import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

// Streams fetcherr serves itself instead of redirecting to. aiostreams' native
// usenet engine hands out URLs under its own BASE_URL, a LAN address, so a
// remote player cannot follow a redirect there. The prefixes come from
// STREAM_RELAY_PREFIXES (config.streamRelayPrefixes); anything outside them
// still gets a 302, so fetcherr never becomes an open proxy.

export function isRelayedUrl(url: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => url.startsWith(prefix))
}

// The URL as aiostreams minted it names the host-published port. Inside the
// stack the same path answers at the configured addon origin (aiostreams:3000),
// the swap the playback unwrap already makes, so that origin goes first and the
// minted URL stays as the last resort.
export function relayCandidates(url: string, origins: readonly string[]): string[] {
  let parsed: URL
  try { parsed = new URL(url) } catch { return [] }
  const out: string[] = []
  for (const origin of origins) {
    let swapped: URL
    try { swapped = new URL(`${parsed.pathname}${parsed.search}`, origin) } catch { continue }
    if (swapped.origin === parsed.origin) continue
    const value = swapped.toString()
    if (!out.includes(value)) out.push(value)
  }
  out.push(parsed.toString())
  return out
}

// The upstream URL that last answered, per play. A relayed play serves every
// range request on the same /play URL, so without this each seek would resolve
// the title again.
export class RelayMemory {
  private readonly entries = new Map<string, { url: string; expiresAt: number }>()

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.url
  }

  set(key: string, url: string): void {
    const now = this.now()
    for (const [other, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(other)
    }
    this.entries.set(key, { url, expiresAt: now + this.ttlMs })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}

export interface RelayOptions {
  log: { warn: (message: string) => void }
  // Names the play in the failure log line.
  label: string
  // Tests pass a stand-in; production uses the global fetch.
  fetchImpl?: typeof fetch
  // The candidate that answered, so the caller can remember it.
  onRelayed?: (url: string) => void
  // No candidate answered with 200 or 206.
  onFailed?: () => void
}

const FORWARDED_REQUEST_HEADERS = ['range', 'if-range'] as const
const PASSED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return 'unknown host' }
}

export async function relayStream(
  req: FastifyRequest,
  reply: FastifyReply,
  candidates: readonly string[],
  options: RelayOptions,
): Promise<FastifyReply> {
  const fetchImpl = options.fetchImpl ?? fetch
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET'
  const headers: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) headers[name] = value
  }

  // 'close' fires both when the response finishes and when the viewer goes away
  // first. Only the second may cancel the upstream read, which is what frees
  // the engine's provider connections.
  const controller = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort()
  })

  let problem = 'no candidates'
  for (const candidate of candidates) {
    let res: Response
    try {
      res = await fetchImpl(candidate, { method, headers, redirect: 'manual', signal: controller.signal })
    } catch (err) {
      problem = `${hostOf(candidate)}: ${err instanceof Error ? err.name : 'request failed'}`
      if (controller.signal.aborted) break
      continue
    }
    // aiostreams answers a failed stream with a redirect to its own error clip,
    // a relative URL that would land on fetcherr. Anything but 200 or 206 is a
    // failure here.
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {})
      problem = `${hostOf(candidate)} answered ${res.status}`
      continue
    }
    options.onRelayed?.(candidate)
    reply.code(res.status)
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = res.headers.get(name)
      if (value) reply.header(name, value)
    }
    reply.header('cache-control', 'no-store')
    if (method === 'HEAD' || !res.body) {
      await res.body?.cancel().catch(() => {})
      // An empty stream, not an empty send: fastify's HEAD handling sets
      // Content-Length to 0 for an undefined payload, and a player probing with
      // HEAD needs the real size.
      return reply.send(Readable.from([]))
    }
    return reply.send(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>))
  }

  options.onFailed?.()
  options.log.warn(`playback: relay failed for ${options.label}: ${problem}`)
  return reply.code(502).send({ error: 'Stream relay failed' })
}
