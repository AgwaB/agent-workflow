# Host API (`@agwab/agent-workflow/hosts/api`)

The CLI, Pi extension and host MCP server call shared typed handlers. The module has no Pi imports.

```ts
import { runWorkflowAction, waitAction } from "@agwab/agent-workflow/hosts/api";
const launched = await runWorkflowAction({ cwd }, {
  workflow: "deep-review", task: "…", executor: "claude",
});
let waited;
do waited = await waitAction({ cwd }, { runId: launched.data.runId! });
while (waited.data.stillRunning);
```

## Common contract

`HOST_API_VERSION = "1"`. `HostApiContext`:

| Field | Meaning |
|---|---|
| `cwd` | Project directory; runs live under `.agent-workflow/` |
| `env?` | Role checks and user home; defaults to `process.env` |
| `host?` | `claude-code`, `codex`, `pi`, `cli`, `generic`; selects host-aware hints and default executor |
| `defaultExecutor?` | Explicit host default, below the saved user profile |
| `runtimeDefaults?` | Host model/effort; lowest-precedence runtime defaults |
| `availableModels?` | Host model registry; enables per-workflow Pi profile preferences |
| `hostTools?` | `{projectTrusted: boolean}` for Pi native codemode/MCP inheritance |
| `readonly?` | Prevent automatic dashboard process startup |
| `dynamicUi?` | `{hasUI, host, confirm(title, message, {timeout, signal})}` for attached dynamic-controller approvals; detached launches/resumes never use it |

Host defaults: Claude Code → `claude`, Codex → `codex`, Pi → `pi`; CLI/generic/absent → first
installed and logged-in of pi → claude → codex.

`HostResult<T>` has `action`, `outcome`, `ok`, JSON-serializable `data` and human-readable `text`.
Outcomes: `success`, `running`, `completed`, `failed`, `blocked`, `interrupted`, `refused`,
`existing`, `timeout`. `ok` is true only for success/running/existing/completed. Hosts print `text`
unchanged; follow-up hints use CLI commands, `/aw`, or MCP tool calls according to `ctx.host`.

Caller mistakes throw `HostUsageError`; invalid specs throw `WorkflowValidationError`.
`formatHostError(error)` renders either. Launch refusals are results, not exceptions. Role checks
allow `worker` / `disabled` processes only `validate` and `help`.

`exitCodeFor`: `ok` → 0, otherwise 1; a still-running wait (`data.stillRunning`) or pending stop
(`data.pending`) → 1; usage error → 2. The [host MCP server](host-mcp.md) returns usage errors with
`isError` and `error.kind: "usage"`.

## Handlers

