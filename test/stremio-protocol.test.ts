import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, orderPreferredFirst, parseStremioStreamId, parseSubtitleExtra } from '../src/stremio-addon.js'

test('the manifest declares streams and subtitles', () => {
  const m = buildManifest() as Record<string, unknown>
  assert.deepEqual(m.resources, ['stream', 'subtitles'])
  assert.deepEqual(m.types, ['movie', 'series'])
  assert.deepEqual(m.idPrefixes, ['tt'])
  assert.deepEqual(m.catalogs, [])
  assert.equal(typeof m.id, 'string')
  assert.equal(typeof m.version, 'string')
})

test('parses a movie id and strips the .json suffix', () => {
  assert.deepEqual(parseStremioStreamId('movie', 'tt0111161.json'), {
    mediaType: 'movie', imdbId: 'tt0111161', externalId: 'tt0111161',
  })
})

test('parses a series id with season and episode', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747:1:2.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:1:2',
  })
})

test('accepts a percent-encoded series id', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747%3A1%3A2.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:1:2',
  })
})

test('rejects ids and types we do not serve', () => {
  assert.equal(parseStremioStreamId('movie', 'kitsu:12345.json'), null)
  assert.equal(parseStremioStreamId('channel', 'tt0111161.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt0903747.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0111161'), null)
  assert.equal(parseStremioStreamId('movie', '../../etc/passwd.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0111161/../x.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt0903747:1:2:3.json'), null)
})

// One title must have exactly one spelling. externalId keys provider stream
// caches, failed-play caches and per-title accounting, so every padded variant
// would buy its own cache miss and its own billed provider round-trip.

test('canonicalizes a zero-padded season and episode', () => {
  assert.equal(parseStremioStreamId('series', 'tt0903747:01:002.json')?.externalId, 'tt0903747:1:2')
})

test('canonicalizes the widest padding to the same id', () => {
  assert.equal(parseStremioStreamId('series', 'tt0903747:0001:0002.json')?.externalId, 'tt0903747:1:2')
})

test('accepts season 0, because specials really are season 0', () => {
  assert.deepEqual(parseStremioStreamId('series', 'tt0903747:0:1.json'), {
    mediaType: 'series', imdbId: 'tt0903747', externalId: 'tt0903747:0:1',
  })
})

test('rejects a padded IMDB id, which IMDB never issued', () => {
  assert.equal(parseStremioStreamId('movie', 'tt00111161.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt000111161.json'), null)
  assert.equal(parseStremioStreamId('movie', 'tt0000111161.json'), null)
  assert.equal(parseStremioStreamId('series', 'tt00903747:1:2.json'), null)
})

test('accepts an 8-digit IMDB id with no leading zero', () => {
  assert.deepEqual(parseStremioStreamId('movie', 'tt10872600.json'), {
    mediaType: 'movie', imdbId: 'tt10872600', externalId: 'tt10872600',
  })
})

test('returns null on non-string input instead of throwing', () => {
  assert.equal(parseStremioStreamId('movie', undefined as never), null)
  assert.equal(parseStremioStreamId('movie', null as never), null)
  assert.equal(parseStremioStreamId('movie', 123 as never), null)
  assert.equal(parseStremioStreamId('movie', {} as never), null)
})

test('the subtitle extra segment yields the file details a provider can match on', () => {
  assert.deepEqual(
    parseSubtitleExtra('videoHash=8E245D9679D31E12&videoSize=652696576&filename=The.Movie.2019.1080p.mkv.json'),
    { videoHash: '8e245d9679d31e12', videoSize: '652696576', filename: 'The.Movie.2019.1080p.mkv' },
  )
  assert.deepEqual(parseSubtitleExtra('filename=Tom%20%26%20Jerry%20(1940).mkv.json'), { filename: 'Tom & Jerry (1940).mkv' })
})

test('anything in the extra segment that is not a plausible file detail is dropped', () => {
  assert.deepEqual(parseSubtitleExtra('videoHash=nothex&videoSize=-1&token=abc.json'), {})
  assert.deepEqual(parseSubtitleExtra(`filename=${'a'.repeat(256)}.json`), {})
  assert.deepEqual(parseSubtitleExtra('filename=bad%0Aname.mkv.json'), {})
  assert.equal(parseSubtitleExtra('videoHash=8e245d9679d31e12'), null)
  assert.equal(parseSubtitleExtra(42 as never), null)
})

test('the preferred language moves to the front and nothing else moves', () => {
  const tracks = [{ lang: 'eng', id: 'a' }, { lang: 'rum', id: 'b' }, { lang: 'eng', id: 'c' }, { lang: 'rum', id: 'd' }]
  assert.deepEqual(orderPreferredFirst(tracks, 'rum').map(track => track.id), ['b', 'd', 'a', 'c'])
  assert.deepEqual(orderPreferredFirst(tracks, '').map(track => track.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(orderPreferredFirst(tracks, 'ger').map(track => track.id), ['a', 'b', 'c', 'd'])
})
