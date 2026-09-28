import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFakeSubtitleProvider } from './fake-subtitle-provider.js'

const databasePath = join(tmpdir(), `fetcherr-subtitle-settings-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
// No network: config reads keys once at load, and unset keys keep every lookup offline.
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { uiRoutes } = await import('../src/ui/routes.js')
// The session is made by the same call the login route makes, so no test-only
// backdoor is added to src/.
const { createSession } = await import('../src/ui/auth.js')
const { fetchSubtitles } = await import('../src/subtitles.js')

const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const plain = db.createUser('plain', 'pw', 'user', 'unrestricted')
const adminHeaders = { cookie: `infuse_session=${createSession(admin.id)}` }
const userHeaders = { cookie: `infuse_session=${createSession(plain.id)}` }

async function buildApp() {
  const app = Fastify()
  await app.register(uiRoutes)
  return app
}
type App = Awaited<ReturnType<typeof buildApp>>

const save = (app: App, payload: Record<string, unknown>, headers: Record<string, string> = adminHeaders) =>
  app.inject({ method: 'POST', url: '/ui/settings-data', headers, payload: payload as never })
const read = async (app: App) =>
  (await app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })).json() as Record<string, unknown>

test('the defaults are English only, three per language, and no named providers', async () => {
  const app = await buildApp()
  const settings = await read(app)
  assert.equal(settings.subtitleLanguages, 'eng')
  assert.equal(settings.subtitleMaxPerLanguage, 3)
  assert.equal(settings.subtitleProviderUrls, '')
  assert.equal(settings.subtitleGestdown, false)
  assert.deepEqual(settings.subtitleLanguageOptions, [{ code: 'eng', name: 'English' }])
  await app.close()
})

test('a saved language list is stored normalised, in order', async () => {
  const app = await buildApp()
  const res = await save(app, { subtitleLanguages: 'en, fr, ro, de' })
  assert.equal(res.statusCode, 200)
  assert.equal(db.getSetting('subtitleLanguages'), 'eng,fre,rum,ger')
  assert.deepEqual(config.subtitleLanguages, ['eng', 'fre', 'rum', 'ger'])
  const settings = await read(app)
  assert.equal(settings.subtitleLanguages, 'eng, fre, rum, ger')
  assert.deepEqual((settings.subtitleLanguageOptions as Array<{ code: string }>).map(option => option.code), ['eng', 'fre', 'rum', 'ger'])
  await app.close()
})

test('an unknown language refuses the whole save and names the culprit', async () => {
  const app = await buildApp()
  const serverUrlBefore = db.getSetting('serverUrl')
  const capBefore = config.subtitleMaxPerLanguage
  const res = await save(app, { subtitleLanguages: 'en, fr, ro, dk', serverUrl: 'https://changed.example', subtitleMaxPerLanguage: 7 })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /\bdk\b/)
  assert.equal(db.getSetting('serverUrl'), serverUrlBefore)
  assert.equal(db.getSetting('subtitleLanguages'), 'eng,fre,rum,ger')
  assert.equal(config.subtitleMaxPerLanguage, capBefore)
  await app.close()
})

test('an empty list is stored as empty, which means no filter', async () => {
  const app = await buildApp()
  await save(app, { subtitleLanguages: '  ' })
  assert.equal(db.getSetting('subtitleLanguages'), '')
  assert.deepEqual(config.subtitleLanguages, [])
  const settings = await read(app)
  assert.equal(settings.subtitleLanguages, '')
  assert.ok((settings.subtitleLanguageOptions as unknown[]).length > 40)
  await save(app, { subtitleLanguages: 'en, fr, ro, de' })
  await app.close()
})

test('the per-language cap is clamped to 1..10', async () => {
  const app = await buildApp()
  const cases: Array<[string | number, number]> = [[0, 1], [25, 10], ['99', 10], [11, 10], ['abc', 3], [5, 5]]
  for (const [input, stored] of cases) {
    await save(app, { subtitleMaxPerLanguage: input })
    assert.equal(config.subtitleMaxPerLanguage, stored, String(input))
    assert.equal(db.getSetting('subtitleMaxPerLanguage'), String(stored))
  }
  await app.close()
})

test('subtitle provider URLs are cleaned like stream provider URLs', async () => {
  const app = await buildApp()
  await save(app, { subtitleProviderUrls: 'https://opensubtitles-v3.strem.io/manifest.json\n\n  https://other.example/  \n' })
  assert.deepEqual(config.subtitleProviderUrls, ['https://opensubtitles-v3.strem.io', 'https://other.example'])
  assert.equal(db.getSetting('subtitleProviderUrls'), 'https://opensubtitles-v3.strem.io\nhttps://other.example')
  assert.equal((await read(app)).subtitleProviderUrls, 'https://opensubtitles-v3.strem.io\nhttps://other.example')
  await app.close()
})

test('turning on Gestdown stores it, applies it, and is reported back', async () => {
  const app = await buildApp()
  assert.equal(config.subtitleGestdown, false)
  const res = await save(app, { subtitleGestdown: true })
  assert.equal(res.statusCode, 200)
  assert.equal(db.getSetting('subtitleGestdown'), 'true')
  assert.equal(config.subtitleGestdown, true)
  assert.equal((await read(app)).subtitleGestdown, true)

  await save(app, { subtitleGestdown: false })
  assert.equal(db.getSetting('subtitleGestdown'), 'false')
  assert.equal(config.subtitleGestdown, false)
  await app.close()
})

test('any settings save drops cached subtitle answers', async t => {
  const provider = await startFakeSubtitleProvider({ subtitles: [{ id: 'a', lang: 'eng', url: 'https://subs.example/a' }] })
  t.after(() => provider.close())
  const app = await buildApp()
  await save(app, { subtitleProviderUrls: provider.url, subtitleLanguages: 'en' })

  await fetchSubtitles('movie', 'tt0111161')
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(provider.requests.length, 1)

  // With no subtitle provider named, a stream provider change alone changes the
  // source, so even a save that touches nothing subtitle-related clears the cache.
  await save(app, {})
  await fetchSubtitles('movie', 'tt0111161')
  assert.equal(provider.requests.length, 2)
  await app.close()
})

test('only an admin can change subtitle settings', async () => {
  const app = await buildApp()
  const before = [...config.subtitleLanguages]
  const res = await save(app, { subtitleLanguages: 'de' }, userHeaders)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(config.subtitleLanguages, before)
  await app.close()
})
