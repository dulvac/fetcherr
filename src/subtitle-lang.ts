// One vocabulary for subtitle languages: ISO 639-2/B three-letter codes. Jellyfin
// clients read it from a stream's Language, the Stremio protocol carries it in
// lang, and an account's preferred language is stored in it, so all three compare
// directly with no further mapping.
//
// Providers do not agree on spelling. The official OpenSubtitles addon sends fre
// and ger (B forms) next to ron, nld and ces (T forms), and other addons send en
// or English. Every spelling is folded here, once, on the way in.

export interface SubtitleLanguage {
  code: string
  name: string
  aliases: readonly string[]
}

// Aliases are lowercase. The code and the lowercased name match without being
// listed. A few aliases are OpenSubtitles' own codes (pob, pom, scc, ze, zht and
// the like): not ISO, but they do arrive from providers.
export const SUBTITLE_LANGUAGES: readonly SubtitleLanguage[] = [
  { code: 'eng', name: 'English', aliases: ['en'] },
  { code: 'fre', name: 'French', aliases: ['fr', 'fra', 'francais', 'français'] },
  { code: 'rum', name: 'Romanian', aliases: ['ro', 'ron', 'romana', 'română', 'mo', 'mol', 'moldavian'] },
  { code: 'ger', name: 'German', aliases: ['de', 'deu', 'deutsch'] },
  { code: 'spa', name: 'Spanish', aliases: ['es', 'espanol', 'español', 'castellano', 'spl', 'spn', 'ea'] },
  { code: 'ita', name: 'Italian', aliases: ['it', 'italiano'] },
  { code: 'por', name: 'Portuguese', aliases: ['pt', 'portugues', 'português', 'brazilian', 'pob', 'pom'] },
  { code: 'dut', name: 'Dutch', aliases: ['nl', 'nld', 'nederlands', 'flemish'] },
  { code: 'pol', name: 'Polish', aliases: ['pl', 'polski'] },
  { code: 'rus', name: 'Russian', aliases: ['ru'] },
  { code: 'ukr', name: 'Ukrainian', aliases: ['uk'] },
  { code: 'cze', name: 'Czech', aliases: ['cs', 'ces'] },
  { code: 'slo', name: 'Slovak', aliases: ['sk', 'slk'] },
  { code: 'slv', name: 'Slovenian', aliases: ['sl', 'slovene'] },
  { code: 'hrv', name: 'Croatian', aliases: ['hr', 'scr'] },
  { code: 'srp', name: 'Serbian', aliases: ['sr', 'scc'] },
  { code: 'bos', name: 'Bosnian', aliases: ['bs'] },
  { code: 'bul', name: 'Bulgarian', aliases: ['bg'] },
  { code: 'mac', name: 'Macedonian', aliases: ['mk', 'mkd'] },
  { code: 'alb', name: 'Albanian', aliases: ['sq', 'sqi'] },
  { code: 'hun', name: 'Hungarian', aliases: ['hu', 'magyar'] },
  { code: 'gre', name: 'Greek', aliases: ['el', 'ell'] },
  { code: 'tur', name: 'Turkish', aliases: ['tr'] },
  { code: 'swe', name: 'Swedish', aliases: ['sv'] },
  { code: 'nor', name: 'Norwegian', aliases: ['no', 'nb', 'nn', 'nob', 'nno'] },
  { code: 'dan', name: 'Danish', aliases: ['da'] },
  { code: 'fin', name: 'Finnish', aliases: ['fi'] },
  { code: 'ice', name: 'Icelandic', aliases: ['is', 'isl'] },
  { code: 'est', name: 'Estonian', aliases: ['et'] },
  { code: 'lav', name: 'Latvian', aliases: ['lv'] },
  { code: 'lit', name: 'Lithuanian', aliases: ['lt'] },
  { code: 'cat', name: 'Catalan', aliases: ['ca'] },
  { code: 'baq', name: 'Basque', aliases: ['eu', 'eus'] },
  { code: 'glg', name: 'Galician', aliases: ['gl'] },
  { code: 'heb', name: 'Hebrew', aliases: ['he', 'iw'] },
  { code: 'ara', name: 'Arabic', aliases: ['ar'] },
  { code: 'per', name: 'Persian', aliases: ['fa', 'fas', 'farsi'] },
  { code: 'hin', name: 'Hindi', aliases: ['hi'] },
  { code: 'ben', name: 'Bengali', aliases: ['bn'] },
  { code: 'tam', name: 'Tamil', aliases: ['ta'] },
  { code: 'tel', name: 'Telugu', aliases: ['te'] },
  { code: 'mal', name: 'Malayalam', aliases: ['ml'] },
  { code: 'urd', name: 'Urdu', aliases: ['ur'] },
  { code: 'tha', name: 'Thai', aliases: ['th'] },
  { code: 'vie', name: 'Vietnamese', aliases: ['vi'] },
  { code: 'ind', name: 'Indonesian', aliases: ['id', 'in'] },
  { code: 'may', name: 'Malay', aliases: ['ms', 'msa'] },
  { code: 'tgl', name: 'Tagalog', aliases: ['tl', 'fil', 'filipino'] },
  { code: 'chi', name: 'Chinese', aliases: ['zh', 'zho', 'mandarin', 'cantonese', 'chs', 'cht', 'zhs', 'zht', 'zhe', 'ze'] },
  { code: 'jpn', name: 'Japanese', aliases: ['ja'] },
  { code: 'kor', name: 'Korean', aliases: ['ko'] },
]

