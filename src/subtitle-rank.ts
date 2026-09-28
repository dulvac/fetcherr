// Which release a subtitle file was made for, read from the release name the
// provider gives, and how closely that release matches the file a version plays.
// A subtitle matched by title alone is often out of sync, and files cut from the
// same release by the same group are the ones that line up.

export type SourceFamily = 'bluray' | 'web' | 'hdtv' | 'dvd'
export interface ReleaseTags { resolution: string | null; family: SourceFamily | null; source: string | null; group: string | null }

// Release names come from provider JSON and from callers that build tracks by
// hand, so anything that is not a string reads as no release rather than
// throwing into PlaybackInfo.
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Every spelling of a source, by family. Releases from one family share their
// cut and frame rate far more often than releases across families.
const SOURCE_WORDS: Record<SourceFamily, readonly string[]> = {
  bluray: ['BluRay', 'Blu-Ray', 'BDRip', 'BRRip', 'BD25', 'BD50', 'Remux'],
  web: ['WEB-DL', 'WEBDL', 'WEBRip', 'WEB', 'AMZN', 'NF', 'DSNP', 'HMAX', 'ATVP'],
  hdtv: ['HDTV', 'PDTV'],
  dvd: ['DVDRip', 'DVD', 'DVD5', 'DVD9', 'DVDScr'],
}

const FAMILY_BY_WORD = new Map<string, SourceFamily>()
for (const [family, words] of Object.entries(SOURCE_WORDS) as Array<[SourceFamily, readonly string[]]>) {
  for (const word of words) FAMILY_BY_WORD.set(word.toLowerCase(), family)
}

// A word is only a tag when it stands alone. Dots, spaces, underscores, dashes
// and brackets all separate words in release names, so the edges are "not a
// letter or digit" rather than \b, which counts _ as part of a word.
const alone = (pattern: string) => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'gi')

// Longest first, so WEB-DL is read as itself and not as WEB.
const SOURCE = alone([...FAMILY_BY_WORD.keys()].sort((a, b) => b.length - a.length).join('|'))
const RESOLUTION = alone('2160p|1080p|720p|576p|480p')
const UHD = alone('4k|uhd')

// Only an extension a video or subtitle file has, so a name that ends in .UNIV
// or .en keeps its last word.
const EXTENSION = /\.(?:mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|srt|vtt|ass|ssa|sub|idx|smi|txt)$/i
const BRACKETED_SUFFIX = /\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/
// 2 to 12 letters or digits after the last hyphen. At least one letter, so an
// episode range like S01E01-02 is not read as a group.
const GROUP = /-(?=[A-Za-z0-9]*[A-Za-z])([A-Za-z0-9]{2,12})$/

export function releaseTags(text: string): ReleaseTags {
  const input = asText(text)
  const resolution = matches(input, RESOLUTION)[0]?.toLowerCase() ?? (matches(input, UHD).length ? '2160p' : null)

  // The last source word is the release's own: a title can contain one too, as
  // in Charlotte's Web, and titles come first.
  const sources = matches(input, SOURCE)
  const source = sources.at(-1) ?? null
  const family = source ? FAMILY_BY_WORD.get(source.toLowerCase()) ?? null : null

  let rest = input.trim().replace(EXTENSION, '')
  while (BRACKETED_SUFFIX.test(rest)) rest = rest.replace(BRACKETED_SUFFIX, '')
  // WEB-DL at the very end is a source, not a group called DL.
  const endsInSource = source !== null && source.includes('-') && rest.toLowerCase().endsWith(source.toLowerCase())
  const group = endsInSource ? null : rest.match(GROUP)?.[1] ?? null

  return { resolution, family, source, group }
}

// matchAll works on a copy of the pattern, so the shared global patterns above
// carry no lastIndex from one call into the next, as .test would.
function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(match => match[0])
}

const FALLBACK_LABEL_LENGTH = 40
const WORD_BREAK = /[\s._-]/

// "720p WEB-DL myTV". A release with no readable tags is shown by the start of
// its name, which still tells two such files apart.
export function releaseLabel(release: string): string {
  const name = asText(release)
  const { resolution, source, group } = releaseTags(name)
  const tags = [resolution, source, group].filter(Boolean)
  if (tags.length) return tags.join(' ')
  const trimmed = name.trim()
  if (trimmed.length <= FALLBACK_LABEL_LENGTH) return trimmed
  let cut = FALLBACK_LABEL_LENGTH
  while (cut > 0 && !WORD_BREAK.test(trimmed[cut])) cut--
  return (cut > 0 ? trimmed.slice(0, cut) : trimmed.slice(0, FALLBACK_LABEL_LENGTH)).replace(/[\s._-]+$/, '')
}

// The group counts most, since one group's files share one cut; then the source
// family, whose releases usually share a frame rate; then the resolution.
export function matchScore(release: string, fileName: string): number {
  const releaseText = asText(release)
  const fileNameText = asText(fileName)
  if (!releaseText.trim() || !fileNameText.trim()) return 0
  return scoreTags(releaseTags(releaseText), releaseTags(fileNameText))
}

function scoreTags(release: ReleaseTags, file: ReleaseTags): number {
  let score = 0
  if (release.group && file.group && release.group.toLowerCase() === file.group.toLowerCase()) score += 3
  if (release.family && release.family === file.family) score += 2
  if (release.resolution && release.resolution === file.resolution) score += 1
  return score
}

export function rankForFile<T extends { lang: string; release: string }>(tracks: T[], fileName: string | null, perLanguage: number): T[] {
  const byLanguage = new Map<string, T[]>()
  for (const track of tracks) {
    const list = byLanguage.get(track.lang)
    if (list) list.push(track)
    else byLanguage.set(track.lang, [track])
  }
  // Read once, not once per track.
  const file = fileName?.trim() ? releaseTags(fileName) : null
  const ranked: T[] = []
  for (const list of byLanguage.values()) {
    const ordered = file
      // Array sort is stable, so equal scores keep the provider's order.
      ? list
        .map(track => ({ track, score: asText(track.release).trim() ? scoreTags(releaseTags(asText(track.release)), file) : 0 }))
        .sort((a, b) => b.score - a.score)
        .map(entry => entry.track)
      : list
    ranked.push(...ordered.slice(0, perLanguage))
  }
  return ranked
}
