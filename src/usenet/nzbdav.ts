import { config } from '../config.js'

export function isNzbDavConfigured(): boolean {
  return Boolean(config.nzbdavUrl && config.nzbdavApiKey && config.nzbdavUser && config.nzbdavPass)
}

function basicAuth(): string {
  return 'Basic ' + Buffer.from(`${config.nzbdavUser}:${config.nzbdavPass}`).toString('base64')
}

// Submit NZB URL via SABnzbd addurl API. Returns nzoId (GUID string).
export async function submitNzbUrl(nzbUrl: string, category: string): Promise<string> {
  const apiUrl = new URL(`${config.nzbdavUrl}/api`)
  apiUrl.searchParams.set('mode', 'addurl')
  apiUrl.searchParams.set('output', 'json')
  apiUrl.searchParams.set('apikey', config.nzbdavApiKey)
  apiUrl.searchParams.set('name', nzbUrl)
  apiUrl.searchParams.set('cat', category)

  const res = await fetch(apiUrl.toString(), { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`NzbDav addurl returned ${res.status}`)
  const data = await res.json() as { status?: boolean; nzo_ids?: string[] }
  const nzoId = data.nzo_ids?.[0]
  if (!nzoId) throw new Error(`NzbDav addurl returned no nzo_id: ${JSON.stringify(data)}`)
  return nzoId
}

export interface NzbDavHistorySlot {
  nzo_id: string
  name: string
  category: string
  status: string
  fail_message?: string
}

// Fetch history slot for a given nzoId. Returns null if not yet in history.
export async function getHistorySlot(nzoId: string): Promise<NzbDavHistorySlot | null> {
  const apiUrl = `${config.nzbdavUrl}/api?mode=history&output=json&apikey=${config.nzbdavApiKey}&limit=200`
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`NzbDav history returned ${res.status}`)
  const data = await res.json() as { history?: { slots?: NzbDavHistorySlot[] } }
  return data.history?.slots?.find(s => s.nzo_id === nzoId) ?? null
}

// PROPFIND a folder and return the WebDAV path of the first video file found.
export async function findVideoInFolder(folderWebdavPath: string): Promise<string | null> {
  const url = config.nzbdavUrl + folderWebdavPath
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      'Authorization': basicAuth(),
      'Depth': '1',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return null
  const xml = await res.text()
  const hrefPattern = /<(?:[^:>\s]+:)?href[^>]*>([^<]+)<\/(?:[^:>\s]+:)?href>/g
  const videoExt = /\.(mkv|mp4|avi|m4v|ts|m2ts)$/i
  let match: RegExpExecArray | null
  while ((match = hrefPattern.exec(xml)) !== null) {
    const href = decodeURIComponent(match[1].trim())
    if (videoExt.test(href)) return href
  }
  return null
}

// Build a WebDAV stream URL with credentials embedded.
// Uses NZBDAV_PUBLIC_URL if set (for clients outside Docker), otherwise NZBDAV_URL.
export function buildStreamUrl(webdavPath: string): string {
  const base = config.nzbdavPublicUrl || config.nzbdavUrl
  const user = encodeURIComponent(config.nzbdavUser)
  const pass = encodeURIComponent(config.nzbdavPass)
  return base.replace(/^(https?:\/\/)/, `$1${user}:${pass}@`) + webdavPath
}
