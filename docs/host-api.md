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

Sources: `src/hosts/api.ts` (exports), `types.ts`, `args.ts`, `catalog.ts`, `launch.ts`,
`launch-guard.ts` (WP16), `runs.ts`, `logs.ts` (WP16), `result-presentation.ts`, `user-profiles.ts`,
`help.ts`, `test-executor.ts`.

## Common contract

**Context** `HostApiContext`: `cwd` (project; runs live under `<cwd>/.agent-workflow/`), optional
`env` (role checks and the user home; default `process.env`), `host` (WP17: `"claude-code" |
"codex" | "pi" | "cli"`; the default executor is the host's own CLI, `cli` or absent = first
installed and logged-in of pi → claude → codex), `defaultExecutor` (explicit host override of that
default, below the saved user profile), `runtimeDefaults` (the host's current model/effort), and
`availableModels` (the host's model registry; when present, the per-workflow Pi profile preferences
of `/workflow profile` are consulted at launch; the CLI and MCP hosts leave it unset), and `host`
(the calling host's identity, for example `claude-code`/`codex` from the host MCP server's `--host`;
passed through unchanged for the stage-2 default-executor rule, WP17).

**Result** `HostResult<T>`:

| Field | Meaning |
|---|---|
| `action` | The handler (`list`, `run`, `wait`, …). |
| `outcome` | `success`, `running`, `completed`, `failed`, `blocked`, `interrupted`, `refused`, `existing` (WP16: the duplicate guard returned an identical active run), `timeout`. |
| `ok` | `outcome` is `success`, `running`, `existing` or `completed`. |
| `data` | Structured, JSON-serializable payload (per handler below). |
| `text` | Plain-text rendering for humans (CLI stdout, MCP text content). |

**Next-step hints (WP18b).** Run texts name follow-up commands (`Open:`, `Resume:`, `Logs:`, `Raw:`,
stall warnings, the detached-launch and blocked-wait lines). Handlers choose them from `ctx.host`
(`src/hosts/hints.ts`): `cli` or unset → `agent-workflow status|resume|logs … <run>`, `pi` →
`/aw …`, `claude-code`/`codex`/`generic` → MCP tool calls (`workflow_status {"runId":…}`,
`workflow_logs`, `workflow_inspect`, `workflow_stop`; resume has no tool, so it names
`agent-workflow resume <run>`). Hosts print `text` unchanged; no host rewrites handler text for
hints. The core formatters keep pi-workflow's `/workflow …` form only as their default for direct
(ported) core callers.

**Errors.** Caller mistakes throw `HostUsageError` (CLI exit 2; host MCP server: a tool result
with `isError` and `error.kind: "usage"`, see `host-mcp.md`). Spec errors
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
| `runWorkflowAction` | `RunWorkflowRequest` (below) | `LaunchData` | running, completed, failed, blocked, refused, existing |
| `runDynamicAction` | `RunDynamicRequest` (no `workflow`) | `LaunchData` (`mode: "direct-dynamic"`) | same |
| `statusAction` | `{runId?}` | `{run: RunSummary & {tasks}}` or `{runs: RunSummary[]}` (top-level, newest first) | success |
| `inspectAction` | `{runId, failures?, results?}` | `{run, reliability: {health, outputRetries, launchRetries, resumeEvents, contextLimitFailures}, listed}` | success |
| `logsAction` (WP16) | `{runId, task?, lines?, stream?}` (below) | `LogsData`: `{runId, name?, status, lines, streams, tasks: [{taskId, specId, status, statusDetail, streams: [{kind, path, lines, truncated}]}], omittedTasks, truncated}` | success |
| `waitAction` | `WaitRequest` (below) | `WaitData` | running, completed, failed, interrupted, blocked |
| `resumeAction` | `{runId, detach?}` | `{runId, status, resetTaskIds, taskSummary, detached?}` | run status |
| `stopAction` | `{runId, timeoutMs?}` | `{runId, status, interruptedTaskIds, pending}` | success, or running when `pending` |
| `pruneAction` | `{keep?, olderThanDays?, yes?}` or `{argv}` | `WorkflowPruneSummary` (core) | success, failed (`summary.error`) |
| `noticesAction` | `{argv}` (`list [--json]`, `acknowledge <id> --state <sha> --reason <text>`, `clear <id> [--json]`) | list: `{notices, acknowledgements, warnings}`; else `{action, runId, notificationOnly}` | success |
| `doctorAction` (WP17) | `{prober?, probeTimeoutMs?, nodeVersion?}` (test seams) | `DoctorData`: `{host, executors[], defaultExecutor, permissionMode, node, home, warnings, runIndex, usable}` (no model call, nothing written) | success (an executor is usable), failed |
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
| `forceNew` | Skip the duplicate guard (the started run becomes the one later identical launches find). |
| `interactive`, `confirmDegradations(preview)` | WP4d. `interactive: true` requires the callback; it is called only when a stage needs confirmation; anything but `true` refuses (`CAPABILITY_DEGRADATION_DECLINED`). Without `interactive`, degradations are recorded (`non-interactive`) and the run proceeds. |
| `selectProfile(title, options, meta?)` | Chooser between declared profiles when none is named (Pi host). `meta.headlessOption` (WP16) is the option a headless launch would pick (the declared default, else `Base (no profile)`), so a host without a dialog can make that choice and list the others as text. |
| `inputOverrides` | Values for declared spec inputs. |

Profile resolution when `profile` is omitted: (host with `availableModels`: the saved per-workflow
Pi preference) > the declared `defaultExecutionProfile` (or `selectProfile`) > the default saved
user profile > none. A saved user profile becomes a captured execution profile
(`executionProfileOverride` with `executor`, `permissionMode`, `strictCapabilities`, no stage
overrides) plus run defaults `model`/`effort`; the engine then applies B2 precedence and records
`run.executor.source` / `run.permissionMode.source` = `user-profile`. On a spec without an artifact
graph the executor and permission mode are passed as run options instead (strictCapabilities then
refuses).

`LaunchData`: `{mode, runId?, status?, name?, specPath?, executor?: {id, source, profile?, host?},
permissionMode?: {mode, source, profile?}, profile?: {name, kind: declared | user |
workflow-preference, source}, capability?: {preview, confirmation, degradations, forcedReadOnly},
taskSummary?, detached?, promptSchemaNotice?, duplicateOf?, refusal?: {code, executorId?,
preview?}}`. `text` starts with the capability preview, then the launch card.

Refusals (`outcome: "refused"`, nothing launched, no run record): `WorkflowCapabilityError` codes
(`EXECUTOR_PROBE_FAILED`, `EXECUTOR_NOT_INSTALLED`, `EXECUTOR_AUTH_NOT_READY`, `CAPABILITY_REFUSED`,
`CAPABILITY_CONFIRMATION_REQUIRED`, `CAPABILITY_DEGRADATION_DECLINED`), `EXECUTOR_UNAVAILABLE`
(unknown or unavailable executor id), and `DUPLICATE_LAUNCH_IN_PROGRESS` (an identical launch is
still starting after a 15 s wait).

**Duplicate-launch guard (WP16, `launch-guard.ts`).** Attached and detached launches, from every
host (CLI, Pi `/aw` and `aw_*`, host MCP server), go through one guard, so a model that retries
`workflow_run`/`aw_run` after a tool timeout gets the first run back. A launch's identity is a
SHA-256 over: kind (`run`/`dynamic`), cwd, resolved spec path and spec name, trimmed task, typed
`inputOverrides`, and the requested `executor`, `profile`, `permissionMode`,
`allowUnverifiedCapabilities` (sorted), `model`, `effort`. WP19 (review #8): plus the resolved
execution identity (`launchExecutionIdentity`, resolved without prompting or probing): the host
(`ctx.host`, default `cli`), the executor that applies and its source (request flag, the saved user
profile the request names or the default one, the workflow's declared profiles, `ctx.defaultExecutor`,
the host's own CLI, or the terminal's `pi>claude>codex` installed-default order), the contents of the
saved user profile that applies, the host's inherited model/effort (`runtimeDefaults`), the effective
permission mode, and `workflowDefinitionFingerprint` of the loaded spec (covering declared profiles
and defaults). So the same request from Claude Code and Codex, or after a workflow or saved-profile
change, starts a new run. WP19 round 2 (N5): the launch profile is resolved once, before the guard,
from one read of the settings (the requested declared or saved user profile, the saved per-workflow
preference with its resolved stage overrides on hosts with a model registry, the default saved user
profile); the fingerprint covers that snapshot and the launch runs from the same snapshot (no second
settings read). Only the interactive declared-profile chooser runs after the guard claimed the launch
(a duplicate never prompts); it picks from the snapshot. So changing the saved per-workflow
preference (e.g. Codex → Claude) between two identical requests starts a new run with the new
preference. Residual: for `cli`/`generic` the installed-default choice is probed after
the guard, so a login change between two identical launches within the window is not seen.
`detach` and the interactive hooks are not part of it. An identical launch while the run it recorded is non-terminal (`running`, `pending`,
`blocked`) and was created within the last 10 minutes (`DUPLICATE_RUN_WINDOW_MS`) returns that run:
`outcome: "existing"` (`ok`), `data` is that run's `LaunchData` plus `duplicateOf`, no new supervisor
is spawned, and the text starts `Duplicate launch guard:` and names `--force-new`. A terminal,
pruned or older run, different inputs or options, or `forceNew: true` start a new run. State: one
claim file per identity in `<cwd>/.agent-workflow/host-launches/<sha256>.json`, created exclusively
before the run starts and given the run id afterwards, so concurrent identical launches also yield
one run (the later ones wait up to 15 s for the first run id). WP19 (review #1): every claim carries
a unique owner token and a renewable lease (`leaseExpiresAt`, 60 s, renewed every 15 s while the
launch is in flight, e.g. waiting for a user confirmation). Publishing, stale takeover, renewal,
`record`, `release` and pruning all run under a per-identity mutex (`<sha256>.lock`, an atomically
created lock directory with owner-aware stealing, the same `dir-lock` the artifact registry uses), so
two launches that find the same stale claim serialize and exactly one is `claimed`; record, release
and prune leave a claim with another owner token alone. WP19 round 2 (N1): the lease fences
execution, not only the claim. A pending claim is taken over at once only when its owner process
(same host) is dead; an owner that is alive (same host) or cannot be checked (another host) keeps
its claim even after its lease expired (a suspended process may still start), and later identical
launches are refused as `DUPLICATE_LAUNCH_IN_PROGRESS`; such a claim is abandoned only 1 h
(`LAUNCH_CLAIM_ABANDON_MS`) after its lease expired. Immediately before `start()` the launch passes an
ownership fence (`begin()`): under the mutex it checks that the claim still carries its owner token
and marks it `state: "starting"`. A launch whose claim was taken over meanwhile starts nothing and
returns the new owner's run (`existing`) or is refused (`DUPLICATE_LAUNCH_IN_PROGRESS`). WP18b: claim files older than 1 h that do not name a
still-active run are stale; every launch removes them in the background and `prune` removes them
with the runs (same dry-run rule; `data.hostLaunchClaims`). Runs launched outside the host API (the
SDK) are not guarded. Before WP16 the guard applied to attached launches only, matched spec name + task, and
refused (`outcome: "refused"`).

The handler returns once the run is launched (usually `running`). The engine keeps an in-process
watcher (unref'd timer) for long-lived hosts; short-lived hosts either `wait` in the foreground or
`detach`.

### `logs` (WP16)

`LogsRequest`: `{runId, task?, lines?, stream?}`. A bounded tail per task of `output`
(`task.files.output`), `stderr` (the task's stderr log, else the latest attempt's executor stderr)
and `events` (the latest attempt's `exec-events.jsonl` under
`.agent-workflow/workflow-subagents/<run>/<task>/`). `task` is a task id or spec id (unknown →
`HostUsageError`); without it every started task, at most 6 (the most recently started), with
`omittedTasks` counting the rest. `lines` per stream 1-400 (default 20); each line is cut at 400
characters (`… [N more chars]`); the text and the lines kept in `data` stop at 48 000 characters
(`truncated: true`). Every line and path goes through `redactSensitiveWorkflowText` (credential
assignments, `Authorization`/cookie headers, bearer tokens, URL secrets and credentials, home paths)
and the values (8+ characters) of host environment variables with sensitive names (`*_KEY`,
`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …) become `[REDACTED:<NAME>]`. The run is refreshed first, like
`status`. Port in spirit of pi-workflow's `/workflow logs <run> [task] [lines]` (one task's output).

WP19 (review #4): run records live in the workspace and can be tampered with, so every path read
from them (`task.files.*`, the attempt dirs) must be project-relative, without `..`, and resolve
canonically (symlinks followed) inside the project's artifact root `<cwd>/.agent-workflow`
(`hosts/run-files.ts`). Anything else is not read: the stream has `refused: "<reason>"` (absolute
path, traversal, outside the artifact root, symlink escape) and the text says `(not read: …)`.
`inspect --results` applies the same check to `task.files.result`, and the wait/status result
presentation requires the output task dir inside the artifact root (not only the project).
Legacy `.pi/workflows/…` paths are refused too, by design: runs are only ever listed from
`.agent-workflow/workflows/` (legacy discovery is for specs and agents; pi-workflow and
agent-workflow each see their own runs, docs/usage.md), so only a pi-workflow run record copied in by
hand can name them.
WP19 (review #7): one redactor (`hosts/redaction.ts`) covers all host text that can carry worker
output: `logs`, the text of `status <run>`, `show`, `inspect`, `wait` (and `data.preview`), and the Pi
completion message. Beyond the rules above it redacts quoted structured credentials, whitespace
included (`"Authorization":"Basic …"`, `Proxy-Authorization`, `Cookie`/`Set-Cookie`, `x-api-key`,
JSON fields such as `token`, `access_token`, `refresh_token`, `api_key`/`apiKey`, `secret`,
`client_secret`, `password`, also backslash-escaped inside JSON strings), and Linux `/home/<user>`
and Windows `C:\Users\<user>` home paths as well as macOS `/Users/<user>`. WP19 round 2 (N4): the end
of a structured value is found by an escape-aware scanner (JSON string escapes at every nesting
level of escaped JSON), so an escaped quote inside the value (`"Cookie":"sid=\"…\"; path=/"`, a
password containing `\"`) no longer ends it early. WP19 round 2 (N6): prose is told apart from
credentials. In the `Label: value` form (colon and a space) only a credential key (`password`,
`token`, `secret`, `*_token`, `*_secret`, `*apikey`, …) or a token-shaped value (≥ 8 characters with a
digit or `+/=_.~`, or ≥ 24 characters) is redacted, so `Exit code: 1` and `HTTP status code: 403`
stay; `key=value` and `key:value` assignments are redacted as before. WP19 round 3 (R1): a value
under an unequivocal credential header (`Authorization`, `Proxy-Authorization`, `Cookie`,
`Set-Cookie`, `x-api-key`, `api-key`, `*-token` such as `X-Auth-Token`) is always redacted through
the end of the line, whatever its length or alphabet (`x-api-key: k3y012` and `Authorization: abc`
too), as are the credential JSON keys above (`password: abc`). The only prose exception is an
obvious statement after `Authorization:`/`Proxy-Authorization:`: the first word is `missing`,
`not`, `none`, `required`, `optional`, … and no word looks like a token
(`Authorization: missing on the delete endpoint; …` stays). When unsure, it redacts.

### `wait`

`WaitRequest`: `{runId, timeoutMs?, signal?, onProgress?(RunSummary)}`. One call drives scheduling
and waits **at most 45 s** (`HOST_WAIT_MAX_TIMEOUT_MS`; default and cap; minimum 1 s,
`boundedWaitTimeout`). MCP hosts have per-tool-call limits (Codex `tool_timeout_sec` defaults to
60 s), so a host calls `wait` again while `stillRunning` is true; the CLI loops. Cancelling (`signal`)
cancels only the wait.

`WaitData`: `{runId, status, semanticStatus, terminal, actionRequired, stillRunning, timeoutMs,
blockedTaskIds, taskSummary, outputTaskIds, outputRetryAttempts, launchRetryAttempts, artifactRoot,
nextRetry?, verdict?, preview?, reportArtifacts, usage?, degradation?}`. `verdict` (WP18b) is the
workflow's domain verdict from the output task's control (for example `NEEDS_WORK`), not the run
status. `verdictGate: true` (WP18b) marks a run whose only failure is the final verdict
gate (`isVerdictGateFailure`: run `failed`, every task completed or skipped except output tasks with
`support_declared_failed`): the preview and `reportArtifacts` then come from that declared-failed
task (before WP18b only a *completed* output task was read, so these runs had no preview and no
report), and `text` leads with `Workflow finished — verdict: X (report ready)` and keeps the run
status on its own line. Presentation only: `status` and the outcome stay `failed` (CLI exit 1).
WP19 (review #10): that structural shape is only the precondition. `verdictGate` also needs
explicit evidence: a non-empty domain verdict in the output task's control *and* an existing
final-report artifact whose task dir resolves inside the run's own directory. A generic support
failure without them (for example a control with only `status: "failed"` and "required evidence
missing") is presented as an ordinary failure: no `verdictGate`, no preview from that task.
`statusAction` for one terminal run adds the same headline, `Verdict:` and report lines, and
`data.run.{verdict?, verdictGate?, reportArtifacts}`. `nextRetry` (WP18b) is set while a
still-running run only waits for a scheduled task retry (no task running, every startable task in a
retry backoff such as a 15-minute rate-limit wait): `{at, retryAfterMs, reason?, message?, taskIds}`;
the text then adds "Now waiting for scheduled retry at <time> (<reason>; <tasks>)".

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

Pi-session behavior stays with the Pi host (WP11b, WP16 `docs/pi-host.md`): completion feedback
delivery, its audience and receipts, the status line, parent-session usage tracking, unfinished-run
notices at session start (`notifyUnfinishedRuns`), the board/TUI, `/workflow auto`, and the Pi
profile picker UI. Launches record no launch-capture metadata (the v1
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
| surface-regressions: formatLogs bounded tail IO | not ported (core `formatLogs`); WP16's `logsAction` has its own bounds tests (`host-wp16-logs`) |
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
  WP18b: run-text hints are host-aware (see *Next-step hints* above).
- **Launch capture:** `WorkflowRunLaunchCapture` has no CLI/MCP source kind; runs launched through
  the host API record no launch metadata until core gains a host-neutral source.
- **Stage 2 (WP13 MCP host):** done — `docs/host-mcp.md` (`HostUsageError` → `isError` tool
  result, repeated bounded `waitAction` calls, `detach` default true, degradation confirmation
  through MCP elicitation when the client supports it, else non-interactive). WP18b added
  the `workflow_logs` tool over `logsAction`.
- **Duplicate guard (WP16):** an `existing` run returned to a launch that asked for `detach` may be an
  attached run whose host process is gone (it stays `running` until `wait`, `resume` or `supervise`
  drives it); `forceNew` or `resume` then. The claim files are not pruned with runs (one small
  file per distinct launch identity).
- A workflow-declared profile replaces a saved user profile entirely (engine B2), so a default user
  profile's executor does not apply to workflows that declare `defaultExecutionProfile`.
- `run` without `--detach` in the CLI ties progress to the foreground process; a killed CLI leaves
  the run for `wait`/`resume`/`supervise` to pick up.
