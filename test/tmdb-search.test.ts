import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeTmdb, FAKE_TMDB_KEY, type FakeTmdbMovie, type FakeTmdbOptions } from './fake-tmdb.js'

// fetchMovieByTmdbId stores what it fetches, so the last test needs a database.
process.env.DATABASE_PATH = join(tmpdir(), `fetcherr-tmdb-search-${randomUUID()}.db`)
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const { config } = await import('../src/config.js')
const { findTmdbTitles, clearTmdbSearchCache, tmdbMovieToMovie, tmdbSeriesToMeta } = await import('../src/tmdb-search.js')
const { fetchMovieByTmdbId } = await import('../src/tmdb.js')

const NO_SKIP = { movieTmdbIds: new Set<number>(), movieImdbIds: new Set<string>(), seriesTmdbIds: new Set<number>(), seriesImdbIds: new Set<string>() }

async function fakeTmdb(t: { after: (fn: () => unknown) => void }, options: FakeTmdbOptions = {}, overrides: Record<string, unknown> = {}) {
  const fake = await startFakeTmdb(options)
  t.after(() => fake.close())
  Object.assign(config, { tmdbApiKey: FAKE_TMDB_KEY, tmdbBaseUrl: fake.url, tmdbSearchTimeoutMs: 2000, ...overrides })
  clearTmdbSearchCache()
  return fake
}

const numbered = (count: number, firstId: number, title: (n: number) => string): FakeTmdbMovie[] =>
  Array.from({ length: count }, (_, i) => ({ id: firstId + i, title: title(i + 1), imdb: `tt${firstId + i}` }))

test('a movie result becomes a search-movie record with its IMDb id', () => {
  const movie = tmdbMovieToMovie({
    tmdbId: 32601, imdbId: 'tt0093549', title: 'The Moromete Family', originalLanguage: 'ro', releaseDate: '1987-01-05',
    year: 1987, overview: 'A village in 1937.', posterPath: '/p.jpg', backdropPath: '/b.jpg', popularity: 3.5, voteAverage: 7.9,
  })
  assert.match(movie.syncedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual({ ...movie, syncedAt: '' }, {
    id: 0, tmdbId: 32601, imdbId: 'tt0093549', mediaLanguage: 'ro', title: 'The Moromete Family', year: 1987,
    overview: 'A village in 1937.', posterPath: '/p.jpg', backdropPath: '/b.jpg', logoPath: '', genres: '[]', runtimeMins: 0,
    popularity: 3.5, officialRating: '', communityRating: 7.9, studiosJson: '[]', tagsJson: '[]', castJson: '[]',
    releaseDate: '1987-01-05', digitalReleaseDate: '', syncedAt: '',
  })
})

test('a series result becomes a Stremio series meta keyed by its IMDb id', () => {
  assert.deepEqual(tmdbSeriesToMeta({
    tmdbId: 62476, imdbId: 'tt4063800', name: 'The Bureau', firstAirDate: '2015-04-27', year: 2015,
    overview: 'Spies.', posterPath: '/bureau.jpg', backdropPath: '',
  }), { id: 'tt4063800', type: 'series', name: 'The Bureau', poster: '/bureau.jpg', description: 'Spies.', releaseInfo: '2015' })
})

test('a French title is found by its original name', async t => {
  const fake = await fakeTmdb(t, {
    series: [
      { id: 62476, name: 'The Bureau', original_name: 'Le Bureau des Légendes', imdb: 'tt4063800', first_air_date: '2015-04-27' },
      { id: 1001, name: 'Unrelated', imdb: 'tt1001' },
    ],
  })
  const hits = await findTmdbTitles('Le Bureau des légendes', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies, [])
  assert.deepEqual(hits.series?.map(s => [s.tmdbId, s.imdbId, s.name, s.year]), [[62476, 'tt4063800', 'The Bureau', 2015]])
  assert.deepEqual(fake.requests.find(r => r.scope === 'tv')?.query, {
    query: 'Le Bureau des légendes', language: 'en-US', include_adult: 'false', page: '1',
  })
  // Both answers said one page, so neither type asks for page 2.
  assert.deepEqual([fake.count('movie'), fake.count('tv')], [1, 1])
})

test('the term reaches TMDB exactly as typed', async t => {
  const fake = await fakeTmdb(t)
  const terms = ['Moromeții', 'Dix pour cent !', "C'est la vie & co", '50% + 1']
  for (const term of terms) await findTmdbTitles(term, ['movie'], NO_SKIP)
  assert.deepEqual(fake.requests.map(r => r.query.query), terms)
  // The cache is keyed by the same exact term.
  await findTmdbTitles('Moromeții', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 4)
})

test('a movies-only search makes no TV calls', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 1201, title: 'Heat', imdb: 'tt1201' }],
    series: [{ id: 1202, name: 'Heat Wave', imdb: 'tt1202' }],
  })
  const hits = await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.imdbId), ['tt1201'])
  assert.deepEqual(hits.series, [])
  assert.deepEqual(fake.requests.map(r => r.scope), ['movie', 'movie-ids'])
})

