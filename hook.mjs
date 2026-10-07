#!/usr/bin/env node
/**
 * Agentic Control Plane hook for Grok Build (xAI).
 *
 * Grok Build hooks are one-shot shell commands: the harness invokes the
 * command per lifecycle event with a camelCase JSON payload on stdin and
 * reads a decision from stdout. This command handles:
 *
 *   pre_tool_use              -> POST {ACP_GOVERN}/govern/tool-use
 *   post_tool_use (+failure)  -> POST {ACP_GOVERN}/govern/tool-output
 *   stop                      -> session receipt (gatewaystack-connect#606)
 *
 * OUTPUT CONTRACT (verified in the open-source hook runner,
 * crates/codegen/xai-grok-hooks/src/runner/mod.rs, 2026-08-19):
 *   - PreToolUse gates parse ONLY the top-level `decision` field:
 *     "deny" (+ `reason`) blocks; "allow" or absent allows; any other value
 *     is an unknown-decision error. Claude's `hookSpecificOutput.
 *     permissionDecision` is NOT parsed (xAI's own example emits it for
 *     forward-compatibility only), and Claude's legacy "approve"/"block"
 *     values are unknown-decision errors. There is NO "ask" decision.
 *   - Exit code 2 is an alternate deny channel (first stderr line becomes
 *     the reason); a stdout deny is honored regardless of exit code. We
 *     emit both on deny — belt and braces.
 *   - Everything else about a failing hook (timeout, crash, bad JSON) is
 *     FAIL-OPEN by Grok's design. Our unattended fail-closed posture below
 *     therefore rides on the deny channel, not on erroring out.
 *
 * ASK MAPPING: Grok has no ask decision (docs.x.ai/build/features/hooks:
 * "Only an explicit deny blocks"; exit 0 allows, exit 2 denies), and a hook
 * allow does not reach the human — it only declines to deny, after which
 * Grok's own gate auto-approves reads, searches and allow-listed shell
 * commands. An ACP `ask` therefore fails CLOSED in every permission mode:
 * deny, with the ACP reason and the console approval link. Never allow.
 *
 * Unreachability posture (gatewaystack-connect#385, never-brick): interactive
 * sessions fail OPEN with a loud UNGOVERNED warning and a ~/.acp/lapse.log
 * entry; unattended tiers fail CLOSED — nobody is watching, so the block is
 * the safety net. Policy denies are unaffected; this posture only covers the
 * inability to ASK the policy.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOOK_VERSION = '0.1.0'

/** 200 KB ceiling on tool output sent for post-hoc scanning (matches the backend). */
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024

/** Hook decision budget: control-plane calls answer fast or get out of the way.
 * Keep well under the registered hook timeout (30s in hooks/acp.json) so the
 * fail posture below decides the outcome, not Grok's own fail-open timeout. */
const CHECK_TIMEOUT_MS = 4000

const ACP_DIR = join(homedir(), '.acp')

function acpDir(env = process.env) {
  return env.HOME ? join(env.HOME, '.acp') : ACP_DIR
}

function readToken(env = process.env) {
  if (env.ACP_BEARER_TOKEN) return env.ACP_BEARER_TOKEN
  // Same order as the other harness plugins' credential lookup — keep in sync.
  for (const file of ['credentials', 'proxy-key']) {
    try {
      const value = readFileSync(join(acpDir(env), file), 'utf8').trim()
      if (value) return value
    } catch { /* absent or unreadable — try the next path */ }
  }
  return null
}

function lapseLine(fields) {
  try {
    mkdirSync(ACP_DIR, { recursive: true })
    appendFileSync(
      join(ACP_DIR, 'lapse.log'),
      JSON.stringify({ at: new Date().toISOString(), client: 'grok-build-hook', ...fields }) + '\n',
    )
  } catch { /* the lapse log is best-effort — never block a call on it */ }
}

/** Modes where a human answers prompts. Everything else has an empty chair. */
const ATTENDED_MODES = new Set(['default', 'plan'])

/**
 * Tier resolution, in trust order: explicit env, config file, CI markers,
 * then the payload's own permissionMode — `bypassPermissions` and `dontAsk`
 * mean no human is answering prompts (fail-closed posture). `auto` keeps a
 * human at the terminal (the classifier only auto-answers), so it stays
 * interactive for the unreachability posture even though asks fail closed.
 */
