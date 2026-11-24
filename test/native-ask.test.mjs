// A gateway ask becomes Grok's own confirmation prompt on Grok Build 1.0.13
// or newer with a person at the terminal, and a deny everywhere else. The
// Grok version and the terminal are injected, so no test needs a real
// `grok` binary or a real terminal.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import { decide, runHook, lookupGrokVersion } from '../hook.mjs'

const ACP_ASK = 'ACP (Agentic Control Plane) asks: pushing to main is outward-facing. Approve: https://cloud.agenticcontrolplane.com/approvals/apr_42'

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
      res.setHeader('content-type', 'application/json')
      if (req.url === '/govern/tool-output') return res.end(JSON.stringify({ action: 'pass' }))
      const cmd = String(payload.tool_input?.command ?? '')
      if (cmd.includes('plain-ask')) return res.end(JSON.stringify({ decision: 'ask', reason: 'outward-facing' }))
      if (cmd.includes('acp-ask')) return res.end(JSON.stringify({ decision: 'ask', reason: ACP_ASK }))
      return res.end(JSON.stringify({ decision: 'allow' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-ask-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return { HOME: home, ACP_GOVERN_BASE: baseUrl, ...extra }
}

function pre(command, extra = {}) {
  return {
    hookEventName: 'pre_tool_use',
    sessionId: 'ask-session',
    cwd: '/tmp/project',
    permissionMode: 'default',
    toolName: 'run_terminal_command',
    toolInput: { command },
    ...extra,
  }
}

function probes(version = '1.0.13', terminal = true) {
  return { grokVersion: () => version, hasTerminal: () => terminal }
}

const lastPre = () => seen.filter((s) => s.path === '/govern/tool-use').at(-1).payload

// --- Ask cases ---------------------------------------------------------------

for (const mode of ['default', 'plan', 'auto']) {
  test(`ask in ${mode} mode on Grok 1.0.13 with a terminal becomes Grok's prompt`, async () => {
    const result = await decide(pre('acp-ask', { permissionMode: mode }), makeEnv(), probes())
    assert.deepEqual(result.out, {
      decision: 'ask',
      reason: ACP_ASK,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: ACP_ASK,
      },
    })
    assert.equal(result.deny, undefined)
    assert.equal(result.warn, undefined)
    const body = lastPre()
    assert.deepEqual(body.attended, { claim: true, source: 'permission_mode', mode })
    assert.deepEqual(body.capabilities, ['native_ask'])
  })
}

test('a gateway reason without the ACP prefix gets the approval prefix', async () => {
  const { out } = await decide(pre('plain-ask'), makeEnv(), probes())
  assert.equal(out.decision, 'ask')
  assert.equal(out.reason, '[ACP] Approval required: outward-facing')
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, out.reason)
})

test('versions compare numerically per dotted part', async () => {
  for (const v of ['1.0.45', '1.1.0', '2.0', '1.0.13.1']) {
    const { out } = await decide(pre('acp-ask'), makeEnv(), probes(v))
    assert.equal(out.decision, 'ask', `${v} should ask`)
  }
  for (const v of ['1.0.9', '0.9.99', '1.0']) {
    const { out } = await decide(pre('acp-ask'), makeEnv(), probes(v))
    assert.equal(out.decision, 'deny', `${v} should deny`)
  }
})

test('async probes are awaited', async () => {
  const { out } = await decide(pre('acp-ask'), makeEnv(), {
    grokVersion: async () => '1.0.13',
    hasTerminal: async () => true,
  })
  assert.equal(out.decision, 'ask')
})

// --- Deny cases --------------------------------------------------------------