const CODE_BY_SPELLING = new Map<string, string>()
const NAME_BY_CODE = new Map<string, string>()
for (const language of SUBTITLE_LANGUAGES) {
  NAME_BY_CODE.set(language.code, language.name)
  for (const spelling of [language.code, language.name.toLowerCase(), ...language.aliases]) {
    CODE_BY_SPELLING.set(spelling, language.code)
  }
}

export const DEFAULT_SUBTITLE_LANGUAGES: readonly string[] = ['eng']

export function normalizeSubtitleLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().toLowerCase().replace(/_/g, '-')
  if (!cleaned) return null
  // en-US, pt-BR, zh-TW: the region folds into the language, so a pt preference
  // still matches files a provider labels pt-BR.
  return CODE_BY_SPELLING.get(cleaned) ?? CODE_BY_SPELLING.get(cleaned.split('-')[0]) ?? null
}

// Order is kept and repeats dropped, because order decides how tracks are grouped.
// Unreadable entries are returned rather than skipped, so Settings can refuse the
// save and name them.
export function parseSubtitleLanguages(value: string): { languages: string[]; unknown: string[] } {
  const languages: string[] = []
  const unknown: string[] = []
  for (const part of value.split(/[\s,;]+/)) {
    if (!part) continue
    const code = normalizeSubtitleLanguage(part)
    if (!code) unknown.push(part)
    else if (!languages.includes(code)) languages.push(code)
  }
  return { languages, unknown }
}

export function subtitleLanguageName(code: string): string {
  return NAME_BY_CODE.get(code) ?? code
}

// Gestdown, like most subtitle sites, asks for a language by its ISO 639-1 code
// rather than the 639-2/B code the rest of fetcherr speaks. The first two-letter
// alias is that code for every language above; a language with none (there is
// none today, but a future addition might lack one) is simply not asked.
export function subtitleLanguageTwoLetter(code: string): string | null {
  const language = SUBTITLE_LANGUAGES.find(candidate => candidate.code === code)
  if (!language) return null
  return language.aliases.find(alias => alias.length === 2) ?? null
}

// The choices offered for an account's preferred language. With no language
// filter any language can arrive, so then every known one is offered.
export function subtitlePreferenceOptions(languages: readonly string[]): Array<{ code: string; name: string }> {
  const codes = languages.length ? languages : SUBTITLE_LANGUAGES.map(language => language.code)
  return codes.map(code => ({ code, name: subtitleLanguageName(code) }))
}
