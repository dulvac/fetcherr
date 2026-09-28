import test from 'node:test'
import assert from 'node:assert/strict'
import { stripAdCues } from '../src/subtitle-clean.js'

// The exact shape every OpenSubtitles v3+ file measured on 2026-09-28 has: a
// header, a banner cue disguised as a second file, a repeated header, then the
// real cues.
function v3PlusBody(extraCues: string[]): Buffer {
  return Buffer.from([
    'WEBVTT',
    '',
    'header',
    '00:00:01.000 --> 00:00:06.000',
    '&gt;&gt;OpenSubtitles v3+ v0.0.4&lt;&lt;',
    '<u>=&gt;Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV.srt</u>',
    '',
    'WEBVTT',
    '',
    '1',
    '00:00:45.602 --> 00:00:46.972',
    'The stove.',
    '',
    ...extraCues,
  ].join('\n'))
}

test('an OpenSubtitles v3+ file loses its banner and repeated header', () => {
  const body = v3PlusBody([
    '2',
    '00:00:48.000 --> 00:00:50.000',
    'Watch your step.',
    '',
    '3',
    '00:00:52.000 --> 00:00:54.000',
    'This way.',
    '',
  ])
  const cleaned = stripAdCues(body).toString('utf-8')
  assert.equal(cleaned, [
    'WEBVTT',
    '',
    '1',
    '00:00:45.602 --> 00:00:46.972',
    'The stove.',
    '',
    '2',
    '00:00:48.000 --> 00:00:50.000',
    'Watch your step.',
    '',
    '3',
    '00:00:52.000 --> 00:00:54.000',
    'This way.',
    '',
  ].join('\n'))
  assert.equal(/OpenSubtitles/i.test(cleaned), false)
  assert.equal(cleaned.match(/^WEBVTT$/gm)?.length, 1)
})

test('an SRT loses its ad cue at either end and is renumbered, keeping CRLF', () => {
  const body = Buffer.from([
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Advertise your product or brand here',
    '',
    '2',
    '00:00:05,000 --> 00:00:07,000',
    'Hello there',
    '',
    '3',
    '00:00:10,000 --> 00:00:12,000',
    'Support us and become VIP member to remove all ads from www.OpenSubtitles.org',
    '',
  ].join('\r\n'))
  const cleaned = stripAdCues(body)
  assert.equal(cleaned.toString('utf-8'), [
    '1',
    '00:00:05,000 --> 00:00:07,000',
    'Hello there',
    '',
  ].join('\r\n'))
})

test('an SRT loses an osdb.link ad cue', () => {
  const body = Buffer.from([
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Hello there',
    '',
    '2',
    '00:00:05,000 --> 00:00:07,000',
    'Watch Online Movies and Series for FREE www.osdb.link/lm',
    '',
  ].join('\n'))
  const cleaned = stripAdCues(body).toString('utf-8')
  assert.equal(cleaned, [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Hello there',
    '',
  ].join('\n'))
})

test('a clean SRT and a clean VTT come back as the exact same buffer', () => {
  const srt = Buffer.from([
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Hello there',
    '',
    '2',
    '00:00:05,000 --> 00:00:07,000',
    'Goodbye',
    '',
  ].join('\r\n'))
  assert.strictEqual(stripAdCues(srt), srt)

  const vtt = Buffer.from([
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:00:02.000',
    'Hello there',
    '',
  ].join('\n'))
  assert.strictEqual(stripAdCues(vtt), vtt)
})

test('an ASS file mentioning OpenSubtitles v3+ in a Dialogue line is unchanged', () => {
  const body = Buffer.from([
    '[Script Info]',
    'Title: Default Aegisub file',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,OpenSubtitles v3+ credit line',
    '',
  ].join('\n'))
  assert.strictEqual(stripAdCues(body), body)
})

test('bytes that are not valid UTF-8 are unchanged', () => {
  const body = Buffer.concat([
    Buffer.from(['1', '00:00:00,000 --> 00:00:02,000', 'Hello there', ''].join('\n')),
    Buffer.from([0xff, 0xfe, 0x41, 0xe9, 0x0a]),
  ])
  assert.strictEqual(stripAdCues(body), body)
})

test('a leading BOM is kept in the output', () => {
  const body = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'Advertise your product or brand here',
      '',
      '2',
      '00:00:05,000 --> 00:00:07,000',
      'Hello there',
      '',
    ].join('\n')),
  ])
  const cleaned = stripAdCues(body)
  assert.equal(cleaned[0], 0xef)
  assert.equal(cleaned[1], 0xbb)
  assert.equal(cleaned[2], 0xbf)
  assert.equal(cleaned.subarray(3).toString('utf-8'), [
    '1',
    '00:00:05,000 --> 00:00:07,000',
    'Hello there',
    '',
  ].join('\n'))
})

test('a cue that mentions OpenSubtitles without v3+ is kept', () => {
  const body = Buffer.from([
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Advertise your product or brand here',
    '',
    '2',
    '00:00:05,000 --> 00:00:07,000',
    'Synced by X for OpenSubtitles',
    '',
  ].join('\n'))
  const cleaned = stripAdCues(body).toString('utf-8')
  assert.equal(cleaned, [
    '1',
    '00:00:05,000 --> 00:00:07,000',
    'Synced by X for OpenSubtitles',
    '',
  ].join('\n'))
})
