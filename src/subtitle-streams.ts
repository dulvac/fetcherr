import type { StremioMediaType } from './sootio.js'
import { subtitleLanguageName } from './subtitle-lang.js'
import { rankForFile, releaseLabel } from './subtitle-rank.js'
import type { SubtitleTrack } from './subtitles.js'

export interface SubtitleLookupKey {
  mediaType: StremioMediaType
  externalId: string
}

const IMDB_ID = /^tt\d{7,10}$/
const NUMBER = /^\d{1,4}$/

// The ids a media source's subtitles are looked up by, read from the play path
// the source was built around. A path this cannot read yields no subtitles,
// which is always a safe answer.
export function parsePlayPath(playPath: string): SubtitleLookupKey | null {
  const path = playPath.split('?')[0]

  const stremio = path.match(/^\/play\/stremio\/(movie|series)\/([^/]+)$/)
  if (stremio) {
    let externalId: string
    try {
      externalId = decodeURIComponent(stremio[2])
    } catch {
      return null
    }
    const mediaType = stremio[1] as StremioMediaType
    const [imdbId, season, episode, ...rest] = externalId.split(':')
    if (!IMDB_ID.test(imdbId) || rest.length) return null
    if (mediaType === 'movie') return season === undefined ? { mediaType, externalId: imdbId } : null
    if (season === undefined || episode === undefined || !NUMBER.test(season) || !NUMBER.test(episode)) return null
    return { mediaType, externalId: `${imdbId}:${Number(season)}:${Number(episode)}` }
  }

  const episode = path.match(/^\/play\/(tt\d{7,10})\/(\d{1,4})\/(\d{1,4})$/)
  if (episode) return { mediaType: 'series', externalId: `${episode[1]}:${Number(episode[2])}:${Number(episode[3])}` }

  const movie = path.match(/^\/play\/(tt\d{7,10})$/)
  if (movie) return { mediaType: 'movie', externalId: movie[1] }

  return null
}

// "English 2 · 720p WEB-DL myTV": numbered within its language in the order
// given, as the generic labels are, then the release the file was made for, so
// a viewer can pick the file cut for the version playing. Stremio shows the same.
export function displayLabel(tracks: ReadonlyArray<Pick<SubtitleTrack, 'lang' | 'release'>>, i: number, languageName: string): string {
  const track = tracks[i]
  const sameLanguage = tracks.filter(other => other.lang === track.lang).length
  const position = tracks.slice(0, i).filter(other => other.lang === track.lang).length + 1
  const base = sameLanguage > 1 ? `${languageName} ${position}` : languageName
  const release = releaseLabel(track.release)
  return release ? `${base} · ${release}` : base
}

// Every character a file name cannot hold safely: the path separators of either
// OS, and any control character a provider's release text might carry.
const UNSAFE_PATH_CHARS = /[/\\\x00-\x1f\x7f]/g

// VidHub names a subtitle track by the file name at the end of its Path rather
// than by DisplayTitle, so the same label goes there, cleaned of what a file
// name cannot hold. A label that sanitizes away to nothing - seen only with odd
// provider data, never with a real release - falls back to the language name.
function subtitlePathName(label: string, languageName: string): string {
  const cleaned = label.replace(UNSAFE_PATH_CHARS, '-').trim()
  return cleaned || languageName
}

export interface SubtitleStreamOptions {
  // How many tracks each version shows per language.
  perLanguage: number
  // The file a version plays, when it is known, so the tracks made for that
  // release can be listed first.
  fileNameFor?: (source: Record<string, unknown>) => string | null
}

