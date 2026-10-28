# Host UX investigation: progress display and completion delivery (WP36)

Owner decisions (2026-10-26): **E1** v1 gives Claude Code a status line plus the query tools, and
Codex the query tools, notifications and a `watch`; **E2** completion uses the common mechanism by
default, host features are added once verified; **Q6** investigate, then decide push with a live
check. Open problem 3 of [live bundle 4](live-acceptance-stage2.md#open-problems): MCP hosts gave
up waiting after ~8.5 min and never learned the result.

This page records what the installed CLIs support, without a model call. Versions checked
2026-10-28: `claude --version` → `2.1.310 (Claude Code)`, `codex --version` → `codex-cli 0.159.2`.

Evidence sources (no session was started; `~/.claude` and `~/.codex` were not changed):

- **Docs (fetched 2026-10-28):** Claude Code `code.claude.com/docs/en/{statusline,hooks,plugins-reference,
  plugins/components,mcp,tools-reference,channels-reference,changelog}.md`; Codex
  `developers.openai.com/codex/{hooks,config-advanced,config-reference,plugins/build,cli/reference,mcp,notifications}`;
  MCP `modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks` and
  `modelcontextprotocol.io/extensions/tasks/overview`. The docs describe the latest release
  (Claude Code 2.1.312 at the time); version notes in the changelog and strings in the installed
  binaries tie each feature to the installed version.
- **Installed files:** Claude Code `~/.local/share/claude/versions/2.1.310` (single binary, searched
  with `grep -a`); Codex `<npm global>/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
  (searched with `strings`); `codex --help`, `codex queue --help`, `codex features list`.
- **Offline plugin check:** `claude plugin validate plugins/agent-workflow --strict` and, with a
  throw-away `CLAUDE_CONFIG_DIR` and project, `claude plugin marketplace add` / `plugin install
  --scope project` / `plugin details` of the dev plugin.

## Claude Code 2.1.310

| Mechanism | Supported here | Evidence | Who configures it |
|---|---|---|---|
| **`statusLine`** (settings) | Yes. Runs a command; stdin gets session JSON (`cwd`, `workspace.current_dir`, `workspace.project_dir`, …); prints the first line(s). Updates on conversation events (debounced 300 ms); `refreshInterval` (≥ 1 s, added ~2.1.97) also re-runs it on a timer, needed while the session is idle. Blank until the workspace is trusted. | `statusline.md` ("How status lines work", "Available data", "Workspace trust required"); binary strings `refreshInterval`, `Status line command skipped` | **The user** (`~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`). A plugin cannot: its `settings.json`/`settings` key applies only `agent` and `subagentStatusLine`, every other key is dropped (`plugins-reference.md` "settings", `plugins/components.md` "Default settings"). |
| **Hooks: `UserPromptSubmit`** | Yes. Plain stdout (exit 0) is added to the model's context for that prompt (also `SessionStart`). Fires in `-p` mode too. | `hooks.md` "Exit code output" (stdout added as context for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`) | **Plugin** (`hooks/hooks.json` or inline `hooks` in `plugin.json`). Verified offline: `claude plugin validate --strict` passes and `claude plugin details` lists `Hooks (1) UserPromptSubmit` for the dev plugin. |
| Hooks: `Stop` / `Notification` | `Stop` can keep Claude working (exit 2 / `decision: block`) but only at the end of a turn; `Notification` output and exit codes are ignored (it can emit a terminal notification sequence). Neither starts a turn for an idle session. | `hooks.md` "Exit code 2 behavior per event", "Emit terminal notifications" | Plugin or user. Not useful for completion. |
| **Hooks: `async` / `asyncRewake`** | Yes. An `async` hook's `additionalContext` arrives on the next turn; an **`asyncRewake`** hook that exits 2 "wakes Claude immediately even when the session is idle" (its stderr becomes a system reminder). Its `timeout` (default 600 s) is enforced. | `hooks.md` "Run hooks in the background" / limitations; binary strings `asyncRewake`, "If true, hook runs in background and wakes the model on exit code 2"; changelog fix ~2.1.287 | Plugin or user. **Needs a live check** (a `PostToolUse` hook on `workflow_run` that waits for that run and exits 2). |
| **Plugin monitors** | Yes. `monitors/monitors.json` (or `experimental.monitors`): a background command per session (or `when: "on-skill-invoke:<skill>"`); each stdout line "reaches Claude as notifications, so Claude can react … without being asked". Not in `-p` mode. Added ~2.1.105; the Monitor tool says "Claude interjects when an event arrives". | `plugins/components.md` "Monitors", `plugins-reference.md` "monitors", `tools-reference.md` "Monitor tool"; binary strings `monitors/monitors.json`, `on-skill-invoke:` | **Plugin.** **Needs a live check** (does an idle interactive session start a turn on a monitor line?). `agent-workflow notify-check --follow` is the command such a monitor would run. |
| MCP `notifications/message` (logging) | The SDK schema is in the binary; the docs describe no display to the model. Not a delivery path. | binary (`notifications/message` only in MCP SDK schemas); `mcp.md` has no logging section | — |
| MCP resource subscriptions (`resources/subscribe`, `notifications/resources/updated`) | Not documented for Claude Code; `list_changed` only refreshes tool/prompt/resource lists. Not a delivery path. | `mcp.md` "Dynamic tool updates" | — |
| MCP progress (`notifications/progress`) | Shown in the `/tasks` entry of a backgrounded call and resets the tool idle timeout (30 min for stdio). Does not start a turn. Our `workflow_wait` already sends it when the call has a `progressToken`. | `mcp.md` "Time limits on MCP tool calls", "Automatic backgrounding" | Server (implemented since WP13). |
| **Automatic backgrounding of long MCP calls** | Yes: a main-conversation tool call still running after 2 min moves to a background task; "the result arrives as a task notification when the call settles". Our `workflow_wait` caps at 45 s, so it never gets there. | `mcp.md` "Automatic backgrounding of long tool calls" | Server-side (a longer wait bound for `--host claude-code`). **Needs a live check** (does the notification start a turn for an idle session?). |
| **MCP tasks** (`tasks/*`, MCP tasks extension) | Public beta from 2.1.304 (installed: 2.1.310), only on protocol revision `2026-07-28` (stdio negotiates it by default since ~2.1.292), interactive CLI sessions, main conversation. "If Claude is idle when the result arrives, Claude starts on it unprompted." In the 2025-11-25 spec, tasks are an experimental utility. | `mcp.md` "MCP tasks that run on the server", "What a call needs to become an MCP task"; changelog (2.1.292, 2.1.302); binary strings `tasks/get`, `MCP task` | Server. **Not available to us yet**: the host MCP server speaks up to `2025-11-25` and declares only `tools` (`src/mcp/stdio-server.ts`). Implementing the extension is its own work package plus a live check. |
| Channels (`notifications/claude/channel`) | Research preview; custom channels only with `--dangerously-load-development-channels`; not registered on `2026-07-28` connections. | `channels-reference.md`; binary strings `claude/channel` | Not for v1. |

