export interface NzbSegment {
  messageId: string
  bytes: number
  number: number
}

export interface NzbFile {
  subject: string
  filename: string
  segments: NzbSegment[]
  totalBytes: number
}

export type ParsedNzb =
  | { type: 'direct'; file: NzbFile; estimatedDecodedBytes: number }
  | { type: 'rar';    volumes: NzbFile[] }

const VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'wmv', 'webm'])
const RAR_PATTERN = /\.(?:rar|r\d{2,3}|part\d+\.rar)$/i

function extractFilename(subject: string): string {
  const quoted = subject.match(/"([^"]+\.[a-zA-Z0-9]{2,5})"/)
  if (quoted) return quoted[1]
  const unquoted = subject.match(/\b([\w. -]+\.(?:mkv|mp4|avi|mov|m4v|ts|wmv|webm|rar|r\d{2,3}))\b/i)
  if (unquoted) return unquoted[1]
  return subject.split(' - ')[0].trim()
}

function isVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.has(ext)
}

function isRarFile(filename: string): boolean {
  return RAR_PATTERN.test(filename)
}

function rarSortKey(filename: string): number {
  if (/\.part1\.rar$/i.test(filename) || /\.rar$/i.test(filename)) return 0
  const m = filename.match(/\.part(\d+)\.rar$/i)
  if (m) return parseInt(m[1], 10) - 1
  const r = filename.match(/\.r(\d{2,3})$/i)
  if (r) return parseInt(r[1], 10) + 1  // .r00=1, .r01=2, ...
  return 9999
}

// yEncode decoded size ≈ encoded bytes * (128/130) per line minus header overhead
function estimateDecodedBytes(encodedBytes: number): number {
  return Math.max(0, Math.floor((encodedBytes - 200) * 128 / 130))
}

export function parseNzb(xml: string): ParsedNzb | null {
  const fileMatches = [...xml.matchAll(/<file\b[^>]*>([\s\S]*?)<\/file>/gi)]
  if (!fileMatches.length) return null

  const videoFiles: NzbFile[] = []
  const rarFiles: NzbFile[] = []

  for (const fileMatch of fileMatches) {
    const fileBlock = fileMatch[0]

    const subjectMatch = fileBlock.match(/\bsubject="([^"]*)"/)
    const subject = subjectMatch ? subjectMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : ''
    const filename = extractFilename(subject)

    const segmentMatches = [...fileBlock.matchAll(/<segment\s+bytes="(\d+)"\s+number="(\d+)"[^>]*>([^<]+)<\/segment>/gi)]
    if (!segmentMatches.length) continue

    const segments: NzbSegment[] = segmentMatches.map(m => ({
      messageId: m[3].trim(),
      bytes: parseInt(m[1], 10),
      number: parseInt(m[2], 10),
    }))
    segments.sort((a, b) => a.number - b.number)
    const totalBytes = segments.reduce((sum, s) => sum + s.bytes, 0)
    const file: NzbFile = { subject, filename, segments, totalBytes }

    if (isVideoFile(filename) && !isRarFile(filename)) {
      videoFiles.push(file)
    } else if (isRarFile(filename)) {
      rarFiles.push(file)
    }
  }

  if (videoFiles.length > 0) {
    const mainFile = videoFiles.reduce((best, f) => f.totalBytes > best.totalBytes ? f : best, videoFiles[0])
    return {
      type: 'direct',
      file: mainFile,
      estimatedDecodedBytes: mainFile.segments.reduce((sum, s) => sum + estimateDecodedBytes(s.bytes), 0),
    }
  }

  if (rarFiles.length > 0) {
    rarFiles.sort((a, b) => rarSortKey(a.filename) - rarSortKey(b.filename))
    return { type: 'rar', volumes: rarFiles }
  }

  return null
}

// ── RAR header offset parsing ───────────────────────────────────────────────

function readVint(bytes: Buffer, off: number): { value: number; size: number } {
  let value = 0, shift = 0, size = 0
  while (off < bytes.length && size < 8) {
    const b = bytes[off++]
    size++
    value |= (b & 0x7F) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return { value, size }
}

const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00])

function parseRar5DataOffset(bytes: Buffer): number {
  let off = 8
  while (off + 5 < bytes.length) {
    off += 4  // skip CRC32
    if (off >= bytes.length) break
    const hs = readVint(bytes, off)
    off += hs.size
    const headerDataEnd = off + hs.value
    if (off >= bytes.length) break
    const { value: htype } = readVint(bytes, off)
    if (htype === 2) return headerDataEnd  // FILE block — data follows here
    off = headerDataEnd
  }
  return off
}

function parseRar4DataOffset(bytes: Buffer): number {
  let off = 7  // skip 7-byte signature
  if (off + 6 > bytes.length) return off
  const archHeadSize = bytes.readUInt16LE(off + 5)
  off += archHeadSize  // skip archive header block
  if (off + 6 > bytes.length) return off
  const fileHeadSize = bytes.readUInt16LE(off + 5)
  off += fileHeadSize  // skip file header block → now at packed data
  return off
}

// Returns byte offset where actual file data begins in a decoded RAR volume.
// Returns 0 if bytes don't look like a RAR (treat as raw video data).
export function parseRarDataOffset(bytes: Buffer): number {
  if (bytes.length < 7) return 0
  if (bytes.length >= 8 && bytes.slice(0, 8).equals(RAR5_SIG)) return parseRar5DataOffset(bytes)
  if (bytes.slice(0, 7).equals(RAR4_SIG)) return parseRar4DataOffset(bytes)
  return 0
}

// ── Offset table helpers (used for direct files and per-volume in RAR) ──────

export function buildOffsetTable(segments: NzbSegment[]): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const seg of segments) {
    offsets.push(offset)
    offset += estimateDecodedBytes(seg.bytes)
  }
  return offsets
}

export function segmentIndexForOffset(offsets: number[], byteOffset: number): number {
  for (let i = offsets.length - 1; i >= 0; i--) {
    if (offsets[i] <= byteOffset) return i
  }
  return 0
}

export function estimateDecodedBytesExport(encodedBytes: number): number {
  return estimateDecodedBytes(encodedBytes)
}
