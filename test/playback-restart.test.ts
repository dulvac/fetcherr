import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// src/config.ts reads these once at module load, so they must be set before
// the dynamic imports below — a static import would be hoisted above them.
const databasePath = join(tmpdir(), `fetcherr-playback-restart-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''

const db = await import('../src/db.js')
const { jellyfinRoutes, resolveJellyfinUser } = await import('../src/jellyfin/index.js')

const TICKS_PER_SEC = 10_000_000
const TICKS_PER_MIN = 60 * TICKS_PER_SEC
const OLD_POSITION_TICKS = 17 * TICKS_PER_MIN

// jellyfin_tokens is created lazily on first use inside src/jellyfin/index.ts;
// this lookup (which misses) is what creates it, before the raw inserts below.
resolveJellyfinUser({ 'x-emby-token': 'no-such-token' })

function authedUser(username: string) {
  const user = db.createUser(username, 'pw', 'user', 'unrestricted')
  const token = randomUUID()
  db.getDb()
    .prepare(`INSERT INTO jellyfin_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, user.id, Date.now() + 24 * 3_600_000)
  return { user, token }
}

async function buildApp() {
  const app = Fastify()
  await app.register(jellyfinRoutes, {} as never)
  return app
}

// A fresh library movie per test, so saved positions and resume membership
// from one test can't leak into another. Mirrors the item id jellyfin/index.ts
// derives for a movie: a v4-shaped uuid carrying the tmdb id in its low bits.
let nextTmdbId = 5_010_001
function makeMovieItemId(): string {
  const tmdbId = nextTmdbId++
  db.upsertMovie({
    tmdbId,
    imdbId: `tt${tmdbId}`,
    mediaLanguage: 'en',
    title: `Restart Test Movie ${tmdbId}`,
    year: 2021,
    overview: '',
    posterPath: '',
    backdropPath: '',
    logoPath: '',
    genres: '[]',
    runtimeMins: 100,
    popularity: 0,
    officialRating: '',
    communityRating: 0,
    studiosJson: '[]',
    tagsJson: '[]',
    castJson: '[]',
    releaseDate: '2021-01-01',
    digitalReleaseDate: '2021-01-01',
    syncedAt: new Date().toISOString(),
  })
  // handleItem's plain-movie branch 404s without a source item on file (the
  // sign a title is actually in the library, not just cached TMDB meta).
  db.addSourceItem('playback-restart-test', 'movie', tmdbId)
  return `00000000-0000-4000-8000-${tmdbId.toString(16).padStart(12, '0')}`
}

async function reportProgress(app: ReturnType<typeof Fastify>, token: string, itemId: string, positionTicks: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/Sessions/Playing/Progress',
    headers: { 'x-emby-token': token },
    payload: { ItemId: itemId, PositionTicks: positionTicks },
  })
  assert.equal(res.statusCode, 200, `progress report failed: ${res.body}`)
}

async function stopPlaying(app: ReturnType<typeof Fastify>, token: string, itemId: string, positionTicks: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/Sessions/Playing/Stopped',
    headers: { 'x-emby-token': token },
    payload: { ItemId: itemId, PositionTicks: positionTicks },
  })
  assert.equal(res.statusCode, 200, `stop report failed: ${res.body}`)
}

async function getPosition(app: ReturnType<typeof Fastify>, token: string, userId: string, itemId: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: `/Users/${userId}/Items/${itemId}`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `open ${itemId} failed: ${res.body}`)
  return (res.json().UserData as Record<string, unknown>).PlaybackPositionTicks as number
}

async function isInResume(app: ReturnType<typeof Fastify>, token: string, userId: string, itemId: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: `/Users/${userId}/Items/Resume`, headers: { 'x-emby-token': token } })
  assert.equal(res.statusCode, 200, `resume failed: ${res.body}`)
  const items = res.json().Items as Array<{ Id: string }>
  return items.some(item => item.Id === itemId)
}

// ── The tests ────────────────────────────────────────────────────────────────