## Codex 0.159.2

| Mechanism | Supported here | Evidence | Who configures it |
|---|---|---|---|
| **`watch`** | **No Codex subcommand or TUI feature named `watch`** (`codex --help` lists `agents`, `exec`, `queue`, `resume`, …; the CLI reference has none). E1's "watch" is ours: `agent-workflow watch` in a pane next to Codex. | `codex --help`; `cli/reference` | — (implemented here) |
| Status line | `tui.status_line` is an ordered list of **built-in item identifiers** (or `null`); no command. Codex cannot show our run status. | `config-reference` (`tui.status_line array<string> \| null`); binary strings `status_line`, `status_line_use_colors` | — |
| **`codex queue`** | Yes: `codex queue --thread <UUID or name> --message <text>` queues a text message for an existing session through the shared local app-server daemon (`thread/queue/add`; "resume the thread before starting a queued message"). Whether a queued message starts a turn in an idle TUI session, and how a run would learn the thread id, is unverified. Each delivery would be a model turn (cost). | `codex queue --help`; `cli/reference` "codex queue"; binary strings `thread/queue/add` | Our code would call it. **Needs a live check** and an owner decision on cost. |
| `notify` (config.toml) | Runs an external program with a JSON argument on **`agent-turn-complete` only**. User-level config only (ignored in project `.codex/config.toml`); not a plugin field. It cannot report a workflow finishing while Codex is idle. | `config-advanced` "Notifications"; `config-reference` ("put provider, notification, and telemetry keys in user-level config") | User. Not a completion path; desktop alerts for runs come from `agent-workflow watch --bell` instead. |
| `tui.notifications` / `tui.notification_method` | Built-in TUI notifications (osc9/bel) for Codex's own events (turn complete, approval requested). | `config-reference` | User. Not for our runs. |
| **Hooks: `UserPromptSubmit`** | Yes (`hooks` feature stable, on): plain stdout is added as extra developer context. Hooks must be **reviewed and trusted** (`/hooks`) before they run; project hooks load only in trusted projects. `async` exists for command hooks (`HookHandlerConfig::Command` fields include `async`); no rewake equivalent is documented. | `codex/hooks` "UserPromptSubmit", "Review and trust hooks"; `codex features list` (`hooks stable true`); binary strings | User (`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `[hooks]` in config.toml). |
| Plugin hooks | Supported (`hooks/hooks.json` or `hooks` in `.codex-plugin/plugin.json`; binary strings `plugin.json#hooks`, "failed to trust materialized plugin hooks"), but skipped until the user trusts them in `/hooks`, and **"Plugins containing lifecycle hooks aren't eligible for the public plugin directory."** | `codex/hooks` "Plugin-bundled hooks"; `plugins/build` "Bundled MCP servers and lifecycle hooks" | Plugin, with the user's trust. **Not shipped** by our plugin (directory eligibility); documented as user configuration. |
| MCP notifications / progress / tasks | rmcp schemas are in the binary (`notifications/message`, `notifications/progress`, `tasks/get`); the docs describe no display of server notifications. `mcp_2026_07_28` is a feature flag "under development", off, so no MCP tasks. Elicitation for tool calls is on (`tool_call_mcp_elicitation stable true`). | `codex features list`; `codex/mcp`; binary strings | — |

## What WP36 implemented (no live verification needed)

- `agent-workflow statusline` ([cli.md](cli.md#statusline-watch-notify-check)): the Claude Code
  `statusLine` command (user settings; manual config in [plugins.md](plugins.md#status-line-and-watch)).
- `agent-workflow watch [run]`: the terminal live view for Codex and Claude Code (`--bell` rings the
  terminal bell when the run ends: the "notification" of E1 that works for every host).
- `agent-workflow notify-check`: the common completion mechanism (E2): runs that finished since the
  last check, each settled state once (receipts in `.agent-workflow/notify-check/`; `wait` marks the
  states it returned). Wired into the **Claude Code plugin** as a `UserPromptSubmit` hook (plugins
  can ship hooks; verified offline). **Codex:** manual hook config ([plugins.md](plugins.md#completion-check-hook)).
  `--follow` prints new lines as they appear, ready for a plugin monitor once verified.
- Server instructions, the `workflow_wait` still-running footer and the `agent-workflow` skill name
  `agent-workflow watch <runId>`, the status line and the notify-check line.

## Recommendation

| Mechanism | Host | Status |
|---|---|---|
| Query tools (`workflow_status`/`workflow_wait`/…) | both | feasible now (shipped, WP13/WP28) |
| `agent-workflow statusline` as `statusLine.command` | Claude Code | feasible now; user config (plugins cannot set `statusLine`) |
| `agent-workflow watch [run]` (+ `--bell`) | both (E1 "watch" for Codex) | feasible now |
| `notify-check` via `UserPromptSubmit` hook (pull at the next user message) | Claude Code | feasible now; shipped in the plugin; needs a live check (L1) to confirm the model sees the line |
| `notify-check` via `UserPromptSubmit` hook | Codex | feasible now as user config (trust review); plugin hook not shipped (directory eligibility); live check L5 |
| Plugin monitor running `notify-check --follow` (push into an idle session) | Claude Code | needs a live check (L3) |
| `asyncRewake` `PostToolUse` hook on `workflow_run` (push) | Claude Code | needs a live check; alternative to L3 |
| Long `workflow_wait` that Claude Code backgrounds after 2 min (push) | Claude Code | needs a server change (longer bound for `--host claude-code`) and a live check (L4) |
| MCP tasks extension (`2026-07-28`) | Claude Code | not available: our server is on `2025-11-25`; own work package, then a live check |
| `codex queue --thread … --message …` (push, one model turn per delivery) | Codex | needs a live check (L6) and an owner decision on cost |
| Codex `notify`, `tui.status_line`, MCP logging/resource notifications, Claude Code channels | — | not available for this purpose on the installed versions |

## Live checks for bundle 5 (one host turn each, temporary projects and config)

Prepare: `npm run build`; `node tools/release/plugins.mjs dev <tmp>/market`; a temporary project
`<tmp>/proj` (git init); a synthetic run, for example a finished run record written by
`test/unit/host-wp36-progress.test.mjs`'s `writeRun` shape (or a real detached run of the fixture
executor). Never write to the real `~/.claude`/`~/.codex`: use `CLAUDE_CONFIG_DIR` with a copied
login, or back up and restore as in [plugins.md](plugins.md).

- **L1 Claude Code prompt hook.** In `<tmp>/proj` with one finished run:
  `claude --plugin-dir <tmp>/market/plugins/agent-workflow -p --model haiku "If your context contains lines starting with 'agent-workflow:', repeat them verbatim; otherwise reply NONE."`
  Pass: the reply contains `agent-workflow: workflow "…" (run workflow_…) finished — …`; a second
  `agent-workflow notify-check` in the project prints nothing.
- **L2 Claude Code status line (no model turn).** Interactive `claude` in tmux in `<tmp>/proj`
  (trusted) with `--settings '{"statusLine":{"type":"command","command":"<node> <checkout>/src/hosts/cli/cli.mjs statusline","refreshInterval":2}}'`
  and a running synthetic run; `tmux capture-pane` shows `aw: … running …`; after the run record
  turns `completed` the line disappears within ~2 s. Send no prompt.
- **L3 Claude Code plugin monitor (push).** Dev plugin plus `monitors/monitors.json`
  `[{"name":"agent-workflow","command":"<node> <checkout>/src/hosts/cli/cli.mjs notify-check --follow --host claude-code","description":"agent-workflow run completions"}]`;
  interactive `claude` in tmux, idle after start; then mark the synthetic run finished. Pass: Claude
  starts a turn on its own and relays the line (one turn). Record whether the line was only shown
  or also acted on.
- **L4 Claude Code backgrounded wait (push).** Needs a test build whose `workflow_wait` accepts a
  bound above 2 min for `--host claude-code`: ask once to "run <fixture workflow> and wait"; the call
  moves to `/tasks` after 2 min; finish the run; pass when the task notification starts a turn.
- **L5 Codex prompt hook.** `<tmp>/proj/.codex/hooks.json` with the `UserPromptSubmit` hook of
  [plugins.md](plugins.md#completion-check-hook), project trusted inline (`-c projects={…}`), one
  finished run: `codex exec --dangerously-bypass-hook-trust -C <tmp>/proj "Repeat any lines starting with 'agent-workflow:' verbatim, else NONE."`
  Pass: the line is repeated.
- **L6 Codex queue (push).** Interactive `codex` in tmux in `<tmp>/proj`, idle; note the session id
  (`codex agents` or the hook input's `session_id`); `codex queue --thread <id> --message "agent-workflow: workflow test finished — reply OK"`.
  Pass: the idle TUI starts a turn without a keypress (one turn). Record whether it needs the
  shared daemon (`daemon_auto_start`).
