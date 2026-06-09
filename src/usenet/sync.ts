import { config } from '../config.js'
import { getMovieByTmdbId, getShowByTmdbId, listUnindexedMovieTmdbIds, listUnindexedEpisodes, upsertUsenetItem, markUsenetItemFailed } from '../db.js'
import { searchMovieNzb, searchEpisodeNzb, isProwlarrConfigured, type NzbResult } from './prowlarr.js'
import { parseNzb, parseRarDataOffset, buildOffsetTable, estimateDecodedBytesExport, type NzbFile } from './nzb-parser.js'
import { getNntpPool } from './nntp-pool.js'
import { ydecode } from './ydecode.js'

const SYNC_INTERVAL_MS   = 6 * 60 * 60 * 1000
const STARTUP_DELAY_MS   = 10_000
const BATCH_SIZE         = 10
const BATCH_DELAY_MS     = 2_000
const DEFAULT_VOL0_HEADER = 128
const DEFAULT_CONT_HEADER = 50

function isNntpConfigured(): boolean {
  return Boolean(config.nntpHost && config.nntpUser && config.nntpPass)
}

async function fetchAndParseNzb(downloadUrl: string): Promise<ReturnType<typeof parseNzb>> {
  const url = downloadUrl.includes('apikey')
    ? downloadUrl
    : downloadUrl + (downloadUrl.includes('?') ? '&' : '?') + `apikey=${config.prowlarrApiKey}`
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`NZB fetch returned ${res.status}`)
  return parseNzb(await res.text())
}

async function fetchVolumeHeaderBytes(volume: NzbFile, fallback: number): Promise<number> {
  try {
    const pool = getNntpPool()
    const body = await pool.fetchArticleBody(volume.segments[0].messageId)
    const decoded = ydecode(body)
    const offset = parseRarDataOffset(decoded)
    return offset > 0 ? offset : fallback
  } catch {
    return fallback
  }
}

function buildRarSegmentsJson(volumes: NzbFile[], headerBytesPerVolume: number[]): { segmentsJson: string; totalBytes: number } {
  let totalBytes = 0
  const volumeData = volumes.map((vol, i) => {
    const headerBytes = headerBytesPerVolume[i] ?? headerBytesPerVolume[1] ?? DEFAULT_CONT_HEADER
    const volDecoded = vol.segments.reduce((sum, s) => sum + estimateDecodedBytesExport(s.bytes), 0)
    totalBytes += Math.max(0, volDecoded - headerBytes)
    return { headerBytes, segments: vol.segments }
  })
  return { segmentsJson: JSON.stringify({ type: 'rar', volumes: volumeData }), totalBytes }
}

async function indexMovie(tmdbId: number): Promise<void> {
  const movie = getMovieByTmdbId(tmdbId)
  if (!movie?.imdbId) {
    markUsenetItemFailed('movie', tmdbId, null, null, 'no IMDB ID')
    return
  }
  const result = await searchMovieNzb(movie.imdbId)
  if (!result) {
    markUsenetItemFailed('movie', tmdbId, null, null, 'no NZB results from Prowlarr')
    return
  }
  await indexItem('movie', tmdbId, null, null, result)
}

async function indexEpisode(showTmdbId: number, season: number, episode: number): Promise<void> {
  const show = getShowByTmdbId(showTmdbId)
  if (!show?.tvdbId) {
    markUsenetItemFailed('episode', showTmdbId, season, episode, 'no TVDB ID')
    return
  }
  const result = await searchEpisodeNzb(show.tvdbId, season, episode)
  if (!result) {
    markUsenetItemFailed('episode', showTmdbId, season, episode, 'no NZB results from Prowlarr')
    return
  }
  await indexItem('episode', showTmdbId, season, episode, result)
}

