import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachSubtitleStreams, parsePlayPath, rememberedSubtitleOrder, rememberSubtitleOrder, subtitleContentType, subtitleTrackForSource,
} from '../src/subtitle-streams.js'
import type { SubtitleTrack } from '../src/subtitles.js'

const TRACKS: SubtitleTrack[] = [
  { id: '1-a', url: 'https://subs.example/a', lang: 'eng', label: 'English 1', format: 'srt', release: '' },
  { id: '1-b', url: 'https://subs.example/b', lang: 'eng', label: 'English 2', format: 'srt', release: '' },
  { id: '1-c', url: 'https://subs.example/c.vtt', lang: 'rum', label: 'Romanian', format: 'vtt', release: '' },
]

const source = () => ({
  Id: 'src',
  MediaStreams: [
    { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true },
    { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, Language: 'eng' },
  ],
})

type Stream = Record<string, unknown>

// Three per language and no file name: the provider order, as before ranking.
const SHOW_THREE = { perLanguage: 3 }

const track = (id: string, lang: string, release: string): SubtitleTrack =>
  ({ id, url: `https://subs.example/${id}`, lang, label: '', format: 'srt', release })
// The Jetsons S01E01 as OpenSubtitles lists it: a DVD-era file first, then one
// for a web release, then one for the BluRay FGT release.
const JETSONS: SubtitleTrack[] = [
  track('j-dvd', 'eng', 'The Jetsons Complete Series'),
  track('j-web', 'eng', 'The.Jetsons.S01E01.720p.WEB-DL.AAC2.0.H.264-NTb'),
  track('j-fgt', 'eng', 'The.Jetsons.S01E01.1080p.BluRay.x264-FGT'),
  track('j-fre', 'fre', ''),
]
const FGT_FILE = 'The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT.mkv'
const WEB_FILE = 'The.Jetsons.S01E01.720p.WEB-DL.AAC2.0.H.264-NTb.mkv'
const subtitleStreams = (source: Record<string, unknown>) =>
  (source.MediaStreams as Stream[]).filter(stream => stream.Type === 'Subtitle')

test('play paths map to the ids subtitles are looked up by', () => {
  const cases: Array<[string, unknown]> = [
    ['/play/tt0111161', { mediaType: 'movie', externalId: 'tt0111161' }],
    ['/play/tt0111161?candidate=abc', { mediaType: 'movie', externalId: 'tt0111161' }],
    ['/play/tt0903747/1/2', { mediaType: 'series', externalId: 'tt0903747:1:2' }],
    ['/play/tt0903747/01/002', { mediaType: 'series', externalId: 'tt0903747:1:2' }],
    ['/play/stremio/movie/tt0111161', { mediaType: 'movie', externalId: 'tt0111161' }],
    ['/play/stremio/series/tt13210838%3A1%3A1', { mediaType: 'series', externalId: 'tt13210838:1:1' }],
    ['/play/stremio/series/tt13210838:1:1', { mediaType: 'series', externalId: 'tt13210838:1:1' }],
  ]
  for (const [path, expected] of cases) assert.deepEqual(parsePlayPath(path), expected, path)
})

test('a path it cannot read yields no lookup', () => {
  for (const path of [
    '', '/play', '/play/12345', '/play/tt0111161/1', '/play/tt0111161/1/2/3', '/stream/tt0111161',
    '/play/stremio/series/kitsu%3A1%3A1', '/play/stremio/movie/tt0111161%3A1%3A1',
    '/play/stremio/series/tt0111161', '/play/stremio/tv/tt0111161', '/play/stremio/series/%E0%A4%A',
  ]) {
    assert.equal(parsePlayPath(path), null, path)
  }
})

test('subtitle streams follow the existing streams and point at this server', () => {
  const [out] = attachSubtitleStreams([source()], TRACKS, '', 'item-1', SHOW_THREE)
  const streams = out.MediaStreams as Stream[]
  assert.equal(streams.length, 5)
  assert.deepEqual(streams[2], {
    Type: 'Subtitle', Index: 2, Codec: 'srt', Language: 'eng', DisplayTitle: 'English 1',
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true,
    DeliveryMethod: 'External', DeliveryUrl: '/Videos/item-1/src/Subtitles/2/0/Stream.srt', IsExternalUrl: false, IsDefault: false,
    Title: 'English 1', IsForced: false, IsHearingImpaired: false, TimeBase: '1/1000', Level: 0,
    Path: '/fetcherr/subtitles/item-1/2.eng.srt',
    LocalizedUndefined: 'Undefined', LocalizedDefault: 'Default', LocalizedForced: 'Forced',
    LocalizedExternal: 'External', LocalizedHearingImpaired: 'Hearing Impaired',
  })
  assert.deepEqual(streams.slice(2).map(stream => [stream.Index, stream.Codec, stream.DeliveryUrl]), [
    [2, 'srt', '/Videos/item-1/src/Subtitles/2/0/Stream.srt'],
    [3, 'srt', '/Videos/item-1/src/Subtitles/3/0/Stream.srt'],
    [4, 'vtt', '/Videos/item-1/src/Subtitles/4/0/Stream.vtt'],
  ])
  assert.equal('DefaultSubtitleStreamIndex' in out, false)
})

