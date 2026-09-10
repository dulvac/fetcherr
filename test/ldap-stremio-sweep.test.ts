import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-ldap-sweep-${randomUUID()}.db`)
const db = await import('../src/db.js')
const { createStremioAccessSweepRunner, sweepStremioAccess, stremioSweepConfigured, usernameFromMemberDn } = await import('../src/ldap-stremio-sweep.js')

function ldapUser(username: string) {
  const user = db.createUser(username, 'pw', 'user', 'unrestricted', undefined, 'ldap')
  db.setStremioEnabled(user.id, true)
  return user
}

const ingroup = ldapUser('ingroup')
const outgroup = ldapUser('outgroup')
const mixedCase = ldapUser('MixedCase')
const localUser = db.createUser('localuser', 'pw', 'user', 'unrestricted')
db.setStremioEnabled(localUser.id, true)
const alreadyOff = db.createUser('alreadyoff', 'pw', 'user', 'unrestricted', undefined, 'ldap')

const enabled = (username: string) => db.getUserByUsername(username)!.stremioEnabled
const allEnabledLdapUsernames = () =>
  db.listUsers().filter(user => user.authSource === 'ldap' && user.stremioEnabled).map(user => user.username)
const everyone = ['ingroup', 'MixedCase']

// Inert unless configured: no LDAP_BIND_DN, LDAP_BIND_PASSWORD or LDAP_GROUP_DN is
// set in this process, and nothing about fetcherr changes for anyone who leaves
// them unset.
test('the sweep is off unless all three variables are set', () => {
  assert.equal(stremioSweepConfigured(), false)
})

test('an LDAP account outside media-users loses Stremio access', async () => {
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => everyone })
  assert.deepEqual(result.disabled, ['outgroup'])
  assert.equal(enabled('ingroup'), true)
  assert.equal(enabled('outgroup'), false)
})

test('username comparison is case-insensitive, since usernames are COLLATE NOCASE', async () => {
  // The group lists MixedCase; the row is MixedCase; a lowercase listing must
  // still match, and vice versa.
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => ['INGROUP', 'mixedcase'] })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('ingroup'), true)
  assert.equal(enabled('MixedCase'), true)
})

test('local accounts are never touched by the sweep', async () => {
  // localuser is not in the group listing and never will be, since the group only
  // knows about LDAP accounts. It must keep access anyway.
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => everyone })
  assert.ok(!result.disabled.includes('localuser'))
  assert.equal(enabled('localuser'), true)
  // And with a listing that is treated as a failure, still nothing.
  await sweepStremioAccess({ membersOfMediaUsers: async () => [] })
  assert.equal(enabled('localuser'), true)
})

// The single most important behaviour here: a lookup that cannot be trusted must
// revoke nobody. Revoking everyone at once is a self-inflicted household outage.
test('a throwing lookup changes nothing', async () => {
  const before = enabled('ingroup')
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => { throw new Error('ldap down') } })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('ingroup'), before)
  assert.equal(enabled('MixedCase'), true)
})

test('an empty member list is treated as a failure, not as nobody', async () => {
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => [] })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('ingroup'), true)
  assert.equal(enabled('MixedCase'), true)
  assert.equal(enabled('localuser'), true)
})

test('a member list of only unusable entries is also treated as a failure', async () => {
  // What a missing group entry or a wrong attribute name looks like by the time
  // it reaches the sweep: entries that yield no username at all.
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => ['', '   '] })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('ingroup'), true)
})

test('an account already disabled stays disabled and is not reported as newly revoked', async () => {
  assert.equal(enabled('alreadyoff'), false)
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => everyone })
  assert.ok(!result.disabled.includes('alreadyoff'), 'must not report an account it did not change')
  assert.equal(enabled('alreadyoff'), false)
})

test('the sweep never re-enables an account the group still lists', async () => {
  // An admin may have deliberately revoked someone who is still in media-users.
  // Re-granting is a human action.
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => [...everyone, 'alreadyoff', 'outgroup'] })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('alreadyoff'), false)
  assert.equal(enabled('outgroup'), false)
})

test('a username is read from the leading cn of a member DN', () => {
  assert.equal(usernameFromMemberDn('cn=andrei,ou=users,dc=ldap,dc=goauthentik,dc=io'), 'andrei')
  assert.equal(usernameFromMemberDn('CN=Andrei,OU=users,DC=io'), 'Andrei')
  assert.equal(usernameFromMemberDn('uid=andrei,ou=users,dc=io'), '')
  assert.equal(usernameFromMemberDn(''), '')
  assert.equal(usernameFromMemberDn('ou=users,dc=io'), '')
})

test('RFC 4514 escaping in a member DN is undone', () => {
  // escapeDnValue in src/ldap-auth.ts is the escaping this codebase produces.
  assert.equal(usernameFromMemberDn('cn=last\\, first,ou=users,dc=io'), 'last, first')
  assert.equal(usernameFromMemberDn('cn=a\\+b,ou=users,dc=io'), 'a+b')
  assert.equal(usernameFromMemberDn('cn=a\\\\b,ou=users,dc=io'), 'a\\b')
  assert.equal(usernameFromMemberDn('cn=a\\3Db,ou=users,dc=io'), 'a=b')
  assert.equal(usernameFromMemberDn('cn=\\20spaced\\20,ou=users,dc=io'), 'spaced')
  assert.equal(usernameFromMemberDn('cn=a\\22b,ou=users,dc=io'), 'a"b')
})

test('an escaped comma does not split the DN early', async () => {
  const awkward = db.createUser('last, first', 'pw', 'user', 'unrestricted', undefined, 'ldap')
  db.setStremioEnabled(awkward.id, true)
  const result = await sweepStremioAccess({
    membersOfMediaUsers: async () => [...everyone, usernameFromMemberDn('cn=last\\, first,ou=users,dc=io')],
  })
  assert.deepEqual(result.disabled, [])
  assert.equal(enabled('last, first'), true)
})

// ── Fix round 1, commit 1: a lookup failure must be audible ─────────────────
//
// sweepStremioAccess swallowed the throw and returned no disabled accounts, so
// the runner's catch never fired and disabled.length was zero: nothing was
// logged. Wrong bind credentials, a renamed group, a firewall change or an
// expired service account all produced an hourly silent no-op while the
// household kept streaming after being removed from media-users.

function stubLogger() {
  const info: string[] = []
  const warn: string[] = []
  return { log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) }, info, warn }
}

test('a throwing lookup reports a reason and still writes nothing', async () => {
  const before = enabled('ingroup')
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => { throw new Error('ldap down') } })
  assert.deepEqual(result.disabled, [])
  assert.ok(result.failed, 'the result must carry a failure reason')
  assert.match(result.failed!, /ldap down/)
  assert.equal(enabled('ingroup'), before)
})

test('an empty listing reports a reason too, since it is treated as a failure', async () => {
  const result = await sweepStremioAccess({ membersOfMediaUsers: async () => [] })
  assert.deepEqual(result.disabled, [])
  assert.ok(result.failed, 'an empty listing is a failure and must say so')
})

test('the runner emits exactly one warning for a failed lookup', async () => {
  const { log, info, warn } = stubLogger()
  const run = createStremioAccessSweepRunner(log, { membersOfMediaUsers: async () => { throw new Error('ECONNREFUSED 127.0.0.1:1') } })
  await run()
  assert.equal(warn.length, 1, `expected one warning, got ${warn.length}: ${warn.join(' | ')}`)
  assert.match(warn[0], /ECONNREFUSED/)
  assert.match(warn[0], /nothing changed/i)
  assert.equal(info.length, 0)
})

test('the runner says nothing on a clean pass', async () => {
  const { log, warn } = stubLogger()
  // Derived from the database rather than a constant, so an account added by an
  // earlier test cannot make a "clean" pass revoke something.
  const run = createStremioAccessSweepRunner(log, { membersOfMediaUsers: async () => allEnabledLdapUsernames() })
  await run()
  await run()
  assert.deepEqual(warn, [])
})

test('the runner warns once, naming the accounts, when it revokes', async () => {
  const victim = db.createUser('revokeme', 'pw', 'user', 'unrestricted', undefined, 'ldap')
  db.setStremioEnabled(victim.id, true)
  const keep = allEnabledLdapUsernames().filter(name => name !== 'revokeme')
  const { log, warn } = stubLogger()
  const run = createStremioAccessSweepRunner(log, { membersOfMediaUsers: async () => keep })
  await run()
  assert.equal(warn.length, 1, warn.join(' | '))
  assert.match(warn[0], /revokeme/)
  assert.equal(enabled('revokeme'), false)
})
