import Fastify from 'fastify'
const app = Fastify()
async function plugin(inner: any) {
  console.log('  inside plugin, app.prefix =', JSON.stringify(inner.prefix))
  inner.get('/stremio/:token/manifest.json', async () => ({ ok: true }))
  inner.all('/stremio/*', async (_r: any, reply: any) => reply.code(404).send({ error: 'Not found' }))
}
await app.register(plugin)
await app.register(plugin, { prefix: '/addon' })
console.log('  no prefix  ->', (await app.inject({ method: 'GET', url: '/stremio/TOK/manifest.json' })).statusCode)
console.log('  prefixed   ->', (await app.inject({ method: 'GET', url: '/addon/stremio/TOK/manifest.json' })).statusCode)
console.log('  prefixed catch-all ->', (await app.inject({ method: 'GET', url: '/addon/stremio/TOK/configure' })).statusCode)
await app.close()