function resolveTier(env = process.env, config = {}, permissionMode) {
  if (env.ACP_AGENT_TIER) return env.ACP_AGENT_TIER
  if (config.agent_tier) return config.agent_tier
  if (env.CI) return 'background'
  if (permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk') return 'background'
  return 'interactive'
}

/** Read a field under both Grok's camelCase and Claude's snake_case. */
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined) return obj[k]
  return undefined
}

/**
 * Grok-native → canonical tool names (the inverse of the alias table in
 * Grok's own hooks guide). The gateway's content floors key on the canonical
 * vocabulary — sending `run_terminal_command` verbatim sailed a hardline
 * `rm -rf /` straight past the floor in live verification (2026-08-19), so
 * the canonical name goes in `tool_name` and the native name rides along as
 * `client_tool_name` for audit fidelity. Unknown names (including MCP
 * `server__tool` forms) pass through unchanged.
 */
const CANONICAL_TOOL = {
  run_terminal_command: 'Bash',
  read_file: 'Read',
  search_replace: 'Edit',
  grep: 'Grep',
  list_dir: 'Glob',
  web_search: 'WebSearch',
  spawn_subagent: 'Task',
}

/** Canonicalize event spellings: "pre_tool_use" / "PreToolUse" / "preToolUse". */
function canonEvent(value) {
  const flat = String(value ?? '').replace(/[_-]/g, '').toLowerCase()
  const map = {
    pretooluse: 'PreToolUse',
    posttooluse: 'PostToolUse',
    posttoolusefailure: 'PostToolUseFailure',
    stop: 'Stop',
    subagentstop: 'SubagentStop',
    sessionstart: 'SessionStart',
    permissiondenied: 'PermissionDenied',
  }
  return map[flat] ?? (value || 'PreToolUse')
}

function normalize(payload, env = process.env) {
  return {
    event: canonEvent(
      pick(payload, 'hookEventName', 'hook_event_name', 'event') ?? env.GROK_HOOK_EVENT,
    ),
    toolName: pick(payload, 'toolName', 'tool_name', 'tool') ?? 'unknown',
    toolInput: pick(payload, 'toolInput', 'tool_input', 'input') ?? {},
    toolOutput: pick(payload, 'toolOutput', 'tool_output', 'result', 'output'),
    toolUseId: pick(payload, 'toolUseId', 'tool_use_id'),
    sessionId: pick(payload, 'sessionId', 'session_id') ?? env.GROK_SESSION_ID,
    cwd: pick(payload, 'cwd', 'workspaceRoot', 'workspace_root') ?? env.GROK_WORKSPACE_ROOT ?? process.cwd(),
    permissionMode: pick(payload, 'permissionMode', 'permission_mode'),
  }
}

/**
 * Encode a decision in Grok's vocabulary, with Claude's camelCase
 * `hookSpecificOutput` alongside for forward-compatibility (the pattern
 * xAI's own example hook uses; unknown stdout keys are tolerated).
 */