| Handler | Request | Data |
|---|---|---|
| `helpAction` | command? | `{command?}` |
| `listWorkflowsAction` | `{query?, offset?, limit?}` | `{workflows, total, nextOffset?, omitted}`; entries include name, aliases, specPath, description?, agent?, readOnly? |
| `validateWorkflowAction` | `{workflow}` | `{valid, name?, specPath, workflowName?, type, tasks, roles, maxConcurrency, blockedPermissionPreviews, warnings}` |
| `workflowRolesAction` | `{workflow}` | `{specPath, roles}` |
| `listAgentsAction` | — | `{agents}` with name, displayName, description?, scope, legacySource?, model?, effort?, tools?, readOnly?, sourcePath |
| `showAction` | `{ref, raw?, snapshot?, includeTaskLogs?, includeReport?, includeTask?}` | Run: `{kind: "run", run, launch?, taskLogIds?, report?, runtimeTask?}`; workflow: `{kind: "workflow", specPath, spec}` |
| `profileAction` | list/show/set/delete/default/presets (below) | `{op, path, default?, profiles?, profile?, deleted?, presets?}` |
| `workflowPreferenceAction` | `{op: "list"}` / `{op: "show", workflow}` / `{op: "set", workflow, profile?, roles?, unset?}` / `{op: "clear", workflow}` | `{op, path, workflow?, preference?, preferences?, cleared?}` |
| `runWorkflowAction` | Launch options plus `workflow` | `LaunchData` |
| `runDynamicAction` | Launch options, no `workflow` | `LaunchData`, `mode: "direct-dynamic"` |
| `statusAction` | `{runId?}` | One `{run}` with tasks, pendingApprovals?, parentUsage?; otherwise `{runs}` top-level, newest first |
| `inspectAction` | `{runId, failures?, results?}` | `{run, reliability: {health, outputRetries, launchRetries, resumeEvents, contextLimitFailures}, listed, parentUsage?, launch?}` |
| `logsAction` | `{runId, task?, lines?, stream?}` | Bounded task log tails (below) |
| `waitAction` | `{runId, timeoutMs?, longWait?, signal?, onProgress?}` | `WaitData` |
| `resumeAction` | `{runId, detach?}` | `{runId, status, resetTaskIds, taskSummary, detached?}` |
| `autoAction` | Consent, choice and launch options (below) | `AutoData` |
| `approveAction` | `{runId, requestId?, decision, confirm?, detach?}` | `ApproveData` |
| `stopAction` | `{runId, timeoutMs?}` | `{runId, status, interruptedTaskIds, pending}` |
| `pruneAction` | `{keep?, olderThanDays?, yes?}` or `{argv}` | `WorkflowPruneSummary` |
| `noticesAction` | `{argv}`: list, acknowledge, clear | List: `{notices, acknowledgements, warnings}`; mutation: `{action, runId, notificationOnly}` |
| `doctorAction` | `{prober?, probeTimeoutMs?, nodeVersion?}` | `{host, executors, defaultExecutor, permissionMode, node, home, warnings, runIndex, usable}`; no model call or writes |
| `executorModelsAction` | `{executors?, prober?, timeoutMs?}` | `{executors: [{id, usable, state, models, modelListComplete, note, error?}]}`; default pi/claude/codex, shared 60 s probe cache |
| `superviseAction` | `{runId? \| all, pollMs?, maxRuntimeMs?, onLog?, signal?, testHooks?}` | `{runIds, maxRuntimeMs, runs, result}` |
| `redriveRunsAction` | — | `{redriven, skipped: [{runId, reason: "live-supervisor"}], errors}` |
| `superviseDetachedAction` | `{runId}` | `{runId, status, started, reason?: "not-running" \| "live-supervisor", detached?: {pid, logPath}}` |

Queries and ordinary mutations return `success`; launch/wait/resume/approve return the applicable
run outcome. Prune fails on `summary.error`; doctor fails when no executor is usable. Pending stop
returns `running`. An identical active launch returns `existing`.

Paged catalog output is bounded to 50 KB / 2000 lines; `limit` accepts 1–20, omitted lists every workflow.
`show.snapshot` reads persisted state without refresh, lease or executor polling. `includeTaskLogs`
returns ids with host-verified logs; `includeReport` returns bounded report text; `includeTask`
returns redacted task text up to 8,000 characters, not the workflow description.

`RunSummary` contains runId, name?, status, type, createdAt, updatedAt, parentRunId?, executor?,
executors?, permissionMode?, taskSummary. Mixed-run task summaries include executor/model/effort.

### `run` / `dynamic`

| Launch option | Contract |
|---|---|
| `task` | Required runtime task |
| `executor`, `permissionMode` | Run overrides; mode `free` / `safe` |
| `profile` | Declared profile, saved user profile, then built-in preset (`codex`, `claude`, `pi`, `mixed`); unknown names throw |
| `allowUnverifiedCapabilities` | Capability opt-in keys |
| `model`, `effort` | Overrides for every stage |
| `inputOverrides` | Typed values for declared inputs |
| `detach` | Spawn detached `agent-workflow supervise`; return `{pid, logPath}`, log at `<run dir>/supervise.log` |
| `forceNew` | Bypass duplicate guard |
| `interactive`, `confirmDegradations` | Interactive requires callback; anything except true refuses with `CAPABILITY_DEGRADATION_DECLINED`; non-interactive records degradations |
| `selectProfile(title, options, meta?)` | Declared-profile chooser; `meta.headlessOption` is the default profile, otherwise Base |
| `launchOrigin` | Host command/tool provenance |

