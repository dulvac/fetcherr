import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'

// A stand-in Gestdown over real HTTP, in the style of fake-subtitle-provider.ts.
// Shows are looked up by TVDB id, subtitles by show guid, season, episode and
// language, and it serves the download endpoint too. Not a test file itself:
// `npm test` globs test/*.test.ts.

export type FakeGestdownMode = 'answers' | '404' | '423' | '429' | 'error' | 'slow'

export interface FakeGestdownShow {
  tvdbId: string | number
  guid: string
}

export interface FakeGestdownLanguageConfig {
  mode?: FakeGestdownMode
  entries?: Array<Record<string, unknown>>
  // Overrides the episode Gestdown reports back, to model the season-pack
  // fallback: an answer about an episode other than the one asked.
  episode?: { season: number; number: number }
}

export interface FakeGestdownOptions {
  shows?: FakeGestdownShow[]
  showMode?: FakeGestdownMode
  // How long 'slow' waits before answering. Default 5000 ms.
  slowMs?: number
}

export interface FakeGestdown {
  url: string
  showRequests: string[]
  languageRequests: string[]
  downloadRequests: string[]
  setShowMode: (mode: FakeGestdownMode) => void
  addShow: (tvdbId: string | number, guid: string) => void
  setLanguage: (guid: string, season: number, episode: number, lang: string, config: FakeGestdownLanguageConfig) => void
  close: () => Promise<void>
}

interface LanguageState {
  mode: FakeGestdownMode
  entries: Array<Record<string, unknown>>
  episode: { season: number; number: number }
}

// subtitles.ts refuses a loopback subtitle URL (a client would be sent to its
// own localhost), so the fake must answer on an address other than one of
// those: its own non-loopback interface, which is reachable from inside the
// same sandbox or container that runs the tests.
function ownAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

export async function startFakeGestdown(options: FakeGestdownOptions = {}): Promise<FakeGestdown> {
  const shows = new Map<string, string>()
  for (const show of options.shows ?? []) shows.set(String(show.tvdbId), show.guid)
  let showMode: FakeGestdownMode = options.showMode ?? 'answers'
  const languages = new Map<string, LanguageState>()
  const showRequests: string[] = []
  const languageRequests: string[] = []
  const downloadRequests: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const slowMs = options.slowMs ?? 5000
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
  }

  const languageKey = (guid: string, season: number, episode: number, lang: string) => `${guid}/${season}/${episode}/${lang}`

  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    const send = (status: number, body: string, contentType = 'application/json') => {
      // The client may have given up and closed the socket already.
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    }
    const answerOr = (mode: FakeGestdownMode, onAnswer: () => void) => {
      if (mode === '404') return send(404, '{}')
      if (mode === '423') return send(423, '{}')
      if (mode === '429') return send(429, '{}')
      if (mode === 'error') return send(500, '{}')
      if (mode === 'slow') return later(slowMs, onAnswer)
      onAnswer()
    }

    const showMatch = /^\/shows\/external\/tvdb\/([^/]+)$/.exec(path)
    if (showMatch) {
      showRequests.push(path)
      answerOr(showMode, () => {
        const guid = shows.get(decodeURIComponent(showMatch[1]))
        send(200, JSON.stringify({ shows: guid ? [{ id: guid, name: 'Fake Show' }] : [] }))
      })
      return
    }

    const langMatch = /^\/subtitles\/get\/([^/]+)\/(\d+)\/(\d+)\/([a-z]{2})$/.exec(path)
    if (langMatch) {
      languageRequests.push(path)
      const [, guid, seasonText, episodeText, lang] = langMatch
      const season = Number(seasonText)
      const episode = Number(episodeText)
      const key = languageKey(guid, season, episode, lang)
      const state = languages.get(key) ?? { mode: 'answers' as FakeGestdownMode, entries: [], episode: { season, number: episode } }
      answerOr(state.mode, () => {
        send(200, JSON.stringify({
          matchingSubtitles: state.entries,
          episode: { season: state.episode.season, number: state.episode.number, title: 'Fake Episode' },
        }))
      })
      return
    }

    const downloadMatch = /^\/subtitles\/download\/([^/]+)$/.exec(path)
    if (downloadMatch) {
      downloadRequests.push(path)
      send(200, `1\n00:00:01,000 --> 00:00:02,000\nfake gestdown file ${downloadMatch[1]}\n`, 'text/srt')
      return
    }

    send(404, '{}')
  })

  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://${ownAddress()}:${port}`,
    showRequests,
    languageRequests,
    downloadRequests,
    setShowMode: mode => { showMode = mode },
    addShow: (tvdbId, guid) => { shows.set(String(tvdbId), guid) },
    setLanguage: (guid, season, episode, lang, config) => {
      const key = languageKey(guid, season, episode, lang)
      const existing = languages.get(key) ?? { mode: 'answers' as FakeGestdownMode, entries: [], episode: { season, number: episode } }
      languages.set(key, {
        mode: config.mode ?? existing.mode,
        entries: config.entries ?? existing.entries,
        episode: config.episode ?? existing.episode,
      })
    },
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