// One external subtitle stream per track, after whatever streams the source
// already lists, best match for the source's file first within each language.
// The first track in the preferred language becomes the default only when there
// is one; otherwise nothing is forced and the field is left out.
export function attachSubtitleStreams(
  sources: Array<Record<string, unknown>>,
  tracks: SubtitleTrack[],
  preferredLanguage: string,
  itemId: string,
  options: SubtitleStreamOptions,
): Array<Record<string, unknown>> {
  if (!tracks.length) return sources
  return sources.map(source => {
    const ordered = rankForFile(tracks, options.fileNameFor?.(source) ?? null, options.perLanguage)
    const defaultAt = preferredLanguage ? ordered.findIndex(track => track.lang === preferredLanguage) : -1
    const existing = Array.isArray(source.MediaStreams) ? source.MediaStreams as unknown[] : []
    const first = existing.length
    const sourceId = String(source.Id ?? '')
    rememberSubtitleOrder(sourceId, ordered.map(track => track.id))
    const subtitleStreams = ordered.map((track, i) => {
      const languageName = subtitleLanguageName(track.lang)
      const label = displayLabel(ordered, i, languageName)
      const pathName = subtitlePathName(label, languageName)
      return {
        Type: 'Subtitle',
        Index: first + i,
        Codec: track.format,
        Language: track.lang,
        DisplayTitle: label,
        IsExternal: true,
        IsTextSubtitleStream: true,
        SupportsExternalStream: true,
        DeliveryMethod: 'External',
        // Server-relative, as real Jellyfin sends it: the players on this network
        // fetch subtitles from their own server and nowhere else.
        DeliveryUrl: `/Videos/${itemId}/${sourceId}/Subtitles/${first + i}/0/Stream.${track.format}`,
        IsExternalUrl: false,
        IsDefault: i === defaultAt,
        // The rest of what real Jellyfin sends for an external .srt. Infuse needs
        // none of it; it is here for players that only trust a stream shaped
        // exactly like a library file's.
        Title: label,
        IsForced: false,
        IsHearingImpaired: false,
        TimeBase: '1/1000',
        Level: 0,
        Path: `/fetcherr/subtitles/${itemId}/${first + i}/${pathName}.${track.lang}.${track.format}`,
        LocalizedUndefined: 'Undefined',
        LocalizedDefault: 'Default',
        LocalizedForced: 'Forced',
        LocalizedExternal: 'External',
        LocalizedHearingImpaired: 'Hearing Impaired',
      }
    })
    const next: Record<string, unknown> = { ...source, MediaStreams: [...existing, ...subtitleStreams] }
    if (defaultAt >= 0) next.DefaultSubtitleStreamIndex = first + defaultAt
    return next
  })
}

// Both media source builders list video at 0 and audio at 1, so the subtitle
// streams attachSubtitleStreams appends start at 2. A client fetching
// /Videos/.../Subtitles/{index} is asking for that position in the same list.
export const FIRST_SUBTITLE_STREAM_INDEX = 2

// The order each version listed its tracks in, by media source id. A player
// fetches a subtitle by its index in that list, possibly hours into a film and
// long after the version's file name is forgotten, so the list itself is kept.
const ORDER_TTL_MS = 6 * 60 * 60 * 1000
const ORDER_MAX = 5000
const subtitleOrders = new Map<string, { trackIds: string[]; expiresAt: number }>()

export function rememberSubtitleOrder(sourceId: string, trackIds: string[]): void {
  if (!sourceId) return
  const now = Date.now()
  // Re-set rather than updated, so the map stays in the order entries were last
  // written, which is also the order they expire in.
  subtitleOrders.delete(sourceId)
  for (const [key, entry] of subtitleOrders) {
    if (entry.expiresAt > now) break
    subtitleOrders.delete(key)
  }
  while (subtitleOrders.size >= ORDER_MAX) {
    const oldest = subtitleOrders.keys().next().value
    if (oldest === undefined) break
    subtitleOrders.delete(oldest)
  }
  subtitleOrders.set(sourceId, { trackIds: [...trackIds], expiresAt: now + ORDER_TTL_MS })
}

export function rememberedSubtitleOrder(sourceId: string): string[] | null {
  const entry = subtitleOrders.get(sourceId)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    subtitleOrders.delete(sourceId)
    return null
  }
  return [...entry.trackIds]
}

// The track a version listed at streamIndex. With nothing remembered, as after a
// restart, the order is worked out again from the version's file, or is the
// provider's when the file is unknown. A remembered track the provider no longer
// offers is null rather than whichever track now sits there.
export function subtitleTrackForSource(
  tracks: SubtitleTrack[],
  sourceId: string,
  streamIndex: number,
  fallback: { perLanguage: number; fileName: string | null },
): SubtitleTrack | null {
  const remembered = rememberedSubtitleOrder(sourceId)
  const byId = new Map(tracks.map(track => [track.id, track]))
  const ordered = remembered
    ? remembered.map(id => byId.get(id) ?? null)
    : rankForFile(tracks, fallback.fileName, fallback.perLanguage)
  const position = streamIndex - FIRST_SUBTITLE_STREAM_INDEX
  return position >= 0 ? ordered[position] ?? null : null
}

const SUBTITLE_CONTENT_TYPES: Record<string, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
}

// The type Jellyfin serves each format with. The charset is the provider's, when
// it declared one, because only the provider knows how the file is encoded.
export function subtitleContentType(format: string, providerContentType: string | null): string {
  const type = SUBTITLE_CONTENT_TYPES[format] ?? 'text/plain'
  const charset = /charset=([^;\s]+)/i.exec(providerContentType ?? '')?.[1]
  return charset ? `${type}; charset=${charset}` : type
}
