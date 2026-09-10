import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StremioMeta } from '../src/sootio.js'
import type { AppUser } from '../src/db.js'

// No network, and no touching the real database. src/config.ts reads both of
// these once at module load, so they have to be set before the module under
// test is imported, which is why the import below is dynamic: static imports
// are hoisted above these assignments and would read the real environment.
// Without a TMDB key the rating lookup returns early instead of making a
// request, so the rating resolves to '' — the production behaviour for a
// rating that cannot be established.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-rating-${randomUUID()}.db`)

const { canUserAccessStremioMeta } = await import('../src/stremio-rating.js')

const meta = { id: 'tt0111161', name: 'Shawshank', releaseInfo: '1994' } as StremioMeta

const base: AppUser = {
  id: 'u1', username: 'kid', passwordHash: '', role: 'kids', maxRating: '1',
  searchEnabled: false, authSource: 'local', stremioToken: '', stremioEnabled: true,
  stremioPlayCap: 30, createdAt: '', updatedAt: '',
}

test('an unrestricted account is always allowed', async () => {
  const adult = { ...base, role: 'user' as const, maxRating: 'unrestricted' }
  assert.equal(await canUserAccessStremioMeta(adult, meta, 'movie'), true)
})

test('a kids account is refused a title whose rating cannot be established', async () => {
  assert.equal(await canUserAccessStremioMeta(base, meta, 'movie'), false)
})