With no requested profile: saved workflow preference > saved Pi per-workflow preference (hosts with
`availableModels`) > declared default/chooser > default saved user profile > none. Saved workflow
role assignments apply on every host. A captured user profile supplies executor, permission mode,
strict capabilities and model/effort defaults. Without an artifact graph, executor/mode are run
options and strict capabilities refuse.

`LaunchData` includes mode, runId?, status?, name?, specPath?, executor? `{id, source, profile?,
host?}`, permissionMode? `{mode, source, profile?}`, profile? `{name, kind, source}`, roles?
`{mixed, executors, stages, warnings?}`, capability? `{preview, confirmation, degradations,
forcedReadOnly}`, taskSummary?, detached?, promptSchemaNotice?, duplicateOf?, refusal? `{code,
executorId?, preview?}`. Profile kinds: declared/user/workflow-preference/preset; sources:
request/workflow-default/user-default/workflow-preference. Text starts with capability preview,
then role table and launch card.

Refusals start no run: `EXECUTOR_PROBE_FAILED`, `EXECUTOR_NOT_INSTALLED`,
`EXECUTOR_AUTH_NOT_READY`, `CAPABILITY_REFUSED`, `MODEL_UNKNOWN`,
`CAPABILITY_CONFIRMATION_REQUIRED`, `CAPABILITY_DEGRADATION_DECLINED`, `EXECUTOR_UNAVAILABLE`,
`DUPLICATE_LAUNCH_IN_PROGRESS`, `WORKFLOW_DEFINITION_CHANGED`. Missing role models are refused only
when the probe's model list is complete; partial lists produce a note.

**Duplicate-launch guard.** Every host API launch hashes kind, cwd, resolved spec path/name,
trimmed task, typed inputs, requested execution options, resolved host/executor/profile/preference
snapshot, inherited defaults and workflow definition fingerprint. `detach` and UI hooks are not
part of identity. Settings are resolved once; the engine refuses a changed definition before launch.
CLI/generic installed-default login changes within the guard window are not detected.

An identical non-terminal run (`running`, `pending`, `blocked`) created within 10 minutes returns
`existing`, with `duplicateOf`, and starts no supervisor. Terminal/pruned/older runs or `forceNew`
start a new run. Claims live at `.agent-workflow/host-launches/<sha256>.json`; concurrent callers
wait up to 15 s for the first run id. Claims use owner tokens, per-identity locks and a 60 s lease
renewed every 15 s. Dead same-host owners allow takeover; live or unverifiable owners retain claims
until 1 hour after lease expiry. An ownership check immediately before start prevents stale owners
launching. Background launch cleanup and prune remove old inactive claims; symlinked control roots
refuse pruning, and unrelated files are retained. Direct SDK launches are not guarded.

The handler returns after launch; long-lived hosts retain an unref'd in-process watcher. Short-lived
hosts must wait or detach. Returning an existing attached run does not attach a new supervisor;
`wait`, `resume` or `supervise` can drive it.

**Launch capture.** `run.launch` uses `agent-workflow-run-launch-v1`: source, entry, requestKind,
`routingMode: "off"`, profile, task character/line counts and command size/SHA-256. The redacted
command/tool call is stored as `<run dir>/launch-command.txt` (0600). Sources: cli, pi,
`mcp:<host>`; entries: command/action or tool/name. Missing origin synthesizes a CLI command.
`show` and `inspect` return launch metadata and command text.

Confirmed auto launches use `agent-workflow-run-launch-v2`, `routingMode: "auto-confirmed"`, and
selection: offered candidates, recommendation or null, selected candidate, choseRecommendation,
classifier executor/model, consent source, taskSha256, confirmed true. The selected candidate must
match requestKind. Classifier reasons are not persisted.

