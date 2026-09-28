import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.js'
import {
  countStremioPlaysToday, finalizeStremioPlay, getUserByStremioToken, hasRatingLimit,
  releaseStremioPlay, reserveStremioPlay, type AppUser,
} from './db.js'
import { buildPlaybackOrigin } from './play-auth.js'
import { extractHashFromStream, type Stream, type StremioMediaType, type StremioMeta } from './sootio.js'
import { canUserAccessStremioMeta } from './stremio-rating.js'
import { subtitleLanguageName } from './subtitle-lang.js'
import { rankForFile } from './subtitle-rank.js'
import { displayLabel } from './subtitle-streams.js'
import type { SubtitleExtra, SubtitleTrack } from './subtitles.js'

// Bumped when the manifest changes, so installed clients can tell. 1.1.0 added
// the subtitles resource.
export const ADDON_VERSION = '1.1.0'
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
    resources: ['stream', 'subtitles'],
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
  // Same defensive guard parseStremioStreamId has, so the two functions stop
  // disagreeing: a non-string pin used to throw from .toLowerCase() where before
  // it returned the ranked order.
  if (typeof infoHash !== 'string') return streams
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

const VIDEO_HASH = /^[0-9a-f]{16}$/
const VIDEO_SIZE = /^\d{1,15}$/

// The extra segment is a querystring before .json, as the addon SDK router builds
// it: videoHash=...&videoSize=...&filename=... Only plausible values are kept,
// because they go into a URL fetched on the viewer's behalf. The caller passes
// the raw segment, still percent-encoded, so an & inside a filename stays part
// of the filename.
export function parseSubtitleExtra(rawSegment: string): SubtitleExtra | null {
  if (typeof rawSegment !== 'string' || !rawSegment.endsWith('.json')) return null
  const params = new URLSearchParams(rawSegment.slice(0, -'.json'.length))
  const extra: SubtitleExtra = {}
  const hash = params.get('videoHash')?.toLowerCase()
  if (hash && VIDEO_HASH.test(hash)) extra.videoHash = hash
  const size = params.get('videoSize')
  if (size && VIDEO_SIZE.test(size)) extra.videoSize = size
  const filename = params.get('filename')?.trim()
  if (filename && filename.length <= 255 && !/[\u0000-\u001f]/.test(filename)) extra.filename = filename
  return extra
}

// The protocol has no default-track field, and the client's own language setting
// chooses, so on Stremio an account's preference can only move its language to
// the front.
export function orderPreferredFirst<T extends { lang: string }>(tracks: T[], preferred: string): T[] {
  if (!preferred) return tracks
  return [...tracks.filter(track => track.lang === preferred), ...tracks.filter(track => track.lang !== preferred)]
}

// The raw path segments after /stremio/:token/subtitles/:mediaType/:id, however
// the plugin is mounted. Raw, because Fastify decodes route params, which would
// turn a %26 inside a filename into a separator.
function rawSegmentsAfterSubtitleId(url: string, mountPath: string): string[] {
  const segments = url.split('?')[0].split('/').filter(Boolean)
  return segments.slice(mountPath.split('/').filter(Boolean).length + 5)
}

// ── Routes ───────────────────────────────────────────────────────────────────
//
// Everything below sits under /stremio/, and nothing else may be registered
// here. /stremio/* is the one prefix on the streaming host that is exempt from
// the network's IP allowlist, because Stremio clients cannot perform the
// interactive sign-in every other path requires. The token in the URL is the
// only credential these routes get, so treat each one as internet-facing.

// Lowercase only, on purpose: no /i flag. The path segment is lowercased before
// it is matched, so an uppercase hash is canonicalized rather than refused,
// and anything that is not 40 hex characters never reaches a provider.
const INFO_HASH = /^[0-9a-f]{40}$/
const NOT_FOUND = { error: 'Not found' }
// Stremio Web fetches the manifest and the stream list with XHR and refuses to
// install an addon without this. Native clients do not care, but "any Stremio
// client" is the point of the feature.
const ADDON_HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }

