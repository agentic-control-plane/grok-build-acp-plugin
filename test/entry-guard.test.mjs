// The hook must run its main function whenever it is the script Node was
// started with. A hook that silently exits 0 with no output is an allow, so
// a path with a space or a symlinked install must still reach the gateway.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs')

let root
let home
let server
let base

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'acp-entry-'))
  home = join(root, 'home')
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')

  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ decision: 'deny', reason: 'stub gateway says no' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function runHookAt(script) {
  const payload = {
    hookEventName: 'pre_tool_use',
    toolName: 'run_terminal_command',
    toolInput: { command: 'echo hi' },
    permissionMode: 'default',
    sessionId: 'entry-guard',
  }
  const env = { ...process.env, HOME: home, ACP_GOVERN_BASE: base }
  delete env.ACP_BEARER_TOKEN
  delete env.ACP_AGENT_TIER
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

function assertDeny(r, label) {
  assert.notEqual(r.stdout.trim(), '', `${label}: hook produced no output (main did not run)`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.decision, 'deny', label)
  assert.match(out.reason, /Denied by policy: stub gateway says no/, label)
  assert.equal(r.code, 2, label)
}

test('plain path: the hook runs and denies', async () => {
  assertDeny(await runHookAt(HOOK), 'plain path')
})

test('copy in a directory whose name contains a space: same deny as the plain path', async () => {
  const dir = join(root, 'dir with space')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'hook.mjs')
  copyFileSync(HOOK, script)
  const plain = await runHookAt(HOOK)
  const spaced = await runHookAt(script)
  assertDeny(spaced, 'space in path')
  assert.equal(spaced.code, plain.code)
  assert.deepEqual(JSON.parse(spaced.stdout), JSON.parse(plain.stdout))
})

test('symlink to hook.mjs: same deny as the plain path', async () => {
  const dir = join(root, 'linked')
  mkdirSync(dir, { recursive: true })
  const link = join(dir, 'hook.mjs')
  symlinkSync(HOOK, link)
  const plain = await runHookAt(HOOK)
  const linked = await runHookAt(link)
  assertDeny(linked, 'symlink')
  assert.equal(linked.code, plain.code)
  assert.deepEqual(JSON.parse(linked.stdout), JSON.parse(plain.stdout))
})
