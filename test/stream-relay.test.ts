import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { request } from 'node:http'
import { parseRelayPrefixes } from '../src/config.js'
import { isRelayedUrl, relayCandidates, relayStream, RelayMemory, type RelayOptions } from '../src/stream-relay.js'
import { FAKE_BODY, startFakeAiostreams } from './fake-aiostreams.js'

const PREFIX = 'http://192.168.87.33:3002/api/v1/usenet/stream/'

test('relay prefixes: a comma list of http(s) URLs with a path', () => {
  assert.deepEqual(parseRelayPrefixes(undefined), [])
  assert.deepEqual(parseRelayPrefixes(''), [])
  assert.deepEqual(parseRelayPrefixes(` ${PREFIX} , https://relay.example/a/ ,,`), [PREFIX, 'https://relay.example/a/'])
  assert.deepEqual(parseRelayPrefixes(`${PREFIX},${PREFIX}`), [PREFIX])
})

test('relay prefixes: a bare origin, another scheme or garbage is dropped', () => {
  assert.deepEqual(parseRelayPrefixes('http://192.168.87.33:3002'), [])
  assert.deepEqual(parseRelayPrefixes('http://192.168.87.33:3002/'), [])
  assert.deepEqual(parseRelayPrefixes('ftp://host/path/'), [])
  assert.deepEqual(parseRelayPrefixes('not a url'), [])
})

test('only URLs under a listed prefix are relayed', () => {
  assert.equal(isRelayedUrl(`${PREFIX}abc`, [PREFIX]), true)
  assert.equal(isRelayedUrl('https://store-021.weur.tb-cdn.st/abc.mkv', [PREFIX]), false)
  assert.equal(isRelayedUrl('http://192.168.87.33:3002/api/v1/debrid/playback/abc', [PREFIX]), false)
  assert.equal(isRelayedUrl(`${PREFIX}abc`, []), false)
})

test('the in-stack origin is tried first and the minted URL last', () => {
  assert.deepEqual(
    relayCandidates(`${PREFIX}tok?x=1`, ['http://aiostreams:3000']),
    ['http://aiostreams:3000/api/v1/usenet/stream/tok?x=1', `${PREFIX}tok?x=1`],
  )
  // An origin equal to the minted one is not tried twice.
  assert.deepEqual(relayCandidates(`${PREFIX}tok`, ['http://192.168.87.33:3002']), [`${PREFIX}tok`])
  assert.deepEqual(relayCandidates('not a url', ['http://aiostreams:3000']), [])
})

test('relay memory forgets an entry once it expires, and set refreshes it', () => {
  let now = 1_000
  const memory = new RelayMemory(100, () => now)
  memory.set('/play/tt1', 'http://aiostreams:3000/api/v1/usenet/stream/a')
  now = 1_050
  assert.equal(memory.get('/play/tt1'), 'http://aiostreams:3000/api/v1/usenet/stream/a')
  memory.set('/play/tt1', 'http://aiostreams:3000/api/v1/usenet/stream/a')
  now = 1_140
  assert.equal(memory.get('/play/tt1'), 'http://aiostreams:3000/api/v1/usenet/stream/a')
  now = 1_151
  assert.equal(memory.get('/play/tt1'), undefined)
  memory.set('/play/tt2', 'u')
  memory.delete('/play/tt2')
  assert.equal(memory.get('/play/tt2'), undefined)
})

test('relay memory only forgets a play when it still holds one of the URLs that failed', () => {
  const memory = new RelayMemory(1000)
  memory.set('/play/tt1', 'http://aiostreams:3000/api/v1/usenet/stream/new')
  // A parallel request stored a newer URL; a failure of the old one must not erase it.
  assert.equal(memory.deleteIfHolding('/play/tt1', ['http://aiostreams:3000/api/v1/usenet/stream/old']), false)
  assert.equal(memory.get('/play/tt1'), 'http://aiostreams:3000/api/v1/usenet/stream/new')
  assert.equal(memory.deleteIfHolding('/play/tt1', ['http://aiostreams:3000/api/v1/usenet/stream/new']), true)
  assert.equal(memory.get('/play/tt1'), undefined)
  // Nothing remembered: the caller may clear what depends on it.
  assert.equal(memory.deleteIfHolding('/play/tt2', ['x']), true)
})

