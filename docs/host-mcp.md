# Host MCP server (`agent-workflow-mcp`)

A stdio MCP server named `agent-workflow` lets Claude Code, Codex and other MCP clients run and manage workflows during a conversation. Tools call the [host API](host-api.md), with results matching the CLI's `--json` output.

## Start

```sh
agent-workflow-mcp --host <claude-code|codex|generic>
node <package>/dist/mcp/host-server/server.js --host <claude-code|codex|generic>
```

`--host` is required and identifies the calling host, including its default executor. Install the [plugins](plugins.md), or register the server directly:

```sh
claude mcp add agent-workflow -- agent-workflow-mcp --host claude-code
codex mcp add agent-workflow -- agent-workflow-mcp --host codex
```

The server's working directory, resolved through symlinks, is its project root. See [client roots](#the-clients-roots) and [`cwd`](#cwd) for overrides. Calls whose project would be the directory holding the user-level home use `~/.agent-workflow/home-runs` instead; a real project below the home directory is used as given.

Exit codes: `2` for usage errors, `1` for a misconfigured test-executor hook, `0` on stdin EOF, SIGTERM or SIGINT. In-flight calls answer before shutdown, with at most 5 s after a signal. stdout is protocol only; diagnostics go to stderr. The CLI's guarded test-executor hook works here too ([cli.md](cli.md)).

## Call protocol (server `instructions`)

1. Use `workflow_list` when the name is uncertain; never guess workflow names.
2. Launch with `workflow_run {workflow, task}` or `workflow_dynamic {task}`. Report the run id and the `Dashboard:` link in your own message before waiting; some clients fold tool results.
3. Follow the launch result's next step. Interactive Claude Code and Codex sessions can receive completion automatically. Otherwise call `workflow_wait {runId}`; leave `timeoutMs` out to use the host's maximum wait. Repeat while `stillRunning` is true. `terminal: true` means finished; `actionRequired: true` means blocked: report it and use `workflow_inspect`.
4. Quote the authoritative result preview and report paths. A result headed `Workflow finished — verdict: X (report ready)` (`verdictGate: true`, footer `verdict=X`) is a non-passing domain verdict with a report, not a workflow failure. Other failed runs are reported as failures.
5. If you stop waiting, give the run id, what it is waiting for, and any `nextRetry` time/reason. The user can ask again or use `agent-workflow watch <runId>` or Claude Code's `agent-workflow statusline`.
6. `workflow_resume` and `workflow_supervise` start model calls and incur cost; use them only on request. Show pending dynamic-approval questions to the user and call `workflow_approve` only after they decide.
7. When asked to choose a workflow, use `workflow_auto`. It requests consent before classification and lets the user choose. Without dialogs, show the local shortlist and launch only the user's pick.

Permission mode defaults to `free`; use `safe` only on request ([permissions.md](permissions.md)). Omit `executor` and `profile` to use the workflow profile or host default unless the user asks otherwise.

## Tools

Every tool accepts optional `cwd`. Unknown parameters are refused. Handler data types are documented in the [host API](host-api.md).

