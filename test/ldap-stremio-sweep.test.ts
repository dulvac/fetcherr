import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-ldap-sweep-${randomUUID()}.db`)
const db = await import('../src/db.js')
const { sweepStremioAccess, stremioSweepConfigured, usernameFromMemberDn } = await import('../src/ldap-stremio-sweep.js')

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
