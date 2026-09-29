import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { config } from '../src/config.js'
import { clearSubtitleCache, fetchSubtitleFile, fetchSubtitles, prefetchSubtitleFiles } from '../src/subtitles.js'
import { startFakeSubtitleProvider } from './fake-subtitle-provider.js'

const sub = (id: string, lang: string) => ({ id, lang, url: `https://subs.example/file/${id}` })

// Every test starts from the same settings and an empty cache, then names its own
// providers. streamProviderUrls and sootioUrl are cleared as well, because they
// are the fallback source when no subtitle provider is named.
function configure(overrides: Partial<typeof config> = {}) {
  Object.assign(config, {
    subtitleProviderUrls: [],
    streamProviderUrls: [],
    sootioUrl: '',
    subtitleLanguages: ['eng', 'fre', 'rum', 'ger'],
    subtitleMaxPerLanguage: 3,
    subtitleTimeoutMs: 1000,
  }, overrides)
  clearSubtitleCache()
}

test('languages are folded, filtered to the configured list and grouped in its order', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      sub('a', 'eng'), sub('b', 'ron'), sub('c', 'spa'), sub('d', 'fre'),
      sub('e', 'deu'), sub('f', 'en'), sub('g', 'English'), sub('h', 'xx'),
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(tracks.map(track => [track.id, track.lang, track.label]), [
    ['1-a', 'eng', 'English 1'],
    ['1-f', 'eng', 'English 2'],
    ['1-g', 'eng', 'English 3'],
    ['1-d', 'fre', 'French'],
    ['1-b', 'rum', 'Romanian'],
    ['1-e', 'ger', 'German'],
  ])
  assert.equal(tracks[0].url, 'https://subs.example/file/a')
  assert.deepEqual(provider.requests, ['/subtitles/movie/tt0111161.json'])
})

test('each language\'s pool fills in rounds across providers, in provider order', async t => {
  const a = await startFakeSubtitleProvider({ subtitles: [sub('a1', 'eng'), sub('a2', 'eng')] })
  const b = await startFakeSubtitleProvider({ subtitles: [sub('b1', 'eng'), sub('b2', 'fre')] })
  const c = await startFakeSubtitleProvider({ subtitles: [sub('c1', 'eng'), sub('c2', 'eng'), sub('c3', 'eng')] })
  t.after(() => Promise.all([a.close(), b.close(), c.close()]))

  // How many each version shows is decided per version, later, so the setting
  // no longer cuts here.
  configure({ subtitleProviderUrls: [a.url, b.url, c.url], subtitleMaxPerLanguage: 2 })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), [
    '1-a1', '2-b1', '3-c1', '1-a2', '3-c2', '3-c3', '2-b2',
  ])
})

test('one provider with more than the pool still gives thirty', async t => {
  const many = await startFakeSubtitleProvider({ subtitles: Array.from({ length: 35 }, (_, i) => sub(`m${i + 1}`, 'eng')) })
  t.after(() => many.close())
  configure({ subtitleProviderUrls: [many.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id),
    Array.from({ length: 30 }, (_, i) => `1-m${i + 1}`))
})

test('two equal providers fill the pool alternating, fifteen from each', async t => {
  const a = await startFakeSubtitleProvider({ subtitles: Array.from({ length: 20 }, (_, i) => sub(`a${i + 1}`, 'eng')) })
  const b = await startFakeSubtitleProvider({ subtitles: Array.from({ length: 20 }, (_, i) => sub(`b${i + 1}`, 'eng')) })
  t.after(() => Promise.all([a.close(), b.close()]))
  configure({ subtitleProviderUrls: [a.url, b.url] })

  const expected: string[] = []
  for (let i = 1; i <= 15; i++) { expected.push(`1-a${i}`); expected.push(`2-b${i}`) }
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), expected)
})

