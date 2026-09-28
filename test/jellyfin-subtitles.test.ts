import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { StremioMediaType } from '../src/sootio.js'
import type { SubtitleTrack } from '../src/subtitles.js'

const databasePath = join(tmpdir(), `fetcherr-jellyfin-subtitles-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// A fixed secret keeps the signed play URLs deterministic.
process.env.PLAYBACK_SIGNING_SECRET = 'jellyfin-subtitles-test-secret'
// The rating gate resolves unknown ratings through TMDB and TVDB, and without
// keys both return early. Set before the dynamic imports, because config reads
// the environment once at module load.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')
const { fetchSubtitleFile } = await import('../src/subtitles.js')

// The item ids jellyfin/index.ts derives: a movie carries its tmdb id in the low
// bits, an episode carries show, season and episode.
const MOVIE_TMDB = 278
const MOVIE_ITEM = `00000000-0000-4000-8000-${MOVIE_TMDB.toString(16).padStart(12, '0')}`
const SHOW_TMDB = 1396
const EPISODE_ITEM = `00000000-0000-4000-8003-${SHOW_TMDB.toString(16).padStart(6, '0')}${(1).toString(16).padStart(3, '0')}${(1).toString(16).padStart(3, '0')}`

// The first account created takes the default admin id, so it goes first.
const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const romanian = db.createUser('mum', 'pw', 'user', 'unrestricted')
db.updateUser(romanian.id, { subtitleLanguage: 'ro' })
const german = db.createUser('dad', 'pw', 'user', 'unrestricted')
db.updateUser(german.id, { subtitleLanguage: 'de' })
// Rating-limited below the R-rated movie, which the subtitle route must respect.
const kid = db.createUser('kid', 'pw', 'kids', '1')

db.upsertMovie({
  tmdbId: MOVIE_TMDB, imdbId: 'tt0111161', mediaLanguage: 'en', title: 'The Shawshank Redemption', year: 1994,
  overview: '', posterPath: '', backdropPath: '', logoPath: '', genres: '[]', runtimeMins: 142, popularity: 0,
  officialRating: 'R', communityRating: 0, studiosJson: '[]', tagsJson: '[]', castJson: '[]',
  releaseDate: '1994-09-23', digitalReleaseDate: '1994-09-23', syncedAt: new Date().toISOString(),
})
// The item-detail route (unlike PlaybackInfo) only serves a movie that hasAnySourceItem
// confirms is actually in the library.
db.addSourceItem('manual:test', 'movie', MOVIE_TMDB)
db.upsertShow({
  tmdbId: SHOW_TMDB, imdbId: 'tt0903747', tvdbId: 81189, mediaLanguage: 'en', title: 'Breaking Bad', year: 2008,
  overview: '', posterPath: '', backdropPath: '', logoPath: '', genres: '[]', status: 'Ended', numSeasons: 5,
  popularity: 0, officialRating: 'TV-MA', communityRating: 0, studiosJson: '[]', tagsJson: '[]', castJson: '[]',
  syncedAt: new Date().toISOString(),
})
db.upsertEpisode({
  showTmdbId: SHOW_TMDB, seasonNumber: 1, episodeNumber: 1, name: 'Pilot', overview: '', stillPath: '',
  runtimeMins: 58, communityRating: 0, airDate: '2008-01-20', syncedAt: new Date().toISOString(),
})

// resolveJellyfinUser creates the jellyfin_tokens table on its first read, so this
// lookup of a token that cannot exist gives the inserts below a table to target.
resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })
function issueToken(userId: string): string {
  const token = randomUUID()
  db.getDb()
    .prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, Date.now() + 3_600_000)
  return token
}
const tokens = { admin: issueToken(admin.id), romanian: issueToken(romanian.id), german: issueToken(german.id), kid: issueToken(kid.id) }

const TRACKS: SubtitleTrack[] = [
  { id: '1-a', url: 'https://subs.example/a', lang: 'eng', label: 'English 1', format: 'srt', release: '' },
  { id: '1-b', url: 'https://subs.example/b', lang: 'eng', label: 'English 2', format: 'srt', release: '' },
  { id: '1-c', url: 'https://subs.example/c.vtt', lang: 'rum', label: 'Romanian', format: 'vtt', release: '' },
]

// The router options src/index.ts:38-43 builds, so the tests measure what is deployed.
const PRODUCTION_ROUTER_OPTIONS = {
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req: { url?: string }) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
}

type Lookup = (mediaType: StremioMediaType, externalId: string) => Promise<SubtitleTrack[]>
const lookups: Array<[string, string]> = []
const recording: Lookup = async (mediaType, externalId) => {
  lookups.push([mediaType, externalId])
  return TRACKS
}

async function playbackInfo(lookupSubtitles: Lookup | undefined, token: string, itemId: string) {
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, (lookupSubtitles ? { lookupSubtitles } : {}) as never)
  const res = await app.inject({ method: 'GET', url: `/Items/${itemId}/PlaybackInfo`, headers: { 'x-emby-token': token } })
  await app.close()
  assert.equal(res.statusCode, 200, res.body)
  const source = (res.json().MediaSources as Array<Record<string, unknown>>)[0]
  return { source, streams: source.MediaStreams as Array<Record<string, unknown>> }
}

test('a movie play offers every subtitle after the video and audio streams', async () => {
  lookups.length = 0
  const { source, streams } = await playbackInfo(recording, tokens.admin, MOVIE_ITEM)
  assert.deepEqual(lookups, [['movie', 'tt0111161']])
  assert.deepEqual(streams.map(stream => stream.Type), ['Video', 'Audio', 'Subtitle', 'Subtitle', 'Subtitle'])
  assert.deepEqual(streams.slice(2).map(stream => [stream.Index, stream.Language, stream.DeliveryUrl, stream.DeliveryMethod, stream.IsDefault]), [
    [2, 'eng', `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/2/0/Stream.srt`, 'External', false],
    [3, 'eng', `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/3/0/Stream.srt`, 'External', false],
    [4, 'rum', `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/4/0/Stream.vtt`, 'External', false],
  ])
  assert.equal('DefaultSubtitleStreamIndex' in source, false)
})

test('an account with a preferred language gets its first track selected', async () => {
  const { source, streams } = await playbackInfo(recording, tokens.romanian, MOVIE_ITEM)
  assert.equal(source.DefaultSubtitleStreamIndex, 4)
  assert.deepEqual(streams.slice(2).map(stream => stream.IsDefault), [false, false, true])
})

test('a preference with no matching track selects nothing and still offers the rest', async () => {
  const { source, streams } = await playbackInfo(recording, tokens.german, MOVIE_ITEM)
  assert.equal('DefaultSubtitleStreamIndex' in source, false)
  assert.equal(streams.filter(stream => stream.Type === 'Subtitle').length, 3)
  assert.ok(streams.every(stream => stream.Type !== 'Subtitle' || stream.IsDefault === false))
})

test('an episode play looks its subtitles up by the episode id', async () => {
  lookups.length = 0
  const { streams } = await playbackInfo(recording, tokens.admin, EPISODE_ITEM)
  assert.deepEqual(lookups, [['series', 'tt0903747:1:1']])
  assert.equal(streams.filter(stream => stream.Type === 'Subtitle').length, 3)
})

test('a failing lookup leaves the play exactly as it was', async () => {
  const baseline = await playbackInfo(undefined, tokens.admin, MOVIE_ITEM)
  assert.equal(baseline.streams.length, 2)
  const rejecting: Lookup = async () => { throw new Error('provider exploded') }
  const throwing = (() => { throw new Error('thrown before any promise') }) as unknown as Lookup
  for (const lookup of [rejecting, throwing]) {
    const { source, streams } = await playbackInfo(lookup, tokens.romanian, MOVIE_ITEM)
    assert.deepEqual(streams, baseline.streams)
    assert.equal('DefaultSubtitleStreamIndex' in source, false)
  }
})

test('a title with no subtitles is served as before', async () => {
  const baseline = await playbackInfo(undefined, tokens.admin, MOVIE_ITEM)
  const { source, streams } = await playbackInfo(async () => [], tokens.romanian, MOVIE_ITEM)
  assert.deepEqual(streams, baseline.streams)
  assert.equal('DefaultSubtitleStreamIndex' in source, false)
})

test('the item detail screen offers the same tracks, with the account\'s default', async () => {
  lookups.length = 0
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: recording } as never)
  const res = await app.inject({ method: 'GET', url: `/Users/${romanian.id}/Items/${MOVIE_ITEM}`, headers: { 'x-emby-token': tokens.romanian } })
  await app.close()
  assert.equal(res.statusCode, 200, res.body)
  const source = (res.json().MediaSources as Array<Record<string, unknown>>)[0]
  const streams = source.MediaStreams as Array<Record<string, unknown>>
  assert.deepEqual(lookups, [['movie', 'tt0111161']])
  assert.equal(streams.filter(stream => stream.Type === 'Subtitle').length, 3)
  assert.equal(source.DefaultSubtitleStreamIndex, 4)
  const topLevel = res.json().MediaStreams as Array<Record<string, unknown>>
  assert.deepEqual(topLevel.map(stream => stream.Type), ['Video', 'Audio', 'Subtitle', 'Subtitle', 'Subtitle'])
})

test('with media source selection on, every offered version carries the subtitles', async t => {
  const before = config.mediaSourceSelection
  config.mediaSourceSelection = true
  t.after(() => { config.mediaSourceSelection = before })
  const versions = async () => [
    { Id: 'v1', MediaStreams: [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 }] },
    { Id: 'v2', MediaStreams: [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 }] },
  ]
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: recording, buildPlaybackMediaSources: versions } as never)
  const res = await app.inject({ method: 'GET', url: `/Items/${MOVIE_ITEM}/PlaybackInfo`, headers: { 'x-emby-token': tokens.romanian } })
  await app.close()
  assert.equal(res.statusCode, 200, res.body)
  const sources = res.json().MediaSources as Array<Record<string, unknown>>
  assert.deepEqual(sources.map(source => source.Id), ['v1', 'v2'])
  for (const source of sources) {
    const streams = source.MediaStreams as Array<Record<string, unknown>>
    assert.deepEqual(streams.map(stream => stream.Index), [0, 1, 2, 3, 4])
    assert.equal(source.DefaultSubtitleStreamIndex, 4)
  }
})

async function startFileHost() {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/fail')) { res.writeHead(500); res.end(); return }
    if (req.url?.startsWith('/slow')) return // never answers
    if (req.url?.startsWith('/huge')) { res.writeHead(200, { 'content-length': String(6 * 1024 * 1024) }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' })
    res.end(`1\n00:00:01,000 --> 00:00:02,000\nfile ${req.url}\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

async function appServingFiles(base: string) {
  const tracks: SubtitleTrack[] = [
    { id: '1-a', url: `${base}/a.srt`, lang: 'eng', label: 'English 1', format: 'srt', release: '' },
    { id: '1-b', url: `${base}/b.srt`, lang: 'eng', label: 'English 2', format: 'srt', release: '' },
    { id: '1-c', url: `${base}/c.vtt`, lang: 'rum', label: 'Romanian', format: 'vtt', release: '' },
    { id: '1-d', url: `${base}/fail.srt`, lang: 'ger', label: 'German', format: 'srt', release: '' },
  ]
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: async () => tracks, fetchSubtitleFile } as never)
  return app
}

