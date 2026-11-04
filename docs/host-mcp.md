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
5. No completion push (WP18b; WP36 below): a run reports only through `workflow_wait`/`workflow_status`.
   If it is still running when the host stops waiting (for example a 15-minute rate-limit backoff;
   the wait result's `nextRetry` and the footer's `nextRetryAt=` give the retry time and reason), the
   host tells the user the `runId`, what the run waits for, that they can ask again, and (WP36) that
   they can follow it with `agent-workflow watch <runId>` in a terminal or Claude Code's
   `agent-workflow statusline`. A later `agent-workflow: workflow … finished — …` line in the
   conversation comes from the completion check; the host relays it.
6. WP28: the other CLI commands are tools. `workflow_resume` and `workflow_supervise` start model
   calls (cost), so only on request; the changing calls below ask the user first.
7. WP29: a run blocked on a dynamic-controller approval has `pendingApprovals` (the question and its
   `requestId`) in `workflow_wait`/`workflow_status`. The host shows the user the question; only
   after the user decides it calls `workflow_approve {runId, requestId, decision}`, which asks the
   user again in a dialog.
8. WP32: when the user asks the host to pick a workflow for a task (instead of naming one), the
   host calls `workflow_auto {task}`. It asks the user before it sends the task to one classifier
   request and lets the user choose the workflow (below). Without dialog support it sends nothing
   and returns a local shortlist; the host shows it and calls `workflow_run` with the user's pick.

Permission mode is `free` by default ([permissions.md](permissions.md)); `safe` only on request.
Executor: omit it to use the workflow profile or the host default; set `executor`/`profile` only
when the user asks.

## Tools

Every tool takes an optional `cwd` (see below). Unknown parameters are refused.

| Tool | Arguments | Host API handler | `data` |
|---|---|---|---|
| `workflow_dashboard` (WP43b) | `run?` (full id: `^workflow_[A-Za-z0-9_-]+$`) | dashboard discovery / launch URL | `{running, port, opened, method}` (top-level structured content; no credentials) |
| `workflow_list` | `query?`, `offset?`, `limit?` (1-20, default 20) | `listWorkflowsAction` | `ListData` |
| `workflow_run` | `workflow`, `task`, launch options | `runWorkflowAction` | `LaunchData` |
| `workflow_dynamic` | `task`, launch options | `runDynamicAction` | `LaunchData` |
| `workflow_status` | `runId?` | `statusAction` | `StatusData` |
| `workflow_wait` | `runId`, `timeoutMs?` (1 000-45 000) | `waitAction` | `WaitData` (`terminal`, `actionRequired`, `stillRunning`, `status`, `preview`, `reportArtifacts`, …) |
| `workflow_stop` | `runId` | `stopAction` | `StopData` (`pending` when another supervisor applies it) |
| `workflow_inspect` | `runId`, `failures?`, `results?` | `inspectAction` | `{run, reliability, listed}`; `run` is the run summary plus brief task rows instead of the full run record |
| `workflow_logs` (WP18b) | `runId`, `task?`, `lines?` (1-400, default 20), `stream?` (`output`/`stderr`/`events`/`all`) | `logsAction` | `LogsData` (bounded, redacted tails per task; WP19: only files inside `.agent-workflow/`, tampered or symlinked paths are refused with a reason; structured credentials and Linux/Windows/macOS home paths redacted, also in `workflow_wait`/`workflow_status` text and previews) |
| `workflow_validate` | `workflow` | `validateWorkflowAction` | `ValidateData` |
| `workflow_check` | `workflow`, `task?`, `executor?`, `profile?`, `permissionMode?`, `allowUnverified?`, `model?`, `effort?`, `inputs?` | `checkWorkflowAction` (2026-10-30: the launch preflight, no run) | `LaunchData` (`capability`; `refusal` when a run would not start) |
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
| `workflow_auto` (WP32) | `task`, launch options | `autoAction` | `AutoData` (`phase`, `classifierCalled`, `classifier`, `consent`, `shortlist`, `recommendation?`, `ranked?`, `selected?`, `launch?`); **asks consent before its one classifier request and then the choice** (below) |

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
read-only; `run`, `dynamic`, `auto`, `stop`, `resume`, `prune`, `profile`, `approve` are destructive; `wait`, `notices` and
`supervise` and `dashboard` are neither. `dashboard` mutates local process state only (never runs) and uses the same role gate as `stop`. `title` is sent from
`2025-06-18`, `annotations` from `2025-03-26` (same gating as the artifact server).

## Results

- `content`: one text item, the handler's `text` (bounded to 50 000 characters) plus, for run,
  dynamic, wait and a pending stop, a short "next step" footer, for example
  `[workflow_wait] runId=… status=running terminal=false actionRequired=false stillRunning=true` and
  `Next: call workflow_wait {"runId":"…"} again.`
