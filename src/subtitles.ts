import { config, SUBTITLE_POOL_PER_LANGUAGE } from './config.js'
import { fetchGestdownSubtitles } from './gestdown.js'
import { fetchManifest, providerBases, providerLabel, type StremioManifest, type StremioMediaType } from './sootio.js'
import { normalizeSubtitleLanguage, subtitleLanguageName } from './subtitle-lang.js'
import { stripAdCues } from './subtitle-clean.js'

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
// Short, so a provider that recovers shows up on the next visit. It also
// bounds a partial answer, where one provider timed out, errored, or Gestdown
// failed on a language: the tracks that did come back are kept, but not
// trusted for the full ten minutes, so the failed provider is asked again soon.
const EMPTY_TTL_MS = 2 * 60 * 1000
const FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000
// Movie or episode ids in the stream id shape: tt0111161, tt13210838:1:2. They go
// into a URL path, so nothing else gets through.
const EXTERNAL_ID = /^tt\d{7,10}(?::\d{1,4}:\d{1,4})?$/
const FORMATS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub'])

// fetchUncached also reports whether some provider's turn failed, so the
// cache below can hold a partial answer only briefly.
type UncachedAnswer = { tracks: SubtitleTrack[]; partial: boolean }
type CacheEntry = { promise: Promise<UncachedAnswer>; expiresAt: number }
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
    return (await fetchUncached(mediaType, externalId, extra)).tracks
  }

  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  const key = `${mediaType}:${externalId}`
  const existing = cache.get(key)
  // Shared while in flight too: Infuse asks for PlaybackInfo on every detail
  // screen, and for several at once when a season is opened.
  if (existing) return (await existing.promise).tracks

  const promise = fetchUncached(mediaType, externalId)
  const entry: CacheEntry = { promise, expiresAt: now + POSITIVE_TTL_MS }
  cache.set(key, entry)
  const { tracks, partial } = await promise
  entry.expiresAt = Date.now() + (tracks.length && !partial ? POSITIVE_TTL_MS : EMPTY_TTL_MS)
  return tracks
}

