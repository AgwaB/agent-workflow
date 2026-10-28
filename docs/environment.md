# Environment variables

Every `AGENT_WORKFLOW_*` variable that the package reads (`src/`), what it does and its default,
followed by the variables only the test suites and release tools read. Set user controls before you
start the CLI, the Pi host or a detached supervisor: child processes (durable workers, supervisors,
the artifact MCP server) inherit them. None of these variables grants a worker more tool authority or
weakens an evidence gate.

Boolean flags marked "flag" are on for `1`, `true`, `yes` or `on` (case-insensitive) and off
otherwise.

## Supported configuration

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_HOME` | Per-user directory: user workflows (`workflows/`), user agents (`agents/`), saved user profiles (`user-profiles/v1/profiles.json`), per-workflow profile preferences, executor state (`executors/<id>/`). | `~/.agent-workflow` |
| `AGENT_WORKFLOW_RUN_INDEX_DIR` | Directory of the runtime's run locator index (lets `status`/`wait` find a run by id from another process). | `~/.agent-workflow/run-index` |
| `AGENT_WORKFLOW_RUN_LOCATOR_PRUNE_AFTER_MS` | Age after which stale run locators are pruned from the index. | 30 days |
| `AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA` | `1`: reject a named workflow before launch when its prompt/schema diagnostics are strict-blocking (direct dynamic runs are excluded). Ordinary validation applies either way. | off |
| `AGENT_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS` | Tool-result budget for dynamic generated tasks (static stages keep their spec budgets). `0` or a negative value disables it. | `320000` |
| `AGENT_WORKFLOW_TOOL_EXPOSURE` | Pi host only (WP28): `deferred` registers the `aw_*` tools with deferred exposure, so they stay out of every model request until Pi's `tool_search` loads them (enable it with `"defaultTools": ["+tool_search"]`). Any other value: normal registration. Port of pi-workflow's `PI_WORKFLOW_TOOL_EXPOSURE`. The `/aw` command and the host MCP server are unaffected (Claude Code already loads MCP tool schemas on demand). | unset (normal) |

`PI_CODING_AGENT_DIR` (Pi's own variable) is honored only to locate the legacy Pi directory that
workflow and agent discovery reads **read-only** (default `~/.pi/agent`). agent-workflow never writes
there. Executor CLIs keep their own variables (`CODEX_HOME`, `ANTHROPIC_API_KEY`, …); see
[`executors/`](executors/).

## Operational limits

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES` | Positive cap on concurrent worker launches per process (launch gate). | `max(2, floor(cores / 2))` |
| `AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS` | Optional positive ceiling on live model workers. | unset (no ceiling) |
| `AGENT_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES` | Retries of a task after a transient model/executor failure (non-negative). | `5` |
| `AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES` | Retries of a task whose output fails the output contract (non-negative). | `2` |
| `AGENT_WORKFLOW_CANCEL_GRACE_MS` | Grace period between a cancel request and forced termination of a worker. | `10000` |
| `AGENT_WORKFLOW_HEARTBEAT_MS` | Durable worker heartbeat interval (minimum 50). | `5000` |
| `AGENT_WORKFLOW_CONTROL_POLL_MS` | Poll interval of the durable control mailbox (approval answers, cancel requests; minimum 5). | `50` |
| `AGENT_WORKFLOW_EVENT_READ_CACHE_MAX` | Entries in the run-event read cache (`0` disables it). | `64` |
| `AGENT_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS` | Delay before a launch slot is released after a launch. | `3000` (`250` with `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP`) |

Lower retries or higher concurrency trade reliability or quality for speed; they are not
recommended defaults.

## Worktree runtime artifacts

