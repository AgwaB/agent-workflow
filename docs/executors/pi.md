# Pi executor

`@agwab/agent-workflow/executors/pi` runs one workflow attempt as one Pi process.
Use `createExecutor(config)` with descriptor
`{ id: "pi", version: "0.1.0", module: "@agwab/agent-workflow/executors/pi", config }`.
Source: `src/executors/pi/` (`executor.ts`, `argv.ts`, `parse.ts`, `errors.ts`, `state.ts`,
`run-extension.ts`, `tool-result-budget.ts`, `config.ts`). Keep secrets out of descriptor config.

## CLI and version

Verified with **Pi 1.1.0** on macOS. `PI_MIN_CLI_VERSION = 1.1.0`;
native MCP (`pi.registerMcpServer`, `createMcpExtension`) needs 1.1. Older versions probe as
`mcpInjection: none`.

`probe()` makes no model turn. It runs `pi --version`, `pi --list-models`, `pi list`, and optionally
`pi auth check --model <config.authCheckModel> --json --no-refresh`, each bounded to 15 s.
A failed `pi list` is not cached. The probe also checks registered web tools in an isolated Pi
session that exits before a model request.

`modelListComplete: false`: Pi accepts model patterns such as `sonnet`, so an unlisted model is
not refused. Prefer exact `provider/id` names. Auth is `ready` → `ok`, `not_ready` → `missing`, else
`unknown`. Without `authCheckModel`, at least one authenticated provider's listed model means `ok`,
"No models available" means `missing`, and command failure means `unknown`. This checks credential
presence, not whether a request will succeed; credentials are never read by the adapter.

## Invocation

```text
pi --mode json --print
   (--no-session | --session-dir <state>/sessions/<id> (--session-id <id> | --session <kept file>))
   --exclude-tools subagent
   [isolation] --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve
   [--system-prompt <attempt>/pi-system-prompt.md] [--model <model>] [--thinking <effort>]
   (--tools <allowlist> | --no-tools)
   -e <attempt>/pi-extension.mjs [-e builtin:mcp -e builtin:codemode -e builtin:tool-search] [-e <pi-web-access>]
stdin: the prompt
```

The isolation flags shown above apply only when `isolation.inherit` is false.

| Flag / channel | Purpose |
|---|---|
| `--mode json --print` | One run, JSONL events on stdout, then exit |
| stdin | Prompt is not exposed on argv and avoids argument length limits (Linux caps one argument at 128 KiB) |
| `--no-session` | Default: no kept session |
| `--session-dir` + `--session-id` | Requested sessions live under adapter state |
| `--session <file>` | Resume an owned session file, independent of cwd |
| `--exclude-tools subagent` | Excludes recursive subagents even with inherited extensions |
| `--system-prompt <file>` | Replaces the system prompt without argv length limits |
| `--thinking` | `off minimal low medium high xhigh max`; Pi clamps to the model |
| `--tools` / `--no-tools` | Fine allowlist replacing defaults; injected MCP tools are included explicitly |
| `-e <attempt>/pi-extension.mjs` | Generated mode-0600 extension importing `dist/executors/pi/run-extension.js`; non-secret MCP env keys, budget, fast-tier and orphan-guard config |
| `AGENT_WORKFLOW_PI_RUN_SECRETS_JSON` | MCP env values; deleted from the environment when the extension loads, not written to disk or argv |
| `PI_SKIP_VERSION_CHECK=1` | Suppresses per-worker `pi.dev` version requests |
| fd 3 pipe | Orphan guard SIGTERMs Pi's process group when the owner dies |

Raw output is `<artifactsDir>/pi-stdout.jsonl` and `pi-stderr.log`, falling back to
`<stateDir>/runs/<sha256(attemptKey)>/`. Request and MCP env values of at least 6 characters are
redacted to `[redacted]` in raw output and normalized events, except public `AGENT_WORKFLOW_ROLE`.
`pi-mcp.log`, written by Pi's MCP extension, is not post-processed.