function assertHeldDeny(result, why) {
  assert.equal(result.deny, true)
  assert.equal(result.out.decision, 'deny')
  assert.equal(result.out.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(result.out.reason.includes(ACP_ASK), 'deny reason carries the gateway reason unchanged')
  assert.ok(result.out.reason.endsWith(`\n\n${ACP_ASK}`), 'gateway reason is the untouched tail, link last')
  assert.match(result.out.reason, /Grok cannot ask here/)
  if (why) assert.ok(result.out.reason.includes(`(${why})`), `deny names why: ${why}`)
  const body = lastPre()
  assert.equal(body.attended.claim, false)
  assert.equal(body.attended.source, 'permission_mode')
  assert.equal(body.capabilities, undefined)
}

test('Grok 1.0.12 cannot show a hook prompt: deny', async () => {
  const r = await decide(pre('acp-ask'), makeEnv(), probes('1.0.12'))
  assertHeldDeny(r, 'this Grok version cannot show a hook prompt (needs 1.0.13 or newer)')
  assert.equal(lastPre().attended.mode, 'default')
  assert.equal(lastPre().attended.auto_approve, undefined)
})

test('unknown Grok version: deny (an old Grok would read ask as fail-open)', async () => {
  const r = await decide(pre('acp-ask'), makeEnv(), probes('unknown'))
  assertHeldDeny(r, 'this Grok version cannot show a hook prompt (needs 1.0.13 or newer)')
})

test('a version probe that throws counts as unknown: deny', async () => {
  const r = await decide(pre('acp-ask'), makeEnv(), {
    grokVersion: () => { throw new Error('boom') },
    hasTerminal: () => true,
  })
  assertHeldDeny(r, 'this Grok version cannot show a hook prompt (needs 1.0.13 or newer)')
})

test('bypassPermissions auto-answers prompts: deny, auto_approve sent', async () => {
  const r = await decide(pre('acp-ask', { permissionMode: 'bypassPermissions' }), makeEnv(), probes())
  assertHeldDeny(r, 'always-approve mode answers prompts by itself')
  assert.deepEqual(lastPre().attended, {
    claim: false, source: 'permission_mode', mode: 'bypassPermissions', auto_approve: true,
  })
})

test('dontAsk never prompts: deny', async () => {
  const r = await decide(pre('acp-ask', { permissionMode: 'dontAsk' }), makeEnv(), probes())
  assertHeldDeny(r, 'dontAsk mode never prompts')
  assert.deepEqual(lastPre().attended, { claim: false, source: 'permission_mode', mode: 'dontAsk' })
})

test('missing permissionMode: deny, no mode sent', async () => {
  const payload = pre('acp-ask')
  delete payload.permissionMode
  const r = await decide(payload, makeEnv(), probes())
  assertHeldDeny(r)
  assert.deepEqual(lastPre().attended, { claim: false, source: 'permission_mode' })
})

test('CI set: deny', async () => {
  const r = await decide(pre('acp-ask'), makeEnv({ CI: 'true' }), probes())
  assertHeldDeny(r)
  assert.equal(lastPre().attended.mode, 'default')
})

test('no terminal: deny', async () => {
  const r = await decide(pre('acp-ask'), makeEnv(), probes('1.0.13', false))
  assertHeldDeny(r, 'there is no terminal')
})

test('a non-interactive tier override never claims', async () => {
  const r = await decide(pre('acp-ask'), makeEnv({ ACP_AGENT_TIER: 'background' }), probes())
  assertHeldDeny(r)
})

// --- Request bodies ------------------------------------------------------------

test('an allowed PreToolUse still carries the claim', async () => {
  const { out } = await decide(pre('npm test', { permissionMode: 'auto' }), makeEnv(), probes())
  assert.equal(out.decision, 'allow')
  assert.deepEqual(lastPre().attended, { claim: true, source: 'permission_mode', mode: 'auto' })
  assert.deepEqual(lastPre().capabilities, ['native_ask'])
})

test('PostToolUse bodies carry neither attended nor capabilities', async () => {
  await decide(pre('echo hi', { hookEventName: 'post_tool_use', toolOutput: 'fine' }), makeEnv(), probes())
  const body = seen.at(-1)
  assert.equal(body.path, '/govern/tool-output')
  assert.equal('attended' in body.payload, false)
  assert.equal('capabilities' in body.payload, false)
})

test('gateway unreachable with an ask-capable Grok keeps the interactive fail-open posture', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300' })
  const { out, warn } = await decide(pre('acp-ask'), env, probes())
  assert.equal(out.decision, 'allow')
  assert.match(warn, /UNGOVERNED: gateway unreachable/)
})

