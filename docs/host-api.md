# Host API (`@agwab/agent-workflow/hosts/api`)

WP11a. The host API layer is one typed, host-neutral handler per workflow action. The
`agent-workflow` CLI (`docs/cli.md`), the stage-2 host MCP server (roadmap WP13) and the Pi host
(WP11b) all call these handlers instead of re-implementing command logic. The module has no Pi
imports; the logic is ported from pi-workflow 0.16.4 (`b83cc4f`) `src/extension.ts` (the `/workflow`
handlers and the `workflow_list/run/dynamic/wait` tools) and `src/cli.mjs` (`inspect`, `prune`,
`notices`, `supervise`).

```ts
import { runWorkflowAction, waitAction } from "@agwab/agent-workflow/hosts/api";
const launched = await runWorkflowAction({ cwd }, { workflow: "deep-review", task: "…", executor: "claude" });
let waited;
do waited = await waitAction({ cwd }, { runId: launched.data.runId! });
while (waited.data.stillRunning);
```

Sources: `src/hosts/api.ts` (exports), `types.ts`, `args.ts`, `catalog.ts`, `launch.ts`, `runs.ts`,
`result-presentation.ts`, `user-profiles.ts`, `help.ts`, `test-executor.ts`.

## Common contract

**Context** `HostApiContext`: `cwd` (project; runs live under `<cwd>/.agent-workflow/`), optional
`env` (role checks and the user home; default `process.env`), `defaultExecutor` (lowest B2
precedence; engine default `pi`), `runtimeDefaults` (the host's current model/effort), and
`availableModels` (the host's model registry; when present, the per-workflow Pi profile preferences
of `/workflow profile` are consulted at launch; the CLI and MCP hosts leave it unset), and `host`
(the calling host's identity, for example `claude-code`/`codex` from the host MCP server's `--host`;
passed through unchanged for the stage-2 default-executor rule, WP17).

**Result** `HostResult<T>`:

| Field | Meaning |
|---|---|
| `action` | The handler (`list`, `run`, `wait`, …). |
| `outcome` | `success`, `running`, `completed`, `failed`, `blocked`, `interrupted`, `refused`, `timeout`. |
| `ok` | `outcome` is `success`, `running` or `completed`. |
| `data` | Structured, JSON-serializable payload (per handler below). |
| `text` | Plain-text rendering for humans (CLI stdout, MCP text content). |

**Errors.** Caller mistakes throw `HostUsageError` (CLI exit 2; MCP: invalid params). Spec errors
throw `WorkflowValidationError`; `formatHostError(error)` renders any error. Launch refusals are
*results*, not errors (`outcome: "refused"`). Every handler first checks the process role
(`AGENT_WORKFLOW_ROLE`): `worker`/`disabled` processes may only `validate` and `help`.

**CLI exit-code mapping** (`exitCodeFor`): `ok` → 0, else 1; a still-running wait
(`data.stillRunning`) or an unconfirmed stop (`data.pending`) → 1; `HostUsageError` → 2.

## Handlers

| Handler | Request | `data` | Outcomes |
|---|---|---|---|
| `helpAction(command?)` | — | `{command?}` | success |
| `listWorkflowsAction` | `{query?, offset?, limit?}`; `limit` 1-20 pages and bounds text and data to 50 KB / 2000 lines; omitted = every workflow | `{workflows: [{name, aliases, specPath, description?, agent?, readOnly?}], total, nextOffset?, omitted}` | success |
| `validateWorkflowAction` | `{workflow}` | `{valid, name?, specPath, workflowName?, type, tasks, roles, maxConcurrency, blockedPermissionPreviews, warnings}` | success (invalid specs throw) |
| `workflowRolesAction` | `{workflow}` | `{specPath, roles}` | success |
| `listAgentsAction` | — | `{agents: [{name, displayName, description?, scope, legacySource?, model?, effort?, tools?, readOnly?, sourcePath}]}` | success |
| `showAction` | `{ref, raw?}`: a run (`raw`, or `workflow_…`) else a workflow | `{kind: "run", run}` or `{kind: "workflow", specPath, spec}` | success |
| `profileAction` | `{op: "list"} \| {op: "show", name?} \| {op: "set", name, values?, unset?, makeDefault?} \| {op: "delete", name} \| {op: "default", name \| null}` | `{op, path, default?, profiles?, profile?, deleted?}` | success |
| `runWorkflowAction` | `RunWorkflowRequest` (below) | `LaunchData` | running, completed, failed, blocked, refused |
| `runDynamicAction` | `RunDynamicRequest` (no `workflow`) | `LaunchData` (`mode: "direct-dynamic"`) | same |
| `statusAction` | `{runId?}` | `{run: RunSummary & {tasks}}` or `{runs: RunSummary[]}` (top-level, newest first) | success |
| `inspectAction` | `{runId, failures?, results?}` | `{run, reliability: {health, outputRetries, launchRetries, resumeEvents, contextLimitFailures}, listed}` | success |
| `waitAction` | `WaitRequest` (below) | `WaitData` | running, completed, failed, interrupted, blocked |
| `resumeAction` | `{runId, detach?}` | `{runId, status, resetTaskIds, taskSummary, detached?}` | run status |
| `stopAction` | `{runId, timeoutMs?}` | `{runId, status, interruptedTaskIds, pending}` | success, or running when `pending` |
| `pruneAction` | `{keep?, olderThanDays?, yes?}` or `{argv}` | `WorkflowPruneSummary` (core) | success, failed (`summary.error`) |
| `noticesAction` | `{argv}` (`list [--json]`, `acknowledge <id> --state <sha> --reason <text>`, `clear <id> [--json]`) | list: `{notices, acknowledgements, warnings}`; else `{action, runId, notificationOnly}` | success |
| `superviseAction` | `{runId? \| all, pollMs?, maxRuntimeMs?, onLog?, signal?, testHooks?}` | `{runIds, maxRuntimeMs, runs, result: completed \| failed \| blocked \| timeout}` | completed, failed, blocked, timeout |

`RunSummary` = `{runId, name?, status, type, createdAt, updatedAt, parentRunId?, executor?,
permissionMode?, taskSummary}`.

### `run` / `dynamic`

`LaunchRequestBase`:

| Field | Meaning |
|---|---|
| `task` | Full runtime task (required). |
| `executor` | Run flag (B2 highest precedence). |
| `profile` | A declared spec profile, else a saved user profile with that name; unknown names throw `HostUsageError` listing both. |
| `permissionMode` | `"free" \| "safe"` run flag (WP4e). |
| `allowUnverifiedCapabilities` | B4 opt-in keys. |
| `model`, `effort` | Run overrides of every stage (`runtimeOverrides`). |
| `detach` | Spawn `agent-workflow supervise <runId>` detached (log `<run dir>/supervise.log`); `data.detached = {pid, logPath}`. |
| `forceNew` | Skip the duplicate guard. |
| `interactive`, `confirmDegradations(preview)` | WP4d. `interactive: true` requires the callback; it is called only when a stage needs confirmation; anything but `true` refuses (`CAPABILITY_DEGRADATION_DECLINED`). Without `interactive`, degradations are recorded (`non-interactive`) and the run proceeds. |
| `selectProfile(title, options)` | Interactive chooser between declared profiles when none is named (Pi host). |
| `inputOverrides` | Values for declared spec inputs. |

Profile resolution when `profile` is omitted: (host with `availableModels`: the saved per-workflow
Pi preference) > the declared `defaultExecutionProfile` (or `selectProfile`) > the default saved
user profile > none. A saved user profile becomes a captured execution profile
(`executionProfileOverride` with `executor`, `permissionMode`, `strictCapabilities`, no stage
overrides) plus run defaults `model`/`effort`; the engine then applies B2 precedence and records
`run.executor.source` / `run.permissionMode.source` = `user-profile`. On a spec without an artifact
graph the executor and permission mode are passed as run options instead (strictCapabilities then
refuses).

`LaunchData`: `{mode, runId?, status?, name?, specPath?, executor?: {id, source, profile?},
permissionMode?: {mode, source, profile?}, profile?: {name, kind: declared | user |
workflow-preference, source}, capability?: {preview, confirmation, degradations, forcedReadOnly},
taskSummary?, detached?, promptSchemaNotice?, duplicateOf?, refusal?: {code, executorId?,
preview?}}`. `text` starts with the capability preview, then the launch card.

Refusals (`outcome: "refused"`, nothing launched, no run record): `WorkflowCapabilityError` codes
(`EXECUTOR_PROBE_FAILED`, `EXECUTOR_NOT_INSTALLED`, `EXECUTOR_AUTH_NOT_READY`, `CAPABILITY_REFUSED`,
`CAPABILITY_CONFIRMATION_REQUIRED`, `CAPABILITY_DEGRADATION_DECLINED`), `EXECUTOR_UNAVAILABLE`
(unknown or unavailable executor id), and the duplicate guard (`duplicateOf`; an identical active
top-level run from the last 10 minutes; not applied with `detach` or `forceNew`).

The handler returns once the run is launched (usually `running`). The engine keeps an in-process
watcher (unref'd timer) for long-lived hosts; short-lived hosts either `wait` in the foreground or
`detach`.

### `wait`

`WaitRequest`: `{runId, timeoutMs?, signal?, onProgress?(RunSummary)}`. One call drives scheduling
and waits **at most 45 s** (`HOST_WAIT_MAX_TIMEOUT_MS`; default and cap; minimum 1 s,
`boundedWaitTimeout`). MCP hosts have per-tool-call limits (Codex `tool_timeout_sec` defaults to
60 s), so a host calls `wait` again while `stillRunning` is true; the CLI loops. Cancelling (`signal`)
cancels only the wait.

`WaitData`: `{runId, status, semanticStatus, terminal, actionRequired, stillRunning, timeoutMs,
blockedTaskIds, taskSummary, outputTaskIds, outputRetryAttempts, launchRetryAttempts, artifactRoot,
preview?, reportArtifacts, usage?, degradation?}`.

| State | `terminal` | `actionRequired` | `stillRunning` | outcome |
|---|---|---|---|---|
| still running after the bound | false | false | true | running |
| blocked (needs inspect/resume) | false | true | false | blocked |
| completed / failed / interrupted | true | false | false | completed / failed / interrupted |

`preview` is the bounded authoritative result of the first completed output task (pi-workflow
`readWorkflowResultPresentation`: `completionSummaryMarkdown` verbatim, else summaries/reports,
truncated to 6000 characters); `reportArtifacts` lists the final report and evidence audit paths.
For a successful run with a preview, `text` is the preview alone (pi-workflow result-only success).

### `stop`

Stops a run through the engine (durable stop intent). If another supervisor (for example a detached
one) holds the run lease, the engine reports the stop as pending; the handler retries for
`timeoutMs` (default 15 s, `HOST_STOP_CONFIRM_TIMEOUT_MS`) and then returns `pending: true`
(outcome `running`); the intent stays durable and the active supervisor applies it.

### `supervise`

Port of pi-workflow `cli.mjs supervise`: schedules until the run (or, with `all`, every run observed
running and top-level) is terminal; failure takes precedence over blocked; an empty batch succeeds.
`maxRuntimeMs` 0 = unlimited; default 4 h, or unlimited for a single running run whose compiled
workflow has a `maxRounds: null` loop. `onLog` receives each progress line. `testHooks` (`now`,
`sleep`, `schedule`) exist for tests only.

## Parsers

Exported for hosts that receive one argument string (Pi `/workflow`, chat hosts):
`parseWorkflowRunArgs`, `parseWorkflowDynamicArgs` (leading or trailing options, quoted text is
literal, duplicates and retired `--route/--no-route` rejected; options `--model --profile --effort
(--thinking/--reasoning) --executor --permission-mode --allow-unverified --detach --force-new`),
`parseWorkflowPruneArgs`, `parseSuperviseArgs`, `tokenizeWorkflowArgs`, `parseDuration`,
`parsePermissionMode`, `parseThinkingLevel`, `parseCapabilityList`. Also exported:
`selectWorkflowExecutionProfile` and `resolveWorkflowExecutionProfileForLaunch` (pi-workflow's
declared-profile picker and launch precedence for hosts with a model registry),
`spawnDetachedSupervisor`, `agentWorkflowCliPath`, `readWorkflowResultPresentation`.

## Saved user profiles

`$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json` (private file and directory):
`{schema: "agent-workflow-user-profiles-v1", default?, profiles: {<name>: {executor?, model?,
effort?, permissionMode?, strictCapabilities?, updatedAt}}}`. Names: 1-64 of `[A-Za-z0-9._-]`.
Values are validated on every write and read (unknown fields, effort levels, modes and capability
names are rejected); a malformed file is reported, never rewritten. pi-workflow's per-workflow
built-in/custom stage preferences (`workflow-profiles/v1`, Pi TUI) are a separate store that the Pi
host keeps (WP11b).

## Test-executor hook

`registerTestExecutorFromEnv(env)` (used by the CLI only; never by the handlers): registers the
descriptor exported as `testExecutorDescriptor` by the module at
`AGENT_WORKFLOW_TEST_EXECUTOR_MODULE`, only when `AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only`, the
path is absolute and the id starts with `test-`. Otherwise it throws `TestExecutorHookError`. See
`docs/cli.md`.

## Not in the host API

Pi-session behavior stays with the Pi host (WP11b): completion feedback delivery and its
presentation lease/receipts (`workflow_wait` ownership checks), parent-session usage tracking,
unfinished-run notices at session start (`notifyUnfinishedRuns`), the board/TUI, `/workflow auto`,
`/workflow logs`, and the Pi profile picker UI. Launches record no launch-capture metadata (the v1
capture schema only knows Pi slash commands and Pi tools).

## Ported pi-workflow tests (WP11a decisions)

Tests deferred because they needed `extension.ts` or `cli.mjs`, where the command behavior now lives
in the host API or the CLI:

| Source | Decision |
|---|---|
| workflow-authoring-gates: 2 `inspect --failures --results` tests | ported → `host-ported-cli-args` (paths `.agent-workflow/workflows`) |
| review-runtime-retention-depth: RR-02 actual CLI prune | ported → `host-ported-cli-args` (`--json` data wrapper) |
| unlimited-supervisor (4) | ported → `host-ported-cli-args` via `superviseAction` with an injected clock/scheduler (was a copied cli.mjs over fake dist modules) |
| surface-regressions: slash options; actual CLI options; supervise failed/blocked/batches; workflow_list bounds | ported → `host-ported-cli-args`. Changed: `dynamic --profile` is accepted; usage errors exit 2 (was 1); blocked supervise exits 1 (was 2), the structured result keeps blocked and the failure precedence |
| surface-regressions: parent usage ownership/replay (2), owner usage/feedback audience (2), catch-up delivery caps (2), board/RPC fallback, board identity, hidden artifact views, skipped dependent stage view, 8 MiB preview bound, preview disposal | not ported: Pi host session/board behavior (WP11b) |
| surface-regressions: formatLogs bounded tail IO | not ported: `logs` is not a host action (core-only; candidate for the core suite) |
| review-core-fixes: IR1-08 parsers; IR1-08 CLI/RPC launch controls (CLI half); IR1-08 slash/CLI prune (slash half → `pruneAction`); IR1-09 catalog paging (→ `listWorkflowsAction`) | ported → `host-ported-cli-args` (exit 2 for usage errors) |
| review-core-fixes: IR1-03 parent usage (4), IR1-04/IR1-05 schema tests | not ported here: parent usage is Pi host (WP11b); IR1-04/05 are core json-schema tests outside WP11a's scope |
| execution-profiles: `--profile` parsing; profile selection | ported → `host-ported-cli-args` |
| workflow-router: retired routing flags | ported → `host-ported-cli-args`; the other 7 (auto capture, TUI, foreground cancel) stay Pi host (WP11b) |
| workflow-user-profiles: invalid/corrupt writes; launch precedence | ported → `host-ported-cli-args`; the 15 profile UI/TUI tests stay Pi host (WP11b) |
| workflow-notice-acknowledgements: list/ack/clear, ineligible, concurrent CLI acks, validation, link escapes, empty list, commit fence (2), slash/standalone parity | ported → `host-ported-notices` (parity now CLI vs `noticesAction`; inspect `--json` wrapper; exit 2) |
| workflow-notice-acknowledgements: suppression, changed-state dedup (3), malformed sidecars | not ported: need `notifyUnfinishedRuns` (Pi session start, WP11b) |
| unit-engine-store: 4 Pi extension launch options | not ported: Pi executor/host options (WP6/WP11b) |

The original files carry `Moved (WP11a)` markers at the former deferral comments.

## Open problems

- **WP11b (Pi host):** `/workflow` slash commands should call these handlers with
  `availableModels`/`runtimeDefaults` from Pi and `selectProfile`/`confirmDegradations` from the
  TUI; it keeps feedback delivery, parent usage, notices at session start, the board and `auto`.
  Core formatters still print `/workflow …` hints (status/show/stop texts); the CLI shows them as is.
- **Launch capture:** `WorkflowRunLaunchCapture` has no CLI/MCP source kind; runs launched through
  the host API record no launch metadata until core gains a host-neutral source.
- **Stage 2 (WP13 MCP host):** map `HostUsageError` to invalid params; call `waitAction` repeatedly
  (≤45 s each); in-process watchers keep runs going while the server lives, so `detach` is only
  needed for runs that must outlive it; interactive confirmation needs an MCP elicitation path
  (until then MCP launches are non-interactive).
- A workflow-declared profile replaces a saved user profile entirely (engine B2), so a default user
  profile's executor does not apply to workflows that declare `defaultExecutionProfile`.
- `run` without `--detach` in the CLI ties progress to the foreground process; a killed CLI leaves
  the run for `wait`/`resume`/`supervise` to pick up.
