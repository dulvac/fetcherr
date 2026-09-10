import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-routes-${randomUUID()}.db`)
// No network from these tests. The rating gate resolves through TMDB and TVDB,
// and without keys both return early, which is also the production behaviour
// for a rating that cannot be established. Set before the dynamic imports
// below, because config reads them once at module load.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { stremioAddonRoutes } = await import('../src/stremio-addon.js')

const hashA = 'a'.repeat(40)
const hashB = 'b'.repeat(40)

const friend = db.createUser('friend', 'pw', 'user', 'unrestricted')
db.setStremioEnabled(friend.id, true)
const token = db.mintStremioToken(friend.id)

const off = db.createUser('revoked', 'pw', 'user', 'unrestricted')
const offToken = db.mintStremioToken(off.id)

let resolvedWith: { streams: unknown[]; label: string } | null = null

async function buildApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify()
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }, { name: 'B', infoHash: hashB }],
    resolvePlayback: async (streams: never, label: string) => {
      resolvedWith = { streams: streams as unknown[], label }
      return { url: 'https://cdn.torbox.test/file.mkv' }
    },
    fetchMeta: async () => ({ id: 'tt0111161', name: 'Shawshank' }),
    ...overrides,
  } as never)
  return app
}

test('serves the manifest for a valid token', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().resources, ['stream'])
  await app.close()
})

test('a bad token and a revoked account are indistinguishable', async () => {
  const app = await buildApp()
  const bad = await app.inject({ method: 'GET', url: '/stremio/nonsense/manifest.json' })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/manifest.json` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  await app.close()
})

test('returns mapped streams for a movie', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  assert.equal(res.statusCode, 200)
  const streams = res.json().streams as Array<{ url: string }>
  assert.equal(streams.length, 2)
  assert.ok(streams[0].url.endsWith(`/stremio/${token}/play/movie/tt0111161/${hashA}`))
  await app.close()
})

test('an unsupported id yields a notice, not an empty list', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/kitsu:1.json` })
  assert.equal(res.statusCode, 200)
  const streams = res.json().streams as Array<{ description: string; url?: string }>
  assert.equal(streams.length, 1)
  assert.equal(streams[0].url, undefined)
  await app.close()
})

test('an empty provider response yields a notice, not an empty list', async () => {
  const app = await buildApp({ fetchStreams: async () => [] })
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const streams = res.json().streams as Array<{ description: string }>
  assert.equal(streams.length, 1)
  assert.match(streams[0].description, /no streams/i)
  await app.close()
})

test('a provider that throws yields a notice, not a 500', async () => {
  const app = await buildApp({ fetchStreams: async () => { throw new Error('boom') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  assert.equal(res.statusCode, 200)
  assert.equal((res.json().streams as unknown[]).length, 1)
  await app.close()
})

test('play redirects to the resolved CDN URL with the pin first', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB}` })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, 'https://cdn.torbox.test/file.mkv')
  assert.equal((resolvedWith?.streams[0] as { infoHash: string }).infoHash, hashB)
  assert.equal(db.countStremioPlaysToday(friend.id), 1)
  await app.close()
})

test('play refuses a malformed hash without calling the resolver', async () => {
  const app = await buildApp()
  resolvedWith = null
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/not-a-hash` })
  assert.equal(res.statusCode, 404)
  assert.equal(resolvedWith, null)
  await app.close()
})

test('play stops at the cap and does not count the refusal', async () => {
  const capped = db.createUser('capped', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(capped.id, true)
  db.setStremioPlayCap(capped.id, 1)
  const cappedToken = db.mintStremioToken(capped.id)
  const app = await buildApp()
  const first = await app.inject({ method: 'GET', url: `/stremio/${cappedToken}/play/movie/tt0111161/${hashA}` })
  const second = await app.inject({ method: 'GET', url: `/stremio/${cappedToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(first.statusCode, 302)
  assert.equal(second.statusCode, 429)
  assert.equal(db.countStremioPlaysToday(capped.id), 1)
  await app.close()
})

test('a rating-limited account gets a notice instead of streams', async () => {
  const kid = db.createUser('kid', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/stream/movie/tt0111161.json` })
  const streams = res.json().streams as Array<{ description: string; url?: string }>
  assert.equal(streams.length, 1)
  assert.equal(streams[0].url, undefined)
  await app.close()
})

test('nothing outside the addon prefix is served by this plugin', async () => {
  const app = await buildApp()
  for (const url of ['/manifest.json', `/play/movie/tt0111161/${hashA}`, `/stremio/${token}/configure`]) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404)
  }
  await app.close()
})

// ── The dispatch's corrections ───────────────────────────────────────────────

test('the stream route refuses a token whose account is revoked', async () => {
  const app = await buildApp()
  const bad = await app.inject({ method: 'GET', url: '/stremio/nonsense/stream/movie/tt0111161.json' })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/stream/movie/tt0111161.json` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  await app.close()
})

test('the play route refuses a bad token and a revoked account identically', async () => {
  const app = await buildApp()
  resolvedWith = null
  const bad = await app.inject({ method: 'GET', url: `/stremio/nonsense/play/movie/tt0111161/${hashA}` })
  const revoked = await app.inject({ method: 'GET', url: `/stremio/${offToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(bad.statusCode, 404)
  assert.equal(revoked.statusCode, 404)
  assert.deepEqual(bad.json(), revoked.json())
  assert.equal(resolvedWith, null)
  await app.close()
})

test('an uppercase hash in the play path is canonicalized, not refused', async () => {
  let pinnedFirst: string | undefined
  const app = Fastify()
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }, { name: 'B', infoHash: hashB }],
    resolvePlayback: async (streams: Array<{ infoHash?: string }>) => {
      pinnedFirst = streams[0]?.infoHash
      return { url: 'https://cdn.torbox.test/file.mkv' }
    },
    fetchMeta: async () => null,
  } as never)
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB.toUpperCase()}` })
  assert.equal(res.statusCode, 302)
  assert.equal(pinnedFirst, hashB)
  await app.close()
})

test('a pin that no longer resolves is logged, not served silently', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line) } } } })
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv' }),
    fetchMeta: async () => null,
  } as never)
  const gone = 'c'.repeat(40)
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${gone}` })
  assert.equal(res.statusCode, 302)
  const warning = lines.find(line => line.includes(gone))
  assert.ok(warning, `expected a warning naming the requested hash, got: ${lines.join('')}`)
  assert.ok(warning.includes(hashA), 'the warning must also name what is being played instead')
  await app.close()
})

test('no log line carries the raw token', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: { level: 'trace', stream: { write: (line: string) => { lines.push(line) } } } })
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => ({ url: 'https://cdn.torbox.test/file.mkv', filename: 'a.mkv' }),
    fetchMeta: async () => null,
  } as never)
  for (const url of [
    `/stremio/${token}/manifest.json`,
    `/stremio/${token}/stream/movie/tt0111161.json`,
    `/stremio/${token}/play/movie/tt0111161/${hashA}`,
  ]) await app.inject({ method: 'GET', url })
  await app.close()
  const logged = lines.join('')
  assert.ok(lines.length > 0, 'expected the logger to have produced output')
  assert.ok(!logged.includes(token), `the raw token leaked into the logs: ${logged}`)
})
