import type { FastifyInstance } from 'fastify'
import { Client } from 'ldapts'
import { listUsers, setStremioEnabled } from './db.js'
import { ldapEnabled } from './ldap-auth.js'

// Fork-only. Nothing in src/stremio-addon.ts, src/db.ts or src/ui/* may import
// this module, and the addon endpoint does not need it to work: the endpoint is
// going upstream as its own PR and this is not.
//
// Why it exists: a Stremio install URL is a bearer credential checked against
// fetcherr's own row, so disabling someone in Authentik does not stop them
// streaming. Without this sweep, revocation depends on an admin remembering to
// press Revoke in Settings.
//
// Configuration, all three required and inert when unset:
//   LDAP_BIND_DN        service account DN to bind as for the group read,
//                       e.g. cn=ldap-bind,ou=users,dc=ldap,dc=goauthentik,dc=io
//   LDAP_BIND_PASSWORD  that account's password
//   LDAP_GROUP_DN       the group whose members keep access, e.g.
//                       cn=media-users,ou=groups,dc=ldap,dc=goauthentik,dc=io
//
// Unset means the sweep never starts and fetcherr behaves exactly as it does
// today. It is never a hard failure.

const LDAP_URL = process.env.LDAP_URL ?? ''
const LDAP_BIND_DN = process.env.LDAP_BIND_DN ?? ''
const LDAP_BIND_PASSWORD = process.env.LDAP_BIND_PASSWORD ?? ''
const LDAP_GROUP_DN = process.env.LDAP_GROUP_DN ?? ''

const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const LDAP_TIMEOUT_MS = 10_000

export function stremioSweepConfigured(): boolean {
  return Boolean(ldapEnabled() && LDAP_BIND_DN && LDAP_BIND_PASSWORD && LDAP_GROUP_DN)
}

// Undo RFC 4514 escaping: \XX hex pairs and \<char>. escapeDnValue in
// src/ldap-auth.ts produces the form this reverses.
function unescapeDnValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      out += value[i]
      continue
    }
    const hex = value.slice(i + 1, i + 3)
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 2
      continue
    }
    if (i + 1 < value.length) {
      out += value[i + 1]
      i += 1
    }
  }
  return out
}

// Split off the first RDN, honouring escaped commas so cn=last\, first stays one
// component.
function firstRdn(dn: string): string {
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\') {
      i += 1
      continue
    }
    if (dn[i] === ',') return dn.slice(0, i)
  }
  return dn
}

// The Authentik LDAP outpost exposes group membership as the group entry's
// `member` attribute, holding member DNs. The username is the leading cn=
// component. Anything else, including a uid= form, is not something this
// deployment issues, so it yields no username rather than a guess.
export function usernameFromMemberDn(dn: string): string {
  const rdn = firstRdn(String(dn ?? '').trim())
  const match = /^cn=/i.exec(rdn)
  if (!match) return ''
  return unescapeDnValue(rdn.slice(match[0].length)).trim()
}

// Reads the group's members with the service account. Throws on anything it
// cannot trust, including a missing group entry, because the caller treats a
// throw as "change nothing".
export async function listMediaUsersFromLdap(): Promise<string[]> {
  const client = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_TIMEOUT_MS })
  try {
    await client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD)
    const { searchEntries } = await client.search(LDAP_GROUP_DN, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    })
    const entry = searchEntries[0]
    if (!entry) throw new Error(`group entry not found: ${LDAP_GROUP_DN}`)
    const raw = entry.member
    const members = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
    return members
      .map(value => usernameFromMemberDn(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)))
      .filter(Boolean)
  } finally {
    try { await client.unbind() } catch { /* ignore */ }
  }
}

export interface StremioSweepResult {
  disabled: string[]
  // Set when the listing could not be trusted, so nothing was written. The
  // runner logs this: without it a failure is a silent hourly no-op while the
  // household keeps streaming after being removed from the group.
  failed?: string
  // Set when the circuit breaker refused a pass that would have revoked every
  // enabled LDAP account at once.
  blocked?: string
}

// A pass that would disable every enabled LDAP account is refused. That is the
// measured catastrophic pattern: a group of display names, uid=-form member DNs,
// or simply the wrong group DN, all parse into usable names that match nobody and
// would take the whole household off the addon at once, from a timer, with no
// user action to correlate against. "All of them" rather than a tunable fraction,
// because it needs no threshold to justify. Two is the floor, so revoking a lone
// account still works.
const MASS_REVOCATION_FLOOR = 2

