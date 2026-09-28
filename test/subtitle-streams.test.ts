import test from 'node:test'
import assert from 'node:assert/strict'
import { attachSubtitleStreams, parsePlayPath, subtitleContentType } from '../src/subtitle-streams.js'
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
  const [out] = attachSubtitleStreams([source()], TRACKS, '', 'item-1')
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
  const [out] = attachSubtitleStreams([source()], tracks, '', 'item-1')
  assert.deepEqual((out.MediaStreams as Stream[]).slice(2).map(stream => [stream.DisplayTitle, stream.Title]), [
    ['English 1 · 720p WEB-DL myTV', 'English 1 · 720p WEB-DL myTV'],
    ['English 2 · The Jetsons Complete Series', 'English 2 · The Jetsons Complete Series'],
    ['Romanian', 'Romanian'],
  ])
})

test('a preferred language selects its first track and nothing else', () => {
  const [english] = attachSubtitleStreams([source()], TRACKS, 'eng', 'item-1')
  assert.equal(english.DefaultSubtitleStreamIndex, 2)
  assert.deepEqual((english.MediaStreams as Stream[]).slice(2).map(stream => stream.IsDefault), [true, false, false])
  const [romanian] = attachSubtitleStreams([source()], TRACKS, 'rum', 'item-1')
  assert.equal(romanian.DefaultSubtitleStreamIndex, 4)
})

test('a preference with no matching track selects nothing', () => {
  const [out] = attachSubtitleStreams([source()], TRACKS, 'ger', 'item-1')
  assert.equal('DefaultSubtitleStreamIndex' in out, false)
  assert.ok((out.MediaStreams as Stream[]).every(stream => stream.Type !== 'Subtitle' || stream.IsDefault === false))
})

test('indices follow however many streams each source already has', () => {
  const three = { Id: 'three', MediaStreams: [{ Index: 0 }, { Index: 1 }, { Index: 2 }] }
  const [a, b] = attachSubtitleStreams([three, { Id: 'bare' }], TRACKS.slice(0, 1), '', 'item-1')
  assert.equal((a.MediaStreams as Stream[])[3].Index, 3)
  assert.equal((b.MediaStreams as Stream[])[0].Index, 0)
})

test('the sources given are left alone, and no tracks returns them as they were', () => {
  const original = source()
  const [out] = attachSubtitleStreams([original], TRACKS, 'eng', 'item-1')
  assert.notEqual(out, original)
  assert.equal(original.MediaStreams.length, 2)
  assert.equal('DefaultSubtitleStreamIndex' in original, false)
  const untouched = [source()]
  assert.equal(attachSubtitleStreams(untouched, [], 'eng', 'item-1'), untouched)
})

test('subtitle files go out with the type Jellyfin uses and the provider\'s charset', () => {
  assert.equal(subtitleContentType('srt', 'application/x-subrip; charset=utf-8'), 'application/x-subrip; charset=utf-8')
  assert.equal(subtitleContentType('vtt', null), 'text/vtt')
  assert.equal(subtitleContentType('ass', 'text/plain; charset=windows-1252'), 'text/x-ssa; charset=windows-1252')
  assert.equal(subtitleContentType('weird', null), 'text/plain')
})
