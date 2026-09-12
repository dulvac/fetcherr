import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// A stand-in directory with three behaviours, all of which a real one has:
//   hang    accepts the connection and never answers, so a bind costs the full
//           operation timeout. This is what a half-dead server looks like.
//   accept  answers every bind with success, i.e. the caller holds valid
//           credentials for whatever entry the DN named.
//   reject  answers every bind with invalidCredentials.
// Nothing here is mocked at the module boundary: ldapts really connects, really
// speaks LDAP, and the timings below are real.
type DirectoryMode = 'hang' | 'accept' | 'reject'
let mode: DirectoryMode = 'hang'

const RESULT_SUCCESS = 0x00
const RESULT_INVALID_CREDENTIALS = 0x31

// LDAPMessage ::= SEQUENCE { messageID INTEGER, BindResponse [APPLICATION 1] }
// BindResponse ::= SEQUENCE { resultCode ENUMERATED, matchedDN "", diagnostic "" }
function bindResponse(messageId: number, resultCode: number): Buffer {
  return Buffer.from([
    0x30, 0x0c,
    0x02, 0x01, messageId,
    0x61, 0x07,
    0x0a, 0x01, resultCode,
    0x04, 0x00,
    0x04, 0x00,
  ])
}

const directory: Server = createServer((socket: Socket) => {
  socket.on('error', () => { /* the client hangs up when a bind times out */ })
  socket.on('data', data => {
    if (mode === 'hang') return
    // messageID is bytes 2..4, then the protocolOp tag: 0x60 is BindRequest.
    const isBind = data[2] === 0x02 && data[3] === 0x01 && data[5] === 0x60
    if (!isBind) return
    socket.write(bindResponse(data[4], mode === 'accept' ? RESULT_SUCCESS : RESULT_INVALID_CREDENTIALS))
  })
})
await new Promise<void>(resolve => directory.listen(0, '127.0.0.1', resolve))
const port = (directory.address() as { port: number }).port

const databasePath = join(tmpdir(), `fetcherr-ldap-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.LDAP_URL = `ldap://127.0.0.1:${port}`
process.env.LDAP_USER_DN = 'cn={username},ou=users,dc=example,dc=com'

// Imported after the environment is set: both modules read it at load time.
const db = await import('../src/db.js')
const { authenticateUser, ldapEnabled } = await import('../src/ldap-auth.js')

const localAdmin = db.createUser('admin', 'localpw', 'admin', 'unrestricted')
const provisioned = db.createUser('diruser', 'random-hash-nobody-knows', 'user', 'unrestricted', undefined, 'ldap')

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - started }
}

test('the fixture really is enabled, or nothing below tests LDAP at all', () => {
  assert.equal(ldapEnabled(), true)
})

test('the stand-in directory really does accept binds', async () => {
  // Guards every "refused" assertion below: if accept mode did not work, those
  // tests would pass for the wrong reason.
  mode = 'accept'
  const { value } = await timed(() => authenticateUser('newcomer', 'anything'))
  assert.equal(value?.username, 'newcomer')
  assert.equal(value?.authSource, 'ldap')
  assert.equal(value?.role, 'user')
})

test('a directory identity cannot sign in as a local account of the same name', async () => {
  // The attacker holds valid credentials for cn=admin in the directory, which is
  // a different identity that merely shares the string. Handing over the local
  // account would hand over its admin role with it.
  mode = 'accept'
  const { value } = await timed(() => authenticateUser('admin', 'valid-in-the-directory'))
  assert.equal(value, null)
  assert.equal(db.getUserById(localAdmin.id)?.authSource, 'local')
})

test('a local account still logs in with its own password', async () => {
  mode = 'accept'
  const { value } = await timed(() => authenticateUser('admin', 'localpw'))
  assert.equal(value?.id, localAdmin.id)
  assert.equal(value?.role, 'admin')
})

test('an LDAP-provisioned account logs in through the directory', async () => {
  mode = 'accept'
  const { value } = await timed(() => authenticateUser('diruser', 'whatever-the-directory-accepts'))
  assert.equal(value?.id, provisioned.id)
})

test('an LDAP-provisioned account is not authenticated by its local hash', async () => {
  // The stored hash is of this exact string, so a local check anywhere in this
  // path would admit a credential the directory never issued.
  mode = 'reject'
  const { value } = await timed(() => authenticateUser('diruser', 'random-hash-nobody-knows'))
  assert.equal(value, null)
})

test('a rejected bind creates no account', async () => {
  mode = 'reject'
  const { value } = await timed(() => authenticateUser('stranger', 'wrong'))
  assert.equal(value, null)
  assert.equal(db.getUserByUsername('stranger'), null)
})

test('a local account never waits for the directory', async () => {
  mode = 'hang'
  const right = await timed(() => authenticateUser('admin', 'localpw'))
  assert.equal(right.value?.id, localAdmin.id)
  assert.ok(right.ms < 500, `expected no directory round trip, took ${right.ms}ms`)
  // A wrong password must not fall through to a bind either, or an outage would
  // stall exactly the login that break-glass access depends on.
  const wrong = await timed(() => authenticateUser('admin', 'wrongpw'))
  assert.equal(wrong.value, null)
  assert.ok(wrong.ms < 500, `expected no directory round trip, took ${wrong.ms}ms`)
})

test('a login that does need the directory is capped at the bind timeout', async () => {
  mode = 'hang'
  const { value, ms } = await timed(() => authenticateUser('nobody', 'whatever'))
  assert.equal(value, null)
  assert.ok(ms >= 1500, `expected a bind attempt, took only ${ms}ms`)
  assert.ok(ms < 4000, `expected the 2s cap, took ${ms}ms`)
})

test('an empty password is refused before any bind', async () => {
  mode = 'hang'
  const { value, ms } = await timed(() => authenticateUser('nobody', ''))
  assert.equal(value, null)
  assert.ok(ms < 500, `expected no directory round trip, took ${ms}ms`)
})

test.after(() => {
  directory.close()
  db.getDb().close()
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
})
