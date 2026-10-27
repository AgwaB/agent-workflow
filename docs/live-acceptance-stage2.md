# Live bundle 4: stage-2 host acceptance (Claude Code, Codex, Pi as hosts)

Stage-2 plan WP14/WP15/WP16 live checks and WP18 (nesting and concurrency), plus the three stage-1
leftovers (worker artifact tool names, D3 session cleanup with the real CLIs, Codex usage model).
A domain verdict (`NEEDS_WORK`, `PARTIAL_REVIEW`, …) counts as **completed**, as in
[stage 1](live-acceptance-stage1.md). Quality is not compared.

- Date: 2026-10-27. Branch `live4-host-acceptance` from main `a6bdcae`; fix `91dc66a`.
- Hosts: Claude Code 2.1.310 (`claude -p --model haiku`), codex-cli 0.159.2, Pi 1.1.0. Real HOME and
  real logins. Permission mode default (`free`). The parent shell's `PI_*` variables (model and
  provider of the session that drove this bundle) were removed from every spawned host.
- Plugin: `node tools/release/plugins.mjs dev /tmp/aw-live4/plugin --force` (server command
  `<node> <HOME>/agent-workflow-live4/src/mcp/host-server/bin.mjs --host claude-code|codex`). Claude
  Code took `--plugin-dir /tmp/aw-live4/plugin/plugins/agent-workflow` (the plugin directory inside
  the generated marketplace root; the root itself holds no `.claude-plugin/plugin.json`).
- Target: `/tmp/aw-live4/<case>/` = `package.json`, `tsconfig.json`, `src/` of
  `internal/raw-recordings/projects/deep-review/` plus the bundled `scout.md` as a project agent
  (legacy `~/.pi/agent/agents/scout.md` would shadow it, stage-1 open problem 2), `git init` and one
  commit. Task: "Review src/workflow-stop.ts, src/workflow-cancellation.ts and
  src/workflow-terminal.ts for correctness and reliability defects in stop/cancel handling."
- Evidence: `test/fixtures/live4/<case>/` — `host-result.json` (host tool calls, what the model saw,
  host usage) or `cli-result.json`, `capability-preview.txt`, `inspect.txt`, `status.json`,
  `summary.json` (executor and source, task summary, usage roll-up, final verdict, models and tool
  names per worker from the raw streams); `d3/` and `c2-codex-host-plugin-offline/` as described
  below. Scrubbed: `<HOME>`, `/private/tmp` → `/tmp`; no account ids, credit numbers or transcripts.

## Blocker: Codex weekly limit