test('each subtitle stream names the release its file was made for', () => {
  const tracks: SubtitleTrack[] = [
    { ...TRACKS[0], release: 'Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV' },
    { ...TRACKS[1], release: 'The Jetsons Complete Series' },
    TRACKS[2],
  ]
  const [out] = attachSubtitleStreams([source()], tracks, '', 'item-1', SHOW_THREE)
  assert.deepEqual((out.MediaStreams as Stream[]).slice(2).map(stream => [stream.DisplayTitle, stream.Title]), [
    ['English 1 · 720p WEB-DL myTV', 'English 1 · 720p WEB-DL myTV'],
    ['English 2 · The Jetsons Complete Series', 'English 2 · The Jetsons Complete Series'],
    ['Romanian', 'Romanian'],
  ])
})

test('a preferred language selects its first track and nothing else', () => {
  const [english] = attachSubtitleStreams([source()], TRACKS, 'eng', 'item-1', SHOW_THREE)
  assert.equal(english.DefaultSubtitleStreamIndex, 2)
  assert.deepEqual((english.MediaStreams as Stream[]).slice(2).map(stream => stream.IsDefault), [true, false, false])
  const [romanian] = attachSubtitleStreams([source()], TRACKS, 'rum', 'item-1', SHOW_THREE)
  assert.equal(romanian.DefaultSubtitleStreamIndex, 4)
})

test('a preference with no matching track selects nothing', () => {
  const [out] = attachSubtitleStreams([source()], TRACKS, 'ger', 'item-1', SHOW_THREE)
  assert.equal('DefaultSubtitleStreamIndex' in out, false)
  assert.ok((out.MediaStreams as Stream[]).every(stream => stream.Type !== 'Subtitle' || stream.IsDefault === false))
})

test('indices follow however many streams each source already has', () => {
  const three = { Id: 'three', MediaStreams: [{ Index: 0 }, { Index: 1 }, { Index: 2 }] }
  const [a, b] = attachSubtitleStreams([three, { Id: 'bare' }], TRACKS.slice(0, 1), '', 'item-1', SHOW_THREE)
  assert.equal((a.MediaStreams as Stream[])[3].Index, 3)
  assert.equal((b.MediaStreams as Stream[])[0].Index, 0)
})

test('the sources given are left alone, and no tracks returns them as they were', () => {
  const original = source()
  const [out] = attachSubtitleStreams([original], TRACKS, 'eng', 'item-1', SHOW_THREE)
  assert.notEqual(out, original)
  assert.equal(original.MediaStreams.length, 2)
  assert.equal('DefaultSubtitleStreamIndex' in original, false)
  const untouched = [source()]
  assert.equal(attachSubtitleStreams(untouched, [], 'eng', 'item-1', SHOW_THREE), untouched)
})

test('subtitle files go out with the type Jellyfin uses and the provider\'s charset', () => {
  assert.equal(subtitleContentType('srt', 'application/x-subrip; charset=utf-8'), 'application/x-subrip; charset=utf-8')
  assert.equal(subtitleContentType('vtt', null), 'text/vtt')
  assert.equal(subtitleContentType('ass', 'text/plain; charset=windows-1252'), 'text/x-ssa; charset=windows-1252')
  assert.equal(subtitleContentType('weird', null), 'text/plain')
})

test('the track made for the version\'s file comes first and is the default', () => {
  const [out] = attachSubtitleStreams([source()], JETSONS, 'eng', 'item-1', { perLanguage: 3, fileNameFor: () => FGT_FILE })
  assert.deepEqual(subtitleStreams(out).map(stream => [stream.Index, stream.DisplayTitle, stream.DeliveryUrl, stream.IsDefault]), [
    [2, 'English 1 · 1080p BluRay FGT', '/Videos/item-1/src/Subtitles/2/0/Stream.srt', true],
    [3, 'English 2 · The Jetsons Complete Series', '/Videos/item-1/src/Subtitles/3/0/Stream.srt', false],
    [4, 'English 3 · 720p WEB-DL NTb', '/Videos/item-1/src/Subtitles/4/0/Stream.srt', false],
    [5, 'French', '/Videos/item-1/src/Subtitles/5/0/Stream.srt', false],
  ])
  assert.equal(out.DefaultSubtitleStreamIndex, 2)
})