function encodeDeny(reason, event) {
  return {
    decision: 'deny',
    reason,
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

const ALLOW = { decision: 'allow' }

/**
 * Operational overrides live in ~/.acp/config.json (govern_base, console_base,
 * agent_tier, shadow, check_timeout_ms). Env wins when present — Grok passes
 * the environment through, and per-hook `env` maps can set these too.
 */
function readConfig(env = process.env) {
  try {
    return JSON.parse(readFileSync(join(acpDir(env), 'config.json'), 'utf8'))
  } catch { return {} }
}

async function post(base, headers, path, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    })
    if (!res.ok) {
      // Tagged so the retry can tell "the server answered with a status" from
      // "the request never landed". Re-rolling a 429 would deepen the rate
      // limit it is reporting.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      err.httpStatus = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// --- Session receipt bookkeeping. Each hook invocation is a fresh process,
// so counts live in a per-session file; a stats failure must never affect a
// call, so every touch is wrapped. ---
function statsPath(sessionId) {
  return join(ACP_DIR, 'grok-sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`)
}

function bump(sessionId, field) {
  if (!sessionId) return
  try {
    mkdirSync(join(ACP_DIR, 'grok-sessions'), { recursive: true })
    const p = statsPath(sessionId)
    let s = { calls: 0, denied: 0, asked: 0, notices: 0 }
    try { s = JSON.parse(readFileSync(p, 'utf8')) } catch { /* first call this session */ }
    s[field] = (s[field] ?? 0) + 1
    writeFileSync(p, JSON.stringify(s))
  } catch { /* bookkeeping only */ }
}

export function buildReceiptMessage(stats, sessionId, consoleBase = 'https://cloud.agenticcontrolplane.com') {
  if (!stats || !(stats.calls > 0)) return null
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? '' : 's'} governed`]
  if (stats.denied > 0) parts.push(`${stats.denied} denied`)
  if (stats.asked > 0) parts.push(`${stats.asked} held for approval`)
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? '' : 's'}`)
  const url = `${consoleBase}/sessions/${encodeURIComponent(String(sessionId))}`
  return `[ACP] Session receipt: ${parts.join(' · ')} — review this session: ${url}`
}

export async function decide(payload, env = process.env) {
  const call = normalize(payload, env)
  const config = readConfig(env)
  const tier = resolveTier(env, config, call.permissionMode)
  const token = readToken(env)

  if (!token) {
    // Loud, once per invocation, plus a durable lapse line — an uncredentialed
    // control plane must never be mistaken for a live one. Grok has no
    // systemMessage channel, so the warning rides stderr into the scrollback.
    lapseLine({ kind: 'UNGOVERNED', reason: 'no-credentials', tool: call.toolName, session: call.sessionId })
    const warn = '[ACP] ⚠ UNGOVERNED: no credential (ACP_BEARER_TOKEN or ~/.acp/credentials) — '
      + 'tool calls run WITHOUT policy checks and ACP has no record of them. '
      + 'Connect at https://cloud.agenticcontrolplane.com'
    return { out: ALLOW, warn }
  }

  const govern = (env.ACP_GOVERN_BASE ?? env.ACP_API_BASE ?? config.govern_base ?? 'https://govern.agenticcontrolplane.com').replace(/\/$/, '')
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GS-Client': `grok-build-hook/${HOOK_VERSION}`,
  }
  const timeoutMs = Number(env.ACP_CHECK_TIMEOUT_MS) || Number(config.check_timeout_ms) || CHECK_TIMEOUT_MS
  const base = {
    tool_name: CANONICAL_TOOL[call.toolName] ?? call.toolName,
    client_tool_name: call.toolName,
    tool_input: call.toolInput,
    session_id: call.sessionId,
    cwd: call.cwd,
    hook_event_name: call.event,
    agent_tier: tier,
  }

  if (call.event === 'Stop' || call.event === 'SubagentStop') {
    // Session end: emit the receipt to stderr (scrollback) and clear the
    // counter file. Never emit a Stop-gate decision — a receipt must not be
    // able to block the agent from stopping.
    try {
      const p = statsPath(call.sessionId)
      const s = JSON.parse(readFileSync(p, 'utf8'))
      unlinkSync(p)
      const line = buildReceiptMessage(s, call.sessionId, env.ACP_CONSOLE_BASE ?? config.console_base)
      return line ? { out: {}, warn: line } : { out: {} }
    } catch { return { out: {} } }
  }

  if (call.event === 'PostToolUse' || call.event === 'PostToolUseFailure') {
    let outputStr = typeof call.toolOutput === 'string' ? call.toolOutput : JSON.stringify(call.toolOutput ?? '')
    if (Buffer.byteLength(outputStr, 'utf8') > POST_HOOK_PAYLOAD_CEILING) {
      outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING)
    }
    let data
    try {
      data = await post(govern, headers, '/govern/tool-output', { ...base, tool_output: outputStr }, timeoutMs)
    } catch {
      // Post-hoc scanning is observability: silent pass-through, the call
      // already ran. The pre-call check is where unreachability gets loud.
      return { out: {} }
    }
    if (data.action === 'block') {
      // Grok's PreToolUse is its only blocking tool event — a post-hoc block
      // can't stop anything here, so it degrades to a loud audit line. The
      // gateway still has the full record.
      bump(call.sessionId, 'denied')
      return { out: {}, warn: `[ACP] Flagged after the fact: ${data.reason ?? 'policy'} — recorded in the audit log.` }
    }
    if (typeof data.notice === 'string' && data.notice.trim() && !/^(off|0|false)$/i.test(env.ACP_SHADOW ?? config.shadow ?? '')) {
      // Shadow-mode counterfactual (#607): advisory, arrives with action "pass".
      bump(call.sessionId, 'notices')
      return { out: {}, warn: data.notice }
    }
    return { out: {} }
  }

  // PreToolUse resolves against the pre-call policy.
  let data
  try {
    try {
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    } catch (first) {
      // Retry once before applying the fail posture (gatewaystack-connect#690):
      // slow answers are cold starts, so the retry lands on a warm instance.
      // Retry only a transport failure — an HTTP status is the server answering.
      if (first?.httpStatus !== undefined) throw first
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    }
  } catch (error) {
    const detail = error?.name === 'AbortError' ? 'request timed out' : (error?.message ?? 'network error')
    if (tier === 'interactive') {
      lapseLine({ kind: 'UNGOVERNED', tool: call.toolName, tier, detail })
      const warn = `[ACP] ⚠ UNGOVERNED: gateway unreachable (${detail}) — ${call.toolName} proceeded WITHOUT policy check. Lapse logged to ~/.acp/lapse.log.`
      return { out: ALLOW, warn }
    }
    return {
      out: encodeDeny(
        `[ACP] Gateway unreachable (${detail}) — ${tier} tier stays blocked when policy can't be consulted (fail-closed for unattended agents; interactive sessions fail open).`,
        call.event),
      deny: true,
    }
  }

  bump(call.sessionId, 'calls')
  if (data.decision === 'deny') {
    bump(call.sessionId, 'denied')
    return { out: encodeDeny(`[ACP] Denied by policy: ${data.reason ?? 'policy did not return a reason'}`, call.event), deny: true }
  }
  if (data.decision === 'ask') {
    bump(call.sessionId, 'asked')
    // Grok has no ask decision and a hook "allow" only declines to deny: the
    // call then falls through to Grok's own gate, which auto-approves reads,
    // searches and allow-listed shell commands — so an allow here would turn
    // a policy ask into a silent allow. Fail closed in every mode; the reason
    // carries the ACP verdict and the place to approve it.
    const where = ATTENDED_MODES.has(call.permissionMode)
      ? 'Grok hooks cannot prompt, so the call is held'
      : `nobody is at the prompt in ${call.permissionMode ?? 'this'} mode, so the call is held`
    const reason = `[ACP] Approval required: ${data.reason ?? 'approval required'} — ${where}. Approve it: ${(env.ACP_CONSOLE_BASE ?? config.console_base ?? 'https://cloud.agenticcontrolplane.com')}/activity`
    return { out: encodeDeny(reason, call.event), deny: true }
  }
  if (data.warning) return { out: ALLOW, warn: String(data.warning) }
  return { out: ALLOW }
}

