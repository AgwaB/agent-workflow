# Executors

Worker artifacts live in the [project state directory](usage.md#where-run-state-lives);
workers execute in the project directory or its managed worktree. Adapter state described
below lives separately under `$AGENT_WORKFLOW_HOME/executors/`.

Each executor runs one attempt through its CLI and normalizes output into SDK events. Keep secrets
in `SubmitRequest.env` or `McpServerSpec.env`, not descriptor config. The engine decides retries
from failure class (`unknown` is never automatically retried); adapters do not relaunch consumed
attempts. Safe readOnly requests may inject only the engine's read-only artifact server; other servers
are refused before consume with `CAPABILITY_MISSING:readOnly`. Free requests permit foreign injected
servers regardless of authored readOnly intent. Web safety policy is unknown.

Workflow built-ins are `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, `edit`, `write`,
and `bash`; SDK constants are `WORKFLOW_TOOL_NAMES` / `WORKFLOW_TOOL_KINDS`. Codex mapping rows use
`workflowName`. `workflow_artifact` is the injected artifact MCP tool, not a built-in.

| Executor | CLI and verified version | Invocation | Isolation | Permission modes | Web tools | Artifact MCP | Notable limits |
|---|---|---|---|---|---|---|---|
| Pi | Pi 1.1.0 | `pi --mode json --print` | Resource-disabling flags; auth retained | Free: requested tools; safe readOnly: read-only allowlist | pi-web-access 0.44.0, search+fetch | `mcp__workflow_artifact__workflow_artifact`; 18,432 artifact output chars/bytes | No sandbox or approvals; fast tier live-unverified |
| Codex | codex-cli 0.166.0 | `codex app-server` | Per-thread config; global instructions/rules remain | Safe: mapped sandbox + `on-request`; free: `danger-full-access` + `never` | Hosted search; fetch mapping unverified | `mcp__workflow_artifact__workflow_artifact`; 30,400 artifact output chars/bytes | Coarse tools; global exec-policy allow rules |
| Claude Code | claude-code 2.1.319 | `claude -p`, stream-json | Settings/MCP isolation; built-in agents/plugins remain | Safe: `default`; free: `bypassPermissions` | `WebSearch`, `WebFetch` | `mcp__workflow_artifact__workflow_artifact`; 21,375 artifact output chars/bytes | Read-tool auto-allow; MCP spill files |
| Antigravity (ACP) | agy_acp_server 1.4.5 | No args on macOS; `--uid=` on Linux | Private `GEMINI_HOME`; workspace skills remain | Free: `yolo`; safe `default`; safe readOnly emulated | `search_web`, `read_url_content` + `view_file` | `call_mcp_tool`; 131,072-byte MCP override | No resume or filesystem sandbox; declared capabilities |

**Contents:** [Pi](#pi) · [Codex](#codex) · [Claude Code](#claude-code) · [Antigravity (ACP)](#antigravity-acp)

## Pi

`@agwab/agent-workflow/executors/pi` runs one workflow attempt as one Pi process.
Use `createExecutor(config)` with descriptor
`{ id: "pi", version: "0.1.0", module: "@agwab/agent-workflow/executors/pi", config }`.
Source: `src/executors/pi/` (`executor.ts`, `argv.ts`, `parse.ts`, `errors.ts`, `state.ts`,
`run-extension.ts`, `tool-result-budget.ts`, `config.ts`).

### CLI and version

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

### Invocation

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

### Isolation

By default, the adapter disables context files, extensions, skills, prompt templates, themes and
project-resource approval. Global and project `AGENTS.md`/`CLAUDE.md` discovery is disabled.
Authentication stays in Pi's own `auth.json` or environment; no credential file is touched.

The run extension starts native MCP through `createMcpExtension` with
`loadConfig: () => ({ servers: [] })`, connects only injected servers, and disables `/mcp` config writes.
A stage that inherits only part of the user's context (`isolation.scope`: its agent's
`inheritProjectContext` → context files, `inheritSkills` → skills) keeps every other flag above and the
private MCP config; only `--no-context-files` and/or `--no-skills` are dropped. A bare
`inherit: true` (no scope) loads user extensions, skills, context files and `mcp.json`; injected
servers register on the built-in MCP implementation.

User `settings.json` values not overridden by flags still apply, including retry, compaction,
transport, shell prefix, `httpProxy` and cache warming. Pi has no per-run settings flag.
`PI_CODING_AGENT_DIR` is not relocated because it also moves authentication.

### Tool mapping (workflow names → Pi executor)

`toolAllowlist` is native and fine.

| Workflow name | Pi executor | ACP kind | Verified |
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
(`bash`, `edit`, `write`, `codemode`).

Web tools require **pi-web-access**, explicitly loaded under isolation. Set `config.webAccessExtension`
or let `pi list` discover it. Install with `pi install npm:pi-web-access` (`PI_WEB_ACCESS_INSTALL`).
Missing packages or disabled tools are reported by the probe and refused before consume with
`CAPABILITY_MISSING:webTools`. The registered-tool check detects tools disabled in `web-search.json`,
sets `unavailableTools`, and reduces `webTools` to `search` or `none`. `agent-workflow doctor --fix`
can re-enable a tool after asking. URL/IP/redaction safety controls are unaudited (`safetyPolicy: unknown`).

`inheritHostTools` is a host-level, per-task descriptor opt-in, honored only for Pi tasks and ignored
for safe readOnly requests. It adds `codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`, and loads `builtin:mcp`, `builtin:codemode`,
`builtin:tool-search` under isolation. This intentionally exposes the user's `mcp.json` servers.
The capability preview records a host-tools notice. This path is verified offline, not live.

### MCP injection

Pi 1.1 native MCP is configured per run without changing global settings. The generated extension
calls `pi.registerMcpServer(name, { command, args, env, exposure: "direct" })` for each injected
server. Server names must match `[A-Za-z0-9_-]+`. Writable requests declare
`mcp__<server>__*`; safe readOnly artifact access declares only
`mcp__workflow_artifact__workflow_artifact`.

Pi cuts MCP text above **20,480 UTF-8 bytes** (`MCP_OUTPUT_MAX_BYTES = 20 * 1024`, `truncateMiddle`),
keeping 10 KiB head and 10 KiB tail around `…N chars truncated…`, with a warning header and full-output
temp-file footer. The probe reports `mcpOutputLimitChars = 20480` and `mcpOutputNoticeChars = 1024`.
The engine sets the artifact server's `--max-output-chars 18432`
(20480 − 1024 notice − 1024 margin); larger whole reads are paged.

Pi does not add MCP server `instructions` to model context. Include artifact-tool guidelines in the
rendered prompt; see [MCP](extending.md#workflow-artifact-mcp-server).

### Capabilities

Every row below describes the declared capability and its factual basis. `probed` rows have real-CLI
live or offline coverage.

| Capability | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Pi owns the loop |
| sessionBound | `true` | — | stdout owned by spawning process |
| mcpInjection | native | probed | live, Pi 1.1.0 |
| readOnly | emulated | probed | safe-only allowlist; live, Pi 1.1.0 |
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
budget through the per-run `context` hook; old results are evicted from model context. Dynamic
generated tasks on Pi get the run's budget (`AGENT_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS`,
default 320,000; `0` disables) unless the executor config sets one; other executors have no
eviction (`toolResultBudget: none`), the budget is only recorded.

Usage is per assistant request. `cached = cacheRead`, `cacheWrite = cacheWrite`, and `model` comes
from the assistant message. Cost is Pi's catalog estimate (`source: estimated`); a reported zero
becomes `null`/`unknown`, since Pi cannot distinguish free from unpriced.

### Fast tier

`fast: "on"` requests `service_tier: priority` for eligible OpenAI models
(`src/executors/pi/fast-tier.ts`, reached through the Pi executor policy). The task runner passes per-task `fast` and `fastApi` only when recorded
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

### Errors

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
is `unknown`. Pi's own retry settings may still apply.

### Durability, idempotency, fencing

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

`AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` is passed when authority has a binding. Sessions can be resumed and deleted as owned only under
`<stateDir>/sessions/`; use `deleteOwnedSession(ownedSession)`.

### Known limits

- No approvals or sandbox: tools are allowed or absent. ReadOnly is an allowlist, not filesystem isolation.
- No live reattach after the owner dies; the orphan guard stops Pi. Reconciliation requires a decision.
- Non-overridable user settings remain under isolation.
- Fast tier and host-tool inheritance lack live verification.
- Pi accepts fuzzy model matches and custom ids; use exact `provider/id`.
- Subscription/free-tier billing is not reflected in catalog cost estimates.
- Web safety policy is unknown; tool-call budgets are not guaranteed by the web extension.
- Concurrency is verified for three parallel attempts; higher concurrency and long runs are unverified.

### Permission mode

Pi has no approval prompts in `--mode json --print` and no sandbox. `free` and `safe` produce the
same argv with every requested tool except that safe readOnly drops mutating tools. Free readOnly
keeps requested mutating tools and opted-in host tools without readOnly MCP restrictions.
See [permissions](usage.md#permission-modes). `PI_PERMISSION_MODE_SETTINGS` describes this as `equivalent`.

## Codex

Entry point: `@agwab/agent-workflow/executors/codex`; source: `src/executors/codex/`.
Use `createExecutor(config)` with descriptor
`{ id: "codex", version: "0.1.0", contractVersion: "0.1.0", module: "@agwab/agent-workflow/executors/codex", config: {} }`.

Verified with **codex-cli 0.166.0** using ChatGPT login. Live coverage also exists for **0.159.2**
and **0.165.0**. Protocol details were established on 0.159.2; MCP output bounds were rechecked
on 0.165.0 and 0.166.0.

### Invocation: `codex app-server`

Each attempt owns one `codex app-server` process using newline-delimited JSON-RPC 2.0 over stdio.
The adapter splits only on `\n`, preserving U+2028/U+2029 inside JSON strings.

1. Consume authority immediately before spawn. Revoked authority yields `AUTHORITY_REVOKED` without
   a process; released authority is recorded as `consumed`.
2. Spawn `codex -c log_dir="<stateDir>/attempts/<digest>.log" app-server` in the request cwd, with
   inherited environment plus `req.env`. Prompt and secrets are not on argv.
3. Send `initialize` (`clientInfo.name = agent_workflow`) then `initialized`, opting out of reasoning,
   output, account and remote-control notifications not needed by the adapter.
4. Under isolation, read user MCP server names through `config/read {cwd}`.
5. Send `thread/start`, or `thread/resume {threadId}` for `resumeSessionId`, with cwd, model,
   permission settings, `serviceTier: null`, `developerInstructions: systemPrompt`,
   `ephemeral: !keptSession`, and per-thread config.
6. Under isolation, check `mcpServerStatus/list {threadId, detail: "toolsAndAuthOnly"}`. A server with
   tools that the request did not inject fails as `config` before the turn.
7. Send `turn/start {threadId, input: [{type: "text", text: prompt}], model, effort}`.
8. Normalize notifications until `turn/completed`, close stdin, and SIGKILL after 3 s if needed.

`submit` returns after turn start or a reported failure, so a kept session's thread id can be in the ref.

#### Flags and overrides

| Setting | Value / purpose |
|---|---|
| `sandbox` | Safe/default: `read-only` for readOnly or read-only tools; `workspace-write` for write/exec tools or an empty tool list on a writable stage. Free (including readOnly): `danger-full-access` |
| `approvalPolicy` | `on-request`; `never` for every free stage |
| `approvalsReviewer` | `user`, preventing user config from routing decisions to auto-review |
| `serviceTier` | `null` (standard); fast tier is not offered |
| `ephemeral` | true unless `sessionId`/`resumeSessionId` is requested |
| `developerInstructions` | Appends `systemPrompt`; does not replace Codex's base prompt |
| config `web_search` | `live` for `web_search`/`fetch_content`, otherwise `disabled` |
| config `tool_output_token_limit` | 10000 by adapter default, independent of model catalog |
| config `features.multi_agent` | false, preventing worker subagents outside engine slots |
| config `mcp_servers.<name>.{command,args,env,enabled,tool_timeout_sec,startup_timeout_sec}` | Injected over stdin; default timeouts 300 s / 30 s |
| `effort` | Request value when set; otherwise the user's `model_reasoning_effort` applies |

### Permission mode

`free` on every stage uses `danger-full-access` plus `never`. Safe/default uses the mapped
sandbox plus `on-request`; safe readOnly uses `read-only` plus `on-request`; free readOnly stays unrestricted (including shell network access).
Free mode records coarse-tool and environment degradations without strict refusal or confirmation.
See [permissions](usage.md#permission-modes); mapping: `CODEX_PERMISSION_MODE_SETTINGS`.

### Isolation

With `isolation.inherit = false`, per-thread config sets:

```text
project_doc_max_bytes = 0
skills.include_instructions = false
features.plugins = false
features.apps = false
features.hooks = false
features.memories = false
include_apps_instructions = false
history.persistence = "none"
notify = []
mcp_servers.<user server>.enabled = false
```

Isolated attempts run with a **private `CODEX_HOME`** under the attempt's log directory that links
(never copies) the user's `auth.json`, `config.toml` and `rules/` and carries no `AGENTS.md`, skills,
plugins, memories or history; it is removed when the app-server exits. A request that keeps a session
gets its private home under `<stateDir>/session-homes/` instead, since the thread's rollout lives there:
resuming the thread reuses it, and deleting the owned session deletes the thread in it and removes it. Codex writes refreshed tokens
in place, so the linked `auth.json` stays the one credential file every Codex process shares. The user's
home is kept instead (and the probe says why) when the stage inherits user context, when
`cli_auth_credentials_store` is not `file` (the keyring store keys credentials by the home path), when
there is neither an `auth.json` nor an `OPENAI_API_KEY`/`CODEX_API_KEY` variable, or when links cannot
be created. Credential files are never read by agent-workflow. Project `AGENTS.md`, skills, plugins,
apps and personal MCP tools are disabled. MCP disabling uses thread config: per-server argv overrides
fail validation on 0.159.2, while `-c mcp_servers={}` merges rather than replacing.

`~/.codex/rules/*.rules` (linked into the private home) and built-in collaboration role blocks remain;
the global `$CODEX_HOME/AGENTS.md` reaches a worker only when the home is not relocated.
An exec-policy `allow` rule can run a matching command outside the sandbox without engine approval.

### Environment probe

`probe()` inspects `rules/*.rules` and `AGENTS.md` under `$CODEX_HOME` (default `~/.codex`),
plus `/etc/codex/requirements.toml` on Unix (Windows: `%ProgramData%/OpenAI/Codex/requirements.toml`).
It never reads `auth.json` or makes a model call. Source: `src/executors/codex/environment.ts`.

| Finding | Probe capability row | Negotiation |
|---|---|---|
| N > 0 `decision = "allow"` rules | `readOnly: emulated`, warning with count and path | readOnly degradation (`CAPABILITY_WARNING:readOnly`); interactive confirmation; strict refusal |
| No allow rules | Declared `readOnly: native` remains | native |
| Non-empty global `AGENTS.md` **and** the worker home stays shared (keyring/auto store, no credentials) | `contextIsolation: emulated`, warning with path and the reason | non-inherit degradation (`CAPABILITY_WARNING:contextIsolation`); strict refusal |
| Global `AGENTS.md` absent/empty, or workers get a private home; no policy warnings | `contextIsolation: native` | native |
| `forbidden` / `prompt` rules or restrictive managed requirements | `contextIsolation: emulated`, count/path warning: policy survives isolation | `CAPABILITY_WARNING:contextIsolation`; free mode records it without confirmation or strict refusal |

The rule tokenizer counts keyword arguments (`"allow"`, `'allow'`, `r"allow"`), not comments or strings
containing similar text. Only counts and paths are recorded, not patterns or file contents.
Unreadable paths are warned about. These warnings appear in `check` previews and `doctor` too.

**Auto-approve is not a policy override.** `forbidden` rules still deny matching commands under
`danger-full-access` + `never`; `prompt` rules become denials rather than questions under `never`.
The probe checks root `allowed_sandbox_modes` / `allowed_approval_policies` string arrays in managed
requirements and warns when they exclude `danger-full-access` / `never`. It is not a full TOML,
execpolicy, named-profile or enterprise-policy evaluator; unsupported array syntax produces a warning.
Dangerous-command heuristics, hooks and inherited OS restrictions can still block work.

After **both `thread/start` and `thread/resume`**, before `turn/start`, the adapter compares:

- Requested `sandbox` (`read-only`, `workspace-write`, `danger-full-access`) to effective
  `sandbox.type` (`readOnly`, `workspaceWrite`, `dangerFullAccess`).
- Requested `approvalPolicy` to the effective `approvalPolicy`.
- If returned, `activePermissionProfile.id` to the corresponding built-in id (`:read-only`,
  `:workspace`, `:danger-full-access`), with no unexpected `extends`. Null/absent provenance is
  accepted for older/non-experimental servers; missing sandbox/approval fields are not.

A mismatch fails the attempt as `executor_config` **without starting a model turn**, naming requested
and effective values and suggesting `requirements.toml` / managed configuration as the likely cause.
Startup `configWarning` / `warning` notifications remain in `codex-app-server.jsonl`, including on failure.

Some execpolicy rejections produce no item notification. The adapter also recognizes the two verified
0.166.0 `ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message:
"Rejected(...)" }` stderr forms: a backtick-delimited command followed by `rejected: policy forbids
commands starting with` a backtick-delimited prefix, or exactly `approval required by policy, but
AskForApproval is set to Never`. ANSI is stripped for parsing only. Each becomes a `tool_call` with
`name: shell`, `kind: execute`, `status: denied`, `input.command` when present, and the reason in
`output` (command/reason bounded to 16,384 characters and request secrets redacted). Unknown/malformed
formats and lines over 65,536 characters emit nothing. Raw stderr remains in the transcript as before;
a denied command does not by itself fail a subsequently completed turn.

For hermetic diagnostics, `AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH` overrides only the probe's policy
file path, not Codex's own requirements loading or the effective-mode check.

Models come from `codex debug models`: visible slugs and per-model `supported_reasoning_levels` become
`modelEfforts`. Stage effort maps to the nearest supported level, lower on a tie.
`modelListComplete: false`: unlisted API-key/custom-provider models are noted, not refused.

### Tool mapping (workflow name → Codex)

| Workflow tool | Mapping | Codex tool | Verified live |
|---|---|---|---|
| `read` | sandbox `read-only` | shell (`cat`, `sed`) | yes, 0.159.2 |
| `grep` | sandbox `read-only` | shell (`rg`/`grep`) | no |
| `find` | sandbox `read-only` | shell (`rg --files`/`find`) | no |
| `ls` | sandbox `read-only` | shell (`ls`) | no |
| `bash` | sandbox `workspace-write` | shell (`exec_command`) | yes, 0.159.2 |
| `edit` | sandbox `workspace-write` | `apply_patch` | yes, 0.159.2 |
| `write` | sandbox `workspace-write` | `apply_patch` | yes, 0.159.2 |
| `web_search` | tool `web_search` (`web_search = "live"`) | hosted web search | yes, 0.159.2 |
| `fetch_content` | tool `web_search` | hosted web search `open_page`/`find_in_page` actions | no |
| `workflow_artifact` | MCP `workflow_artifact`/`workflow_artifact` | `mcp__workflow_artifact__workflow_artifact` | yes, 0.159.2 |

`CODEX_TOOL_MAPPING` is coarse: Codex has no per-tool allowlist. Unknown names are refused with
`INVALID_REQUEST` before consume. Shell access is controlled by the sandbox, not exact tool names.

### MCP injection

Injected servers use dotted `thread/start` config keys such as
`mcp_servers.workflow_artifact.command`, `.args`, `.env`, `.enabled`, `.tool_timeout_sec`,
`.startup_timeout_sec`. Env values travel over stdin, not argv. The artifact tool is
**`mcp__workflow_artifact__workflow_artifact`**.

Injected MCP servers run outside Codex's sandbox.

Codex limits results through `tool_output_token_limit` (default 10,000), retaining head and tail.
On 0.159.2 the measured bound is about **40,000 bytes**, estimated at 4 bytes/token.
On 0.165.0, 47,500 bytes arrived intact and 48,500 bytes became 48,022 bytes; on 0.166.0,
47,500 bytes arrived intact and 48,500 bytes or more became 47,988 bytes with a truncation marker.
ASCII and Korean text hit the same byte bound.

**Code mode.** Codex 0.166's model catalog gives `gpt-5.6-luna` the tool mode `code_mode_only`: the
model calls tools, `workflow_artifact` included, from JavaScript it runs with Codex's `exec` tool, and
only what that script returns reaches the model, capped at 10,000 tokens per `exec` by default
(Codex `DEFAULT_MAX_OUTPUT_TOKENS`). A script that reads many pages at once therefore leaves part of
them unseen, while the read ledger, which sees each MCP call, records every page as delivered
complete. In recorded deep-research runs the final audit read its 17 projections in one script in
30 of 30 such attempts; each delivered 11,579–58,010 approximate tokens and the model's context grew
by 10,011–12,177. The feature flag `code_mode` does not change it (the catalog's tool mode takes
precedence); no per-run override exists short of replacing Codex's model catalog.

The probe conservatively reports `mcpOutputLimitChars = 32000`. The engine sets
`--max-output-chars 30400` (5% margin), bounding both UTF-16 length and UTF-8 bytes; larger whole
reads are paged. See [MCP](extending.md#workflow-artifact-mcp-server). Normalized `tool_call.output` is separately clipped at
16,384 characters; the raw transcript keeps the full result. `tool_timeout_sec` is honored;
the adapter defaults to 300 s (startup 30 s).

### Events

| app-server | ExecEvent |
|---|---|
| thread started | `started {sessionId: threadId}` |
| `item/agentMessage/delta` | `message_delta` |
| `commandExecution` started/completed | `tool_call shell`; read/listFiles → read, search → search, otherwise execute; nonzero exit → failed, declined → denied |
| `fileChange` | `tool_call apply_patch`, edit (delete if all changes delete) |
| `mcpToolCall` | `tool_call mcp__<server>__<tool>`; read for artifact or `readOnlyHint`, otherwise other |
| `webSearch` | `tool_call web_search`, fetch |
| `dynamicToolCall`, `imageView`, `collabAgentToolCall` | `tool_call`, kinds other/read/other |
| `thread/tokenUsage/updated` | One turn delta keyed by `turnId`; resumed previous-turn usage is excluded |
| `item/commandExecution/requestApproval` | `approval_request`, execute (fetch with network context) |
| `item/fileChange/requestApproval`, `applyPatchApproval` | `approval_request`, edit |
| `item/permissions/requestApproval` | `approval_request`, edit for filesystem, fetch for network |
| `mcpServer/elicitation/request`, `item/tool/requestUserInput` | Declined / empty answers |
| `turn/completed` | completed → `completed {finalText}` from `final_answer`; failed → classified `failed`; interrupted → `failed cancelled` |
| early process exit | Classified failure; cancelled after adapter cancellation |

Usage normalizes `input = inputTokens − cachedInputTokens − cacheWriteInputTokens`,
`cached = cachedInputTokens`, `cacheWrite = cacheWriteInputTokens`; model comes from thread start/resume,
else the request. Output includes reasoning. Cost is `null`, source `unknown`. One event covers a turn
(the sum of its requests); `peakContext` is the largest `last.inputTokens` among the turn's
`thread/tokenUsage/updated` notifications, the prompt of its largest single request.

Raw stream: `<artifactsDir>/codex-app-server.jsonl` (`{at, dir: out|in|stderr|meta, msg}`), falling
back to the attempt log directory. Request and MCP env values of at least 8 characters are redacted
in raw logs, stderr and normalized events as `<redacted:KEY>` / `<redacted:server.KEY>`.
`config/read` retains only server names; MCP status retains names and counts; account and
remote-control notifications are redacted. Messages sent to the CLI remain unchanged.

### respond / cancel / reconcile / sessions

- `respond`: allow → `accept`, deny → `decline`, never `acceptForSession`. Permissions are granted
  only for the turn. Unanswered requests are denied at `approvalPolicy.timeoutMs`. Unknown id →
  `unknown_request`; already answered or server-resolved → `too_late`.
- `cancel`: `turn/interrupt`; `owned` or no active turn also terminates the process with
  SIGTERM/SIGKILL. Completion races return `too_late`; unconfirmed cancellation returns `uncertain`.
  For another process's attempt, results are `too_late` (terminal), `no_active` (owner gone), or `uncertain`.
- `reconcile`: records under `$AGENT_WORKFLOW_HOME/executors/codex/attempts/` use exclusive claims.
  None/revoked → `absent`; consumed without spawn → `unknown`; spawned/terminal → `found`.
  Unreadable records are `unknown`, block resubmission with `AUTHORITY_ALREADY_CONSUMED`, and make
  cancel `uncertain`. Session-bound attempts are never adopted by another process.
- Cross-process `observe` replays the durable event log, ending `failed unknown` if the server died
  without a terminal event.
- Sessions are kept only for `sessionId`/`resumeSessionId`. Codex picks the thread id, returned in
  `ExecRef.sessionId` and `ownedSession {kind: "codex-thread", locator: threadId}` for owned threads.
  Ownership records live in `<stateDir>/sessions/`; a resumed foreign thread is not marked owned.
  `deleteOwnedSession` refuses unrecorded threads, otherwise uses `thread/delete` and removes the
  record after `deleted`/`not_found`.

### Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Codex owns the loop |
| sessionBound | true | — | one stdio connection owns the thread |
| mcpInjection | native | probed | live, 0.159.2; offline app-server |
| readOnly | native | probed | safe only; live, 0.159.2; environment probe can lower it |
| toolAllowlist | native, coarse | probed | read-only sandbox; live, 0.159.2 |
| systemPrompt | native, append | declared | `developerInstructions`; live, 0.159.2 |
| modelSelect | native | probed | live, 0.159.2 |
| effortLevels | low, medium, high, xhigh, max, ultra | — | `model/list`; `codex debug models` |
| resume | native, native | probed | live, 0.159.2 |
| partialStream | native | probed | `item/agentMessage/delta` |
| usage | native, tokens | probed | turn usage notifications |
| toolTelemetry | native | probed | live, 0.159.2 |
| cancel | native, interrupt | probed | live, 0.159.2 |
| nativeSchema | none | declared | SDK has no schema field |
| contextIsolation | emulated | probed | global instructions/rules; environment-dependent |
| fastTier | none | declared | standard tier forced |
| toolResultBudget | none | declared | source: capabilities declaration |
| webTools | native, search, safetyPolicy **unknown** | probed | hosted search; live, 0.159.2 |

Capability metadata retains the original 0.159.2 verification baseline; the latest verified CLI is
0.166.0. A differing installed version is noted by the probe.

### Error classification

`codexErrorInfo` takes precedence over text rules (`src/executors/codex/errors.ts`).

| Input | Class | Source |
|---|---|---|
| 400 `model_not_found`, unsupported model | config | live, 0.159.2 |
| 401 `httpConnectionFailed`, missing bearer | auth | live, 0.159.2 |
| interrupted turn / exit after cancel | cancelled | live, 0.159.2 |
| unauthorized, not logged in, token expired | auth | protocol / text |
| `usageLimitExceeded`, `rateLimitExceeded`, HTTP 429 | rate_limit | protocol |
| `serverOverloaded`, `internalServerError`, `httpConnectionFailed`, `responseStream*`, `responseTooManyFailedAttempts`, `flexUnavailable`, 5xx, connection reset/disconnected | transient | protocol |
| `contextWindowExceeded`, `sessionBudgetExceeded`, `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials`, `threadRollbackFailed` | permanent | protocol |
| `badRequest`, `sandboxError`, invalid configuration/transport, CLI missing/ENOENT, isolation guard | config | protocol / offline |
| otherwise | unknown | source: `errors.ts` |

Expired-token, rate-limit and context-overflow cases have protocol coverage, not live reproduction.

### Known limits

- Global instructions and exec-policy rules remain; the probe warns and records degradations.
- Always pass effort if user defaults must not apply.
- An injected MCP name colliding with a user server can merge incompatible keys and fail config.
- `fetch_content`, `grep`, `find`, `ls` mappings and concurrent token refresh are unverified.
- Three parallel app-servers are verified; refresh contention was not exercised.
- Hosted web search safety controls are unconfirmed (`safetyPolicy: unknown`).
- Terminal/revoked records, or spawned records with a dead server, are eligible for pruning after
  7 days, on submit at most every 6 h and by `agent-workflow prune`, with `.events.jsonl` and `.log/`.
  Launched records become permanent `agent-workflow-attempt-tombstone-v1` tombstones (attemptKey,
  terminal outcome, finishedAt, prunedAt). Reconcile reports `unknown`, never `absent`, and submit
  refuses the key. Only never-launched revoked records are removed.

## Claude Code

Entry point: `@agwab/agent-workflow/executors/claude`; source: `src/executors/claude/`.
Use `createExecutor(config)`; the typed factory is `createClaudeExecutor({ config, faults })`.
Adapter and SDK contract version: `0.1.0`.

Verified with **claude-code 2.1.319** using claude.ai subscription login. Live coverage also exists
for **2.1.310**, **2.1.314** and **2.1.318**; protocol and output-limit details were established on 2.1.310.

### Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `claudePath` | `claude` | CLI binary |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/claude` (`~/.agent-workflow/…`) | Attempt and kept-session records |
| `mcpOutputTokens` | `25000` | Overrides inherited/request `MAX_MCP_OUTPUT_TOKENS` |
| `mcpToolTimeoutMs` | unset | Sets `MCP_TOOL_TIMEOUT` |
| `systemPromptMode` | `append` | `--append-system-prompt` or `--system-prompt` (`replace`) |
| `listModels` | `true` | Lists models through `initialize` during probe |
| `killGraceMs` | `3000` | Grace between interrupt, SIGTERM and SIGKILL |
| `claudeConfigDir` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Used only to remove worker session files |

Unknown keys are refused (`DESCRIPTOR_INVALID`).

### Invocation

```text
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-mode (default | bypassPermissions) --permission-prompt-tool stdio
  --tools <mapped built-ins> [--allowedTools <web tools>,mcp__<server>…] [--disallowedTools Bash,Edit,Write,NotebookEdit]
  [--setting-sources "" --settings {"autoMemoryEnabled":false} --strict-mcp-config --disable-slash-commands]
  [--mcp-config <artifactsDir>/claude-mcp-config.json] [--model M] [--effort E]
  [--append-system-prompt S | --system-prompt S]
  (--session-id <uuid> --no-session-persistence | --session-id <requested> | --resume <id>)
```

The prompt is one stream-json `user` message on stdin. Stdin stays open for approvals and interrupts,
then closes after the `result` line. `--verbose` is required with print-mode stream-json output;
`--include-partial-messages` enables text deltas. `--permission-prompt-tool stdio` routes approval
requests to the engine instead of letting the CLI silently deny them.

`--tools` restricts built-ins. `--allowedTools` pre-allows requested web tools and injected MCP tools;
readOnly artifact access uses the exact `mcp__workflow_artifact__workflow_artifact` rule, not a
server-wide rule. Safe readOnly also adds `--disallowedTools Bash,Edit,Write,NotebookEdit`.

### Permission mode

Safe/default stages use `--permission-mode default`. Every free stage, including readOnly,
use `--permission-mode bypassPermissions`, not the `--dangerously-skip-permissions` alias.
The stdio approval channel stays enabled; the engine allows requests that still arrive in free mode
with audit reason `engine-policy:free`. Free readOnly retains requested mutating tools and adds no `--disallowedTools`; safe readOnly keeps
the read-only tool set and disallowed mutating tools.
See [permissions](usage.md#permission-modes); mapping: `CLAUDE_PERMISSION_MODE_SETTINGS`.

### Managed-policy preflight

Without a model call, `probe()` reads endpoint-managed settings at
`/Library/Application Support/ClaudeCode/managed-settings.json` (macOS),
`/etc/claude-code/managed-settings.json` (Linux), or
`C:\Program Files\ClaudeCode\managed-settings.json` (Windows). These paths follow the
[Claude settings documentation](https://code.claude.com/docs/en/settings). Credentials and ordinary
`~/.claude` settings are not read by this probe.

It warns for `permissions.disableBypassPermissionsMode: "disable"`, counts `permissions.deny` and
`permissions.ask` rules without recording patterns, and warns for root execution on Unix. Managed
settings survive `--setting-sources ""`; deny rules still deny matching tools in `bypassPermissions`.
Ask rules can still request approval: supported requests are answered automatically by the workflow
in free mode, but provider-only interaction may be denied. Disabled bypass can prevent free-mode
startup. Claude refuses bypass under root/sudo unless it recognizes a sandbox; use a non-root account.

Warnings reuse `CAPABILITY_WARNING:contextIsolation` (policy survives isolation), appear in `check`
previews and the `doctor` warning list, and are recorded without confirmation or strict refusal in
free mode. Invalid/unreadable policy warns rather than claiming it is absent. This is a file-based
advisory probe, not effective-settings resolution: server-managed policy, MDM, managed-settings
fragments, hooks and sandbox restrictions may add blocks. Claude has no Codex-style effective-mode
response check here. Its existing `system/permission_denied` stream handling emits denied tool calls;
a later normal completion can still follow a denial.

`AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH` overrides only the diagnostics file path (tests use
fixtures); it cannot override Claude's actual managed policy.

### Isolation

`inherit: false` adds `--setting-sources "" --strict-mcp-config --disable-slash-commands
--settings {"autoMemoryEnabled":false}`. This disables user settings, hooks, commands, skills and
personal MCP configuration while preserving subscription login. Project `CLAUDE.md`/`AGENTS.md`
isolation is verified live. Auto-memory is disabled to avoid creating worker memory directories.
Built-in agents and plugins remain loaded.

User-level `~/.claude/CLAUDE.md` isolation has not been verified; the SDK documents `settingSources`
as controlling its loading. `inherit: true` drops isolation flags but still explicitly selects the
permission mode for the request; user allow rules can then apply. `--bare` is not used because it
does not preserve OAuth login.

### Tool mapping (workflow → Claude)

| Workflow tool | Claude | Kind | Verified live |
|---|---|---|---|
| `read` | `Read` | read | yes, 2.1.310 |
| `grep` | `Grep` | search | listed in init, 2.1.310 |
| `find` | `Glob` | search | listed in init, 2.1.310 |
| `ls` | `Glob` (2.1.310 has no LS tool) | search | listed in init, 2.1.310 |
| `bash` | `Bash` | execute | yes, 2.1.310 |
| `edit` | `Edit` | edit | docs only |
| `write` | `Write` | edit | docs only |
| `web_search` | `WebSearch` (client tool) | fetch | yes, 2.1.310 |
| `fetch_content` | `WebFetch` | fetch | yes, 2.1.310 |
| `workflow_artifact` | MCP `mcp__workflow_artifact__workflow_artifact` | read | yes, 2.1.310 |

Unknown tools fail before consume with `CAPABILITY_MISSING:tool:<name>`.
`workflow_artifact` requires the injected server or fails with `INVALID_REQUEST`.
ReadOnly removes `Bash`, `Edit`, `Write`, `NotebookEdit`.

### Approvals

- `control_request can_use_tool` becomes `approval_request` with id, kind and tool detail.
- Allow returns `control_response {behavior: allow, updatedInput: <original input>}`;
  deny returns `{behavior: deny, message}` and a denied tool event.
- Unanswered requests are denied at `approvalPolicy.timeoutMs`.
- Unknown id → `unknown_request`; already answered or ended attempt → `too_late`.
- Unsupported control requests get an error response rather than hanging.

Claude auto-allows Read/Grep/Glob inside working directories and read-only shell commands without
asking the engine. These still produce tool events. ReadOnly stages have no Bash tool.

### MCP injection

`--mcp-config <artifactsDir>/claude-mcp-config.json` is mode 0600 and uses stdio servers.
Each MCP env value becomes `${AW_CLAUDE_MCP_<i>_<KEY>}` in the file; the value is passed in the CLI's
environment and expanded by Claude. Values never appear in the file or argv. Commands/arguments
containing `${` are refused to prevent unintended expansion. Servers inherit the CLI's full environment.
Visible names are `mcp__<server>__<tool>`, including
**`mcp__workflow_artifact__workflow_artifact`**.

`MAX_MCP_OUTPUT_TOKENS` is honored. At 2,000 tokens, 3,000 characters stayed inline and 12,000 spilled;
at the default 25,000 tokens, 22,500 and 45,000 stayed inline and 90,000 spilled.
Over-limit results are **not truncated**: a notice replaces them and the full result is saved under
`~/.claude/projects/<cwd>/<session>/tool-results/…`, even without session persistence.

The probe reports `mcpOutputLimitChars = floor(0.9 × tokens) = 22500` by default. The artifact server
bounds UTF-8 bytes as well as character length; the engine sets `--max-output-chars 21375`
(5% margin), paging larger whole reads. See [MCP](extending.md#workflow-artifact-mcp-server).
`MCP_TOOL_TIMEOUT` is honored; `MCP_TIMEOUT` startup behavior is unmeasured.
An injected server reported `failed` or `needs-auth` at init fails the attempt as `config`.

### Sessions

Default: `--session-id <attempt uuid> --no-session-persistence`. The UUID is deterministic per
attempt (SHA-256 UUID layout), providing launch identity without a kept transcript. After exit,
the adapter removes `<claudeConfigDir>/projects/*/<uuid>/` spill files and empty project directories,
never other session names. Ephemeral terminal events wait for CLI exit, cleanup and raw-log flush.

Requested `sessionId` enables persistence and records ownership under `stateDir/sessions/`.
UUIDs pass through; non-empty logical ids map through `claudeSessionUuid(id)` to a deterministic
UUID with v4 layout over SHA-256. Owned sessions are reported as
`ownedSession {kind: "claude-session", locator: <uuid>}`.

`resumeSessionId` uses `--resume <id>` and must reuse the session's original cwd. A resumed foreign
session is kept but never recorded or reported as owned. `deleteOwnedSession` refuses unrecorded
sessions; for owned sessions it removes `<uuid>.jsonl` and `<uuid>/` across project directories,
returning `deleted` or `absent`. It is an adapter extension, not part of the SDK interface.

### Events

| CLI event | ExecEvent |
|---|---|
| `system/init` | `started {sessionId}` |
| text delta / unstreamed assistant text | `message_delta` |
| `tool_use` / `tool_result` | `tool_call` running / completed, failed or denied |
| `can_use_tool` | `approval_request` |
| successful `result` | usage then `completed {finalText: result}` |
| error `result` | unknown usage then classified `failed` |

Usage is `input = input_tokens`, `cached = cache_read_input_tokens`,
`cacheWrite = cache_creation_input_tokens`, output as reported, and resolved model from `result.modelUsage`
or the last assistant message. `total_cost_usd` is reported cost, but on subscriptions it is notional
list price (`costBasis: "list"`). Interrupted/error results have unknown usage rather than misleading
zeros. Tool event input/output is capped at 65,536 characters; raw logs retain the full payload.

Synthetic assistant messages are skipped. `rate_limit_event`, `system/status`, `thinking_tokens`
and hook events stay only in raw logs. The `result` line is terminal; later exit code is ignored.

Raw files in `artifactsDir` (fallback `stateDir/attempts/<hash>/`): `claude-stream.jsonl`,
`claude-stderr.log`, `claude-invocation.json` (argv, env keys, tools), `claude-mcp-config.json`.
Request secrets of at least 8 characters are redacted in raw streams, stderr, argv and events;
split stderr chunks are handled by the shared stream redactor.

### Cancel

`cancel(turn)` sends the `interrupt` control request and yields `failed {class: cancelled}`.
Without a result within `killGraceMs`, stdin closes, then SIGTERM/SIGKILL escalation follows.
`cancel(owned)` interrupts, closes stdin and escalates. Results: `too_late` after terminal,
`no_active` for an unknown attempt, `uncertain` for another process's attempt.

### Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | declared | CLI owns both |
| sessionBound | **true** | declared | spawning worker owns stdio/control |
| mcpInjection | native | probed | live, 2.1.310 |
| readOnly | native | probed | safe only; live conformance, 2.1.310 |
| toolAllowlist | native, fine | probed | safe only; live conformance, 2.1.310 |
| systemPrompt | native, `append` (or `replace` per config) | probed | live, 2.1.310 |
| modelSelect | native | probed | `--model`; live, 2.1.310 |
| effortLevels | low, medium, high, xhigh, max | declared | CLI help; minimal maps to low |
| resume | native, native | probed | safe only; live conformance, 2.1.310 |
| partialStream | native | probed | live, 2.1.310 |
| usage | native, cost | probed | `total_cost_usd` |
| toolTelemetry | native | probed | live, 2.1.310 |
| cancel | native, interrupt | probed | live, 2.1.310 |
| nativeSchema | none | declared | SDK has no schema field |
| contextIsolation | native | probed | project isolation, 2.1.310 |
| fastTier | none | declared | `fast_mode_disabled_reason: sdk_opt_in_required` |
| toolResultBudget | none | declared | source: capability declaration |
| webTools | native, search+fetch, **safetyPolicy `unknown`** | probed | live, 2.1.310; safety controls undocumented |

Capability metadata retains the original 2.1.310 baseline; latest verified CLI is 2.1.319.
The probe notes version differences. Unsupported efforts are refused; Workflow `minimal` maps to `low`.

`probe()` makes no model call and reads no credentials. It reports installation, `claude --version`,
auth from `claude auth status --json` (`loggedIn` → `ok`/`missing`/`unknown`), models from `initialize`
(values plus `resolvedModel`), and the MCP output limit. `modelListComplete: false`: unlisted full
model ids are noted, not refused. Model listing starts one CLI for the control handshake, about 1–2 s.

### Error classification

`CLAUDE_ERROR_RULES` checks result text, subtype, `api_error_status`, `terminal_reason`, errors and stderr.

| Case | Source | Class |
|---|---|---|
| Not logged in / run login | live, 2.1.310 | auth |
| Invalid API key, expired OAuth, `authentication_error`, 401/403 | documented shapes | auth |
| Selected model issue, 404, `unrecognized_model` | live, 2.1.310 | config |
| Unknown option, injected server failure, CLI missing/ENOENT | adapter | config |
| 429, `rate_limit_error`, usage limit | documented | rate_limit |
| 500/502/503/504/529, overload, ECONNRESET/ETIMEDOUT/socket hang up | documented | transient |
| Prompt too long, 400 `invalid_request_error`, `error_max_turns` / `error_max_budget_usd` | documented | permanent |
| Adapter-requested interrupt or exit after stop | live, 2.1.310 | cancelled |
| Unrequested interrupt, exit without result and unrecognized stderr | offline / replay | unknown |

Exclusive claims prevent duplicate launches; unreadable or mismatched
records mean unknown, refuse resubmission with `AUTHORITY_ALREADY_CONSUMED`, and make cancel uncertain.

### Known limits

- **Session-bound:** another process reconciles from raw output: recorded result → `found`, otherwise
  `unknown`. Either needs a decision, never automatic adoption/relaunch. Cross-process observe
  replays raw output and ends `failed unknown` without a result.
- **Auto-allow:** CLI read tools and read-only Bash can bypass engine approval; safe readOnly removes Bash.
- **Spills:** files exist during the run and are removed after ephemeral CLI exit. The artifact
  server's actual default bound is 21,375 characters/bytes, below the 22,500 probe limit.
- **Environment:** inherited `ANTHROPIC_API_KEY` switches to API-key billing. MCP env values are
  visible to CLI Bash children.
- **Unverified:** global `CLAUDE.md`, `Edit`/`Write` names, `MCP_TIMEOUT`. `deadlineMs` is not
  adapter-enforced; runtime timeouts apply. Web safety controls are undocumented.
- Three parallel attempts are verified; higher concurrency is unverified.
- Revoked or dead-process spawned records older than 7 days are pruned with their attempt directory,
  on submit at most every 6 h and by `agent-workflow prune`. Launched records become permanent
  `agent-workflow-attempt-tombstone-v1` tombstones (attemptKey, finishedAt, prunedAt; no outcome).
  Reconcile reports `unknown`, never `absent`; submit refuses the key. Only never-launched revoked
  records are removed.

## Antigravity (ACP)

Entry point: `@agwab/agent-workflow/executors/acp`; source: `src/executors/acp/`.
Use `createExecutor(config)` or the typed `createAcpExecutor({ config, faults })`.
Adapter and SDK contract version: `0.1.0`; ACP protocol version: **1**.
`config.preset` selects the agent and executor id.

**Antigravity** is built in (`--executor antigravity`), verified with **agy_acp_server 1.4.5** and
`gemini-3.8-flash` (low). Live readOnly, tool-allowlist, isolation and artifact-MCP checks pass;
resume/session-ownership checks skip because those capabilities are none. Capabilities remain
`declared`. **Gemini CLI** (`gemini --acp`) is a pilot preset without a verified live CLI version.
Offline and runtime conformance use a scripted ACP agent.

### Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `preset` | `gemini` | Agent preset and executor id |
| `command` | `gemini` or `agy_acp_server`; Antigravity checks `$AGENT_WORKFLOW_AGY_ACP_SERVER` first | Executable |
| `agentHome` | `<stateDir>/<preset>-home` | Engine-owned login home for presets supporting isolation |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/acp` (`~/.agent-workflow/…`) | Attempt records |
| `killGraceMs` | `2000` | Grace between stdin close, SIGTERM and SIGKILL |
| `handshakeTimeoutMs` | `60000` | Bound for `initialize` and `session/new` |

Unknown keys fail with `DESCRIPTOR_INVALID`. The built-in descriptor is
`{ id: "antigravity", module: <dist>/executors/acp/index.js, config: { preset: "antigravity" } }`.
To use Gemini, register in process:

```js
registerWorkflowExecutor({
  id: "gemini", version: "0.1.0", contractVersion: "0.1.0",
  module: "@agwab/agent-workflow/executors/acp", config: { preset: "gemini" }
});
```

Then select `executor: "gemini"`.

### Invocation

1. Build launch argv and validate before consuming authority.
2. Launch the agent with inherited environment plus request env, subject to preset isolation.
3. Send `initialize` without client `fs` or `terminal` capabilities: the agent uses its own tools.
4. Send `session/new {cwd, mcpServers}`, followed by preset mode/model/effort configuration and one
   `session/prompt`. MCP env values travel in `session/new`, never on argv or disk.
5. Close stdin when the prompt settles, then escalate through SIGTERM/SIGKILL after the grace.

ACP has no system-prompt field. The adapter prefixes the system prompt to the task, separated by `---`;
this is emulated append, not a privileged system message. Sessions are process-bound, not resumable.

### Gemini preset

Launch:

```text
gemini --acp [--model <m>] --allowed-mcp-server-names <engine servers> --approval-mode <mode>
```

ACP servers merge into user-configured servers. `--allowed-mcp-server-names` excludes ambient servers;
with no engine servers it uses the sentinel `agent-workflow-none`.
Safe readOnly uses `--approval-mode plan`; every free stage uses `yolo`; safe writable stages use `default`.
Permission requests still pass through engine policy. GEMINI.md memory and user settings remain;
`contextIsolation` is none and no fine tool allowlist is offered.

The expected artifact name is `mcp_workflow_artifact_workflow_artifact` from Gemini source, not yet
verified live. Its MCP delivery limit, real approval behavior, cancellation and usage numbers are
also unverified. `probe()` reads `--version`; auth is `unknown`, because ACP initialization lists
methods rather than login status. Gemini tools send display text, not full results; these events
cannot serve as evidence receipts.

### Antigravity preset

Install the registry archive (`antigravity-acp`) and expose `agy_acp_server` on PATH, or set
`AGENT_WORKFLOW_AGY_ACP_SERVER`. There is no installer. `doctor` lists Antigravity after Pi, Claude
and Codex, but does not make it the installed default.

Launch uses no arguments on macOS and `--uid=` on Linux. For symlinked executables, the adapter sets
`ANTIGRAVITY_HARNESS_PATH` to `localharness_external` beside the real file.

After `session/new`, the adapter sends `session/set_mode`: `yolo` for every free stage (including readOnly), otherwise
`default`. Antigravity has no read-only mode; enforcement relies on tool filtering and engine
permission decisions, not a filesystem sandbox. `session/set_config_option` selects `model` and
`thinking_level`. Models outside the offered list fail as config; non-Google provider names are
refused before launch because 1.4.5 offers only Gemini models. Effort maps to low/medium/high:
`off`/`minimal`/`low` → low, `medium` → medium, `high`/`xhigh`/`max`/`ultra` → high, when offered.

#### Tool mapping

`ANTIGRAVITY_TOOL_MAPPING` builds `_meta.antigravity.enabledTools` for `session/new`.
The server enforces this allowlist; engine MCP tools are unaffected.

| Workflow tool | Antigravity built-in / MCP tool |
|---|---|
| `read` | `view_file` |
| `grep`, `find`, `ls`, `bash` | `run_command` |
| `edit` | `edit_file` |
| `write` | `create_file` |
| `web_search` | `search_web` |
| `fetch_content` | `read_url_content` plus `view_file` |
| `workflow_artifact` | MCP `workflow_artifact` / `workflow_artifact` |

ReadOnly drops `edit_file` and `create_file`. Shell access remains coarse and permission-gated;
`grep`/`find`/`ls` have no dedicated live tools in 1.4.5. `list_directory`, `search_directory`,
`find_file` are not offered even if enabled. The model may expose write tools as `write_to_file`
and `replace_file_content`; the table uses the server's filter names.

Every unlisted built-in is disabled, including `run_workflow`, `schedule`, `invoke_subagent`,
`ask_question`, `generate_image`. This prevents out-of-engine agents/timers and unattended questions;
disabling `run_workflow` also prevents its startup `skills/system/run-workflow/SKILL.md` write in cwd.
When nothing maps, `disabledTools` lists all **15** known filter names instead; empty-allowlist
semantics are unverified. Unknown filter names are warned about. The adapter uses `_meta.antigravity`,
not legacy `_meta.agy` (documented since server 1.2.1).

#### Isolation and authentication

Isolated attempts set `GEMINI_HOME` to a fresh private `aw-antigravity-home-*` directory containing
only a copy of `<agentHome>/antigravity-acp/settings.json`. The temporary home is removed after server
exit. The shared worker home retains login configuration, not worker conversations. This excludes
user global hooks (`config/hooks.json`), MCP servers (`config/mcp_config.json`), GEMINI.md and history.
`isolation.inherit` instead uses the user's home.

Workspace `AGENTS.md`, `GEMINI.md` and `.agents/rules` are not loaded on 1.4.5, but `.agents/skills`
are offered with no disable switch. `contextIsolation` is therefore emulated with a warning.
Workspace hooks are expected to require trust, but their absence has not been observed directly.

Inherited `GEMINI_API_KEY`, `GOOGLE_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`,
`ANTIGRAVITY_HARNESS_PATH`, `AGY_ACP_*` are removed unless explicitly set in the request.
Removed names are recorded as `envRemoved` in `acp-invocation.json`.

Authenticate the worker home once with `authenticateAcpAgent(config, "oauth-personal")`.
The server manages Google credentials outside `GEMINI_HOME`; only the method is recorded in
`<agentHome>/antigravity-acp/settings.json` (verified on macOS). Existing server login can avoid a new
browser flow; otherwise the user completes Google login. The probe reads only the method, never
credentials, and reports missing auth until it is recorded.

Server starts refresh the login token. A cross-process lock per login home serializes startup from
spawn through `session/new`, with at most about 2 min waiting, reducing concurrent-refresh login
prompts. Workers get `BROWSER=true`. A server requesting interactive login fails immediately as
`auth`; authenticate the worker home again. Browser suppression itself is unverified live.

#### MCP and web results

The artifact prompt name remains **`mcp__workflow_artifact__workflow_artifact`**. The model routes
MCP calls through `call_mcp_tool(ServerName, ToolName, Arguments)`.
Every session sets `_meta.antigravity.mcpMaxOutputBytes = 131072` (server ≥ 1.4.0);
`probe().mcpOutputLimitChars = 32768` (byte bound / 4). A 30,000-character result is verified inline.
Without this override, 1.4.5 spills on-demand MCP results over 4 KB to step files.

ACP MCP `rawOutput` is a display summary. The adapter holds completion until after the turn, then
matches server/tool/arguments against
`antigravity-acp/brain/<session>/.system_generated/logs/transcript_full.jsonl`.
Results come from the matching following step or its `steps/<n>/output.txt`, restricted to the
session directory and clipped at **8 MiB**. Transcripts over **64 MiB** are not read. An unmatched
call, or a call using an inherited home, closes without recovered output.
Released results are recorded in `acp-stream.jsonl` as `{"agentWorkflow":"tool-results"}` so replay
releases the same output.

`search_web` returns a grounded summary with links; some use
`vertexaisearch.cloud.google.com/grounding-api-redirect/…`. `read_url_content` reports a title and
saves page Markdown to `.system_generated/steps/<n>/content.md`; the adapter releases that page as
output keyed by `Url`. The model also needs `view_file` to read the saved page, hence the paired
mapping. `search_web` permission requests are treated as fetch, not ACP search.
Shell `rawOutput` retains `combinedOutput` and `exitCode`, but the server truncates long shell output.
Built-in reads retain real paths/ranges (`file_path`, `start_line`, `end_line`) but only display-summary
output. They are not recovered from transcripts. Evidence must use local file bytes, captured MCP
results, or the complete web outputs above, not display summaries.

### Events

| ACP | SDK event |
|---|---|
| `agent_message_chunk` text | `message_delta`; concatenated answer |
| `tool_call`, `tool_call_update` | `tool_call`; pending/in_progress/completed/failed → pending/running/completed/failed; rejected permission → denied |
| `session/request_permission` | `approval_request`; allow_once/reject_once only, never *_always; absent option → cancelled; timeout → denied |
| prompt result `usage` | input = `inputTokens − cachedReadTokens`, output = `outputTokens + thoughtTokens`, cost unknown |
| `end_turn` | `completed` |
| `cancelled` | `failed/cancelled` |
| `max_tokens`, `max_turn_requests`, `refusal` | `failed/permanent` |

Other agent requests (`fs/*`, `terminal/*`) receive JSON-RPC error **-32601**.
`cancel` sends `session/cancel`; process cleanup uses stdin close and signal escalation.

Raw files: `<artifactsDir>/acp-stream.jsonl` (agent-to-client lines), `acp-stderr.log`,
`acp-invocation.json` (argv, env keys, MCP server names/env keys). Request env values of at least
8 characters are redacted. Cross-process observe replays these files; without a prompt result,
reconcile reports `unknown` because the original process owned the session.

### Capabilities (Gemini preset, declared)

All capability levels remain declared. Source: `src/executors/acp/capabilities.ts`.
The Antigravity column includes its live-verified behavior without upgrading metadata to probed.

| Capability | Gemini | Antigravity | Basis |
|---|---|---|---|
| toolLoop / context | agent / agent | agent / agent | agent-owned loop |
| sessionBound | true | true | process-owned ACP session |
| mcpInjection | native | native | `session/new`; Antigravity live, 1.4.5 |
| readOnly | emulated | emulated | safe only: plan/default mode plus engine policy |
| toolAllowlist | none | native, coarse | Antigravity `enabledTools`, live 1.4.5 |
| systemPrompt | emulated, append | emulated, append | prompt prefix |
| modelSelect | native | native | CLI flag / session config |
| effortLevels | none | low, medium, high | preset config |
| partialStream | native | native | `agent_message_chunk` |
| usage | native, tokens | native, tokens | prompt result usage |
| toolTelemetry | native | native | ACP tool events |
| cancel | native, notify | native, notify | `session/cancel` |
| nativeSchema | none | none | source: capabilities declaration |
| contextIsolation | none | emulated | Gemini memory/settings; Antigravity workspace skills |
| fastTier | none | none | source: capabilities declaration |
| toolResultBudget | none | none | source: capabilities declaration |
| webTools | search+fetch, safety unknown | search+fetch, safety unknown | preset declaration; Antigravity web result capture |
| resume | none | none | source: capabilities declaration |

### Errors and retries

Failures without a stop reason are classified from error text as auth, rate_limit, config, transient,
or unknown. The adapter does not infer success from an unrecorded result or automatically reattach to another
process's session.

Antigravity failure-shaped answers are handled explicitly:

| Answer / condition | Class |
|---|---|
| `Usage Limit Reached` | rate_limit |
| `Agent execution error: …` | classified from detail |
| `The MCP server '…' failed to initialize` | unknown |
| Interactive Google login request on stderr | auth |
| Unsupported offered model | config |

The failure-answer patterns are source-based and have not been observed live here.

### Known limits

- Gemini live MCP naming/delivery, approvals, cancellation and usage remain unverified.
- Neither preset supports resume or session adoption after owner loss.
- Antigravity has no filesystem sandbox or native read-only mode; safe readOnly is emulated; free readOnly is not enforced.
- Antigravity workspace skills remain visible under isolation; workspace-hook exclusion is unverified.
- Antigravity unknown/new built-ins and empty-allowlist semantics need verification on newer servers.
- Raw tool display summaries are not full evidence; result recovery is unavailable with inherited homes.
- Startup serialization mitigates refresh contention but does not prove interactive login impossible;
  `BROWSER=true` suppression remains unverified live.
