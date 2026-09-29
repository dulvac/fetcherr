import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { warmTorBoxLink, type WarmTorBoxLinkOptions } from '../src/torbox-link.js'

// Each test uses its own requestdl URL (a fresh token per test) so the module's
// module-level cache and in-flight map never leak a result from one test into
// another.
const requestdl = () => `https://api.torbox.app/v1/api/torrents/requestdl?token=${randomUUID()}&torrent_id=1&file_id=0`
const cdn = () => `https://store-021.weur.tb-cdn.st/${randomUUID()}?token=${randomUUID()}`

const noSleep = async () => {}

type Answer = { status: number; location?: string } | 'network-error'

// A fetch stub scripted per URL: each URL gets an ordered list of answers,
// the last one repeating once the list runs out.
function scriptedFetch(script: Record<string, Answer[]>) {
  const calls: string[] = []
  const counts = new Map<string, number>()
  const fetchImpl = (async (input: string | URL) => {
    const url = input.toString()
    calls.push(url)
    const n = counts.get(url) ?? 0
    counts.set(url, n + 1)
    const answers = script[url]
    if (!answers) throw new Error(`unscripted fetch: ${url}`)
    const answer = answers[Math.min(n, answers.length - 1)]
    if (answer === 'network-error') throw new Error('fake network error')
    return new Response(null, { status: answer.status, headers: answer.location ? { location: answer.location } : undefined })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, countOf: (url: string) => counts.get(url) ?? 0 }
}

test('a 400 twice then 206 warms the link and returns the CDN URL after three probes', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 400 }, { status: 400 }, { status: 206 }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
})

test('a 206 on the first probe returns the CDN URL after one probe, no log line', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 206 }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
  assert.equal(countOf(cdnUrl), 1)
  assert.equal(log.mock.calls.length, 0, 'a single probe needs no "ready after N probes" line')
})

test('a 400 past the probe budget falls back to the requestdl URL, and does not cache it', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const options: WarmTorBoxLinkOptions = { probeIntervalMs: 5, probeBudgetMs: 20, requestTimeoutMs: 1_000 }
  const script = { [requestdlUrl]: [{ status: 302, location: cdnUrl }], [cdnUrl]: [{ status: 400 }] }

  const first = scriptedFetch(script)
  const startedAt = Date.now()
  const result = await warmTorBoxLink(requestdlUrl, { ...options, fetch: first.fetchImpl })
  const elapsedMs = Date.now() - startedAt
  assert.equal(result, requestdlUrl)
  assert.ok(first.countOf(cdnUrl) >= 2, `expected more than one probe, got ${first.countOf(cdnUrl)}`)
  assert.ok(elapsedMs >= options.probeBudgetMs!, `expected at least the ${options.probeBudgetMs}ms budget to elapse, took ${elapsedMs}ms`)

  // Not cached: a second warm asks the network again instead of reusing a fallback.
  const second = scriptedFetch(script)
  const again = await warmTorBoxLink(requestdlUrl, { ...options, fetch: second.fetchImpl })
  assert.equal(again, requestdlUrl)
  assert.equal(second.countOf(requestdlUrl), 1, 'the fallback path must ask requestdl again, not reuse a cached fallback')
})

test('requestdl answering 200 with no Location returns the requestdl URL unchanged', async () => {
  const requestdlUrl = requestdl()
  const { fetchImpl } = scriptedFetch({ [requestdlUrl]: [{ status: 200 }] })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl }), requestdlUrl)
})

test('requestdl answering 500 with no Location returns the requestdl URL unchanged', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const { fetchImpl } = scriptedFetch({ [requestdlUrl]: [{ status: 500 }] })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl }), requestdlUrl)
})

test('a 404 on the CDN falls back to the requestdl URL', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 404 }],
  })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep }), requestdlUrl)
})

test('a network error probing the CDN falls back to the requestdl URL', async t => {
  t.mock.method(console, 'warn', () => {})
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: ['network-error'],
  })
  assert.equal(await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep }), requestdlUrl)
})

test('a 3xx from the CDN itself is returned and cached as-is', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const cdnRedirect = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 302, location: cdnRedirect }],
  })
  const result = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(result, cdnUrl)
  const again = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  assert.equal(again, cdnUrl)
  assert.equal(countOf(requestdlUrl), 1, 'the cached result must skip a second requestdl fetch')
})

test('two warms within ten minutes make one requestdl request; a warm ten minutes later asks again', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  const { fetchImpl, countOf } = scriptedFetch({
    [requestdlUrl]: [{ status: 302, location: cdnUrl }],
    [cdnUrl]: [{ status: 206 }],
  })
  let clock = 1_700_000_000_000
  const now = () => clock

  const first = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  clock += 9 * 60 * 1000
  const second = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  assert.equal(first, cdnUrl)
  assert.equal(second, cdnUrl)
  assert.equal(countOf(requestdlUrl), 1, 'still within the ten minute cache window')

  clock += 10 * 60 * 1000 + 1
  const third = await warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, now, sleep: noSleep })
  assert.equal(third, cdnUrl)
  assert.equal(countOf(requestdlUrl), 2, 'past the ten minute window, the cache must not answer')
})

test('two concurrent warms for the same URL share one in-flight request', async () => {
  const requestdlUrl = requestdl()
  const cdnUrl = cdn()
  let releaseRedirect: (() => void) | undefined
  const redirectGate = new Promise<void>(resolve => { releaseRedirect = resolve })
  let redirectCalls = 0
  const fetchImpl = (async (input: string | URL) => {
    const url = input.toString()
    if (url === requestdlUrl) {
      redirectCalls++
      await redirectGate
      return new Response(null, { status: 302, headers: { location: cdnUrl } })
    }
    return new Response(null, { status: 206 })
  }) as unknown as typeof fetch

  const first = warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  const second = warmTorBoxLink(requestdlUrl, { fetch: fetchImpl, sleep: noSleep })
  releaseRedirect?.()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult, cdnUrl)
  assert.equal(secondResult, cdnUrl)
  assert.equal(redirectCalls, 1, 'only one caller should have reached requestdl')
})

test('no log line ever names a query string', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})

  // One warm that needs three probes (logs the "ready after N probes" info line)...
  const readyRequestdlUrl = requestdl()
  const readyCdnUrl = cdn()
  const readyFetch = scriptedFetch({
    [readyRequestdlUrl]: [{ status: 302, location: readyCdnUrl }],
    [readyCdnUrl]: [{ status: 400 }, { status: 206 }],
  })
  await warmTorBoxLink(readyRequestdlUrl, { fetch: readyFetch.fetchImpl, sleep: noSleep })

  // ...and one that exhausts its budget and falls back (logs the warn line).
  const fallbackRequestdlUrl = requestdl()
  const fallbackCdnUrl = cdn()
  const fallbackFetch = scriptedFetch({
    [fallbackRequestdlUrl]: [{ status: 302, location: fallbackCdnUrl }],
    [fallbackCdnUrl]: [{ status: 400 }],
  })
  await warmTorBoxLink(fallbackRequestdlUrl, { fetch: fallbackFetch.fetchImpl, probeIntervalMs: 1, probeBudgetMs: 5 })

  const allLines = [...log.mock.calls, ...warn.mock.calls].map(call => String(call.arguments[0]))
  assert.ok(allLines.length > 0, 'expected at least the ready and fallback lines to have logged')
  for (const line of allLines) assert.ok(!line.includes('token='), line)
})
