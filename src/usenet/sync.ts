import { config } from '../config.js'
import { getMovieByTmdbId, getShowByTmdbId, listUnindexedMovieTmdbIds, listUnindexedEpisodes, listUsenetPriorityTargets, listPendingUsenetItems, upsertUsenetItem, updateUsenetItemIndexed, markUsenetItemFailed } from '../db.js'
import { searchMovieNzb, searchEpisodeNzb, isProwlarrConfigured, type NzbResult } from './prowlarr.js'
import { submitNzbUrl, getHistorySlot, findVideoInFolder, isNzbDavConfigured } from './nzbdav.js'

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const STARTUP_DELAY_MS = 10_000
const BATCH_SIZE       = 1
const BATCH_DELAY_MS   = 3_000
const POLL_INTERVAL_MS = 3_000
const POLL_MAX_MS      = 30_000

function ensureNzbApiKey(downloadUrl: string): string {
  if (downloadUrl.includes('apikey')) return downloadUrl
  return downloadUrl + (downloadUrl.includes('?') ? '&' : '?') + `apikey=${config.prowlarrApiKey}`
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function indexMovie(tmdbId: number): Promise<void> {
  if (!isNzbDavConfigured()) return
  const movie = getMovieByTmdbId(tmdbId)
  if (!movie?.imdbId) {
    markUsenetItemFailed('movie', tmdbId, null, null, 'no IMDB ID')
    return
  }
  const result = await searchMovieNzb(movie.imdbId)
  if (!result) {
    console.warn(`[usenet/sync] no NZB for movie ${tmdbId} (${movie.imdbId})`)
    markUsenetItemFailed('movie', tmdbId, null, null, 'no NZB results from Prowlarr')
    return
  }
  await indexItem('movie', tmdbId, null, null, result)
}

export async function indexEpisode(showTmdbId: number, season: number, episode: number): Promise<void> {
  if (!isNzbDavConfigured()) return
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
  const label = mediaType === 'episode' ? `${tmdbId} S${season}E${episode}` : String(tmdbId)
  const category = mediaType === 'movie' ? 'movies' : 'tv'
  const nzbUrl = ensureNzbApiKey(result.downloadUrl)

  const nzoId = await submitNzbUrl(nzbUrl, category)
  console.log(`[usenet/sync] submitted ${mediaType} ${label}: ${result.title} → ${nzoId}`)

  // Store as pending immediately to prevent re-submission during polling
  upsertUsenetItem({
    mediaType,
    tmdbId,
    season,
    episode,
    nzbTitle:        result.title,
    nzbDownloadUrl:  result.downloadUrl,
    videoFilename:   '',
    totalBytes:      0,
    segmentsJson:    '[]',
    nzbdavNzoId:     nzoId,
    nzbdavPath:      '',
    status:          'pending',
    indexedAt:       Date.now(),
  })

  // Poll NzbDav history until Completed or timeout
  const deadline = Date.now() + POLL_MAX_MS
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS)
    try {
      const slot = await getHistorySlot(nzoId)
      if (!slot) continue
      if (slot.status === 'Failed') {
        console.warn(`[usenet/sync] NzbDav failed ${label}: ${slot.fail_message ?? 'unknown'}`)
        markUsenetItemFailed(mediaType, tmdbId, season, episode, slot.fail_message || 'NzbDav processing failed')
        return
      }
      if (slot.status === 'Completed') {
        const folderPath = `/content/${encodeURIComponent(slot.category)}/${encodeURIComponent(slot.name)}`
        const videoPath = await findVideoInFolder(folderPath)
        if (videoPath) {
          const filename = videoPath.split('/').pop() ?? result.title + '.mkv'
          const item = listPendingUsenetItems().find(i => i.nzbdavNzoId === nzoId)
          if (item) updateUsenetItemIndexed(item.id, videoPath, filename)
          console.log(`[usenet/sync] indexed ${mediaType} ${label}: ${filename}`)
          return
        }
      }
    } catch (e: unknown) {
      console.warn(`[usenet/sync] poll error for ${label}: ${(e as Error)?.message ?? e}`)
    }
  }

  console.warn(`[usenet/sync] timeout waiting for NzbDav completion for ${label}, leaving as pending`)
}

