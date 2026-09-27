import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBTITLE_LANGUAGES, SUBTITLE_LANGUAGES, normalizeSubtitleLanguage, parseSubtitleLanguages,
  subtitleLanguageName, subtitlePreferenceOptions,
} from '../src/subtitle-lang.js'
import { parseSubtitleLanguageSetting, parseSubtitleMaxPerLanguage } from '../src/config.js'

test('every spelling providers send folds to one ISO 639-2/B code', () => {
  const cases: Record<string, string> = {
    en: 'eng', eng: 'eng', English: 'eng', 'en-US': 'eng', EN_gb: 'eng',
    fr: 'fre', fre: 'fre', fra: 'fre', French: 'fre', 'français': 'fre',
    de: 'ger', ger: 'ger', deu: 'ger', German: 'ger', Deutsch: 'ger',
    ro: 'rum', rum: 'rum', ron: 'rum', Romanian: 'rum', mol: 'rum',
    nld: 'dut', ces: 'cze', pob: 'por', 'pt-BR': 'por', zht: 'chi',
  }
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeSubtitleLanguage(input), expected, input)
  }
})

test('anything that is not a known language maps to nothing', () => {
  for (const input of ['', '   ', 'xx', 'klingon', 'e', 'english2', 'und', null, undefined, 42]) {
    assert.equal(normalizeSubtitleLanguage(input), null, String(input))
  }
})

test('no spelling is claimed by two languages', () => {
  const owner = new Map<string, string>()
  for (const language of SUBTITLE_LANGUAGES) {
    for (const spelling of [language.code, language.name.toLowerCase(), ...language.aliases]) {
      const previous = owner.get(spelling)
      assert.ok(previous === undefined || previous === language.code, `${spelling} is claimed by ${previous} and ${language.code}`)
      owner.set(spelling, language.code)
    }
  }
})

test('every code maps to itself, so stored values survive a round trip', () => {
  for (const language of SUBTITLE_LANGUAGES) {
    assert.match(language.code, /^[a-z]{3}$/)
    assert.equal(normalizeSubtitleLanguage(language.code), language.code)
  }
})

test('a language list keeps its order, drops repeats and reports what it cannot read', () => {
  assert.deepEqual(parseSubtitleLanguages('en, fr, ro, de'), { languages: ['eng', 'fre', 'rum', 'ger'], unknown: [] })
  assert.deepEqual(parseSubtitleLanguages('ro,ron;rum  en'), { languages: ['rum', 'eng'], unknown: [] })
  assert.deepEqual(parseSubtitleLanguages('en, xx, fr, klingon'), { languages: ['eng', 'fre'], unknown: ['xx', 'klingon'] })
  assert.deepEqual(parseSubtitleLanguages(''), { languages: [], unknown: [] })
  assert.deepEqual(parseSubtitleLanguages(' , ,'), { languages: [], unknown: [] })
})

test('the build default is English only, and empty is kept distinct from unset', () => {
  assert.deepEqual([...DEFAULT_SUBTITLE_LANGUAGES], ['eng'])
  assert.deepEqual(parseSubtitleLanguageSetting(undefined), ['eng'])
  assert.deepEqual(parseSubtitleLanguageSetting(''), [])
  assert.deepEqual(parseSubtitleLanguageSetting('fr,de'), ['fre', 'ger'])
})

test('the per-language cap defaults to 3 and stays within 1..20', () => {
  assert.equal(parseSubtitleMaxPerLanguage(undefined), 3)
  assert.equal(parseSubtitleMaxPerLanguage(''), 3)
  assert.equal(parseSubtitleMaxPerLanguage('abc'), 3)
  assert.equal(parseSubtitleMaxPerLanguage('0'), 1)
  assert.equal(parseSubtitleMaxPerLanguage('-4'), 1)
  assert.equal(parseSubtitleMaxPerLanguage('7'), 7)
  assert.equal(parseSubtitleMaxPerLanguage('99'), 20)
})

test('display names and the choices for an account preference', () => {
  assert.equal(subtitleLanguageName('rum'), 'Romanian')
  assert.equal(subtitleLanguageName('zzz'), 'zzz')
  assert.deepEqual(subtitlePreferenceOptions(['eng', 'rum']), [
    { code: 'eng', name: 'English' },
    { code: 'rum', name: 'Romanian' },
  ])
  // With no language filter any language can arrive, so every known one is a choice.
  assert.equal(subtitlePreferenceOptions([]).length, SUBTITLE_LANGUAGES.length)
})