// --- runHook exit code and stderr ------------------------------------------

async function runCli(payload, env, deps) {
  let stdout = ''
  let stderr = ''
  const prior = process.exitCode
  process.exitCode = 0
  try {
    await runHook(undefined, {
      stdin: [JSON.stringify(payload)],
      stdout: { write: (s) => { stdout += s } },
      stderr: { write: (s) => { stderr += s } },
      env,
      deps,
    })
    return { stdout, stderr, exitCode: process.exitCode }
  } finally {
    process.exitCode = prior
  }
}

test('runHook: an ask exits 0 and writes nothing to stderr', async () => {
  const r = await runCli(pre('acp-ask'), makeEnv(), probes())
  assert.equal(r.exitCode, 0)
  assert.equal(r.stderr, '')
  const out = JSON.parse(r.stdout)
  assert.equal(out.decision, 'ask')
  assert.equal(out.reason, ACP_ASK)
})

test('runHook: a held deny still exits 2', async () => {
  const r = await runCli(pre('acp-ask'), makeEnv(), probes('1.0.12'))
  assert.equal(r.exitCode, 2)
  assert.equal(JSON.parse(r.stdout).decision, 'deny')
  assert.notEqual(r.stderr, '')
})

test('runHook: the exit-2 stderr line carries the whole held-deny reason, link included', async () => {
  const r = await runCli(pre('acp-ask'), makeEnv(), probes('1.0.12'))
  const firstLine = r.stderr.split('\n')[0]
  assert.match(firstLine, /Grok cannot ask here/)
  assert.ok(firstLine.endsWith(ACP_ASK), 'gateway reason and its link are on the first stderr line')
  // stdout keeps the reason exactly as decide() built it.
  assert.ok(JSON.parse(r.stdout).reason.endsWith(`\n\n${ACP_ASK}`))
})

test('a held deny always names the console, even when the gateway reason has no link', async () => {
  const { out } = await decide(pre('plain-ask'), makeEnv(), probes('1.0.12'))
  assert.equal(out.decision, 'deny')
  assert.ok(out.reason.includes('https://cloud.agenticcontrolplane.com/activity'))
  assert.ok(out.reason.endsWith('\n\noutward-facing'))
  const custom = await decide(pre('plain-ask'), makeEnv({ ACP_CONSOLE_BASE: 'https://console.example.test' }), probes('1.0.12'))
  assert.ok(custom.out.reason.includes('https://console.example.test/activity'))
})

// --- Version lookup ------------------------------------------------------------

function fakeGrok() {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-ver-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const file = join(bin, 'grok')
  writeFileSync(file, '#!/bin/sh\necho never-run\n', { mode: 0o755 })
  return { env: { HOME: home, PATH: bin }, file, cache: join(home, '.acp', 'hooks', 'grok-build', 'grok-version.json') }
}

test('version lookup runs grok once per binary path and mtime, then reads the cache file', async () => {
  const { env, file, cache } = fakeGrok()
  const calls = []
  const run = (bin, opts) => { calls.push({ bin, opts }); return 'grok 1.0.45\n' }

  assert.equal(await lookupGrokVersion({ env, run }), '1.0.45')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].opts.timeoutMs <= 1500)
  assert.ok(existsSync(cache))
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).version, '1.0.45')

  // Second call is served from the cache file, not the binary.
  const cached = JSON.parse(readFileSync(cache, 'utf8'))
  writeFileSync(cache, JSON.stringify({ ...cached, version: '1.0.50' }))
  assert.equal(await lookupGrokVersion({ env, run }), '1.0.50')
  assert.equal(calls.length, 1)

  // A new binary (new modification time) is looked up again.
  utimesSync(file, new Date(), new Date(Date.now() + 60_000))
  assert.equal(await lookupGrokVersion({ env, run }), '1.0.45')
  assert.equal(calls.length, 2)
})