test('an uneven pair alternates until the smaller runs out, then the larger fills the rest', async t => {
  const small = await startFakeSubtitleProvider({ subtitles: Array.from({ length: 5 }, (_, i) => sub(`s${i + 1}`, 'eng')) })
  const large = await startFakeSubtitleProvider({ subtitles: Array.from({ length: 40 }, (_, i) => sub(`l${i + 1}`, 'eng')) })
  t.after(() => Promise.all([small.close(), large.close()]))
  configure({ subtitleProviderUrls: [small.url, large.url] })

  const expected: string[] = []
  for (let i = 1; i <= 5; i++) { expected.push(`1-s${i}`); expected.push(`2-l${i}`) }
  for (let i = 6; i <= 25; i++) expected.push(`2-l${i}`)
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), expected)
})

const openSubtitlesV3Entry = { id: '5467612', lang: 'eng', url: 'https://subs5.strem.io/en/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/5467612' }
const openSubtitlesV3PlusEntry = { id: 'v3+|5467612|x', sub_id: 5467612, lang: 'eng', url: 'https://subs.example/sub.vtt/?sub_id=5467612' }

test('the same OpenSubtitles file offered by v3 and v3+ is kept once, in provider order', async t => {
  const v3 = await startFakeSubtitleProvider({ subtitles: [openSubtitlesV3Entry] })
  const v3Plus = await startFakeSubtitleProvider({ subtitles: [openSubtitlesV3PlusEntry] })
  t.after(() => Promise.all([v3.close(), v3Plus.close()]))

  configure({ subtitleProviderUrls: [v3.url, v3Plus.url] })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-5467612'])

  configure({ subtitleProviderUrls: [v3Plus.url, v3.url] })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-v3+|5467612|x'])
})

test('a plain id that matches an OpenSubtitles v3 id is not a duplicate unless the URL is strem.io\'s', async t => {
  const v3 = await startFakeSubtitleProvider({ subtitles: [openSubtitlesV3Entry] })
  const other = await startFakeSubtitleProvider({ subtitles: [{ id: '5467612', lang: 'eng', url: 'https://other.example/file/5467612' }] })
  t.after(() => Promise.all([v3.close(), other.close()]))
  configure({ subtitleProviderUrls: [v3.url, other.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-5467612', '2-5467612'])
})

test('each track carries the release it was made for', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { ...sub('a', 'eng'), movieReleaseName: 'Monk.S01E01.720p.WEB-DL.H264.AAC20-myTV', subtitleFileName: 'Other.Name.srt' },
      { ...sub('b', 'eng'), movieReleaseName: '', subtitleFileName: 'Monk - 1x01 - Mr. Monk and the Candidate_WEBRip.srt' },
      { ...sub('c', 'eng'), movieReleaseName: '   ', subtitleFileName: 'Monk.S01E01.DVDRip.ass' },
      { ...sub('d', 'eng'), movieReleaseName: 42 },
      sub('e', 'fre'),
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(tracks.map(track => [track.id, track.release, track.label]), [
    ['1-a', 'Monk.S01E01.720p.WEB-DL.H264.AAC20-myTV', 'English 1'],
    ['1-b', 'Monk - 1x01 - Mr. Monk and the Candidate_WEBRip', 'English 2'],
    ['1-c', 'Monk.S01E01.DVDRip', 'English 3'],
    ['1-d', '', 'English 4'],
    ['1-e', '', 'French'],
  ])
})

test('the release name is also read from title, releaseName and fileName', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'v3+|5467612|x', sub_id: 5467612, lang: 'eng', title: 'Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV', url: 'https://subs.example/sub.vtt/?lang_code=en&sub_id=5467612' },
      { id: 'a', lang: 'eng', url: 'https://subs.example/file/a', releaseName: 'Show.S01E01.WEBRip-GRP', fileName: 'Show.S01E01.WEBRip-GRP.srt' },
      { id: 'b', lang: 'eng', url: 'https://subs.example/file/b', fileName: 'Show.S01E01.1080p.WEB-DL-GRP.srt' },
      { id: 'c', lang: 'eng', url: 'https://subs.example/file/c', movieReleaseName: 'Movie.From.OpenSubtitles.v3', title: 'Wrong.Title', releaseName: 'Wrong.ReleaseName' },
      { id: 'd', lang: 'eng', url: 'https://subs.example/file/d', title: 42, releaseName: '  ' },
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(tracks.map(track => [track.id, track.release, track.format]), [
    ['1-v3+|5467612|x', 'Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV', 'vtt'],
    ['1-a', 'Show.S01E01.WEBRip-GRP', 'srt'],
    ['1-b', 'Show.S01E01.1080p.WEB-DL-GRP', 'srt'],
    ['1-c', 'Movie.From.OpenSubtitles.v3', 'srt'],
    ['1-d', '', 'srt'],
  ])
})

