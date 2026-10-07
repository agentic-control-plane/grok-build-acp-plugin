import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide, buildReceiptMessage } from '../hook.mjs'

// --- Mock ACP gateway -------------------------------------------------------
// Behaviour is keyed off the incoming tool_input.command so each test drives
// its own verdict without shared mutable state.
let server
let baseUrl
const seen = []

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      seen.push({ path: req.url, payload })
      const cmd = String(payload.tool_input?.command ?? '')
      res.setHeader('content-type', 'application/json')
      if (req.url === '/govern/tool-output') {
        if (String(payload.tool_output ?? '').includes('SECRET')) {
          return res.end(JSON.stringify({ action: 'block', reason: 'PII detected' }))
        }
        return res.end(JSON.stringify({ action: 'pass' }))
      }
      if (cmd.includes('rm -rf')) return res.end(JSON.stringify({ decision: 'deny', reason: 'hardline floor' }))
      if (cmd.includes('git push')) return res.end(JSON.stringify({ decision: 'ask', reason: 'outward-facing' }))
      if (cmd.includes('boom-500')) { res.statusCode = 500; return res.end('{}') }
      return res.end(JSON.stringify({ decision: 'allow' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

// Isolated HOME so credential/config reads never touch the real ~/.acp.
// (Lapse-log/session-stat bookkeeping still lands in the real ~/.acp — same
// as the sibling plugins — and no test asserts on it.)
function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-test-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return {
    HOME: home,
    ACP_GOVERN_BASE: baseUrl,
    ...extra,
  }
}

// Grok's live payload shape (camelCase, snake_case event VALUE) from the
// in-repo user guide, verbatim structure.
function grokPayload(command, extra = {}) {
  return {
    hookEventName: 'pre_tool_use',
    sessionId: 'abc-123',
    cwd: '/tmp/project',
    workspaceRoot: '/tmp/project',
    permissionMode: 'default',
    toolName: 'run_terminal_command',
    toolInput: { command },
    timestamp: '2026-08-19T12:00:00Z',
    ...extra,
  }
}

test('camelCase payload parses and allow comes back in Grok vocabulary', async () => {
  const { out } = await decide(grokPayload('npm test'), makeEnv())
  assert.equal(out.decision, 'allow')
  const sent = seen.at(-1)
  assert.equal(sent.path, '/govern/tool-use')
  assert.equal(sent.payload.tool_name, 'Bash', 'native shell tool maps to canonical so floors fire')
  assert.equal(sent.payload.client_tool_name, 'run_terminal_command')
  assert.equal(sent.payload.tool_input.command, 'npm test')
  assert.equal(sent.payload.hook_event_name, 'PreToolUse')
})

test('unknown and MCP tool names pass through unmapped', async () => {
  await decide(grokPayload('x', { toolName: 'linear__save_issue' }), makeEnv())
  assert.equal(seen.at(-1).payload.tool_name, 'linear__save_issue')
})

test('policy deny emits top-level decision:"deny" plus forward-compat hookSpecificOutput', async () => {
  const { out, deny } = await decide(grokPayload('rm -rf /'), makeEnv())
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /Denied by policy: hardline floor/)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
})

test('ask in default mode fails closed: deny with the ACP reason (never a silent allow)', async () => {
  const { out, deny, warn } = await decide(grokPayload('git push origin main'), makeEnv())
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /Approval required: outward-facing/)
  assert.match(out.reason, /cloud\.agenticcontrolplane\.com/)
  assert.equal(warn, undefined)
})

test('ask in plan mode also fails closed', async () => {
  const { out, deny } = await decide(
    grokPayload('git push origin main', { permissionMode: 'plan' }),
    makeEnv(),
  )
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /Approval required: outward-facing/)
})

test('ask in bypassPermissions mode becomes a deny with the console link', async () => {
  const { out, deny } = await decide(
    grokPayload('git push origin main', { permissionMode: 'bypassPermissions' }),
    makeEnv(),
  )
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /nobody is at the prompt/)
  assert.match(out.reason, /cloud\.agenticcontrolplane\.com/)
})

test('ask in auto mode also fails closed (classifier answers prompts, not the human)', async () => {
  const { out } = await decide(
    grokPayload('git push origin main', { permissionMode: 'auto' }),
    makeEnv(),
  )
  assert.equal(out.decision, 'deny')
})

test('gateway unreachable: interactive fails OPEN and loud', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300' })
  const { out, warn } = await decide(grokPayload('npm test'), env)
  assert.equal(out.decision, 'allow')
  assert.match(warn, /UNGOVERNED/)
})

test('gateway unreachable: bypassPermissions fails CLOSED', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300' })
  const { out, deny } = await decide(
    grokPayload('npm test', { permissionMode: 'bypassPermissions' }),
    env,
  )
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /fail-closed/)
})

test('HTTP 500 is the server answering — no retry storm, posture still applies', async () => {
  const before500 = seen.length
  const { out } = await decide(grokPayload('boom-500'), makeEnv())
  assert.equal(out.decision, 'allow') // interactive fail-open
  assert.equal(seen.length - before500, 1, 'HTTP status must not be retried')
})

test('missing credential allows loudly instead of deciding silently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-nocred-'))
  const { out, warn } = await decide(grokPayload('npm test'), { HOME: home, ACP_GOVERN_BASE: baseUrl })
  assert.equal(out.decision, 'allow')
  assert.match(warn, /UNGOVERNED: no credential/)
  rmSync(home, { recursive: true, force: true })
})

test('PostToolUse block degrades to a loud audit line — Grok cannot block post-hoc', async () => {
  const { out, warn } = await decide(
    grokPayload('echo hi', { hookEventName: 'post_tool_use', toolOutput: 'SECRET=abc123' }),
    makeEnv(),
  )
  assert.deepEqual(out, {})
  assert.match(warn, /Flagged after the fact/)
})

test('PostToolUse pass emits nothing', async () => {
  const { out, warn } = await decide(
    grokPayload('echo hi', { hookEventName: 'post_tool_use', toolOutput: 'all fine' }),
    makeEnv(),
  )
  assert.deepEqual(out, {})
  assert.equal(warn, undefined)
})

test('snake_case fallback payloads still parse (Claude-shaped stdin)', async () => {
  const { out } = await decide(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 's1',
      permission_mode: 'default',
    },
    makeEnv(),
  )
  assert.equal(out.decision, 'allow')
})

test('Stop never blocks: empty decision object even when stats are absent', async () => {
  const { out } = await decide(
    { hookEventName: 'stop', sessionId: 'no-stats-session' },
    makeEnv(),
  )
  assert.deepEqual(out, {})
})

test('receipt message formats counts and console link', () => {
  const line = buildReceiptMessage({ calls: 3, denied: 1, asked: 0, notices: 0 }, 's-9')
  assert.match(line, /3 tool calls governed · 1 denied/)
  assert.match(line, /sessions\/s-9/)
})

test('unknown permission mode is treated as unattended for asks', async () => {
  const { out } = await decide(
    grokPayload('git push origin main', { permissionMode: 'dontAsk' }),
    makeEnv(),
  )
  assert.equal(out.decision, 'deny')
})
