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

// ── Final wave, commit 2: the addon's meta lookup must not follow the setting ──
//
// stremioSearchSource is admin-selectable and 'addon' repoints metadata lookups at
// the configured stream providers. aiostreams serves streams, not metas, so the
// lookup returns null, the parental gate fails closed, and every rating-limited
// account loses the addon on both routes. The gate's lookup is pinned to Cinemeta
// instead of inheriting a stream-provider setting.

test('the addon meta lookup targets Cinemeta even when the search source is addon', async () => {
  const { config } = await import('../src/config.js')
  const { fetchCinemetaMeta } = await import('../src/sootio.js')
  const requested: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input))
    return new Response(JSON.stringify({ meta: { id: 'tt0111161', type: 'movie', name: 'Shawshank' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  const previousSource = config.stremioSearchSource
  const previousProviders = config.streamProviderUrls
  try {
    // The misconfiguration the finding describes.
    ;(config as { stremioSearchSource: string }).stremioSearchSource = 'addon'
    ;(config as { streamProviderUrls: string[] }).streamProviderUrls = ['https://aiostreams.example.test']

    const meta = await fetchCinemetaMeta('movie', 'tt0111161')
    assert.equal(meta?.id, 'tt0111161', 'the pinned lookup must still resolve')
    assert.equal(requested.length, 1)
    assert.match(requested[0], /^https:\/\/v3-cinemeta\.strem\.io\//)
    assert.ok(!requested.some(url => url.includes('aiostreams')), `a stream provider was queried: ${requested.join(', ')}`)
  } finally {
    ;(config as { stremioSearchSource: string }).stremioSearchSource = previousSource
    ;(config as { streamProviderUrls: string[] }).streamProviderUrls = previousProviders
    globalThis.fetch = realFetch
  }
})