- `structuredContent` (from `2025-06-18`): `{action, ok, outcome, data, text, next?}`; `data` equals
  the host API's (and the CLI `--json`) `data`, except for the inspect projection above.
- **Per host (WP18b):** `--host claude-code` gets the text `content` only, without
  `structuredContent` for host API results (`HOST_MCP_TEXT_ONLY_HOSTS`). Evidence: live bundle 4 case 1
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
- Worker processes (`AGENT_WORKFLOW_ROLE=worker`) may only `workflow_validate` and `workflow_check` (host API role check; `check` uses the `validate` permission).

## Dashboard opening (WP43b)

`workflow_run`, `workflow_dynamic` and a launched `workflow_auto` preserve the token-free
`Dashboard: http://127.0.0.1:<port>/?run=<id>` line on every successful launch, auto-starting a detached server when needed (unless disabled or startup fails).
The launch data includes `dashboard: {url, port, started?: true, auth?: true}` (`workflow_auto`: `data.launch.dashboard`) and the
text's `Dashboard:` line sits right under the run heading (`Dashboard: not running · agent-workflow
dashboard --open` when auto-start is off or fails); the `Next:` guidance tells the model to report the run id and that
link to the user before waiting, then call `workflow_dashboard` if the user wants it opened for
them (or, when the dashboard runs with sign-in — `auth: true` — says the link asks them to sign in).
The link opens directly by default: the dashboard has no sign-in unless started with `--auth` /
`AGENT_WORKFLOW_DASHBOARD_AUTH=1`. Launches auto-start the server but never open a browser themselves.

`workflow_dashboard {run?}` ensures a dashboard is running for the call's project, starting it
detached if needed, and mints a launch URL (a launch id by default; a one-time sign-in token under
`--auth`). Then, by what the client can show:

- **URL elicitation** (protocol **2025-11-25** or later with `capabilities.elicitation.url`; Claude
  Code ≥ 2.1.87): one `elicitation/create` with `mode: "url"` — the client asks the user and opens
  the browser on acceptance; once the browser has arrived (the launch id, or under `--auth` the
  one-time token, was consumed; the server polls `GET /api/launch/:id`) the server sends
  `notifications/elicitation/complete`, so the client stops waiting. `method: "url-elicitation"`.
- **Form elicitation only** (Codex today, openai/codex#29344): one form dialog "Open the
  agent-workflow dashboard for <project> in your browser?"; on accept the MCP server — which runs on
  the user's machine over stdio — opens the browser itself (`BROWSER`/`BROWSER_ARGS` honored), as
  `/aw dashboard` does in Pi. `method: "form-consent"`. Decline/cancel: `opened: false`, nothing opens.
- **No dialogs**: instructions only — `Dashboard is running on 127.0.0.1:<port>; open it from a
  terminal with agent-workflow dashboard --open (project <dir>)`. `method: "instructions"`.

The one-time URL travels only in the elicitation request or to the local browser, never in the tool
result; neither the session token nor the launch key is returned. On protocols supporting structured
content this tool returns the compact top-level `{running, port, opened, method}` even for Claude Code
(an exception to host API text-only results). Startup failures return `isError: true` with a reason.
This tool is not a confirmed run change: it starts a local process but changes nothing in runs.

## Run id and dashboard link in the agent's message (2026-11-03)

Owner (the Claude desktop app's chat): after a launch the agent said "you can follow it in the
dashboard" without the link; the app folds tool results, so the link in the result was not seen.
A launch result's next step now names the run and the link itself ("Now tell the user, in your own
message (some apps fold tool results): run <id>, Dashboard: <url> — the link as is. Then call
workflow_wait …"; without a dashboard: the run id and that `workflow_dashboard` opens it), and a
finished `workflow_wait` asks to include the link as is. The server instructions say the same and
stay under 4,096 characters: Claude Code keeps only that much ("Server instructions truncated from
4508 to 4096 chars" in its MCP log), which had cut the dashboard and `cwd` lines.

## Degradation confirmation (elicitation)

A launch whose capability check needs confirmation (WP4d; for example environment warnings in
`safe` mode) is asked; one whose limits are only recorded (free-mode-accepted, record-only such as
unknown cost) starts without a question (`confirmation: "not-needed"`). 2026-11-04 (owner: "if
confirmation is required, ask; otherwise skip"):

- If the client declared `capabilities.elicitation` with form mode (`{}` or `{form: …}`) and the
  session is `2025-06-18` or later, the server sends `elicitation/create` with message
  `Proceed with these executor capability degradations?` plus the preview's short `prompt` (2026-11-03,
  owner: the full per-stage report made a 30+ line dialog): executor · stages · permission mode, the
  limits that need the user's OK once each with the stages they cover (an environment warning names
  what was found), one line of limits that are only recorded, and a note that the full report is
  saved with the run (`capabilityNegotiation`; the terminal CLI still prints it) — and an empty
  form (`requestedSchema: {type: "object", properties: {}}`; `mode: "form"` on `2025-11-25`).
  `accept` proceeds (`capability.confirmation: "confirmed"`, `confirmedVia: "dialog"`); `decline`
  is the user's no (`CAPABILITY_DEGRADATION_DECLINED`).
  A `cancel` or an error response is the client's, not the user's: Claude Code in print mode (the
  Claude desktop app's Code tab, the Agent SDK without an `onElicitation` callback) declares
  elicitation but answers every dialog with `cancel` at once (its MCP log: "Elicitation request
  received in print mode"; claude-agent-acp `src/acp-agent.ts` keeps "the SDK's default
  (auto-decline) behavior" for such clients); agy (Antigravity CLI, 2026-11-04 session
  `fad55d42…`) does the same. That launch is not started (`CAPABILITY_CONFIRMATION_REQUIRED`, "the
  user was not asked yet") and is asked in the conversation (below).
- Otherwise (no elicitation, URL-only elicitation, older revision — the Claude desktop app's chat)
  the server sends no dialog and the launch is not started (`CAPABILITY_CONFIRMATION_REQUIRED`)
  either. Before 2026-11-04 it was non-interactive: recorded (`confirmation: "non-interactive"`)
  and started unasked.
- Asking in the conversation (2026-11-03, generalized 2026-11-04): the refusal says "Nothing
  started: this run needs the user's OK, and this client could not ask them in a dialog", carries
  the short limits text, and tells the agent to ask the user in its reply and, only if they agree,
  call again with `acceptDegradations` naming the keys it lists (`preview.needsOk`, e.g.
  `["webTools"]`). With keys that cover every limit that needs an OK the server asks nothing and
  the run starts with `capability.confirmation: "confirmed"` and `confirmedVia: "chat"` (run
  record and launch result); keys that do not cover them refuse the launch. The tool description
  tells the agent never to set it on its own. Verified with agy: the agent asked in chat, the user
  agreed, the second call started `workflow_mw1fr3yo_b1f2d6` (`confirmedVia: "chat"`).

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

### Codex `approval_policy = "never"` (owner decision O2, 2026-10-28)

The server respects the client's policy. Codex with `approval_policy = "never"` answers every
empty confirm form (`elicitation/create` without fields) itself with `accept`, without showing a
dialog; agent-workflow treats that as the user's consent, consistent with the permission mode
`free` ("approve everything"). This covers the `workflow_auto` consent (recorded as consent
`elicitation`; one classifier request is sent), the degradation confirmation, `workflow_approve`
and the confirmed changes (`workflow_profile`, `workflow_prune`, `workflow_notices`). Forms with a
required field (the `workflow_auto` choice) are cancelled by Codex under that policy, so nothing
starts from `workflow_auto` without a choice. To be asked, run Codex with
`-c approval_policy="on-request"` (or set it in `~/.codex/config.toml`); live bundle 5 showed both
dialogs there.

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
   run (detached by default; completed tasks are not relaunched); `decline` rejects the
   controller for this run (`dynamic_approval_rejected`, never asked again). For
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

## Auto workflow selection (WP32, owner decision Q5)

`workflow_auto {task, …launch options}` is the MCP form of `agent-workflow auto`:

1. **Local shortlist.** The dynamic workflow and the discoverable workflows (at most 24), ranked by
   the task's words against each spec's `routing` hints. No model call.
2. **Consent.** One `elicitation/create` (`elicitConfirmation`) titled `Send this task to
   <executor> to compare workflows?` shows the task, the candidate names and the classifier
   executor/model. The classifier runs on the run's default executor: `executor`, else the saved
   user profile, else this host's own CLI (`--host claude-code` → `claude`, `codex` → `codex`,
   `generic` → the first installed and logged-in of pi, claude, codex), with `model`/`effort` or the
   executor's default model. Only `accept` sends the one tool-less request; nothing is sent otherwise. `decline` is the user's
   no (`phase: "consent-declined"`); `cancel` or an error is the client's, not the user's (Claude
   Code print mode answers every elicitation with `cancel`), so the result says the client
   cancelled or cannot ask and never that the user declined (`phase: "consent-cancelled"`, WP39b).
3. **Choice.** A second elicitation (`elicitChoice`) is a form with one required enum field
   `workflow`: the ranked launchable candidates (`<name> (recommended)`, `<name>`, …; no number prefix, since
   Codex numbers enum options itself — WP39b; equal names get their scope, `review [user]`), the
   recommendation as `default`; the message carries the classifier's recommendation and reasons. `accept` with a
   value starts that workflow through the normal launch path (duplicate guard, profiles, degradation
   elicitation, `detach` default true; the footer says to call `workflow_wait`). `decline`/`cancel`
   starts nothing and returns the ranked list (`phase: "cancelled"`), so the host can show it and
   call `workflow_run` if the user then names a workflow.
4. **No elicitation.** A client without form elicitation gets no classifier request at all: the
   result (`phase: "consent-unavailable"`, `outcome: "refused"`) is the local shortlist with the
   `workflow_run`/`workflow_dynamic` call of each candidate (the task as `<task>`).

Why this design: consent has to come from the user, not the model, so it is an elicitation, as for
the WP28 confirmed changes; the second elicitation keeps the final choice with the user and lets the
server record it (launch capture `agent-workflow-run-launch-v2`: offered candidates,
recommendation, choice, classifier executor/model, consent `elicitation`; never the task text). The
alternative — return the ranking and let the host call `workflow_run` — would leave the choice to
the model and lose the selection record; it remains the fallback when the user declines the choice
dialog. Live-only: whether Claude Code and Codex show the enum form, and whether a tool call that
waits for two dialogs plus a classifier request (up to 120 s) fits the host's tool timeout (Codex
`tool_timeout_sec`, default 60 s).

## `cwd`

Optional on every tool. Relative paths resolve against the root. After resolving symlinks the target
must be the root or an existing directory below it; anything else (`..`, an absolute path outside, a
symlink escaping the root, a missing path, a file) is a usage error. Runs launched with a `cwd` live
in that directory's run store (`<cwd>/.agent-workflow/`), so later calls must pass the same `cwd`.

## Cancellation and progress

`notifications/cancelled` for a running call aborts it (for `workflow_wait` only the wait, never the
run) and no response is sent. A `workflow_wait` call with `_meta.progressToken` gets
`notifications/progress` (`progress` counts updates, `message` = completed/total/running).

## Completion delivery (WP36)

Investigation with the installed Claude Code 2.1.310 and Codex 0.159.2, evidence per mechanism:
[host-ux-investigation.md](host-ux-investigation.md). Summary:

- **The server cannot push.** Claude Code shows no server `notifications/message` or resource
  updates to the model, and MCP progress (sent by `workflow_wait` for a `progressToken`) only
  updates a backgrounded call's `/tasks` entry. Claude Code's MCP tasks (beta from 2.1.304) need
  protocol `2026-07-28`; this server speaks up to `2025-11-25`. Codex 0.159.2 has MCP `2026-07-28`
  behind an off feature flag. Claude Code moves a tool call that runs past 2 minutes to the
  background and delivers its result as a task notification, but `workflow_wait` returns within
  45 s by design.
- **Common mechanism (E2): `agent-workflow notify-check`** prints one line per run that settled
  since the last check, each state once (receipts in `.agent-workflow/notify-check/`; a state that
  `workflow_wait` returned is marked seen and not repeated). The Claude Code plugin runs it from a
  `UserPromptSubmit` hook, whose stdout Claude Code adds to the context: the result reaches the
  conversation at the user's next message. Codex: the same hook as user configuration
  ([plugins.md](plugins.md#completion-check-hook)).
- **Progress display (E1):** `agent-workflow statusline` as Claude Code's `statusLine.command` (user
  setting; plugins cannot set it) and `agent-workflow watch [runId]` in a terminal next to either host
  ([cli.md](cli.md#statusline-watch-notify-check)).
- **Push candidates needing live checks (bundle 5):** a Claude Code plugin monitor running
  `notify-check --follow`, an `asyncRewake` hook, a long `workflow_wait` that Claude Code
  backgrounds, the MCP tasks extension, and `codex queue` (one model turn per delivery). None is
  enabled until verified (owner decision Q6).

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
WP32: `host-wp32-auto.test.mjs` (`workflow_auto` without elicitation sends nothing; declined consent
sends nothing; consent → one classifier submit on `codex` for `--host codex` → the choice form
launches and records the selection; a declined choice starts nothing).

## Open items

- WP14/WP15 ([plugins.md](plugins.md)): the plugin manifests register
  `agent-workflow-mcp --host claude-code|codex`. Offline checks: both hosts start the plugin
  server in the project directory. Live bundle 4 verified Claude Code (tool names, server cwd;
  it shows `structuredContent` when present, so it gets `content` only since WP18b). Still
  live-only: Codex's tool names in a model turn, whether Codex shows `content` or
  `structuredContent`, and elicitation support in practice.
- WP17: default executor from `ctx.host`; until then an omitted `executor` uses the engine default.
- WP36: live checks L1-L6 of [host-ux-investigation.md](host-ux-investigation.md) decide which
  push mechanism, if any, is added per host.