## Isolation

By default, the adapter disables context files, extensions, skills, prompt templates, themes and
project-resource approval. Global and project `AGENTS.md`/`CLAUDE.md` discovery is disabled.
Authentication stays in Pi's own `auth.json` or environment; no credential file is touched.

The run extension starts native MCP through `createMcpExtension` with
`loadConfig: () => ({ servers: [] })`, connects only injected servers, and disables `/mcp` config writes.
With `inherit: true`, Pi loads user extensions, skills, context files and `mcp.json`; injected
servers register on the built-in MCP implementation.

User `settings.json` values not overridden by flags still apply, including retry, compaction,
transport, shell prefix, `httpProxy` and cache warming. Pi has no per-run settings flag.
`PI_CODING_AGENT_DIR` is not relocated because it also moves authentication.

## Tool mapping (Pi names → Pi executor)

Workflow specs use Pi tool names. `toolAllowlist` is native and fine.

| Pi name | Pi executor | ACP kind | Verified |
|---|---|---|---|
| `read` | `read` | read | live, Pi 1.1.0 |
| `grep`, `find`, `ls` | same | search, search, read | built-ins; not called live |
| `bash` | `bash` | execute | offline, real Pi CLI |
| `edit`, `write` | same | edit | not called live |
| `web_search` | `web_search` (pi-web-access) | fetch | live, Pi 1.1.0 |
| `fetch_content` | `fetch_content` (pi-web-access) | fetch | listed by pi-web-access 0.44.0 |
| `workflow_artifact` | MCP `mcp__workflow_artifact__workflow_artifact` | read | live, Pi 1.1.0 |
| other names | none → `CAPABILITY_MISSING:toolAllowlist` before consume | — | unit |

The mapping is `PI_EXECUTOR_TOOL_MAPPING`. ReadOnly is emulated by dropping mutating kinds
(`bash`, `edit`, `write`, `codemode`). ReadOnly requests may inject only the engine's
`workflow_artifact` server; other servers are refused before consume with `CAPABILITY_MISSING:readOnly`.

Web tools require **pi-web-access**, explicitly loaded under isolation. Set `config.webAccessExtension`
or let `pi list` discover it. Install with `pi install npm:pi-web-access` (`PI_WEB_ACCESS_INSTALL`).
Missing packages or disabled tools are reported by the probe and refused before consume with
`CAPABILITY_MISSING:webTools`. The registered-tool check detects tools disabled in `web-search.json`,
sets `unavailableTools`, and reduces `webTools` to `search` or `none`. `agent-workflow doctor --fix`
can re-enable a tool after asking. URL/IP/redaction safety controls are unaudited (`safetyPolicy: unknown`).

`inheritHostTools` is a host-level, per-task descriptor opt-in, honored only for Pi tasks and ignored
for readOnly requests. It adds `codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`, and loads `builtin:mcp`, `builtin:codemode`,
`builtin:tool-search` under isolation. This intentionally exposes the user's `mcp.json` servers.
The capability preview records a host-tools notice. This path is verified offline, not live.

## MCP injection

Pi 1.1 native MCP is configured per run without changing global settings. The generated extension
calls `pi.registerMcpServer(name, { command, args, env, exposure: "direct" })` for each injected
server. Server names must match `[A-Za-z0-9_-]+`. Writable requests declare
`mcp__<server>__*`; readOnly artifact access declares only
`mcp__workflow_artifact__workflow_artifact`.

Pi cuts MCP text above **20,480 UTF-8 bytes** (`MCP_OUTPUT_MAX_BYTES = 20 * 1024`, `truncateMiddle`),
keeping 10 KiB head and 10 KiB tail around `…N chars truncated…`, with a warning header and full-output
temp-file footer. The probe reports `mcpOutputLimitChars = 20480` and `mcpOutputNoticeChars = 1024`.
The engine sets the artifact server's `--max-output-chars 18432`
(20480 − 1024 notice − 1024 margin); larger whole reads are paged.

