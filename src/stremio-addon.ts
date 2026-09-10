import { config } from './config.js'
import { extractHashFromStream, type Stream, type StremioMediaType } from './sootio.js'

export const ADDON_VERSION = '1.0.0'
export const ADDON_ID = 'io.fetcherr.streams'

export interface ParsedStremioId {
  mediaType: StremioMediaType
  imdbId: string
  externalId: string
}

// An IMDB id is an opaque identifier, not a number, so padded variants are not
// the same id spelled differently: they are strings IMDB never issued. Accept
// only the forms it does issue, exactly 7 digits or 8 to 10 with no leading
// zero, rather than normalizing padding away and letting a nonexistent id
// address a real title.
const IMDB_ID = /^tt(?:\d{7}|[1-9]\d{7,9})$/
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
  if (typeof rawId !== 'string') return null
  if (!rawId.endsWith('.json')) return null

  let id = rawId.slice(0, -'.json'.length)
  // Decode first. The traversal check below must stay below this line: run it
  // above the decode and %2e%2e%2f walks straight through it.
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
  // Season and episode are numbers, so canonicalize the padding: one title must
  // have one externalId. It keys provider stream caches, failed-play caches and
  // per-title accounting, and every extra spelling buys its own cache miss and
  // its own provider round-trip billed to one shared subscription.
  const seasonEpisode = SEASON_EPISODE.exec(`${parts[1]}:${parts[2]}`)
  if (!seasonEpisode) return null
  const season = Number(seasonEpisode[1])
  const episode = Number(seasonEpisode[2])
  return { mediaType, imdbId, externalId: `${imdbId}:${season}:${episode}` }
}

export const MAX_STREAMS = 10

export interface PlayUrlContext {
  origin: string
  token: string
  mediaType: StremioMediaType
  externalId: string
}

export function playUrlFor(ctx: PlayUrlContext, infoHash: string): string {
  // Encode every caller-supplied segment. Tokens are base64url and hashes are
  // hex today, so nothing needs it, but this function builds a URL and should
  // not depend on its callers staying disciplined.
  return `${ctx.origin}/stremio/${encodeURIComponent(ctx.token)}/play/${ctx.mediaType}/${encodeURIComponent(ctx.externalId)}/${encodeURIComponent(infoHash)}`
}

export function toStremioStreams(streams: Stream[], ctx: PlayUrlContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const stream of streams) {
    if (out.length >= MAX_STREAMS) break
    const hash = extractHashFromStream(stream)
    if (!hash || seen.has(hash)) continue
    seen.add(hash)
    // Truthiness, not typeof: an empty bingeGroup is a string, so a typeof check
    // would pass '' through and skip the per-hash fallback, and every stream
    // carrying '' would share one binge group. Stremio picks the next episode's
    // source from that. An empty filename and a zero videoSize would likewise
    // render as a blank name and a zero-byte file, so leave them out entirely.
    const upstreamBingeGroup = stream.behaviorHints?.bingeGroup
    const upstreamFilename = stream.behaviorHints?.filename
    const upstreamVideoSize = stream.behaviorHints?.videoSize
    const behaviorHints: Record<string, unknown> = {
      bingeGroup: typeof upstreamBingeGroup === 'string' && upstreamBingeGroup ? upstreamBingeGroup : `fetcherr-${hash}`,
    }
    if (typeof upstreamFilename === 'string' && upstreamFilename) behaviorHints.filename = upstreamFilename
    if (typeof upstreamVideoSize === 'number' && upstreamVideoSize > 0) behaviorHints.videoSize = upstreamVideoSize
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
  // Hex infohashes are case-insensitive and extractHashFromStream lowercases
  // what it returns, so normalize the pin here rather than trusting every
  // caller to. Comparing raw made a differently-cased pin match nothing and
  // fall through to the ranked order, silently serving another release.
  const wanted = infoHash.toLowerCase()
  // An unmatched pin still returns the ranked order on purpose. Stremio caches
  // stream lists for a long time and re-resolution legitimately reorders and
  // drops candidates, so failing hard on a stale pin would break playback for
  // someone who did nothing wrong.
  const pinned = streams.filter(stream => extractHashFromStream(stream) === wanted)
  const rest = streams.filter(stream => extractHashFromStream(stream) !== wanted)
  return [...pinned, ...rest]
}
