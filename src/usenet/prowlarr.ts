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

async function searchIndexer(indexerId: number, params: Record<string, string>): Promise<NzbResult[]> {
  const url = new URL(`${config.prowlarrUrl}/${indexerId}/api`)
  url.searchParams.set('apikey', config.prowlarrApiKey)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) })
  } catch (e: unknown) {
    console.warn(`[usenet/prowlarr] indexer ${indexerId} fetch failed:`, (e as Error)?.message ?? e)
    return []
  }
  if (!res.ok) {
    console.warn(`[usenet/prowlarr] indexer ${indexerId} returned ${res.status}`)
    return []
  }
  return parseRssItems(await res.text())
}

async function getUsenetIndexerIds(): Promise<number[]> {
  const res = await fetch(`${config.prowlarrUrl}/api/v1/indexer`, {
    headers: { 'X-Api-Key': config.prowlarrApiKey },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Prowlarr indexers ${res.status}`)
  const data = await res.json() as Array<{ id: number; enable: boolean; protocol: string }>
  return data.filter(i => i.enable && i.protocol === 'usenet').map(i => i.id)
}

function selectBestNzb(results: NzbResult[], maxBytes: number): NzbResult | null {
  if (!results.length) return null
  const fits = results
    .filter(r => r.sizeBytes === 0 || r.sizeBytes <= maxBytes)
    .sort((a, b) => b.grabs - a.grabs)
  return fits[0] ?? [...results].sort((a, b) => b.grabs - a.grabs)[0]
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