These belong to the managed-worktree implementation (write-capable stages), not to portable specs.

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_PRIVATE_RUNTIME_ARTIFACT_NAMES` | Comma-separated directory names (for example build outputs) that each worktree gets a private copy of. `0`/`false`/`off`/`none`/`no` disables. | `target` |
| `AGENT_WORKFLOW_CLONE_RUNTIME_ARTIFACT_DIRS` | Flag: clone those directories into new worktrees (copy-on-write `cp -c`). | off |
| `AGENT_WORKFLOW_ALLOW_FULL_RUNTIME_ARTIFACT_COPY` | Flag: fall back to a full copy when copy-on-write cloning fails. | off |

## Experimental (default off)

Flags. No general speed or quality claim is implied by any of them.

| Variable | What it does |
|---|---|
| `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP` | The artifact server suppresses an identical re-read (ledger row with `returnedBytes: 0`). An adapter that wants it must pass it in `McpServerSpec.env` ([`mcp.md`](mcp.md)). |
| `AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH` | Foreach prompts keep the item payload out of the instruction text (cache-stable prefix). |
| `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP` | Shorter launch-slot release delay. |
| `AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR` | Output repair retries continue the worker's kept session instead of a fresh attempt (untested live with Claude). The only setting that makes the engine request kept worker sessions (D3); without it no attempt keeps one. Kept sessions are released at task/run end ([`usage.md`](usage.md#run-records) "Worker sessions"). |
| `AGENT_WORKFLOW_PER_ITEM_DISPATCH` | Streaming foreach children whose projection is satisfiable from published partial output start per item. |
| `AGENT_WORKFLOW_ADAPTIVE_LIVE_WORKERS` | Adaptive live-worker limit (floor 4, ceiling `AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS` or 16). |

Defined but inactive (they enable no behavior): `AGENT_WORKFLOW_CACHE_SHAPE_METRICS`,
`AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER`.

## Internal (set by the engine or for integrations; leave unset)

| Variable | What it is |
|---|---|
| `AGENT_WORKFLOW_ROLE` | Process role: `supervisor` (default), `worker`, `disabled`. Workers get `worker`; `worker`/`disabled` processes may only `help`/`validate` and the Pi host registers no tools. |
| `AGENT_WORKFLOW_HOST_CONTEXT` | JSON host context (`version`, `cwd`, `homeDir`, `projectTrusted`) passed to headless children. |
| `AGENT_WORKFLOW_PARENT_SUBAGENT_CWD`, `_RUNS_DIR`, `_RUN_ID`, `_ATTEMPT_ID` | Identify the parent runtime attempt of a nested workflow so child events and usage are recorded on it. |
| `AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` | Barrier binding handed to a durable worker. |
| `AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON` | Env values (`SubmitRequest.env`, MCP server env) for a durable worker; removed from the worker's `process.env` at startup, never written to disk. |
| `AGENT_WORKFLOW_PI_RUN_SECRETS_JSON` | Secret part of the Pi executor's per-run config; deleted as soon as the in-Pi extension loads. |
| `AGENT_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256` | Lowercase SHA-256 of an external launch grant bound into launch provenance. |
| `AGENT_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT` | `1`: a launch without the grant digest fails. |
| `AGENT_WORKFLOW_CAPTURE_TOOL_CALLS` | Flag: record worker tool calls in launch provenance (diagnostics). |

`PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` (pi-subagent's name) is removed from worker environments; it
is never read.

## Test-only (the package reads them; never set them in normal use)

| Variable | What it does |
|---|---|
| `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` | Absolute path of a test executor module for the CLI's guarded hook ([`cli.md`](cli.md)). |
| `AGENT_WORKFLOW_TEST_EXECUTOR_ACK` | Must be exactly `test-only` when the module is set; otherwise every CLI command exits 2. |
| `AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR` | `1`: the detached supervisor stays in the CLI's process group (test cleanup). |
| `AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS` | Delays durable worker startup (race tests). Default `0`. |
| `AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS` | Delays the durable worker's terminal write (race tests). Default `0`. |

## Read only by the test suites and release tools

Not read by the package.

| Variable | Used by |
|---|---|
| `AGENT_WORKFLOW_TEST_CONCURRENCY`, `AGENT_WORKFLOW_KEEP_TEST_HOME` | `test/run-unit.mjs`: parallel test files; keep the per-file test homes. |
| `AGENT_WORKFLOW_LIVE`, `AGENT_WORKFLOW_LIVE_PI_MODEL`, `AGENT_WORKFLOW_LIVE_CLAUDE_MODEL`, `AGENT_WORKFLOW_LIVE_REPORT`, `AGENT_WORKFLOW_CODEX_LIVE_MODEL`, `AGENT_WORKFLOW_CODEX_LIVE_REPORT` | Live executor tiers (real CLIs and models; cost money). Off unless `AGENT_WORKFLOW_LIVE=1`. |
| `AGENT_WORKFLOW_PI_BIN`, `AGENT_WORKFLOW_PI_RPC_RECORD`, `AGENT_WORKFLOW_PI_WORKFLOW_EXTENSION` | Live Pi host RPC check ([`pi-host.md`](pi-host.md)). |
| `AGENT_WORKFLOW_ROOT` | Replay fixture builder. |
| `AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS`, `AGENT_WORKFLOW_E2E_PROCESS_LOG`, `AGENT_WORKFLOW_E2E_REAL_NPM` | `npm run e2e`: the no-external-actions guard and its command shims (set by `test/e2e/run.mjs`). |
| `AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION` | `tools/release/release-check.mjs`: allow a validation-only rerun of an already published version. |