test('version lookup: a failing runner yields unknown, and unknown is cached too', async () => {
  const { env } = fakeGrok()
  let calls = 0
  const run = () => { calls++; throw new Error('spawn failed') }
  assert.equal(await lookupGrokVersion({ env, run }), 'unknown')
  assert.equal(await lookupGrokVersion({ env, run }), 'unknown')
  assert.equal(calls, 1)
})

test('version lookup: an unknown answer is retried once the retry window has passed', async () => {
  const { env, cache } = fakeGrok()
  let calls = 0
  const failing = () => { calls++; throw new Error('cold start') }
  assert.equal(await lookupGrokVersion({ env, run: failing }), 'unknown')
  assert.equal(calls, 1)
  const cached = JSON.parse(readFileSync(cache, 'utf8'))
  writeFileSync(cache, JSON.stringify({ ...cached, checkedAt: Date.now() - 11 * 60 * 1000 }))
  assert.equal(await lookupGrokVersion({ env, run: () => { calls++; return 'grok 1.0.45' } }), '1.0.45')
  assert.equal(calls, 2)
})

test('version lookup: a date-like number is not a Grok version', async () => {
  const { env } = fakeGrok()
  assert.equal(await lookupGrokVersion({ env, run: () => 'grok 2026.11.01 build' }), 'unknown')
})

test('version lookup asks the Grok that invoked the hook, not the one on PATH', async () => {
  const { env } = fakeGrok()
  const other = mkdtempSync(join(tmpdir(), 'grok-acp-invoking-'))
  const invoking = join(other, 'grok')
  writeFileSync(invoking, '#!/bin/sh\necho never-run\n', { mode: 0o755 })
  const ran = []
  const run = (bin) => { ran.push(bin); return bin === realpathSync(invoking) ? 'grok 1.0.12' : 'grok 1.0.45' }
  const version = await lookupGrokVersion({ env, run, ancestors: () => ['/bin/sh', invoking] })
  assert.deepEqual(ran, [realpathSync(invoking)])
  assert.equal(version, '1.0.12')
})

test('version lookup skips relative PATH entries', async () => {
  const { env } = fakeGrok()
  let calls = 0
  const rel = relative(process.cwd(), env.PATH)
  assert.ok(!isAbsolute(rel))
  const version = await lookupGrokVersion({ env: { ...env, PATH: rel }, run: () => { calls++; return '1.0.45' }, ancestors: () => [] })
  assert.equal(version, 'unknown')
  assert.equal(calls, 0)
})

test('version lookup: output without a dotted version yields unknown', async () => {
  const { env } = fakeGrok()
  assert.equal(await lookupGrokVersion({ env, run: () => 'grok build (dev)' }), 'unknown')
})

test('version lookup: no grok on PATH yields unknown without running anything', async () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-nobin-'))
  let calls = 0
  const run = () => { calls++; return '1.0.45' }
  assert.equal(await lookupGrokVersion({ env: { HOME: home, PATH: join(home, 'missing') }, run }), 'unknown')
  assert.equal(calls, 0)
})

test('version lookup never waits longer than 1.5 seconds', async () => {
  const { env } = fakeGrok()
  const started = Date.now()
  const version = await lookupGrokVersion({ env, run: () => new Promise(() => {}) })
  const waited = Date.now() - started
  assert.equal(version, 'unknown')
  assert.ok(waited < 2000, `waited ${waited} ms`)
})
