import * as net from 'net'
import * as tls from 'tls'
import { config } from '../config.js'

export class NntpError extends Error {}

class NntpConnection {
  private buf = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private _closed = false

  constructor(private socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      const waiters = this.waiters.splice(0)
      for (const w of waiters) w()
    })
    socket.on('error', () => { this._closed = true; const w = this.waiters.splice(0); w.forEach(fn => fn()) })
    socket.on('close', () => { this._closed = true; const w = this.waiters.splice(0); w.forEach(fn => fn()) })
  }

  get closed() { return this._closed }

  private waitData(): Promise<void> {
    return new Promise(resolve => this.waiters.push(resolve))
  }

  async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf('\r\n')
      if (idx >= 0) {
        const line = this.buf.slice(0, idx).toString('binary')
        this.buf = this.buf.slice(idx + 2)
        return line
      }
      if (this._closed) throw new NntpError('Connection closed while reading line')
      await this.waitData()
    }
  }

  async readMultilineBody(): Promise<Buffer> {
    const chunks: Buffer[] = []
    while (true) {
      const line = await this.readLine()
      if (line === '.') break
      const actual = line.startsWith('..') ? line.slice(1) : line
      chunks.push(Buffer.from(actual, 'binary'))
      chunks.push(Buffer.from('\r\n'))
    }
    return Buffer.concat(chunks)
  }

  send(cmd: string): void {
    this.socket.write(cmd + '\r\n')
  }

  destroy(): void {
    this._closed = true
    this.socket.destroy()
  }
}

async function openConnection(): Promise<NntpConnection> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket
    let settled = false

    const handshakeTimeout = setTimeout(() => {
      if (!settled) { socket?.destroy(); reject(new NntpError('NNTP connection timed out')) }
    }, 20_000)

    const onConnect = async () => {
      const conn = new NntpConnection(socket)
      try {
        const banner = await conn.readLine()
        if (!banner.startsWith('2')) throw new NntpError(`NNTP server rejected connection: ${banner}`)

        conn.send(`AUTHINFO USER ${config.nntpUser}`)
        const authUserResp = await conn.readLine()
        if (authUserResp.startsWith('381')) {
          conn.send(`AUTHINFO PASS ${config.nntpPass}`)
          const authPassResp = await conn.readLine()
          if (!authPassResp.startsWith('281')) throw new NntpError(`NNTP auth failed: ${authPassResp}`)
        } else if (!authUserResp.startsWith('281')) {
          throw new NntpError(`NNTP auth user failed: ${authUserResp}`)
        }

        clearTimeout(handshakeTimeout)
        // Disable inactivity timeout — pool connections live until the server closes them.
        // We detect server-side closes via the 'close' event (sets _closed = true).
        socket.setTimeout(0)
        settled = true
        resolve(conn)
      } catch (err) {
        clearTimeout(handshakeTimeout)
        settled = true
        socket.destroy()
        reject(err)
      }
    }

    if (config.nntpSsl) {
      const tlsSocket = tls.connect(
        { host: config.nntpHost, port: config.nntpPort, rejectUnauthorized: true },
        onConnect,
      )
      tlsSocket.on('error', (err) => { if (!settled) { settled = true; clearTimeout(handshakeTimeout); reject(err) } })
      socket = tlsSocket
    } else {
      socket = net.createConnection({ host: config.nntpHost, port: config.nntpPort }, onConnect)
      socket.on('error', (err) => { if (!settled) { settled = true; clearTimeout(handshakeTimeout); reject(err) } })
    }
  })
}

class NntpPool {
  private idle: NntpConnection[] = []
  private queue: Array<(conn: NntpConnection) => void> = []
  private active = 0

  async acquire(): Promise<NntpConnection> {
    // Return idle connection if available and healthy
    while (this.idle.length > 0) {
      const conn = this.idle.pop()!
      if (!conn.closed) return conn
      this.active--  // server closed this idle connection; reclaim the slot
    }

    // Open new connection if under limit
    if (this.active < config.nntpConnections) {
      this.active++
      try {
        return await openConnection()
      } catch (err) {
        this.active--
        throw err
      }
    }

    // Wait for a connection to be released
    return new Promise(resolve => this.queue.push(resolve))
  }

  release(conn: NntpConnection): void {
    if (conn.closed) {
      this.active--
      const waiter = this.queue.shift()
      if (waiter) {
        this.active++
        openConnection()
          .then(newConn => waiter(newConn))
          .catch(() => { this.active--; this.release(conn) })
      }
      return
    }

    const waiter = this.queue.shift()
    if (waiter) {
      waiter(conn)
    } else {
      this.idle.push(conn)
    }
  }

  async fetchArticleBody(messageId: string): Promise<Buffer> {
    const conn = await this.acquire()
    // Per-article timeout: destroy the connection if the server stalls mid-transfer
    const fetchTimer = setTimeout(() => conn.destroy(), 120_000)
    try {
      conn.send(`BODY <${messageId}>`)
      const resp = await conn.readLine()
      if (!resp.startsWith('222')) throw new NntpError(`NNTP BODY failed: ${resp}`)
      const body = await conn.readMultilineBody()
      clearTimeout(fetchTimer)
      this.release(conn)
      return body
    } catch (err) {
      clearTimeout(fetchTimer)
      conn.destroy()
      this.active--
      throw err
    }
  }
}

let _pool: NntpPool | null = null

export function getNntpPool(): NntpPool {
  if (!_pool) _pool = new NntpPool()
  return _pool
}
