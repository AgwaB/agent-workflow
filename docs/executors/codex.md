# Codex executor adapter (WP7)

Entry point: `@agwab/agent-workflow/executors/codex` (source `src/executors/codex/`). Descriptor
convention: `createExecutor(config)`; descriptor
`{ id: "codex", version: "0.1.0", contractVersion: "0.1.0", module: "@agwab/agent-workflow/executors/codex", config: {} }`.

Verified against **codex-cli 0.159.2** (ChatGPT login) on 2026-10-26 with 18 live model calls
(log: `test/fixtures/executors/codex/live-calls.md`). Model for every recording: `gpt-5.6-luna`,
effort `low` (cheapest tier listed by `model/list`; the CLI reports no prices).

## Transport: `codex app-server`

One `codex app-server` process (JSON-RPC 2.0 over stdio, newline-delimited) per attempt.

- Protocol source: `codex app-server generate-ts` / `generate-json-schema` from 0.159.2, plus live
  traffic. Message shapes follow openai/codex-plugin-cc `app-server.mjs` (Apache-2.0); no code was
  copied, so no NOTICE entry is needed.
- Why not `codex exec --json`: app-server gives everything the contract needs in one process —
  `thread/start` overrides (sandbox, approval routing, per-thread config), approval requests as
  server→client requests, `turn/interrupt`, `thread/resume`/`thread/delete`, per-thread MCP status,
  token usage notifications. Nothing forced a fallback.
