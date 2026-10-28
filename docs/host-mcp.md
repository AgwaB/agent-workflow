# Host MCP server (`agent-workflow-mcp`)

WP13. A stdio MCP server named `agent-workflow` that lets an agent host (Claude Code, Codex, any MCP
client) run and manage agent-workflow workflows during a conversation. Each tool is a thin call into
one [host API](host-api.md) handler, so results match the `agent-workflow` CLI's `--json` output.
Source: `src/mcp/host-server/` (`tools.ts` tools and schemas, `serve.ts` wiring, `server.ts` entry,
`bin.mjs` launcher). Protocol layer: `src/mcp/stdio-server.ts`, shared with the
[`workflow_artifact` server](mcp.md).

## Start

```
agent-workflow-mcp --host <claude-code|codex|generic>
node <package>/dist/mcp/host-server/server.js --host <claude-code|codex|generic>
```

- `--host` is required and names the calling host. It reaches every handler as
  `HostApiContext.host`; the stage-2 default-executor rule (host's own CLI, WP17) reads it.
- **Project = working directory.** The server's working directory (resolved through symlinks) is its
  project root. Register the server so the host starts it in the project.
- Registration without a plugin (the plugins are WP14/WP15, [plugins.md](plugins.md)):
  `claude mcp add agent-workflow -- agent-workflow-mcp --host claude-code`,
  `codex mcp add agent-workflow -- agent-workflow-mcp --host codex`.
- Exit codes: `2` usage (missing/unknown `--host`, unknown flag), `1` refused to start (a misconfigured
  test-executor hook), `0` on stdin EOF, SIGTERM or SIGINT (in-flight calls answer first; at most 5 s
  after a signal).
- stdout is protocol only; diagnostics go to stderr. The guarded test-executor hook of the CLI
  (`AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` + `..._ACK=test-only`, [cli.md](cli.md)) works the same way.

## Call protocol (server `instructions`)

1. `workflow_list` when the workflow name is uncertain; never guess names.
2. `workflow_run {workflow, task}` (or `workflow_dynamic {task}`) launches and returns the `runId`.
3. `workflow_wait {runId}` waits **at most 45 s** per call (Codex `tool_timeout_sec` defaults to 60 s).
   While `stillRunning` is true, call it again with the same `runId`. `terminal: true` = finished;
   `actionRequired: true` = blocked (report it, use `workflow_inspect`; the user resumes with
   `agent-workflow resume <runId>`).
4. When finished, quote the result preview and give the report paths verbatim; do not paraphrase.
   A result headed `Workflow finished — verdict: X (report ready)` (`verdictGate: true`, footer
   `verdict=X`) is the workflow's result with a non-passing verdict, not a workflow failure (WP18b).
   WP19: `verdictGate` is set only with a declared domain verdict and a report file inside the run
   directory; every other failed run is a real failure and is reported as one.
5. No completion push (WP18b): a run reports only through `workflow_wait`/`workflow_status`. If it is
   still running when the host stops waiting (for example a 15-minute rate-limit backoff; the wait
   result's `nextRetry` and the footer's `nextRetryAt=` give the retry time and reason), the host
   tells the user the `runId`, what the run waits for, and that they can ask again.
6. WP28: the other CLI commands are tools. `workflow_resume` and `workflow_supervise` start model
   calls (cost), so only on request; the changing calls below ask the user first.
7. WP29: a run blocked on a dynamic-controller approval has `pendingApprovals` (the question and its
   `requestId`) in `workflow_wait`/`workflow_status`. The host shows the user the question; only
   after the user decides it calls `workflow_approve {runId, requestId, decision}`, which asks the
   user again in a dialog.

Permission mode is `free` by default ([permissions.md](permissions.md)); `safe` only on request.
Executor: omit it to use the workflow profile or the host default; set `executor`/`profile` only
when the user asks.

## Tools

Every tool takes an optional `cwd` (see below). Unknown parameters are refused.

| Tool | Arguments | Host API handler | `data` |
|---|---|---|---|
| `workflow_list` | `query?`, `offset?`, `limit?` (1-20, default 20) | `listWorkflowsAction` | `ListData` |
| `workflow_run` | `workflow`, `task`, launch options | `runWorkflowAction` | `LaunchData` |
| `workflow_dynamic` | `task`, launch options | `runDynamicAction` | `LaunchData` |
| `workflow_status` | `runId?` | `statusAction` | `StatusData` |
| `workflow_wait` | `runId`, `timeoutMs?` (1 000-45 000) | `waitAction` | `WaitData` (`terminal`, `actionRequired`, `stillRunning`, `status`, `preview`, `reportArtifacts`, …) |
| `workflow_stop` | `runId` | `stopAction` | `StopData` (`pending` when another supervisor applies it) |
| `workflow_inspect` | `runId`, `failures?`, `results?` | `inspectAction` | `{run, reliability, listed}`; `run` is the run summary plus brief task rows instead of the full run record |
| `workflow_logs` (WP18b) | `runId`, `task?`, `lines?` (1-400, default 20), `stream?` (`output`/`stderr`/`events`/`all`) | `logsAction` | `LogsData` (bounded, redacted tails per task; WP19: only files inside `.agent-workflow/`, tampered or symlinked paths are refused with a reason; structured credentials and Linux/Windows/macOS home paths redacted, also in `workflow_wait`/`workflow_status` text and previews) |
| `workflow_validate` | `workflow` | `validateWorkflowAction` | `ValidateData` |
| `workflow_resume` (WP28) | `runId`, `detach?` (default true) | `resumeAction` | `ResumeData`; the description says it continues the run and starts model calls (cost) |
| `workflow_show` (WP28) | `ref`, `raw?` | `showAction` | `{kind: "workflow", specPath, spec}` or `{kind: "run", run}` with the run projected like `workflow_inspect` |
| `workflow_roles` (WP28) | `workflow` | `workflowRolesAction` | `RolesData` |
| `workflow_agents` (WP28) | — | `listAgentsAction` | `{agents}` |
| `workflow_notices` (WP28) | `action?` (`list` default, `acknowledge`, `clear`), `runId?`, `state?`, `reason?` | `noticesAction` | list: `{notices, acknowledgements, warnings}`; else `{action, runId, notificationOnly}`. **acknowledge/clear confirm** |
| `workflow_doctor` (WP28) | — | `doctorAction` | `DoctorData` (no model call, nothing written) |
| `workflow_prune` (WP28) | `keep?`, `olderThanDays?`, `dryRun?` (default true) | `pruneAction` | the prune summary; **`dryRun: false` confirms** (the dialog shows the dry run first) |
| `workflow_profile` (WP28, WP31) | `op?` (`list` default, `show`, `set`, `delete`, `default`, `clear-default`, `presets`, `workflow-list`, `workflow-show`, `workflow-set`, `workflow-clear`), `name?`, set: `executor?`, `model?`, `effort?`, `permissionMode?`, `strictCapabilities?`, `preset?`, `roles?` (role → `{executor?, model?, effort?}`), `unset?` (also `roles.<role>`), `makeDefault?`; workflow-*: `workflow`, workflow-set: `profile?`, `roles?`, `unset?` | `profileAction`, `workflowPreferenceAction` | `ProfileData` / `WorkflowPreferenceData`; **set/delete/default/clear-default/workflow-set/workflow-clear confirm** |
| `workflow_supervise` (WP28) | `runId` | `superviseDetachedAction` | `{runId, status, started, reason?: not-running \| live-supervisor, detached?}`: spawns `agent-workflow supervise <run>` for a running run no live process drives (the CLI's foreground `supervise` would outlast a tool call) |
| `workflow_approve` (WP29) | `runId`, `requestId`, `decision` (`approve`/`reject`), `detach?` (default true) | `approveAction` | `ApproveData` (`decision: approved \| rejected \| unanswered`, `resumed?`, `otherBlockers?`); **always confirms** (below) |

Launch options (same as the CLI flags and Pi's `aw_run`): `executor`, `profile`, `permissionMode`
(`free`/`safe`), `allowUnverified` (capability keys), `model`, `effort`, `inputs` (declared workflow
inputs), `forceNew`, and `detach`, which **defaults to true** here: MCP calls are time-limited, so a
standalone supervisor (`agent-workflow supervise`, log `<run dir>/supervise.log`) keeps the run going
between calls and after the server exits. `detach: false` keeps the run in the server process only.
A retried identical launch (same workflow, task, inputs and options) while the first run is still
active returns that run with `outcome: "existing"` instead of starting another (WP16 duplicate guard,
`host-api.md`; WP19 round 2: a retry that arrives while the first launch is still starting is
refused as `DUPLICATE_LAUNCH_IN_PROGRESS` even if the first launch's lease expired, and a changed saved
user profile is a new launch); `forceNew: true` starts a new run. The text and
logs redaction keeps report prose such as `Exit code: 1` and redacts escaped-quote credentials
(WP19 round 2, `host-api.md`); WP19 round 3: values under credential headers (`Authorization`,
`x-api-key`, `Cookie`, `*-token`, …) are always redacted, whatever their length. `workflow_logs` (WP18b), `agent-workflow logs` and Pi's
`/aw logs` call the same `logs` handler.

Annotations: `list`, `status`, `inspect`, `logs`, `validate`, `show`, `roles`, `agents`, `doctor` are
read-only; `run`, `dynamic`, `stop`, `resume`, `prune`, `profile`, `approve` are destructive; `wait`, `notices` and
`supervise` are neither. `title` is sent from
`2025-06-18`, `annotations` from `2025-03-26` (same gating as the artifact server).

## Results

- `content`: one text item, the handler's `text` (bounded to 50 000 characters) plus, for run,
  dynamic, wait and a pending stop, a short "next step" footer, for example
  `[workflow_wait] runId=… status=running terminal=false actionRequired=false stillRunning=true` and
  `Next: call workflow_wait {"runId":"…"} again.`
- `structuredContent` (from `2025-06-18`): `{action, ok, outcome, data, text, next?}`; `data` equals
  the host API's (and the CLI `--json`) `data`, except for the inspect projection above.
- **Per host (WP18b):** `--host claude-code` gets the text `content` only, never
  `structuredContent` (`HOST_MCP_TEXT_ONLY_HOSTS`). Evidence: live bundle 4 case 1
  ([live-acceptance-stage2.md](live-acceptance-stage2.md)), Claude Code 2.1.310 handed the model
  the serialized `structuredContent` JSON instead of `content`, so every result reached the model
  twice (`data` and the same `text`). The tools declare no `outputSchema`, so `structuredContent`
  is optional. `codex` and `generic` keep it (Codex's rendering is not observed live yet).
- `isError: true` for a refused launch (`outcome: "refused"`: capability refusal, unavailable
  executor, declined confirmation, an identical launch still starting) and for handler errors:
  `structuredContent: {ok: false, outcome: kind, error: {kind, message}}` with `kind` `usage`
  (`HostUsageError`, text prefixed `Usage error:`), `validation` (invalid spec) or `error` (for
  example an unknown run). Tool-level errors let the model correct the call (MCP guidance).
- JSON-RPC errors only for protocol problems: unknown tool or non-object `arguments` (`-32602`),
  unknown method (`-32601`), requests before `initialize` (`-32600`).
- Worker processes (`AGENT_WORKFLOW_ROLE=worker`) may only `workflow_validate` (host API role check).

## Degradation confirmation (elicitation)

A launch whose capability check needs confirmation (WP4d; for example environment warnings in
`safe` mode):

- If the client declared `capabilities.elicitation` with form mode (`{}` or `{form: …}`) and the
  session is `2025-06-18` or later, the server sends `elicitation/create` with message
  `Proceed with these executor capability degradations?` plus the capability preview and an empty
  form (`requestedSchema: {type: "object", properties: {}}`; `mode: "form"` on `2025-11-25`).
  `accept` proceeds (`capability.confirmation: "confirmed"`); `decline`, `cancel`, an error
  response, a cancelled tool call or a disconnect refuse the launch
  (`CAPABILITY_DEGRADATION_DECLINED`).
- Otherwise (no elicitation, URL-only elicitation, older revision) the launch is non-interactive:
  degradations are recorded (`confirmation: "non-interactive"`) and the run proceeds.

## Confirmed changes (WP28, owner decision Q7)

`workflow_prune` with `dryRun: false`, `workflow_profile` `set`/`delete`/`default`/`clear-default`/
`workflow-set`/`workflow-clear` (WP31: the per-workflow preference; the terminal command is
`agent-workflow profile workflow set|clear …`) and
`workflow_notices` `acknowledge`/`clear` change state only after the user confirms. Arguments are
checked first (a usage error never asks). Then, through the same elicitation helper as above
(`elicitConfirmation`):

- Client with form elicitation: one `elicitation/create` whose message names the change
  (`Save the agent-workflow user profile "fast"?` plus the fields; prune adds its dry run; notices
  the reason). `accept` acts; `decline`, `cancel`, an error response or a failed request change
  nothing: `isError: true`, `outcome: "refused"`, `data: {confirmation: "declined" | "cancelled",
  command, changed: false}`.
- Client without form elicitation (no capability, URL-only, before `2025-06-18`): refused the same
  way with `confirmation: "unsupported"`; the text names the terminal command, for example
  `agent-workflow profile set fast --executor codex --default` (with `cd <dir> &&` for a `cwd` below
  the root).

Read-only calls, `workflow_prune` dry runs, `workflow_resume` and `workflow_supervise` never ask
(resume and supervise state their cost in the description instead).

Hints (WP18b) now name `workflow_resume {"runId":…}` for resume and `workflow_show {"ref":…,"raw":true}`
for the raw run view; a blocked `workflow_wait` footer offers `workflow_resume` after the user agrees.

## Dynamic-controller approval (WP29)

A dynamic stage whose controller declares `dynamic.permissions.approval: "ask"` runs only after the
user's approval ([usage.md](usage.md#dynamic-approval)). The server can ask its user only inside a
tool call, so it never approves while it drives a run (it passes no `dynamicUi`): such a run blocks
as `dynamic_ui_unavailable`, and the design is ask-on-answer:

1. **Surface.** `workflow_wait` (with `actionRequired: true`) and `workflow_status {runId}` return
   `pendingApprovals: [{requestId, controllerSpecId, taskId, title, message, requestedAt}]`; the text
   adds an `Awaiting approval` block with the question and the `workflow_approve` calls for approve
   and reject, and the footer says to show the user the question and call `workflow_approve` only
   after the user decided.
2. **Answer.** `workflow_approve {runId, requestId, decision}` sends one `elicitation/create` through
   `elicitConfirmation` with `Run dynamic workflow controller?` (or `Reject dynamic workflow
   controller?`) and the approval scope. For `approve`: `accept` records the approval and resumes the
   run (detached by default; completed tasks are not relaunched); `decline` is pi-workflow's "no" and
   rejects the controller for this run (`dynamic_approval_rejected`, never asked again). For
   `reject`: `accept` rejects; `decline` changes nothing. `cancel`, an error response or a failed
   request record nothing (`decision: "unanswered"`, `isError`, `outcome: "refused"`).
3. **No elicitation.** A client without form elicitation is refused before anything is read or
   recorded (`confirmation: "unsupported"`) with the terminal command, for example
   `agent-workflow approve <run> --request <requestId>` (`--reject` for a rejection).

Why this design: the elicitation is tied to the user's explicit decision in one short tool call
instead of a dialog popping up inside a 45 s `workflow_wait`; the model can never approve on its
own (the user confirms in the dialog), a stale request id cannot approve a changed scope (the
request id is the approval digest), and the decision is recorded on the run
(`decidedBy: {host: "<--host>", via: "approve"}`).

## `cwd`

Optional on every tool. Relative paths resolve against the root. After resolving symlinks the target
must be the root or an existing directory below it; anything else (`..`, an absolute path outside, a
symlink escaping the root, a missing path, a file) is a usage error. Runs launched with a `cwd` live
in that directory's run store (`<cwd>/.agent-workflow/`), so later calls must pass the same `cwd`.

## Cancellation and progress

`notifications/cancelled` for a running call aborts it (for `workflow_wait` only the wait, never the
run) and no response is sent. A `workflow_wait` call with `_meta.progressToken` gets
`notifications/progress` (`progress` counts updates, `message` = completed/total/running).

## Tests

`test/unit/mcp-host-tools.test.mjs` (fake client, in-process: every tool, equality with the host API
and CLI `--json`, wait cap and loop, progress, cancellation, elicitation accept/decline/error/absent,
cwd rule, usage errors, host identity, role check), `mcp-host-sdk-interop.test.mjs` (official SDK
client over stdio with the test-executor hook, including SDK elicitation), `mcp-host-protocol.test.mjs`
(startup arguments, framing and lifecycle), `mcp-host-wp28-tools.test.mjs` (WP28: every new tool
against the host API and CLI `--json`, confirmation refused without elicitation, declined/cancelled/
error change nothing, accept acts, dry-run prune and read-only calls never ask, usage errors before
any dialog), SDK cases in `mcp-host-sdk-interop.test.mjs` (confirmed profile changes, dry-run prune,
`workflow_supervise` driving a run whose attached server was killed), and the E2E case
`packed-mcp-host` (packed bin: list → run → wait loop → inspect → show). WP29:
`mcp-host-wp29-approve.test.mjs` (pending approvals in wait/status, `workflow_approve` refused
without elicitation, accept continues, decline rejects, cancel/error record nothing, reject).

## Open items

- WP14/WP15 ([plugins.md](plugins.md)): the plugin manifests register
  `agent-workflow-mcp --host claude-code|codex`. Offline checks: both hosts start the plugin
  server in the project directory. Live bundle 4 verified Claude Code (tool names, server cwd;
  it shows `structuredContent` when present, so it gets `content` only since WP18b). Still
  live-only: Codex's tool names in a model turn, whether Codex shows `content` or
  `structuredContent`, and elicitation support in practice.
- WP17: default executor from `ctx.host`; until then an omitted `executor` uses the engine default.
