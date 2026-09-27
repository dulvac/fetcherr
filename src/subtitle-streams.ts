import type { StremioMediaType } from './sootio.js'
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

// One external subtitle stream per track, after whatever streams the source
// already lists. The first track in the preferred language becomes the default
// only when there is one; otherwise nothing is forced and the field is left out.
export function attachSubtitleStreams(
  sources: Array<Record<string, unknown>>,
  tracks: SubtitleTrack[],
  preferredLanguage: string,
  itemId: string,
): Array<Record<string, unknown>> {
  if (!tracks.length) return sources
  const defaultAt = preferredLanguage ? tracks.findIndex(track => track.lang === preferredLanguage) : -1
  return sources.map(source => {
    const existing = Array.isArray(source.MediaStreams) ? source.MediaStreams as unknown[] : []
    const first = existing.length
    const sourceId = String(source.Id ?? '')
    const subtitleStreams = tracks.map((track, i) => ({
      Type: 'Subtitle',
      Index: first + i,
      Codec: track.format,
      Language: track.lang,
      DisplayTitle: track.label,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
      // Server-relative, as real Jellyfin sends it: the players on this network
      // fetch subtitles from their own server and nowhere else.
      DeliveryUrl: `/Videos/${itemId}/${sourceId}/Subtitles/${first + i}/0/Stream.${track.format}`,
      IsExternalUrl: false,
      IsDefault: i === defaultAt,
    }))
    const next: Record<string, unknown> = { ...source, MediaStreams: [...existing, ...subtitleStreams] }
    if (defaultAt >= 0) next.DefaultSubtitleStreamIndex = first + defaultAt
    return next
  })
}

// Both media source builders list video at 0 and audio at 1, so the subtitle
// streams attachSubtitleStreams appends start at 2. A client fetching
// /Videos/.../Subtitles/{index} is asking for that position in the same list.
export const FIRST_SUBTITLE_STREAM_INDEX = 2

export function subtitleTrackAtIndex(tracks: SubtitleTrack[], streamIndex: number): SubtitleTrack | null {
  return tracks[streamIndex - FIRST_SUBTITLE_STREAM_INDEX] ?? null
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