async function fetchUncached(mediaType: StremioMediaType, externalId: string, extra?: SubtitleExtra): Promise<UncachedAnswer> {
  try {
    const { bases, checkManifest } = subtitleProviders()
    // Read once, not once before the await and again after: a Settings save
    // can flip this while a lookup is in flight, and a second read after the
    // await would misalign idx === bases.length against the array built below.
    const gestdown = config.subtitleGestdown
    if (!bases.length && !gestdown) return { tracks: [], partial: false }
    const path = requestPath(mediaType, externalId, extra)
    const timeoutMs = config.subtitleTimeoutMs
    // fetchGestdownSubtitles never rejects: a failed show or language lookup
    // still resolves with whatever it did get, so the partial flag it sets
    // here is the only sign of that failure, unlike a provider's, which shows
    // up as a rejected settled result below.
    let gestdownFailed = false
    // Gestdown is one more answer, after every configured or discovered
    // provider: it goes through the same deadline and lands at bases.length + 1,
    // whether or not any provider is named. It ignores extra (a hash lookup):
    // it has no file hash of its own to match against.
    const settled = await Promise.allSettled([
      ...bases.map(base => withDeadline(fetchFromProvider(base, path, checkManifest, timeoutMs), timeoutMs)),
      ...(gestdown
        ? [withDeadline(fetchGestdownSubtitles(externalId, config.subtitleLanguages, reason => {
            gestdownFailed = true
            logFailure('gestdown', 'Gestdown', path, reason)
          }), timeoutMs)]
        : []),
    ])
    let partial = gestdownFailed
    const answers = settled.map((result, idx) => {
      if (result.status === 'fulfilled') return result.value
      partial = true
      const isGestdown = gestdown && idx === bases.length
      if (isGestdown) logFailure('gestdown', 'Gestdown', path, result.reason)
      else logFailure(bases[idx], providerLabel(bases[idx], idx), path, result.reason)
      return []
    })
    return { tracks: selectTracks(answers, config.subtitleLanguages), partial }
  } catch (err) {
    console.warn(`subtitles: lookup failed for ${mediaType} ${externalId}: ${err instanceof Error ? err.message : String(err)}`)
    return { tracks: [], partial: true }
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

// Checks, in order: an explicit file name's trailing extension, then the URL
// path's trailing extension, then any other .vtt path segment, since the two
// checks above already catch one at the path's end. OpenSubtitles v3+ serves
// subtitles at paths like /sub.vtt/?lang_code=en&sub_id=5467612.
function formatOf(url: string, fileName: unknown): string {
  const pathname = new URL(url).pathname
  for (const candidate of [typeof fileName === 'string' ? fileName : '', pathname]) {
    const extension = candidate.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
    if (extension && FORMATS.has(extension)) return extension
  }
  if (pathname.toLowerCase().split('/').some(segment => segment.endsWith('.vtt'))) return 'vtt'
  return 'srt'
}

// The release name, read from the first field that has one: movieReleaseName
// (OpenSubtitles v3), releaseName (SubSense) or title (OpenSubtitles v3+, which
// has neither of the other two). When none does, it is guessed from a file name
// that usually repeats it: subtitleFileName (OpenSubtitles v3) or fileName
// (SubSense), with its extension removed.
function releaseOf(entry: RawSubtitle): string {
  const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
  const named = text(entry.movieReleaseName) || text(entry.releaseName) || text(entry.title)
  if (named) return named
  const fileName = text(entry.subtitleFileName) || text(entry.fileName)
  return fileName.replace(/\.(?:srt|vtt|ass|ssa|sub|smi|txt)$/i, '')
}

// An entry that is the same underlying OpenSubtitles file as another, so that
// one is dropped as soon as either identifies it: an OpenSubtitles v3+ file's
// sub_id, or, for a strem.io URL, an OpenSubtitles v3 file's id (v3 files are
// served from subs5.strem.io). Anything else has no file id of its own, so a
// coincidence of ids on other providers is never mistaken for the same file.
function openSubtitlesFileId(entry: RawSubtitle, url: string): string | null {
  const digits = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value)
    if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return String(Number(value))
    return null
  }
  const subId = digits(entry.sub_id)
  if (subId) return subId
  const host = new URL(url).hostname.toLowerCase()
  if (host === 'strem.io' || host.endsWith('.strem.io')) return digits(entry.id)
  return null
}