test('a client fetching a subtitle at its DeliveryUrl gets the file from this server', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  const app = await appServingFiles(host.base)
  const info = await app.inject({ method: 'GET', url: `/Items/${MOVIE_ITEM}/PlaybackInfo`, headers: { 'x-emby-token': tokens.admin } })
  const source = (info.json().MediaSources as Array<Record<string, unknown>>)[0]
  const subtitleStreams = (source.MediaStreams as Array<Record<string, unknown>>).filter(stream => stream.Type === 'Subtitle')
  for (const [n, stream] of subtitleStreams.slice(0, 3).entries()) {
    assert.equal(stream.IsExternalUrl, false)
    // No token, as the players in the production log sent none.
    const res = await app.inject({ method: 'GET', url: String(stream.DeliveryUrl) })
    assert.equal(res.statusCode, 200, String(stream.DeliveryUrl))
    assert.equal(res.headers['content-type'], n === 2 ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8')
    assert.match(res.body, new RegExp(`file /${['a.srt', 'b.srt', 'c.vtt'][n]}`))
  }
  // The other spellings players use reach the same file, from memory.
  for (const path of [
    `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/2/Stream.srt`,
    `/videos/${MOVIE_ITEM}/${MOVIE_ITEM}:candidate:${'a'.repeat(32)}/Subtitles/2/0/Stream.srt`,
  ]) {
    const res = await app.inject({ method: 'GET', url: path })
    assert.equal(res.statusCode, 200, path)
  }
  assert.equal(host.hits.filter(hit => hit === '/a.srt').length, 1)
  await app.close()
})