| Tool | Arguments | Result / behavior |
|---|---|---|
| `workflow_dashboard` | `run?` (full id: `^workflow_[A-Za-z0-9_-]+$`) | `{running, port, opened, method}`; no credentials |
| `workflow_list` | `query?`, `offset?`, `limit?` (1–20, default 20) | `ListData` |
| `workflow_run` | `workflow`, `task`, launch options | `LaunchData` |
| `workflow_dynamic` | `task`, launch options | `LaunchData` |
| `workflow_status` | `runId?` | `StatusData` |
| `workflow_wait` | `runId`, `timeoutMs?` (1 000–45 000, or up to 1 800 000 for long waits) | `WaitData`: `terminal`, `actionRequired`, `stillRunning`, `status`, `preview`, `reportArtifacts`, … |
| `workflow_stop` | `runId` | `StopData`; `pending` when another supervisor applies it |
| `workflow_inspect` | `runId`, `failures?`, `results?` | `{run, reliability, listed}`; brief task rows, not the full run record |
| `workflow_logs` | `runId`, `task?`, `lines?` (1–400, default 20), `stream?` (`output`/`stderr`/`events`/`all`) | Bounded, redacted tails per task |
| `workflow_validate` | `workflow` | `ValidateData` |
| `workflow_check` | `workflow`, `task?`, `executor?`, `profile?`, `permissionMode?`, `allowUnverified?`, `model?`, `effort?`, `inputs?` | Launch preflight without a run; `LaunchData` with `capability` and any `refusal` |
| `workflow_resume` | `runId`, `detach?` (default true) | `ResumeData`; starts model calls |
| `workflow_show` | `ref`, `raw?` | Workflow spec or run projected like `workflow_inspect` |
| `workflow_roles` | `workflow` | `RolesData` |
| `workflow_agents` | — | `{agents}` |
| `workflow_notices` | `action?` (`list` default, `acknowledge`, `clear`), `runId?`, `state?`, `reason?` | List: `{notices, acknowledgements, warnings}`; changes confirm |
| `workflow_doctor` | — | `DoctorData`; no model call or writes |
| `workflow_prune` | `keep?`, `olderThanDays?`, `dryRun?` (default true) | Prune summary; `dryRun: false` confirms after showing the dry run |
| `workflow_profile` | `op?` (see below), `name?`, profile fields | `ProfileData` / `WorkflowPreferenceData`; changes confirm |
| `workflow_supervise` | `runId` | Starts a detached supervisor for a running run without a live driver; `{runId, status, started, reason?: not-running \| live-supervisor, detached?}` |
| `workflow_approve` | `runId`, `requestId`, `decision` (`approve`/`reject`), `detach?` (default true) | `ApproveData`; always confirms |
| `workflow_auto` | `task`, launch options | `AutoData`: phase, consent, classifier, shortlist, recommendation, selection and launch |

Profile operations: `list` (default), `show`, `set`, `delete`, `default`, `clear-default`, `presets`, `workflow-list`, `workflow-show`, `workflow-set`, `workflow-clear`. Set fields: `executor?`, `model?`, `effort?`, `permissionMode?`, `strictCapabilities?`, `preset?`, `roles?` (role → `{executor?, model?, effort?}`), `unset?` (including `roles.<role>`), `makeDefault?`. Workflow operations take `workflow`; `workflow-set` accepts `profile?`, `roles?`, `unset?`.

Launch options: `executor`, `profile`, `permissionMode` (`free`/`safe`), `allowUnverified` (capability keys), `model`, `effort`, `inputs` (declared workflow inputs), `forceNew`, `detach`, and `acceptDegradations` (only after user consent; see below).

`detach` defaults to **true**: a standalone `agent-workflow supervise` process (log: `<run dir>/supervise.log`) continues between calls and after the server exits. `detach: false` keeps execution in the server process.

An identical active launch returns `outcome: "existing"` and the existing run. A retry while launch is still starting is refused as `DUPLICATE_LAUNCH_IN_PROGRESS`, even after its lease expires. Changed saved profiles count as new launches; `forceNew: true` always starts a new run.

Logs accept only files inside `.agent-workflow/`; tampered or symlinked paths are refused with a reason. Text, previews and logs redact credentials and Linux/Windows/macOS home paths. Credential headers (`Authorization`, `x-api-key`, `Cookie`, `*-token`, …) are redacted regardless of value length. CLI `logs` and Pi `/aw logs` use the same handler.

MCP annotations: list/status/inspect/logs/validate/show/roles/agents/doctor are read-only; run/dynamic/auto/stop/resume/prune/profile/approve are destructive; wait/notices/supervise/dashboard are neither. Dashboard changes local process state, not runs, and uses the stop role gate. `title` requires protocol `2025-06-18`; annotations require `2025-03-26`.

## Results