type SweepLogger = { info: (message: string) => void; warn: (message: string) => void }

export async function sweepStremioAccess(
  deps: { membersOfMediaUsers: () => Promise<string[]> },
): Promise<StremioSweepResult> {
  let members: string[]
  try {
    members = await deps.membersOfMediaUsers()
  } catch (err) {
    // An unreadable group revokes nobody. A bind failure, a timeout, a missing
    // entry or a renamed attribute would otherwise revoke every LDAP account at
    // once, which is a self-inflicted outage for the whole household.
    return { disabled: [], failed: `group lookup failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const allowed = new Set(
    members.map(name => String(name ?? '').trim().toLowerCase()).filter(Boolean),
  )
  // Empty is indistinguishable from a search that silently matched nothing, so
  // it is treated as a failure rather than as "the group has no members".
  if (!allowed.size) {
    return { disabled: [], failed: `group listing produced no usable usernames (${members.length} raw ${members.length === 1 ? 'entry' : 'entries'})` }
  }

  // Nothing is written until the whole population has been examined, so the
  // breaker below can refuse the pass without having to undo anything.
  const enabledLdap = listUsers().filter(user =>
    // Local accounts are never touched, whatever the group says.
    user.authSource === 'ldap'
    // Only ever disables: an admin may have deliberately revoked someone who is
    // still in the group, and re-granting is a human action. Skipping accounts
    // that are already off also keeps them out of the revoked list.
    && user.stremioEnabled)
  const toDisable = enabledLdap.filter(user => !allowed.has(user.username.toLowerCase()))

  if (toDisable.length === enabledLdap.length && enabledLdap.length >= MASS_REVOCATION_FLOOR) {
    return {
      disabled: [],
      blocked: `refusing to revoke every enabled LDAP account at once: ${allowed.size} member${allowed.size === 1 ? '' : 's'} listed in ${LDAP_GROUP_DN} matched none of the ${enabledLdap.length} enabled accounts`,
    }
  }

  const disabled: string[] = []
  for (const user of toDisable) {
    setStremioEnabled(user.id, false)
    disabled.push(user.username)
  }
  return { disabled }
}

// Quiet on a clean pass: an hourly timer that logs every time trains people to
// ignore it. Only a revocation or a failed lookup says anything. Exported so the
// logging itself is testable without an LDAP server.
export function createStremioAccessSweepRunner(
  log: SweepLogger,
  deps: { membersOfMediaUsers: () => Promise<string[]> },
): () => Promise<void> {
  return async () => {
    try {
      const { disabled, failed, blocked } = await sweepStremioAccess(deps)
      if (failed) {
        log.warn(`stremio: LDAP access sweep failed, nothing changed: ${failed}`)
        return
      }
      if (blocked) {
        log.warn(`stremio: LDAP access sweep ${blocked}. Nothing changed; check LDAP_GROUP_DN and the group's member DNs.`)
        return
      }
      if (disabled.length) {
        log.warn(`stremio: revoked access for ${disabled.join(', ')} (no longer in ${LDAP_GROUP_DN})`)
      }
    } catch (err) {
      // sweepStremioAccess reports rather than throws, so this is only for a
      // defect in the sweep itself. Still logged, never silent.
      log.warn(`stremio: LDAP access sweep errored, nothing changed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function startStremioAccessSweep(app: FastifyInstance): void {
  if (!stremioSweepConfigured()) {
    const missing = [
      ...(ldapEnabled() ? [] : ['LDAP_URL/LDAP_USER_DN']),
      ...(LDAP_BIND_DN ? [] : ['LDAP_BIND_DN']),
      ...(LDAP_BIND_PASSWORD ? [] : ['LDAP_BIND_PASSWORD']),
      ...(LDAP_GROUP_DN ? [] : ['LDAP_GROUP_DN']),
    ]
    app.log.info(`stremio: LDAP access sweep off, not configured (${missing.join(', ')})`)
    return
  }

  const run = createStremioAccessSweepRunner(app.log, { membersOfMediaUsers: listMediaUsersFromLdap })

  app.log.info(`stremio: LDAP access sweep on, hourly against ${LDAP_GROUP_DN}`)
  void run()
  // unref so an hourly timer cannot hold the process open.
  setInterval(() => { void run() }, SWEEP_INTERVAL_MS).unref()
}