export async function runHook(fallbackEvent) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let payload = {}
  try { payload = JSON.parse(raw) } catch { /* empty or non-JSON stdin — still answer */ }
  if (fallbackEvent && payload.hookEventName === undefined && payload.hook_event_name === undefined) {
    payload.hookEventName = fallbackEvent
  }

  let result
  try {
    result = await decide(payload)
  } catch (error) {
    // A hook crash must never take the harness down with it: fail open with
    // a loud trace rather than let an unhandled rejection decide anything.
    lapseLine({ kind: 'HOOK_ERROR', detail: error?.message })
    result = { out: ALLOW, warn: `[ACP] hook error (${error?.message ?? 'unknown'}) — call proceeded WITHOUT policy check` }
  }
  // On deny, stderr's first line doubles as the reason for the exit-2 channel.
  if (result.deny) {
    process.stderr.write((result.out.reason ?? 'denied by ACP') + '\n')
  } else if (result.warn) {
    process.stderr.write(result.warn + '\n')
  }
  process.stdout.write(JSON.stringify(result.out) + '\n')
  // Exit 2 is Grok's alternate deny channel; the stdout deny is authoritative
  // either way, so this only hardens against stdout parse edge cases.
  if (result.deny) process.exitCode = 2
}

// Only run the CLI when invoked directly — tests import decide() without I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
  runHook()
}