- `content`: one text item, bounded to 50 000 characters, with next-step guidance for launches, waits and pending stops.
- `structuredContent` (protocol `2025-06-18` onward): `{action, ok, outcome, data, text, next?}`. `data` matches host API and CLI `--json`, except the inspect projection.
- `--host claude-code` receives text only for host API results; `codex` and `generic` retain structured content. Tools declare no `outputSchema`.
- `isError: true` marks refused launches and handler errors. Structured errors are `{ok: false, outcome: kind, error: {kind, message}}`, with kind `usage`, `validation` or `error`. Exception: `CAPABILITY_CONFIRMATION_REQUIRED` is `isError: false`, still `outcome: "refused"`, because the user must answer a question.
- JSON-RPC errors: unknown tool/non-object arguments `-32602`, unknown method `-32601`, requests before initialization `-32600`.
- Workers (`AGENT_WORKFLOW_ROLE=worker`) may call only `workflow_validate` and `workflow_check`.

## Dashboard opening

Launches auto-start a detached dashboard when needed but never open a browser themselves. Launch data includes `dashboard: {url, port, started?: true, auth?: true}` (`workflow_auto`: `data.launch.dashboard`). The token-free link is printed immediately below the run heading. If startup is disabled or fails, the line is `Dashboard: not running · agent-workflow dashboard --open`.

`workflow_dashboard {run?}` ensures the project's dashboard is running, then opens it according to client support:

| Client capability | Behavior | `method` |
|---|---|---|
| URL elicitation, protocol `2025-11-25` onward (Claude Code ≥ 2.1.87) | Client asks and opens the URL; server sends `notifications/elicitation/complete` when the browser arrives | `url-elicitation` |
| Form elicitation only | Confirmation dialog; on accept the local MCP server opens the browser (`BROWSER`/`BROWSER_ARGS` honored) | `form-consent` |
| No dialogs | Instructions to run `agent-workflow dashboard --open` in the project | `instructions` |

Decline/cancel opens nothing. One-time URLs travel only through elicitation or to the browser; session tokens and launch keys never enter tool results. This tool returns top-level `{running, port, opened, method}` as structured content on supported protocols, including Claude Code. Startup failure returns `isError: true`. See [dashboard.md](dashboard.md) for security, authentication and lifecycle options.

## Degradation confirmation (elicitation)

Capability limits needing confirmation ask the user; record-only limits start without a question (`confirmation: "not-needed"`).

With form elicitation (`{}` or `{form: …}`) and protocol `2025-06-18` onward, the server sends `elicitation/create`: `Proceed with these executor capability degradations?`, the short preview prompt, and an empty object form. Protocol `2025-11-25` uses `mode: "form"`. The prompt lists executor, stages, permission mode and limits; the full report is saved as `capabilityNegotiation`.

- `accept`: launch with `capability.confirmation: "confirmed"`, `confirmedVia: "dialog"`.
- `decline`: refuse with `CAPABILITY_DEGRADATION_DECLINED`.
- `cancel`, client error, unavailable form elicitation or older protocol: nothing starts; return `CAPABILITY_CONFIRMATION_REQUIRED`. Claude Code print mode, the Agent SDK without `onElicitation`, and headless clients may cancel dialogs automatically; this is not the user's refusal.

The agent must ask in the conversation. Only after the user agrees may it retry with `acceptDegradations` covering all keys in `preview.needsOk` (for example `["webTools"]`). Complete keys launch with `confirmedVia: "chat"`; incomplete keys refuse. The agent must never supply consent on its own.

## Waiting without polling: the Claude Code completion monitor

The Claude Code plugin declares `experimental.monitors` → `run-completion` for interactive sessions, not `-p`. It runs `agent-workflow notify-check --follow --host claude-code --session $CLAUDE_CODE_SESSION_ID`; each output line wakes the idle session. Verified with Claude Code 2.1.318.

Session links in `.agent-workflow/notify-check/session-<id>.<run>.link` scope delivery to the launching session. A monitor stamp younger than 20 s makes launch guidance say to end the turn without `workflow_wait`. Otherwise use a long wait below.

