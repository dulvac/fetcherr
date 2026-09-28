import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeSubtitleProvider } from './fake-subtitle-provider.js'
import type { StremioMediaType } from '../src/sootio.js'
import type { SubtitleExtra, SubtitleTrack } from '../src/subtitles.js'

const databasePath = join(tmpdir(), `fetcherr-stremio-subtitles-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// No network: the rating gate resolves through TMDB and TVDB, and without keys
// both return early, which is also production behaviour for an unknown rating.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { stremioAddonRoutes } = await import('../src/stremio-addon.js')
const { fetchSubtitles, clearSubtitleCache } = await import('../src/subtitles.js')

function account(name: string, role: 'user' | 'kids' = 'user', maxRating = 'unrestricted') {
  const user = db.createUser(name, 'pw', role, maxRating)
  db.setStremioEnabled(user.id, true)
  return { user, token: db.mintStremioToken(user.id) }
}
const friend = account('friend')
const mum = account('mum')
db.updateUser(mum.user.id, { subtitleLanguage: 'ro' })
// Rating-limited, so with no way to establish a rating every title is refused.
const kid = account('kid', 'kids', '1')
const capped = account('capped')
db.setStremioPlayCap(capped.user.id, 0)
// Holds a token but was never enabled, which must look exactly like no token.
const revoked = db.createUser('revoked', 'pw', 'user', 'unrestricted')
const revokedToken = db.mintStremioToken(revoked.id)

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

type Fetch = (mediaType: StremioMediaType, externalId: string, extra?: SubtitleExtra) => Promise<SubtitleTrack[]>
const calls: Array<[string, string, SubtitleExtra | undefined]> = []
const recording: Fetch = async (mediaType, externalId, extra) => {
  calls.push([mediaType, externalId, extra])
  return TRACKS
}

async function get(url: string, fetchSubtitlesOption: Fetch = recording, method: 'GET' | 'HEAD' = 'GET') {
  const app = Fastify(PRODUCTION_ROUTER_OPTIONS as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv' }),
    fetchMeta: async () => ({ id: 'tt0111161', name: 'Shawshank' }),
    fetchSubtitles: fetchSubtitlesOption,
  } as never)
  const res = await app.inject({ method, url })
  await app.close()
  return res
}

const TOM_AND_JERRY = 'videoHash=8e245d9679d31e12&videoSize=652696576&filename=Tom%20%26%20Jerry%20(1940).mkv.json'

test('serves subtitles for a movie in the protocol shape', async () => {
  calls.length = 0
  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161.json`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['access-control-allow-origin'], '*')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(res.json(), { subtitles: TRACKS.map(({ id, url, lang, label }) => ({ id, url, lang, label })) })
  assert.deepEqual(calls, [['movie', 'tt0111161', undefined]])
})

test('an episode is looked up by its canonical stream id', async () => {
  calls.length = 0
  await get(`/stremio/${friend.token}/subtitles/series/tt13210838:1:02.json`)
  assert.deepEqual(calls, [['series', 'tt13210838:1:2', undefined]])
})

test('the preferred language comes first, the rest keep their order', async () => {
  const res = await get(`/stremio/${mum.token}/subtitles/movie/tt0111161.json`)
  assert.deepEqual(res.json().subtitles.map((entry: { id: string }) => entry.id), ['1-c', '1-a', '1-b'])
})

// Two English files made for different releases of Monk S01E01, as the official
// OpenSubtitles addon lists them.
const RELEASED: SubtitleTrack[] = [
  { ...TRACKS[0], release: 'Monk S01E01E02 Mr. Monk and the Candidate Part 1_2.DVDRip.NonHI.en.UNIV' },
  { ...TRACKS[1], release: 'Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV' },
  TRACKS[2],
]
const labels = (res: { json: () => { subtitles: Array<{ id: string; label: string }> } }) =>
  res.json().subtitles.map(entry => [entry.id, entry.label])

