# Codex executor adapter

Entry point: `@agwab/agent-workflow/executors/codex`; source: `src/executors/codex/`.
Use `createExecutor(config)` with descriptor
`{ id: "codex", version: "0.1.0", contractVersion: "0.1.0", module: "@agwab/agent-workflow/executors/codex", config: {} }`.
Keep secrets in `SubmitRequest.env` or `McpServerSpec.env`, not descriptor config.

Verified with **codex-cli 0.166.0** using ChatGPT login. Live coverage also exists for **0.159.2**
and **0.165.0**. Protocol details were established on 0.159.2; MCP output bounds were rechecked
on 0.165.0 and 0.166.0.

## Transport: `codex app-server`

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

### Flags and overrides

| Setting | Value / purpose |
|---|---|
| `sandbox` | Safe/default: `read-only` for readOnly or read-only tools; `workspace-write` for write/exec tools or an empty tool list on a writable stage. Free and non-readOnly: `danger-full-access` |
| `approvalPolicy` | `on-request`; `never` only for free, non-readOnly stages |
| `approvalsReviewer` | `user`, preventing user config from routing decisions to auto-review |
| `serviceTier` | `null` (standard); fast tier is not offered |
| `ephemeral` | true unless `sessionId`/`resumeSessionId` is requested |
| `developerInstructions` | Appends `systemPrompt`; does not replace Codex's base prompt |
| config `web_search` | `live` for `web_search`/`fetch_content`, otherwise `disabled` |
| config `tool_output_token_limit` | 10000 by adapter default, independent of model catalog |
| config `features.multi_agent` | false, preventing worker subagents outside engine slots |
| config `mcp_servers.<name>.{command,args,env,enabled,tool_timeout_sec,startup_timeout_sec}` | Injected over stdin; default timeouts 300 s / 30 s |
| `effort` | Request value when set; otherwise the user's `model_reasoning_effort` applies |

## Permission mode

`free` on a non-readOnly stage uses `danger-full-access` plus `never`. Safe/default uses the mapped
sandbox plus `on-request`; readOnly uses `read-only` plus `on-request` in either mode.
Free mode records coarse-tool and environment degradations without strict refusal or confirmation.
See [permissions](../permissions.md); mapping: `CODEX_PERMISSION_MODE_SETTINGS`.

## Isolation

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

`CODEX_HOME` is not relocated and credential files are not read. Project `AGENTS.md`, skills, plugins,
apps and personal MCP tools are disabled. MCP disabling uses thread config: per-server argv overrides
fail validation on 0.159.2, while `-c mcp_servers={}` merges rather than replacing.

Global `$CODEX_HOME/AGENTS.md`, `~/.codex/rules/*.rules` and built-in collaboration role blocks remain.
An exec-policy `allow` rule can run a matching command outside the sandbox without engine approval.

## Environment probe

`probe()` inspects only `rules/*.rules` and `AGENTS.md` under `$CODEX_HOME` (default `~/.codex`),
never `auth.json`. Source: `src/executors/codex/environment.ts`.

| Finding | Probe capability row | Negotiation |
|---|---|---|
| N > 0 `decision = "allow"` rules | `readOnly: emulated`, warning with count and path | readOnly degradation (`CAPABILITY_WARNING:readOnly`); interactive confirmation; strict refusal |
| No allow rules | Declared `readOnly: native` remains | native |
| Non-empty global `AGENTS.md` | `contextIsolation: emulated`, warning with path | non-inherit degradation (`CAPABILITY_WARNING:contextIsolation`); strict refusal |
| Absent or whitespace-only global `AGENTS.md` | `contextIsolation: native` | native |

The rule tokenizer counts keyword arguments (`"allow"`, `'allow'`, `r"allow"`), not comments or strings
containing similar text. Only counts and paths are recorded, not patterns or file contents.
Unreadable paths are noted. Free-mode behavior is described above.

Models come from `codex debug models`: visible slugs and per-model `supported_reasoning_levels` become
`modelEfforts`. Stage effort maps to the nearest supported level, lower on a tie.
`modelListComplete: false`: unlisted API-key/custom-provider models are noted, not refused.

## Tool mapping (Pi name → Codex)

| Pi tool | Mapping | Codex tool | Verified live |
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

## MCP injection

Injected servers use dotted `thread/start` config keys such as
`mcp_servers.workflow_artifact.command`, `.args`, `.env`, `.enabled`, `.tool_timeout_sec`,
`.startup_timeout_sec`. Env values travel over stdin, not argv. The artifact tool is
**`mcp__workflow_artifact__workflow_artifact`**.

Injected MCP servers run outside Codex's sandbox. ReadOnly requests may inject only the engine's
read-only artifact server; other servers fail before consume with `CAPABILITY_MISSING:readOnly`.

Codex limits results through `tool_output_token_limit` (default 10,000), retaining head and tail.
On 0.159.2 the measured bound is about **40,000 bytes**, estimated at 4 bytes/token.
On 0.165.0, 47,500 bytes arrived intact and 48,500 bytes became 48,022 bytes; on 0.166.0,
47,500 bytes arrived intact and 48,500 bytes or more became 47,988 bytes with a truncation marker.
ASCII and Korean text hit the same byte bound.

The probe conservatively reports `mcpOutputLimitChars = 32000`. The engine sets
`--max-output-chars 30400` (5% margin), bounding both UTF-16 length and UTF-8 bytes; larger whole
reads are paged. See [MCP](../mcp.md). Normalized `tool_call.output` is separately clipped at
16,384 characters; the raw transcript keeps the full result. `tool_timeout_sec` is honored;
the adapter defaults to 300 s (startup 30 s).

## Events

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
else the request. Output includes reasoning. Cost is `null`, source `unknown`.

Raw stream: `<artifactsDir>/codex-app-server.jsonl` (`{at, dir: out|in|stderr|meta, msg}`), falling
back to the attempt log directory. Request and MCP env values of at least 8 characters are redacted
in raw logs, stderr and normalized events as `<redacted:KEY>` / `<redacted:server.KEY>`.
`config/read` retains only server names; MCP status retains names and counts; account and
remote-control notifications are redacted. Messages sent to the CLI remain unchanged.

## respond / cancel / reconcile / sessions

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

## Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Codex owns the loop |
| sessionBound | true | — | one stdio connection owns the thread |
| mcpInjection | native | probed | live, 0.159.2; offline app-server |
| readOnly | native | probed | live, 0.159.2; environment probe can lower it |
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

## Error classification

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

The engine decides retries by failure class; a consumed attempt is not relaunched by the adapter.
Expired-token, rate-limit and context-overflow cases have protocol coverage, not live reproduction.

## Known limits

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
