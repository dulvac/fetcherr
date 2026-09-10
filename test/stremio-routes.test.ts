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
  // Unmatched paths under the prefix are most of what a probing or misconfigured
  // client sends: /configure is what the containment test requests, and /meta/
  // is what a client tries when it has a manifest cached from another
  // configuration. Each of these used to log the token twice.
  for (const url of [
    `/stremio/${token}/configure`,
    `/stremio/${token}/meta/movie/tt0111161.json`,
    `/stremio/${token}/catalog/movie/top.json`,
    `/stremio/${token}/manifest.json/`,
  ]) await app.inject({ method: 'GET', url })
  await app.inject({ method: 'POST', url: `/stremio/${token}/manifest.json` })
  await app.close()
  const logged = lines.join('')
  assert.ok(lines.length > 0, 'expected the logger to have produced output')
  assert.ok(!logged.includes(token), `the raw token leaked into the logs: ${logged}`)
})

test('unmatched paths under the prefix answer like an invalid token', async () => {
  const app = await buildApp()
  const invalid = await app.inject({ method: 'GET', url: '/stremio/nonsense/manifest.json' })
  for (const url of [
    `/stremio/${token}/configure`,
    `/stremio/${token}/meta/movie/tt0111161.json`,
    `/stremio/${token}/manifest.json/`,
  ]) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), invalid.json())
  }
  const wrongMethod = await app.inject({ method: 'POST', url: `/stremio/${token}/manifest.json` })
  assert.equal(wrongMethod.statusCode, 404)
  assert.deepEqual(wrongMethod.json(), invalid.json())
  await app.close()
})

test('the catch-all does not shadow the three real routes', async () => {
  const app = await buildApp()
  const manifest = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  const stream = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const play = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashB}` })
  assert.equal(manifest.statusCode, 200)
  assert.deepEqual(manifest.json().resources, ['stream'])
  assert.equal(stream.statusCode, 200)
  assert.equal((stream.json().streams as unknown[]).length, 2)
  assert.equal(play.statusCode, 302)
  await app.close()
})

// ── Fix round 1, commit 1: the rating gate belongs on play too ───────────────
//
// The stream route's refusal is cosmetic if play does not enforce it: the URL
// is fully derivable from the account's own token, which the account holder
// necessarily has, and orderByPinnedHash's fallback means even a random hash
// plays the top candidate.

test('a rating-limited account gets no 302 from play, with a real or a random hash', async () => {
  const kid = db.createUser('kid-play', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp()

  const real = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${hashA}` })
  const random = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${'f'.repeat(40)}` })

  assert.equal(real.statusCode, 404)
  assert.equal(random.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(kid.id), 0)
  await app.close()
})

test('a rating-limited account is refused when the meta lookup fails, not permitted', async () => {
  const kid = db.createUser('kid-meta', 'pw', 'kids', '1')
  db.setStremioEnabled(kid.id, true)
  const kidToken = db.mintStremioToken(kid.id)
  const app = await buildApp({ fetchMeta: async () => { throw new Error('tmdb down') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${kidToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(kid.id), 0)
  await app.close()
})

test('an unrestricted account still plays with the gate in place', async () => {
  const adult = db.createUser('adult-play', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(adult.id, true)
  const adultToken = db.mintStremioToken(adult.id)
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${adultToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 302)
  assert.equal(db.countStremioPlaysToday(adult.id), 1)
  await app.close()
})

// ── Fix round 1, commit 2: the cap must hold under concurrency ───────────────
//
// better-sqlite3 is synchronous and node is single-threaded, so every request
// in a burst finished its count read before the first write landed. The window
// was the whole burst, which on a leaked token is the containment mechanism
// gone: N concurrent requests bought N debrid resolutions.

test('20 concurrent plays against a cap of 1 yield exactly one 302', async () => {
  const burst = db.createUser('burst', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(burst.id, true)
  db.setStremioPlayCap(burst.id, 1)
  const burstToken = db.mintStremioToken(burst.id)
  const app = await buildApp()

  const results = await Promise.all(Array.from({ length: 20 }, () =>
    app.inject({ method: 'GET', url: `/stremio/${burstToken}/play/movie/tt0111161/${hashA}` })))

  const redirects = results.filter(res => res.statusCode === 302)
  const refusals = results.filter(res => res.statusCode === 429)
  assert.equal(redirects.length, 1, `expected exactly one 302, got ${redirects.length}`)
  assert.equal(refusals.length, 19)
  assert.equal(db.countStremioPlaysToday(burst.id), 1)
  await app.close()
})

test('a resolver that throws leaves no play recorded', async () => {
  const flaky = db.createUser('flaky', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(flaky.id, true)
  const flakyToken = db.mintStremioToken(flaky.id)
  const app = await buildApp({ resolvePlayback: async () => { throw new Error('torbox down') } })
  const res = await app.inject({ method: 'GET', url: `/stremio/${flakyToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(db.countStremioPlaysToday(flaky.id), 0)
  await app.close()
})

