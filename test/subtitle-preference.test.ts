import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const databasePath = join(tmpdir(), `fetcherr-subtitle-preference-${randomUUID()}.db`)
process.env.DATABASE_PATH = databasePath
process.env.TMDB_API_KEY = ''
process.env.TVDB_API_KEY = ''
const db = await import('../src/db.js')
const { uiRoutes } = await import('../src/ui/routes.js')
const { createSession } = await import('../src/ui/auth.js')

const admin = db.createUser('admin', 'pw', 'admin', 'unrestricted')
const adminHeaders = { cookie: `infuse_session=${createSession(admin.id)}` }

test('a new account has no preferred subtitle language', () => {
  const user = db.createUser('fresh', 'pw', 'user', 'unrestricted')
  assert.equal(db.getUserById(user.id)?.subtitleLanguage, '')
})

test('the preference is stored in the one vocabulary', () => {
  const user = db.createUser('mum', 'pw', 'user', 'unrestricted')
  const cases: Array<[string, string]> = [['ro', 'rum'], ['Romanian', 'rum'], ['fra', 'fre'], ['', ''], ['  ', '']]
  for (const [input, stored] of cases) {
    assert.equal(db.updateUser(user.id, { subtitleLanguage: input }).subtitleLanguage, stored, input)
  }
})

test('an unknown preference is refused and changes nothing', () => {
  const user = db.createUser('dad', 'pw', 'user', 'unrestricted')
  db.updateUser(user.id, { subtitleLanguage: 'fr' })
  assert.throws(() => db.updateUser(user.id, { subtitleLanguage: 'dk', username: 'renamed' }), /Unknown subtitle language: dk/)
  const after = db.getUserById(user.id)!
  assert.equal(after.username, 'dad')
  assert.equal(after.subtitleLanguage, 'fre')
})

test('an update that does not mention the preference keeps it', () => {
  const user = db.createUser('ralu', 'pw', 'user', 'unrestricted')
  db.updateUser(user.id, { subtitleLanguage: 'de' })
  db.updateUser(user.id, { maxRating: '2' })
  assert.equal(db.getUserById(user.id)?.subtitleLanguage, 'ger')
})

test('the users API sets the preference and the settings payload reports it', async () => {
  const app = Fastify()
  await app.register(uiRoutes)
  const user = db.createUser('nelly', 'pw', 'user', 'unrestricted')

  const saved = await app.inject({ method: 'POST', url: '/ui/users-data', headers: adminHeaders, payload: { id: user.id, subtitleLanguage: 'ro' } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().user.subtitleLanguage, 'rum')

  const refused = await app.inject({ method: 'POST', url: '/ui/users-data', headers: adminHeaders, payload: { id: user.id, subtitleLanguage: 'dk' } })
  assert.equal(refused.statusCode, 400)
  assert.match(refused.json().error, /dk/)

  const settings = await app.inject({ method: 'GET', url: '/ui/settings-data', headers: adminHeaders })
  const listed = (settings.json().users as Array<{ id: string; subtitleLanguage: string }>).find(entry => entry.id === user.id)
  assert.equal(listed?.subtitleLanguage, 'rum')
  await app.close()
})
