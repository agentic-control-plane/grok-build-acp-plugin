# @agenticcontrolplane/grok-build

![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

[Agentic Control Plane](https://agenticcontrolplane.com) governance hook for **Grok Build** (xAI's coding agent). Every tool call is checked against your workspace policy before it runs — and because Grok Build fires `PreToolUse` hooks in **every** permission mode, the policy holds even in `--always-approve`.

Before any tool runs, ACP is consulted via `/govern/tool-use`; after it runs, the output goes to `/govern/tool-output` for audit and PII scan. Session end emits a receipt with a review link.

## Install

```bash
curl -fsSL https://agenticcontrolplane.com/install.sh | bash
```

The installer detects Grok Build, places the hook at `~/.acp/hooks/grok-build/hook.mjs`, and registers it in `~/.grok/hooks/acp.json` (user-global — no per-project trust prompt). Manual install:

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
| `Stop` | — | Session receipt in the scrollback with a console review link |

**Tool-name mapping.** Grok's native names (`run_terminal_command`, `read_file`, `search_replace`, …) are mapped to the canonical vocabulary before the policy check so content floors fire — verified live: `rm -rf /` hits the hardline floor under the native name. The native name is preserved as `client_tool_name` in the audit record. Unknown and MCP (`server__tool`) names pass through.

## The ask decision

Grok Build's hook contract has no `ask` — a gate hook can only allow or deny. An ACP `ask` verdict resolves by permission mode:

- **`default` / `plan`** — a human answers prompts and Grok's own permission gate still stands after this hook, so the ask lands on the native prompt. Caveat: an explicit local allow rule outranks an ACP ask in these modes. ACP denies always hold.
- **`auto` / `bypassPermissions` / headless** — nobody is at the prompt: the ask becomes a deny whose reason carries the console link.

## Failure posture

Grok Build hooks are **fail-open by design** — a timed-out, crashed, or malformed hook logs and allows. This hook therefore makes its posture explicit rather than inheriting Grok's:

- **Interactive sessions** (`default`/`plan`/`auto`): gateway unreachable → fail **open**, loudly — `[ACP] ⚠ UNGOVERNED` on stderr and a durable line in `~/.acp/lapse.log`. An ACP outage must never brick your session.
- **Unattended tiers** (`bypassPermissions`, headless, CI): fail **closed** — nobody is watching, so the block is the safety net.
- One retry on transport failure before the posture applies (cold starts answer on the second try). HTTP error statuses are the server answering — never retried.
- The registered hook timeout (30s) sits far above the internal 4s decision budget, so our posture decides the outcome, not Grok's fail-open timer.

For yolo users: `--always-approve` bypasses Grok's own prompts but **not** this hook — Grok fires deny rules and PreToolUse hooks in every mode. That is the point.

## Configuration

Environment (or `~/.acp/config.json` — snake_case keys — for setups where env doesn't reach hooks):

| Env | Config key | Default |
|---|---|---|
| `ACP_BEARER_TOKEN` | — | `~/.acp/credentials` |
| `ACP_GOVERN_BASE` | `govern_base` | `https://govern.agenticcontrolplane.com` |
| `ACP_CONSOLE_BASE` | `console_base` | `https://cloud.agenticcontrolplane.com` |
| `ACP_AGENT_TIER` | `agent_tier` | resolved from `permissionMode` / CI |
| `ACP_CHECK_TIMEOUT_MS` | `check_timeout_ms` | `4000` |
| `ACP_SHADOW` | `shadow` | shadow-mode notices on |

## Tests

```bash
node --test test/*.test.mjs
```

17 offline tests against a mock gateway (payload parsing both vocabularies, deny/ask/allow, both fail postures, retry discipline, tool-name mapping, receipts). Deny/allow/receipt additionally verified live against the production gateway on Grok's documented payload shape.

## Which ACP?

This is the **Agentic Control Plane**. Grok Build also speaks Zed's **Agent Client Protocol** (`grok agent stdio`) — an editor-integration protocol that shares the acronym. [Disambiguation.](https://agenticcontrolplane.com/acp-vs-acp)

## License

MIT