Before the project has runs, the monitor checks every 2 s for `$CLAUDE_PROJECT_DIR/.agent-workflow/workflows`. For the first run, launch waits up to 5 s for the monitor stamp, except in SDK/print entrypoints (`CLAUDE_CODE_ENTRYPOINT` `sdk-cli`/`sdk-ts`/`sdk-py`) or when the monitor watches another directory. Settled states are reported once through completion-check receipts. The monitor stops when its parent exits. Scripts can use `notify-check --run <id> --follow` to exit when one run settles.

## Long waits

`workflow_wait` uses at most 30 min, with 2 min reserved below a known host per-call limit; unknown limits use 45 s.

| Host | Known limit | Maximum wait |
|---|---|---|
| Claude Code (`--host claude-code`, `CLAUDECODE=1`) | `MCP_TOOL_TIMEOUT`, else 100 000 000 ms (Claude Code 2.1.318 default) | 30 min |
| Codex plugin | `tool_timeout_sec = 1920`, server flag `--tool-timeout-ms 1920000` | 30 min |
| Others, including plain `codex mcp add` and generic clients | Unknown | 45 s |

For a known limit, the bound is `min(1 800 000, limit - 120 000)` ms when that exceeds 45 000 ms; otherwise it stays 45 000 ms. Configure the client's timeout accordingly. Leave `timeoutMs` out to use the bound. Claude Code can background calls after 120 s and deliver their results as task notifications. In Codex code mode, launch guidance asks the agent to start the cell with `// @exec: {"yield_time_ms": 1830000}` and use the same value for `wait`, avoiding repeated short cell yields. See [plugin timeout configuration](plugins.md#timeouts).

## Waiting without polling: Codex sessions

For interactive Codex launches driven by a detached supervisor, turn metadata (`params._meta["x-codex-turn-metadata"]`) links the run to its thread. When it settles, the supervisor invokes `codex queue --thread <id> --message <completion line>`. The next step tells the agent to end its turn, not call `workflow_wait`. Closed threads receive the message when resumed. Verified with Codex 0.166.0.

This works with the plugin or `codex mcp add … --host codex`. `codex exec` still waits; servers registered with another `--host` do not wake Codex. A state already returned by `workflow_wait` is not queued again. The supervisor finds `codex` on PATH; the queue call is killed with SIGKILL after 30 s. Set `AGENT_WORKFLOW_HOST_WAKE=0` in the server environment to disable it.

## The client's roots

A call without `cwd` uses the client's single file root when the client declares MCP `roots`. `roots/list` is requested during the call, with a 5 s timeout. With several roots, omission of `cwd` is refused with the root list. Explicit `cwd` may be inside the server root or a client root. This lets desktop clients select their session's project even when they start the server in the home directory.

## PATH of a server an app starts

Apps such as the ChatGPT desktop app may omit CLI installation directories from PATH, causing errors such as `spawn claude ENOENT`. At startup the server obtains PATH from `$SHELL -l -c` and `$SHELL -i -l -c` concurrently (at most 10 s), appending missing absolute entries. Tool calls wait for this; initialization does not. Workers and detached supervisors inherit the result.

Set `AGENT_WORKFLOW_LOGIN_SHELL_PATH=0` to disable it. Windows and csh/tcsh are skipped. Shell probes have closed stdin and their own process session; their process groups are killed on timeout.

## Antigravity CLI (agy) as a host

agy loads the converted plugin with `agy plugin install` and the MCP registration in `~/.gemini/config/mcp_config.json`; tools are called through `call_mcp_tool`. Interactive agy asks before commands. Headless `agy -p` auto-denies tools needing `command` permission because it cannot prompt. For unattended use, add `permissions.allow` rules in agy's `settings.json` (for example `command(node …)`), or use `--dangerously-skip-permissions`, preferably with `--sandbox`. User-level agy rules also apply.

## Confirmed changes

`workflow_prune` with `dryRun: false`, profile set/delete/default/clear-default/workflow-set/workflow-clear, and notices acknowledge/clear require user confirmation. Usage is checked before asking.

Form-capable clients receive one dialog naming the change; prune includes the dry run. `accept` acts. Decline, cancel, client errors or failed requests change nothing: `isError: true`, `outcome: "refused"`, `data: {confirmation: "declined" | "cancelled", command, changed: false}`.

