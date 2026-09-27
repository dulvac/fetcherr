import test from 'node:test'
import assert from 'node:assert/strict'
import { attachSubtitleStreams, parsePlayPath } from '../src/subtitle-streams.js'
import type { SubtitleTrack } from '../src/subtitles.js'

const TRACKS: SubtitleTrack[] = [
  { id: '1-a', url: 'https://subs.example/a', lang: 'eng', label: 'English 1', format: 'srt' },
  { id: '1-b', url: 'https://subs.example/b', lang: 'eng', label: 'English 2', format: 'srt' },
  { id: '1-c', url: 'https://subs.example/c.vtt', lang: 'rum', label: 'Romanian', format: 'vtt' },
]

const source = () => ({
  Id: 'src',
  MediaStreams: [
    { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true },
    { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, Language: 'eng' },
  ],
})

type Stream = Record<string, unknown>

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

test('subtitle streams follow the existing streams and point at the provider', () => {
  const [out] = attachSubtitleStreams([source()], TRACKS, '')
  const streams = out.MediaStreams as Stream[]
  assert.equal(streams.length, 5)
  assert.deepEqual(streams[2], {
    Type: 'Subtitle', Index: 2, Codec: 'srt', Language: 'eng', DisplayTitle: 'English 1',
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true,
    DeliveryMethod: 'External', DeliveryUrl: 'https://subs.example/a', IsExternalUrl: true, IsDefault: false,
  })
  assert.deepEqual(streams.slice(2).map(stream => [stream.Index, stream.Codec, stream.DeliveryUrl]), [
    [2, 'srt', 'https://subs.example/a'],
    [3, 'srt', 'https://subs.example/b'],
    [4, 'vtt', 'https://subs.example/c.vtt'],
  ])
  assert.equal('DefaultSubtitleStreamIndex' in out, false)
})

test('a preferred language selects its first track and nothing else', () => {
  const [english] = attachSubtitleStreams([source()], TRACKS, 'eng')
  assert.equal(english.DefaultSubtitleStreamIndex, 2)
  assert.deepEqual((english.MediaStreams as Stream[]).slice(2).map(stream => stream.IsDefault), [true, false, false])
  const [romanian] = attachSubtitleStreams([source()], TRACKS, 'rum')
  assert.equal(romanian.DefaultSubtitleStreamIndex, 4)
})

test('a preference with no matching track selects nothing', () => {
  const [out] = attachSubtitleStreams([source()], TRACKS, 'ger')
  assert.equal('DefaultSubtitleStreamIndex' in out, false)
  assert.ok((out.MediaStreams as Stream[]).every(stream => stream.Type !== 'Subtitle' || stream.IsDefault === false))
})

test('indices follow however many streams each source already has', () => {
  const three = { Id: 'three', MediaStreams: [{ Index: 0 }, { Index: 1 }, { Index: 2 }] }
  const [a, b] = attachSubtitleStreams([three, { Id: 'bare' }], TRACKS.slice(0, 1), '')
  assert.equal((a.MediaStreams as Stream[])[3].Index, 3)
  assert.equal((b.MediaStreams as Stream[])[0].Index, 0)
})

test('the sources given are left alone, and no tracks returns them as they were', () => {
  const original = source()
  const [out] = attachSubtitleStreams([original], TRACKS, 'eng')
  assert.notEqual(out, original)
  assert.equal(original.MediaStreams.length, 2)
  assert.equal('DefaultSubtitleStreamIndex' in original, false)
  const untouched = [source()]
  assert.equal(attachSubtitleStreams(untouched, [], 'eng'), untouched)
})
