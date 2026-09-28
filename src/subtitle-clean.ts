// Some providers weave an ad into the file itself, where a Jellyfin subtitle
// track has no way to skip it. OpenSubtitles v3+ answers every WebVTT request
// with a header, a banner cue disguised as a second file, a repeated header,
// then the real cues; OpenSubtitles.org's SRT files carry an ad cue at either
// end. This drops both kinds before a client ever sees the file.

type Format = 'vtt' | 'srt' | null

// Case-insensitive, and matched after decoding the three entities providers use
// in their banner text, so &gt;&gt;OpenSubtitles v3+&lt;&lt; still counts.
const AD_PHRASES = [
  'opensubtitles v3+',
  'osdb.link',
  'become vip member',
  'advertise your product or brand here',
]

export function stripAdCues(body: Buffer): Buffer {
  const hasBOM = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text: string
  try {
    // A fatal decode also strips a leading BOM, so hasBOM above is read from
    // the bytes, not from the decoded string.
    text = decoder.decode(body)
  } catch {
    return body
  }

  // ASS/SSA cues (Dialogue: ...) never use -->, but a Dialogue line's own free
  // text can contain one coincidentally, which would otherwise read as SRT and
  // risk dropping a whole [Events] block over one line's wording. The real
  // format tag is always the file's first line once a BOM and any leading
  // whitespace are out of the way.
  if (text.trimStart().startsWith('[Script Info]')) return body

  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  // The output's own leading and trailing line endings are ours to set, not the
  // input's, so a run of blank lines at either edge is not a block of its own.
  const normalized = text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const format: Format = normalized.startsWith('WEBVTT')
    ? 'vtt'
    : normalized.split('\n').some(line => line.includes('-->')) ? 'srt' : null
  if (!format) return body

  // A line holding only spaces or tabs separates blocks the same as an empty
  // line does: providers do not always leave a truly blank line around an
  // inserted ad.
  const blocks = normalized.split(/\n(?:[ \t]*\n)+/).filter(block => block.length > 0).map(block => block.split('\n'))
  const kept: string[][] = []
  let dropped = false

  blocks.forEach((lines, index) => {
    const arrowIndex = lines.findIndex(line => line.includes('-->'))
    const isCue = arrowIndex !== -1
    const arrowCount = lines.filter(line => line.includes('-->')).length
    // The header is never checked: the first block in a WebVTT file always is one.
    if (format === 'vtt' && index === 0) {
      kept.push(lines)
      return
    }
    // A later block that repeats the header, alone or with no cue in it.
    if (format === 'vtt' && lines[0].trim() === 'WEBVTT' && !isCue) {
      dropped = true
      return
    }
    // More than one cue in a block means two cues ran together with no blank
    // line between them. Which cue the ad phrase belongs to is then unknown,
    // so the whole block is kept rather than risk taking a real cue down with it.
    if (isCue && arrowCount === 1 && isAdCue(lines.slice(arrowIndex + 1))) {
      dropped = true
      return
    }
    kept.push(lines)
  })

  if (!dropped) return body
  if (format === 'srt') renumber(kept)

  const rebuilt = kept.map(lines => lines.join(lineEnding)).join(lineEnding + lineEnding) + lineEnding
  return Buffer.from(new TextEncoder().encode(hasBOM ? `\uFEFF${rebuilt}` : rebuilt))
}

function isAdCue(textLines: string[]): boolean {
  const decoded = textLines.join('\n')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .toLowerCase()
  return AD_PHRASES.some(phrase => decoded.includes(phrase))
}

// Every surviving cue gets the next number in order; a cue whose first line was
// not a number stays without one, but still takes its place in the count.
function renumber(blocks: string[][]): void {
  let n = 1
  for (const lines of blocks) {
    if (!lines.some(line => line.includes('-->'))) continue
    if (/^\d+$/.test(lines[0].trim())) lines[0] = String(n)
    n++
  }
}