test('the format also comes from a .vtt path segment, and from fileName when subtitleFileName is missing', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'a', lang: 'eng', url: 'https://subs.example/files/sub.VTT/?id=1' },
      { id: 'b', lang: 'eng', url: 'https://subs.example/download/abc' },
      { id: 'c', lang: 'eng', url: 'https://subs.example/sub.vtt/?id=2', subtitleFileName: 'x.ass' },
      { id: 'd', lang: 'eng', url: 'https://subs.example/file/d', fileName: 'x.ass' },
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.format), ['vtt', 'srt', 'ass', 'ass'])
})

test('the same file offered by two providers is offered once', async t => {
  const shared = { id: 'x', lang: 'eng', url: 'https://subs.example/file/shared' }
  const first = await startFakeSubtitleProvider({ subtitles: [shared] })
  const second = await startFakeSubtitleProvider({ subtitles: [{ ...shared, id: 'y' }, sub('z', 'eng')] })
  t.after(() => Promise.all([first.close(), second.close()]))
  configure({ subtitleProviderUrls: [first.url, second.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-x', '2-z'])
})

test('entries a client could not fetch are dropped', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'ftp', lang: 'eng', url: 'ftp://subs.example/a.srt' },
      { id: 'junk', lang: 'eng', url: 'not a url' },
      { id: 'stremio-server', lang: 'eng', url: 'http://127.0.0.1:11470/subtitles.srt' },
      { id: 'localhost', lang: 'eng', url: 'http://localhost/a.srt' },
      { id: 'v6', lang: 'eng', url: 'http://[::1]/a.srt' },
      { id: 'nourl', lang: 'eng' },
      { id: 'nolang', lang: '', url: 'https://subs.example/nolang.srt' },
      { id: 'ok', lang: 'eng', url: 'https://subs.example/ok.vtt' },
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(tracks.map(track => [track.id, track.format]), [['1-ok', 'vtt']])
})

test('the format comes from the file name when the URL has none', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'a', lang: 'eng', url: 'https://subs.example/file/1', subtitleFileName: 'Show.S01E01.ass' },
      { id: 'b', lang: 'eng', url: 'https://subs.example/file/2' },
      { id: 'c', lang: 'eng', url: 'https://subs.example/file/3.VTT' },
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.format), ['ass', 'srt', 'vtt'])
})

test('an empty language list offers every language, grouped by first appearance', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'spa'), sub('b', 'eng'), sub('c', 'spa')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url], subtitleLanguages: [] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => [track.id, track.lang]), [
    ['1-a', 'spa'], ['1-c', 'spa'], ['1-b', 'eng'],
  ])
})

test('a slow provider costs its own timeout, not everyone\'s', async t => {
  t.mock.method(console, 'warn', () => {})
  const slow = await startFakeSubtitleProvider({ mode: 'slow', slowMs: 5000, subtitles: [sub('a', 'eng')] })
  const fast = await startFakeSubtitleProvider({ subtitles: [sub('b', 'eng')] })
  t.after(() => Promise.all([slow.close(), fast.close()]))
  configure({ subtitleProviderUrls: [slow.url, fast.url], subtitleTimeoutMs: 300 })

  const started = performance.now()
  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.ok(performance.now() - started < 2000, 'the slow provider held up the answer')
  assert.deepEqual(tracks.map(track => track.id), ['2-b'])
  assert.equal(slow.requests.length, 1)
})

