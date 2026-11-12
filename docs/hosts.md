# Agent hosts

Use agent-workflow from a conversation or a local browser:

- **[Claude Code and Codex](#claude-code-and-codex):** install the plugin for in-host `aw` commands, or ask the agent to use the MCP tools (also available with MCP-only installation).
- **[Pi](#pi):** install the extension, then use `/aw` or ask the agent to use its `aw_*` tools.
- **[Dashboard](#dashboard):** open a project's local web view to inspect and manage runs.
- **[Other MCP clients and Antigravity CLI (agy)](#other-hosts):** register the MCP server or converted plugin and call its tools.

## Requirements and installing from source

Node.js 22+ (tested on macOS and Linux) and at least one executor CLI installed and logged in: Claude Code 2.1+,
Codex 0.159+, Pi 1.1+ or Antigravity ([executors](executors.md)). Each CLI keeps its own login; agent-workflow never
handles credentials. Install agent-workflow where you type (a host below); the executors need only their login.
`agent-workflow doctor` shows what is ready.

Until the first npm release, the npm-based installs below do not resolve. From a checkout:

```sh
git clone https://github.com/AgwaB/agent-workflow && cd agent-workflow
npm ci && npm run build && npm link     # puts agent-workflow and agent-workflow-mcp on your PATH
```

For the Claude Code plugin from a checkout, see [local development](#local-development).

## Claude Code and Codex

Ask for a workflow, for example “run deep-review on the current diff”. The agent launches a detached run, reports its id and dashboard link, then waits or receives completion. It quotes the result preview and report paths when finished.

The plugin in `plugins/agent-workflow/` registers the MCP server with the correct `--host` and supplies three skills: `agent-workflow` (tool protocol), `workflow-guide` (authoring and scaffolds), and `execution-router` (route recommendation). Direct `mcp add` registration is an alternative without skills.

### Install (plugin)

Claude Code:

```sh
claude plugin marketplace add AgwaB/agent-workflow
claude plugin install agent-workflow@agent-workflow
# Add --scope project|local to share or limit the installation.
# In a session, Claude Code 2.1.275+ also supports:
# /plugin install agent-workflow --marketplace AgwaB/agent-workflow
```

Codex:

```sh
codex plugin marketplace add AgwaB/agent-workflow
codex plugin add agent-workflow@agent-workflow
```

Codex marketplace registration can use `--sparse .agents/plugins --sparse plugins/agent-workflow`. The repository marketplace file alone is not enough: register it with `plugin marketplace add` or a `marketplaces` configuration entry. Installed copies live under `$CODEX_HOME/plugins/cache/`.

Trusted projects can enable or disable the Codex plugin in `.codex/config.toml`:

```toml
[plugins."agent-workflow@agent-workflow"]
enabled = true
```

See [Codex approval](#codex-approval) for dialog behavior.

Restart the session after installation. Claude Code lists the server as `plugin:agent-workflow:agent-workflow`; Codex lists it as `agent-workflow`.

### In-host `aw` commands

With the plugin installed, Claude Code accepts **`/aw`** and **`/agent-workflow:aw`**.
Codex accepts **`$aw`** and **`aw …`** (and `$agent-workflow:aw`, which Codex's skill picker inserts
when you choose `$aw` from its list). On first start after installing or changing the Codex
hook, accept the one-time **Hooks need review → Trust all and continue** prompt (or review it
with `/hooks`). Plugin updates change the plugin's contents, so Codex asks again once after each
update. The declared hook command stays the same across releases (it runs the plugin's
`scripts/codex-host-command.sh`), because Codex 0.166 applies a "Trust all" answer for a changed hook
declaration only after a restart. Untrusted or disabled hooks do not run: the `aw` skill then guides
the model through the MCP tools instead, including any dialogs those tools require.

Use the appropriate prefix with these six forms:

| Command | Result |
|---|---|
| `aw` | Six-line usage, up to three recent top-level runs of this project, and the dashboard URL (ensured, not opened). |
| `aw dashboard [run]` | Open the user-level dashboard with this project and optional run selected; accepts an unambiguous run prefix. Opens even in an agent environment. |
| `aw run <workflow> <task…>` | Start a detached named workflow with profile defaults; print the run id, executor and dashboard link. |
| `aw dynamic <task…>` | Start a detached dynamic workflow. |
| `aw auto <task…>` | Send one classifier comparison and immediately start its top recommendation; show the pick, reason and other candidates. Typing the command is consent (`command` in launch metadata). Classifier failure starts nothing. |
| `aw stop <run>` | Stop a run by id or unambiguous prefix. |

There are **no options and no confirmation questions** in the hook commands. The task is the
trimmed remainder after the action (and workflow for `run`); one matching surrounding quote pair
is removed. Words such as `--executor` are task text, not flags. Use the dashboard for other
management actions and configuration. Capability degradations are recorded non-interactively;
hard refusals and the existing duplicate-run guard still apply.

Hooks handle these requests in code (only `auto` invokes a classifier), returning a bounded,
redacted plain-text block reason. Ordinary prompts pass through without starting the command CLI.
Claude uses `UserPromptSubmit` and `UserPromptExpansion`; Codex uses `UserPromptSubmit`, each with
a 300 s command timeout. Claude's existing notification hook and completion monitor remain.
Commands resolve the hook's `cwd` to the project root, including the CLI's home-directory rule.
Detached runs link to Claude's `session_id`; Codex's `session_id` is the thread id and is linked
only when `AGENT_WORKFLOW_HOST_WAKE` is enabled. Completion uses the same monitor/queued-message
paths as MCP launches; `AGENT_WORKFLOW_HOST_WAKE=0` disables Codex delivery.

Claude has no common submission id on these two hooks, so a short-lived, task-hashed receipt in
private project state pairs opposite events for the same session and arguments within 30 seconds.
This blocks double handling; same-hook retries remain valid and use the normal duplicate guard.

**Why not `/aw` in Codex?** Its composer rejects unknown slash commands before submitting a
prompt. Only built-in/service-tier commands are registered there; plugins, skills and MCP cannot
add slash commands, so the hook never receives `/aw`. Use `$aw` or `aw …` instead. Bare
`aw draw a box` remains a normal model prompt; `$aw unknown` shows command usage. Claude's
`/awesome` is not intercepted.

Plugins containing hooks are **not eligible for OpenAI's public plugin directory**. This plugin
is distributed through our own marketplace above. The generated commands use POSIX shell; Windows
hook behavior has not been verified.

### Alternative: `mcp add`

Without plugin skills, the server's instructions still provide the tool protocol:

```sh
claude mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host claude-code
codex mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host codex
```

Replace the version with the package version you want. With a global install (`npm install -g @agwab/agent-workflow`), use `agent-workflow-mcp --host …` directly.

`claude mcp add` accepts `--scope local|project|user` (`project` writes `.mcp.json`). `codex mcp add` writes `[mcp_servers.agent-workflow]` in `~/.codex/config.toml`.

### Server launch

The released plugin uses an exact package version:

```sh
npx -y --package=@agwab/agent-workflow@<package version> agent-workflow-mcp --host <claude-code|codex>
```

Node.js 22+ is required. First startup downloads the package. Keep `--package`: `npx <package> agent-workflow-mcp` would select the package's `agent-workflow` binary and pass `agent-workflow-mcp` as an argument. For an unpublished or local version, use the development plugin below or register a local install with `mcp add`.

### MCP server

A stdio MCP server named `agent-workflow` lets MCP clients run and manage workflows. Tools call the [host API](extending.md#host-api), with results matching CLI `--json` output.

```sh
agent-workflow-mcp --host <claude-code|codex|generic>
node <package>/dist/mcp/host-server/server.js --host <claude-code|codex|generic>
```

`--host` is required and identifies the calling host, including its default executor. Use the [plugin](#install-plugin) or [direct registration](#alternative-mcp-add) above.

The server's working directory, resolved through symlinks, is its project root. See [client roots](#the-clients-roots) and [`cwd`](#cwd) for overrides. Calls whose project would be the directory holding the user-level home use `~/.agent-workflow/home-runs` instead; a real project below the home directory is used as given.

Exit codes: `2` for usage errors, `1` for a misconfigured test-executor hook, `0` on stdin EOF, SIGTERM or SIGINT. In-flight calls answer before shutdown, with at most 5 s after a signal. stdout is protocol only; diagnostics go to stderr. The CLI's guarded test-executor hook works here too ([cli.md](cli.md)).

### Tools

Every tool accepts optional `cwd`. Unknown parameters are refused. Handler data types are documented in the [host API](extending.md#host-api).

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
| `workflow_auto` | `task`, launch options | `AutoData`: phase, consent, classifier, shortlist, recommendation, selection and launch |

Profile operations: `list` (default), `show`, `set`, `delete`, `default`, `clear-default`, `presets`, `workflow-list`, `workflow-show`, `workflow-set`, `workflow-clear`. Set fields: `executor?`, `model?`, `effort?`, `permissionMode?`, `strictCapabilities?`, `preset?`, `roles?` (role → `{executor?, model?, effort?}`), `unset?` (including `roles.<role>`), `makeDefault?`. Workflow operations take `workflow`; `workflow-set` accepts `profile?`, `roles?`, `unset?`.

Launch options: `executor`, `profile`, `permissionMode` (`free`/`safe`), `allowUnverified` (capability keys), `model`, `effort`, `inputs` (declared workflow inputs), `forceNew`, `detach`.

`detach` defaults to **true**: a standalone `agent-workflow supervise` process (log: `<run dir>/supervise.log`) continues between calls and after the server exits. `detach: false` keeps execution in the server process.

An identical active launch returns `outcome: "existing"` and the existing run. A retry while launch is still starting is refused as `DUPLICATE_LAUNCH_IN_PROGRESS`, even after its lease expires. Changed saved profiles count as new launches; `forceNew: true` always starts a new run.

Logs accept only files inside the [state directory](usage.md#where-run-state-lives)'s `.agent-workflow/`; tampered or symlinked paths are refused with a reason. Text, previews and logs redact credentials and Linux/Windows/macOS home paths. Credential headers (`Authorization`, `x-api-key`, `Cookie`, `*-token`, …) are redacted regardless of value length. CLI `logs` and Pi `/aw logs` use the same handler.

MCP annotations: list/status/inspect/logs/validate/show/roles/agents/doctor are read-only; run/dynamic/auto/stop/resume/prune/profile are destructive; wait/notices/supervise/dashboard are neither. Dashboard changes local process state, not runs, and uses the stop role gate. `title` requires protocol `2025-06-18`; annotations require `2025-03-26`.

### Call protocol (server `instructions`)

1. Use `workflow_list` when the name is uncertain; never guess workflow names.
2. Launch with `workflow_run {workflow, task}` or `workflow_dynamic {task}`. Report the run id and the `Dashboard:` link in your own message before waiting; some clients fold tool results.
3. Follow the launch result's next step. Interactive Claude Code and Codex sessions can receive completion automatically. Otherwise call `workflow_wait {runId}`; leave `timeoutMs` out to use the host's maximum wait. Repeat while `stillRunning` is true. `terminal: true` means finished; `actionRequired: true` means blocked: report it and use `workflow_inspect`.
4. Quote the authoritative result preview and report paths. A result headed `Workflow finished — verdict: X (report ready)` (`verdictGate: true`, footer `verdict=X`) is a non-passing domain verdict with a report, not a workflow failure. Other failed runs are reported as failures.
5. If you stop waiting, give the run id, what it is waiting for, and any `nextRetry` time/reason. The user can ask again or use `agent-workflow watch <runId>` or Claude Code's `agent-workflow statusline`.
6. `workflow_resume` and `workflow_supervise` start model calls and incur cost; use them only on request.
7. When asked to choose a workflow, use `workflow_auto`. It classifies once and starts the top recommendation without asking. Classifier failure starts nothing.

Permission mode defaults to `free`; use `safe` only on request ([permissions.md](usage.md#permission-modes)). Omit `executor` and `profile` to use the workflow profile or host default unless the user asks otherwise.

### Results

- `content`: one text item, bounded to 50 000 characters, with next-step guidance for launches, waits and pending stops.
- `structuredContent` (protocol `2025-06-18` onward): `{action, ok, outcome, data, text, next?}`. `data` matches host API and CLI `--json`, except the inspect projection.
- `--host claude-code` receives text only for host API results; `codex` and `generic` retain structured content. Tools declare no `outputSchema`.
- `isError: true` marks refused launches and handler errors. Structured errors are `{ok: false, outcome: kind, error: {kind, message}}`, with kind `usage`, `validation` or `error`.
- JSON-RPC errors: unknown tool/non-object arguments `-32602`, unknown method `-32601`, requests before initialization `-32600`.
- Workers (`AGENT_WORKFLOW_ROLE=worker`) may call only `workflow_validate` and `workflow_check`.

### Capability degradations

Degradations are recorded and shown without dialogs or chat confirmation. Refusals still start nothing.

### Confirmed changes

`workflow_prune` with `dryRun: false`, profile set/delete/default/clear-default/workflow-set/workflow-clear, and notices acknowledge/clear require user confirmation. Usage is checked before asking.

Form-capable clients receive one dialog naming the change; prune includes the dry run. `accept` acts. Decline, cancel, client errors or failed requests change nothing: `isError: true`, `outcome: "refused"`, `data: {confirmation: "declined" | "cancelled", command, changed: false}`.

Without form elicitation (including URL-only clients or protocols before `2025-06-18`), changes are refused with `confirmation: "unsupported"` and a terminal command. Read-only calls, prune dry runs, resume and supervise never ask; resume/supervise describe their cost instead.

#### Codex approval

Codex with `approval_policy = "never"` automatically accepts empty confirmation forms without showing a dialog. This affects confirmations for profile/prune/notice changes, not workflow launches or auto classification (which never ask).

To see dialogs, use `-c approval_policy="on-request"` or set it in `~/.codex/config.toml`.

### MCP auto

`workflow_auto {task, …launch options}` sends one tool-less classifier request and immediately
starts its top recommendation, even without elicitation support. The classifier follows the run's
executor/profile precedence. Failure or no recommendation starts nothing. Metadata records consent
`command`, candidates, recommendation, selection and classifier executor/model, never task text.

### Blocked-action notices

Completion-check lines (including the Claude monitor and Codex queued message) append a short
warning when worker actions were denied, for example:
`agent-workflow: workflow "review" (run <id>) finished — status completed; 2 actions were blocked (provider policy). Details: workflow_status ...`.
Engine-only blocks say `(engine policy)`; mixed or unknown sources carry their counts. MCP
status/wait text and structured data carry the same warning/counts. A denied action does not
itself change completion status or ask for user approval. Inspect the run or open dashboard run
details for bounded redacted samples and the task's events-log command. Zero blocks add nothing.
See [blocked actions](usage.md#blocked-actions) for the counting and attribution rules.

### Waiting without polling: the Claude Code completion monitor

The Claude Code plugin declares `experimental.monitors` → `run-completion` for interactive sessions, not `-p`. It runs `agent-workflow notify-check --follow --host claude-code --session $CLAUDE_CODE_SESSION_ID`; each output line wakes the idle session. Verified with Claude Code 2.1.318.

Session links in `.agent-workflow/notify-check/session-<id>.<run>.link` in the
[state directory](usage.md#where-run-state-lives) scope delivery to the launching session. A monitor stamp younger than 20 s makes launch guidance say to end the turn without `workflow_wait`. Otherwise use a long wait below.

The monitor resolves the project path with `realpath` and a SHA-256 tool, finds its state directory
via `$AGENT_WORKFLOW_HOME/projects/*-<hash>` (default home `~/.agent-workflow`), and checks every
2 s for its `.agent-workflow/workflows/`. Without either tool, it leaves discovery to the CLI. For the first run, launch waits up to 5 s for the monitor stamp, except in SDK/print entrypoints (`CLAUDE_CODE_ENTRYPOINT` `sdk-cli`/`sdk-ts`/`sdk-py`) or when the monitor watches another directory. Settled states are reported once through completion-check receipts. The monitor stops when its parent exits. Scripts can use `notify-check --run <id> --follow` to exit when one run settles.

### Timeouts

- The Codex plugin sets `tool_timeout_sec = 1920`, server flag `--tool-timeout-ms 1920000`, and `startup_timeout_sec = 120` for the first `npx` download.
- With `codex mcp add`, waits remain 45 s. For 30 min waits, add `--tool-timeout-ms 1920000` after `--host codex` **and** set `tool_timeout_sec = 1920` under `[mcp_servers.agent-workflow]`. The flag alone can exceed Codex's tool limit. Add `startup_timeout_sec = 120` if first startup times out.
- Claude Code uses `MCP_TIMEOUT` for startup and `MCP_TOOL_TIMEOUT` for calls (milliseconds), or per-server `timeout` in `.mcp.json`/`mcpServers`. The plugin sets none. If the first download is slow, start Claude Code with `MCP_TIMEOUT=60000`.

#### Long waits

`workflow_wait` uses at most 30 min, with 2 min reserved below a known host per-call limit; unknown limits use 45 s.

| Host | Known limit | Maximum wait |
|---|---|---|
| Claude Code (`--host claude-code`, `CLAUDECODE=1`) | `MCP_TOOL_TIMEOUT`, else 100 000 000 ms (Claude Code 2.1.318 default) | 30 min |
| Codex plugin | `tool_timeout_sec = 1920`, server flag `--tool-timeout-ms 1920000` | 30 min |
| Others, including plain `codex mcp add` and generic clients | Unknown | 45 s |

For a known limit, the bound is `min(1 800 000, limit - 120 000)` ms when that exceeds 45 000 ms; otherwise it stays 45 000 ms. Configure the client's timeout accordingly. Leave `timeoutMs` out to use the bound. Claude Code can background calls after 120 s and deliver their results as task notifications. In Codex code mode, launch guidance asks the agent to start the cell with `// @exec: {"yield_time_ms": 1830000}` and use the same value for `wait`, avoiding repeated short cell yields. See [timeout configuration](#timeouts).

### Waiting without polling: Codex sessions

For interactive Codex launches driven by a detached supervisor, turn metadata (`params._meta["x-codex-turn-metadata"]`) links the run to its thread. When it settles, the supervisor invokes `codex queue --thread <id> --message <completion line>`. The next step tells the agent to end its turn, not call `workflow_wait`. Closed threads receive the message when resumed. Verified with Codex 0.166.0.

This works with the plugin or `codex mcp add … --host codex`. `codex exec` still waits; servers registered with another `--host` do not wake Codex. A state already returned by `workflow_wait` is not queued again. The supervisor finds `codex` on PATH; the queue call is killed with SIGKILL after 30 s. Set `AGENT_WORKFLOW_HOST_WAKE=0` in the server environment to disable it.

### The client's roots

A call without `cwd` uses the client's single file root when the client declares MCP `roots`. `roots/list` is requested during the call, with a 5 s timeout. With several roots, omission of `cwd` is refused with the root list. Explicit `cwd` may be inside the server root or a client root. This lets desktop clients select their session's project even when they start the server in the home directory.

### `cwd`

Optional on every tool. Relative paths resolve against the server root. After resolving symlinks, the target must be an existing directory within the server root or a declared client root; missing paths, files and escaping symlinks are usage errors. Runs live in the project's [state directory](usage.md#where-run-state-lives); subsequent calls must use the same project directory.

### Login-shell PATH

Apps such as the ChatGPT desktop app may omit CLI installation directories from PATH, causing errors such as `spawn claude ENOENT`. At startup the server obtains PATH from `$SHELL -l -c` and `$SHELL -i -l -c` concurrently (at most 10 s), appending missing absolute entries. Tool calls wait for this; initialization does not. Workers and detached supervisors inherit the result.

Set `AGENT_WORKFLOW_LOGIN_SHELL_PATH=0` to disable it. Windows and csh/tcsh are skipped. Shell probes have closed stdin and their own process session; their process groups are killed on timeout.

### Cancellation and progress

`notifications/cancelled` aborts a running call and sends no response. Cancelling `workflow_wait` stops only the wait, never the run. A wait with `_meta.progressToken` receives `notifications/progress`: update count and completed/total/running message.

### Tool names

Skills use short tool names; hosts prefix them:

| Registration | Model-visible name |
|---|---|
| Claude Code plugin | `mcp__plugin_agent-workflow_agent-workflow__workflow_run` |
| `claude mcp add agent-workflow` | `mcp__agent-workflow__workflow_run` |
| Codex plugin or `mcp add` | `mcp__agent_workflow__workflow_run` |

In Codex code mode, MCP functions are called inside JavaScript cells, for example `tools.mcp__agent_workflow__workflow_run({…})`. A long call can outlast the cell's 30 s yield; the model resumes it with `wait`. Long-wait guidance supplies a `// @exec` `yield_time_ms` pragma ([long waits](#long-waits)).

Codex names plugin skills `agent-workflow:agent-workflow`, `agent-workflow:aw`, `agent-workflow:workflow-guide`, and `agent-workflow:execution-router`.

### Status line and watch

A Claude Code plugin cannot set the main status line. Add this to `~/.claude/settings.json` or a trusted project's `.claude/settings.json`:

```json
{"statusLine": {"type": "command", "command": "agent-workflow statusline", "refreshInterval": 2}}
```

Without a global install, use `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow statusline` as the command. It shows active workflow progress and nothing when idle.

For either host, run `agent-workflow watch [runId]` in another terminal pane to see tasks, elapsed time, blockers, and final verdict/report. `--bell` rings when the run ends. Codex's `tui.status_line` accepts only built-in items, not commands. See [CLI feedback commands](cli.md#statusline-watch-notify-check).

### Completion check hook

`agent-workflow notify-check` announces newly settled run states once. A state returned by `workflow_wait` is marked seen; receipts live in `.agent-workflow/notify-check/` in the [state directory](usage.md#where-run-state-lives). A `UserPromptSubmit` hook adds its output to the host's context at the user's next message. Interactive session wake mechanisms work without waiting for another prompt; see [completion delivery](#completion-check-hook).

A whole-project check (not `--run` or `--session`) also adds the [unfinished-run reminder](#unfinished-run-reminders): the same reminder Pi gives at session start, with the host's own commands. A run the same check just announced is not repeated. The plugin hooks pass `--hook`. When there is a reminder, the output is the hook JSON: a one-line summary as `systemMessage`, which Claude Code and Codex show to the user under their message, and everything as `additionalContext` for the model. Otherwise the output is plain text as before.

#### Claude Code hook

The plugin includes a `UserPromptSubmit` command hook with a 60 s timeout. It runs this in `$CLAUDE_PROJECT_DIR`:

```sh
npx -y --package=@agwab/agent-workflow@<package version> agent-workflow notify-check --host claude-code --hook
```

The generated hook skips CLI startup when there are no runs, or when no `run.json` changed since `.agent-workflow/notify-check/hook-claude-code.stamp` and that stamp is less than six hours old (an older stamp lets the reminder repeat). Its shell finds the state directory using `realpath`, a SHA-256 tool and the
`projects/*-<hash>` glob, and only reads state paths; without either tool it leaves the decision
to the CLI. `notify-check --stamp hook-claude-code` writes the stamp through a contained writer after success. Failed checks or changes during a check are retried at the next prompt. At most 5 runs are announced per check; deferred runs prevent stamping so the next prompt drains the backlog. Errors print nothing and do not fail the prompt.

#### Codex hook

The plugin's Codex prompt hook (`scripts/codex-host-command.sh`) does two things. A prompt that is an `aw` command goes to `host-command` alone, since its JSON decision must be the whole output. Any other prompt runs `notify-check --host codex --stamp hook-codex` with the same idle fast path as the Claude Code hook. Codex adds plain stdout as developer context. Interactive Codex sessions also receive supervisor-delivered completions through `codex queue`. Such a completion is marked as reported, so the next prompt does not repeat it. `codex exec` uses waits ([details](#waiting-without-polling-codex-sessions)).

The hook's declared command never changes between releases, and only the script's content does, so Codex does not ask to trust it again after an update.

### Unfinished-run reminders

Every host reminds you about runs that stopped or failed and that you have not dealt with:

| Host | When |
|---|---|
| Pi | At session start |
| Claude Code, Codex | With the plugin's prompt hook, at your next message: a one-line summary under your message, details for the assistant |
| Dashboard | "Needs you" and Maintenance |

A run qualifies when it is a top-level failed or interrupted run, or a blocked run needing an executor decision, updated in the last 7 days. Mock runs are excluded and at most 5 are listed. A run is reminded again when its state changes or 6 hours after the last reminder. Reminder state is shared by all hosts of the project.

Dismissing a reminder hides it in every host. You can dismiss from:

- the dashboard's "Needs you" × or Maintenance → Dismiss
- `workflow_notices {"action":"acknowledge", …}`
- `/aw notices acknowledge …`
- `agent-workflow notices acknowledge …`

A dismissal records the run's exact state, so a run that later fails again is reminded again. Show again (or `notices clear`) undoes it. Dismissing never changes the run or its resume.

### Dashboard opening

`workflow_dashboard {run?}` ensures the user-level dashboard is running, selecting the current project, then opens it according to client support:

| Client capability | Behavior | `method` |
|---|---|---|
| URL elicitation, protocol `2025-11-25` onward (Claude Code ≥ 2.1.87) | Client asks and opens the URL; server sends `notifications/elicitation/complete` when the browser arrives | `url-elicitation` |
| Form elicitation only | Confirmation dialog; on accept the local MCP server opens the browser (`BROWSER`/`BROWSER_ARGS` honored) | `form-consent` |
| No dialogs | Instructions to run `agent-workflow dashboard --open` in the project | `instructions` |

Decline/cancel opens nothing. One-time URLs travel only through elicitation or to the browser; session tokens and launch keys never enter tool results. This tool returns top-level `{running, port, opened, method}` as structured content on supported protocols, including Claude Code. Startup failure returns `isError: true`. See [Dashboard](#dashboard) for security, authentication and lifecycle options.

### Plugin layout

```text
.claude-plugin/marketplace.json          Claude Code marketplace (repo root)
.agents/plugins/marketplace.json         Codex marketplace (repo root)
plugins/agent-workflow/
  .claude-plugin/plugin.json             Claude Code server, command/notify hooks and monitor
  .codex-plugin/plugin.json              Codex server, skills, inline command hook and timeouts
  skills/agent-workflow/
  skills/workflow-guide/
  skills/execution-router/
  reference/                            Usage guide, workflow guide and bundled specs
```

The plugin uses two manifests so each host passes its own `--host`. It has no `.mcp.json`, which Claude Code would load as a second server. Codex's compatibility manifest starts the server in the session directory; portable Agent Plugins manifests use the plugin root instead.

For maintainers, `node tools/release/plugins.mjs build` generates the plugin and marketplaces from `package.json`, `skills/` and documentation; `check` reports drift. Do not edit generated plugin files by hand. The generator also writes Pi's `workflow-guide` and `execution-router` skills under `plugins/pi/skills/`.

### Local development

```sh
npm run build
node tools/release/plugins.mjs dev /tmp/aw-dev
claude --plugin-dir /tmp/aw-dev/plugins/agent-workflow
```

Use `--force` to rewrite a development marketplace. Its server command uses absolute paths: `<node> <checkout>/src/mcp/host-server/bin.mjs --host claude-code|codex`.

Use a throw-away `CODEX_HOME` for Codex integration probes: `codex app-server`'s `thread/start` can write project trust into its configuration. Do not probe against the user's real configuration.

### Plugin limits

The generated completion-hook command uses POSIX shell. Windows `npx.cmd` startup and Git Bash hook behavior have not been verified.

## Pi

The Pi extension provides `/aw`, four agent tools, a run board, a profile picker, session-start notices and completion delivery. Pi is the parent agent; workflow workers use the selected executor, profile or default `pi`. Actions use the shared [host API](extending.md#host-api), as do the [CLI](cli.md) and [MCP host](#mcp-server).

### Pi install

Requires Pi 1.1 or newer. Pi supplies the optional `@earendil-works/pi-coding-agent` and `pi-ai` peer dependencies.

```sh
# One invocation, without changing Pi settings:
pi -e ./node_modules/@agwab/agent-workflow/dist/hosts/pi/index.js
pi -e npm:@agwab/agent-workflow

# Install as a Pi package; add -l for the project:
pi install npm:@agwab/agent-workflow
```

The package registers the extension and two skills: `/skill:workflow-guide` (authoring and scaffolds) and `/skill:execution-router` (route recommendation). The MCP protocol skill is not exposed in Pi; `aw_*` tools carry their own guidelines.

Importing `@agwab/agent-workflow/hosts/pi` outside Pi without its peer raises `PiHostUnavailableError`, not a bare module-resolution error. Other package modules do not import the Pi host.

### `/aw` command

A Pi session started in the home directory uses `~/.agent-workflow/home-runs` for every action and tool; the home directory itself is not a project.

`/aw help` lists actions; `/aw help <action>` shows shared action help. Text results appear as Pi notifications (stdout/stderr in print/JSON mode); errors are error notifications.

| Command | Behavior |
|---|---|
| `/aw`, `/aw <run-id-or-prefix>` | TUI: [board](#board); outside TUI, `/aw` shows help and a bare run id is an unknown action |
| `help [action]` | Action list or shared action help |
| `list [--query T] [--offset N] [--limit N]` | Discover workflows |
| `validate <workflow>`, `roles <workflow>`, `agents` | Validate a spec, list its roles, or list agents |
| `profile` | TUI: [profile picker](#profile-picker); otherwise list profiles |
| `profile list \| show [name] \| set <name> … [--default] \| delete <name> \| default <name> \| default --clear \| presets` | Saved user profiles; CLI options include `--preset` and `--role` |
| `profile workflow list \| show <workflow> \| set <workflow> … \| clear <workflow>` | Per-workflow preferences applied by every host |
| `run <workflow> <task> [options]` | Launch a named workflow |
| `dynamic <task> [options]` | Launch a dynamic workflow |
| `auto <task> [options]` | Classify once and launch the top recommendation without asking, including print/JSON |
| `dashboard [<run-id-or-prefix>]` | Open this project's view in the user-level [web dashboard](#dashboard) |
| `status [run]` | Run status |
| `show <workflow>` / `show <run> [--raw]` | Workflow or run details |
| `inspect <run> [--failures] [--results]` | Reliability and results |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | Bounded, redacted log tails |
| `wait <run> [timeout \| --timeout D]` | Wait until settled/action required or timeout; default 60 s, max 4 h; bare number means milliseconds |
| `resume <run> [--detach]` | Continue a run |
| `stop <run>` | Stop a run |
| `prune [--keep N] [--older-than DAYS] [--yes]` | Prune stored runs |
| `notices list \| acknowledge <run> --state <sha256> --reason <text> \| clear <run>` | Manage unfinished-run notices |

Run options may lead or trail the task; quoted text is literal:

```text
--executor <id> --profile <name> --permission-mode free|safe
--allow-unverified <a,b> --model <id> --effort <level>
--input <key=value> (repeatable) --detach --force-new
```

`/aw run` returns after launch; the in-process watcher drives the run while Pi lives. Use `/aw wait`, `/aw status` or `aw_wait` for progress. `--detach` starts a standalone supervisor that outlives the session. `supervise` itself is CLI-only (MCP: `workflow_supervise`).

Run output names `/aw` follow-up commands. Logs are contained to the [state directory](usage.md#where-run-state-lives)'s `.agent-workflow/` and redact credentials; completion messages use the same redaction.

### Pi tools

| Tool | Parameters |
|---|---|
| `aw_list` | `query?`, `offset?`, `limit?` (1–20, default 20) |
| `aw_run` | `workflow`, `task`, `executor?`, `profile?`, `permissionMode?` (`free`/`safe`), `allowUnverified?` (string[]), `model?`, `effort?`, `detach?`, `forceNew?`, `inputs?` (object), `awaitTerminal?`, `timeoutMs?` (1000–14400000, requires `awaitTerminal`) |
| `aw_dynamic` | `task` and the same launch options |
| `aw_wait` | `runId`, `timeoutMs?` (1000–14400000, default 1800000) |

`AGENT_WORKFLOW_TOOL_EXPOSURE=deferred` registers all `aw_*` tools with deferred exposure: Pi loads them through `tool_search` instead of including them in every request. Unset or any other value uses normal registration ([environment.md](usage.md#environment-variables)).

Results contain handler text in `content` and handler data plus `outcome`/`ok` in `details`. Launches add `waitWith`. Refused launches set `isError: true` and `details.refusal`; usage errors throw with the host API message.

An identical active launch returns `details.outcome: "existing"`, its `runId`/`duplicateOf`, and `waitWith`, including for detached runs. `forceNew: true` starts another.

`aw_wait` streams progress through `onUpdate` and returns `terminal`, `actionRequired`, `stillRunning`, `semanticStatus`, bounded authoritative `preview`, `reportArtifacts` and `taskSummary`. It waits until settled/action required or timeout (default 30 min, max 4 h); `stillRunning` means the timeout came first.

`awaitTerminal: true` on a launch returns the wait result with launch details under `details.launch`. It is mutually exclusive with `detach`; launch `timeoutMs` requires it. Cancelling the call stops only the wait. A settled awaited result is not delivered again as a completion message; timeout/cancel leaves the run tracked for later delivery.

`inputs` is the object form of `--input`: declared keys only. Strings are converted to the declared number, boolean or JSON type; other values must already match. Invalid input is refused before launch ([workflow inputs](usage.md#workflow-inputs---input-keyvalue)).

### Board

`/aw` opens the run list; `/aw <run-id-or-prefix>` opens that run's stages, pinning a child run otherwise omitted from the list. This requires TUI mode and `ctx.ui.custom`; RPC/print/JSON keep text behavior. The command returns when the board closes.

Navigate runs → stages → tasks → task detail. The list includes all top-level project runs, with progress and executors. The side pane shows id, timing, verdict, report paths, parent-session usage and launch details. Problem tasks appear first. Task details include executor/model/effort, status reason, last message and up to 400 lines each of output, stderr and events.

| Key | Where | Action |
|---|---|---|
| ↑/↓, `k`/`j`, `[`/`]`, `p`/`n` | Lists | Move, wrapping |
| Enter, →, `l` | Lists | Drill down |
| Esc, ←, `h`, `b`, Backspace | Lists/detail | Back; Esc on run list closes |
| `q`, Ctrl+C, Ctrl+D | Anywhere | Close |
| `r` | Anywhere | Refresh; also automatic every 2 s |
| `v` | Runs/stages/tasks | View redacted launch command; control/bidi characters escaped |
| `c` | Launch viewer/runs/stages/tasks | Copy exact launch command |
| ↑/↓; `b`/Esc | Launch viewer | Scroll; back |
| ←/→ | Task detail | Switch output/stderr/events |
| ↑/↓ | Task detail | Scroll logs |
| `[`/`]`, `p`/`n` | Task detail | Previous/next task in stage |
| `s` | Anywhere | Stop selected run after `y` |
| `u` | Anywhere | Resume failed/interrupted/blocked run, attached, after `y` |
| `y` / `n` / Esc | Confirmation | Yes / no / cancel |

Reads and actions use only the host API. Resumed runs are tracked for completion. Task details show logs, not task prompts.

### Profile picker

`/aw profile` opens the TUI picker; outside TUI it lists profiles. Text operations remain available.

1. Choose scope: a saved user profile for every workflow, or one workflow's saved preference. The launch chooser's `Custom…` skips this step.
2. Choose preset (`Codex`, `Claude`, `Pi`, `Mixed`), saved profile, or `Custom…`. Custom starts from the current choice, otherwise `Pi`.
3. Preview executor/model/effort per role: `default`, `planning`, `research-execution`, `synthesis`, `verification`, `final-judgment`, then `agent:<name>`. Missing role entries inherit the default. Warnings show missing/logged-out executors and unknown models (complete model lists cause launch refusal; partial lists only note the mismatch). Below 66 columns, rows stack over two lines.
4. Edit roles: choose executor (`pi`, `claude`, `codex`), model (executor default, probed list or manual id), effort, or remove the role. Changing executor clears the model. Probes make no model calls; edits write nothing until Save.
5. Save. User scope can update/create a named profile and make it default; an unedited saved profile only asks about making it default. Workflow scope saves the base profile and differing role overrides, replacing earlier overrides. A preference cannot remove a base-profile role; the picker warns and keeps it.

Back/cancel writes nothing. Workflow-declared execution profiles remain in the launch chooser, not the picker.

### `/aw auto`

`/aw auto <task> [options]` sends one tool-less classifier request and launches its top
recommendation without consent or choice dialogs, including in print/JSON mode. Failure starts
nothing. The TUI comparison loader can still cancel the operation; session shutdown also cancels
it. Launch metadata records consent `command`. Stop a published run with `/aw stop <run>`.
There is no `aw_auto` tool.

### Profile choice

Capability degradations are recorded and shown without confirmation. Refusals remain enforced.

Workflow-declared execution profiles are offered through `ctx.ui.select` when none is named. Without UI, the declared default or base spec is used; output names the selected profile and available alternatives. Explicit profiles or saved per-workflow preferences skip the chooser.

In the TUI, `/aw run` also offers `Custom… (open the profile picker)`. This cancels the launch attempt and opens the [picker](#profile-picker) for that workflow. Saving a per-workflow preference retries the launch with that preference; closing without saving starts nothing. RPC and agent tools keep the plain chooser.

Each call uses Pi's cwd and model registry. Pi's current model and thinking level supply runtime defaults when no executor or `pi` is explicitly selected; explicit `--executor codex` does not inherit them. Saved per-workflow preferences and stage overrides are resolved once for both launch and duplicate identity, so changing them starts a new run.

### `/aw dashboard`

`/aw dashboard [<run-id-or-prefix>]` opens the user-level dashboard with the current project selected in the browser, starting it detached if necessary. A one-time launch URL keeps session tokens and launch keys out of chat. The board remains the in-terminal view. See [Dashboard](#dashboard) for authentication and lifecycle options.

### Host tools for Pi workers

Pi 1.1 with native MCP (`pi.getMcpServers`) and project trust (`ctx.isProjectTrusted`) can lend native tools to Pi workers. Launch records host context references (cwd, agent-workflow home, project trust), never MCP configuration or credentials.

Only non-readOnly Pi tasks inherit `codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`. These are mutation-capable; permission-mode worktree/approval rules apply. Declared or negotiated readOnly tasks get none. In mixed runs the decision is per task; Claude/Codex inheritance is a separate opt-in. Older Pi hosts and CLI/MCP hosts do not enable this inheritance.

The capability preview names inheriting/excluded stages; `run.capabilityNegotiation.stages[].hostTools` is `inherited`, `readOnly`, `no-tools` or `executor` (not Pi).

Inheritance uses file configuration: workers read the user's `mcp.json`; live parent MCP connections and `registerMcpServer()` registrations are not transferred. Under isolation (`--no-approve`), workers do not load a trusted project's `.pi/mcp.json`; recorded project trust is not yet used.

### Session start

Startup work is asynchronous and does not delay Pi. In supervisor role, the host re-drives project runs with scheduler work and no live driver. A held lease or a live other pid with a supervisor heartbeat younger than 30 s prevents takeover. Blocked runs stay blocked. Workers that died without terminal records are reconciled; unknown outcomes block as `executor_needs_decision`, never automatically relaunch.

Re-driving does not take over completion delivery: the original audience session still owns it. Attached runs continue only while Pi runs; use `--detach` to outlive sessions.

The host then warns about unfinished top-level failed/interrupted runs and blocked runs needing executor decisions. It excludes mock runs, active acknowledgements and runs not updated for 7 days; at most 5 appear. Rendered degraded finals are labeled `failed (final rendered — degraded)`. Malformed acknowledgement sidecars suppress nothing.

Notices repeat after status/update changes, stale acknowledgement or 6 hours. Claude Code and Codex give the same reminder through their prompt hook ([unfinished-run reminders](#unfinished-run-reminders)). State lives in `.agent-workflow/workflows/unfinished-notices.json` in the
[project state directory](usage.md#where-run-state-lives). Silence a state with `/aw notices acknowledge <run> --state <sha256> --reason <text>`.

### Status line and completion delivery

With UI (TUI/RPC), launches, resumes and duplicate-existing results bind a run exclusively to the first Pi session in `<run dir>/pi-feedback-audience.json`. Other sessions do not track or receive it.

- **Status:** the `agent-workflow` footer shows `aw: <name> <completed>/<total> running`, with `+N more` for additional runs. One timer polls tracked `run.json` files every second without driving execution, updating only on text changes. It stops when inactive or on shutdown.
- **Completion:** settled runs (completed/failed/interrupted/blocked) produce an `agent-workflow-completion` custom message with status, counts, problem task, separate domain verdict and semantic run status, report paths, bounded preview and next commands. User-command launches do not start agent turns; tool launches deliver a follow-up instructing the agent to treat the message as data and present the result. TUI shows only the message; RPC/other UI modes also receive an info/warning notice.
- **Restart:** at session start, active audience-owned runs are tracked again. Up to 5 top-level runs updated within 7 days receive catch-up completion without starting a turn.

Delivery is once per session/run/settled state in normal operation. Resuming and settling again creates a new state. Receipts under `<run dir>/pi-feedback-receipts/<epoch>.json` reconcile with session history: messages queued in a live runtime are not resent; history confirmation prevents duplication after restart. `/reload` keeps the queue, while `/new`, `/resume`, `/fork` and quit dispose it. A missing history entry can cause redelivery after a crash or queue disposal. A module upgrade across receipt process-state schemas may produce at most one duplicate.

Another live process's unconfirmed delivery is deferred for at most 10 min while its queue lifetime remains alive. With unreadable history, recovery allows at most 2 enqueue attempts per epoch, including orphaned pending reservations; two crashes before sending can exhaust this budget without delivery. Throwing sends retry at most 4 times before an error notification. Queue-end tombstones live in the state directory's `.agent-workflow/pi-feedback-queue-ends`, expire after 20 min and are capped at 1024 files. Symlinked directories are not written or pruned; recovery then waits for the 10 min window.

#### Session-owned waits

`aw_wait` refuses runs owned by another Pi session. Unowned CLI/MCP/print-mode runs may be waited on without recording ownership. Contexts without session ids own nothing and receive no footer/completion delivery.

While the owning session waits through `aw_wait` or an awaited launch, completion messages are held back. A settled tool result is the presentation; its `details.feedbackEpoch` lets session history confirm it. Timeout/cancel releases the hold for later completion delivery. If a completion already arrived, the tool reports `details.completionAlreadyDelivered`. User-command `/aw wait` does not suppress the completion message.

### Active workflows widget and foreground loader

With UI, the `agent-workflow-active` widget below the editor lists active runs tracked by this session, newest first, at most 5 plus an overflow count. It clears when no tracked run is active and at shutdown.

In TUI, `/aw wait` uses a cancellable loader: `Waiting for <run> (Esc stops waiting; the run continues)…`. Escape cancels only the wait. RPC waits without a custom loader; agent tools use Pi's normal tool progress and turn cancellation. Launch/resume commands return after startup and need no loader.

### Parent-session usage

Runs launched, resumed or returned as existing in this session track parent assistant usage in `<run dir>/parent-usage.json`, including print mode. Assistant messages while active contribute usage; the first after settlement counts once as wrap-up. Session start resumes counting owned active runs; shutdown flushes it.

The sidecar contains numbers, timestamps, session id and message hashes, never message content. Other sessions' runs are not written. Status and inspect expose totals as `parentUsage` and show whether counting is ongoing. MCP hosts cannot collect parent usage because the server cannot observe it.

### Process roles

With `AGENT_WORKFLOW_ROLE=worker` or `disabled`, tools and notices are not registered. `/aw help` and `/aw validate` remain available; other actions are refused by the host API.

### Pi limits

- The profile picker edits role profiles, not workflow-declared execution profiles.
- Runtime defaults follow the explicit executor option: a profile selecting a non-Pi executor can still receive Pi's current model as its lowest-precedence default.
- Completion recovery with unreadable history has the bounded retry limits described above, not an unconditional delivery guarantee.

## Dashboard

`agent-workflow dashboard` serves one localhost-only dashboard for all registered projects: progress, stages, agent activity, logs, results and items needing attention. Stop, Resume, Approve and Reject use the shared [host API](extending.md#host-api). The dashboard takes no run lease and makes no model calls itself; resuming or approving can continue model work.

### What it shows

The sidebar project switcher selects a project or **All projects**. The overview shows project paths (including missing paths), active runs, needs-attention counts and last activity from status summaries. `?project=<id>` selects a project; the last choice is remembered in this browser. Only the selected project is polled in detail. Inside a project, the sidebar lists runs with task previews, timing, progress and reports. **Needs you** collects executor decisions and failed/blocked runs. Failures can be dismissed in this browser; decisions cannot. A stopped run offers Resume rather than appearing as a new need.

The sidebar has **Runs · Workflows · Profiles · Maintenance · Executors**. Management views are deep-linkable with `?project=<id>&view=workflows|profiles|maintenance|executors`; switching projects keeps the management view. There is no launch form: start runs with `aw run`, `aw dynamic`, `aw auto`, the CLI, MCP or Pi.

| View | Scope | Management |
|---|---|---|
| Runs | Selected project (or All projects overview) | Existing run, task and report views |
| Workflows | Selected project | Discover workflows and agents, source/scope and routing hints; inspect stages, compiled roles and validation; **Check** executor/profile/model/effort/permission mode without starting a run or calling a model |
| Profiles | User level, shared by every project and host | List/show/create/edit/delete profiles, apply presets, set/clear the default, and edit role assignments using probed executor/model choices. Executor default profiles (codex, claude, pi) are listed with what their stages get; Edit saves only your changes, Restore built-in deletes them. Per-workflow preferences are also user-level; the selected project supplies the workflow definition and declared profiles. |
| Maintenance | Selected project's runs/notices | Prune preview/delete and notice acknowledgement/clear. The shared prune action also previews user-level executor attempt state and stale project launch claims. |
| Executors | User level | Installed CLI/version vs verified version, login state, default executor and why, permission-mode default and warnings. Reports are cached for 60 seconds; **Refresh** invalidates report and probe caches. |

Empty states explain how to add definitions or profiles. Action errors appear inline. Command hints use `agent-workflow` CLI commands or the minimal `aw run <workflow> "<task>"`; `aw` uses saved defaults and does not parse launch flags. To reproduce explicit Check overrides, use the displayed CLI command.

**Prune confirmation rule:** Preview calls the shared `pruneAction` in dry-run mode with bounded keep/older-than parameters. It shows run selections, protections, adapter paths and stale launch claims. The server hashes the complete unredacted preview, project identity and parameters into a SHA-256 digest. Delete sends those same parameters and digest; the server serializes management pruning, recomputes the dry run and only calls `pruneAction` with `yes: true` when the digest matches. A changed preview returns **409**, includes the new preview and deletes nothing. The UI requires a fresh Preview after a mismatch or parameter edit. Shared prune protections (active runs/leases, retained references, owned sessions, worktrees and evidence) remain authoritative at deletion time, including changes made by another host. Notice acknowledgement requires the listed run-state hash and a reason; it changes notifications, never run history or resume authority. Dashboard users are the actors for these confirmed host actions; there are no extra MCP confirmation dialogs.

The run view separates process status from the workflow's verdict: a workflow may finish its work and still report “Needs work”. The graph shows stages, dependencies and agent progress. Code steps are hidden by default; Show/Hide remembers your choice. Failed, running, attention-required or selected code steps remain visible. Fit, Focus and direction controls help navigate larger graphs.

Select a stage or agent to see activity, results, output, stderr or events. Finished agents expand in place; **Open agent** shows full detail and log tabs. Run details show the task, redacted launch command, permission mode, host and usage. Unreported cost is `null`/“Not collected”, not zero.

Reports and task results render text-only Markdown, with no active links, images or HTML. Code highlighting loads locally when available and falls back to plain text. The report's Light/Dark page choice is independent of the dashboard's Auto/Light/Dark theme. Theme, sidebar and display choices are stored in this browser.

Stop explains its impact and records a durable request for the supervisor. Resume does not relaunch completed tasks. Approval dialogs show the controller question and scope; rejecting leaves the run blocked.

`Live`, `Reconnecting` and `Stale (updated …)` describe the connection, not run status. Stale appears after 30 s without a heartbeat. Reduced-motion preferences disable animations. Keyboard controls include ↑/↓ navigation, Enter, Escape, `⌘K` search, and `j`/`k` between agents. Clicking empty canvas closes the inspector; dragging pans instead.

Deep-link state includes `project`, `run`, `stage`, `task`, `tab=result|output|stderr|events`, `view=report|details|workflows|profiles|maintenance|executors`, and `dialog=stop|resume`.

### Start, stop and options

```sh
agent-workflow dashboard [--port <n>] [--readonly] [--auth] [--open] [--project <dir>]
agent-workflow dashboard --status [--project <dir>]
agent-workflow dashboard --stop [--project <dir>]
agent-workflow dashboard --reset-session [--project <dir>]
```

- Binds **127.0.0.1 only**, never `0.0.0.0` or IPv6-any. Defaults to **7417**, then 7418–7426, then an ephemeral port if other listeners occupy them. Explicit `--port` / `AGENT_WORKFLOW_DASHBOARD_PORT` is strict. With `AGENT_WORKFLOW_HOME` set, reuse `<home>/dashboard-port` if free, else use an ephemeral port; custom homes never take the default range automatically.
- `--project` defaults to cwd and chooses the opened project view only. The server always covers the user registry at `<home>/projects/*/project.json` (`<home>` = `AGENT_WORKFLOW_HOME` or `~/.agent-workflow`).
- Foreground mode prints the URL and runs until SIGINT/SIGTERM (exit 0). Usage errors, including unavailable/invalid ports or a non-directory project, exit 2.
- `--open` opens the browser. Default URLs need no sign-in; with `--auth`, the printed foreground URL includes a session token.
- `--readonly` disables controls and rejects every mutation with 403.
- `--status` reports discovery state, pid, port, start time, auth mode and detached idle-exit timing. `--stop` sends authenticated `POST /api/shutdown` and waits for discovery removal. These management options act on the user-level server, regardless of `--project`.
- `--detached` runs in the background without printing a session URL. Detached servers exit after 2 h with no SSE client and no running/blocked run in any project; foreground servers never idle out.

### Security model

**Default: no sign-in.** Any local OS user or process able to reach the port can view runs, edit shared profiles/preferences, prune history and use Stop/Resume/Approve/Reject. Use `--auth` on shared machines and `--readonly` when mutations are unwanted. Loopback binding does not isolate users on the same machine.

| Threat | Control |
|---|---|
| Local access (`--auth`) | 256-bit random user-level session token; required except for bootstrap/sign-in routes |
| Token exposure (`--auth`) | `?token=…` sets `HttpOnly; SameSite=Strict; Path=/` cookie, then 302 redirects to a token-free URL; `Referrer-Policy: no-referrer` |
| DNS rebinding / foreign pages | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 421); no CORS headers |
| CSRF | Mutations require POST/PUT/DELETE, JSON content type, matching `Origin` and `X-AW-CSRF` from same-origin `GET /api/session`. Default mode requires `Sec-Fetch-Site: same-origin`; otherwise, when present, it must be `same-origin` or `none`. With auth, CSRF is tied to the token by HMAC. |
| Untrusted output | Text DOM nodes, no `innerHTML`; reports cannot execute HTML or load content resources |
| Browser execution | CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`; no inline scripts/styles or external resources |
| Response leakage | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, no-referrer |
| Secrets and paths | Host API containment/redaction; result files contained to the project's artifact root and redacted |
| Unbounded reads | Logs ≤400 lines / ≤48 kB per call; report ≤256 kB with truncation notice; task result files ≤1 MiB each, analysis ≤60,000 characters, control ≤40,000 characters, references ≤100 |
| Read-only mutation | Server-side 403 `{ "error": "read-only" }`; UI controls also disabled |

The UI receives a projection, not raw run records. Task activity labels describe tool intent, never tool output; URLs omit query/fragment, paths are relative or reduced to basenames, and secret-like values are redacted.

### Management HTTP API

Responses use the shared host action's `{action, ok, outcome, data, text}` envelope (workflow detail combines `spec`, `roles`, `validation`). All payloads and errors pass through dashboard redaction. Every write below requires JSON, exact Origin, fetch metadata and the session CSRF token; `--readonly` returns 403, including for Check and prune preview. Reads use the existing optional session-cookie authentication. Workflow references must be names present in the catalog; only a server-discovered spec path is passed to an action, never a request path. Project ids must be valid registry entries. Bad input is 400, unknown projects/workflows/profiles are 404; stale prune/notice state is 409. Doctor, models, Check and pruning use a bounded serialized server queue; executor probes retain their existing time budgets.

| Method | Path | Shared action |
|---|---|---|
| GET | `/api/projects/<id>/workflows` | `listWorkflowsAction` |
| GET | `/api/projects/<id>/workflows/<name>` | `showWorkflowSpecAction`, `workflowRolesAction`, `validateWorkflowAction` |
| POST | `/api/projects/<id>/workflows/<name>/check` | `checkWorkflowAction` (optional executor/profile/model/effort/permissionMode) |
| GET | `/api/projects/<id>/agents` | `listAgentsAction` |
| GET | `/api/profiles`, `/api/profiles/<name>`, `/api/profiles/presets` | `profileAction` list/show/presets |
| PUT / DELETE | `/api/profiles/<name>` | `profileAction` set/delete; PUT accepts values/unset/preset/makeDefault |
| PUT | `/api/profiles-default` | `profileAction` default (`{name}` or `{name:null}`) |
| GET | `/api/workflow-preferences` | `workflowPreferenceAction` list |
| GET / PUT / DELETE | `/api/workflow-preferences/<workflow>[?project=<id>]` | `workflowPreferenceAction` show/set/clear; project defaults to the server's initial directory when omitted |
| GET | `/api/executors/models[?executor=<id>]` | `executorModelsAction` |
| GET | `/api/doctor[?refresh=1]` | `doctorAction` |
| POST | `/api/projects/<id>/prune/preview`, `/api/projects/<id>/prune` | `pruneAction` dry-run / confirmed; keep 0–100000, olderThanDays 0–36500 integer days; Delete requires digest |
| GET | `/api/projects/<id>/notices` | `noticesAction` list |
| POST | `/api/projects/<id>/notices/<run>/acknowledge`, `/api/projects/<id>/notices/<run>/clear` | `noticesAction` acknowledge (`{state,reason}`) / clear |

### Authentication

Enable with `--auth` or `AGENT_WORKFLOW_DASHBOARD_AUTH=1` (also applies to auto-started servers).

The session token is stored in `<home>/dashboard-session` (0600, 32 random bytes base64url) and reused across restarts, so signed-in browser cookies remain valid. `--reset-session` stops a running dashboard and rotates the token, requiring browsers to sign in again.

Unauthenticated UI requests receive a 401 sign-in page (`/app.css` remains public). **Sign in on this computer** calls `POST /api/signin-local`; matching Origin and `Sec-Fetch-Site: same-origin` are required, with one call per 3 s. The server opens a one-time URL through the OS browser opener; it never returns that URL to the page. Alternatively, use `agent-workflow dashboard --open` or ask the host to open it.

One-time auth launch tokens contain 32 random bytes, expire after 60 s and are single-use. The persistent session token remains available for manual sign-in.

### Launch integration

`run`, `dynamic` and launched `auto` operations auto-start a detached dashboard if needed and print a token-free link:

```text
Dashboard: http://127.0.0.1:<port>/?project=<project-id>&run=<id>
```

Launch data includes `dashboard: {url, port, started?: true, auth?: true}`. Startup waits at most 3 s. Dashboard failure never fails the workflow launch; the fallback is `Dashboard: not running · agent-workflow dashboard --open`.

When `wait` returns a settled or blocked run, it supplies the dashboard link again. Finished runs with reports use `&view=report`.

Auto-start never opens a browser. Opening is opt-in through CLI `--open`, `AGENT_WORKFLOW_DASHBOARD_OPEN=1`, Pi `/aw dashboard`, or MCP `workflow_dashboard`. Environment-requested opening is suppressed when `CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT` or `AI_AGENT` is set, or the host is Pi/Codex/Claude Code. Explicit `--open` overrides suppression. Openers honor `BROWSER`/`BROWSER_ARGS`.

Set `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0` to disable auto-start. It is also disabled for worker roles and read-only contexts. Browser-opening host behavior is documented in [MCP dashboard opening](#dashboard-opening) and [Pi dashboard command](#aw-dashboard).

The last port is stored in `<home>/dashboard-port`. Custom homes reuse it when free; default homes try the fixed range again. With auth, persistent cookies survive restarts.

### Dashboard environment variables

| Variable | Meaning |
|---|---|
| `AGENT_WORKFLOW_DASHBOARD_PORT` | Strict port override (1–65535) |
| `AGENT_WORKFLOW_DASHBOARD_AUTH=1` | Require sign-in, including auto-started servers |
| `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0` | Disable automatic dashboard startup |
| `AGENT_WORKFLOW_DASHBOARD_OPEN=1` | Open after launch, subject to agent suppression |
| `AGENT_WORKFLOW_DASHBOARD_IDLE_MS` | Detached idle timeout; default 2 h, minimum 1 min |
| `AGENT_WORKFLOW_DASHBOARD_POLL_MS` | SSE poll interval; default 1000 ms, range 500–10000 ms |
| `BROWSER`, `BROWSER_ARGS` | Browser opener command and arguments |

### Dashboard HTTP API

JSON responses use `Content-Type: application/json; charset=utf-8`. Errors are `{ "error": string }` with 400/401/403/404/409/421/500 as appropriate. Auth mode requires a session except on bootstrap/sign-in routes; mutations require the controls above. Project ids must match `^[a-z0-9-]{1,32}-[0-9a-f]{12}$` and exist in the private registry before any project-state access; request paths never choose directories. Unknown ids return 404, malformed ids 400. Run ids must match `^workflow_[A-Za-z0-9_-]+$`; prefixes are not accepted over HTTP.

| Method & path | Result |
|---|---|
| `GET /?launch=…` | Mark launch consumed; 302 to `/`, forwarding valid `project`, `run`, `task`, `tab`, `view`; unknown ids ignored and stray tokens dropped in default mode |
| `GET /?token=…` (`--auth`) | Set cookie and redirect, forwarding valid UI parameters without token |
| `GET /`, `/app.js`, `/app.css` | UI assets |
| `GET /api/session` | `{apiVersion: 2, mode: "read-write" \| "read-only", auth, csrf, serverTime, version}` |
| `GET /api/projects` | `{serverTime, projects: [{id, name, path, pathMissing, lastSeenAt, counts: {running, needsAttention, lastActivity}}]}`; cheap status summaries |
| `GET /api/identity?nonce=<random>` | `{protocol, version, proof}`; HMAC-SHA256(launchKey, nonce), no credentials sent |
| `POST /api/shutdown` | Launch-key-authenticated user server shutdown |
| `GET /api/projects/:projectId/runs` | `{serverTime, runs}`; top-level run summaries, newest first |
| `GET /api/projects/:projectId/runs/:runId` | Full dashboard projection |
| `GET /api/projects/:projectId/runs/:runId/tasks/:taskId/logs?stream=output\|stderr\|events\|all&lines=1..400` | Host API task log data, including truncation/refusal information |
| `GET /api/projects/:projectId/runs/:runId/tasks/:taskId/result` | `{digest?, analysis?, refs?: [{title?, url?, note?}], control?, *Truncated?}`; `{}` if known task has no results; 404 if unknown |
| `GET /api/projects/:projectId/runs/:runId/report` | `{path, text, truncated}` for first report artifact, or 404 |
| `GET /api/events?project=<projectId>[&run=<runId>]` | SSE `runs`, selected `run`, and 15 s `heartbeat`; initial payload immediately, later payloads only when content changes |
| `POST /api/projects/:projectId/runs/:runId/stop` | `{outcome, status, pending, interruptedTaskIds, text}` |
| `POST /api/projects/:projectId/runs/:runId/resume` | Detached resume: `{outcome, status, resetTaskIds, text}` |

Overview counts use status summaries: `running` includes running/blocked runs, `needsAttention` counts blocked/failed runs or runs with failed tasks, and `lastActivity` is the latest update (or `null`). No task logs or reports are read for overview polling.

#### Dashboard projection

Run summaries include `runId`, `name`, `status`, `statusDetail?`, timestamps, redacted `taskPreview?` (≤140 characters), executor(s), host, task/agent counts, verdict, report availability, `needsYou` and `live` (a supervisor holds the lease). A `running` run with `live: false` and no recent launch is shown as stalled: the status text says `no live driver`, the dashboard says `Stalled`. The status stays `running`.

Full runs add the redacted runtime task, permission mode, usage (or `null`), redacted launch details and tasks. Tasks include ids, kind, agent, state/reason, dependencies, executor/model/effort, timing, retry information, last message, usage, worktree, log availability, item title, outcome and current activity.

Agent counts exclude foreach placeholders, support helpers and controllers. `needsYou` contains `executor_needs_decision` tasks, and failed/blocked runs. Cost is `null` unless reported by the executor.

### Discovery file

`<home>/dashboard.json` is written with mode 0600 after listening and removed on clean shutdown:

```json
{"schema":"agent-workflow-dashboard-v1","pid":12345,"port":7417,"url":"http://127.0.0.1:7417/","home":"<home>","protocol":2,"version":"0.1.0","startedAt":"…","launchKey":"<32 random bytes, base64url>","auth":false}
```

`launchKey` is a local control secret, never printed and distinct from the session token. Missing `auth` means the server requires sign-in. Readers require a live pid and verify `GET /api/identity?nonce=<random>` against HMAC-SHA256(launchKey, nonce), never sending the key or session token before identity is proven. A foreign listener is not adopted. A private O_EXCL `<home>/dashboard.lock` serializes discovery → spawn → adoption; dead or expired holders are reclaimed. A newer protocol launcher authenticates shutdown of an older server and restarts on its port; older launchers reuse newer servers. Local discovery/launch requests time out after 3 s. Dead-pid discovery files are removed.

#### One-time launch URLs

`POST /api/launch` requires loopback/Host checks and `X-AW-Launch-Key` (timing-safe comparison), not cookie/CSRF. JSON accepts optional validated `project`, `run`, `task`, `tab`, `view`; response is `{url, launchId}`. A bad key returns 401; more than 16 outstanding launches returns 429.

Default URLs use `?launch=<id>` only to signal browser arrival; auth URLs use one-time `?token=<token>`. `GET /api/launch/:id`, protected by the launch key, reports consumption so MCP URL elicitation can complete. Session tokens and launch keys never appear in host tool results.

### Dashboard limits

Per-project dashboard files are no longer read or written. The registry is validated for schema, id, private permissions and owner; missing project paths remain visible.

If port 7417 is occupied, output prints the real URL and explains the fallback. A bookmark to 7417 can break after idle exit if another listener takes that port. Bind permission failures (EPERM/EACCES) do not retry: start the dashboard from a terminal, hook or MCP server instead of a sandboxed model shell. Workflow launches still succeed without it.

The dashboard does not support remote access, HTTPS, authentication beyond the local token, workflow editing or launching runs from the browser.

## Other hosts

### Antigravity CLI (agy) as a host

agy loads the converted plugin with `agy plugin install` and the MCP registration in `~/.gemini/config/mcp_config.json`; tools are called through `call_mcp_tool`. Interactive agy asks before commands. Headless `agy -p` auto-denies tools needing `command` permission because it cannot prompt. For unattended use, add `permissions.allow` rules in agy's `settings.json` (for example `command(node …)`), or use `--dangerously-skip-permissions`, preferably with `--sandbox`. User-level agy rules also apply.