export interface StremioAddonRouteOptions {
  fetchStreams: (mediaType: StremioMediaType, externalId: string) => Promise<Stream[]>
  resolvePlayback: (streams: Stream[], label: string, cacheKey: string) => Promise<{ url: string; filename?: string }>
  fetchMeta: (mediaType: StremioMediaType, imdbId: string) => Promise<StremioMeta | null>
  // Optional, so a registration without it answers the subtitles resource with an
  // empty list rather than failing.
  fetchSubtitles?: (mediaType: StremioMediaType, externalId: string, extra?: SubtitleExtra) => Promise<SubtitleTrack[]>
}

// The token is a path segment, so fastify's own request logging and every
// reverse-proxy access log would capture it verbatim. Keep enough to correlate
// two requests from the same client, never enough to replay one.
function tokenHint(token: string): string {
  return token ? `${token.slice(0, 6)}~` : 'none'
}

// The one source of truth for where these routes live. Route registration and the
// redactor both derive from it, so they cannot disagree: anchoring the redactor
// on a hardcoded '/stremio/' was only correct because the plugin happened to be
// mounted without a prefix, and adding one later would have written tokens into
// the logs with nothing failing.
const STREMIO_ROUTE_PREFIX = '/stremio'

export function redactStremioToken(url: string, mountPath = ''): string {
  const anchor = `${mountPath}${STREMIO_ROUTE_PREFIX}/`
  if (!url.startsWith(anchor)) return url
  const rest = url.slice(anchor.length)
  const boundary = rest.search(/[/?#]/)
  const token = boundary === -1 ? rest : rest.slice(0, boundary)
  const tail = boundary === -1 ? '' : rest.slice(boundary)
  return `${anchor}${tokenHint(token)}${tail}`
}

// Applied to every route here. Fastify emits its own request line before any
// handler or onRequest hook runs, so redacting inside a handler would be too
// late: 'silent' suppresses the route's automatic request and response logging
// entirely, and the onResponse hook below puts back one line with the token
// segment already reduced to a hint.
const SILENCE_DEFAULT_REQUEST_LOG = { logLevel: 'silent' as const }

function userForToken(token: string): AppUser | null {
  const user = getUserByStremioToken(token)
  // A token that was never issued and a token whose account has been switched
  // off must be indistinguishable: same status, same body, no hint which it was.
  if (!user || !user.stremioEnabled) return null
  return user
}

// Admins are bounded too, just generously. The owner's own install URL is the one
// pasted into a chat while showing someone how to install it, screenshotted during
// setup, and installed on the most devices, so it needs the brake more than most.
// 200 is far above any real day's viewing and still bounds a leaked token.
const ADMIN_PLAY_CAP = 200

export function playCapFor(user: Pick<AppUser, 'role' | 'stremioPlayCap'>): number {
  return user.role === 'admin' ? ADMIN_PLAY_CAP : user.stremioPlayCap
}

// The household's only parental control. Both routes run it, because enforcing
// it on the stream route alone is cosmetic: the play URL is derivable from the
// account's own token, which the account holder necessarily has in their
// Stremio configuration, and orderByPinnedHash's fallback plays the top
// candidate even for a hash that matches nothing. Fails closed: a meta lookup
// that errors or returns nothing refuses, never permits.
async function ratingRefusesMeta(user: AppUser, parsed: ParsedStremioId, opts: StremioAddonRouteOptions): Promise<boolean> {
  if (!hasRatingLimit(user)) return false
  const meta = await opts.fetchMeta(parsed.mediaType, parsed.imdbId).catch(() => null)
  const allowed = meta ? await canUserAccessStremioMeta(user, meta, parsed.mediaType).catch(() => false) : false
  return !allowed
}

export async function stremioAddonRoutes(app: FastifyInstance, opts: StremioAddonRouteOptions) {
  // Derived from the plugin's own mount path rather than assumed: fastify exposes
  // the encapsulated prefix here, and it is '' when registered without one. A
  // trailing slash is stripped, because prefix: '/addon/' would make the anchor
  // '/addon//stremio/', which matches nothing, and the full token would be logged.
  const mountPath = (app.prefix ?? '').replace(/\/+$/, '')

  // Scoped to this plugin, so it covers the addon routes and nothing else.
  app.addHook('onResponse', async (req, reply) => {
    app.log.info(`stremio: ${req.method} ${redactStremioToken(req.url, mountPath)} -> ${reply.statusCode} in ${Math.round(reply.elapsedTime)}ms`)
  })

  // Anything under the prefix that matches no route below is answered here, not
  // by the root not-found handler, which logs with the root logger and wrote the
  // token out twice: once in the req serializer and once in "Route ... not
  // found". /configure and /meta/... are ordinary traffic from a client holding
  // a manifest cached from another configuration, and a trailing slash is one
  // typo away. Fastify prefers the specific routes over this wildcard, so it
  // shadows nothing. Same body as an invalid token.
  app.all(`${STREMIO_ROUTE_PREFIX}/*`, SILENCE_DEFAULT_REQUEST_LOG, async (_req, reply) => reply.code(404).send(NOT_FOUND))

  app.get(`${STREMIO_ROUTE_PREFIX}/:token/manifest.json`, SILENCE_DEFAULT_REQUEST_LOG, async (req, reply) => {
    const { token } = req.params as { token: string }
    if (!userForToken(token)) return reply.code(404).send(NOT_FOUND)
    return reply.headers(ADDON_HEADERS).send(buildManifest())
  })

  app.get(`${STREMIO_ROUTE_PREFIX}/:token/stream/:mediaType/:id`, SILENCE_DEFAULT_REQUEST_LOG, async (req, reply) => {
    const { token, mediaType, id } = req.params as { token: string; mediaType: string; id: string }
    const user = userForToken(token)
    if (!user) return reply.code(404).send(NOT_FOUND)

    const origin = buildPlaybackOrigin(req.headers as Record<string, string | undefined>)
    // Every failure below returns one non-playable entry rather than an empty
    // list, because an empty list renders as "nothing exists" and tells the
    // viewer nothing about why.
    const notice = (message: string) => reply.headers(ADDON_HEADERS).send({ streams: noticeStreams(message, origin) })

    const parsed = parseStremioStreamId(mediaType, id)
    if (!parsed) return notice('This title is not supported by Fetcherr.')

    if (await ratingRefusesMeta(user, parsed, opts)) return notice('Not available for this account.')

    // Checked here as well as on play so the cap is visible before someone
    // presses play. Only the play route records, so nothing counted here.
    if (countStremioPlaysToday(user.id) >= playCapFor(user)) {
      return notice('Daily play limit reached. Try again tomorrow.')
    }

    let streams: Stream[] = []
    try {
      streams = await opts.fetchStreams(parsed.mediaType, parsed.externalId)
    } catch (err) {
      app.log.warn(`stremio: stream lookup failed for ${parsed.externalId} (${user.username}): ${err}`)
      return notice('No streams available right now.')
    }

    const mapped = toStremioStreams(streams, { origin, token, mediaType: parsed.mediaType, externalId: parsed.externalId })
    app.log.info(`stremio: ${mapped.length} of ${streams.length} candidates for ${parsed.externalId} (${user.username})`)
    if (!mapped.length) return notice('No streams available right now.')
    return reply.headers(ADDON_HEADERS).send({ streams: mapped })
  })

  // Subtitles for a title, with or without the file details a client can send.
  // Every refusal is an empty list: unlike a stream list there is no notice entry
  // to explain one. No play is counted and the cap is not consulted, because a
  // lookup spends nothing. HEAD stays auto-exposed for the same reason.
  async function answerSubtitles(req: FastifyRequest, reply: FastifyReply, rawId: string, rawExtra: string | null) {
    const { token, mediaType } = req.params as { token: string; mediaType: string }
    const user = userForToken(token)
    if (!user) return reply.code(404).send(NOT_FOUND)
    const empty = () => reply.headers(ADDON_HEADERS).send({ subtitles: [] })

    const parsed = parseStremioStreamId(mediaType, rawId)
    if (!parsed || !opts.fetchSubtitles) return empty()
    const extra = rawExtra === null ? undefined : parseSubtitleExtra(rawExtra)
    if (extra === null) return empty()
    if (await ratingRefusesMeta(user, parsed, opts)) return empty()

    let tracks: SubtitleTrack[] = []
    try {
      tracks = await opts.fetchSubtitles(parsed.mediaType, parsed.externalId, extra)
    } catch (err) {
      app.log.warn(`stremio: subtitle lookup failed for ${parsed.externalId} (${user.username}): ${err}`)
      return empty()
    }
    // The client's file, when it names one, picks the best few per language.
    // Labelled before the preference moves a language forward, so each track
    // reads as it does to a Jellyfin client playing the same file.
    const ranked = rankForFile(tracks, extra?.filename ?? null, config.subtitleMaxPerLanguage)
    const labelled = ranked.map((track, i) => ({ ...track, label: displayLabel(ranked, i, subtitleLanguageName(track.lang)) }))
    const subtitles = orderPreferredFirst(labelled, user.subtitleLanguage)
      .map(track => ({ id: track.id, url: track.url, lang: track.lang, label: track.label }))
    return reply.headers(ADDON_HEADERS).send({ subtitles })
  }

  app.get(`${STREMIO_ROUTE_PREFIX}/:token/subtitles/:mediaType/:id`, SILENCE_DEFAULT_REQUEST_LOG, async (req, reply) => {
    const { id } = req.params as { id: string }
    return answerSubtitles(req, reply, id, null)
  })

  // A wildcard, not a :param: find-my-way caps a param at 100 characters, and a
  // real client's extra (hash, size and a release filename) runs past that. Over
  // the cap a request skips the catch-all above and reaches the root not-found
  // handler, which logs the whole token. The extra is one segment; anything with
  // more is not a request this route understands, so it gets the empty list.
  app.get(`${STREMIO_ROUTE_PREFIX}/:token/subtitles/:mediaType/:id/*`, SILENCE_DEFAULT_REQUEST_LOG, async (req, reply) => {
    const { id } = req.params as { id: string }
    const extra = rawSegmentsAfterSubtitleId(req.url, mountPath)
    return answerSubtitles(req, reply, `${id}.json`, extra.length === 1 ? extra[0] : '')
  })

  // exposeHeadRoute false because fastify would otherwise auto-register HEAD
  // against this handler, and a player or link preview that probes with HEAD
  // before GET would spend a cap slot and a debrid resolution for nothing,
  // quietly halving the account's quota. An unmatched HEAD falls to the
  // catch-all above.
  app.get(`${STREMIO_ROUTE_PREFIX}/:token/play/:mediaType/:externalId/:infoHash`, { ...SILENCE_DEFAULT_REQUEST_LOG, exposeHeadRoute: false }, async (req, reply) => {
    const { token, mediaType, externalId, infoHash } = req.params as Record<string, string>
    const user = userForToken(token)
    if (!user) return reply.code(404).send(NOT_FOUND)
    const wanted = infoHash.toLowerCase()
    if (!INFO_HASH.test(wanted)) return reply.code(404).send(NOT_FOUND)

    const parsed = parseStremioStreamId(mediaType, `${externalId}.json`)
    if (!parsed) return reply.code(404).send(NOT_FOUND)

    // A notice entry only means something inside a stream list, so a refusal
    // here is the route's standard not-found response.
    if (await ratingRefusesMeta(user, parsed, opts)) {
      app.log.warn(`stremio: rating gate refused play of ${parsed.externalId} for ${user.username}`)
      return reply.code(404).send(NOT_FOUND)
    }

    // Reserve the slot before resolving, atomically, so a burst cannot outrun the
    // count. A same-day request for the same file reuses its row rather than
    // taking a second slot: the redirect is no-store, so a client re-enters this
    // route on every range request and seek. Every account takes this path,
    // admins included, so playCapFor is the only place a cap comes from.
    const reservation = reserveStremioPlay({
      userId: user.id,
      mediaType: parsed.mediaType,
      externalId: parsed.externalId,
      infoHash: wanted,
      cap: playCapFor(user),
    })
    if (reservation === null) {
      app.log.warn(`stremio: play cap reached for ${user.username}`)
      return reply.code(429).send({ error: 'Daily play limit reached' })
    }
    // Only a row this request created may be released by this request's failure.
    let releasableId = reservation.created ? reservation.id : null

    const label = `stremio ${parsed.mediaType} ${parsed.externalId} (${user.username})`
    try {
      const streams = await opts.fetchStreams(parsed.mediaType, parsed.externalId)
      const ordered = orderByPinnedHash(streams, wanted)
      if (!ordered.length) {
        if (releasableId !== null) releaseStremioPlay(releasableId)
        return reply.code(404).send({ error: 'No streams found' })
      }
      // Falling through to the next candidate is deliberate: Stremio caches
      // stream lists for a long time and re-resolution legitimately drops
      // candidates. But it must not be silent, or someone gets a different
      // release with no trace of why, so name both hashes.
      const playing = extractHashFromStream(ordered[0])
      if (playing !== wanted) {
        app.log.warn(`stremio: pinned ${wanted} is gone, playing ${playing ?? 'unknown'} instead for ${label}`)
      }
      const resolved = await opts.resolvePlayback(ordered, label, `/stremio/play/${parsed.mediaType}/${parsed.externalId}`)
      // A resolver that returns nothing usable must not spend the slot or send
      // the client a redirect to an empty Location.
      if (!resolved?.url) {
        if (releasableId !== null) releaseStremioPlay(releasableId)
        app.log.warn(`stremio: resolver returned no url for ${label}`)
        return reply.code(404).send({ error: 'No stream available' })
      }
      // A shared row can vanish underneath us: if the request that created it
      // failed and released it, this one is holding a dead id, and finalizing
      // nothing would serve a play that counts for nobody. Re-reserve through the
      // same capped statement, never around it, so the cap still decides.
      if (!finalizeStremioPlay(reservation.id, resolved.filename ?? '')) {
        const again = reserveStremioPlay({
          userId: user.id,
          mediaType: parsed.mediaType,
          externalId: parsed.externalId,
          infoHash: wanted,
          cap: playCapFor(user),
        })
        if (again === null) {
          app.log.warn(`stremio: play cap reached for ${user.username} while re-counting ${label}`)
          return reply.code(429).send({ error: 'Daily play limit reached' })
        }
        releasableId = again.created ? again.id : null
        finalizeStremioPlay(again.id, resolved.filename ?? '')
      }
      app.log.info(`stremio: play ${label} hash=${wanted} file=${resolved.filename ?? '?'}`)
      // The whole design rests on play re-resolving at click time, so nothing
      // may cache this redirect and pin a CDN URL that expires.
      return reply.header('Cache-Control', 'no-store').redirect(resolved.url, 302)
    } catch (err) {
      // The slot was never spent, so it must not count against today. A reused row
      // belongs to an earlier successful request and stays.
      if (releasableId !== null) releaseStremioPlay(releasableId)
      app.log.warn(`stremio: no playable stream for ${label}: ${err}`)
      return reply.code(404).send({ error: 'No stream available' })
    }
  })
}
