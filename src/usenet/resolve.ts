import { getUsenetMovieItem, getUsenetEpisodeItem, type UsenetItem } from '../db.js'
import { isNzbDavConfigured, buildStreamUrl } from './nzbdav.js'
import { isProwlarrConfigured } from './prowlarr.js'

export function isUsenetConfigured(): boolean {
  return isNzbDavConfigured() && isProwlarrConfigured()
}

export interface UsenetStreamRef {
  itemId: number
  url: string
  filename: string
  totalBytes: number
}

function itemToStreamRef(item: UsenetItem, fetcherrStreamBase: string): UsenetStreamRef {
  return {
    itemId:     item.id,
    url:        `${fetcherrStreamBase}/usenet/stream/${item.id}`,
    filename:   item.videoFilename,
    totalBytes: item.totalBytes,
  }
}

export function resolveUsenetMovieStream(tmdbId: number, fetcherrStreamBase: string): UsenetStreamRef {
  const item = getUsenetMovieItem(tmdbId)
  if (!item) throw new Error(`usenet: movie ${tmdbId} not indexed`)
  return itemToStreamRef(item, fetcherrStreamBase)
}

export function resolveUsenetEpisodeStream(showTmdbId: number, season: number, episode: number, fetcherrStreamBase: string): UsenetStreamRef {
  const item = getUsenetEpisodeItem(showTmdbId, season, episode)
  if (!item) throw new Error(`usenet: episode ${showTmdbId} S${season}E${episode} not indexed`)
  return itemToStreamRef(item, fetcherrStreamBase)
}

export { buildStreamUrl as buildNzbDavStreamUrl }
