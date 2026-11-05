# Pi host (`@agwab/agent-workflow/hosts/pi`)

The Pi extension provides `/aw`, four agent tools, a run board, a profile picker, session-start notices and completion delivery. Pi is the parent agent; workflow workers use the selected executor, profile or default `pi`. Actions use the shared [host API](host-api.md), as do the [CLI](cli.md) and [MCP host](host-mcp.md).

## Install

Requires Pi 1.1 or newer. Pi supplies the optional `@earendil-works/pi-coding-agent`, `pi-ai` and `pi-tui` peer dependencies.

```sh
# One invocation, without changing Pi settings:
pi -e ./node_modules/@agwab/agent-workflow/dist/hosts/pi/index.js
pi -e npm:@agwab/agent-workflow

# Install as a Pi package; add -l for the project:
pi install npm:@agwab/agent-workflow
```

The package registers the extension and two prefixed skills, avoiding collisions with other packages: `/skill:aw-workflow-guide` (authoring and scaffolds) and `/skill:aw-execution-router` (route recommendation). The MCP protocol skill is not exposed in Pi; `aw_*` tools carry their own guidelines.

Importing `@agwab/agent-workflow/hosts/pi` outside Pi without its peer raises `PiHostUnavailableError`, not a bare module-resolution error. Other package modules do not import the Pi host.

## `/aw` command

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
| `auto <task> [options]` | Classify with consent, then launch the user's choice; print/JSON sends nothing |
| `dashboard [<run-id-or-prefix>]` | Open the project's [web dashboard](dashboard.md) |
| `status [run]` | Run status |
| `show <workflow>` / `show <run> [--raw]` | Workflow or run details |
| `inspect <run> [--failures] [--results]` | Reliability and results |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | Bounded, redacted log tails |
| `wait <run> [timeout \| --timeout D]` | Wait until settled/action required or timeout; default 60 s, max 4 h; bare number means milliseconds |
| `resume <run> [--detach]` | Continue a run |
| `approve <run> [--request <id>] [--reject] [--detach] [--yes]` | Answer a dynamic approval; no dialog UI requires `--yes` |
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

Run output names `/aw` follow-up commands. Logs are contained to `.agent-workflow/` and redact credentials; completion messages use the same redaction.

## Tools

| Tool | Parameters |
|---|---|
| `aw_list` | `query?`, `offset?`, `limit?` (1–20, default 20) |
| `aw_run` | `workflow`, `task`, `executor?`, `profile?`, `permissionMode?` (`free`/`safe`), `allowUnverified?` (string[]), `model?`, `effort?`, `detach?`, `forceNew?`, `inputs?` (object), `awaitTerminal?`, `timeoutMs?` (1000–14400000, requires `awaitTerminal`) |
| `aw_dynamic` | `task` and the same launch options |
| `aw_wait` | `runId`, `timeoutMs?` (1000–14400000, default 1800000) |

`AGENT_WORKFLOW_TOOL_EXPOSURE=deferred` registers all `aw_*` tools with deferred exposure: Pi loads them through `tool_search` instead of including them in every request. Unset or any other value uses normal registration ([environment.md](environment.md)).

Results contain handler text in `content` and handler data plus `outcome`/`ok` in `details`. Launches add `waitWith`. Refused launches set `isError: true` and `details.refusal`; usage errors throw with the host API message.

An identical active launch returns `details.outcome: "existing"`, its `runId`/`duplicateOf`, and `waitWith`, including for detached runs. `forceNew: true` starts another.

`aw_wait` streams progress through `onUpdate` and returns `terminal`, `actionRequired`, `stillRunning`, `semanticStatus`, bounded authoritative `preview`, `reportArtifacts` and `taskSummary`. It waits until settled/action required or timeout (default 30 min, max 4 h); `stillRunning` means the timeout came first.

`awaitTerminal: true` on a launch returns the wait result with launch details under `details.launch`. It is mutually exclusive with `detach`; launch `timeoutMs` requires it. Cancelling the call stops only the wait. A settled awaited result is not delivered again as a completion message; timeout/cancel leaves the run tracked for later delivery.

