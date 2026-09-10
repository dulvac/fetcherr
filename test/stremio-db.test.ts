import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-stremio-${randomUUID()}.db`)
const db = await import('../src/db.js')

const user = db.createUser('friend', 'pw', 'user', 'unrestricted')

test('a fresh user has no token and no access', () => {
  assert.equal(user.stremioToken, '')
  assert.equal(user.stremioEnabled, false)
  assert.equal(user.stremioPlayCap, 30)
})

test('minting returns a base64url token that resolves back to the user', () => {
  const token = db.mintStremioToken(user.id)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(db.getUserByStremioToken(token)?.id, user.id)
})

test('rotating invalidates the previous token', () => {
  const first = db.mintStremioToken(user.id)
  const second = db.mintStremioToken(user.id)
  assert.notEqual(first, second)
  assert.equal(db.getUserByStremioToken(first), null)
  assert.equal(db.getUserByStremioToken(second)?.id, user.id)
})

test('clearing removes the token without deleting the user', () => {
  const token = db.mintStremioToken(user.id)
  db.clearStremioToken(user.id)
  assert.equal(db.getUserByStremioToken(token), null)
  assert.equal(db.getUserById(user.id)?.stremioToken, '')
})

test('an empty token never resolves to a user', () => {
  assert.equal(db.getUserByStremioToken(''), null)
})

test('two users with no token do not collide', () => {
  const other = db.createUser('friend2', 'pw', 'user', 'unrestricted')
  assert.equal(other.stremioToken, '')
  assert.equal(db.getUserById(user.id)?.stremioToken, '')
})

test('enabled and cap round-trip', () => {
  db.setStremioEnabled(user.id, true)
  db.setStremioPlayCap(user.id, 5)
  const fresh = db.getUserById(user.id)!
  assert.equal(fresh.stremioEnabled, true)
  assert.equal(fresh.stremioPlayCap, 5)
})

test('plays are counted per user per day', () => {
  assert.equal(db.countStremioPlaysToday(user.id), 0)
  db.recordStremioPlay({ userId: user.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'b'.repeat(40), title: 'Shawshank 1080p' })
  db.recordStremioPlay({ userId: user.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'b'.repeat(40), title: 'Shawshank 1080p' })
  assert.equal(db.countStremioPlaysToday(user.id), 2)
  const other = db.getUserByUsername('friend2')!
  assert.equal(db.countStremioPlaysToday(other.id), 0)
})

// Reserving counts the slot in the same statement that checks the cap, so a
// burst cannot read the count before the first write lands.

test('reserving stops at the cap and returns null', () => {
  const u = db.createUser('reserver', 'pw', 'user', 'unrestricted')
  const play = { userId: u.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'c'.repeat(40), cap: 2 }
  assert.notEqual(db.reserveStremioPlay(play), null)
  assert.notEqual(db.reserveStremioPlay(play), null)
  assert.equal(db.reserveStremioPlay(play), null)
  assert.equal(db.countStremioPlaysToday(u.id), 2)
})

test('a released reservation frees the slot again', () => {
  const u = db.createUser('releaser', 'pw', 'user', 'unrestricted')
  const play = { userId: u.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'd'.repeat(40), cap: 1 }
  const id = db.reserveStremioPlay(play)
  assert.notEqual(id, null)
  assert.equal(db.reserveStremioPlay(play), null)
  db.releaseStremioPlay(id!)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
  assert.notEqual(db.reserveStremioPlay(play), null)
})

test('finalizing sets the title on the reserved row', () => {
  const u = db.createUser('finalizer', 'pw', 'user', 'unrestricted')
  const id = db.reserveStremioPlay({ userId: u.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'e'.repeat(40), cap: 5 })
  db.finalizeStremioPlay(id!, 'Shawshank.1080p.mkv')
  const row = db.getDb().prepare(`SELECT title FROM stremio_plays WHERE id = ?`).get(id) as { title: string }
  assert.equal(row.title, 'Shawshank.1080p.mkv')
})

test('a cap of zero refuses every reservation', () => {
  const u = db.createUser('zero-cap', 'pw', 'user', 'unrestricted')
  assert.equal(db.reserveStremioPlay({ userId: u.id, mediaType: 'movie', externalId: 'tt0111161', infoHash: 'f'.repeat(40), cap: 0 }), null)
  assert.equal(db.countStremioPlaysToday(u.id), 0)
})