Pi does not add MCP server `instructions` to model context. Include artifact-tool guidelines in the
rendered prompt; see [MCP](../mcp.md).

## Capabilities

Every row below describes the declared capability and its factual basis. `probed` rows have real-CLI
live or offline coverage.

| Capability | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Pi owns the loop |
| sessionBound | `true` | — | stdout owned by spawning process |
| mcpInjection | native | probed | live, Pi 1.1.0 |
| readOnly | emulated | probed | allowlist; live, Pi 1.1.0 |
| toolAllowlist | native / fine | probed | live, Pi 1.1.0 |
| systemPrompt | native / replace | probed (offline) | `--system-prompt <file>`, Pi 1.1.0 |
| modelSelect | native | probed | `--model`; live, Pi 1.1.0 |
| effortLevels | off…max | — | `--thinking` |
| resume | native / native | probed | live, Pi 1.1.0 |
| partialStream | native | probed | `text_delta` events |
| usage | native / cost | probed | assistant usage; catalog estimate |
| toolTelemetry | native | probed | `tool_execution_start/end` |
| cancel | native / kill | probed | process-group signals; live, Pi 1.1.0 |
| nativeSchema | none | declared | no structured-output flag |
| contextIsolation | native | probed | live and offline, Pi 1.1.0 |
| fastTier | native | **unverified** | offline fake provider streams |
| toolResultBudget | native | probed (offline) | per-run `context` hook, Pi 1.1.0 |
| webTools | native / search+fetch, safetyPolicy **unknown** | unverified (static) / probed via `pi list` | pi-web-access 0.44.0; search live, Pi 1.1.0 |

Set `config.toolResultBudget: { maxTotalChars: N }` to enforce a cumulative tool-result character
budget through the per-run `context` hook; old results are evicted from model context.

Usage is per assistant request. `cached = cacheRead`, `cacheWrite = cacheWrite`, and `model` comes
from the assistant message. Cost is Pi's catalog estimate (`source: estimated`); a reported zero
becomes `null`/`unknown`, since Pi cannot distinguish free from unpriced.

## Fast tier

`fast: "on"` requests `service_tier: priority` for eligible OpenAI models
(`src/core/fast-tier.ts`). The task backend passes per-task `fast` and `fastApi` only when recorded
negotiation accepted `fastTier`. This requires `allowUnverifiedCapabilities: ["fastTier"]`;
otherwise the preview records degradation and the worker runs without fast tier.

The generated wrapper imports `streamOpenAIResponses`, `streamOpenAICodexResponses` and
`clampThinkingLevel` from Pi's `@earendil-works/pi-ai/compat`. At `session_start`, it re-registers
the bound `openai` or `openai-codex` provider with a stream that checks provider/id/api, sends
`serviceTier: priority`, chains upstream `onPayload`, stamps `service_tier`, and clamps reasoning.
`before_provider_request` also checks the binding and stamps the tier.

A model or payload binding mismatch aborts and fails as `config` with `fast tier failed: <reason>`.
Without a provider registry or stream functions, the guard degrades to the payload hook without
changing the outcome. `<attempt>/pi-fast-tier.json` records `status`
(`pending`, `guarded`, `payload-only`, `failed`), binding, `guardedRequests`, `payloadRequests`, `reason`.
Provider-stream behavior is tested offline only; a real priority request is unverified.

## Errors

`PI_ERROR_RULES` uses the first matching rule, else `unknown`. Pi can exit 0 after a provider error;
the adapter checks the last assistant `stopReason: "error"` and `errorMessage` before exit/stderr.

The answer ends at the first assistant message with `stopReason: "stop"`. Later extension-triggered
turns, such as pi-web-access `web-search-content-ready`, contribute usage but cannot replace the
answer or fail the completed task.

