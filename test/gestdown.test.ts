import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeGestdown } from './fake-gestdown.js'
import { startFakeSubtitleProvider } from './fake-subtitle-provider.js'

const databasePath = join(tmpdir(), `fetcherr-gestdown-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// No network: config reads keys once at load, and unset keys keep every other
// lookup offline. Gestdown and Cinemeta are the only network this file touches,
// and both are faked below.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { clearSubtitleCache, fetchSubtitles, fetchSubtitleFile } = await import('../src/subtitles.js')
const { clearGestdownCache, fetchGestdownSubtitles } = await import('../src/gestdown.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')
const { releaseTags, releaseLabel } = await import('../src/subtitle-rank.js')

// Call My Agent!, as measured against the real Gestdown and Cinemeta on
// 2026-09-28 (see the task brief). Not fetched for real here: fake-gestdown.ts
// stands in for Gestdown, and stubCinemeta below stands in for Cinemeta.
const IMDB_ID = 'tt4277922'
const TVDB_ID = 300247
const GUID = 'e6c4ee38-9432-4b53-8d33-a91dff47827d'

const LIBERTY_ENTRY = {
  subtitleId: 'f8aac9db-d4ad-4b7a-bb8c-89513e603e9d', version: 'LiBERTY', release: null,
  qualities: ['720p', '1080p'], completed: true, hearingImpaired: false,
  downloadUri: '/subtitles/download/f8aac9db-d4ad-4b7a-bb8c-89513e603e9d', language: 'English', source: 'Addic7ed',
}
const AIRTV_ENTRY = {
  subtitleId: '6c0f3264-3f48-4575-a4f2-87cd43cc02b9', version: '1080p.BluRay.x264-AiRTV', release: null,
  qualities: ['1080p'], completed: true, hearingImpaired: false,
  downloadUri: '/subtitles/download/6c0f3264-3f48-4575-a4f2-87cd43cc02b9', language: 'English', source: 'Addic7ed',
}
const FRENCH_ENTRY = {
  subtitleId: 'b2d6a1a4-2222-4000-8000-1234567890ab', version: 'NF, WEB-DL', release: null,
  qualities: ['1080p'], completed: true, hearingImpaired: false,
  downloadUri: '/subtitles/download/b2d6a1a4-2222-4000-8000-1234567890ab', language: 'French', source: 'Addic7ed',
}

// Every test starts from the same settings and an empty cache, then points
// Gestdown at its own fake.
function configure(overrides: Partial<typeof config> = {}) {
  Object.assign(config, {
    subtitleProviderUrls: [],
    streamProviderUrls: [],
    sootioUrl: '',
    subtitleLanguages: ['eng'],
    subtitleMaxPerLanguage: 30,
    subtitleTimeoutMs: 1000,
    subtitleGestdown: true,
  }, overrides)
  clearSubtitleCache()
  clearGestdownCache()
}

// Stands in for Cinemeta: fetchCinemetaMeta calls the real global fetch, so
// this replaces it for v3-cinemeta.strem.io URLs only and leaves every other
// URL (Gestdown's fake, and anything else) going to the real fetch underneath.
function stubCinemeta(handler: (imdbId: string) => { status: number; meta?: Record<string, unknown> }) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.startsWith('https://v3-cinemeta.strem.io/')) {
      calls++
      const match = /\/meta\/series\/([^/.]+)\.json$/.exec(new URL(url).pathname)
      const imdbId = match ? decodeURIComponent(match[1]) : ''
      const { status, meta } = handler(imdbId)
      if (status !== 200) return new Response('{}', { status })
      return new Response(JSON.stringify({ meta }), { status: 200 })
    }
    return original(input, init)
  }) as typeof fetch
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = original },
  }
}

test('English and French tracks come back, with release labels, srt format and Gestdown\'s own URL', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(imdbId => imdbId === IMDB_ID ? { status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } } : { status: 404 })
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY, AIRTV_ENTRY] })
  fake.setLanguage(GUID, 1, 1, 'fr', { entries: [FRENCH_ENTRY] })
  configure({ subtitleLanguages: ['eng', 'fre', 'rum', 'ger'], gestdownBaseUrl: fake.url })

  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => [track.id, track.lang, track.format]), [
    ['1-f8aac9db-d4ad-4b7a-bb8c-89513e603e9d', 'eng', 'srt'],
    ['1-6c0f3264-3f48-4575-a4f2-87cd43cc02b9', 'eng', 'srt'],
    ['1-b2d6a1a4-2222-4000-8000-1234567890ab', 'fre', 'srt'],
  ])
  assert.equal(tracks[0].url, `${fake.url}/subtitles/download/f8aac9db-d4ad-4b7a-bb8c-89513e603e9d`)
  assert.equal(releaseTags(tracks[0].release).group, 'LiBERTY')
  assert.equal(releaseLabel(tracks[0].release), 'LiBERTY')
  assert.equal(releaseTags(tracks[1].release).group, 'AiRTV')

  assert.equal(cinemeta.calls(), 1)
  assert.deepEqual(fake.showRequests, [`/shows/external/tvdb/${TVDB_ID}`])
  assert.deepEqual(fake.languageRequests, [
    `/subtitles/get/${GUID}/1/1/en`, `/subtitles/get/${GUID}/1/1/fr`, `/subtitles/get/${GUID}/1/1/ro`, `/subtitles/get/${GUID}/1/1/de`,
  ])
})

test('a Gestdown version that is a source word gets that source\'s label, not a doubled one', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  const entries = ['WEB', 'HDTV', 'AMZN', 'BluRay'].map((version, i) => ({
    subtitleId: `source-word-${i}`, version, release: null, qualities: ['1080p'], completed: true, hearingImpaired: false,
    downloadUri: `/subtitles/download/source-word-${i}`, language: 'English', source: 'Addic7ed',
  }))
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [...entries, LIBERTY_ENTRY] })
  configure({ gestdownBaseUrl: fake.url })

  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => releaseLabel(track.release)), ['WEB', 'HDTV', 'AMZN', 'BluRay', 'LiBERTY'])
  assert.equal(releaseTags(tracks[4].release).group, 'LiBERTY')
})

test('a second episode of the same show reuses the cached show', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY] })
  fake.setLanguage(GUID, 1, 2, 'en', { entries: [AIRTV_ENTRY] })
  configure({ gestdownBaseUrl: fake.url })

  const first = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  const second = await fetchSubtitles('series', `${IMDB_ID}:1:2`)
  assert.deepEqual(first.map(track => track.id), ['1-f8aac9db-d4ad-4b7a-bb8c-89513e603e9d'])
  assert.deepEqual(second.map(track => track.id), ['1-6c0f3264-3f48-4575-a4f2-87cd43cc02b9'])
  assert.equal(cinemeta.calls(), 1)
  assert.deepEqual(fake.showRequests, [`/shows/external/tvdb/${TVDB_ID}`])
})

test('a movie asks nothing, not even Cinemeta', async t => {
  const fake = await startFakeGestdown()
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: 'tt0111161', tvdb_id: 12345 } }))
  t.after(cinemeta.restore)
  configure({ gestdownBaseUrl: fake.url })

  assert.deepEqual(await fetchSubtitles('movie', 'tt0111161'), [])
  assert.equal(cinemeta.calls(), 0)
  assert.equal(fake.showRequests.length, 0)
})

test('subtitleGestdown off asks nothing', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY] })
  configure({ gestdownBaseUrl: fake.url, subtitleGestdown: false })

  assert.deepEqual(await fetchSubtitles('series', `${IMDB_ID}:1:1`), [])
  assert.equal(cinemeta.calls(), 0)
  assert.equal(fake.showRequests.length, 0)
})

test('a show Cinemeta cannot place, or that Gestdown has never heard of, is cached as absent', async t => {
  const fake = await startFakeGestdown()
  t.after(() => fake.close())
  configure({ gestdownBaseUrl: fake.url })

  const noTvdbId = stubCinemeta(() => ({ status: 200, meta: { id: 'tt1111111' } }))
  assert.deepEqual(await fetchSubtitles('series', 'tt1111111:1:1'), [])
  assert.deepEqual(await fetchSubtitles('series', 'tt1111111:1:2'), [])
  assert.equal(noTvdbId.calls(), 1)
  assert.equal(fake.showRequests.length, 0)
  noTvdbId.restore()

  fake.addShow(424242, 'unused-guid')
  fake.setShowMode('404')
  const unknownShow = stubCinemeta(() => ({ status: 200, meta: { id: 'tt2222222', tvdb_id: 424242 } }))
  assert.deepEqual(await fetchSubtitles('series', 'tt2222222:1:1'), [])
  assert.deepEqual(await fetchSubtitles('series', 'tt2222222:1:2'), [])
  assert.equal(unknownShow.calls(), 1)
  assert.equal(fake.showRequests.length, 1)
  unknownShow.restore()
})

test('a Cinemeta failure is asked again on the next lookup, not cached as absent for a day', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY] })
  configure({ gestdownBaseUrl: fake.url })

  // fetchGestdownSubtitles taken directly, with a private onFailure, rather than
  // through fetchSubtitles: subtitles.ts logs every Gestdown failure under one
  // throttled key shared with the 429 and 423 tests below, so console.warn is
  // not a reliable place to observe one specific failure in this file.
  const failures: unknown[] = []
  const failing = stubCinemeta(() => ({ status: 503 }))
  const empty = await fetchGestdownSubtitles(`${IMDB_ID}:1:1`, ['eng'], reason => failures.push(reason))
  assert.deepEqual(empty, [])
  assert.equal(failures.length, 1)
  assert.match(String((failures[0] as Error).message), /Cinemeta/)
  assert.equal(fake.showRequests.length, 0, 'a Cinemeta failure never reaches the show lookup')
  failing.restore()

  // Not cached: the very next lookup, still within the same 24h window, reaches
  // Cinemeta and the show lookup again instead of reusing the failed attempt.
  const recovered = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(recovered.restore)
  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => track.id), ['1-f8aac9db-d4ad-4b7a-bb8c-89513e603e9d'])
  assert.equal(fake.showRequests.length, 1, 'the recovered lookup reaches the show lookup')
})

test('a 429 on the show lookup gives nothing, logs once, and is not cached', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }], showMode: '429' })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  configure({ gestdownBaseUrl: fake.url })
  const lines = () => warn.mock.calls.filter(call => String(call.arguments[0]).includes('Gestdown'))

  assert.deepEqual(await fetchSubtitles('series', `${IMDB_ID}:1:1`), [])
  assert.equal(lines().length, 1)
  assert.equal(fake.showRequests.length, 1)

  clearSubtitleCache()
  assert.deepEqual(await fetchSubtitles('series', `${IMDB_ID}:1:1`), [])
  assert.equal(fake.showRequests.length, 2, 'not cached: the next lookup asks again')
})

// Runs after the 429 test above, not before: both log under the same throttled
// 'gestdown' key, and only the first failure in the file is guaranteed to log.
test('a 423 on one language keeps the others', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY] })
  fake.setLanguage(GUID, 1, 1, 'fr', { mode: '423' })
  configure({ subtitleLanguages: ['eng', 'fre'], gestdownBaseUrl: fake.url })

  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => track.lang), ['eng'])
})

test('an incomplete entry, and a season-pack fallback answer, are both dropped', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY, { ...AIRTV_ENTRY, subtitleId: 'incomplete-1', completed: false }] })
  // The season-pack fallback: Gestdown answers about episode 3, not the one asked.
  fake.setLanguage(GUID, 1, 1, 'fr', { entries: [FRENCH_ENTRY], episode: { season: 1, number: 3 } })
  configure({ subtitleLanguages: ['eng', 'fre'], gestdownBaseUrl: fake.url })

  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => [track.id, track.lang]), [['1-f8aac9db-d4ad-4b7a-bb8c-89513e603e9d', 'eng']])
})

test('a slow Gestdown costs its own timeout, not a fast provider\'s answer', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }], showMode: 'slow', slowMs: 5000 })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  const provider = await startFakeSubtitleProvider({ subtitles: [{ id: 'a', lang: 'eng', url: 'https://subs.example/a' }] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url], gestdownBaseUrl: fake.url, subtitleTimeoutMs: 200 })

  const started = performance.now()
  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.ok(performance.now() - started < 2000, 'the slow Gestdown lookup held up the answer')
  assert.deepEqual(tracks.map(track => track.id), ['1-a'])
})

test('Gestdown\'s tracks take turns with a subtitle provider\'s, in each language', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  const provider = await startFakeSubtitleProvider({ subtitles: [
    { id: 'p1', lang: 'eng', url: 'https://subs.example/p1' },
    { id: 'p2', lang: 'eng', url: 'https://subs.example/p2' },
  ] })
  t.after(() => provider.close())
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY, AIRTV_ENTRY] })
  configure({ subtitleProviderUrls: [provider.url], gestdownBaseUrl: fake.url })

  const tracks = await fetchSubtitles('series', `${IMDB_ID}:1:1`)
  assert.deepEqual(tracks.map(track => track.id), [
    '1-p1', '2-f8aac9db-d4ad-4b7a-bb8c-89513e603e9d', '1-p2', '2-6c0f3264-3f48-4575-a4f2-87cd43cc02b9',
  ])
})

test('a Gestdown track appears in PlaybackInfo and its DeliveryUrl serves the fake\'s file', async t => {
  const fake = await startFakeGestdown({ shows: [{ tvdbId: TVDB_ID, guid: GUID }] })
  t.after(() => fake.close())
  const cinemeta = stubCinemeta(() => ({ status: 200, meta: { id: IMDB_ID, tvdb_id: TVDB_ID } }))
  t.after(cinemeta.restore)
  fake.setLanguage(GUID, 1, 1, 'en', { entries: [LIBERTY_ENTRY] })
  configure({ subtitleLanguages: ['eng'], gestdownBaseUrl: fake.url })

  const SHOW_TMDB = 909090
  db.upsertShow({
    tmdbId: SHOW_TMDB, imdbId: IMDB_ID, tvdbId: TVDB_ID, mediaLanguage: 'fr', title: 'Call My Agent!', year: 2015,
    overview: '', posterPath: '', backdropPath: '', logoPath: '', genres: '[]', status: 'Ended', numSeasons: 1,
    popularity: 0, officialRating: '', communityRating: 0, studiosJson: '[]', tagsJson: '[]', castJson: '[]',
    syncedAt: new Date().toISOString(),
  })
  db.upsertEpisode({
    showTmdbId: SHOW_TMDB, seasonNumber: 1, episodeNumber: 1, name: 'Cécile', overview: '', stillPath: '',
    runtimeMins: 30, communityRating: 0, airDate: '2015-01-01', syncedAt: new Date().toISOString(),
  })
  const admin = db.createUser('gestdown-admin', 'pw', 'admin', 'unrestricted')
  // Creates the jellyfin_tokens table on its first read, so the insert below has
  // a table to target.
  resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
  const token = randomUUID()
  db.getDb().prepare('INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, admin.id, Date.now() + 3_600_000)
  const EPISODE_ITEM = `00000000-0000-4000-8003-${SHOW_TMDB.toString(16).padStart(6, '0')}${(1).toString(16).padStart(3, '0')}${(1).toString(16).padStart(3, '0')}`

  const app = Fastify({
    routerOptions: { ignoreTrailingSlash: true },
    rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
  } as never)
  // The production functions, not a hand-built stub: this is the one test that
  // proves Gestdown really reaches PlaybackInfo and the file route.
  await app.register(jellyfinRoutes, { lookupSubtitles: fetchSubtitles, fetchSubtitleFile } as never)
  t.after(() => app.close())

  const info = await app.inject({ method: 'GET', url: `/Items/${EPISODE_ITEM}/PlaybackInfo`, headers: { 'x-emby-token': token } })
  assert.equal(info.statusCode, 200, info.body)
  const source = (info.json().MediaSources as Array<Record<string, unknown>>)[0]
  const subtitle = (source.MediaStreams as Array<Record<string, unknown>>).find(stream => stream.Type === 'Subtitle')
  assert.ok(subtitle, 'no subtitle stream in PlaybackInfo')

  const file = await app.inject({ method: 'GET', url: String(subtitle!.DeliveryUrl) })
  assert.equal(file.statusCode, 200, file.body)
  assert.match(file.body, /fake gestdown file f8aac9db-d4ad-4b7a-bb8c-89513e603e9d/)
})
