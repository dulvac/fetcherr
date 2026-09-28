import { config } from './config.js'
import { fetchManifest, providerBases, providerLabel, type StremioManifest, type StremioMediaType } from './sootio.js'
import { normalizeSubtitleLanguage, subtitleLanguageName } from './subtitle-lang.js'

// A provider-agnostic client for the Stremio subtitles resource. Every configured
// provider is asked at once and the answers are merged, so no single provider can
// delay or empty the result. Subtitles are additive: nothing here rejects, and
// every failure reads as "no subtitles".

export interface SubtitleTrack {
  // Unique across providers: the provider's position, then its own id.
  id: string
  // Absolute http(s) URL that the client fetches itself. Bytes never pass through here.
  url: string
  // ISO 639-2/B, see subtitle-lang.ts.
  lang: string
  label: string
  // srt, vtt, ass, ssa or sub. Passed through, never converted.
  format: string
  // The release the file was made for, as the provider names it, or '' when it
  // does not. What the label shows and what ranking compares to the playing file.
  release: string
}

// File details a Stremio client sends so a provider can match by hash.
export interface SubtitleExtra {
  videoHash?: string
  videoSize?: string
  filename?: string
}

type RawSubtitle = Record<string, unknown>

const POSITIVE_TTL_MS = 10 * 60 * 1000
// Short, so a provider that recovers shows up on the next visit.
const EMPTY_TTL_MS = 2 * 60 * 1000
const FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000
// Movie or episode ids in the stream id shape: tt0111161, tt13210838:1:2. They go
// into a URL path, so nothing else gets through.
const EXTERNAL_ID = /^tt\d{7,10}(?::\d{1,4}:\d{1,4})?$/
const FORMATS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub'])
// Kept per language before any version is looked at: enough for each version to
// find the file made for it, while subtitleMaxPerLanguage is how many each
// version then shows.
export const SUBTITLE_POOL_PER_LANGUAGE = 10

