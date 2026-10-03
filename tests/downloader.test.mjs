import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import plugin from '../downloader.ts'

const dir = mkdtempSync(join(tmpdir(), 'opencode-dl-test-'))
const tools = new Map()
const notifications = []
const fixture = createServer((req, res) => {
  if (req.url === '/slow') {
    res.writeHead(200)
    const timer = setInterval(() => res.write('chunk'), 30)
    res.on('close', () => clearInterval(timer))
  } else {
    res.writeHead(200, { 'content-length': 7 })
    res.end('fixture')
  }
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const port = fixture.address().port
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const guiPort = probe.address().port
await new Promise(resolve => probe.close(resolve))
globalThis.__ocDownloader = {
  tasks: new Map(), controllers: new Map(), running: 0, server: null,
  activeSessionID: 'wrong-session',
  cfg: { dir, autoNotify: true, autoMirror: true, guiPort, maxMbps: 0 },
}
const store = globalThis.__ocDownloader
await plugin.setup({
  tool: { hook() {}, async transform(fn) { fn({ namespace() {}, add(t) { tools.set(t.name, t.execute) } }) } },
  session: { async prompt(message) { notifications.push(message) } },
})
const call = (name, input = {}, context = { sessionID: 'correct-session' }) => tools.get(name)(input, context)
const add = async (name, extra = {}) => {
  await call('add', { url: `http://127.0.0.1:${port}/file`, name, ...extra })
  return [...store.tasks.values()].at(-1)
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(20) }
  throw new Error('Timed out')
}
after(async () => {
  for (const ac of store.controllers.values()) ac.abort()
  fixture.closeAllConnections()
  await Promise.all([new Promise(r => fixture.close(r)), new Promise(r => store.server.close(r))])
  await waitFor(() => store.running === 0)
  rmSync(dir, { recursive: true, force: true })
})

test('custom directory, checksum and correct session; completed files survive cancel', async () => {
  const custom = join(dir, 'custom')
  const t = await add('valid.bin', { dir: custom, sha256: createHash('sha256').update('fixture').digest('hex'), mirror: false })
  await waitFor(() => t.status === 'done')
  assert.equal(readFileSync(t.dest, 'utf8'), 'fixture')
  assert.equal(t.dest, join(custom, 'valid.bin'))
  assert.equal(notifications.at(-1).sessionID, 'correct-session')
  assert.equal(store.cfg.autoMirror, true)
  await assert.rejects(call('cancel', { id: t.id }), /already ended/)
  assert.ok(existsSync(t.dest))
})

test('reject traversal, unsupported URLs, invalid checksums, rates and overwrite', async () => {
  for (const name of ['../escape', 'a/b', 'CON', 'trailing.']) await assert.rejects(add(name), /Invalid filename/)
  await assert.rejects(add('bad.bin', { url: 'file:///etc/passwd' }), /HTTP/)
  await assert.rejects(add('bad.bin', { sha256: 'abc' }), /SHA-256/)
  await assert.rejects(add('bad.bin', { max_mbps: -1 }), /Rate/)
  const t = await add('existing.bin')
  await waitFor(() => t.status === 'done')
  await assert.rejects(add('existing.bin'), /Destination/)
})

test('checksum failure leaves no final file; retry resets notification state', async () => {
  const t = await add('checksum.bin', { sha256: '0'.repeat(64) })
  await waitFor(() => t.status === 'failed' && !store.controllers.has(t.id))
  assert.ok(!existsSync(t.dest))
  const count = notifications.length
  t.sha256 = undefined
  await call('retry', { id: t.id })
  await waitFor(() => t.status === 'done')
  assert.equal(notifications.length, count + 1)
})

test('cancel cleans partial files; running retry/remove is rejected', async () => {
  const t = await add('slow.bin', { url: `http://127.0.0.1:${port}/slow` })
  await waitFor(() => t.received > 0)
  await assert.rejects(call('retry', { id: t.id }), /running/)
  await assert.rejects(call('remove', { id: t.id }), /running/)
  await call('cancel', { id: t.id })
  await waitFor(() => !store.controllers.has(t.id) && store.running === 0)
  assert.ok(!existsSync(t.dest))
  assert.ok(!existsSync(`${t.dest}.${t.id}.part`))
})

test('GUI rejects cross-origin mutations and GET actions; preserves verifying records', async () => {
  const url = `http://127.0.0.1:${guiPort}`
  assert.equal((await fetch(`${url}/api/remove?id=missing`)).status, 405)
  assert.equal((await fetch(`${url}/api/remove?id=missing`, { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403)
  assert.equal((await fetch(`${url}/api/remove?id=missing`, { method: 'POST' })).status, 404)
  const t = { id: 'verify-test', status: 'verifying' }
  store.tasks.set(t.id, t)
  await assert.rejects(call('remove', { id: t.id }), /running/)
  await call('clear')
  assert.ok(store.tasks.has(t.id))
  store.tasks.delete(t.id)
  const html = await (await fetch(url)).text()
  assert.ok(html.includes('esc(t.name)'))
  // Compile the generated inline script, catching template escaping mistakes.
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])
})