test('a hanging manifest costs its own timeout, not everyone\'s', async t => {
  t.mock.method(console, 'warn', () => {})
  const hanging = await startFakeSubtitleProvider({ manifestDelayMs: 5000, subtitles: [sub('a', 'eng')] })
  const good = await startFakeSubtitleProvider({ subtitles: [sub('b', 'eng')] })
  t.after(() => Promise.all([hanging.close(), good.close()]))
  // No subtitle provider named, so both stream providers' manifests are consulted.
  configure({ streamProviderUrls: [hanging.url, good.url], subtitleTimeoutMs: 300 })

  const started = performance.now()
  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.ok(performance.now() - started < 2000, 'the hanging manifest held up the answer')
  assert.deepEqual(tracks.map(track => track.id), ['2-b'])
})

test('a failing, empty or garbled provider costs nothing but its own answer', async t => {
  t.mock.method(console, 'warn', () => {})
  const failing = await startFakeSubtitleProvider({ mode: 'error' })
  const empty = await startFakeSubtitleProvider({ mode: 'empty' })
  const garbled = await startFakeSubtitleProvider({ mode: 'garbage' })
  const good = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => Promise.all([failing, empty, garbled, good].map(provider => provider.close())))

  configure({ subtitleProviderUrls: [failing.url, empty.url, garbled.url, good.url] })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['4-a'])

  configure({ subtitleProviderUrls: [failing.url, garbled.url] })
  assert.deepEqual(await fetchSubtitles('movie', 'tt0111161'), [])
})

test('failures are logged once per provider per ten minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const warn = t.mock.method(console, 'warn', () => {})
  const failing = await startFakeSubtitleProvider({ mode: 'error' })
  t.after(() => failing.close())
  configure({ subtitleProviderUrls: [failing.url] })
  const lines = () => warn.mock.calls.filter(call => String(call.arguments[0]).startsWith('subtitles:'))

  assert.deepEqual(await fetchSubtitles('movie', 'tt0111161'), [])
  assert.equal(lines().length, 1)
  assert.match(String(lines()[0].arguments[0]), /HTTP 500/)

  // Each lookup below reaches the provider, because the cache is cleared or the
  // title is new, and none of them may add a line inside the ten minutes.
  clearSubtitleCache()
  await fetchSubtitles('movie', 'tt0111161')
  await fetchSubtitles('movie', 'tt0068646')
  assert.equal(failing.requests.length, 3)
  assert.equal(lines().length, 1)

  t.mock.timers.tick(10 * 60 * 1000)
  clearSubtitleCache()
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(lines().length, 2)
})

