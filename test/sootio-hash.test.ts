import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHashFromStream } from '../src/sootio.js'

const HASH = 'a'.repeat(40)

test('extracts an infohash from an AIOStreams playback URL', () => {
  const blob = Buffer.from(JSON.stringify({ hash: HASH })).toString('base64')
  const url = `http://192.168.87.33:3002/api/v1/debrid/playback/auth/${blob}/f.mkv`
  assert.equal(extractHashFromStream({ url }), HASH)
})

test('falls back to the infoHash field', () => {
  assert.equal(extractHashFromStream({ infoHash: HASH.toUpperCase() }), HASH)
})

test('returns null when nothing carries a hash', () => {
  assert.equal(extractHashFromStream({ url: 'https://example.test/video.mkv' }), null)
})

// aiostreams puts a content hash of the NZB in its usenet playback URLs. It is
// not a torrent: taking it for one sends the play to the debrid hash resolver,
// which cannot know it, and lists the stream in the Stremio addon as a torrent.
test('an AIOStreams usenet playback URL carries no infohash', () => {
  const blob = Buffer.from(JSON.stringify({ type: 'usenet', nzb: 'https://api.nzbgeek.info/api?t=get', hash: HASH })).toString('base64')
  const url = `http://192.168.87.33:3002/api/v1/debrid/playback/auth/${blob}/${'b'.repeat(64)}/f.mkv`
  assert.equal(extractHashFromStream({ url }), null)
})

test('an AIOStreams torrent playback URL still carries its infohash', () => {
  const blob = Buffer.from(JSON.stringify({ type: 'torrent', hash: HASH })).toString('base64')
  const url = `http://192.168.87.33:3002/api/v1/debrid/playback/auth/${blob}/${'b'.repeat(64)}/f.mkv`
  assert.equal(extractHashFromStream({ url }), HASH)
})
