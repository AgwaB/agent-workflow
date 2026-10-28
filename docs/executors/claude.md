# Claude Code executor (WP8)

Entry point: `@agwab/agent-workflow/executors/claude`. Source: `src/executors/claude/`.

- Factory: `createExecutor(config)` (descriptor convention, R#15). `createClaudeExecutor({ config, faults })` is the typed form.
- Adapter version: `0.1.0`. SDK contract: `0.1.0`.
- Verified against **claude-code 2.1.310**, on a claude.ai subscription login, live on 2026-10-26.
- Live evidence: 22 calls on `claude-haiku-5-5`, notional $0.029. See `test/fixtures/executors/claude/live-calls.md`.
- Scrubbed transcripts: `test/fixtures/executors/claude/transcripts/`.

## Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `claudePath` | `claude` | CLI binary |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/claude` (`~/.agent-workflow/…`) | Attempt records (reconcile) and kept-session records (`deleteOwnedSession`) |
| `mcpOutputTokens` | `25000` | `MAX_MCP_OUTPUT_TOKENS` the adapter sets for every worker. It overrides inherited and request values |
| `mcpToolTimeoutMs` | unset | `MCP_TOOL_TIMEOUT` (verified: honoured, "timed out after 3s") |
| `systemPromptMode` | `append` | `--append-system-prompt` or `--system-prompt` (`replace`) |
| `listModels` | `true` | `probe()` lists models through the `initialize` control request |
| `killGraceMs` | `3000` | Grace between interrupt → SIGTERM → SIGKILL |
| `claudeConfigDir` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Used only to remove worker session files |

Unknown keys are refused (`DESCRIPTOR_INVALID`).

## Invocation and why

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-mode (default | bypassPermissions) --permission-prompt-tool stdio
  --tools <mapped built-ins> [--allowedTools <web tools>,mcp__<server>…] [--disallowedTools Bash,Edit,Write,NotebookEdit]
  [--setting-sources "" --settings {"autoMemoryEnabled":false} --strict-mcp-config --disable-slash-commands]
  [--mcp-config <artifactsDir>/claude-mcp-config.json] [--model M] [--effort E]
  [--append-system-prompt S | --system-prompt S]
  (--session-id <uuid> --no-session-persistence | --session-id <requested> | --resume <id>)
```

The prompt goes to **stdin** as one stream-json `user` message. The adapter keeps stdin open for the
control protocol and ends it after the `result` line, so the CLI exits.

| Flag | Why (evidence) |
|---|---|
| `-p --output-format stream-json --verbose` | `stream-json` requires `--verbose` with `-p` |
| `--input-format stream-json` | Enables the control protocol on stdin/stdout: `can_use_tool` approvals and `interrupt` |
| `--include-partial-messages` | `stream_event` text deltas → `message_delta` (#1, #4) |
| `--permission-mode default` | **`safe` mode (or no `permissionMode`) and every readOnly stage.** The user's `settings.json` on the test machine says `defaultMode: auto`; without the flag, the `initialize` probe reported `current_permission_mode: auto`. Bypass, `acceptEdits`, `auto`, `dontAsk`, `--dangerously-*` and `--bare` are never used in safe mode (D2) |
| `--permission-mode bypassPermissions` | **`free` mode on a stage that is not readOnly** (WP4e, D2 revised). The documented `--permission-mode` choice in `claude --help` 2.1.310 (choices `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`); the `--dangerously-skip-permissions` alias is not used. Live #23: `system/init.permissionMode: bypassPermissions`, Bash ran without a `can_use_tool` request. `--permission-prompt-tool stdio` stays, so a request that still arrives reaches the engine (free → `allow`) |
| `--permission-prompt-tool stdio` | Without it, a write needing approval is denied by the CLI with `system/permission_denied` and the host is never asked (#2). With it, the CLI sends `control_request can_use_tool` and waits (#3) |
| `--tools` | Restricts the built-in tool set. This enforces readOnly: the kit's `live.readonly_enforced` and `live.tool_allowlist` checks pass |
| `--allowedTools` | Pre-allows only the stage's web tools and tools of engine-injected MCP servers (`mcp__<server>`; verified with `mcp__workflow_artifact`, #10). Read, Grep and Glob inside the cwd need no rule. Everything else goes through the approval channel |
| `--disallowedTools` (readOnly) | Defence in depth next to `--tools` |
| `--session-id` / `--no-session-persistence` | The session id is deterministic per attempt (`attemptSessionId`, UUID layout over SHA-256). It sits on argv, so launch evidence can be tied to an attempt. The session is not kept unless requested (D3) |
| `--settings {"autoMemoryEnabled":false}` | Without it, `system/init.memory_paths.auto` pointed into `~/.claude/projects/<cwd>/memory/` and the CLI created that dir (#1). With it: no `memory_paths`, no dir (#2) |

## Isolation (B5): result

`inherit: false` ⇒ `--setting-sources "" --strict-mcp-config --disable-slash-commands --settings
{"autoMemoryEnabled":false}`. **The subscription login survives** (`apiKeySource: none`, OAuth; every
live call). Evidence:

**Without a model turn: `initialize` control response**

| Combination | slash commands | agents | permission mode | hooks fired |
|---|---|---|---|---|
| no isolation flags | 124 (user commands) | user agents (analyst, planner, scientist) + built-ins | `auto` (user settings) | 3 SessionStart hooks |
| `--safe-mode` | 54 built-in | built-ins | **`auto`** (permissions still load) | none |
| `--restricted` | 54 built-in | built-ins | `default` | none |
| **adapter combination** | **0** | built-ins only | **`default`** | **none** |

**Live**

- **#1, `--include-hook-events`:** no hook events. Only the `cc-plugin-*@builtin` plugins loaded; the 9 user plugins did not. `skills: []`. `mcp_servers` held only the injected server.
- **#1 and kit `live.isolation`:** `CLAUDE.md` and `AGENTS.md` in the cwd held "always end with ZEBRA…". The model did not follow them.
- **#7, `--bare`:** "Not logged in · Please run /login" (OAuth is not read). It still loaded user plugins and skills, so it is neither usable nor isolating.

`contextIsolation` is therefore `native` / `probed`.

**Not verified**

- A user-level `~/.claude/CLAUDE.md`. None exists on the test machine, and the global config must not be changed. The SDK documents `settingSources` as the switch for all CLAUDE.md loading.
- The built-in plugins (`cc-plugin-sec-default`, `cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`) stay loaded. The `agents-md` plugin did not inject the cwd `AGENTS.md`.

`inherit: true` drops the four isolation flags but **keeps `--permission-mode default`**. The user's
own permission allow rules then apply (the user's choice).

## Tool mapping (Pi → Claude)

| Pi | Claude | Kind | Verified live |
|---|---|---|---|
| `read` | `Read` | read | yes (#1, #10, kit) |
| `grep` | `Grep` | search | listed in `system/init.tools` (#1), not called |
| `find` | `Glob` | search | listed (#1), not called |
| `ls` | `Glob` (2.1.310 has no LS tool) | search | listed (#1), not called |
| `bash` | `Bash` | execute | yes (#1 `ls` auto-allowed; #3 `touch` allow/deny) |
| `edit` | `Edit` | edit | no (name from Claude Code docs) |
| `write` | `Write` | edit | no (name from Claude Code docs) |
| `web_search` | `WebSearch` (client tool) | fetch | yes (#14) |
| `fetch_content` | `WebFetch` | fetch | yes (#14) |
| `workflow_artifact` | MCP `mcp__workflow_artifact__workflow_artifact` | read | yes (#10, real artifact server, 1 ledger row) |

- A tool without a mapping is refused before consume (`CAPABILITY_MISSING:tool:<name>`).
- `workflow_artifact` without an injected `workflow_artifact` server is refused (`INVALID_REQUEST`).
- readOnly removes `Bash`, `Edit`, `Write` and `NotebookEdit`.

## Approvals (R#4, D2)

Permission mode (WP4e, see [`../permissions.md`](../permissions.md)): in `free` mode a non-readOnly
stage runs with `bypassPermissions`, so the CLI asks nothing; the engine answers anything that still
arrives with `allow` (audited `engine-policy:free`). A readOnly stage gets the same argv in both modes.
The rest of this section describes the channel itself (used in `safe` mode).

- `control_request can_use_tool` → `approval_request{requestId: request_id, kind, detail: "<Tool>: <command|path|url…>"}`.
- `respond(allow)` → `control_response {behavior: allow, updatedInput: <original input>}`. `respond(deny)` → `{behavior: deny, message}`.
- The denied call is reported as `tool_call{status: denied}`.
- Unanswered requests are denied after `approvalPolicy.timeoutMs` (fail closed).
- `respond` returns `unknown_request` for an id it never saw and `too_late` for an id it already answered or after the run ended.
- Other control requests the CLI might send get an error response, so the CLI never waits forever.
- **CLI-side auto-allow:** Claude Code allows read-only shell commands (`ls`) and Read/Grep/Glob inside the working dirs without asking (#1). The engine sees them only as `tool_call` events. readOnly stages have no Bash at all.

## MCP injection (R#9)

- **Method:** `--mcp-config <artifactsDir>/claude-mcp-config.json` (mode 0600) + `--strict-mcp-config`. The server type is `stdio`.
- **Env values never reach the file or argv.** Each `McpServerSpec.env` value becomes `${AW_CLAUDE_MCP_<i>_<KEY>}`, and the adapter passes the value in the CLI's environment. Claude Code expands it: verified without a model turn through `mcp_status` (the server saw the value's hash; the file held only the reference).
  - A `${` in an MCP command or argument is refused, because Claude would expand it.
  - The MCP server inherits the CLI's whole environment.
- **Visible tool name:** `mcp__<server>__<tool>`, verified: `mcp__workflow_artifact__workflow_artifact` (#10) and `mcp__workflow_artifact__echo` (#1).
  - `src/mcp/visible-names.ts` still says `verified: false`, because the field's type is the literal `false`; flipping it belongs to the MCP owner or WP9b.
- **Output limit:** `MAX_MCP_OUTPUT_TOKENS` is honoured.
  - At 2,000 tokens, 3,000 chars arrived inline and 12,000 chars spilled (#8).
  - At the default 25,000 tokens, 22,500 and 45,000 chars arrived inline and 90,000 chars spilled (#9).
  - **Over-limit results are not truncated.** They are replaced by a notice ("exceeds maximum allowed tokens. Output has been saved to `~/.claude/projects/<cwd>/<session>/tool-results/…`") and written to that file, even with `--no-session-persistence`.
  - The adapter sets `MAX_MCP_OUTPUT_TOKENS` itself (default 25,000) and declares `probe().mcpOutputLimitChars = floor(0.9 × tokens) = 22,500`. A token covers at least one UTF-8 byte, and the artifact server bounds UTF-8 bytes, so results under that limit are always inline. Since WP5b the engine launches the artifact server with `--max-output-chars 21375` (22,500 − 5 % margin; docs/mcp.md "Measured limits"), and larger whole reads are paged.
- **Timeouts:**
  - `MCP_TOOL_TIMEOUT` is honoured: `is_error` "MCP server "x" tool "slow" timed out after 3s" (#8).
  - `MCP_TIMEOUT` (startup) was not measured.
  - An injected server that reports `failed` or `needs-auth` at `system/init` fails the attempt with class `config`.

## Sessions (D3, R#10)

- **Default:** `--session-id <attempt uuid> --no-session-persistence`. No transcript is written.
  - After exit, the adapter removes `<claudeConfigDir>/projects/*/<that uuid>/` (spilled tool results), and the project dir too if it is then empty. The terminal event of such an attempt is held until the CLI exited and the removal finished (live bundle 4), because the durable worker exits right after it.
  - It never touches other names.
- **`sessionId`:** the session is kept (`--session-id`, persistence on) and recorded under `stateDir/sessions/`. Terminal events carry `ownedSession {kind: "claude-session", locator: <uuid>}` (kit `live.session_ownership`).
  - A UUID is used as is. Any other id (the engine's logical `agent-workflow.<run>.<task>`) maps to a deterministic UUID, `claudeSessionUuid(id)` (v4 layout over SHA-256). Until live bundle 3 a non-UUID id was refused (`INVALID_REQUEST`), which stopped every Claude workflow run before launch.
- **`resumeSessionId`:** `--resume <id>` (kit `live.resume`: the codeword was recalled). Claude resumes only from the directory the session was created in, so same-session repair must reuse the attempt cwd. The live harness does this.
- **`deleteOwnedSession({kind, locator})`:** an adapter extension, not in the SDK interface yet.
  - Only for sessions in `stateDir/sessions/` (otherwise `refused`).
  - Removes `<uuid>.jsonl` and `<uuid>/` from every project dir.
  - Returns `deleted` or `absent`. Used live to remove the kit's two kept sessions.

## Events

See the table in `src/executors/claude/stream.ts`.

- **Started:** `system/init` → `started{sessionId}`.
- **Text:** text deltas, or assistant text when the message was not streamed, become `message_delta`.
- **Tools:**
  - `tool_use` → `tool_call{running, input}`.
  - `tool_result` → `completed` / `failed` / `denied`.
  - `can_use_tool` → `approval_request`.
- **Result:**
  - Success: `usage{input: input+cache_creation+cache_read, output, cached: cache_read, cost: total_cost_usd, source: reported}`, then `completed{finalText: result}`.
  - Error: `usage` with every field `null` and `source: unknown`, then `failed`.
- **Ignored or skipped:**
  - Assistant messages from model `<synthetic>` (CLI error text) are skipped.
  - `rate_limit_event`, `system/status`, `thinking_tokens` and hook events are ignored. They stay in the raw log.
- **The `result` line is terminal.** Its exit code is ignored: #5 exited 143 after a successful result.

**Cost.** On a subscription, `total_cost_usd` is a notional list price (`costBasis: "list"`).
Interrupted (#4) and errored results report 0 tokens and $0 although tokens were spent. The adapter
reports them as unknown (never 0).

**Raw evidence** in `artifactsDir` (or `stateDir/attempts/<hash>/`):

- `claude-stream.jsonl`: stdout verbatim, with request env values ≥ 8 chars replaced by `<redacted:KEY>`
- `claude-stderr.log`
- `claude-invocation.json`: argv, env keys only, tools
- `claude-mcp-config.json`

## Cancel

- **`cancel(turn)`:** the `interrupt` control request (verified #4: `control_response success`, then `result error_during_execution`, `terminal_reason: aborted_streaming`). It ends with `failed{class: cancelled}` because the adapter asked. Without a result within `killGraceMs`, the adapter ends stdin and escalates to SIGTERM, then SIGKILL.
- **`cancel(owned)`:** interrupt + end stdin + SIGTERM/SIGKILL escalation.
- **Results:** `too_late` after terminal. `no_active` for an unknown attempt. `uncertain` for an attempt launched by another process; this instance cannot reach it.

## Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | declared | CLI owns both |
| sessionBound | **true** | declared | stdio and the control protocol belong to the spawning worker. From another process, reconcile is `unknown` (with a reason) unless the raw stream recorded a result (`found`); both ⇒ `needs_decision`, never adoption or relaunch |
| mcpInjection | native | probed | #1, #10 |
| readOnly | native | probed | kit `live.readonly_enforced` |
| toolAllowlist | native, fine | probed | kit `live.tool_allowlist` |
| systemPrompt | native, `append` (or `replace` per config) | probed | #21, #22 |
| modelSelect | native | probed | `--model haiku` → `claude-haiku-5-5` |
| effortLevels | low, medium, high, xhigh, max | declared | `--help`. Pi `minimal` → `low`; others refused |
| resume | native, native | probed | kit `live.resume` |
| partialStream | native | probed | #1, #4 |
| usage | native, cost | probed | `total_cost_usd` (notional on a subscription) |
| toolTelemetry | native | probed | #1, #3, #10, #14 |
| cancel | native, interrupt | probed | #4 |
| nativeSchema | none | declared | `--json-schema` exists, but `SubmitRequest` has no schema field |
| contextIsolation | native | probed | see Isolation |
| fastTier | none | declared | `fast_mode_disabled_reason: sdk_opt_in_required` |
| toolResultBudget | none | declared | C1 |
| webTools | native, search+fetch, **safetyPolicy `unknown`** | probed | #14. The CLI documents no private-IP, credential-URL, redaction or budget controls (C2/Q2) |

`probed` rows carry `verifiedWith: "claude-code 2.1.310, WP8 live 2026-10-26"`. `probe()` adds a note
when the installed version differs.

`probe()` makes no model call and reads no credential file. It reports:

- `installed`
- `cliVersion` (`claude --version`)
- `auth` (`claude auth status --json` → only `loggedIn` → `ok`/`missing`/`unknown`)
- models (from `initialize`; only the model `value`s are kept). These are aliases, and the CLI also
  accepts full ids (`claude-haiku-5-5`), so `modelListComplete: false`: a role model missing from
  the list is noted as not verified, never refused (WP31 follow-up)
- `mcpOutputLimitChars` (22,500)

## Error classification (`CLAUDE_ERROR_RULES`)

The classifier sees the result text, `subtype`, `api_error_status`, `terminal_reason`, `errors` and stderr.

| Case | Source | Class |
|---|---|---|
| "Not logged in · Please run /login" (`--bare`, OAuth not read) | live #7 | auth |
| "Invalid API key", OAuth token expired, `authentication_error`, status 401/403 | documented shapes | auth |
| "There's an issue with the selected model…", status 404, stderr `unrecognized_model` | live #6 | config |
| unknown CLI option; injected MCP server `failed`; CLI not found (spawn ENOENT) | adapter | config |
| status 429, `rate_limit_error`, "usage limit reached" | documented | rate_limit |
| status 500/502/503/504/529, `overloaded_error`, ECONNRESET/ETIMEDOUT/socket hang up | documented | transient |
| "prompt is too long", status 400 `invalid_request_error`, `error_max_turns` / `error_max_budget_usd` | documented | permanent |
| interrupt requested by the adapter (`error_during_execution` / `aborted_streaming`, or exit after our stop) | live #4 | cancelled |
| interrupt not requested by us; exit without a result and unrecognised stderr | live #4 replay, offline | unknown (never auto-retried) |

## Concurrency

Three parallel `claude -p` runs (#11–#13) completed in 3.5 s wall time, with distinct sessions and
correct answers. There were no auth or lock conflicts and no rate limiting (five-hour window
utilisation 0.17).

## Web (C2)

One call (#14) with tools `web_search, fetch_content`: `WebSearch` (a client tool, `query`, `mode:
standard`) and `WebFetch` (`url`, `prompt`) both completed. The answer cited sources.

- `server_tool_use.web_search_requests` stayed 0: the CLI runs the search itself.
- Both tools are pre-allowed when the stage asks for them.
- `safetyPolicy: unknown`.

## Conformance

- **Offline** (`test/unit/executor-claude-conformance.test.mjs`): 33 checks pass. The stub CLI replays the scrubbed transcripts; `mcp_tool` uses `fake-claude-mcp.mjs`, which acts as Claude's MCP client, `${VAR}` expansion and spill included.
  - `mcp.delivery_bound` is **skipped, justified.** Claude replaces an over-limit result with a spill notice instead of delivering a prefix, so no delivered output contains the nonce the check measures. The live measurements are #8 and #9.
  - The fail scenarios for rate_limit, transient and permanent are synthetic API-error results in the live `api_error` shape. The auth and config scenarios are the live transcripts.
- **Runtime** (same file): `runtime.durable_authority` (kill ⇒ `marked-needs-decision/unknown` since WP37), `runtime.detach_rediscovery` and `runtime.control_relay` all pass. They drive the real durable worker with the stub CLI.
- **Live** (`test/unit/executor-claude-live.test.mjs`, `AGENT_WORKFLOW_LIVE=1`, real HOME):
  - Kit checks: `live.readonly_enforced`, `live.tool_allowlist`, `live.isolation`, `live.session_ownership` and `live.resume` all pass.
  - Own tests: smoke + artifact MCP, concurrency, web and system prompt all pass.
  - The session-cleanup assertion was corrected after the run. The duplicate session record from the resume attempt correctly reports `absent`.

## Known limits

- **sessionBound.**
  - If the worker process dies, the CLI loses its stdio. Reconcile from another process reports `unknown` with a reason (no result recorded) or `found` (the raw stream holds a result); either way the attempt needs a decision and is never relaunched automatically (B3, WP37).
  - `observe` in another process replays the raw stream and, if no result was recorded, ends with `failed{unknown}`.
- **CLI-side auto-allow.** Read/Grep/Glob inside the cwd and read-only Bash commands are allowed without an approval request. They are visible only as `tool_call` events.
- **Spilled MCP results.** They land under `~/.claude/projects/…` while the run is active. The adapter removes them after exit. The artifact server's bound (22,500 chars) keeps `workflow_artifact` below the spill.
- **Environment.**
  - The CLI inherits the full process environment. A set `ANTHROPIC_API_KEY` switches the CLI to API-key billing (D1 allows it).
  - MCP env values sit in the CLI's environment, so Bash tool children can see them.
- **Not verified:**
  - user-level `CLAUDE.md`
  - `Edit` and `Write` names
  - `MCP_TIMEOUT`
  - `deadlineMs`. The adapter does not enforce it; the runtime enforces timeouts.
- **Probe cost.** `probe()` with `listModels` spawns one `claude -p` for the `initialize` exchange (about 1–2 s, no model turn).

## Change log

- **WP37 (B3 reconcile):** `reconcile(attemptKey)` in a process that does not own the attempt (the
  spawning worker died, taking the CLI's stdio and control protocol with it) reads the kept raw
  stream. With a recorded `result` line it stays `found` (the outcome can be replayed); without one
  it reports `{unknown: true, reason}` naming the attempt handle and CLI pid, "the claude CLI is
  session-bound … no result was recorded, so the outcome is unknown: needs an owner decision, no
  automatic relaunch (B3)". Before, it reported `found`, and the runtime's needs_decision message
  claimed the executor "still holds the attempt". The runtime records the reason
  (`metadata.executor.reconcileReason`) and marks the attempt `failed/needs_decision`; the engine
  blocks the task (`executor_needs_decision`) until a person resumes or stops it. The owning
  instance still reports `found`. The raw stream is now closed (flushed) before the held terminal
  event is delivered, so a worker that exits right after that event leaves a result another process
  can read (a validate run under load once saw the conformance `reconcile.found` restart read the
  file before the flush). Tests: `executor-wp37-claude-reconcile.test.mjs`;
  `executor-claude-conformance.test.mjs` expects kill ⇒ `marked-needs-decision/unknown`.
- **Live bundle 4 (2026-10-27):** an ephemeral attempt's spilled tool results
  (`<claudeConfigDir>/projects/<cwd slug>/<uuid>/tool-results/`) are removed **before** the terminal
  event. The terminal event is emitted at the stream's `result` line, and the durable worker commits
  it and calls `process.exit`; the removal ran fire-and-forget in the child's `close` handler, so it
  was cut. Measured: after three concurrent CLI deep-review runs on haiku, 7 worker session
  directories (each `tool-results/toolu_*.txt`) were left in three `~/.claude/projects` entries. Now
  a `completed`/`failed` event of a non-kept session is held until `close`, the removal is awaited,
  then the event is delivered (at most `killGraceMs` later: stdin is closed at `result` and the CLI
  is reaped). Kept sessions are unchanged. Test: `executor-claude-sessions.test.mjs` "… gone before
  the terminal event (D3, live 4)" (40 unrelated project dirs; no polling after the terminal event).

- **WP12d-2 review #10:** child handlers (`error`, `close`, stdin, stdout, stderr) are attached
  synchronously right after `spawn`, before any await; the durable `spawned` record is written after
  them, and the session ownership record before the spawn. Before, an immediate spawn error (ENOENT)
  had no listener and became an uncaught exception, and a CLI that exited during the `spawned` write
  lost its `close` and output (measured: a child's `close` is not replayed to listeners attached after
  it fired). Test: `executor-wp12d2-spawn-handlers.test.mjs` (missing CLI → `failed` event; exit during
  a delayed `spawned` write → terminal event with the stderr text).

- **WP12d-2 review #9:** same pattern checked: `deleteOwnedSession` already required a session
  record, but resuming any session UUID recorded it and reported it as `ownedSession`. A resumed
  session is now owned only when the adapter recorded it earlier; a foreign one is kept (not removed
  after the run) but never recorded or reported as owned, also on replay. Test:
  `executor-wp12d2-session-ownership.test.mjs`.

- **WP12d-2 review #6:** injected MCP servers no longer bypass readOnly. `--allowedTools` pre-allows
  the engine's artifact server by its one read-only tool (`mcp__workflow_artifact__workflow_artifact`,
  exact-tool rule; the server-wide `mcp__workflow_artifact` rule was the live-verified form, #10),
  never server-wide. A readOnly request that injects any other server is refused before consume with
  `CAPABILITY_MISSING:readOnly` (its tools may mutate and the adapter cannot tell them apart). On
  non-readOnly requests a caller-injected server keeps its server-wide rule. The conformance kit's
  `mcp_tool` requests are now non-readOnly (`src/sdk/conformance/checks-mcp.ts`). Tests:
  `executor-wp12d2-mcp-readonly.test.mjs`, `executor-claude-argv.test.mjs`.

- **WP12d-2 review #5:** same exposure checked: stdout lines, argv and events were already redacted,
  but stderr was redacted per chunk, so a value split across two chunks was written in full to
  `claude-stderr.log` and the failure text. stderr now goes through the shared stream redactor
  (`src/executors/redact.ts`; a possible value prefix is held back until the next chunk or stream
  end). Test: `executor-wp12d2-secret-echo.test.mjs`.

- **WP12d-2 review #3:** unreadable launch evidence is no longer proven absence. `ClaudeStateStore.lookupAttempt` returns `missing` only on
  ENOENT; a record that cannot be read, does not parse, has the wrong schema/phase or names another
  attemptKey is `unreadable`: `reconcile` answers `unknown` (the runtime records
  `failed/needs_decision`, `src/runtime/orchestrate/reconcile.ts` already maps every non-`absent`
  outcome there and is unchanged), `submit` refuses with `AUTHORITY_ALREADY_CONSUMED` before consuming
  the authority, and `cancel` answers `uncertain`. Test: `executor-wp12d2-evidence.test.mjs`
  (malformed, empty, directory and mismatched records for all three adapters).

- **WP12d-2 review #2:** attempt claims are exclusive across executor instances and processes.
  After the authority is consumed, the first attempt record (`consumed`, or `revoked`) is created
  with an exclusive hard link (`ClaudeStateStore.claimAttempt`); a submit that loses the claim
  resolves the existing record (spawned ⇒ same ref, otherwise `AUTHORITY_ALREADY_CONSUMED` /
  `AUTHORITY_REVOKED`) and never overwrites it or spawns. Test:
  `executor-wp12d2-claude-claim.test.mjs` (two instances, one stateDir/key: one launch).

- **WP12a (2026-10-27):** usage is normalized (docs/core-port.md WP12a change log 3): `input` is
  `input_tokens` as reported (no longer plus cache reads and cache creation), `cached` =
  `cache_read_input_tokens`, `cacheWrite` = `cache_creation_input_tokens`, and `model` is the resolved
  model (`result.modelUsage`, else the last assistant message), not the request alias. Tests:
  `executor-claude-stream.test.mjs`, `core-wp12a-usage-normalized.test.mjs`.

- **Live bundle 3 (2026-10-27):** a requested `sessionId` that is not a UUID maps to
  `claudeSessionUuid(sessionId)` instead of being refused (the engine names kept sessions
  `agent-workflow.<run>.<task>`; all four Claude bundled-workflow runs failed `launch_failed`
  "sessionId must be a UUID"). An empty id is still refused. Test: `executor-claude-argv.test.mjs`
  "a logical engine session id maps to a deterministic Claude session UUID".
- **WP4e (2026-10-26):** permission modes. `buildClaudeInvocation` returns `permissionMode`
  (`claudePermissionMode(req)`): `bypassPermissions` for `free` on a non-readOnly request, otherwise
  `default`; readOnly argv is identical in both modes. `claude-invocation.json` records
  `requestPermissionMode` and `permissionMode`. Conformance harness documents the mapping
  (`CLAUDE_PERMISSION_MODE_SETTINGS`, check `permission.mode_mapping`). Tests:
  `executor-claude-argv.test.mjs` (free/safe/absent, readOnly in free). Live #23 (1 call).

## What later work packages need

- **WP9b**
  - Use `createClaudeStubHarness()` and `createClaudeLiveHarness()` from `test/fixtures/executors/claude/harness.mjs`.
  - The kit's `runConformance` ignores a `workDir` option. Live cwds land in `os.tmpdir()` unless `TMPDIR` is set.
  - `mcp.delivery_bound` assumes prefix truncation. For spill-style clients it should accept "notice instead of content".
  - Flip `ARTIFACT_TOOL_NAME_MAPPINGS.claude.verified` (its type is literal `false`).
- **WP4c/retention**
  - `ownedSession {kind: "claude-session"}` must be deleted through the adapter's `deleteOwnedSession`. Consider adding an optional `deleteOwnedSession` to `WorkflowExecutor`.
  - Prune `stateDir/attempts`: done in WP18b (`revoked`, or `spawned` with the process gone, older
    than 7 days, with its `attempts/<hash>/` dir; on submit at most every 6 h and by
    `agent-workflow prune`).
    WP19 (review #2): a launched attempt's record (`spawned`) is not deleted but replaced by a compact tombstone (`agent-workflow-attempt-tombstone-v1`: attemptKey, no outcome: the adapter records none, finishedAt, prunedAt); reconcile reads it as `unknown` ("launched, record pruned"), never `absent`, and submit refuses that attemptKey, so an orphaned workflow never retries an attempt that already ran. Tombstones are never pruned; only `revoked` (never-launched) records are removed.
- **WP10**
  - `web_search`/`fetch_content` → `WebSearch`/`WebFetch` (pre-allowed, `safetyPolicy: unknown`).
  - `ls` maps to `Glob`.
  - Write stages need worktrees (D2). Edits go through the approval channel, so non-interactive runs deny them unless `allowKinds` includes `edit`.
  - Same-session repair must keep the cwd.
- **WP11**
  - Module `@agwab/agent-workflow/executors/claude` with the config above.
  - Live checks need the real HOME (the CLI owns the login).
  - Show `probe().auth` and the version note.
  - Pass `probe().mcpOutputLimitChars` to the artifact server spec (done by the engine since WP5b).