| Text | Class | Evidence |
|---|---|---|
| context length / window exceeded | permanent | source: `errors.ts` |
| `Model "<x>" not found` | config | offline, Pi 1.1.0 |
| `Unknown option`, `Invalid thinking level` | config | source: `errors.ts` |
| `workflow fast mode … binding mismatch`, `fast tier failed` | config | offline fake provider stream |
| `No API key found for <provider>` | auth | offline, Pi 1.1.0 |
| `(401)`/`(403)`, `invalid_api_key` | auth | live, Pi 1.1.0 |
| OAuth expired/refresh | auth | source: `errors.ts` |
| `(404)`, `model_not_found`, `does not exist` | config | source: `errors.ts` |
| `"code": 429`, `RESOURCE_EXHAUSTED` | rate_limit | live, Pi 1.1.0 |
| `(429)`, rate limit, quota, usage limit | rate_limit | source: `errors.ts` |
| `"code": 5xx`, `Internal Server Error`, `Internal error encountered` | transient | live, Pi 1.1.0 |
| `(500/502/503/504/529)`, overloaded, ECONNRESET, ETIMEDOUT, fetch failed, terminated | transient | source: `errors.ts` |
| anything else | unknown | source: `errors.ts` |

Requested cancellation yields `failed/cancelled`. Both `turn` and `owned` cancel stop the process
group with SIGTERM, then SIGKILL after `killGraceMs` (default 3000 ms). Print mode has no turn-only
interrupt. Unrequested nonzero exit is classified from stderr; aborted or missing assistant output
is `unknown`. The workflow engine decides retries from failure class; the adapter does not relaunch
an already consumed attempt. Pi's own retry settings may still apply.

## Durability, idempotency, fencing

Records live at `<stateDir>/attempts/<sha256(attemptKey)>.json`, default
`~/.agent-workflow/executors/pi`. An exclusive `pending` record precedes `consume()`, followed by
`revoked` or `consumed`, then `spawned` (pid, group, birth identity), then `exited`.

| Call | Behaviour |
|---|---|
| `submit` with known key | Returns recorded ref; consumed without spawn → `AUTHORITY_ALREADY_CONSUMED` |
| `submit` | Validation and capability refusals precede consume |
| `reconcile` | none/revoked → `absent`; pending/consumed → `unknown`; spawned/exited → `found` |
| cross-process `cancel` | Checks process identity before signalling; returns `uncertain` |
| `respond` | `unknown_request`: no approval channel in print mode |

Unreadable or mismatched records mean `unknown`, not absence; submit refuses the key and cancel is
`uncertain`. Exited/revoked records and spawned records with a dead process are eligible for pruning
after 7 days, on submit at most every 6 h and by `agent-workflow prune`. Launched records become
permanent `agent-workflow-attempt-tombstone-v1` tombstones (attemptKey, outcome, finishedAt, prunedAt);
reconcile reports `unknown` and resubmission is refused. Never-launched revoked records can be deleted.
Owned run directories are removed only through real-directory ancestors resolving inside stateDir.

`AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` is passed when authority has a binding.
`PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` is also passed only with `isolation.inherit: true` for
compatibility with inherited extensions. Sessions can be resumed and deleted as owned only under
`<stateDir>/sessions/`; use `deleteOwnedSession(ownedSession)`.

## Known limits

- No approvals or sandbox: tools are allowed or absent. ReadOnly is an allowlist, not filesystem isolation.
- No live reattach after the owner dies; the orphan guard stops Pi. Reconciliation requires a decision.
- Non-overridable user settings remain under isolation.
- Fast tier and host-tool inheritance lack live verification.
- Pi accepts fuzzy model matches and custom ids; use exact `provider/id`.
- Subscription/free-tier billing is not reflected in catalog cost estimates.
- Web safety policy is unknown; tool-call budgets are not guaranteed by the web extension.
- Concurrency is verified for three parallel attempts; higher concurrency and long runs are unverified.

## Permission mode

Pi has no approval prompts in `--mode json --print` and no sandbox. `free` and `safe` produce the
same argv with every requested tool; readOnly drops mutating tools in both modes.
See [permissions](../permissions.md). `PI_PERMISSION_MODE_SETTINGS` describes this as `equivalent`.
