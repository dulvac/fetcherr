import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// A directory that completes the TCP handshake and then never answers, which is
// what a hung or half-dead LDAP server looks like from the client side. Every
// bind against it therefore costs the full operation timeout, which is what
// makes the timings below meaningful.
const blackHole: Server = createServer(() => { /* accept, never reply */ })
await new Promise<void>(resolve => blackHole.listen(0, '127.0.0.1', resolve))
const port = (blackHole.address() as { port: number }).port

const databasePath = join(tmpdir(), `fetcherr-ldap-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.LDAP_URL = `ldap://127.0.0.1:${port}`
process.env.LDAP_USER_DN = 'cn={username},ou=users,dc=example,dc=com'

// Imported after the environment is set: both modules read it at load time.
const db = await import('../src/db.js')
const { authenticateUser, ldapEnabled } = await import('../src/ldap-auth.js')

const local = db.createUser('localadmin', 'localpw', 'admin', 'unrestricted')
const provisioned = db.createUser('diruser', 'random-hash-nobody-knows', 'user', 'unrestricted', undefined, 'ldap')

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - started }
}

test('the fixture really is enabled, or nothing below tests LDAP at all', () => {
  assert.equal(ldapEnabled(), true)
})

test('a local account logs in without waiting for the directory', async () => {
  const { value, ms } = await timed(() => authenticateUser('localadmin', 'localpw'))
  assert.equal(value?.id, local.id)
  // Bind-first would have paid the full timeout against the black hole here.
  assert.ok(ms < 500, `expected no directory round trip, took ${ms}ms`)
})

test('a wrong password on a local account still reaches the directory', async () => {
  const { value, ms } = await timed(() => authenticateUser('localadmin', 'wrongpw'))
  assert.equal(value, null)
  assert.ok(ms >= 1500, `expected a bind attempt, took only ${ms}ms`)
  assert.ok(ms < 4000, `expected the 2s cap, took ${ms}ms`)
})

test('an unknown username is capped by the bind timeout', async () => {
  const { value, ms } = await timed(() => authenticateUser('nobody', 'whatever'))
  assert.equal(value, null)
  assert.ok(ms >= 1500, `expected a bind attempt, took only ${ms}ms`)
  assert.ok(ms < 4000, `expected the 2s cap, took ${ms}ms`)
})

test('an LDAP-provisioned account is not authenticated by its local hash', async () => {
  // The stored hash is of this exact string, so a local-first check would let it
  // in and hand out a credential the directory never issued.
  const { value } = await timed(() => authenticateUser('diruser', 'random-hash-nobody-knows'))
  assert.equal(value, null)
  assert.equal(db.getUserById(provisioned.id)?.authSource, 'ldap')
})

test('an empty password is refused before any bind', async () => {
  const { value, ms } = await timed(() => authenticateUser('localadmin', ''))
  assert.equal(value, null)
  assert.ok(ms < 500, `expected no directory round trip, took ${ms}ms`)
})

test.after(() => {
  blackHole.close()
  db.getDb().close()
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
})