### `logs`

`LogsData`: runId, name?, status, lines, streams, tasks (taskId, specId, status, statusDetail,
streams with kind/path/lines/truncated), omittedTasks, truncated. `stream` selects output, stderr
or events. `task` accepts task/spec id; unknown throws. Without task, return at most six most
recently started tasks. Lines per stream: 1–400, default 20; each line capped at 400 characters;
text and data stop at 48,000 characters. The run is refreshed first.

Read paths must be project-relative, without `..`, and resolve inside `.agent-workflow/`; absolute,
traversal and symlink escapes are not read and get `refused` reasons. Inspect results and result
presentation enforce the same artifact boundary. Credential assignments, structured/escaped JSON
secrets, authorization/cookie/API-key headers, bearer tokens, URL secrets, sensitive environment
values (8+ characters), and macOS/Linux/Windows home paths are redacted. Malformed quoted
credentials fail closed through the rest of the line. The same redactor covers show/status/inspect,
wait previews and Pi completion messages.

### `wait`

A normal call drives scheduling for at most 45 s (default and cap; minimum 1 s). Repeat while
`stillRunning`. Cancelling `signal` cancels only the wait. `longWait: true` is for hosts without
per-call limits: default 30 minutes, cap 4 hours. `timeoutMs` in data is the effective bound.

`WaitData`: runId, status, semanticStatus, terminal, actionRequired, stillRunning, timeoutMs,
blockedTaskIds, taskSummary, outputTaskIds, outputRetryAttempts, launchRetryAttempts, artifactRoot,
nextRetry?, verdict?, verdictGate?, preview?, reportArtifacts, usage?, degradation?, pendingApprovals?,
dashboard?. `onProgress` receives a RunSummary.

| State | terminal | actionRequired | stillRunning |
|---|---|---|---|
| Bound reached while running | false | false | true |
| Blocked | false | true | false |
| Completed/failed/interrupted | true | false | false |

`preview` is the first completed output task's `completionSummaryMarkdown`, otherwise summaries/
reports, capped at 6,000 characters. Successful text is the preview alone. `reportArtifacts` lists
report/audit paths; dashboard links open report view when appropriate.

`verdictGate` also permits a declared-failed output task when every other task completed/skipped,
the task has a nonempty domain verdict, and an existing final report resolves inside the run's own
directory. Text then says “Workflow finished — verdict: X (report ready)”; status/outcome remain
failed (CLI exit 1). Generic support failures do not qualify. Terminal `statusAction` uses the same
presentation. `nextRetry` is `{at, retryAfterMs, reason?, message?, taskIds}` when the only remaining
work is in retry backoff.

### `approve`

Dynamic controllers with `dynamic.permissions.approval: "ask"` use `ctx.dynamicUi` while attached;
without UI they block as `dynamic_ui_unavailable`, or `dynamic_approval_timeout` after an unanswered
prompt. Status/wait expose `pendingApprovals`: requestId, controllerSpecId, taskId, title, message,
requestedAt.

`decision` is approve/reject. `requestId` accepts a unique prefix of at least eight characters and
is optional with one open approval. Optional `confirm(title, message)` is bounded to five minutes:
true applies; false rejects an approval question but does nothing on a rejection question;
undefined/cancel/error/timeout records nothing and returns refused. Without confirm the decision
is final. Decisions are appended under the run lease with host/via provenance. Rejection marks
`dynamic_approval_rejected`. Approval resumes unless other failed/interrupted/blocked tasks remain;
then it records the approval and returns blocked.

`ApproveData`: runId, requestId, controllerSpecId, decision (approved/rejected/unanswered), status,
decidedBy?, resumed?, otherBlockers?.

### `auto`

`AutoRequest` takes launch options without workflow, plus `consent`, `choose`, `compare?`, `signal?`.
No consent means no classifier call. Consent is `{source: "flag"}` or prompt/elicitation with
`confirm(title, message, preview)`. The preview includes task text capped at 2,000 characters,
candidate names and classifier executor/model. False declines; undefined/error cancels.