test('a provider file in the OpenSubtitles v3+ shape is served without its banner', async t => {
  // The episode item, not the movie item every other test in this file shares:
  // the route remembers each source's subtitle order under its item id, and a
  // single-track answer here must not leave that memory behind for them to trip on.
  const banner = [
    'WEBVTT',
    '',
    'header',
    '00:00:01.000 --> 00:00:06.000',
    '&gt;&gt;OpenSubtitles v3+ v0.0.4&lt;&lt;',
    '<u>=&gt;Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV.srt</u>',
    '',
    'WEBVTT',
    '',
    '1',
    '00:00:45.602 --> 00:00:46.972',
    'The stove.',
    '',
  ].join('\n')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' })
    res.end(banner)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))

  const tracks: SubtitleTrack[] = [
    { id: '1-a', url: `http://127.0.0.1:${port}/banner.vtt`, lang: 'eng', label: 'English', format: 'vtt', release: '' },
  ]
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: async () => tracks, fetchSubtitleFile } as never)
  t.after(() => app.close())

  const info = await app.inject({ method: 'GET', url: `/Items/${EPISODE_ITEM}/PlaybackInfo`, headers: { 'x-emby-token': tokens.admin } })
  const source = (info.json().MediaSources as Array<Record<string, unknown>>)[0]
  const stream = (source.MediaStreams as Array<Record<string, unknown>>).find(entry => entry.Type === 'Subtitle')!
  const res = await app.inject({ method: 'GET', url: String(stream.DeliveryUrl) })
  assert.equal(res.statusCode, 200)
  assert.equal(/OpenSubtitles/i.test(res.body), false)
  assert.equal(res.body.match(/^WEBVTT$/gm)?.length, 1)
})

