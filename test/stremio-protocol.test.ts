import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, parseStremioStreamId } from '../src/stremio-addon.js'

test('the manifest declares a stream-only addon', () => {
  const m = buildManifest() as Record<string, unknown>
  assert.deepEqual(m.resources, ['stream'])
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