Without form elicitation (including URL-only clients or protocols before `2025-06-18`), changes are refused with `confirmation: "unsupported"` and a terminal command. Read-only calls, prune dry runs, resume and supervise never ask; resume/supervise describe their cost instead.

### Codex approval

Codex with `approval_policy = "never"` automatically accepts empty confirmation forms without showing a dialog. The server treats that as consent for auto classification, capability degradations, dynamic approvals, and profile/prune/notice changes. Required-field forms, including the auto workflow choice, are cancelled: auto starts nothing without a choice.

To see dialogs, use `-c approval_policy="on-request"` or set it in `~/.codex/config.toml`.

## Dynamic-controller approval

A controller declaring `dynamic.permissions.approval: "ask"` blocks as `dynamic_ui_unavailable` because the MCP driver has no interactive UI ([usage.md](usage.md#dynamic-approval)).

1. `workflow_wait` (`actionRequired: true`) and `workflow_status` expose `pendingApprovals: [{requestId, controllerSpecId, taskId, title, message, requestedAt}]`. Show the user the question.
2. After their decision, call `workflow_approve {runId, requestId, decision}`. It asks `Run dynamic workflow controller?` or `Reject dynamic workflow controller?`, including the scope.
3. For `approve`, accept records approval and resumes (detached by default; completed tasks are not relaunched); decline rejects permanently for this run (`dynamic_approval_rejected`). For `reject`, accept rejects and decline changes nothing. Cancel/errors leave `decision: "unanswered"`, `isError: true`, `outcome: "refused"`.
4. Without form elicitation, nothing is recorded (`confirmation: "unsupported"`); use `agent-workflow approve <run> --request <requestId>` or add `--reject`.

A request id is a digest of the approval scope, so a stale id cannot approve a changed scope. Decisions record `decidedBy: {host: "<--host>", via: "approve"}`.

## Auto workflow selection

`workflow_auto {task, …launch options}` implements `agent-workflow auto`:

1. Rank the dynamic workflow and at most 24 discoverable workflows locally using task words and `routing` hints. No model call.
2. Ask `Send this task to <executor> to compare workflows?`, showing task, candidates and classifier executor/model. Executor selection: explicit executor, saved user profile, then host CLI (`claude-code` → `claude`, `codex` → `codex`, `generic` → first installed and logged-in of pi, claude, codex). Model/effort use explicit options or executor defaults. Only accept sends one tool-less classifier request (up to 120 s). Decline returns `phase: "consent-declined"`; client cancel/error returns `consent-cancelled`.
3. Ask the user to choose a ranked launchable workflow in a required enum form, defaulting to the recommendation. Equal names include their scope. Accept launches normally; decline/cancel starts nothing and returns the ranking (`phase: "cancelled"`).
4. Without form elicitation, send nothing and return the local shortlist with launch calls (`phase: "consent-unavailable"`, `outcome: "refused"`). The host may launch after the user names a workflow.

Launch metadata records offered candidates, recommendation, choice, classifier executor/model and consent `elicitation`, never task text.

## `cwd`

Optional on every tool. Relative paths resolve against the server root. After resolving symlinks, the target must be an existing directory within the server root or a declared client root; missing paths, files and escaping symlinks are usage errors. Runs live in `<cwd>/.agent-workflow/`; subsequent calls must use the same project directory.

## Cancellation and progress

`notifications/cancelled` aborts a running call and sends no response. Cancelling `workflow_wait` stops only the wait, never the run. A wait with `_meta.progressToken` receives `notifications/progress`: update count and completed/total/running message.

## Completion delivery

Session wake mechanisms are described above. For next-prompt delivery, `agent-workflow notify-check` prints each newly settled state once; a state returned by `workflow_wait` is marked seen. Receipts live in `.agent-workflow/notify-check/`. The Claude Code plugin includes a prompt hook; Codex users can configure one ([plugins.md](plugins.md#completion-check-hook)). For progress outside the conversation, use `agent-workflow watch [runId]` or Claude Code's status line ([cli.md](cli.md#statusline-watch-notify-check)).