test('a subtitle fetch works without a prior PlaybackInfo, as after a restart', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  const app = await appServingFiles(host.base)
  const res = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/3/0/Stream.srt` })
  await app.close()
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /file \/b\.srt/)
})

test('a subtitle fetch the server cannot place, cannot get, or the account may not see is refused', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  const app = await appServingFiles(host.base)
  for (const index of ['0', '1', '6', '99', '-1', 'abc']) {
    const res = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/${index}/0/Stream.srt` })
    assert.equal(res.statusCode, 404, `index ${index}`)
  }
  // The provider's file host fails for the German track.
  const unavailable = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/5/0/Stream.srt` })
  assert.equal(unavailable.statusCode, 404)
  const unknownItem = `00000000-0000-4000-8000-${(999999).toString(16).padStart(12, '0')}`
  assert.equal((await app.inject({ method: 'GET', url: `/Videos/${unknownItem}/${unknownItem}/Subtitles/2/0/Stream.srt` })).statusCode, 404)
  const limited = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${MOVIE_ITEM}/Subtitles/2/0/Stream.srt`, headers: { 'x-emby-token': tokens.kid } })
  assert.equal(limited.statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/someone-else/Subtitles/2/0/Stream.srt` })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/someone-else/Subtitles/2/0/Stream.srt`, headers: { 'x-emby-token': tokens.admin } })).statusCode, 200)
  await app.close()
})

