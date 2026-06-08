import { config } from '../config.js'
import { getMovieByTmdbId, getShowByTmdbId, listUnindexedMovieTmdbIds, listUnindexedEpisodes, upsertUsenetItem, markUsenetItemFailed } from '../db.js'
import { searchMovieNzb, searchEpisodeNzb, isProwlarrConfigured } from './prowlarr.js'
import { parseNzb } from './nzb-parser.js'

const SYNC_INTERVAL_MS   = 6 * 60 * 60 * 1000  // 6h full re-index
const STARTUP_DELAY_MS   = 10_000
const BATCH_SIZE         = 10
const BATCH_DELAY_MS     = 2_000

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
  const parsed = await fetchAndParseNzb(result.downloadUrl)
  if (!parsed) {
    markUsenetItemFailed('movie', tmdbId, null, null, `NZB has no usable video file: ${result.title}`)
    return
  }
  upsertUsenetItem({
    mediaType:      'movie',
    tmdbId,
    season:         null,
    episode:        null,
    nzbTitle:       result.title,
    nzbDownloadUrl: result.downloadUrl,
    videoFilename:  parsed.file.filename,
    totalBytes:     parsed.estimatedDecodedBytes,
    segmentsJson:   JSON.stringify(parsed.file.segments),
    status:         'indexed',
    indexedAt:      Date.now(),
  })
  console.log(`[usenet/sync] indexed movie ${tmdbId}: ${parsed.file.filename} (${parsed.file.segments.length} segments)`)
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
  const parsed = await fetchAndParseNzb(result.downloadUrl)
  if (!parsed) {
    markUsenetItemFailed('episode', showTmdbId, season, episode, `NZB has no usable video file: ${result.title}`)
    return
  }
  upsertUsenetItem({
    mediaType:      'episode',
    tmdbId:         showTmdbId,
    season,
    episode,
    nzbTitle:       result.title,
    nzbDownloadUrl: result.downloadUrl,
    videoFilename:  parsed.file.filename,
    totalBytes:     parsed.estimatedDecodedBytes,
    segmentsJson:   JSON.stringify(parsed.file.segments),
    status:         'indexed',
    indexedAt:      Date.now(),
  })
  console.log(`[usenet/sync] indexed episode ${showTmdbId} S${season}E${episode}: ${parsed.file.filename}`)
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function syncLibrary(): Promise<void> {
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
    syncLibrary().catch(e => console.error('[usenet/sync] sync error:', e?.message ?? e))
  }

  setTimeout(() => {
    run()
    setInterval(run, SYNC_INTERVAL_MS)
  }, STARTUP_DELAY_MS)
}
