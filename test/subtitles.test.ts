import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { config } from '../src/config.js'
import { clearSubtitleCache, fetchSubtitleFile, fetchSubtitles } from '../src/subtitles.js'
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

test('each language is capped, in provider order and then the provider\'s own order', async t => {
  const first = await startFakeSubtitleProvider({ subtitles: [sub('a1', 'eng'), sub('a2', 'eng')] })
  const second = await startFakeSubtitleProvider({ subtitles: [sub('b1', 'eng'), sub('b2', 'fre')] })
  t.after(() => Promise.all([first.close(), second.close()]))

  configure({ subtitleProviderUrls: [first.url, second.url], subtitleMaxPerLanguage: 2 })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a1', '1-a2', '2-b2'])

  configure({ subtitleProviderUrls: [first.url, second.url], subtitleMaxPerLanguage: 3 })
  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-a1', '1-a2', '2-b1', '2-b2'])
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
  configure({ subtitleProviderUrls: [provider.url], subtitleMaxPerLanguage: 10 })

  const tracks = await fetchSubtitles('movie', 'tt0111161')
  assert.deepEqual(tracks.map(track => [track.id, track.release, track.label]), [
    ['1-a', 'Monk.S01E01.720p.WEB-DL.H264.AAC20-myTV', 'English 1'],
    ['1-b', 'Monk - 1x01 - Mr. Monk and the Candidate_WEBRip', 'English 2'],
    ['1-c', 'Monk.S01E01.DVDRip', 'English 3'],
    ['1-d', '', 'English 4'],
    ['1-e', '', 'French'],
  ])
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

test('.sub files are not offered and do not use up the cap', async t => {
  const provider = await startFakeSubtitleProvider({
    subtitles: [
      { id: 'micro', lang: 'eng', url: 'https://subs.example/file/1', subtitleFileName: 'Movie.sub' },
      { id: 'srt', lang: 'eng', url: 'https://subs.example/file/2', subtitleFileName: 'Movie.srt' },
    ],
  })
  t.after(() => provider.close())
  configure({ subtitleProviderUrls: [provider.url], subtitleMaxPerLanguage: 1 })

  assert.deepEqual((await fetchSubtitles('movie', 'tt0111161')).map(track => track.id), ['1-srt'])
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
