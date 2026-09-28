import { config } from './config.js'
import { fetchCinemetaMeta } from './sootio.js'
import { subtitleLanguageTwoLetter } from './subtitle-lang.js'
import { releaseTags } from './subtitle-rank.js'
import { trimCacheMap } from './cache-utils.js'

// A direct client for Gestdown (api.gestdown.info), the public Addic7ed mirror.
// TV only: Gestdown knows shows by TVDB id, not IMDb id, so every lookup first
// asks Cinemeta for the show's TVDB id. Never rejects, so a failure here reads
// as "fewer subtitles" the same way a Stremio provider's failure does.

// tt{digits}, optionally with :season:episode, the shape subtitles.ts already
// validates before calling here. Gestdown answers episodes only.
const EPISODE_ID = /^(tt\d{7,10}):(\d{1,4}):(\d{1,4})$/

type ShowState = { status: 'found'; guid: string } | { status: 'absent' }

// Keyed by IMDb id: the show is the same for every episode, so one lookup
// serves them all. Failures are never stored here, only found or absent shows,
// so a Gestdown outage is retried on the next episode rather than remembered
// for a day.
const showCache = new Map<string, { promise: Promise<ShowState | 'failed'>; expiresAt: number }>()
const SHOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SHOW_CACHE_MAX_ITEMS = 1000

export function clearGestdownCache(): void {
  showCache.clear()
}

export async function fetchGestdownSubtitles(
  externalId: string,
  languages: readonly string[],
  onFailure: (reason: unknown) => void,
): Promise<Array<Record<string, unknown>>> {
  try {
    const match = EPISODE_ID.exec(externalId)
    if (!match) return []
    const [, imdbId, seasonText, episodeText] = match
    const season = Number(seasonText)
    const episodeNumber = Number(episodeText)

    const state = await resolveShow(imdbId, onFailure)
    if (state === 'failed' || state.status === 'absent') return []

    // ISO 639-2/B, as config.subtitleLanguages carries them. Unfiltered means
    // ask English only: no filter is not "ask every language Gestdown has".
    const codes = (languages.length ? languages : ['eng'])
      .map(lang => ({ lang, code: subtitleLanguageTwoLetter(lang) }))
      .filter((entry): entry is { lang: string; code: string } => entry.code !== null)

    const results = await Promise.all(
      codes.map(({ lang, code }) => fetchLanguage(state.guid, season, episodeNumber, lang, code, onFailure)),
    )
    return results.flat()
  } catch (err) {
    onFailure(err)
    return []
  }
}

async function resolveShow(imdbId: string, onFailure: (reason: unknown) => void): Promise<ShowState | 'failed'> {
  const now = Date.now()
  const existing = showCache.get(imdbId)
  if (existing) {
    if (existing.expiresAt > now) return existing.promise
    showCache.delete(imdbId)
  }

  // Set before the first await, so a second episode of the same show asked in
  // the same tick shares this lookup rather than starting its own.
  const promise = lookupShow(imdbId, onFailure)
  showCache.set(imdbId, { promise, expiresAt: now + SHOW_CACHE_TTL_MS })
  trimCacheMap(showCache, SHOW_CACHE_MAX_ITEMS)

  const state = await promise
  // A failure is not a fact about the show, only about this attempt, so it
  // must not linger where a real answer would.
  if (state === 'failed') showCache.delete(imdbId)
  return state
}

async function lookupShow(imdbId: string, onFailure: (reason: unknown) => void): Promise<ShowState | 'failed'> {
  const meta = await fetchCinemetaMeta('series', imdbId)
  // fetchCinemetaMeta turns a network error, a 5xx or its own timeout into null
  // the same way it turns a real 404 into null, so null here is read as a
  // failure of this attempt, not a fact about the show: it is logged and not
  // cached, unlike a meta that names no usable tvdb_id.
  if (meta === null) {
    onFailure(new Error('no Cinemeta meta'))
    return 'failed'
  }
  const tvdbId = tvdbIdOf(meta.tvdb_id)
  if (!tvdbId) return { status: 'absent' }
  return fetchShowState(tvdbId, onFailure)
}

function tvdbIdOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return String(Number(value))
  return null
}

async function fetchShowState(tvdbId: string, onFailure: (reason: unknown) => void): Promise<ShowState | 'failed'> {
  try {
    const res = await fetch(`${config.gestdownBaseUrl}/shows/external/tvdb/${tvdbId}`, {
      signal: AbortSignal.timeout(config.subtitleTimeoutMs),
    })
    if (res.status === 404) return { status: 'absent' }
    if (!res.ok) {
      onFailure(new Error(`HTTP ${res.status}`))
      return 'failed'
    }
    const body = await res.json() as { shows?: unknown }
    const shows = Array.isArray(body.shows) ? body.shows : []
    const show = shows.find((entry): entry is { id: string } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string' && (entry as { id: string }).id.trim() !== '')
    return show ? { status: 'found', guid: show.id } : { status: 'absent' }
  } catch (err) {
    onFailure(err)
    return 'failed'
  }
}

async function fetchLanguage(
  guid: string,
  season: number,
  episodeNumber: number,
  lang: string,
  code: string,
  onFailure: (reason: unknown) => void,
): Promise<Array<Record<string, unknown>>> {
  try {
    const url = `${config.gestdownBaseUrl}/subtitles/get/${guid}/${season}/${episodeNumber}/${code}`
    const res = await fetch(url, { signal: AbortSignal.timeout(config.subtitleTimeoutMs) })
    if (res.status === 404) return []
    if (!res.ok) {
      onFailure(new Error(`HTTP ${res.status}`))
      return []
    }
    const body = await res.json() as { matchingSubtitles?: unknown[]; episode?: { season?: unknown; number?: unknown } }
    const episode = body.episode
    // Gestdown falls back to a season pack's episode when it has none of its
    // own; that answer is about a different episode and none of it is kept.
    if (!episode || Number(episode.season) !== season || Number(episode.number) !== episodeNumber) return []

    const entries = Array.isArray(body.matchingSubtitles) ? body.matchingSubtitles : []
    const kept: Array<Record<string, unknown>> = []
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      if (entry.completed !== true) continue
      const subtitleId = entry.subtitleId
      if (typeof subtitleId !== 'string' || !subtitleId) continue
      const downloadUri = entry.downloadUri
      if (typeof downloadUri !== 'string' || !downloadUri.startsWith('/')) continue
      kept.push({
        id: subtitleId,
        url: `${config.gestdownBaseUrl}${downloadUri}`,
        lang,
        releaseName: releaseNameOf(entry.version),
      })
    }
    return kept
  } catch (err) {
    onFailure(err)
    return []
  }
}

// Addic7ed names most versions by release group alone, as in LiBERTY, with none
// of the dots, source or resolution a fuller release name carries. releaseTags'
// group pattern only reads a trailing -GROUP, so a bare group name is given a
// leading hyphen here, which makes it read exactly as a fuller name naming the
// same group would. A version that already looks like a release name, such as
// 1080p.BluRay.x264-AiRTV, is left as it is. A version that is itself a source
// or resolution word, such as WEB or BluRay, is left alone too: releaseTags
// already reads it as a source with no group, and hyphenating it would give it
// a group of the same name, doubling its label.
const BARE_GROUP = /^(?=.*[A-Za-z])[A-Za-z0-9]{2,12}$/

function releaseNameOf(version: unknown): string {
  const text = typeof version === 'string' ? version.trim() : ''
  if (!BARE_GROUP.test(text)) return text
  const { source, resolution } = releaseTags(text)
  return source || resolution ? text : `-${text}`
}
