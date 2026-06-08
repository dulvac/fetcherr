import { config } from '../config.js'
import { getUsenetMovieItem, getUsenetEpisodeItem, type UsenetItem } from '../db.js'
import { isProwlarrConfigured } from './prowlarr.js'

export function isUsenetConfigured(): boolean {
  return Boolean(
    config.nntpHost && config.nntpUser && config.nntpPass &&
    isProwlarrConfigured()
  )
}

export interface UsenetStreamRef {
  itemId: number
  url: string
  filename: string
  totalBytes: number
}

function itemToStreamRef(item: UsenetItem): UsenetStreamRef {
  return {
    itemId:     item.id,
    url:        `${config.serverUrl}/usenet/stream/${item.id}`,
    filename:   item.videoFilename,
    totalBytes: item.totalBytes,
  }
}

export function resolveUsenetMovieStream(tmdbId: number): UsenetStreamRef {
  const item = getUsenetMovieItem(tmdbId)
  if (!item) throw new Error(`usenet: movie ${tmdbId} not indexed`)
  return itemToStreamRef(item)
}

export function resolveUsenetEpisodeStream(showTmdbId: number, season: number, episode: number): UsenetStreamRef {
  const item = getUsenetEpisodeItem(showTmdbId, season, episode)
  if (!item) throw new Error(`usenet: episode ${showTmdbId} S${season}E${episode} not indexed`)
  return itemToStreamRef(item)
}