// Filter to the configured languages, then fill each language's pool in rounds:
// round one takes every provider's first remaining entry in provider order,
// round two each provider's next, and so on, until the pool holds
// SUBTITLE_POOL_PER_LANGUAGE or every provider is exhausted. A duplicate (the
// same URL, or the same OpenSubtitles file under two answers) is dropped where
// it falls, without giving its provider another turn in the same round.
// Languages come out in the configured order, or in order of first appearance
// when there is no filter.
function selectTracks(answers: RawSubtitle[][], languages: readonly string[]): SubtitleTrack[] {
  type Candidate = { track: SubtitleTrack; url: string; fileId: string | null }
  // Per language, one list per provider index, in that provider's own order.
  const byLanguage = new Map<string, Candidate[][]>()

  for (const [providerIdx, entries] of answers.entries()) {
    for (const [entryIdx, entry] of entries.entries()) {
      const url = usableUrl(entry.url)
      const lang = normalizeSubtitleLanguage(entry.lang)
      if (!url || !lang) continue
      if (languages.length && !languages.includes(lang)) continue
      const format = formatOf(url, typeof entry.subtitleFileName === 'string' ? entry.subtitleFileName : entry.fileName)
      // MicroDVD counts frames and VobSub is images that need an .idx beside
      // them; neither plays reliably as an external text track, and skipping
      // them here lets the pool fill with files that do.
      if (format === 'sub') continue
      const ownId = typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id) : String(entryIdx)
      const track: SubtitleTrack = { id: `${providerIdx + 1}-${ownId}`, url, lang, label: '', format, release: releaseOf(entry) }
      let perProvider = byLanguage.get(lang)
      if (!perProvider) {
        perProvider = []
        byLanguage.set(lang, perProvider)
      }
      let list = perProvider[providerIdx]
      if (!list) {
        list = []
        perProvider[providerIdx] = list
      }
      list.push({ track, url, fileId: openSubtitlesFileId(entry, url) })
    }
  }

  const seenUrls = new Set<string>()
  const seenFileIds = new Set<string>()
  const tracks: SubtitleTrack[] = []
  for (const lang of languages.length ? languages : [...byLanguage.keys()]) {
    const perProvider = byLanguage.get(lang) ?? []
    const pool: SubtitleTrack[] = []
    for (let round = 0; pool.length < SUBTITLE_POOL_PER_LANGUAGE; round++) {
      let anyProviderHadATurn = false
      for (const list of perProvider) {
        if (!list || round >= list.length) continue
        anyProviderHadATurn = true
        const candidate = list[round]
        if (seenUrls.has(candidate.url) || (candidate.fileId !== null && seenFileIds.has(candidate.fileId))) continue
        seenUrls.add(candidate.url)
        if (candidate.fileId !== null) seenFileIds.add(candidate.fileId)
        pool.push(candidate.track)
        if (pool.length >= SUBTITLE_POOL_PER_LANGUAGE) break
      }
      if (!anyProviderHadATurn) break
    }
    const name = subtitleLanguageName(lang)
    pool.forEach((track, i) => tracks.push({ ...track, label: pool.length > 1 ? `${name} ${i + 1}` : name }))
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

// A URL already being fetched, so a second caller awaits that fetch instead of
// starting another. Infuse's own request and this file's prefetch often race
// for the same URL, and the provider should see one of them, not two.
const inFlightFileFetches = new Map<string, Promise<SubtitleFile | null>>()

// Jellyfin players fetch subtitles from their own server and follow neither an
// absolute DeliveryUrl nor a redirect, so the file comes through here. Kept
// briefly, because a player fetches every track at play start and again on each
// replay. Never rejects: a file that cannot be had is null, and the player
// simply lacks that track.
export async function fetchSubtitleFile(url: string): Promise<SubtitleFile | null> {
  const cached = fileCache.get(url)
  if (cached && cached.expiresAt > Date.now()) return cached.file
  const inFlight = inFlightFileFetches.get(url)
  if (inFlight) return inFlight
  const promise = fetchSubtitleFileUncached(url)
  inFlightFileFetches.set(url, promise)
  try {
    return await promise
  } finally {
    inFlightFileFetches.delete(url)
  }
}

async function fetchSubtitleFileUncached(url: string): Promise<SubtitleFile | null> {
  const now = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(config.subtitleTimeoutMs) })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > FILE_MAX_BYTES) return null
    const raw = Buffer.from(await res.arrayBuffer())
    if (raw.length > FILE_MAX_BYTES) return null
    // Cleaned before it enters the cache, so every client and every cache hit
    // gets the same ad-free bytes.
    const file: SubtitleFile = { body: stripAdCues(raw), contentType: res.headers.get('content-type') }
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

// At most this many of prefetchSubtitleFiles' urls are ever in flight together,
// so a title with many tracks does not open a burst of connections to a
// provider that counts them, or to one that throttles by IP.
const PREFETCH_CONCURRENCY = 4

// Starts fetching every url a play is about to ask for anyway, so the player's
// own requests land on fetchSubtitleFile's cache or its in-flight fetch instead
// of starting a fresh one. Fire-and-forget: it never throws or rejects, and a
// caller that does not await it still gets the overlap this exists for.
export function prefetchSubtitleFiles(urls: string[]): void {
  const distinct = [...new Set(urls)]
  if (!distinct.length) return
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < distinct.length) {
      const url = distinct[next++]
      await fetchSubtitleFile(url)
    }
  }
  for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, distinct.length); i++) worker().catch(() => {})
}
