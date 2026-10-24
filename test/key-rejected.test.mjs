// A 401/403 from the gateway is a credential failure, not an outage, and a
// 401 with `code: "workspace_deleted"` says so once per session
// (gatewaystack-connect#1693; mirrors codex-acp-plugin
// test/key-rejected.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide } from '../hook.mjs'

async function withGateway(status, reply, fn) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(reply === undefined ? '' : JSON.stringify(reply))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { server.close() }
}

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'acp-keyrej-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return home
}

function runPre(base, home, extra = {}) {
  const payload = {
    hookEventName: 'pre_tool_use',
    toolName: 'run_terminal_command',
    toolInput: { command: 'echo hi' },
    permissionMode: 'default',
    ...extra,
  }
  return decide(payload, { HOME: home, ACP_GOVERN_BASE: base })
}

const DELETED = { error: 'workspace deleted', code: 'workspace_deleted' }

test('interactive 401 proceeds with KEY REJECTED naming the key and the fix, and logs the lapse', async () => {
  const home = tmpHome()
  const r = await withGateway(401, { error: 'invalid key' }, (b) => runPre(b, home, { sessionId: 's1' }))
  assert.equal(r.out.decision, 'allow')
  assert.ok(!r.deny)
  assert.match(r.warn, /^\[ACP\] ⚠ KEY REJECTED \(HTTP 401\): the key in ~\/\.acp\/credentials is revoked or invalid/)
  assert.match(r.warn, /install\.sh/)
  assert.match(r.warn, /settings\/api-keys/)
  assert.doesNotMatch(r.warn, /unreachable/i)
  assert.match(readFileSync(join(home, '.acp', 'lapse.log'), 'utf8'), /key rejected \(HTTP 401\)/)
})

test('interactive 401 with no body still reads as KEY REJECTED', async () => {
  const r = await withGateway(401, undefined, (b) => runPre(b, tmpHome()))
  assert.equal(r.out.decision, 'allow')
  assert.match(r.warn, /KEY REJECTED \(HTTP 401\)/)
})

test('unattended 401 stays denied with the cause named', async () => {
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const r = await withGateway(401, { error: 'invalid key' }, (b) => runPre(b, tmpHome(), { permissionMode: mode }))
    assert.equal(r.out.decision, 'deny')
    assert.equal(r.deny, true)
    assert.match(r.out.reason, /Key rejected \(HTTP 401\)/)
    assert.match(r.out.reason, /~\/\.acp\/credentials/)
    assert.doesNotMatch(r.out.reason, /unreachable/i)
  }
})

test('403 is treated like 401', async () => {
  const i = await withGateway(403, { error: 'forbidden' }, (b) => runPre(b, tmpHome()))
  assert.equal(i.out.decision, 'allow')
  assert.match(i.warn, /KEY REJECTED \(HTTP 403\)/)
  const u = await withGateway(403, { error: 'forbidden' }, (b) => runPre(b, tmpHome(), { permissionMode: 'bypassPermissions' }))
  assert.equal(u.out.decision, 'deny')
  assert.match(u.out.reason, /Key rejected \(HTTP 403\)/)
})

test('5xx keeps the outage posture', async () => {
  const i = await withGateway(503, { error: 'down' }, (b) => runPre(b, tmpHome()))
  assert.equal(i.out.decision, 'allow')
  assert.match(i.warn, /UNGOVERNED: gateway unreachable \(HTTP 503/)
  const u = await withGateway(503, { error: 'down' }, (b) => runPre(b, tmpHome(), { permissionMode: 'bypassPermissions' }))
  assert.equal(u.out.decision, 'deny')
  assert.match(u.out.reason, /Gateway unreachable/)
})

test('interactive workspace_deleted: one notice per session, then silent; lapse logged every call', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    const first = await runPre(b, home, { sessionId: 'sess-a' })
    assert.equal(first.out.decision, 'allow')
    assert.match(first.warn, /workspace this machine was connected to has been deleted/)
    assert.match(first.warn, /acp-uninstall/)
    assert.match(first.warn, /uninstall\.sh/)
    assert.ok(existsSync(join(home, '.acp', 'notices', 'workspace-deleted.sess-a')))

    const second = await runPre(b, home, { sessionId: 'sess-a' })
    assert.equal(second.out.decision, 'allow')
    assert.equal(second.warn, undefined)

    const otherSession = await runPre(b, home, { sessionId: 'sess-b' })
    assert.match(otherSession.warn, /has been deleted/)
  })
  const lapses = readFileSync(join(home, '.acp', 'lapse.log'), 'utf8').trim().split('\n')
  assert.equal(lapses.length, 3)
})

test('interactive workspace_deleted with no session id: at most once per 24h', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    const first = await runPre(b, home)
    assert.match(first.warn, /has been deleted/)
    const second = await runPre(b, home)
    assert.equal(second.out.decision, 'allow')
    assert.equal(second.warn, undefined)
  })
})

test('unattended workspace_deleted denies every call with the deleted message', async () => {
  const home = tmpHome()
  await withGateway(401, DELETED, async (b) => {
    for (let i = 0; i < 2; i++) {
      const r = await runPre(b, home, { permissionMode: 'bypassPermissions', sessionId: 'sess-u' })
      assert.equal(r.out.decision, 'deny')
      assert.match(r.out.reason, /has been deleted/)
      assert.match(r.out.reason, /acp-uninstall/)
    }
  })
})