test('a play that ran and stopped early clears the old resume point', async () => {
  const { user, token } = authedUser('restart-clears')
  const app = await buildApp()
  const itemId = makeMovieItemId()
  db.saveProgress(itemId, OLD_POSITION_TICKS, user.id)

  await reportProgress(app, token, itemId, 3 * TICKS_PER_SEC)
  await stopPlaying(app, token, itemId, Math.round(8.4 * TICKS_PER_SEC))

  assert.equal(await getPosition(app, token, user.id, itemId), 0)
  assert.equal(await isInResume(app, token, user.id, itemId), false)
  await app.close()
})

test('a stop with no progress report first leaves the old resume point alone', async () => {
  const { user, token } = authedUser('no-progress-keeps')
  const app = await buildApp()
  const itemId = makeMovieItemId()
  db.saveProgress(itemId, OLD_POSITION_TICKS, user.id)

  await stopPlaying(app, token, itemId, Math.round(8.4 * TICKS_PER_SEC))

  assert.equal(await getPosition(app, token, user.id, itemId), OLD_POSITION_TICKS)
  await app.close()
})

test('a stop under the 5s floor leaves the old resume point alone', async () => {
  const { user, token } = authedUser('under-floor-keeps')
  const app = await buildApp()
  const itemId = makeMovieItemId()
  db.saveProgress(itemId, OLD_POSITION_TICKS, user.id)

  // Infuse's first Progress report of a resumed play, before it seeks.
  await reportProgress(app, token, itemId, Math.round(1.3 * TICKS_PER_SEC))
  await stopPlaying(app, token, itemId, Math.round(1.3 * TICKS_PER_SEC))

  assert.equal(await getPosition(app, token, user.id, itemId), OLD_POSITION_TICKS)
  await app.close()
})

test('a stop at or above 2 minutes still saves its position as today', async () => {
  const { user, token } = authedUser('long-stop-saves')
  const app = await buildApp()
  const itemId = makeMovieItemId()
  db.saveProgress(itemId, OLD_POSITION_TICKS, user.id)

  await reportProgress(app, token, itemId, 3 * TICKS_PER_SEC)
  await stopPlaying(app, token, itemId, 3 * TICKS_PER_MIN)

  assert.equal(await getPosition(app, token, user.id, itemId), 3 * TICKS_PER_MIN)
  await app.close()
})

test('a progress report from another account does not count for this one', async () => {
  const itemId = makeMovieItemId()
  const { user: userA, token: tokenA } = authedUser('other-account-a')
  const { token: tokenB } = authedUser('other-account-b')
  const app = await buildApp()
  db.saveProgress(itemId, OLD_POSITION_TICKS, userA.id)

  await reportProgress(app, tokenB, itemId, 3 * TICKS_PER_SEC)
  await stopPlaying(app, tokenA, itemId, Math.round(8.4 * TICKS_PER_SEC))

  assert.equal(await getPosition(app, tokenA, userA.id, itemId), OLD_POSITION_TICKS)
  await app.close()
})

test('a stop forgets the remembered play, so a later stop with no new progress does not wrongly clear', async () => {
  const { user, token } = authedUser('forget-on-stop')
  const app = await buildApp()
  const itemId = makeMovieItemId()

  // A real, continued session: remembers the play, then stops past 2 minutes,
  // which saves as today (unchanged) and, per this fix, forgets the play too.
  await reportProgress(app, token, itemId, 3 * TICKS_PER_SEC)
  await stopPlaying(app, token, itemId, 3 * TICKS_PER_MIN)
  assert.equal(await getPosition(app, token, user.id, itemId), 3 * TICKS_PER_MIN)

  // A second, unrelated stop with no progress report since the first stop. If
  // the remembered play had survived the first stop instead of being forgotten,
  // this position (5s-2min) would wrongly read as a restart-and-give-up and
  // clear the point just saved above.
  await stopPlaying(app, token, itemId, 8 * TICKS_PER_SEC)

  assert.equal(await getPosition(app, token, user.id, itemId), 3 * TICKS_PER_MIN)
  await app.close()
})

// better-sqlite3 leaves the database plus its -wal and -shm sidecars in tmpdir,
// once per run per file. Nothing else cleans them up.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
})