At 15:48:43Z, during case 4a, a Codex worker got `429 Too Many Requests` ("exceeded retry limit").
`codex app-server` `account/rateLimits/read` (no model call) then reported
`ordinaryUsageAllowed: false`, `rateLimitReachedType: rate_limit_reached`, the 7-day window at
100 % until **2026-11-02T06:10Z**, and `credits.hasCredits: true`; the credit balance kept
decreasing, also while none of these runs used OpenAI. From then on every Codex model call of this
account draws on credits (the engine's retry of that task 15 min later succeeded). Paid credit use
is not part of the approval, so **no further Codex model call was made**: case 2 (Codex host → codex
workers) and case 4b (Codex host → claude workers) ran offline only (plugin install, skills, tools,
server cwd; no `codex exec`), and the concurrency case ran on Claude instead of Codex (below).
Evidence: `test/fixtures/live4/c4a-claude-host-codex-workers/codex-rate-limit.txt`.

## Results per case

| # | Case | Result | Run id | Executor (source) | Verdict | Tasks | Wall |
|---|---|---|---|---|---|---|---|
| 1 | Claude Code host → claude workers | **completed** | `workflow_mvquw71p_ebc65b` | `claude` (`host-default`, host `claude-code`) | `NEEDS_WORK` (3 findings) | 13/13 | 80 s (host turn 86 s) |
| 2 | Codex host → codex workers | **not run live** (Codex limit); offline: plugin installed in the real Codex, 3 skills and 8 tools listed, server started in the target dir with `--host codex`; config restored byte-identical | — | — | — | — | — |
| 3 | Pi host → pi workers | **completed** | `workflow_mvqvdiwl_0a0742` | `pi` (`host-default`, host `pi`) | `NEEDS_WORK` (7 findings) | 18/18 | 487 s |
| 4a | Claude Code host → codex workers | **completed** (domain verdict; run `failed` by `support_declared_failed`) after the host stopped waiting | `workflow_mvqv0cco_0f069a` | `codex` (`run-flag`) | `PARTIAL_REVIEW` (0 kept, 2 needs-human) | 11/12 | 982 s (host turn 518 s) |
| 4b | Codex host → claude workers | **not run live** (Codex host needs a Codex model turn; limit) | — | — | — | — | — |
| 5 | 3 concurrent CLI runs | **completed ×3 on `--executor claude --model haiku`** (substitute; Codex not run: limit) | `workflow_mvqvrclz_3beec8`, `workflow_mvqvrcma_071d40`, `workflow_mvqvrcgf_b9b768` | `claude` (`run-flag`) | `NEEDS_WORK` ×3 | 18/18, 18/18, 16/16 | 140 s, 152 s, 127 s |
| 6 | Stage-1 leftovers | tool names verified on Claude, Pi and Codex workers; **D3 bug found on Claude and fixed** (`91dc66a`, retry `workflow_mvqw6utn_5f5573` clean); Codex usage records `model` | — | — | — | — | — |
| 7 | Duplicate guard | the host model did not retry; an identical `workflow_run` sent by a direct stdio MCP client (no model) while run 1 was active returned `outcome: "existing"` | `workflow_mvquw71p_ebc65b` | — | — | — | — |

### Case 1: Claude Code host → claude workers

`claude -p --model haiku --plugin-dir /tmp/aw-live4/plugin/plugins/agent-workflow --permission-mode
default --allowedTools <the 8 plugin tools> --output-format stream-json --verbose "<prompt>"` in the
target. The prompt asked for `deep-review` with the task and `model: "haiku"`, `workflow_wait`
until terminal, then the verdict and report path verbatim.

- `init`: cwd `/tmp/aw-live4/c1-claude-claude`, server `plugin:agent-workflow:agent-workflow`
  `connected` (source `plugin`), skills `agent-workflow:agent-workflow`,
  `agent-workflow:execution-router`, `agent-workflow:workflow-guide`; tools
  `mcp__plugin_agent-workflow_agent-workflow__workflow_{dynamic,inspect,list,run,status,stop,validate,wait}`.
- **Exact calls:** `ToolSearch {"query":"select:mcp__plugin_agent-workflow_agent-workflow__workflow_run,mcp__plugin_agent-workflow_agent-workflow__workflow_wait"}`
  (Claude Code defers MCP tool schemas; `ToolSearch` needed no permission entry), then
  `mcp__plugin_agent-workflow_agent-workflow__workflow_run {"workflow":"deep-review","task":"…","model":"haiku"}`
  and `mcp__plugin_agent-workflow_agent-workflow__workflow_wait {"runId":"workflow_mvquw71p_ebc65b"}`
  twice (45 s, then terminal). No `permission_denials`.
- **What the model saw: `structuredContent`.** Every agent-workflow `tool_result` was the
  serialized JSON `{"action":…,"ok":…,"outcome":…,"data":{…},"text":…,"next":…}`, not the `content`
  text. The handler text and the next-step line reach the model inside it.
- **Server cwd = target:** `run.cwd` `/tmp/aw-live4/c1-claude-claude`, run store
  `<target>/.agent-workflow/workflows/…`; report path quoted by the host:
  `.agent-workflow/workflows/workflow_mvquw71p_ebc65b/tasks/task-8/final-report.md`.
- **Executor:** `{"id":"claude","source":"host-default","host":"claude-code"}` in the launch result
  and the run record. Workers: `claude-haiku-5-5` in all 7 raw streams.
- Host answer: verdict `NEEDS_WORK` and the result preview quoted verbatim, then the report path.
- Duplicate guard (case 7): `test/fixtures/live4/c1-claude-host-claude-workers/host-result.json`
  `duplicateGuardProbe`: `isError: false`, `outcome: "existing"`, `duplicateOf`
  `workflow_mvquw71p_ebc65b`, text "Duplicate launch guard: run workflow_mvquw71p_ebc65b is already
  active with the same workflow, task, inputs and options (running, started 50s ago)."
- Elicitation was not exercised: no launch needed a confirmation in `free` mode.

### Case 2 and 4b: Codex host (offline part)

Approved temporary change, in the real `~/.codex`: backup of `config.toml` (SHA-256 `704a2c61…`),
`codex plugin marketplace add /tmp/aw-live4/plugin`, `codex plugin add agent-workflow@agent-workflow`
(installed into `<HOME>/.codex/plugins/cache/agent-workflow/agent-workflow/0.1.0`). Then, without a
model turn, `codex app-server` in `/tmp/aw-live4/c2-codex-codex`: `initialize` →
`thread/start {cwd, ephemeral: true}` → `skills/list` → `mcpServerStatus/list`
(`c2-codex-host-plugin-offline/appserver-probe.json`):

- skills `agent-workflow:agent-workflow`, `agent-workflow:execution-router`,
  `agent-workflow:workflow-guide`;
- server `agent-workflow` with tools `workflow_dynamic, workflow_inspect, workflow_list,
  workflow_run, workflow_status, workflow_stop, workflow_validate, workflow_wait` (the model-facing
  name `mcp__agent-workflow__workflow_run` was not observed: no model turn);
- the server process `<node> …/host-server/bin.mjs --host codex` had cwd
  `/tmp/aw-live4/c2-codex-codex` (`lsof`), i.e. the thread's cwd.

Not verified live: the exact tool names in a Codex model turn, `content` vs `structuredContent`,
the executor `codex` `host-default` (unit test `core-wp17-default-executor.test.mjs` "host default:
Claude Code → claude, Codex → codex, Pi → pi"), Codex-host nesting and auth conflicts.

**Config restore proof** (`c2-codex-host-plugin-offline/config-restore-proof.txt`): after the
install `diff` showed exactly `[marketplaces.agent-workflow]` and
`[plugins."agent-workflow@agent-workflow"] enabled = true`; after `codex plugin remove
agent-workflow@agent-workflow` and `codex plugin marketplace remove agent-workflow` one entry was
left, `[projects."/private/tmp/aw-live4/c2-codex-codex"] trust_level = "trusted"`, written by the
probe's `thread/start`. The backup was copied back: `diff` exit 0, `cmp` byte-identical, both
SHA-256 `704a2c61c9249f7bbd1dd0e3df29301a04e2ae7afb52d4a2429315c543efb069`, no
`agent-workflow`/`aw-live4` line, `codex plugin marketplace list`, `plugin list` and `mcp list` show
no agent-workflow entry. The cache dir `<HOME>/.codex/plugins/cache/agent-workflow/` (created by
`plugin add`) was removed. The Codex worker threads of case 4a did not touch `config.toml` (`cmp`
against the backup was clean before the install).

### Case 3: Pi host → pi workers

`pi --mode rpc --no-session -e <HOME>/agent-workflow-live4/dist/hosts/pi/index.js` in the target
(the user's other Pi extensions loaded too), one RPC `prompt` `/aw run deep-review "<task>"`; no
parent model turn (records: `response`, `extension_ui_request`, one custom `message_start/end`).

- Launch notification: capability preview (accepted; `readOnly` emulated by the Pi executor),
  "Workflow started: deep-review", run `workflow_mvqvdiwl_0a0742`.
- **Status line** (`setStatus`, key `agent-workflow`): `aw: deep-review 0/8 running` → `2/11` →
  `3/11` → `4/11` → `7/18` → … → `16/18 running` → cleared (11 texts, then `undefined`).
- **One completion message** (`customType: "agent-workflow-completion"`, `display: true`, exactly 1)
  at 16:06:09Z: "**Workflow completed: deep-review** … (18/18 completed, 0 failed, 0 interrupted) …
  Reports: Final report: .agent-workflow/workflows/workflow_mvqvdiwl_0a0742/tasks/task-8/final-report.md",
  result preview `Verdict: **NEEDS_WORK**` with 7 kept findings; `details` status `completed`.
- `/aw logs workflow_mvqvdiwl_0a0742` → "Logs: deep-review (completed)" with task tails;
  `/aw status …` → "Status: completed, Progress: 18/18".
- Executor `{"id":"pi","source":"host-default","host":"pi"}`; workers ran Pi's default model
  `openai-codex/gpt-6.1-sol` with Pi's default thinking `xhigh` (12 model tasks).
- The Pi `openai-codex` provider was not rate limited during this run.

### Case 4a: Claude Code host → codex workers

Same Claude command; the prompt named `executor: "codex"`, `model: "gpt-5.6-luna"`, `effort: "low"`.
Calls: `ToolSearch`, `…__workflow_run {"workflow":"deep-review","task":"…","executor":"codex","model":"gpt-5.6-luna","effort":"low"}`,
10 × `…__workflow_wait`, `…__workflow_inspect`, `…__workflow_wait` — all seen as `structuredContent`.
Executor `{"id":"codex","source":"run-flag"}`; every worker turn `gpt-5.6-luna`/`low`.

Task 12 (`devil-advocate.finding-002`): its first attempt's control failed the schema (model), the
output retry hit the Codex 429 above, and the engine scheduled a launch retry with
`retryAfterMs: 900000`. The haiku host waited about 8.5 min, then answered that the run was still
running and named the retry time (16:03:44Z), without a verdict. The detached supervisor kept going:
the retry completed, the run ended at 16:04:09Z with `PARTIAL_REVIEW` (two findings routed to
needs-human for incomplete reviewer source coverage) and the supervisor exited. No auth or session
conflict between the Claude host and the Codex workers was seen; the 429 is the account limit.

### Case 5: concurrency (substitute on Claude)

`agent-workflow run deep-review --executor claude --model haiku --json -- "<task>"` started in three
targets within 0.2 s (16:08:47Z). All three completed (`NEEDS_WORK`); peak 13 concurrent Claude
worker processes (37 model attempts in total). No auth, token-refresh, lock or rate-limit error in
any worker stderr or result; 3 output retries (schema repairs, model). Wall 127–152 s against 118 s
for a single run (case 6 retry). The Codex variant (token-refresh contention, the stage-1 open
question) was not run: limit.

### Case 6: stage-1 leftovers

- **Worker artifact MCP tool, exact names:** Claude workers call
  `mcp__workflow_artifact__workflow_artifact` (`report.main` in runs 1, 5 ×3 and the retry); Pi
  workers call `mcp__workflow_artifact__workflow_artifact` (run 3); Codex reports an `mcpToolCall`
  item with server `workflow_artifact`, tool `workflow_artifact` (run 4a). Repository reads used
  `Read`/`Grep`/`Glob` (Claude), `read`/`grep`/`find`/`ls` (Pi) and `commandExecution` (Codex).
- **D3, Claude:** after runs 1 and 4a the only `<HOME>/.claude/projects` entries for these targets
  were the two hosts' own `claude -p` sessions (`<session_id>.jsonl` = the stream's `session_id`, and
  an empty `memory/`). After the three concurrent runs, **7 worker directories**
  `<uuid>/tool-results/toolu_*.txt` were left in three new project dirs: every worker that spilled a
  tool result (2 + 3 + 2) left it, although the attempt records say `keepSession: false`
  (`d3/claude-projects-before-fix.txt`). Cause and fix below (F1). Retry run
  `workflow_mvqw6utn_5f5573` after the fix: 2 workers spilled, no project dir was left
  (`d3/after-fix.txt`). No worker `<uuid>.jsonl` transcript was ever written.
- **D3, Codex:** all 8 worker `thread/start` requests of run 4a had `ephemeral: true`; no thread
  ownership record (`executors/codex/sessions` 0) and no rollout for the targets under
  `<HOME>/.codex/sessions` (`d3/codex-pi.txt`).
- **D3, Pi:** workers ran `--no-session`; `executors/pi/sessions` unchanged (73, all from live 3),
  no `<HOME>/.pi/agent/sessions` entry for the targets.
- **Codex usage records `model`:** task usage of run 4a has `model: "gpt-5.6-luna"`,
  `thinking: "low"`, `costUsd: null`; raw usage events carry `"model":"gpt-5.6-luna","cost":null`.

## Bugs found and fixed

| # | Run(s) | Classification | Evidence | Fix |
|---|---|---|---|---|
| F1 | 5 ×3 (`workflow_mvqvrclz_3beec8`, `workflow_mvqvrcma_071d40`, `workflow_mvqvrcgf_b9b768`) | **adapter bug** (Claude, D3) | 7 `<HOME>/.claude/projects/<slug>/<uuid>/tool-results/` dirs left; the files were written 11–17 s before each attempt completed. The Claude adapter emits the terminal event at the stream's `result` line and removed the spill fire-and-forget in the child's `close` handler; the durable worker commits the terminal result and calls `process.exit`, cutting the removal | `91dc66a`: a non-kept session's `completed`/`failed` event is held until `close`, the removal is awaited, then the event is delivered. Regression test `executor-claude-sessions.test.mjs` "… gone before the terminal event (D3, live 4)" (failed before the fix). Change log in `docs/executors/claude.md`. Retry `workflow_mvqw6utn_5f5573`: clean |

Not bugs: the domain verdicts; output retries (schema repairs); the Codex 429 (account limit). The
fix commit passed `npm run validate` (no live run was active while it rebuilt `dist/`).

## Live-call ledger (7 workflow runs of ≤ 15)

| # | Case | Host (model) | Workers (model) | Run id | Duration | Input (excl. cache) | Cache read | Cache write | Output | Cost (as reported) | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | Claude Code (`claude-haiku-5-5`) | claude (`claude-haiku-5-5`) | `workflow_mvquw71p_ebc65b` | 80 s run, 86 s host | 50 | 209,603 | 50,770 | 24,454 | workers $0.0245, host $0.0071 (notional) | completed / NEEDS_WORK |
| 2 | 4a | Claude Code (`claude-haiku-5-5`) | codex (`gpt-5.6-luna`, low) | `workflow_mvqv0cco_0f069a` | 982 s run, 518 s host | 68,413 | 213,376 | 0 | 4,724 | workers not reported (`null`), host $0.0140 (notional) | failed / PARTIAL_REVIEW (domain); 1 task hit the 429 |
| 3 | 3 | Pi (no model turn) | pi (`openai-codex/gpt-6.1-sol`, xhigh) | `workflow_mvqvdiwl_0a0742` | 487 s | 244,503 | 761,600 | 0 | 33,464 | $0.900 Pi catalog estimate | completed / NEEDS_WORK |
| 4 | 5 | CLI | claude (`claude-haiku-5-5`) | `workflow_mvqvrclz_3beec8` | 140 s | 88 | 384,251 | 103,349 | 48,177 | $0.0486 notional | completed / NEEDS_WORK |
| 5 | 5 | CLI | claude (`claude-haiku-5-5`) | `workflow_mvqvrcma_071d40` | 152 s | 104 | 469,194 | 104,326 | 47,804 | $0.0495 notional | completed / NEEDS_WORK |
| 6 | 5 | CLI | claude (`claude-haiku-5-5`) | `workflow_mvqvrcgf_b9b768` | 127 s | 72 | 328,211 | 90,932 | 41,585 | $0.0423 notional | completed / NEEDS_WORK |
| 7 | 6 (retry after F1) | CLI | claude (`claude-haiku-5-5`) | `workflow_mvqw6utn_5f5573` | 118 s | 82 | 359,589 | 98,958 | 44,455 | $0.0456 notional | completed / NEEDS_WORK |

Usage is the run record's task roll-up (normalized: input excludes cache reads and writes). Run 2's
roll-up covers the 5 tasks that reported usage; the 429 attempt reported none. Host usage from the
`claude -p` result: run 1 input 10, cache read 145,569, cache write 25,506, output 1,181; run 2
input 30, cache read 567,411, cache write 34,077, output 2,922. No `codex exec` was started.

| CLI | Runs | Cost |
|---|---|---|
| Claude Code (hosts + workers) | 2 host turns, 6 worker runs | $0.232 notional `total_cost_usd` (subscription): hosts $0.021, workers $0.211 |
| Codex | 1 worker run (case 4a) | not reported; 286,513 tokens; the calls after 15:48Z ran past the weekly limit (credits) |
| Pi | 1 worker run | $0.900 Pi catalog estimate (ChatGPT subscription) |

## Open problems

1. **Codex host and Codex concurrency are unverified live** (cases 2, 4b, 5-on-Codex): rerun after
   the limit resets (2026-11-02T06:10Z) or with approval to use credits: `codex exec` with the
   temporary plugin (tool names in a model turn, `content` vs `structuredContent`, `host-default`
   codex), Codex host → claude workers, three concurrent Codex runs (token refresh).
2. **Claude Code shows `structuredContent`, not `content`.** The model gets the whole
   `{action, ok, outcome, data, text, next}` JSON, so every result carries the data twice (structured
   and in `text`). It worked, but a large `data` (wait results, inspect) costs host context.
3. **Long engine backoff vs. host patience.** A rate-limit launch retry waits 15 min
   (`retryAfterMs: 900000`); the haiku host stopped after ~8.5 min of `workflow_wait`. MCP hosts get
   no completion delivery, so the user learns the result only by asking again.
4. **CLI text uses pi-workflow hints.** `agent-workflow status` prints `Open: /workflow <run>`,
   `Resume: /workflow resume <run>` and "inspect /workflow logs <run>"; only the Pi host rewrites
   them (the MCP texts seen here had none).
5. **False stall warning during a scheduled retry.** `status` showed "⚠ no task progress for 14m
   (heartbeat alive — possible stall)" while the only open task was waiting for its retry time.
6. **Pi completion message "Verdict: completed"** is the run's semantic status; the report verdict
   (`NEEDS_WORK`) appears only in the preview below it.
7. **Codex `thread/start` trusts the project in the user config.** The documented app-server probe
   (`docs/plugins.md`) wrote `[projects."<cwd>"] trust_level = "trusted"` into the real
   `config.toml`; use a throw-away `CODEX_HOME` or restore the file. The adapter's worker threads did
   not write it.
8. Still open from stage 1: a domain verdict fails the run (`support_declared_failed`, case 4a);
   Claude adapter attempt records are not pruned (`executors/claude/attempts` 56 → 112).