test('each version shows only its best few per language', () => {
  // French is the third track shown, though the fourth the provider sent, and
  // the default points at where it is shown.
  const [out] = attachSubtitleStreams([source()], JETSONS, 'fre', 'item-1', { perLanguage: 2, fileNameFor: () => FGT_FILE })
  assert.deepEqual(subtitleStreams(out).map(stream => [stream.Index, stream.DisplayTitle, stream.IsDefault]), [
    [2, 'English 1 · 1080p BluRay FGT', false], [3, 'English 2 · The Jetsons Complete Series', false], [4, 'French', true],
  ])
  assert.equal(out.DefaultSubtitleStreamIndex, 4)
})

test('two versions of one title each get the order for their own file', () => {
  const fileNames: Record<string, string> = { bluray: FGT_FILE, web: WEB_FILE }
  const [bluray, web] = attachSubtitleStreams([{ ...source(), Id: 'bluray' }, { ...source(), Id: 'web' }], JETSONS, '', 'item-1', {
    perLanguage: 3,
    fileNameFor: version => fileNames[String(version.Id)] ?? null,
  })
  assert.deepEqual(subtitleStreams(bluray).map(stream => stream.DisplayTitle), [
    'English 1 · 1080p BluRay FGT', 'English 2 · The Jetsons Complete Series', 'English 3 · 720p WEB-DL NTb', 'French',
  ])
  assert.deepEqual(subtitleStreams(web).map(stream => stream.DisplayTitle), [
    'English 1 · 720p WEB-DL NTb', 'English 2 · The Jetsons Complete Series', 'English 3 · 1080p BluRay FGT', 'French',
  ])
})

const NO_FILE = { perLanguage: 3, fileName: null }
const trackIdsAt = (sourceId: string, indices: number[], fallback: { perLanguage: number; fileName: string | null }, tracks = JETSONS) =>
  indices.map(index => subtitleTrackForSource(tracks, sourceId, index, fallback)?.id ?? null)

test('a subtitle fetch gets the track the version listed at that index', () => {
  attachSubtitleStreams([{ ...source(), Id: 'listed' }], JETSONS, '', 'item-1', { perLanguage: 3, fileNameFor: () => FGT_FILE })
  // No file name at fetch time, as once the version's candidate is forgotten:
  // the remembered order still answers.
  assert.deepEqual(trackIdsAt('listed', [0, 1, 2, 3, 4, 5, 6], NO_FILE), [null, null, 'j-fgt', 'j-dvd', 'j-web', 'j-fre', null])
})

test('with no order remembered, a fetch ranks for the version\'s file, or keeps the provider order', () => {
  assert.deepEqual(trackIdsAt('never-listed', [2, 3, 4, 5], { perLanguage: 3, fileName: FGT_FILE }), ['j-fgt', 'j-dvd', 'j-web', 'j-fre'])
  assert.deepEqual(trackIdsAt('never-listed', [2, 3, 4, 5], { perLanguage: 2, fileName: null }), ['j-dvd', 'j-web', 'j-fre', null])
})

test('a remembered order lasts six hours', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  attachSubtitleStreams([{ ...source(), Id: 'expiring' }], JETSONS, '', 'item-1', { perLanguage: 3, fileNameFor: () => FGT_FILE })
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1)
  assert.deepEqual(trackIdsAt('expiring', [2], NO_FILE), ['j-fgt'])
  t.mock.timers.tick(1)
  assert.deepEqual(trackIdsAt('expiring', [2], NO_FILE), ['j-dvd'])
})

test('a listed track the provider no longer offers is not replaced by another', () => {
  attachSubtitleStreams([{ ...source(), Id: 'shrunk' }], JETSONS, '', 'item-1', { perLanguage: 3, fileNameFor: () => FGT_FILE })
  const now = JETSONS.filter(entry => entry.id !== 'j-fgt')
  assert.deepEqual(trackIdsAt('shrunk', [2, 3, 4, 5], NO_FILE, now), [null, 'j-dvd', 'j-web', 'j-fre'])
})

test('at most 5000 orders are remembered, the oldest dropped first', () => {
  for (let i = 0; i <= 5000; i++) rememberSubtitleOrder(`many-${i}`, [`t${i}`])
  assert.equal(rememberedSubtitleOrder('many-0'), null)
  assert.deepEqual(rememberedSubtitleOrder('many-1'), ['t1'])
  assert.deepEqual(rememberedSubtitleOrder('many-5000'), ['t5000'])
})
