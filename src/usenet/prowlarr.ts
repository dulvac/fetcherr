import { config } from '../config.js'

export interface NzbResult {
  guid: string
  title: string
  sizeBytes: number
  downloadUrl: string
  grabs: number
}

function parseRssItems(xml: string): NzbResult[] {
  const results: NzbResult[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const titleCdata = block.match(/<title><!\[CDATA\[(.*?)\]\]>/)
    const title = titleCdata?.[1] ?? block.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    const url = block.match(/enclosure[^>]+url="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? ''
    const linkUrl = block.match(/<link>(.*?)<\/link>/)?.[1]?.replace(/&amp;/g, '&') ?? ''
    const downloadUrl = url || linkUrl
    const sizeTag = block.match(/<size>(\d+)<\/size>/)?.[1]
    const sizeAttr = block.match(/newznab:attr[^>]+name="size"[^>]+value="(\d+)"/)?.[1]
    const encLength = block.match(/enclosure[^>]+length="(\d+)"/)?.[1]
    const sizeBytes = parseInt(sizeAttr ?? sizeTag ?? encLength ?? '0', 10) || 0
    const grabsAttr = block.match(/newznab:attr[^>]+name="grabs"[^>]+value="(\d+)"/)?.[1]
    const grabs = parseInt(grabsAttr ?? '0', 10) || 0
    const guid = block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? downloadUrl
    if (downloadUrl && title) results.push({ guid, title, sizeBytes, downloadUrl, grabs })
  }
  return results
}

// Cache indexer IDs for 1 hour — avoids one extra Prowlarr API call per search
let indexerIdCache: { ids: number[]; expiresAt: number } | null = null

async function getUsenetIndexerIds(): Promise<number[]> {
  const now = Date.now()
  if (indexerIdCache && now < indexerIdCache.expiresAt) return indexerIdCache.ids
  const res = await fetch(`${config.prowlarrUrl}/api/v1/indexer`, {
    headers: { 'X-Api-Key': config.prowlarrApiKey },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Prowlarr indexers ${res.status}`)
  const data = await res.json() as Array<{ id: number; enable: boolean; protocol: string }>
  const ids = data.filter(i => i.enable && i.protocol === 'usenet').map(i => i.id)
  indexerIdCache = { ids, expiresAt: now + 60 * 60 * 1000 }
  return ids
}

// Global throttle: one Prowlarr search at a time, minimum 2s between requests
// NZBgeek (and most indexers) enforce per-account rate limits
let searchQueue: Promise<void> = Promise.resolve()
const MIN_SEARCH_INTERVAL_MS = 2_000

// Per-indexer rate limit: if an indexer returns 429, skip it until the backoff expires.
// Never block the global queue waiting for a long Retry-After.
const indexerRateLimitedUntil = new Map<number, number>()

async function searchIndexer(indexerId: number, params: Record<string, string>): Promise<NzbResult[]> {
  const rateLimitedUntil = indexerRateLimitedUntil.get(indexerId) ?? 0
  if (Date.now() < rateLimitedUntil) {
    console.warn(`[usenet/prowlarr] indexer ${indexerId} still rate limited, skipping`)
    return []
  }

  const result = new Promise<NzbResult[]>((resolve) => {
    searchQueue = searchQueue.then(async () => {
      // Re-check inside queue in case it became rate-limited while waiting
      const stillLimited = indexerRateLimitedUntil.get(indexerId) ?? 0
      if (Date.now() < stillLimited) {
        console.warn(`[usenet/prowlarr] indexer ${indexerId} rate limited, skipping`)
        resolve([])
        await new Promise(r => setTimeout(r, MIN_SEARCH_INTERVAL_MS))
        return
      }

      const url = new URL(`${config.prowlarrUrl}/${indexerId}/api`)
      url.searchParams.set('apikey', config.prowlarrApiKey)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      try {
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) })
        if (res.status === 429) {
          const retryAfter = Math.min(parseInt(res.headers.get('Retry-After') ?? '300', 10), 3600)
          console.warn(`[usenet/prowlarr] indexer ${indexerId} rate limited for ${retryAfter}s`)
          indexerRateLimitedUntil.set(indexerId, Date.now() + retryAfter * 1000)
          resolve([])
        } else if (!res.ok) {
          console.warn(`[usenet/prowlarr] indexer ${indexerId} returned ${res.status}`)
          resolve([])
        } else {
          resolve(parseRssItems(await res.text()))
        }
      } catch (e: unknown) {
        console.warn(`[usenet/prowlarr] indexer ${indexerId} fetch failed:`, (e as Error)?.message ?? e)
        resolve([])
      }
      await new Promise(r => setTimeout(r, MIN_SEARCH_INTERVAL_MS))
    })
  })
  return result
}

const HD_PATTERN  = /\b(2160p|4k|uhd|1080p)\b/i
const LOW_PATTERN = /\b(720p|480p|576p|dvdscr|dvdrip|hdcam|cam|ts|telesync)\b/i

function isHd(title: string): boolean {
  return HD_PATTERN.test(title) || !LOW_PATTERN.test(title)
}

function selectBestNzb(results: NzbResult[], maxBytes: number): NzbResult | null {
  if (!results.length) return null
  const byGrabs = (a: NzbResult, b: NzbResult) => b.grabs - a.grabs
  const fits = results.filter(r => r.sizeBytes === 0 || r.sizeBytes <= maxBytes)
  const pool = fits.length ? fits : [...results]
  const hd = pool.filter(r => isHd(r.title)).sort(byGrabs)
  return hd[0] ?? pool.sort(byGrabs)[0]
}

export async function searchMovieNzb(imdbId: string): Promise<NzbResult | null> {
  const ids = await getUsenetIndexerIds()
  if (!ids.length) return null
  const id = imdbId.replace(/^tt/i, '')
  const results = (await Promise.all(
    ids.map(i => searchIndexer(i, { t: 'movie', imdbid: id, cat: '2000' }))
  )).flat()
  return selectBestNzb(results, 20 * 1e9)
}

export async function searchEpisodeNzb(tvdbId: number, season: number, episode: number): Promise<NzbResult | null> {
  const ids = await getUsenetIndexerIds()
  if (!ids.length) return null
  const results = (await Promise.all(
    ids.map(i => searchIndexer(i, {
      t: 'tvsearch', tvdbid: String(tvdbId), season: String(season), ep: String(episode), cat: '5000',
    }))
  )).flat()
  return selectBestNzb(results, 5 * 1e9)
}

export function isProwlarrConfigured(): boolean {
  return Boolean(config.prowlarrUrl && config.prowlarrApiKey)
}
