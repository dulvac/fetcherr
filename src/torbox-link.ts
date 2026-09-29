import { trimCacheMap } from './cache-utils.js'

// TorBox's requestdl endpoint redirects to a CDN URL whose presigned token the
// CDN node needs about a second to learn. A player that hits the CDN URL in
// that window gets a 400 ("Invalid Presigned Token") and, for Infuse, gives up
// on the first failure. So fetcherr follows the redirect itself, waits for the
// CDN to answer, and only then sends the player a URL that already works.

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 500
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_PROBE_INTERVAL_MS = 150
const DEFAULT_PROBE_BUDGET_MS = 4_000

export interface WarmTorBoxLinkOptions {
  fetch?:             typeof fetch
  now?:               () => number
  sleep?:             (ms: number) => Promise<void>
  requestTimeoutMs?:  number
  probeIntervalMs?:   number
  probeBudgetMs?:     number
}

interface CacheEntry {
  url:       string
  expiresAt: number
}

// Keyed by the requestdl URL, which is unique per playback attempt (it carries
// the torrent id and file id), so distinct plays never collide here.
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string>>()

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Query strings carry TorBox's API key (requestdl) or a presigned token (the
// CDN URL). Logging only host and path keeps both out of the logs.
function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return 'invalid url'
  }
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {})
}

export async function warmTorBoxLink(requestdlUrl: string, options: WarmTorBoxLinkOptions = {}): Promise<string> {
  const now = options.now ?? Date.now
  const cached = cache.get(requestdlUrl)
  if (cached && cached.expiresAt > now()) return cached.url

  const running = inflight.get(requestdlUrl)
  if (running) return running

  const promise = warmUncached(requestdlUrl, options).finally(() => inflight.delete(requestdlUrl))
  inflight.set(requestdlUrl, promise)
  return promise
}

async function warmUncached(requestdlUrl: string, options: WarmTorBoxLinkOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const probeBudgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS

  let cdnUrl: string
  try {
    const res = await fetchImpl(requestdlUrl, { redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs) })
    await cancelBody(res)
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return requestdlUrl
    cdnUrl = new URL(location, requestdlUrl).href
  } catch {
    // No usable redirect: today's behaviour is to hand the player the
    // requestdl URL, so a broken follow-up is no worse than before this change.
    return requestdlUrl
  }

  const start = now()
  let probes = 0
  while (true) {
    probes++
    let res: Response
    try {
      res = await fetchImpl(cdnUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch {
      return fallback(requestdlUrl, cdnUrl)
    }
    await cancelBody(res)

    if (res.status >= 200 && res.status < 300) return ready()
    if (res.status >= 300 && res.status < 400) return ready()
    if (res.status === 400 && now() - start < probeBudgetMs) {
      await sleep(probeIntervalMs)
      continue
    }
    return fallback(requestdlUrl, cdnUrl)
  }

  function ready(): string {
    if (probes > 1) console.log(`play: TorBox link ready after ${probes} probes (${now() - start} ms)`)
    cache.set(requestdlUrl, { url: cdnUrl, expiresAt: now() + CACHE_TTL_MS })
    trimCacheMap(cache, CACHE_MAX_ENTRIES)
    return cdnUrl
  }
}

function fallback(requestdlUrl: string, cdnUrl: string): string {
  console.warn(`play: TorBox link still not answering, falling back to requestdl (${hostAndPath(cdnUrl)})`)
  return requestdlUrl
}
