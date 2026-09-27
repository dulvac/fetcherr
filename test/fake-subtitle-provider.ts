import { createServer, type Server } from 'node:http'

// A stand-in Stremio subtitles addon over real HTTP, so fetchSubtitles really
// connects, really times out and really parses JSON. Behaviour is chosen per
// test and can be switched mid-test with setMode.
//
// Not a test file itself: `npm test` globs test/*.test.ts.

export type FakeSubtitleMode = 'answers' | 'empty' | 'slow' | 'error' | 'garbage'

export interface FakeSubtitleProviderOptions {
  mode?: FakeSubtitleMode
  // Entries as a provider would send them. Loose on purpose, so tests can send
  // the malformed ones too.
  subtitles?: Array<Record<string, unknown>>
  // How long 'slow' waits before answering. Default 5000 ms.
  slowMs?: number
  // What the manifest declares. Default ['subtitles'].
  resources?: unknown[]
  // Delay before the manifest answers, to model a provider whose manifest hangs.
  manifestDelayMs?: number
}

export interface FakeSubtitleProvider {
  url: string
  // Every subtitles request path exactly as it arrived, still percent-encoded.
  requests: string[]
  manifestRequests: () => number
  setMode: (mode: FakeSubtitleMode) => void
  close: () => Promise<void>
}

export async function startFakeSubtitleProvider(options: FakeSubtitleProviderOptions = {}): Promise<FakeSubtitleProvider> {
  let mode: FakeSubtitleMode = options.mode ?? 'answers'
  let manifestRequests = 0
  const requests: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    const send = (status: number, body: string) => {
      // The client may have given up and closed the socket already.
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }

    if (path === '/manifest.json') {
      manifestRequests++
      const manifest = JSON.stringify({
        id: 'test.fake-subtitles', version: '1.0.0', name: 'Fake subtitles',
        resources: options.resources ?? ['subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [],
      })
      if (options.manifestDelayMs) later(options.manifestDelayMs, () => send(200, manifest))
      else send(200, manifest)
      return
    }
    if (!path.startsWith('/subtitles/')) {
      send(404, '{}')
      return
    }

    requests.push(path)
    const answer = () => {
      if (mode === 'error') return send(500, '{"error":"boom"}')
      if (mode === 'garbage') return send(200, 'this is not json')
      send(200, JSON.stringify({ subtitles: mode === 'empty' ? [] : options.subtitles ?? [] }))
    }
    if (mode === 'slow') later(options.slowMs ?? 5000, answer)
    else answer()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    manifestRequests: () => manifestRequests,
    setMode: next => { mode = next },
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