test('answers are kept ten minutes and empty answers two', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  await fetchSubtitles('movie', 'tt0111161')
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(provider.requests.length, 1)
  t.mock.timers.tick(10 * 60 * 1000 - 1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(provider.requests.length, 1)
  t.mock.timers.tick(1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(provider.requests.length, 2)

  // A provider that had nothing is asked again soon, so one that recovers shows
  // up on the next visit rather than ten minutes later.
  provider.setMode('empty')
  assert.deepEqual(await fetchSubtitles('movie', 'tt0068646'), [])
  assert.equal(provider.requests.length, 3)
  t.mock.timers.tick(2 * 60 * 1000 - 1)
  await fetchSubtitles('movie', 'tt0068646')
  assert.equal(provider.requests.length, 3)
  t.mock.timers.tick(1)
  await fetchSubtitles('movie', 'tt0068646')
  assert.equal(provider.requests.length, 4)
})

test('a slow provider costs the answer two minutes, not ten, though the fast one\'s tracks are kept', async t => {
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const fast = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  const slow = await startFakeSubtitleProvider({ mode: 'slow', slowMs: 5000 })
  t.after(() => Promise.all([fast.close(), slow.close()]))
  configure({ subtitleProviderUrls: [fast.url, slow.url], subtitleTimeoutMs: 200 })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a'])
  assert.equal(fast.requests.length, 1)
  assert.equal(slow.requests.length, 1)

  t.mock.timers.tick(2 * 60 * 1000 - 1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(fast.requests.length, 1, 'served from cache')
  assert.equal(slow.requests.length, 1, 'served from cache')

  t.mock.timers.tick(1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(fast.requests.length, 2, 'both providers are asked again')
  assert.equal(slow.requests.length, 2, 'both providers are asked again')
})

test('a provider answering HTTP 500 costs the answer two minutes too', async t => {
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const good = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  const failing = await startFakeSubtitleProvider({ mode: 'error' })
  t.after(() => Promise.all([good.close(), failing.close()]))
  configure({ subtitleProviderUrls: [good.url, failing.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a'])
  t.mock.timers.tick(2 * 60 * 1000 - 1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(good.requests.length, 1, 'served from cache')
  t.mock.timers.tick(1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(good.requests.length, 2, 'asked again')
})

test('two providers that both answer are still kept ten minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const a = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  const b = await startFakeSubtitleProvider({ subtitles: [sub('b', 'fre')] })
  t.after(() => Promise.all([a.close(), b.close()]))
  configure({ subtitleProviderUrls: [a.url, b.url] })

  await fetchSubtitles('movie', 'tt0111161')
  t.mock.timers.tick(10 * 60 * 1000 - 1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(a.requests.length, 1, 'served from cache')
  assert.equal(b.requests.length, 1, 'served from cache')
  t.mock.timers.tick(1)
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(a.requests.length, 2, 'asked again')
  assert.equal(b.requests.length, 2, 'asked again')
})

test('concurrent lookups for one title share one request', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const results = await Promise.all([1, 2, 3].map(() => fetchSubtitles('movie', 'tt0111161')))
  assert.equal(provider.requests.length, 1)
  for (const tracks of results) assert.equal(tracks.length, 1)
})

test('file details bypass the cache and reach the provider re-encoded', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })
  const extra = { videoHash: '8e245d9679d31e12', videoSize: '652696576', filename: 'Tom & Jerry (1940).mkv' }
  const withExtra = '/subtitles/movie/tt0111161/videoHash=8e245d9679d31e12&videoSize=652696576&filename=Tom%20%26%20Jerry%20(1940).mkv.json'

  await fetchSubtitles('movie', 'tt0111161')
  await fetchSubtitles('movie', 'tt0111161', extra)
  await fetchSubtitles('movie', 'tt0111161', extra)
  // An empty extra is no extra, and the title-level entry must have survived.
  await fetchSubtitles('movie', 'tt0111161', {})
  await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(provider.requests, ['/subtitles/movie/tt0111161.json', withExtra, withExtra])
})

test('an episode is asked for by the stream id shape', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  await fetchSubtitles('series', 'tt13210838:1:2')
  assert.deepEqual(provider.requests, ['/subtitles/series/tt13210838:1:2.json'])
})

test('ids that are not IMDb shaped never reach a provider', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  const cases: Array<[string, string]> = [
    ['movie', 'kitsu:1'], ['movie', '../../etc/passwd'], ['movie', 'tt123'], ['series', 'tt0903747:1'],
    ['movie', ''], ['channel', 'tt0111161'],
  ]
  for (const [mediaType, externalId] of cases) {
    assert.deepEqual(await fetchSubtitles(mediaType as never, externalId), [], `${mediaType} ${externalId}`)
  }
  assert.equal(provider.requests.length, 0)
})

test('with no subtitle providers named, stream providers that declare subtitles are asked', async t => {
  const both = await startFakeSubtitleProvider({ resources: ['stream', 'subtitles'], subtitles: [sub('a', 'eng')] })
  const streamOnly = await startFakeSubtitleProvider({ resources: ['stream'], subtitles: [sub('b', 'eng')] })
  const objectForm = await startFakeSubtitleProvider({ resources: [{ name: 'subtitles', types: ['movie'] }], subtitles: [sub('c', 'eng')] })
  t.after(() => Promise.all([both.close(), streamOnly.close(), objectForm.close()]))
  configure({ streamProviderUrls: [both.url, streamOnly.url, objectForm.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a', '3-c'])
  assert.equal(streamOnly.requests.length, 0)
})

test('named subtitle providers replace the stream providers and skip the manifest', async t => {
  const named = await startFakeSubtitleProvider({ subtitles: [sub('a', 'eng')] })
  const stream = await startFakeSubtitleProvider({ subtitles: [sub('b', 'eng')] })
  t.after(() => Promise.all([named.close(), stream.close()]))
  configure({ subtitleProviderUrls: [named.url], streamProviderUrls: [stream.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a'])
  assert.equal(stream.requests.length, 0)
  assert.equal(named.manifestRequests(), 0)
})

test('no providers at all means no subtitles', async () => {
  configure()
  assert.deepEqual(await fetchSubtitles('movie', 'tt0111161'), [])
})

test('.sub files are not offered and do not use up the pool', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'micro', lang: 'eng', url: 'https://subs.example/file/micro', subtitleFileName: 'Movie.sub' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `srt${i + 1}`, lang: 'eng', url: `https://subs.example/file/${i + 1}`, subtitleFileName: 'Movie.srt' })),
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url] })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), [
    '1-srt1', '1-srt2', '1-srt3', '1-srt4', '1-srt5', '1-srt6', '1-srt7', '1-srt8', '1-srt9', '1-srt10',
  ])
})