test('page 2 is asked for only when page 1 reports more, and a search keeps 40 movies', async t => {
  const fake = await fakeTmdb(t, {
    movies: numbered(60, 1301, n => `Agent ${n}`),
    series: numbered(5, 1401, n => `Agent Show ${n}`).map(({ title, ...rest }) => ({ ...rest, name: title })),
  })
  const hits = await findTmdbTitles('agent', ['movie', 'series'], NO_SKIP)
  assert.equal(hits.movies?.length, 40)
  assert.equal(hits.series?.length, 5)
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie').map(r => r.query.page), ['1', '2'])
  assert.deepEqual(fake.requests.filter(r => r.scope === 'tv').map(r => r.query.page), ['1'])
  assert.equal(fake.count('movie-ids'), 40)
})

test('titles without an IMDb id are left out', async t => {
  await fakeTmdb(t, {
    movies: [{ id: 1501, title: 'Monk', imdb: 'tt1501' }, { id: 1502, title: 'Monk', imdb: null }],
    series: [{ id: 1601, name: 'Monk', imdb: 'tt0312172' }, { id: 1602, name: 'Monk', imdb: null }],
  })
  const hits = await findTmdbTitles('monk', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [1501])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1601])
})

test('results that share an IMDb id collapse to the first', async t => {
  await fakeTmdb(t, {
    movies: [{ id: 1701, title: 'Solaris', imdb: 'tt0069293' }, { id: 1702, title: 'Solaris', imdb: 'tt0069293' }],
    series: [{ id: 1801, name: 'Solaris', imdb: 'tt1801' }, { id: 1802, name: 'Solaris', imdb: 'tt1801' }],
  })
  const hits = await findTmdbTitles('solaris', ['movie', 'series'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [1701])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1801])
})

test('series are ranked by title before the cap of 20, past titles with no IMDb id', async t => {
  // TMDB's popularity order, as measured for `monk`: loose matches first, then
  // exact matches that mostly have no IMDb id, then the ones that do.
  const loose = Array.from({ length: 25 }, (_, i) => ({ id: 1901 + i, name: `Monkey Business ${i + 1}`, imdb: `tt${1901 + i}` }))
  const exactNoId = Array.from({ length: 5 }, (_, i) => ({ id: 1926 + i, name: 'Monk', imdb: null }))
  const exact = Array.from({ length: 3 }, (_, i) => ({ id: 1931 + i, name: 'Monk', imdb: `tt${1931 + i}` }))
  const fake = await fakeTmdb(t, { series: [...loose, ...exactNoId, ...exact] })
  const hits = await findTmdbTitles('monk', ['series'], NO_SKIP)
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [1931, 1932, 1933, ...loose.slice(0, 17).map(s => s.id)])
  assert.equal(fake.count('tv-ids'), 33)
})