test('each version lists the track made for its own file first, and serves it at that index', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  const before = config.mediaSourceSelection
  config.mediaSourceSelection = true
  t.after(() => { config.mediaSourceSelection = before })

  const bluray = `${MOVIE_ITEM}:candidate:${'b'.repeat(32)}`
  const web = `${MOVIE_ITEM}:candidate:${'c'.repeat(32)}`
  // Known by its file but never listed, as for a player that skips PlaybackInfo.
  const unlisted = `${MOVIE_ITEM}:candidate:${'d'.repeat(32)}`
  const tracks: SubtitleTrack[] = [
    { id: '1-dvd', url: `${host.base}/dvd.srt`, lang: 'eng', label: 'English 1', format: 'srt', release: 'The.Shawshank.Redemption.1994.DVDRip.XviD-ABC' },
    { id: '1-web', url: `${host.base}/web.srt`, lang: 'eng', label: 'English 2', format: 'srt', release: 'The.Shawshank.Redemption.1994.720p.WEB-DL.H264-myTV' },
    { id: '1-fgt', url: `${host.base}/fgt.srt`, lang: 'eng', label: 'English 3', format: 'srt', release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-FGT' },
  ]
  const fileNames = new Map([
    [bluray, 'The.Shawshank.Redemption.1994.1080p.BluRay.x264.DTS-FGT.mkv'],
    [web, 'The.Shawshank.Redemption.1994.720p.WEB-DL.DD5.1.H264-myTV.mkv'],
    [unlisted, 'The.Shawshank.Redemption.1994.1080p.BDRip.x264-FGT.mkv'],
  ])
  let candidatesKnown = true
  const fileNameForMediaSource = (id: string) => candidatesKnown ? fileNames.get(id) ?? null : null
  const versions = async () => [bluray, web].map(Id => ({ Id, MediaStreams: [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 }] }))
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: async () => tracks, fetchSubtitleFile, buildPlaybackMediaSources: versions, fileNameForMediaSource } as never)
  t.after(() => app.close())

  const info = await app.inject({ method: 'GET', url: `/Items/${MOVIE_ITEM}/PlaybackInfo`, headers: { 'x-emby-token': tokens.admin } })
  assert.equal(info.statusCode, 200, info.body)
  const listedFirst = (info.json().MediaSources as Array<Record<string, unknown>>).map(source =>
    [source.Id, (source.MediaStreams as Array<Record<string, unknown>>).find(stream => stream.Index === 2)?.DisplayTitle])
  assert.deepEqual(listedFirst, [[bluray, 'English 1 · 1080p BluRay FGT'], [web, 'English 1 · 720p WEB-DL myTV']])

  const unlistedFetch = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${unlisted}/Subtitles/2/0/Stream.srt` })
  assert.match(unlistedFetch.body, /file \/fgt\.srt/)

  // Candidates are forgotten after ten minutes, and a player may fetch its
  // subtitles later than that. The order it was shown must still hold.
  candidatesKnown = false
  for (const [id, file] of [[bluray, 'fgt.srt'], [web, 'web.srt']]) {
    const res = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${id}/Subtitles/2/0/Stream.srt` })
    assert.equal(res.statusCode, 200, id)
    assert.match(res.body, new RegExp(`file /${file.replace('.', '\\.')}`), id)
  }
})

test('the subtitle log line names the version the file was fetched for', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  const tracks: SubtitleTrack[] = [{ id: '1-a', url: `${host.base}/a.srt`, lang: 'eng', label: 'English 1', format: 'srt', release: '' }]
  const lines: string[] = []
  const app = Fastify({ ...PRODUCTION_ROUTER_OPTIONS, logger: { level: 'info', stream: { write: (line: string) => { lines.push(line) } } } } as never)
  await app.register(jellyfinRoutes, { lookupSubtitles: async () => tracks, fetchSubtitleFile } as never)
  t.after(() => app.close())
  const token = `${'e'.repeat(8)}${'f'.repeat(24)}`
  const messages = async (sourceId: string) => {
    lines.length = 0
    const res = await app.inject({ method: 'GET', url: `/Videos/${MOVIE_ITEM}/${sourceId}/Subtitles/2/0/Stream.srt` })
    assert.equal(res.statusCode, 200, sourceId)
    return lines.map(line => String(JSON.parse(line).msg)).filter(msg => msg.startsWith('playback: subtitle '))
  }

  const [candidate] = await messages(`${MOVIE_ITEM}:candidate:${token}`)
  assert.match(candidate, / version eeeeeeee /)
  // A whole candidate token lets a player without an account stream that version.
  assert.ok(!candidate.includes(token), candidate)
  const [plain] = await messages(MOVIE_ITEM)
  assert.match(plain, new RegExp(` version ${MOVIE_ITEM} `))
})
