import { randomBytes } from 'crypto'
import { Client, InvalidCredentialsError } from 'ldapts'
import {
  createUser,
  getUserByUsername,
  verifyUserCredentials,
  type AppUser,
  type AppUserRole,
} from './db.js'

// Optional LDAP bind authentication (e.g. against an Authentik LDAP outpost).
// When LDAP_URL and LDAP_USER_DN are set, logins try an LDAP bind first and
// fall back to local accounts, so a local admin always keeps working.
//   LDAP_URL          ldap://host:389 or ldaps://host:636
//   LDAP_USER_DN      DN template, e.g. cn={username},ou=users,dc=ldap,dc=goauthentik,dc=io
//   LDAP_DEFAULT_ROLE role for auto-provisioned users: user (default) or kids

const LDAP_URL = process.env.LDAP_URL ?? ''
const LDAP_USER_DN = process.env.LDAP_USER_DN ?? ''
const LDAP_DEFAULT_ROLE: AppUserRole =
  process.env.LDAP_DEFAULT_ROLE === 'kids' ? 'kids' : 'user'

// Both halves of a bind are capped, so a directory that accepts connections and
// then goes quiet costs a login attempt at most 2 x this. Kept deliberately
// short: every login that is not a known local account waits for it.
const LDAP_TIMEOUT_MS = 2000

export function ldapEnabled(): boolean {
  return Boolean(LDAP_URL && LDAP_USER_DN.includes('{username}'))
}

// Escape RFC 4514 special characters plus NUL in a DN attribute value.
// Leading/trailing spaces need no handling here: authenticateUser trims the
// username before it reaches the DN template.
function escapeDnValue(value: string): string {
  return value
    .replace(/([\\,+"<>;=#])/g, '\\$1')
    .replace(/\0/g, '\\00')
}

async function ldapBind(username: string, password: string): Promise<boolean> {
  if (!password) return false // empty password = unauthenticated bind, always refuse
  const client = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_TIMEOUT_MS })
  try {
    // Replacer function so `$` sequences in usernames are inserted literally
    // instead of being expanded as replacement patterns.
    await client.bind(LDAP_USER_DN.replace('{username}', () => escapeDnValue(username)), password)
    return true
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      console.log(`ldap: bind rejected for "${username}" (invalid credentials)`)
    } else {
      console.warn(`ldap: bind failed for "${username}": ${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  } finally {
    try { await client.unbind() } catch { /* ignore */ }
  }
}

export async function authenticateUser(username: string, password: string): Promise<AppUser | null> {
  const name = username.trim()
  if (!name) return null
  if (!ldapEnabled()) return verifyUserCredentials(name, password)

  // A username that already belongs to a local account is a local credential and
  // nothing else. Falling through to a bind here would let any directory entry
  // that happens to share the string sign in as that account and inherit its
  // role, so a local admin could be taken over by whoever controls a directory
  // entry of the same name. Two identities that share a string stay separate;
  // tying one to the directory has to be a deliberate admin act.
  const existing = getUserByUsername(name)
  if (existing?.authSource === 'local') {
    const local = verifyUserCredentials(name, password)
    // Says why in the one case an admin will ask about: a directory user whose
    // name collides with a local account, wondering why their password fails.
    if (!local) console.log(`ldap: "${name}" is a local account, so the directory was not consulted`)
    return local
  }

  if (await ldapBind(name, password)) {
    if (existing) return existing
    // Auto-provision with a random local password; these accounts authenticate
    // through the directory only, so the local hash is never a usable credential.
    return createUser(name, randomBytes(24).toString('hex'), LDAP_DEFAULT_ROLE, '', undefined, 'ldap')
  }
  // Nothing is left to try: a local username returned above, an LDAP-provisioned
  // account has no password of its own, and an unknown username has nothing to
  // check against.
  return null
}