test('each label names the release its file was made for, as on Jellyfin', async () => {
  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161.json`, async () => RELEASED)
  assert.deepEqual(labels(res), [
    ['1-a', 'English 1 · DVDRip'],
    ['1-b', 'English 2 · 720p WEB-DL myTV'],
    ['1-c', 'Romanian'],
  ])
})

test('a bad token and a revoked account are indistinguishable', async () => {
  calls.length = 0
  const bad = await get('/stremio/nonsense/subtitles/movie/tt0111161.json')
  const gone = await get(`/stremio/${revokedToken}/subtitles/movie/tt0111161.json`)
  assert.equal(bad.statusCode, 404)
  assert.equal(gone.statusCode, 404)
  assert.deepEqual(bad.json(), gone.json())
  assert.equal(calls.length, 0)
})

test('file details from the client are forwarded to the lookup', async () => {
  calls.length = 0
  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161/${TOM_AND_JERRY}`)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [['movie', 'tt0111161', { videoHash: '8e245d9679d31e12', videoSize: '652696576', filename: 'Tom & Jerry (1940).mkv' }]])
})

test('an id it does not serve, or a title the account may not see, is an empty list', async () => {
  calls.length = 0
  for (const url of [
    `/stremio/${friend.token}/subtitles/movie/kitsu:1.json`,
    `/stremio/${friend.token}/subtitles/channel/tt0111161.json`,
    `/stremio/${friend.token}/subtitles/movie/tt0111161/no-json-suffix`,
    `/stremio/${kid.token}/subtitles/movie/tt0111161.json`,
  ]) {
    const res = await get(url)
    assert.equal(res.statusCode, 200, url)
    assert.deepEqual(res.json(), { subtitles: [] }, url)
  }
  assert.equal(calls.length, 0)
})

test('a failing lookup is an empty list, not an error', async () => {
  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161.json`, async () => { throw new Error('provider exploded') })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { subtitles: [] })
})

test('subtitle lookups neither count as plays nor stop at the play cap', async () => {
  const before = db.countStremioPlaysToday(capped.user.id)
  for (let i = 0; i < 3; i++) {
    const res = await get(`/stremio/${capped.token}/subtitles/movie/tt0111161.json`)
    assert.equal(res.json().subtitles.length, 3)
  }
  assert.equal(db.countStremioPlaysToday(capped.user.id), before)
})

test('HEAD is answered, since a lookup has no side effects', async () => {
  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161.json`, recording, 'HEAD')
  assert.equal(res.statusCode, 200)
})

test('a real client\'s long extra segment reaches the route and never logs the token', async () => {
  calls.length = 0
  const filename = 'The.Shawshank.Redemption.1994.REMASTERED.1080p.BluRay.x265.10bit.AAC.5.1-Tigole [Criterion Collection].mkv'
  const segment = `videoHash=8e245d9679d31e12&videoSize=652696576&filename=${encodeURIComponent(filename)}.json`
  assert.ok(segment.length > 150, `segment is only ${segment.length} characters`)

  const lines: string[] = []
  const app = Fastify({ ...PRODUCTION_ROUTER_OPTIONS, logger: { level: 'info', stream: { write: (line: string) => { lines.push(line) } } } } as never)
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv' }),
    fetchMeta: async () => ({ id: 'tt0111161', name: 'Shawshank' }),
    fetchSubtitles: recording,
  } as never)
  const res = await app.inject({ method: 'GET', url: `/stremio/${friend.token}/subtitles/movie/tt0111161/${segment}` })
  const multi = await app.inject({ method: 'GET', url: `/stremio/${friend.token}/subtitles/movie/tt0111161/a/${segment}` })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [['movie', 'tt0111161', { videoHash: '8e245d9679d31e12', videoSize: '652696576', filename }]])
  assert.deepEqual(multi.json(), { subtitles: [] })
  assert.ok(lines.length > 0, 'the plugin logs one redacted line per request')
  assert.ok(!lines.some(line => line.includes(friend.token)), 'a log line carries the full token')
})

test('the provider receives the hash and size the client sent', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [{ id: 'x', lang: 'eng', url: 'https://subs.example/x' }] })
  t.after(() => provider.close())
  const before = { subtitleProviderUrls: config.subtitleProviderUrls, subtitleLanguages: config.subtitleLanguages, subtitleTimeoutMs: config.subtitleTimeoutMs }
  t.after(() => { Object.assign(config, before) })
  Object.assign(config, { subtitleProviderUrls: [provider.url], subtitleLanguages: ['eng'], subtitleTimeoutMs: 2000 })
  clearSubtitleCache()

  const res = await get(`/stremio/${friend.token}/subtitles/movie/tt0111161/${TOM_AND_JERRY}`, fetchSubtitles)
  assert.deepEqual(provider.requests, [`/subtitles/movie/tt0111161/${TOM_AND_JERRY}`])
  assert.deepEqual(res.json().subtitles.map((entry: { lang: string }) => entry.lang), ['eng'])
})
