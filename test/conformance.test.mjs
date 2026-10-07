// Shared ACP plugin conformance corpus (davidcrowe/gatewaystack-connect#1344)
// run against the REAL hook.mjs entry point, spawned exactly the way Grok
// Build invokes it (hooks/acp.json: `node hook.mjs` with a JSON payload on
// stdin), against a fake gateway on 127.0.0.1. See
// test/fixtures/plugin-corpus.json for the corpus and its capability
// contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, '..', 'hook.mjs');
const CORPUS_PATH = join(__dirname, 'fixtures', 'plugin-corpus.json');
const PINNED_FINGERPRINT = 'aa186d3fb3e7d18c';
const PLUGIN_NAME = 'grok-build-acp-plugin';

const rawCorpus = readFileSync(CORPUS_PATH);
const fingerprint = createHash('sha256').update(rawCorpus).digest('hex').slice(0, 16);
if (fingerprint !== PINNED_FINGERPRINT) {
  throw new Error(
    `test/fixtures/plugin-corpus.json fingerprint mismatch: got ${fingerprint}, pinned ${PINNED_FINGERPRINT}. `
    + 'Re-vendor a byte-identical copy from the canonical corpus (conformance/plugin-corpus.json).',
  );
}
const corpus = JSON.parse(rawCorpus.toString('utf8'));
const MARKER = corpus.marker;

const rows = corpus.harnesses.filter((h) => h.plugin === PLUGIN_NAME);
assert.ok(rows.length > 0, `corpus has no rows for ${PLUGIN_NAME}`);
for (const row of rows) {
  assert.equal(row.status, 'supported', `${PLUGIN_NAME}/${row.capability} expected "supported" in the corpus`);
}

// grok-build is NOT among the plugins #1334 lists as dropping notices
// (codex, opencode, hermes, fx); hook.mjs's PostToolUse branch returns the
// gateway's notice as `warn`, and runHook() writes that warn to stderr —
// Grok's own scrollback channel (hook.mjs's comments: "Grok has no
// systemMessage channel, so the warning rides stderr into the scrollback").
// No divergence is therefore expected for either capability.
const EXPECTED_DIVERGENCES = [];

test('EXPECTED_DIVERGENCES matches exactly what is recorded for grok-build', () => {
  assert.deepEqual(EXPECTED_DIVERGENCES.map((d) => d.case).sort(), []);
});

function startFakeGateway(gatewayReply) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore malformed body */ }
        requests.push({ method: req.method, path: req.url, body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/govern/tool-output' ? gatewayReply : { decision: 'allow' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, requests }));
  });
}

/** Spawn the REAL hook.mjs the way Grok's hooks/acp.json does: stdin JSON in,
 * stdout JSON decision, stderr for anything the person would see. Isolates
 * HOME to a fresh temp dir and supplies a dummy bearer token (never a real
 * credential) via env, exactly as hook.mjs's own credential lookup expects. */
async function runHook(payload, { shadow } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-conformance-'));
  const { server, base, requests } = await startFakeGateway(payload.__gatewayReply);
  const env = {
    ...process.env,
    HOME: home,
    ACP_BEARER_TOKEN: 'gsk_dummy_test_token_never_real',
    ACP_GOVERN_BASE: base,
  };
  if (shadow !== undefined) env.ACP_SHADOW = shadow; else delete env.ACP_SHADOW;

  const child = spawn(process.execPath, [HOOK_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const { hookPayload } = payload;
  child.stdin.write(JSON.stringify(hookPayload));
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  server.close();
  rmSync(home, { recursive: true, force: true });

  return { stdout, stderr, exitCode, requests };
}

function grokPayload(overrides = {}) {
  return {
    hookEventName: 'pre_tool_use',
    sessionId: 'acpconf-session-0001',
    cwd: '/tmp/project',
    workspaceRoot: '/tmp/project',
    permissionMode: 'default',
    toolName: 'run_terminal_command',
    toolInput: { command: `echo ${MARKER}` },
    ...overrides,
  };
}

const noticeCases = corpus.cases.filter((c) => c.capability === 'notice');
for (const c of noticeCases) {
  test(`notice capability [${c.id}]: person-visible channel = stderr scrollback (Grok has no systemMessage channel)`, async () => {
    const { stdout, stderr } = await runHook({
      __gatewayReply: c.gatewayReply,
      hookPayload: grokPayload({
        hookEventName: 'post_tool_use',
        toolInput: { command: 'echo unrelated' },
        toolOutput: 'unrelated tool output, no marker here',
      }),
    }, { shadow: c.env?.ACP_SHADOW });

    const seenOnStderr = stderr.includes(c.expect.contains);
    const seenOnStdout = stdout.includes(c.expect.contains);
    const div = EXPECTED_DIVERGENCES.find((d) => d.case === c.id);
    if (div) {
      assert.notEqual(seenOnStderr, c.expect.personSees, `divergence ${div.issue} (${c.id}) should still reproduce — if this matches expect.personSees now, remove the EXPECTED_DIVERGENCES entry`);
    } else {
      assert.equal(seenOnStderr, c.expect.personSees, `${c.id}: stderr marker presence should match expect.personSees`);
    }
    // The decision object on stdout is a control-plane detail, never a
    // display channel — the marker must never leak there either way.
    assert.equal(seenOnStdout, false, `${c.id}: stdout is not a person-visible display channel and must never carry the notice`);
  });
}

test('post-tool capability [post-tool-fields]: native pre/post payload -> /govern/tool-output body', async () => {
  const c = corpus.cases.find((x) => x.id === 'post-tool-fields');
  const { requests } = await runHook({
    __gatewayReply: c.gatewayReply,
    hookPayload: grokPayload({
      hookEventName: 'post_tool_use',
      toolName: c.call.tool === 'shell' ? 'run_terminal_command' : c.call.tool,
      sessionId: c.call.sessionId,
      toolInput: { command: c.call.command },
      toolOutput: c.call.output,
    }),
  });

  const req = requests.find((r) => r.path === '/govern/tool-output');
  assert.ok(req, 'expected a POST /govern/tool-output request');
  const body = req.body;

  // Declared mapping (hook.mjs CANONICAL_TOOL): the native Grok tool id
  // "run_terminal_command" -> the Claude Code-canonical "Bash".
  const CANONICAL_SHELL_NAME = 'Bash';

  const checks = {
    hook_event_name: body.hook_event_name === 'PostToolUse',
    tool_name: body.tool_name === CANONICAL_SHELL_NAME,
    tool_input: typeof body.tool_input === 'object' && body.tool_input !== null && JSON.stringify(body.tool_input).includes(MARKER),
    tool_output: JSON.stringify(body.tool_output ?? '').includes(MARKER),
    session_id: typeof body.session_id === 'string' && body.session_id.length > 0,
  };
  const conforms = Object.values(checks).every(Boolean);
  const div = EXPECTED_DIVERGENCES.find((d) => d.case === 'post-tool-fields');

  if (div) {
    assert.notEqual(conforms, true, `divergence ${div.issue} should still reproduce (checks: ${JSON.stringify(checks)})`);
  } else {
    assert.equal(conforms, true, `all post-tool fields should conform (checks: ${JSON.stringify(checks)})`);
  }
});
