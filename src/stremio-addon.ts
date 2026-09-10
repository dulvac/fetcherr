import { config } from './config.js'
import { extractHashFromStream, type Stream, type StremioMediaType } from './sootio.js'

export const ADDON_VERSION = '1.0.0'
export const ADDON_ID = 'io.fetcherr.streams'

export interface ParsedStremioId {
  mediaType: StremioMediaType
  imdbId: string
  externalId: string
}

const IMDB_ID = /^tt\d{7,10}$/
const SEASON_EPISODE = /^(\d{1,4}):(\d{1,4})$/

export function buildManifest(): Record<string, unknown> {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: `${config.serverName} Streams`,
    description: 'Debrid streams resolved by Fetcherr.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  }
}

export function parseStremioStreamId(mediaType: string, rawId: string): ParsedStremioId | null {
  if (mediaType !== 'movie' && mediaType !== 'series') return null
  if (!rawId.endsWith('.json')) return null

  let id = rawId.slice(0, -'.json'.length)
  try { id = decodeURIComponent(id) } catch { return null }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return null

  const parts = id.split(':')
  const imdbId = parts[0] ?? ''
  if (!IMDB_ID.test(imdbId)) return null

  if (mediaType === 'movie') {
    if (parts.length !== 1) return null
    return { mediaType, imdbId, externalId: imdbId }
  }

  if (parts.length !== 3) return null
  if (!SEASON_EPISODE.test(`${parts[1]}:${parts[2]}`)) return null
  return { mediaType, imdbId, externalId: `${imdbId}:${parts[1]}:${parts[2]}` }
}

export const MAX_STREAMS = 10

export interface PlayUrlContext {
  origin: string
  token: string
  mediaType: StremioMediaType
  externalId: string
}

export function playUrlFor(ctx: PlayUrlContext, infoHash: string): string {
  return `${ctx.origin}/stremio/${ctx.token}/play/${ctx.mediaType}/${encodeURIComponent(ctx.externalId)}/${infoHash}`
}

export function toStremioStreams(streams: Stream[], ctx: PlayUrlContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const stream of streams) {
    if (out.length >= MAX_STREAMS) break
    const hash = extractHashFromStream(stream)
    if (!hash || seen.has(hash)) continue
    seen.add(hash)
    const behaviorHints: Record<string, unknown> = {
      bingeGroup: typeof stream.behaviorHints?.bingeGroup === 'string' ? stream.behaviorHints.bingeGroup : `fetcherr-${hash}`,
    }
    if (typeof stream.behaviorHints?.filename === 'string') behaviorHints.filename = stream.behaviorHints.filename
    if (typeof stream.behaviorHints?.videoSize === 'number') behaviorHints.videoSize = stream.behaviorHints.videoSize
    out.push({
      name: stream.name ?? 'Fetcherr',
      description: stream.title ?? stream.description ?? '',
      url: playUrlFor(ctx, hash),
      behaviorHints,
    })
  }
  return out
}

export function noticeStreams(message: string, origin: string): Record<string, unknown>[] {
  return [{ name: 'Fetcherr', description: message, externalUrl: origin }]
}

export function orderByPinnedHash(streams: Stream[], infoHash: string): Stream[] {
  const pinned = streams.filter(stream => extractHashFromStream(stream) === infoHash)
  const rest = streams.filter(stream => extractHashFromStream(stream) !== infoHash)
  return [...pinned, ...rest]
}