test('a released slot does not consume the cap', async () => {
  const retry = db.createUser('retry', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(retry.id, true)
  db.setStremioPlayCap(retry.id, 1)
  const retryToken = db.mintStremioToken(retry.id)

  const failing = await buildApp({ resolvePlayback: async () => { throw new Error('torbox down') } })
  assert.equal((await failing.inject({ method: 'GET', url: `/stremio/${retryToken}/play/movie/tt0111161/${hashA}` })).statusCode, 404)
  await failing.close()

  const working = await buildApp()
  assert.equal((await working.inject({ method: 'GET', url: `/stremio/${retryToken}/play/movie/tt0111161/${hashA}` })).statusCode, 302)
  assert.equal(db.countStremioPlaysToday(retry.id), 1)
  await working.close()
})

test('an admin is not held to the cap', async () => {
  const boss = db.createUser('boss', 'pw', 'admin', 'unrestricted')
  db.setStremioEnabled(boss.id, true)
  db.setStremioPlayCap(boss.id, 1)
  const bossToken = db.mintStremioToken(boss.id)
  const app = await buildApp()
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: 'GET', url: `/stremio/${bossToken}/play/movie/tt0111161/${hashA}` })
    assert.equal(res.statusCode, 302)
  }
  assert.equal(db.countStremioPlaysToday(boss.id), 3)
  await app.close()
})

// ── Fix round 1, commit 4: the cheap minors ─────────────────────────────────

test('a HEAD on the play route burns no cap slot and no resolution', async () => {
  const prober = db.createUser('prober', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(prober.id, true)
  db.setStremioPlayCap(prober.id, 1)
  const proberToken = db.mintStremioToken(prober.id)
  let resolverCalls = 0
  const app = Fastify()
  await app.register(stremioAddonRoutes, {
    fetchStreams: async () => [{ name: 'A', infoHash: hashA }],
    resolvePlayback: async () => { resolverCalls++; return { url: 'https://cdn.torbox.test/file.mkv' } },
    fetchMeta: async () => null,
  } as never)

  const head = await app.inject({ method: 'HEAD', url: `/stremio/${proberToken}/play/movie/tt0111161/${hashA}` })
  assert.notEqual(head.statusCode, 302)
  assert.equal(resolverCalls, 0)
  assert.equal(db.countStremioPlaysToday(prober.id), 0)

  // The quota the HEAD did not spend is still there for the real request.
  const get = await app.inject({ method: 'GET', url: `/stremio/${proberToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(get.statusCode, 302)
  assert.equal(resolverCalls, 1)
  assert.equal(db.countStremioPlaysToday(prober.id), 1)
  await app.close()
})

test('a resolver that returns no url gets a 404, not a redirect to nowhere', async () => {
  const broken = db.createUser('broken-resolver', 'pw', 'user', 'unrestricted')
  db.setStremioEnabled(broken.id, true)
  const brokenToken = db.mintStremioToken(broken.id)
  const app = await buildApp({ resolvePlayback: async () => ({}) })
  const res = await app.inject({ method: 'GET', url: `/stremio/${brokenToken}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 404)
  assert.equal(res.headers.location, undefined)
  assert.equal(db.countStremioPlaysToday(broken.id), 0)
  await app.close()
})

test('the play redirect is not cacheable, because it re-resolves at click time', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/stremio/${token}/play/movie/tt0111161/${hashA}` })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['cache-control'], 'no-store')
  await app.close()
})

test('the manifest and stream responses allow cross-origin reads, for Stremio Web', async () => {
  const app = await buildApp()
  const manifest = await app.inject({ method: 'GET', url: `/stremio/${token}/manifest.json` })
  const stream = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/tt0111161.json` })
  const notice = await app.inject({ method: 'GET', url: `/stremio/${token}/stream/movie/kitsu:1.json` })
  assert.equal(manifest.headers['access-control-allow-origin'], '*')
  assert.equal(stream.headers['access-control-allow-origin'], '*')
  assert.equal(notice.headers['access-control-allow-origin'], '*')
  await app.close()
})