`inputs` is the object form of `--input`: declared keys only. Strings are converted to the declared number, boolean or JSON type; other values must already match. Invalid input is refused before launch ([workflow inputs](usage.md#workflow-inputs---input-keyvalue)).

## Confirmation and profile choice

With a dialog UI (`ctx.hasUI`, TUI or RPC), capability limits needing consent ask `ctx.ui.confirm("Proceed with these executor capability degradations?", <preview.prompt>)`. The short prompt lists each limit once with its stages; the full report is saved with the run. Decline refuses with `CAPABILITY_DEGRADATION_DECLINED`. Without UI, degradations are recorded as `non-interactive` and the run proceeds.

Workflow-declared execution profiles are offered through `ctx.ui.select` when none is named. Without UI, the declared default or base spec is used; output names the selected profile and available alternatives. Explicit profiles or saved per-workflow preferences skip the chooser.

In the TUI, `/aw run` also offers `Custom… (open the profile picker)`. This cancels the launch attempt and opens the [picker](#profile-picker) for that workflow. Saving a per-workflow preference retries the launch with that preference; closing without saving starts nothing. RPC and agent tools keep the plain chooser.

Each call uses Pi's cwd and model registry. Pi's current model and thinking level supply runtime defaults when no executor or `pi` is explicitly selected; explicit `--executor codex` does not inherit them. Saved per-workflow preferences and stage overrides are resolved once for both launch and duplicate identity, so changing them starts a new run.

## Board

`/aw` opens the run list; `/aw <run-id-or-prefix>` opens that run's stages, pinning a child run otherwise omitted from the list. This requires TUI mode and `ctx.ui.custom`; RPC/print/JSON keep text behavior. The command returns when the board closes.

Navigate runs → stages → tasks → task detail. The list includes all top-level project runs, with progress and executors. The side pane shows id, timing, verdict, report paths, approvals, parent-session usage and launch details. Problem tasks appear first. Task details include executor/model/effort, status reason, last message and up to 400 lines each of output, stderr and events.

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
| `a` | Anywhere | First pending approval: `y` approves/resumes, `x` rejects, Esc cancels |
| `y` / `n` / Esc | Confirmation | Yes / no / cancel |

Reads and actions use only the host API. Resumed runs are tracked for completion. Task details show logs, not task prompts.

## `/aw dashboard`

`/aw dashboard [<run-id-or-prefix>]` opens the project's local dashboard in the browser, starting it detached if necessary. A one-time launch URL keeps session tokens and launch keys out of chat. The board remains the in-terminal view. See [dashboard.md](dashboard.md) for authentication and lifecycle options.

## Profile picker

`/aw profile` opens the TUI picker; outside TUI it lists profiles. Text operations remain available.

1. Choose scope: a saved user profile for every workflow, or one workflow's saved preference. The launch chooser's `Custom…` skips this step.
2. Choose preset (`Codex`, `Claude`, `Pi`, `Mixed`), saved profile, or `Custom…`. Custom starts from the current choice, otherwise `Pi`.
3. Preview executor/model/effort per role: `default`, `planning`, `research-execution`, `synthesis`, `verification`, `final-judgment`, then `agent:<name>`. Missing role entries inherit the default. Warnings show missing/logged-out executors and unknown models (complete model lists cause launch refusal; partial lists only note the mismatch). Below 66 columns, rows stack over two lines.
4. Edit roles: choose executor (`pi`, `claude`, `codex`), model (executor default, probed list or manual id), effort, or remove the role. Changing executor clears the model. Probes make no model calls; edits write nothing until Save.
5. Save. User scope can update/create a named profile and make it default; an unedited saved profile only asks about making it default. Workflow scope saves the base profile and differing role overrides, replacing earlier overrides. A preference cannot remove a base-profile role; the picker warns and keeps it.

Back/cancel writes nothing. Workflow-declared execution profiles remain in the launch chooser, not the picker.

## `/aw auto`

`/aw auto <task> [options]` recommends a workflow and launches only the user's choice:

1. Build a local shortlist from the dynamic workflow and discoverable workflows using `routing` hints; no model call.
2. With dialog UI, ask `Send this task to <executor> to compare workflows?`, showing task, candidates and classifier executor/model. Executor precedence is explicit option, saved user profile, then `pi` with Pi's current model/thinking. No means nothing is sent or started.
3. Yes sends one tool-less classifier request. TUI shows `Comparing workflow candidates… (Esc cancels; nothing starts)`; Escape aborts the request. RPC shows a notification. Choose a ranked workflow, then confirm `Confirm selected workflow launch`. Normal profile/degradation dialogs still apply; the run is tracked for completion.
4. Print/JSON sends nothing and prints shortlist launch commands (exit code 1).

Session shutdown during comparison or questions cancels the operation. Once launched, the command returns like `/aw run`; stop it with `/aw stop <run>`. Metadata records candidates, recommendation, selection, classifier executor/model and consent `prompt`. There is no `aw_auto` tool: agents cannot initiate classification on their own.

## Dynamic-controller approval

With dialog UI, an attached run whose controller declares `dynamic.permissions.approval: "ask"` asks while this session drives it: attached launches, awaited tools, waits, resume and session-start re-drive.

The dialog is `ctx.ui.confirm("Run dynamic workflow controller?", <scope>, {timeout: 300000, signal})`. Yes runs the controller (`decidedBy: {host: "pi", via: "prompt"}`); no rejects for this run (`dynamic_approval_rejected`, never asked again); timeout leaves it blocked and resumable (`dynamic_approval_timeout`). Detached launches/resumes have no UI; print/JSON blocks as `dynamic_ui_unavailable`.

Answer later with `/aw approve <run> --request <id>` (or `--reject`), including approvals left by other hosts. Yes approves and resumes without relaunching completed tasks; no rejects. No dialog UI requires `--yes`, with flags supplying the decision. There is no `aw_approve` tool: approval belongs to the user.

## Host tools for Pi workers

Pi 1.1 with native MCP (`pi.getMcpServers`) and project trust (`ctx.isProjectTrusted`) can lend native tools to Pi workers. Launch records host context references (cwd, agent-workflow home, project trust), never MCP configuration or credentials.

Only non-readOnly Pi tasks inherit `codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`. These are mutation-capable; permission-mode worktree/approval rules apply. Declared or negotiated readOnly tasks get none. In mixed runs the decision is per task; Claude/Codex inheritance is a separate opt-in. Older Pi hosts and CLI/MCP hosts do not enable this inheritance.

The capability preview names inheriting/excluded stages; `run.capabilityNegotiation.stages[].hostTools` is `inherited`, `readOnly`, `no-tools` or `executor` (not Pi).

Inheritance uses file configuration: workers read the user's `mcp.json`; live parent MCP connections and `registerMcpServer()` registrations are not transferred. Under isolation (`--no-approve`), workers do not load a trusted project's `.pi/mcp.json`; recorded project trust is not yet used.

## Session start

Startup work is asynchronous and does not delay Pi. In supervisor role, the host re-drives project runs with scheduler work and no live driver. A held lease or a live other pid with a supervisor heartbeat younger than 30 s prevents takeover. Blocked runs stay blocked. Workers that died without terminal records are reconciled; unknown outcomes block as `executor_needs_decision`, never automatically relaunch.

Re-driving does not take over completion delivery: the original audience session still owns it. Attached runs continue only while Pi runs; use `--detach` to outlive sessions.

The host then warns about unfinished top-level failed/interrupted runs and blocked runs needing approval or executor decisions. It excludes mock runs, active acknowledgements and runs not updated for 7 days; at most 5 appear. Rendered degraded finals are labeled `failed (final rendered — degraded)`. Malformed acknowledgement sidecars suppress nothing.

Notices repeat after status/update changes, stale acknowledgement or 6 hours. State lives in `.agent-workflow/workflows/unfinished-notices.json`. Silence a state with `/aw notices acknowledge <run> --state <sha256> --reason <text>`.

## Status line and completion delivery

With UI (TUI/RPC), launches, resumes and duplicate-existing results bind a run exclusively to the first Pi session in `<run dir>/pi-feedback-audience.json`. Other sessions do not track or receive it.

- **Status:** the `agent-workflow` footer shows `aw: <name> <completed>/<total> running`, with `+N more` for additional runs. One timer polls tracked `run.json` files every second without driving execution, updating only on text changes. It stops when inactive or on shutdown.
- **Completion:** settled runs (completed/failed/interrupted/blocked) produce an `agent-workflow-completion` custom message with status, counts, problem task, separate domain verdict and semantic run status, report paths, bounded preview and next commands. User-command launches do not start agent turns; tool launches deliver a follow-up instructing the agent to treat the message as data and present the result. TUI shows only the message; RPC/other UI modes also receive an info/warning notice.
- **Restart:** at session start, active audience-owned runs are tracked again. Up to 5 top-level runs updated within 7 days receive catch-up completion without starting a turn.

Delivery is once per session/run/settled state in normal operation. Resuming and settling again creates a new state. Receipts under `<run dir>/pi-feedback-receipts/<epoch>.json` reconcile with session history: messages queued in a live runtime are not resent; history confirmation prevents duplication after restart. `/reload` keeps the queue, while `/new`, `/resume`, `/fork` and quit dispose it. A missing history entry can cause redelivery after a crash or queue disposal. A module upgrade across receipt process-state schemas may produce at most one duplicate.

Another live process's unconfirmed delivery is deferred for at most 10 min while its queue lifetime remains alive. With unreadable history, recovery allows at most 2 enqueue attempts per epoch, including orphaned pending reservations; two crashes before sending can exhaust this budget without delivery. Throwing sends retry at most 4 times before an error notification. Queue-end tombstones live in `.agent-workflow/pi-feedback-queue-ends`, expire after 20 min and are capped at 1024 files. Symlinked directories are not written or pruned; recovery then waits for the 10 min window.

### Session-owned waits

`aw_wait` refuses runs owned by another Pi session. Unowned CLI/MCP/print-mode runs may be waited on without recording ownership. Contexts without session ids own nothing and receive no footer/completion delivery.

While the owning session waits through `aw_wait` or an awaited launch, completion messages are held back. A settled tool result is the presentation; its `details.feedbackEpoch` lets session history confirm it. Timeout/cancel releases the hold for later completion delivery. If a completion already arrived, the tool reports `details.completionAlreadyDelivered`. User-command `/aw wait` does not suppress the completion message.

## Active workflows widget and foreground loader

With UI, the `agent-workflow-active` widget below the editor lists active runs tracked by this session, newest first, at most 5 plus an overflow count. It clears when no tracked run is active and at shutdown.

In TUI, `/aw wait` uses a cancellable loader: `Waiting for <run> (Esc stops waiting; the run continues)…`. Escape cancels only the wait. RPC waits without a custom loader; agent tools use Pi's normal tool progress and turn cancellation. Launch/resume/approve commands return after startup and need no loader.

## Parent-session usage

Runs launched, resumed, approved or returned as existing in this session track parent assistant usage in `<run dir>/parent-usage.json`, including print mode. Assistant messages while active contribute usage; the first after settlement counts once as wrap-up. Session start resumes counting owned active runs; shutdown flushes it.

The sidecar contains numbers, timestamps, session id and message hashes, never message content. Other sessions' runs are not written. Status and inspect expose totals as `parentUsage` and show whether counting is ongoing. MCP hosts cannot collect parent usage because the server cannot observe it.

## Process roles

With `AGENT_WORKFLOW_ROLE=worker` or `disabled`, tools and notices are not registered. `/aw help` and `/aw validate` remain available; other actions are refused by the host API.

## Other Pi extensions

The extension uses only `/aw`, `aw_*` tools and `aw-` skills. Runs live in `.agent-workflow/`.

## Limits

- The board lists all top-level project runs, not just the current session's. A dynamic approval dialog replaces an open board or wait loader. The wait continues after the answer without its loader; start another `/aw wait` and press Escape to cancel waiting, or let it finish.
- The profile picker edits role profiles, not workflow-declared execution profiles.
- Runtime defaults follow the explicit executor option: a profile selecting a non-Pi executor can still receive Pi's current model as its lowest-precedence default.
- Completion recovery with unreadable history has the bounded retry limits described above, not an unconditional delivery guarantee.