async function indexItem(
  mediaType: 'movie' | 'episode',
  tmdbId: number,
  season: number | null,
  episode: number | null,
  result: NzbResult,
): Promise<void> {
  const parsed = await fetchAndParseNzb(result.downloadUrl)
  if (!parsed) {
    markUsenetItemFailed(mediaType, tmdbId, season, episode, `NZB has no usable files: ${result.title}`)
    return
  }

  let videoFilename: string
  let totalBytes: number
  let segmentsJson: string

  if (parsed.type === 'direct') {
    videoFilename = parsed.file.filename
    totalBytes    = parsed.estimatedDecodedBytes
    segmentsJson  = JSON.stringify(parsed.file.segments)
  } else {
    // RAR: fetch first article of vol0 and vol1 to get exact header offsets
    const [vol0Header, vol1Header] = await Promise.all([
      fetchVolumeHeaderBytes(parsed.volumes[0], DEFAULT_VOL0_HEADER),
      parsed.volumes.length > 1
        ? fetchVolumeHeaderBytes(parsed.volumes[1], DEFAULT_CONT_HEADER)
        : Promise.resolve(DEFAULT_CONT_HEADER),
    ])
    const headerBytes = [vol0Header, ...parsed.volumes.slice(1).map(() => vol1Header)]
    const built = buildRarSegmentsJson(parsed.volumes, headerBytes)
    segmentsJson  = built.segmentsJson
    totalBytes    = built.totalBytes
    // Derive filename from release title — strip scene tags, assume mkv
    videoFilename = result.title.replace(/\.(rar|r\d{2,3})$/i, '') + '.mkv'
  }

  upsertUsenetItem({
    mediaType,
    tmdbId,
    season,
    episode,
    nzbTitle:       result.title,
    nzbDownloadUrl: result.downloadUrl,
    videoFilename,
    totalBytes,
    segmentsJson,
    status:         'indexed',
    indexedAt:      Date.now(),
  })
  const label = mediaType === 'episode' ? `${tmdbId} S${season}E${episode}` : String(tmdbId)
  console.log(`[usenet/sync] indexed ${mediaType} ${label}: ${videoFilename} (${parsed.type})`)
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function syncUsenetLibrary(): Promise<void> {
  if (!isProwlarrConfigured()) return

  const movieIds = listUnindexedMovieTmdbIds()
  console.log(`[usenet/sync] indexing ${movieIds.length} unindexed movies`)
  for (let i = 0; i < movieIds.length; i += BATCH_SIZE) {
    const batch = movieIds.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(batch.map(id => indexMovie(id).catch(e => {
      console.warn(`[usenet/sync] movie ${id} error: ${e?.message ?? e}`)
      markUsenetItemFailed('movie', id, null, null, String(e?.message ?? e))
    })))
    if (i + BATCH_SIZE < movieIds.length) await delay(BATCH_DELAY_MS)
  }

  const episodes = listUnindexedEpisodes()
  console.log(`[usenet/sync] indexing ${episodes.length} unindexed episodes`)
  for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
    const batch = episodes.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(batch.map(ep => indexEpisode(ep.showTmdbId, ep.season, ep.episode).catch(e => {
      console.warn(`[usenet/sync] episode ${ep.showTmdbId} S${ep.season}E${ep.episode} error: ${e?.message ?? e}`)
      markUsenetItemFailed('episode', ep.showTmdbId, ep.season, ep.episode, String(e?.message ?? e))
    })))
    if (i + BATCH_SIZE < episodes.length) await delay(BATCH_DELAY_MS)
  }
}

export function startUsenetSync(): void {
  if (!isNntpConfigured() || !isProwlarrConfigured()) {
    console.log('[usenet/sync] NNTP or Prowlarr not configured, skipping sync')
    return
  }

  const run = () => {
    syncUsenetLibrary().catch(e => console.error('[usenet/sync] sync error:', e?.message ?? e))
  }

  setTimeout(() => {
    run()
    setInterval(run, SYNC_INTERVAL_MS)
  }, STARTUP_DELAY_MS)
}