test('library titles are skipped before any lookup', async t => {
  const fake = await fakeTmdb(t, {
    movies: [
      { id: 2001, title: 'Heat', imdb: 'tt2001' },
      { id: 2002, title: 'Heat', imdb: 'tt2002' },
      { id: 2003, title: 'Heat 2', imdb: 'tt2003' },
    ],
    series: [{ id: 2101, name: 'Heat', imdb: 'tt2101' }, { id: 2102, name: 'Heat Squad', imdb: 'tt2102' }],
  })
  const skip = { ...NO_SKIP, movieTmdbIds: new Set([2001]), movieImdbIds: new Set(['tt2003']), seriesTmdbIds: new Set([2101]) }
  const hits = await findTmdbTitles('heat', ['movie', 'series'], skip)
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [2002])
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [2102])
  // A library title known by its IMDb id only needs its lookup to be recognised.
  assert.deepEqual(fake.requests.filter(r => r.scope.endsWith('-ids')).map(r => r.path).sort(), [
    '/movie/2002/external_ids', '/movie/2003/external_ids', '/tv/2102/external_ids',
  ])
})

test('answers are kept ten minutes, and IMDb ids for the life of the process', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const fake = await fakeTmdb(t, { movies: [{ id: 2201, title: 'Ronin', imdb: 'tt2201' }] })
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [1, 1])
  t.mock.timers.tick(10 * 60 * 1000 - 1)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 1)
  t.mock.timers.tick(1)
  const hits = await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [2, 1])
  assert.deepEqual(hits.movies?.map(m => m.imdbId), ['tt2201'])
  // A settings save drops answers but keeps IMDb ids, which never change.
  clearTmdbSearchCache()
  t.mock.timers.tick(24 * 60 * 60 * 1000)
  await findTmdbTitles('ronin', ['movie'], NO_SKIP)
  assert.deepEqual([fake.count('movie'), fake.count('movie-ids')], [3, 1])
})

test('the answer cache keeps at most 500 entries, oldest dropped first', async t => {
  const fake = await fakeTmdb(t)
  for (let i = 0; i < 501; i++) await findTmdbTitles(`term ${i}`, ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 501)
  await findTmdbTitles('term 500', ['movie'], NO_SKIP)
  await findTmdbTitles('term 1', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 501)
  await findTmdbTitles('term 0', ['movie'], NO_SKIP)
  assert.equal(fake.count('movie'), 502)
})

test('identical searches in flight share their requests', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2301, title: 'Heat', imdb: 'tt2301' }],
    series: [{ id: 2401, name: 'Heat', imdb: 'tt2401' }],
  })
  const answers = await Promise.all([1, 2, 3].map(() => findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)))
  assert.deepEqual(answers.map(a => [a.movies?.length, a.series?.length]), [[1, 1], [1, 1], [1, 1]])
  assert.deepEqual([fake.count('movie'), fake.count('tv'), fake.count('movie-ids'), fake.count('tv-ids')], [1, 1, 1, 1])
})

test('a type TMDB could not answer comes back as failed', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2501, title: 'Heat', imdb: 'tt2501' }],
    series: [{ id: 2601, name: 'Heat', imdb: 'tt2601' }],
  }, { tmdbSearchTimeoutMs: 300 })
  const search = () => findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)

  fake.setMode('tv', 'unauthorized')
  let hits = await search()
  assert.deepEqual(hits.movies?.map(m => m.tmdbId), [2501])
  assert.equal(hits.series, null)

  clearTmdbSearchCache()
  fake.setMode('tv', 'answers')
  fake.setMode('movie', 'error')
  hits = await search()
  assert.equal(hits.movies, null)
  assert.deepEqual(hits.series?.map(s => s.tmdbId), [2601])

  clearTmdbSearchCache()
  fake.setMode('movie', 'slow')
  const started = Date.now()
  hits = await search()
  assert.equal(hits.movies, null)
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`)

  // A 200 that is not a TMDB answer counts as a failure too.
  fake.setMode('movie', 'answers')
  for (const body of ['{"results":"none"}', 'not json at all']) {
    clearTmdbSearchCache()
    fake.setRaw('movie', body)
    assert.equal((await search()).movies, null, body)
  }
})

test('a failed page 2 keeps page 1', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: numbered(25, 2701, n => `Agent ${n}`) })
  fake.setMode('movie', 'error', 2)
  const hits = await findTmdbTitles('agent', ['movie'], NO_SKIP)
  assert.equal(hits.movies?.length, 20)
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie').map(r => r.query.page), ['1', '2'])
})

test('a failed IMDb lookup drops only that title, and is asked again next time', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {
    movies: [{ id: 2801, title: 'Heat', imdb: 'tt2801' }, { id: 2802, title: 'Heat Wave', imdb: 'tt2802' }],
  })
  fake.failLookups.add(2802)
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [2801])
  fake.failLookups.clear()
  assert.deepEqual((await findTmdbTitles('heat', ['movie'], NO_SKIP)).movies?.map(m => m.tmdbId), [2801, 2802])
  assert.deepEqual(fake.requests.filter(r => r.scope === 'movie-ids').map(r => r.path).sort(), [
    '/movie/2801/external_ids', '/movie/2802/external_ids', '/movie/2802/external_ids',
  ])
})

test('slow lookups give up together inside one window', async t => {
  t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, { movies: numbered(25, 2901, n => `Slow ${n}`) }, { tmdbSearchTimeoutMs: 300 })
  fake.setMode('movie-ids', 'slow')
  const started = Date.now()
  const hits = await findTmdbTitles('slow', ['movie'], NO_SKIP)
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`)
  assert.deepEqual(hits.movies, [])
  // Ten in flight when the window closed, and nothing started after it.
  assert.equal(fake.count('movie-ids'), 10)
})