type CacheEntry = { promise: Promise<SubtitleTrack[]>; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const lastFailureLogAt = new Map<string, number>()

// Called on every settings save: cached answers were filtered under the old
// languages, and a newly named provider should count on the next play.
export function clearSubtitleCache(): void {
  cache.clear()
}

export async function fetchSubtitles(
  mediaType: StremioMediaType,
  externalId: string,
  extra?: SubtitleExtra,
): Promise<SubtitleTrack[]> {
  if ((mediaType !== 'movie' && mediaType !== 'series') || !EXTERNAL_ID.test(externalId)) return []
  // A hash-matched answer is specific to one file, so it is neither served from
  // nor stored in the title-level cache that Jellyfin lookups share.
  if (extra && (extra.videoHash || extra.videoSize || extra.filename)) {
    return fetchUncached(mediaType, externalId, extra)
  }

  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  const key = `${mediaType}:${externalId}`
  const existing = cache.get(key)
  // Shared while in flight too: Infuse asks for PlaybackInfo on every detail
  // screen, and for several at once when a season is opened.
  if (existing) return existing.promise

  const promise = fetchUncached(mediaType, externalId)
  const entry: CacheEntry = { promise, expiresAt: now + POSITIVE_TTL_MS }
  cache.set(key, entry)
  const tracks = await promise
  entry.expiresAt = Date.now() + (tracks.length ? POSITIVE_TTL_MS : EMPTY_TTL_MS)
  return tracks
}

async function fetchUncached(mediaType: StremioMediaType, externalId: string, extra?: SubtitleExtra): Promise<SubtitleTrack[]> {
  try {
    const { bases, checkManifest } = subtitleProviders()
    if (!bases.length) return []
    const path = requestPath(mediaType, externalId, extra)
    const timeoutMs = config.subtitleTimeoutMs
    const settled = await Promise.allSettled(bases.map(base =>
      withDeadline(fetchFromProvider(base, path, checkManifest, timeoutMs), timeoutMs)))
    const answers = settled.map((result, idx) => {
      if (result.status === 'fulfilled') return result.value
      logFailure(bases[idx], providerLabel(bases[idx], idx), path, result.reason)
      return []
    })
    return selectTracks(answers, config.subtitleLanguages)
  } catch (err) {
    console.warn(`subtitles: lookup failed for ${mediaType} ${externalId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// Named subtitle providers are used as given: naming one is the admin saying it
// serves subtitles. Otherwise the stream providers are asked, but only those whose
// manifest declares a subtitles resource, so a stream-only addon is never sent
// requests it can only refuse.
function subtitleProviders(): { bases: string[]; checkManifest: boolean } {
  if (config.subtitleProviderUrls.length) return { bases: [...config.subtitleProviderUrls], checkManifest: false }
  return { bases: providerBases(), checkManifest: true }
}

function declaresSubtitles(manifest: StremioManifest | null): boolean {
  return (manifest?.resources ?? []).some(resource =>
    typeof resource === 'string' ? resource === 'subtitles' : resource?.name === 'subtitles')
}

// The addon SDK router's shape, /:resource/:type/:id/:extra?.json, where extra is
// a querystring. Each value is encoded, so a filename with & or spaces arrives intact.
function requestPath(mediaType: StremioMediaType, externalId: string, extra?: SubtitleExtra): string {
  const parts: string[] = []
  if (extra?.videoHash) parts.push(`videoHash=${encodeURIComponent(extra.videoHash)}`)
  if (extra?.videoSize) parts.push(`videoSize=${encodeURIComponent(extra.videoSize)}`)
  if (extra?.filename) parts.push(`filename=${encodeURIComponent(extra.filename)}`)
  const base = `/subtitles/${mediaType}/${externalId}`
  return parts.length ? `${base}/${parts.join('&')}.json` : `${base}.json`
}

async function fetchFromProvider(base: string, path: string, checkManifest: boolean, timeoutMs: number): Promise<RawSubtitle[]> {
  if (checkManifest && !declaresSubtitles(await fetchManifest(base))) return []
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json() as { subtitles?: unknown }
  if (!Array.isArray(body.subtitles)) return []
  return body.subtitles.filter((entry): entry is RawSubtitle => typeof entry === 'object' && entry !== null)
}

// The fetch carries its own abort signal. This also bounds the manifest lookup,
// which sootio allows thirty seconds, so a provider whose manifest hangs costs the
// same timeout as one whose subtitles hang.
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Keyed by base, printed by label: a base can carry an addon's configuration,
// which is a credential, and providerLabel redacts it.
function logFailure(base: string, label: string, path: string, reason: unknown): void {
  const now = Date.now()
  const last = lastFailureLogAt.get(base)
  if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLogAt.set(base, now)
  const message = reason instanceof Error ? reason.message : String(reason)
  console.warn(`subtitles: ${label} failed for ${path}: ${message}`)
}

// A client fetches this URL itself, so a loopback address would send every device
// to its own localhost, where the Stremio desktop server lives on 127.0.0.1:11470.
function usableUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host)) return null
  return parsed.href
}

function formatOf(url: string, fileName: unknown): string {
  for (const candidate of [typeof fileName === 'string' ? fileName : '', new URL(url).pathname]) {
    const extension = candidate.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
    if (extension && FORMATS.has(extension)) return extension
  }
  return 'srt'
}

// OpenSubtitles names the release in movieReleaseName. Its file name usually
// repeats it, so that stands in when the release name is missing.
function releaseOf(entry: RawSubtitle): string {
  const named = typeof entry.movieReleaseName === 'string' ? entry.movieReleaseName.trim() : ''
  if (named) return named
  const fileName = typeof entry.subtitleFileName === 'string' ? entry.subtitleFileName.trim() : ''
  return fileName.replace(/\.(?:srt|vtt|ass|ssa|sub|smi|txt)$/i, '')
}

// Filter to the configured languages, collapse the same URL offered twice, keep
// provider order and then each provider's own order within a language, and keep
// the pool. Languages come out in the configured order, or in order of first
// appearance when there is no filter.
function selectTracks(answers: RawSubtitle[][], languages: readonly string[]): SubtitleTrack[] {
  const byLanguage = new Map<string, SubtitleTrack[]>()
  const seenUrls = new Set<string>()
  for (const [providerIdx, entries] of answers.entries()) {
    for (const [entryIdx, entry] of entries.entries()) {
      const url = usableUrl(entry.url)
      const lang = normalizeSubtitleLanguage(entry.lang)
      if (!url || !lang) continue
      if (languages.length && !languages.includes(lang)) continue
      const format = formatOf(url, entry.subtitleFileName)
      // MicroDVD counts frames and VobSub is images that need an .idx beside
      // them; neither plays reliably as an external text track, and skipping
      // them here lets the pool fill with files that do.
      if (format === 'sub') continue
      if (seenUrls.has(url)) continue
      seenUrls.add(url)
      let list = byLanguage.get(lang)
      if (!list) {
        list = []
        byLanguage.set(lang, list)
      }
      if (list.length >= SUBTITLE_POOL_PER_LANGUAGE) continue
      const ownId = typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id) : String(entryIdx)
      list.push({ id: `${providerIdx + 1}-${ownId}`, url, lang, label: '', format, release: releaseOf(entry) })
    }
  }

  const tracks: SubtitleTrack[] = []
  for (const lang of languages.length ? languages : [...byLanguage.keys()]) {
    const list = byLanguage.get(lang) ?? []
    const name = subtitleLanguageName(lang)
    list.forEach((track, i) => tracks.push({ ...track, label: list.length > 1 ? `${name} ${i + 1}` : name }))
  }
  return tracks
}

export interface SubtitleFile {
  body: Buffer
  // The provider's Content-Type header, or null when it sent none.
  contentType: string | null
}

const FILE_TTL_MS = 10 * 60 * 1000
const FILE_CACHE_MAX = 200
const FILE_MAX_BYTES = 5 * 1024 * 1024
const fileCache = new Map<string, { file: SubtitleFile; expiresAt: number }>()

// Jellyfin players fetch subtitles from their own server and follow neither an
// absolute DeliveryUrl nor a redirect, so the file comes through here. Kept
// briefly, because a player fetches every track at play start and again on each
// replay. Never rejects: a file that cannot be had is null, and the player
// simply lacks that track.
export async function fetchSubtitleFile(url: string): Promise<SubtitleFile | null> {
  const now = Date.now()
  const cached = fileCache.get(url)
  if (cached && cached.expiresAt > now) return cached.file
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(config.subtitleTimeoutMs) })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > FILE_MAX_BYTES) return null
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > FILE_MAX_BYTES) return null
    const file: SubtitleFile = { body, contentType: res.headers.get('content-type') }
    for (const [key, entry] of fileCache) {
      if (entry.expiresAt <= now) fileCache.delete(key)
    }
    if (fileCache.size >= FILE_CACHE_MAX) {
      const oldest = fileCache.keys().next().value
      if (oldest !== undefined) fileCache.delete(oldest)
    }
    fileCache.set(url, { file, expiresAt: now + FILE_TTL_MS })
    return file
  } catch {
    return null
  }
}