- Lines are split on `\n` only. `node:readline` also splits on U+2028/U+2029, which Codex emits
  unescaped inside JSON strings (live call #6 web results); that bug was found live and is covered
  by a unit test.

Sequence (request ids are fixed, which the replay fixtures rely on):

1. `authority.consume()` — immediately before the spawn (R#1). Revoked → `AUTHORITY_REVOKED`, no
   process. Released → durable record `consumed`, then spawn.
2. spawn `codex -c log_dir="<stateDir>/attempts/<digest>.log" app-server` (cwd = request cwd, env =
   process env + `req.env`). `log_dir` keeps CLI logs per attempt (0.159.2 writes nothing there for
   app-server) and puts the attempt digest on argv, which the conformance harness uses to count
   launches. Nothing else is on argv.
3. `initialize` (`clientInfo.name = agent_workflow`, opt-out of reasoning deltas, output deltas and
   account/remote-control notifications) → `initialized`.
4. `config/read {cwd}` (isolation only): names of the user's MCP servers, kept in memory only.
5. `thread/start` (or `thread/resume {threadId}` for `resumeSessionId`):
   `{cwd, model, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox, serviceTier: null,
   developerInstructions: systemPrompt, ephemeral: !keptSession, config}`.
6. Isolation guard: `mcpServerStatus/list {threadId, detail: "toolsAndAuthOnly"}`; any server with
   tools that the request did not inject fails the attempt (`config`) before a turn starts.
7. `turn/start {threadId, input: [{type: "text", text: prompt}], model, effort}`.
8. Notifications → events until `turn/completed`; then stdin is closed (the server exits on EOF;
   SIGKILL after 3 s).

`submit` returns after step 7 (or after a failure, reported as a `failed` event), so the ExecRef can
carry the thread id of a kept session.

### Flags and overrides, and why

| Setting | Value | Why |
|---|---|---|
| `sandbox` | `read-only` when `readOnly` or only read tools; `workspace-write` when a write/exec tool is requested or `tools` is empty on a writable stage | coarse tool mapping (below); never `danger-full-access` (D2). The user's config here defaults to `danger-full-access` + `never`, so the override is required |
| `approvalPolicy` | `on-request` | escalations reach the engine as approval requests (R#4) |
| `approvalsReviewer` | `user` | the user's config may route approvals to `auto_review`/guardian, which would auto-decide (D2) |
| `serviceTier` | `null` (standard) | `fastTier` is not offered; the user's config here selects `priority` |
| `ephemeral` | true unless `sessionId`/`resumeSessionId` | D3: no rollout on disk by default |
| `developerInstructions` | `systemPrompt` | appended developer message (verified live #17); `baseInstructions` would replace Codex's own agent prompt |
| config `web_search` | `live` if `web_search`/`fetch_content` requested, else `disabled` | C2 |
| config `tool_output_token_limit` | 10000 (adapter config) | pins the C1 output cap independent of the model catalog |
| config `features.multi_agent` | false | worker sub-agents would be model calls outside the engine's slots |
| config `mcp_servers.<name>.{command,args,env,enabled,tool_timeout_sec,startup_timeout_sec}` | per injected server; timeouts 300 s / 30 s (adapter config) | MCP injection over stdin; env values never on argv |
| `effort` | `req.effort` when set | when unset, the user's `model_reasoning_effort` applies (profiles should always set it) |

## Isolation (B5)

With `isolation.inherit = false` the thread config adds:

`project_doc_max_bytes = 0`, `skills.include_instructions = false`, `features.plugins = false`,
`features.apps = false`, `features.hooks = false`, `features.memories = false`,
`include_apps_instructions = false`, `history.persistence = "none"`, `notify = []`, and
`mcp_servers.<user server>.enabled = false` for every server `config/read` lists.

- Login is untouched: `CODEX_HOME` is never relocated, no credential file is read.
- Per-server `-c mcp_servers.X.enabled=false` on argv fails in app-server 0.159.2 ("invalid
  transport in `mcp_servers.aside`": the override layer is validated alone); the same keys in the
  `thread/start` config work. `-c mcp_servers={}` merges instead of replacing.

Evidence:

- `codex debug prompt-input` (no model) with these keys: the skills block, recommended plugins and
  apps instructions and the project `AGENTS.md` disappear.
- `thread/start` returns `instructionSources: ["<HOME>/.codex/AGENTS.md"]` with a project
  `AGENTS.md` present (project file not loaded).
- `mcpServerStatus/list` for the thread: every user server at 0 tools, `codex_apps` absent.
- Live #1 and kit `live.isolation` (#13): a marker demanded by the project `AGENTS.md`/`CLAUDE.md`
  never appears.

Residuals (why `contextIsolation` is `emulated`, not `native`):

1. `$CODEX_HOME/AGENTS.md` (global user instructions) is always loaded; no config key in 0.159.2
   disables it short of relocating `CODEX_HOME`, which would need the credentials copied (D1).
2. `~/.codex/rules/*.rules` exec-policy rules still apply. The permissions prompt lists the user's
   prefix rules, and a command matching an `allow` rule runs outside the sandbox without an
   approval request. This is a **D2 gap** for workers; open problem below.
3. Codex's built-in collaboration/multi-agent role blocks remain (product prompt, not user context).

## Environment probe (WP4d)

`probe()` also inspects `$CODEX_HOME` (default `~/.codex`; `src/executors/codex/environment.ts`). It
opens only `rules/*.rules` and `AGENTS.md`, never `auth.json` or other credential files (D1).

| Finding | Probe capability row | Negotiation |
|---|---|---|
| `rules/*.rules` with N > 0 `decision = "allow"` rules | `readOnly = { level: "emulated", source: "probed", warning: "N allow rules in <CODEX_HOME>/rules let matching commands run without approval" }` | readOnly stages degrade (`CAPABILITY_WARNING:readOnly`); interactive → confirm; strict `readOnly` → refuse |
| no allow rules | (row not returned; declared `readOnly: native` stays) | native |
| `AGENTS.md` exists and is non-empty | `contextIsolation = { level: "emulated", source: "probed", warning: "global <CODEX_HOME>/AGENTS.md is loaded into every Codex worker" }` | every non-`inherit` stage degrades (`CAPABILITY_WARNING:contextIsolation`); strict → refuse |
| `AGENTS.md` absent or whitespace-only | `contextIsolation = { level: "native", source: "probed" }` | native |

- Owner decisions "Codex allow 규칙" (run but warn; strict refuses) and "Codex 전역 AGENTS.md" (show only
  when the file exists).
- Rules are counted with a small Starlark tokenizer: `decision = "allow"` / `'allow'` / `r"allow"`
  keyword arguments only; comments, other decisions and strings that merely contain `decision="allow"`
  are not counted. Only the count and paths are recorded, never rule patterns or file contents. Probe
  notes: `exec-policy rules: N allow rules in F files under <path>`, `global instructions: <path>
  present|absent|empty`, and unreadable paths if any.
- This machine (2026-10-26, codex-cli 0.159.2): 151 allow rules in 1 file; global `AGENTS.md` present.
  So Codex readOnly stages and every isolated stage run degraded (recorded; confirmed on interactive
  hosts) unless a strict profile refuses them.

## Tool mapping (Pi name → Codex)

| Pi tool | Mapping | Codex tool | Verified live |
|---|---|---|---|
| `read` | sandbox `read-only` | shell (`cat`, `sed`) | yes (#1: `cat a.txt`, read action) |
| `grep` | sandbox `read-only` | shell (`rg`/`grep`) | no |
| `find` | sandbox `read-only` | shell (`rg --files`/`find`) | no |
| `ls` | sandbox `read-only` | shell (`ls`) | no |
| `bash` | sandbox `workspace-write` | shell (`exec_command`) | yes (#12 blocked → approval → denied; #18 ran) |
| `edit` | sandbox `workspace-write` | `apply_patch` | yes (#18) |
| `write` | sandbox `workspace-write` | `apply_patch` | yes (#18) |
| `web_search` | tool `web_search` (`web_search = "live"`) | hosted web search | yes (#6) |
| `fetch_content` | tool `web_search` | hosted web search `open_page`/`find_in_page` actions | no |
| `workflow_artifact` | MCP `workflow_artifact`/`workflow_artifact` | `mcp__workflow_artifact__workflow_artifact` | yes (#2) |

`toolAllowlist` is `coarse`: Codex has no per-tool allowlist. Any other tool name is refused with
`INVALID_REQUEST` before consume (B4 decides earlier from `CODEX_TOOL_MAPPING`).

## MCP injection

- Method: dotted keys in the `thread/start` `config` (stdin), e.g.
  `"mcp_servers.workflow_artifact.command"`, `.args`, `.env` (values), `.enabled`,
  `.tool_timeout_sec`, `.startup_timeout_sec`. Live #2: the stub server received its env variable,
  argv carried only the script path.
- Visible tool name: **`mcp__workflow_artifact__workflow_artifact`** (live #2: the model called it by
  that name; `non_prefixed_mcp_tool_names` is off by default in 0.159.2). The WP5 table
  (`src/mcp/visible-names.ts`) still says `verified: false`; flipping it belongs to the MCP owner.
- Output limit: Codex truncates tool output to `tool_output_token_limit` tokens, estimating 4 bytes
  per token. Live #2: a 60,008-char result was cut with `Warning: truncated output (original token
  count: 15002)` (= 60,008 / 4) and head and tail kept, so the delivered bound is about 40,000
  bytes at the pinned 10,000-token limit. `probe().mcpOutputLimitChars = 32000` (20 % headroom;
  the WP5 server checks UTF-16 length and UTF-8 bytes). Hosts should launch the artifact server
  with `artifactMcpServerSpecWithOutputLimit(config, probe.mcpOutputLimitChars)`.
- Tool timeout: `tool_timeout_sec` per server is honored (2 s → "timed out awaiting tools/call
  after 2s", measured offline with `mcpServer/tool/call`); with no value, a direct call did not time
  out within 200 s. The adapter sets 300 s.
- Normalized `tool_call.output` is clipped at 16,384 chars with a note; the raw transcript keeps the
  full result. The kit's `mcp.delivery_bound` therefore passes on the event view; the real model
  bound is the one above.

## Events

| app-server | ExecEvent |
|---|---|
| thread started | `started {sessionId: threadId}` |
| `item/agentMessage/delta` | `message_delta` |
| `item/started`/`item/completed` `commandExecution` | `tool_call shell`, kind from `commandActions` (read/listFiles → read, search → search, else execute), status inProgress→running, completed (non-zero exit → failed), failed, declined→denied |
| `fileChange` | `tool_call apply_patch`, kind edit (all deletes → delete) |
| `mcpToolCall` | `tool_call mcp__<server>__<tool>`, kind read for the artifact tool or `readOnlyHint`, else other |
| `webSearch` | `tool_call web_search`, kind fetch |
| `dynamicToolCall`, `imageView`, `collabAgentToolCall` | `tool_call` (other/read/other) |
| `thread/tokenUsage/updated` | one `usage` per turn: thread total minus the total before the turn's first request, keyed by `turnId` (`thread/resume` replays the previous turn's usage; live #16). `cost: null`, `source: "unknown"` |
| server request `item/commandExecution/requestApproval` | `approval_request` kind execute (fetch with a network context) |
| `item/fileChange/requestApproval`, `applyPatchApproval` | `approval_request` kind edit |
| `item/permissions/requestApproval` | `approval_request` (edit for file system, fetch for network) |
| `mcpServer/elicitation/request` | declined (no person behind a worker); `item/tool/requestUserInput` → empty answers |
| `turn/completed` completed / failed / interrupted | `completed {finalText}` (the `final_answer` message) / `failed` (classified) / `failed cancelled` |
| process exit before `turn/completed` | `failed` classified from the last error or stderr; `cancelled` after a cancel |

Raw stream: `<artifactsDir>/codex-app-server.jsonl` (`{at, dir: out|in|stderr|meta, msg}`), or
under the attempt log dir when no `artifactsDir` is given. Redacted there: MCP env values,
`config/read` (only server names), `mcpServerStatus/list` (names and tool counts), `account/*` and
`remoteControl/*` notifications.

## respond / cancel / reconcile / sessions

- `respond`: allow → `accept`, deny → `decline` (never `acceptForSession`); permissions requests get
  the requested permissions for the turn or none. Unanswered requests are denied when
  `approvalPolicy.timeoutMs` expires (fail closed). Unknown id → `unknown_request`; answered or
  resolved by the server (`serverRequest/resolved`) → `too_late`.
- `cancel`: `turn/interrupt` (live #5: `cancelled`, turn `interrupted` → `failed cancelled`). `owned`,
  or no turn yet: interrupt, then SIGTERM/SIGKILL the app-server. A cancel that loses the race to
  completion returns `too_late`; one that cannot be confirmed returns `uncertain`. Attempts owned by
  another process: `too_late` (terminal), `no_active` (owner gone) or `uncertain`.
- `reconcile`: durable records under `stateDir` (`$AGENT_WORKFLOW_HOME/executors/codex/attempts/`,
  `O_EXCL` create): none/revoked → `absent`; consumed without spawn → `unknown`; spawned/terminal →
  `found`. `sessionBound: true`, so the runtime never adopts a found attempt in another process.
  `observe` of an attempt owned by an earlier process replays its durable event log (and reports
  `failed unknown` when its app-server died without a terminal event).
- Sessions (D3): kept only when `sessionId`/`resumeSessionId` is set. Codex picks the thread id;
  `ExecRef.sessionId` and `ownedSession {kind: "codex-thread", locator: threadId}` carry it.
  `deleteOwnedSession(owned)` → `thread/delete` (live kit run: 2 deleted, 1 `not_found` for the
  already deleted resumed thread).

## Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Codex runs its own loop |
| sessionBound | true | — | one stdio connection owns the thread |
| mcpInjection | native | probed | #2, offline fake app-server check |
| readOnly | native | probed | #11, #12. `probe()` lowers it to emulated + warning when `allow` rules exist (WP4d) |
| toolAllowlist | native, coarse | probed | #12 (`tools: [read]` → read-only sandbox; `touch` denied) |
| systemPrompt | native, append | declared | #17 (`developerInstructions` honored) |
| modelSelect | native | probed | all calls (`x-codex-turn-metadata` model) |
| effortLevels | low, medium, high, xhigh, max, ultra | — | `model/list` union (Luna models stop at max) |
| resume | native, native | probed | kit `live.resume` (#15–16) |
| partialStream | native | probed | `item/agentMessage/delta` |
| usage | native, tokens | probed | every completed call; cost never reported |
| toolTelemetry | native | probed | #1, #2, #12, #18 |
| cancel | native, interrupt | probed | #5 |
| nativeSchema | none | declared | `turn/start.outputSchema` exists, SDK v0 `SubmitRequest` has no schema field |
| contextIsolation | emulated | probed | see Isolation; global `AGENTS.md` and exec-policy rules remain. `probe()` overrides it per machine (WP4d: native without a global `AGENTS.md`, emulated + warning with one) |
| fastTier | none | declared | standard tier forced (Pi-only feature, A2-4) |
| toolResultBudget | none | declared | C1 |
| webTools | native, search, safetyPolicy **unknown** | probed | #6; hosted search, credential-URL/redaction/budget controls unconfirmed (C2, plan §6.5) |

`probed` rows carry `verifiedWith: "codex-cli 0.159.2, WP7 live 2026-10-26"`. `probe()` notes a
different CLI version (F3: rerun the kit).

## Error classification

`codexErrorInfo` decides first (`src/executors/codex/errors.ts`), then the text table.

| Input | Class | Source |
|---|---|---|
| 400 `model_not_found` ("model is not supported…"), codexErrorInfo `other` | config | recorded #3 |
| 401 (`httpConnectionFailed{httpStatusCode: 401}`), "Missing bearer…" | auth | recorded #4 |
| interrupted turn / exit after cancel | cancelled | recorded #5 |
| `unauthorized`, "not logged in", "token expired" | auth | protocol / text |
| `usageLimitExceeded`, `rateLimitExceeded`, any HTTP 429, "rate limit" | rate_limit | protocol |
| `serverOverloaded`, `internalServerError`, `httpConnectionFailed`, `responseStream*`, `responseTooManyFailedAttempts`, `flexUnavailable`, 5xx, "connection reset", "stream disconnected" | transient | protocol |
| `contextWindowExceeded`, `sessionBudgetExceeded`, `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials`, `threadRollbackFailed` | permanent | protocol |
| `badRequest`, `sandboxError`, "failed to load configuration", "invalid transport", ENOENT / CLI missing, isolation guard | config | protocol / observed offline |
| anything else (incl. `other` without a matching text) | unknown | B3 |

Not reproducible safely: expired tokens, real rate limits, context overflow (protocol rows only).

## Concurrency

Three app-servers in parallel (#7–9): all completed, wall 5.2 s, no auth/refresh/lock messages in
any stderr. Token refresh did not happen during the test (fresh token), so refresh contention
between concurrent app-servers is **not** proven absent.

## Web tool

Live call #6 with `web_search = "live"`: one `webSearch` item (action `search`), the answer cited the Wikipedia
URL. `safetyPolicy: "unknown"` (owner decision Q2): the search is hosted, so private-IP/DNS
rebinding concerns do not apply locally, but credential-URL blocking, redaction and a character
budget are not confirmed. `fetch_content` (open_page) not observed.

## Tests

- Offline (`test/unit/executor-codex-conformance.test.mjs`): the full offline kit, 34/34 pass.
  Stub `codex` = `createStubCli` replaying `test/fixtures/executors/codex/recorded/*.jsonl` (complete,
  usage_unknown, slow, approval-deny, fail_auth, fail_config recorded; transient, rate_limit,
  permanent, unknown, crash_after_consume and the approval allow branch synthetic from the
  protocol). `mcp_tool` uses `fake-mcp-app-server.mjs`, which launches the injected server from the
  thread config like Codex. `crash_after_consume` uses the test-only `testFaults` config.
- Runtime tier (`executor-codex-runtime.test.mjs`): `runtime.durable_authority`,
  `runtime.detach_rediscovery`, `runtime.control_relay` pass with the adapter descriptor against
  the stub.
- Parser, error table, mapping, isolation config, redaction (`executor-codex-parser.test.mjs`,
  `executor-codex-config.test.mjs`); fixture scrub (`executor-codex-fixtures-scrub.test.mjs`).
- Live (`executor-codex-live.test.mjs`, `AGENT_WORKFLOW_LIVE=1`, real HOME): smoke + kit live tier,
  run once: 5/5 live checks pass (`readonly_enforced`, `tool_allowlist`, `isolation`,
  `session_ownership`, `resume`).

## Known limits

- Global `$CODEX_HOME/AGENTS.md` and `~/.codex/rules` cannot be disabled per run (see Isolation); since
  WP4d the probe reports them as warnings and negotiation records the degradation.
- `effort` falls back to the user's config when the request has none.
- Input tokens include cached tokens; output includes reasoning tokens.
- A user MCP server with the same name as an injected one merges keys (e.g. `url` + `command` →
  config failure).
- Attempt records and logs under `stateDir` are never pruned yet.
- `probe()` lists models with `codex debug models` (a debug subcommand; app-server `model/list`
  would need a second app-server spawn).
- `fetch_content`, `grep`, `find`, `ls` mappings and token-refresh contention are unverified.

## What later work packages need

- **WP9b**: use `createCodexStubHarness` / `createCodexLiveHarness`
  (`test/fixtures/executors/codex/harness.mjs`); flip `ARTIFACT_TOOL_NAME_MAPPINGS.codex.verified`
  (evidence: live #2); the kit's `live.isolation` only covers project files, so the global
  `AGENTS.md` residual needs its own row.
- **WP10**: Codex's web tool is `web_search` (request `tools: ["web_search"]`); prompts name the
  artifact tool `mcp__workflow_artifact__workflow_artifact`; precise tool lists degrade to the
  coarse sandbox (B4 `toolAllowlist.fine` → readOnly downgrade where allowed).
- **WP11 / WP4c**: launch the artifact server with `probe().mcpOutputLimitChars` (32000); always
  pass `effort`; keep secrets in `SubmitRequest.env`/`McpServerSpec.env`, never in descriptor
  config; prune should call `deleteOwnedSession` for `codex-thread` sessions (R#10) and sweep
  `stateDir`. The exec-policy-rules gap is decided (WP4d: accept and record with a warning; strict
  profiles refuse).

## Change log

- **WP4d (2026-10-26):** `probe()` returns `capabilities.readOnly` (emulated + warning when
  `$CODEX_HOME/rules/*.rules` has `allow` rules) and `capabilities.contextIsolation` (native without a
  global `AGENTS.md`, emulated + warning with a non-empty one), plus count/path notes; credential files
  are never read. Engine B4 negotiation turns these warnings into recorded degradations (see
  `docs/core-port.md` "WP4d"). Tests: `executor-codex-environment.test.mjs` (rule counting, temp
  `CODEX_HOME` with rules/`AGENTS.md` present/absent/empty and an unreadable `auth.json`, `probe()` over
  the stub CLI, engine `probeWorkflowExecutor` merge).