test('failures are logged once per ten minutes, without the key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const warn = t.mock.method(console, 'warn', () => {})
  const fake = await fakeTmdb(t, {}, { tmdbApiKey: 'wrong-key-5f3a9c' })
  const lines = () => warn.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('tmdb search: '))

  await findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)
  assert.equal(lines().length, 1)
  assert.match(lines()[0], /HTTP 401/)
  // Failures are not cached, so this asks again, and still logs nothing new.
  await findTmdbTitles('heat', ['movie', 'series'], NO_SKIP)
  assert.equal(fake.count('movie'), 2)
  assert.equal(lines().length, 1)

  t.mock.timers.tick(10 * 60 * 1000)
  await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.equal(lines().length, 2)
  assert.ok(lines().every(line => !line.includes('wrong-key-5f3a9c')))
})

test('malformed results are skipped, not fatal', async t => {
  const fake = await fakeTmdb(t, {
    movies: [{ id: 3001, title: 'Heat', imdb: 'tt3001' }, { id: 3003, title: 'Heat Again', imdb: 'tt3003' }],
  })
  fake.setRaw('movie', JSON.stringify({
    page: 1, total_pages: 1, total_results: 5,
    results: [
      { id: 3001, title: 'Heat', poster_path: null, backdrop_path: null },
      { id: 'x', title: 'Bad id' },
      { id: 3002 },
      null,
      { id: 3003, title: 'Heat Again', release_date: '', poster_path: 'https://elsewhere.example/p.jpg', overview: 7 },
    ],
  }))
  const hits = await findTmdbTitles('heat', ['movie'], NO_SKIP)
  assert.deepEqual(hits.movies?.map(m => [m.tmdbId, m.title, m.posterPath, m.releaseDate, m.year, m.overview]), [
    [3001, 'Heat', '', '', 0, ''],
    [3003, 'Heat Again', '', '', 0, ''],
  ])
})

test('a blank term asks TMDB nothing', async t => {
  const fake = await fakeTmdb(t)
  assert.deepEqual(await findTmdbTitles('   ', ['movie', 'series'], NO_SKIP), { movies: [], series: [] })
  assert.deepEqual(await findTmdbTitles('heat', [], NO_SKIP), { movies: [], series: [] })
  assert.equal(fake.requests.length, 0)
})

test('every TMDB call uses the configured base', async t => {
  const fake = await fakeTmdb(t, { movies: [{ id: 3101, title: 'Heat', imdb: 'tt3101', certification: 'R', release_date: '1995-12-15' }] })
  const movie = await fetchMovieByTmdbId(3101)
  assert.deepEqual([movie?.imdbId, movie?.officialRating], ['tt3101', 'R'])
  assert.deepEqual(fake.requests.map(r => r.path), ['/movie/3101'])
})
