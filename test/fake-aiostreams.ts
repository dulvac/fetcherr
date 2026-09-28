import { createServer, type Server } from 'node:http'

// A stand-in for aiostreams' native usenet stream route over real HTTP, so the
// relay really connects, really sends Range and really sees its request
// cancelled. Paths under /api/v1/usenet/stream/:
//   good     a fixed 1 MiB body with byte-range support
//   gone     404, as for a token aiostreams no longer knows
//   error    307 to /static/500.mp4, as aiostreams answers a failed stream
//   endless  200, then 64 KiB every 20 ms until the client goes away
//
// Not a test file itself: `npm test` globs test/*.test.ts.

export const FAKE_BODY = Buffer.alloc(1024 * 1024, 0).map((_, i) => i % 251)

export interface FakeAiostreams {
  origin: string
  // Every request as it arrived: method, path, and the Range header if any.
  requests: Array<{ method: string; path: string; range?: string }>
  // Resolves once an endless stream has been closed by its client.
  endlessClosed: () => Promise<void>
  close: () => Promise<void>
}

export async function startFakeAiostreams(): Promise<FakeAiostreams> {
  const requests: FakeAiostreams['requests'] = []
  let markClosed: () => void = () => {}
  const closed = new Promise<void>(resolve => { markClosed = resolve })
  const timers = new Set<ReturnType<typeof setInterval>>()

  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
    requests.push({ method: req.method ?? 'GET', path, ...(range ? { range } : {}) })
    const name = path.replace(/^\/api\/v1\/usenet\/stream\//, '').split(/[/?]/)[0]

    if (name === 'good') {
      const match = range?.match(/^bytes=(\d+)-(\d*)$/)
      const total = FAKE_BODY.length
      if (match) {
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
        res.writeHead(206, {
          'content-type': 'video/x-matroska',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'x-internal': 'not for the viewer',
        })
        res.end(req.method === 'HEAD' ? undefined : FAKE_BODY.subarray(start, end + 1))
        return
      }
      res.writeHead(200, {
        'content-type': 'video/x-matroska',
        'content-length': String(total),
        'accept-ranges': 'bytes',
        'x-internal': 'not for the viewer',
      })
      res.end(req.method === 'HEAD' ? undefined : FAKE_BODY)
      return
    }
    if (name === 'error') {
      res.writeHead(307, { location: '/static/500.mp4' })
      res.end()
      return
    }
    if (name === 'endless') {
      res.writeHead(200, { 'content-type': 'video/x-matroska' })
      const chunk = Buffer.alloc(64 * 1024, 7)
      const timer = setInterval(() => res.write(chunk), 20)
      timers.add(timer)
      res.on('close', () => {
        clearInterval(timer)
        timers.delete(timer)
        markClosed()
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake aiostreams has no port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    endlessClosed: () => closed,
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearInterval(timer)
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