async function startFileHost() {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/fail')) { res.writeHead(500); res.end(); return }
    if (req.url?.startsWith('/slow')) return // never answers
    if (req.url?.startsWith('/huge')) { res.writeHead(200, { 'content-length': String(6 * 1024 * 1024) }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' })
    res.end(`1\n00:00:01,000 --> 00:00:02,000\nfile ${req.url}\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

test('a subtitle file is fetched once and then served from memory', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  configure()
  const first = await fetchSubtitleFile(`${host.base}/a.srt`)
  const second = await fetchSubtitleFile(`${host.base}/a.srt`)
  assert.equal(first?.body.toString(), '1\n00:00:01,000 --> 00:00:02,000\nfile /a.srt\n')
  assert.equal(first?.contentType, 'application/x-subrip; charset=utf-8')
  assert.equal(second, first)
  assert.deepEqual(host.hits, ['/a.srt'])
})

test('a subtitle file that fails, hangs or is too large is null, not an error', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  configure({ subtitleTimeoutMs: 300 })
  assert.equal(await fetchSubtitleFile(`${host.base}/fail.srt`), null)
  const started = performance.now()
  assert.equal(await fetchSubtitleFile(`${host.base}/slow.srt`), null)
  assert.ok(performance.now() - started < 2000)
  assert.equal(await fetchSubtitleFile(`${host.base}/huge.srt`), null)
  assert.equal(await fetchSubtitleFile('not a url'), null)
})

test('two concurrent fetches for the same URL share one request', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  configure()
  const [first, second] = await Promise.all([fetchSubtitleFile(`${host.base}/a.srt`), fetchSubtitleFile(`${host.base}/a.srt`)])
  assert.equal(second, first)
  assert.deepEqual(host.hits, ['/a.srt'])
})

test('a failed fetch is not cached, so the next call reaches the host again', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  configure()
  assert.equal(await fetchSubtitleFile(`${host.base}/fail.srt`), null)
  assert.equal(await fetchSubtitleFile(`${host.base}/fail.srt`), null)
  assert.deepEqual(host.hits, ['/fail.srt', '/fail.srt'])
})

test('prefetchSubtitleFiles never has more than four requests open at once', async t => {
  let open = 0
  let maxOpen = 0
  const server = createServer((req, res) => {
    open++
    maxOpen = Math.max(maxOpen, open)
    setTimeout(() => {
      open--
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }, 30)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  configure()

  const urls = Array.from({ length: 6 }, (_, i) => `http://127.0.0.1:${port}/${i}.srt`)
  prefetchSubtitleFiles(urls)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(maxOpen, 4)
})

test('prefetchSubtitleFiles does not throw and does not let a failing url stop the others', async t => {
  const host = await startFileHost()
  t.after(() => host.close())
  configure()
  assert.doesNotThrow(() => prefetchSubtitleFiles([`${host.base}/fail.srt`, `${host.base}/a.srt`, `${host.base}/b.srt`]))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual([...host.hits].sort(), ['/a.srt', '/b.srt', '/fail.srt'])
})

test('prefetchSubtitleFiles is a no-op for an empty list', async () => {
  configure()
  assert.doesNotThrow(() => prefetchSubtitleFiles([]))
})