// Poll all pending items in DB against NzbDav history.
// Runs periodically so items that timed out in indexItem() still get resolved.
async function pollPendingItems(): Promise<void> {
  if (!isNzbDavConfigured()) return
  const pending = listPendingUsenetItems()
  if (!pending.length) return
  console.log(`[usenet/sync] polling ${pending.length} pending NzbDav items`)

  for (const item of pending) {
    if (!item.nzbdavNzoId) continue
    try {
      const slot = await getHistorySlot(item.nzbdavNzoId)
      if (!slot) continue
      if (slot.status === 'Failed') {
        markUsenetItemFailed(item.mediaType, item.tmdbId, item.season, item.episode, slot.fail_message || 'NzbDav failed')
        console.warn(`[usenet/sync] pending → failed: ${item.nzbTitle}`)
      } else if (slot.status === 'Completed') {
        const folderPath = `/content/${encodeURIComponent(slot.category)}/${encodeURIComponent(slot.name)}`
        const videoPath = await findVideoInFolder(folderPath)
        if (videoPath) {
          const filename = videoPath.split('/').pop() ?? item.nzbTitle + '.mkv'
          updateUsenetItemIndexed(item.id, videoPath, filename)
          console.log(`[usenet/sync] pending → indexed: ${item.nzbTitle}`)
        }
      }
    } catch (e: unknown) {
      console.warn(`[usenet/sync] poll pending error for item ${item.id}: ${(e as Error)?.message ?? e}`)
    }
  }
}

export async function syncUsenetLibrary(): Promise<void> {
  if (!isProwlarrConfigured() || !isNzbDavConfigured()) return

  const movieIds = listUnindexedMovieTmdbIds()
  console.log(`[usenet/sync] indexing ${movieIds.length} unindexed movies`)
  for (let i = 0; i < movieIds.length; i += BATCH_SIZE) {
    const batch = movieIds.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(batch.map(id => indexMovie(id).catch(e => {
      console.warn(`[usenet/sync] movie ${id} error: ${(e as Error)?.message ?? e}`)
      markUsenetItemFailed('movie', id, null, null, String((e as Error)?.message ?? e))
    })))
    if (i + BATCH_SIZE < movieIds.length) await delay(BATCH_DELAY_MS)
  }

  const episodes = listUnindexedEpisodes()
  console.log(`[usenet/sync] indexing ${episodes.length} unindexed episodes`)
  for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
    const batch = episodes.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(batch.map(ep => indexEpisode(ep.showTmdbId, ep.season, ep.episode).catch(e => {
      console.warn(`[usenet/sync] episode ${ep.showTmdbId} S${ep.season}E${ep.episode} error: ${(e as Error)?.message ?? e}`)
      markUsenetItemFailed('episode', ep.showTmdbId, ep.season, ep.episode, String((e as Error)?.message ?? e))
    })))
    if (i + BATCH_SIZE < episodes.length) await delay(BATCH_DELAY_MS)
  }
}

export async function syncPriorityUsenetItems(): Promise<void> {
  if (!isProwlarrConfigured() || !isNzbDavConfigured()) return

  const { movies, episodes } = listUsenetPriorityTargets()
  if (!movies.length && !episodes.length) return
  console.log(`[usenet/sync] priority: ${movies.length} resume movies, ${episodes.length} next-up/resume episodes`)

  await Promise.allSettled(movies.map(id => indexMovie(id).catch(e => {
    console.warn(`[usenet/sync] priority movie ${id} error: ${(e as Error)?.message ?? e}`)
    markUsenetItemFailed('movie', id, null, null, String((e as Error)?.message ?? e))
  })))

  await Promise.allSettled(episodes.map(ep => indexEpisode(ep.showTmdbId, ep.season, ep.episode).catch(e => {
    console.warn(`[usenet/sync] priority episode error: ${(e as Error)?.message ?? e}`)
    markUsenetItemFailed('episode', ep.showTmdbId, ep.season, ep.episode, String((e as Error)?.message ?? e))
  })))
}

export function startUsenetSync(): void {
  if (!isNzbDavConfigured() || !isProwlarrConfigured()) {
    console.log('[usenet/sync] NzbDav or Prowlarr not configured, skipping sync')
    return
  }
  if (!config.nzbdavSyncEnabled) {
    console.log('[usenet/sync] NZBDAV_SYNC_ENABLED=false — library sync disabled; on-demand indexing still active')
    // Still poll pending items in case on-demand indexing submitted something
    setInterval(() => {
      pollPendingItems().catch(e => console.error('[usenet/sync] pending poll error:', (e as Error)?.message ?? e))
    }, 60_000)
    return
  }

  const runFull = () => {
    syncUsenetLibrary().catch(e => console.error('[usenet/sync] sync error:', (e as Error)?.message ?? e))
  }

  const runPendingPoll = () => {
    pollPendingItems().catch(e => console.error('[usenet/sync] pending poll error:', (e as Error)?.message ?? e))
  }

  setTimeout(() => {
    syncPriorityUsenetItems()
      .catch(e => console.error('[usenet/sync] priority sync error:', (e as Error)?.message ?? e))
      .finally(() => {
        runFull()
        setInterval(runFull, SYNC_INTERVAL_MS)
        setInterval(runPendingPoll, 60_000)
      })
  }, STARTUP_DELAY_MS)
}