// A bare fastify app whose one route relays to the given candidates, so the
// tests exercise relayStream the way the /play routes call it.
async function relayApp(candidates: string[], extra: Partial<RelayOptions> = {}) {
  const warnings: string[] = []
  const relayed: string[] = []
  let failed = 0
  const tried: string[][] = []
  const app: FastifyInstance = Fastify()
  app.get('/play/tt0111161', (req, reply) => relayStream(req, reply, candidates, {
    log: { warn: message => { warnings.push(message) } },
    label: 'tt0111161',
    onRelayed: url => { relayed.push(url) },
    onFailed: urls => { failed++; tried.push([...urls]) },
    ...extra,
  }))
  return { app, warnings, relayed, failures: () => failed, tried }
}

test('a range request is passed through with the upstream status, headers and bytes', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app, relayed } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/good`])
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161', headers: { range: 'bytes=1000-1999' } })
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], `bytes 1000-1999/${FAKE_BODY.length}`)
  assert.equal(res.headers['content-length'], '1000')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(res.headers['content-type'], 'video/x-matroska')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-internal'], undefined)
  assert.ok(res.rawPayload.equals(FAKE_BODY.subarray(1000, 2000)))
  assert.deepEqual(upstream.requests, [{ method: 'GET', path: '/api/v1/usenet/stream/good', range: 'bytes=1000-1999' }])
  assert.deepEqual(relayed, [`${upstream.origin}/api/v1/usenet/stream/good`])
})

test('a request without Range gets the whole body with a 200', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/good`])
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], String(FAKE_BODY.length))
  assert.ok(res.rawPayload.equals(FAKE_BODY))
  assert.equal(upstream.requests[0].range, undefined)
})

test('HEAD is forwarded as HEAD and answers with headers only', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/good`])
  t.after(() => app.close())
  const res = await app.inject({ method: 'HEAD', url: '/play/tt0111161' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], String(FAKE_BODY.length))
  assert.equal(res.rawPayload.length, 0)
  assert.equal(upstream.requests[0].method, 'HEAD')
})

test("aiostreams' redirect to its error clip becomes a 502, not a redirect", async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app, warnings, failures } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/error`])
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161' })
  assert.equal(res.statusCode, 502)
  assert.equal(res.headers.location, undefined)
  assert.equal(failures(), 1)
  assert.match(warnings.join('\n'), /relay failed for tt0111161: 127\.0\.0\.1:\d+ answered 307/)
})

test('a dead first candidate falls through to the next one', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app, relayed } = await relayApp([
    'http://127.0.0.1:1/api/v1/usenet/stream/good',
    `${upstream.origin}/api/v1/usenet/stream/gone`,
    `${upstream.origin}/api/v1/usenet/stream/good`,
  ])
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161', headers: { range: 'bytes=0-9' } })
  assert.equal(res.statusCode, 206)
  assert.deepEqual(relayed, [`${upstream.origin}/api/v1/usenet/stream/good`])
})

test('when every candidate fails the viewer gets a 502 and the log names no token', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app, warnings, failures } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/gone`])
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161' })
  assert.equal(res.statusCode, 502)
  assert.deepEqual(res.json(), { error: 'Stream relay failed' })
  assert.equal(failures(), 1)
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes('/api/v1/usenet/stream/'), warnings[0])
})

test('a failure tells the caller which URLs it tried', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const urls = [`${upstream.origin}/api/v1/usenet/stream/gone`, `${upstream.origin}/api/v1/usenet/stream/error`]
  const { app, tried } = await relayApp(urls)
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/play/tt0111161' })
  assert.equal(res.statusCode, 502)
  assert.deepEqual(tried, [urls])
})

test('a viewer who disconnects cancels the upstream read', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/endless`])
  t.after(() => app.close())
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path: '/play/tt0111161' }, res => {
      assert.equal(res.statusCode, 200)
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', err => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err) })
    req.end()
  })
  const closed = await Promise.race([
    upstream.endlessClosed().then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)),
  ])
  assert.equal(closed, true, 'the upstream stream was still open 3 s after the viewer left')
})

test('a viewer who leaves before the upstream answers is not a relay failure', async t => {
  const upstream = await startFakeAiostreams()
  t.after(() => upstream.close())
  const { app, warnings, failures } = await relayApp([`${upstream.origin}/api/v1/usenet/stream/slow`])
  t.after(() => app.close())
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => {
    const req = request({ host: '127.0.0.1', port: address.port, path: '/play/tt0111161' })
    req.on('error', () => resolve())
    req.end()
    setTimeout(() => { req.destroy(); resolve() }, 100)
  })
  // Give the relay time to see the abort and to finish whatever it does next.
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(upstream.requests.length, 1)
  assert.equal(failures(), 0)
  assert.deepEqual(warnings, [])
})