The classifier target follows request > named/default saved profile (`executor` or roles.default) >
host default override > host executor. Model/effort follow request > profile > matching host runtime
defaults > executor default. Exactly one classifier call ranks a local shortlist; tasks forbidding
external models or exceeding 24 KB are refused. `choose` receives title, message, choices and
recommendedId?, returning a candidateId or undefined. Without choose, ranking is returned and
nothing starts. The selected workflow is rehashed before launch; changed specs return stale.

`compare(operation)` wraps the classifier call, passing a cancel signal; undefined means cancelled.
The action signal is checked after consent, classification and choice; late output is discarded.
`AutoData` includes phase, classifierCalled, classifier?, consent?, shortlist, status?, reason?,
recommendation?, ranked?, selected?, launch?, next?. Phases: consent-unavailable, consent-declined,
consent-cancelled, classifier-unavailable, ranked, cancelled, stale, launched. Candidate views carry
candidateId, kind, label, scope, description, launchable, blockers?, fit?, reason?, recommended?,
command?. Reasons are bounded and control characters replaced; commands use `<task>` placeholders.

### `stop`

Writes durable stop intent. If another supervisor holds the lease, retry for `timeoutMs` (default
15 s), then return `pending: true`, outcome running. The active supervisor applies the intent.

### `supervise`

Schedules a run or all running top-level runs until terminal; failure takes precedence over blocked;
an empty batch succeeds. `maxRuntimeMs`: default 4 hours, 0 unlimited; a single running workflow
with `maxRounds: null` defaults to unlimited. `onLog` receives progress lines; testHooks are test-only.

`redriveRunsAction` schedules once, then watches runs with scheduler work that no other live process
drives; blocked stays blocked, unknown reconcile needs a decision. It binds no delivery audience.
`superviseDetachedAction` starts a standalone supervisor unless no work remains or another process
holds the lease/has a live-pid heartbeat younger than 30 s.

## Parsers

String-based hosts can use `parseWorkflowRunArgs`, `parseWorkflowDynamicArgs`,
`parseWorkflowPruneArgs`, `parseSuperviseArgs`, `tokenizeWorkflowArgs`, `parseDuration`,
`parsePermissionMode`, `parseThinkingLevel`, `parseCapabilityList`. Run/dynamic accept leading or
trailing options; quoted text is literal. Duplicate options and `--route` / `--no-route` are
rejected. Options include model, profile, effort (thinking/reasoning aliases), executor,
permission-mode, allow-unverified, detach and force-new.

Also exported: `selectWorkflowExecutionProfile`, `resolveWorkflowExecutionProfileForLaunch`,
`spawnDetachedSupervisor`, `agentWorkflowCliPath`, `readWorkflowResultPresentation`.

## Saved user profiles

`profileAction` operations: list, show(name?), set(name, values?, unset?, makeDefault?, preset?),
delete(name), default(name or null), presets. Role values and `unset: ["roles.<role>"]` are
supported. Workflow preferences accept name/spec path, key by spec.name, and validate referenced
profiles and executor ids.

Profiles live in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json`, private file/directory,
schema `agent-workflow-user-profiles-v1`, with default? and profiles keyed by name. Values include
executor?, model?, effort?, permissionMode?, strictCapabilities?, roles?, updatedAt. Names are
1–64 characters of `[A-Za-z0-9._-]`. Reads/writes reject unknown fields and invalid values; malformed
files are reported, never rewritten. Workflow preferences use `workflow-preferences/v1` separately.

## Test-executor hook

CLI-only `registerTestExecutorFromEnv(env)` loads `testExecutorDescriptor` from an absolute
`AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` only with `AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only` and an
id beginning `test-`; otherwise throws `TestExecutorHookError`. Handlers never invoke it.

## Not in the host API

Pi completion delivery/audiences/receipts, footer, parent-session usage tracking, session-start
notices, board and profile-picker UI belong to the [Pi host](pi-host.md), not shared handlers.
