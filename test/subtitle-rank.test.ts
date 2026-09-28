import test from 'node:test'
import assert from 'node:assert/strict'
import { matchScore, rankForFile, releaseLabel, releaseTags } from '../src/subtitle-rank.js'

test('release names give up their resolution, source and group', () => {
  const cases: Array<[string, ReturnType<typeof releaseTags>]> = [
    ['Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV',
      { resolution: '720p', family: 'web', source: 'WEB-DL', group: 'myTV' }],
    ['The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT.mkv',
      { resolution: '1080p', family: 'bluray', source: 'BluRay', group: 'FGT' }],
    // The encoder's name sits inside the brackets, not after a hyphen.
    ['The Jetsons (1962) - S01E01 - Rosey the Robot (1080p BluRay x265 RZeroX).mkv',
      { resolution: '1080p', family: 'bluray', source: 'BluRay', group: null }],
    ['Monk S01E01E02 Mr. Monk and the Candidate Part 1_2.DVDRip.NonHI.en.UNIV',
      { resolution: null, family: 'dvd', source: 'DVDRip', group: null }],
    ['The Jetsons Complete Series',
      { resolution: null, family: null, source: null, group: null }],
    // The last source word is the one kept, so a Remux reads as one.
    ['Show.S01E01.2160p.UHD.BluRay.Remux-GRP',
      { resolution: '2160p', family: 'bluray', source: 'Remux', group: 'GRP' }],
    ['Monk - 1x01 - Mr. Monk and the Candidate_WEBRip_1h18m24s',
      { resolution: null, family: 'web', source: 'WEBRip', group: null }],
    ['Movie.2019.4K.HDR.WEB.H265-GRP',
      { resolution: '2160p', family: 'web', source: 'WEB', group: 'GRP' }],
    ['Show.S02E03.HDTV.x264-KILLERS[rarbg]',
      { resolution: null, family: 'hdtv', source: 'HDTV', group: 'KILLERS' }],
    // A title word that is also a source word loses to the release's own.
    ["Charlotte's.Web.2006.1080p.BluRay.x264-GRP",
      { resolution: '1080p', family: 'bluray', source: 'BluRay', group: 'GRP' }],
    ['tj.s01.e01-vRs',
      { resolution: null, family: null, source: null, group: 'vRs' }],
    // A final -TOKEN is the group even when it names a codec.
    ['Movie.2012.DVD9.x264-AC3',
      { resolution: null, family: 'dvd', source: 'DVD9', group: 'AC3' }],
    // Hyphenated codec and source words, an episode range and an overlong tail
    // are not groups.
    ['Movie.2010.1080p.BluRay.DTS-HD.MA.5.1.x264',
      { resolution: '1080p', family: 'bluray', source: 'BluRay', group: null }],
    ['Movie.2010.720p.WEB-DL',
      { resolution: '720p', family: 'web', source: 'WEB-DL', group: null }],
    ['Monk S01E01-02',
      { resolution: null, family: null, source: null, group: null }],
    ['Show.S01E01.1080p.WEB-DL.H264-ThisNameIsTooLong',
      { resolution: '1080p', family: 'web', source: 'WEB-DL', group: null }],
  ]
  for (const [name, expected] of cases) assert.deepEqual(releaseTags(name), expected, name)
})

test('a release is labelled by its tags, or by its name when it has none', () => {
  assert.equal(releaseLabel('Monk.S01E01.Mr.Monk.and.the.Candidate.720p.WEB-DL.H264.AAC20-myTV'), '720p WEB-DL myTV')
  assert.equal(releaseLabel('Monk S01E01E02 Mr. Monk and the Candidate Part 1_2.DVDRip.NonHI.en.UNIV'), 'DVDRip')
  assert.equal(releaseLabel('The Jetsons Complete Series'), 'The Jetsons Complete Series')
  // Longer than 40 characters: cut at the last word boundary inside the 40.
  assert.equal(releaseLabel('Monk - S01E01 - Mr. Monk and the Candidate (1)'), 'Monk - S01E01 - Mr. Monk and the')
  assert.equal(releaseLabel('Mr.Monk.and.the.Candidate.Part.One.Extended.Cut'), 'Mr.Monk.and.the.Candidate.Part.One')
  assert.equal(releaseLabel('A'.repeat(50)), 'A'.repeat(40))
  assert.equal(releaseLabel(''), '')
})

test('a release scores 3 for its group, 2 for its source family and 1 for its resolution', () => {
  const cases: Array<[string, string, number]> = [
    ['The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT', 'The.Jetsons.S01E01.1080p.BDRip.x265-fgt.mkv', 6],
    ['Show.S01E01.720p.HDTV.x264-FGT', 'Show.S01E01.1080p.BluRay.x264-FGT.mkv', 3],
    ['Show.S01E01.720p.WEBRip.x264-AAA', 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1-BBB.mkv', 2],
    ['Show.S01E01.1080p.HDTV.x264-AAA', 'Show.S01E01.1080p.BluRay.x264-BBB.mkv', 1],
    ['The Jetsons Complete Series', 'The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT.mkv', 0],
    ['The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT', '', 0],
    ['', 'The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT.mkv', 0],
  ]
  for (const [release, fileName, score] of cases) assert.equal(matchScore(release, fileName), score, `${release} vs ${fileName}`)
})

const track = (id: string, lang: string, release: string) => ({ id, lang, release })
const FILE = 'The.Jetsons.S01E01.1080p.BluRay.x264.DTS-FGT.mkv'
const TRACKS = [
  track('e1', 'eng', 'The Jetsons Complete Series'),
  track('e2', 'eng', 'tj.s01.e01-vRs'),
  track('e3', 'eng', 'The.Jetsons.S01E01.1080p.BluRay.x264-FGT'),
  track('f1', 'fre', 'Jetsons.720p.WEB-DL-XYZ'),
  track('f2', 'fre', 'Jetsons.1080p.BDRip-ABC'),
  track('r1', 'rum', ''),
]
const ids = (tracks: Array<{ id: string }>) => tracks.map(entry => entry.id)

test('the best match for the file comes first within each language, ties in provider order', () => {
  assert.deepEqual(ids(rankForFile(TRACKS, FILE, 3)), ['e3', 'e1', 'e2', 'f2', 'f1', 'r1'])
})

test('languages keep the order they first appear in, whatever their scores', () => {
  const mixed = [TRACKS[3], TRACKS[0], TRACKS[4], TRACKS[2]]
  assert.deepEqual(ids(rankForFile(mixed, FILE, 3)), ['f2', 'f1', 'e3', 'e1'])
})

test('each language keeps only its best few', () => {
  assert.deepEqual(ids(rankForFile(TRACKS, FILE, 1)), ['e3', 'f2', 'r1'])
})

test('with no file name the provider order stands and only the cap applies', () => {
  assert.deepEqual(ids(rankForFile(TRACKS, null, 2)), ['e1', 'e2', 'f1', 'f2', 'r1'])
  assert.deepEqual(ids(rankForFile(TRACKS, '', 2)), ['e1', 'e2', 'f1', 'f2', 'r1'])
})
