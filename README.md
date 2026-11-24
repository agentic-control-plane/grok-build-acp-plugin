# @agenticcontrolplane/grok-build

![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

[Agentic Control Plane](https://agenticcontrolplane.com) governance hook for **Grok Build** (xAI's coding agent). Every tool call is checked against your workspace policy before it runs. Grok Build fires `PreToolUse` hooks in every permission mode, so the check also runs in `--always-approve`.

Before any tool runs, ACP is consulted via `/govern/tool-use`; after it runs, the output goes to `/govern/tool-output` for audit and PII scan. Session end emits a receipt with a review link.

## Install

```bash
curl -fsSL https://agenticcontrolplane.com/install.sh | bash
```

The installer detects Grok Build, places the hook at `~/.acp/hooks/grok-build/hook.mjs`, and registers it in `~/.grok/hooks/acp.json` (user-global, so there is no per-project trust prompt). Manual install:

```bash
mkdir -p ~/.acp/hooks/grok-build ~/.grok/hooks
curl -fsSL https://raw.githubusercontent.com/agentic-control-plane/grok-build-acp-plugin/main/hook.mjs \
  -o ~/.acp/hooks/grok-build/hook.mjs
curl -fsSL https://raw.githubusercontent.com/agentic-control-plane/grok-build-acp-plugin/main/hooks/acp.json \
  -o ~/.grok/hooks/acp.json
```

Credentials live at `~/.acp/credentials` (the installer provisions them; or paste a workspace key from [cloud.agenticcontrolplane.com](https://cloud.agenticcontrolplane.com)).

## What it does

| Grok event | ACP call | Effect |
|---|---|---|
| `PreToolUse` | `POST /govern/tool-use` | `deny` blocks the call (top-level `decision:"deny"` + exit 2, both channels); `ask` resolves by mode (below); `allow` proceeds |
| `PostToolUse` / `PostToolUseFailure` | `POST /govern/tool-output` | Audit + PII scan; a post-hoc block degrades to a loud audit line (Grok's only blocking tool event is `PreToolUse`) |
| `Stop` | none | Session receipt in the scrollback with a console review link |

**Tool-name mapping.** Grok's native names (`run_terminal_command`, `read_file`, `search_replace`, …) are mapped to the canonical vocabulary before the policy check so content floors fire. For example, `rm -rf /` hits the hardline floor under the native name. The native name is preserved as `client_tool_name` in the audit record. Unknown and MCP (`server__tool`) names pass through.

## The ask decision

When ACP holds a call for approval, Grok shows its own confirmation prompt if it can. The prompt names the hook and shows the ACP reason. Answer yes and the call runs; answer no and it does not.

The prompt appears only when all of these are true:

- Grok Build is version 1.0.13 or newer. The hook runs `grok --version` once per installed binary, waits at most 1.5 seconds, and caches the answer in `~/.acp/hooks/grok-build/grok-version.json`. If the version cannot be read, the hook tries again after 10 minutes. On Linux the hook checks the Grok that started it. On other systems it checks the first `grok` in a full path on `PATH`, so keep only one Grok installed there. An older Grok started by another path would run a held call without asking.
- The permission mode is `default`, `plan` or `auto`. In `auto` mode the prompt still appears, even for commands you saved as "always allow".
- `CI` is not set.
- The agent tier is interactive. Setting `ACP_AGENT_TIER` or `agent_tier` in `~/.acp/config.json` to anything else blocks the call instead.
- The hook has a terminal a person can answer at.

In every other case the held call is blocked instead. That covers `--always-approve` (it would answer the prompt by itself), `dontAsk` mode (it never prompts), CI, runs without a terminal, and a Grok version that is older than 1.0.13 or cannot be read. Grok versions before 1.0.13 do not understand an ask and would run the call, so an unreadable version always counts as too old. The block message says why Grok cannot ask and ends with the ACP reason, including any approval link it carries. Approve the call in the ACP console and run it again, or set an allow rule for the tool.

The hook tells the gateway which case applies on every pre-call check (`attended` and `capabilities: ["native_ask"]`), so the gateway knows whether a person can be asked.

## Failure posture

Grok Build hooks are **fail-open by design**: a timed-out, crashed, or malformed hook logs and allows. This hook sets its own posture instead of inheriting Grok's. If the gateway is unreachable:

- **Interactive sessions** (`default`/`plan`/`auto`) fail **open**, loudly: `[ACP] ⚠ UNGOVERNED` on stderr and a durable line in `~/.acp/lapse.log`.
- **Unattended tiers** (`bypassPermissions`, `dontAsk`, or `CI` set) fail **closed**. A headless run with none of those signals counts as interactive. Nobody is watching, so the block is the safety net.
- There is one retry on transport failure before the posture applies (cold starts answer on the second try). HTTP error statuses are the server answering and are never retried.
- The registered hook timeout (30s) sits far above the internal 4s decision budget, so this hook's posture decides the outcome, not Grok's fail-open timer.

`--always-approve` bypasses Grok's own prompts but not this hook, because Grok fires deny rules and PreToolUse hooks in every mode.

## Configuration

Environment (or `~/.acp/config.json` with snake_case keys, for setups where env doesn't reach hooks):

| Env | Config key | Default |
|---|---|---|
| `ACP_BEARER_TOKEN` | none | `~/.acp/credentials` |
| `ACP_GOVERN_BASE` | `govern_base` | `https://govern.agenticcontrolplane.com` |
| `ACP_CONSOLE_BASE` | `console_base` | `https://cloud.agenticcontrolplane.com` |
| `ACP_AGENT_TIER` | `agent_tier` | resolved from `permissionMode` / CI |
| `ACP_CHECK_TIMEOUT_MS` | `check_timeout_ms` | `4000` |
| `ACP_SHADOW` | `shadow` | shadow-mode notices on |

## Tests

```bash
node --test test/*.test.mjs
```

Offline tests against a mock gateway cover payload parsing in both vocabularies, deny/ask/allow, both fail postures, retry behavior, tool-name mapping and receipts.

## Which ACP?

This is the **Agentic Control Plane**. Grok Build also speaks Zed's **Agent Client Protocol** (`grok agent stdio`), an editor-integration protocol that shares the acronym. [Disambiguation.](https://agenticcontrolplane.com/acp-vs-acp)

## License

MIT
