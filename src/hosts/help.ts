// New in agent-workflow (WP11a): command help shared by the `agent-workflow` CLI and the host API
// `help` action (stage-2 hosts reuse the same text). WP17: `doctor` and the default-executor line.
// WP31: profile roles, presets and per-workflow preferences.
// WP36: statusline, watch, notify-check. WP32: auto.
import { HostUsageError } from "./args.js";
import { type HostResult, result } from "./types.js";

const LAUNCH_FLAGS = `  --executor <id>              executor for this run (pi, codex, claude; run flag beats profiles;
                               default: first installed and logged-in of pi, claude, codex)
  --profile <name>             workflow-declared execution profile, else a saved user profile,
                               else a built-in preset (codex, claude, pi, mixed)
  --permission-mode free|safe  approvals/sandbox mode (default free; see docs/permissions.md)
  --allow-unverified <a,b>     accept these unverified executor capabilities (B4 opt-in)
  --model <id>                 model override for every stage
  --effort <level>             effort override: off, minimal, low, medium, high, xhigh, max
  --input <key=value>          set a workflow input the spec declares (repeatable; typed like
                               the declared default, e.g. --input depth=quick)
  --detach                     start a background supervisor and return immediately
  --open                       open the dashboard for this run (even in an agent environment)
  --force-new                  start a new run even if an identical launch is still active
                               (otherwise the active run is returned)
  --yes                        do not ask: record capability degradations and proceed
  --timeout <duration>         stop waiting after this long (30000, 30s, 5m, 1h); the run continues
  --json                       print one JSON result object`;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
	list: `Usage: agent-workflow list [--query <text>] [--offset N] [--limit N] [--json]

List discoverable workflows (project .agent-workflow/workflows, ~/.agent-workflow/workflows,
bundled; legacy Pi locations read-only). --limit (1-20) pages the output.`,
	validate: `Usage: agent-workflow validate <workflow-name-or-path> [--json]

Load and compile a workflow spec without running it. Exit 1 when the spec is invalid.`,
	roles: `Usage: agent-workflow roles <workflow-name-or-path> [--json]

Show the compiled role context exactly as it is injected into task prompts.`,
	agents: `Usage: agent-workflow agents [--json]

List discoverable agent definitions.`,
	profile: `Usage: agent-workflow profile list [--json]
       agent-workflow profile show [<name>] [--json]
       agent-workflow profile set <name> [--preset codex|claude|pi|mixed] [--executor <id>]
                                  [--model <id>] [--effort <level>]
                                  [--role <role>=<executor>[:<model>[:<effort>]]]...
                                  [--permission-mode free|safe] [--strict-capabilities <a,b>]
                                  [--unset <field,...|roles.<role>>] [--default] [--json]
       agent-workflow profile delete <name> [--json]
       agent-workflow profile default <name> | --clear [--json]
       agent-workflow profile presets [--json]
       agent-workflow profile workflow list [--json]
       agent-workflow profile workflow show|clear <workflow> [--json]
       agent-workflow profile workflow set <workflow> [--profile <name>]
                                  [--role <role>=<executor>[:<model>[:<effort>]]]...
                                  [--unset profile,roles,roles.<role>] [--json]

Roles: default, planning, research-execution, synthesis, verification, final-judgment, or
agent:<name>. Saved user profiles live in $AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json,
per-workflow preferences in $AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json
(default ~/.agent-workflow). A launch uses: --profile <name>, else the workflow's saved preference
profile, else the workflow's declared default profile, else the default saved profile. Precedence
per field (executor, model, effort, also per role): run flag > per-workflow preference roles >
workflow-declared profile > saved user profile > default.`,
	run: `Usage: agent-workflow run <workflow-name-or-path> <task...> [options]

Start exactly the named workflow and wait in the foreground until it is terminal (Ctrl-C stops
waiting, not the run; continue with \`agent-workflow wait <run-id>\`). With --detach, a background
supervisor drives the run and the command returns the run id.

In a terminal the capability preview is shown and, when an executor capability is degraded and
the run needs confirmation, you are asked y/N. With --yes or without a terminal the degradations
are recorded and the run proceeds.

Options:
${LAUNCH_FLAGS}`,
	dynamic: `Usage: agent-workflow dynamic <task...> [options]

Start a spec-less direct dynamic workflow run. Same options and behavior as \`run\`.

Options:
${LAUNCH_FLAGS}`,
	auto: `Usage: agent-workflow auto <task...> [--yes] [options]

Recommend a workflow for a task and start the one you choose. First a local shortlist is made
without any model call (the dynamic workflow and the discoverable workflows, ranked by their
routing hints). Comparing them needs one classifier request: it sends your task and the bounded
descriptions of the candidates to the run's default executor (--executor, else the saved user
profile, else the first installed and logged-in of pi, claude, codex) with --model/--effort or the
executor's default model, without tools. Nothing is sent without your consent:
  - in a terminal you are shown the task, the candidates and the executor/model and asked y/N;
    then you pick the workflow from the ranked list (Enter takes the recommendation, n cancels),
    and it starts like \`run\` (foreground; --detach for background);
  - without a terminal no request is sent: the local shortlist and the commands to start a
    workflow directly are printed (exit 1);
  - --yes is your explicit consent to the one request (no question). Without a terminal the
    ranked recommendation and the commands are printed and nothing starts.
Declining or cancelling starts nothing. The started run records the selection (candidates,
recommendation, your choice, classifier executor/model, consent) in its launch metadata.

Options:
${LAUNCH_FLAGS}`,
	status: `Usage: agent-workflow status [<run-id-or-prefix>] [--json]

Show every top-level run, or one run.`,
	show: `Usage: agent-workflow show <run-id-or-prefix> [--raw] [--json]
       agent-workflow show <workflow-name-or-path>

Show run details (--raw: full record view) or a workflow spec. Arguments that start with
"workflow_" are run ids.`,
	inspect: `Usage: agent-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]

Reliability summary and task listing. --failures lists only failed/blocked/interrupted tasks;
--results prints task results (with --failures on a clean run: every result).`,
	logs: `Usage: agent-workflow logs <run-id-or-prefix> [--task <task-id>] [--lines N]
                          [--stream output|stderr|events|all] [--json]

Bounded tail of task output, stderr and executor events (the latest attempt's exec-events.jsonl).
Without --task: every started task (at most 6, most recent). --lines: lines per stream (1-400,
default 20). Lines are cut at 400 characters and the text at 48 000; credentials, bearer tokens,
URL secrets, home paths and values of sensitive environment variables are redacted.`,
	wait: `Usage: agent-workflow wait <run-id-or-prefix> [--timeout <duration>] [--json]

Drive and wait for a run until it is terminal or needs action. Without --timeout it waits until
then; each underlying wait call is bounded to 45 s. Exit 0 when the run completed, 1 when it
failed, was interrupted, is blocked, or is still running at --timeout.`,
	resume: `Usage: agent-workflow resume <run-id-or-prefix> [--detach] [--timeout <duration>] [--json]

Reset failed, interrupted and resumable blocked tasks and continue the run (in the foreground,
or with --detach in a background supervisor).`,
	approve: `Usage: agent-workflow approve <run-id-or-prefix> [--request <id>] [--reject] [--yes]
                                [--detach] [--timeout <duration>] [--json]

Answer a dynamic-controller approval (a workflow whose dynamic stage declares
permissions.approval "ask") that a run is blocked on. \`status <run>\` shows the question and its
request id; --request picks one when several are open (a unique prefix of 8+ characters is enough).
In a terminal the question is asked y/n: y approves, n rejects the controller for this run (it is
never asked again), no answer records nothing. Without a terminal --yes is required and the
decision is final. An approval resumes the run (in the foreground, or with --detach in a background
supervisor); completed tasks are not relaunched. The decision is recorded on the run with the host
that made it. Foreground run, wait and resume ask the same question in a terminal while they drive
the run.`,
	stop: `Usage: agent-workflow stop <run-id-or-prefix> [--json]

Stop a non-terminal run; running tasks are interrupted. Resume later with \`resume\`.`,
	prune: `Usage: agent-workflow prune [--keep N] [--older-than DAYS] [--yes] [--json]

Delete terminal runs beyond the retention filters. Without --yes this is a dry run.`,
	notices: `Usage: agent-workflow notices list [--json]
       agent-workflow notices acknowledge <exact-run-id> --state <sha256> --reason <text>
       agent-workflow notices clear <exact-run-id> [--json]

Notification-only acknowledgements of unfinished runs; run history and resume are unchanged.`,
	supervise: `Usage: agent-workflow supervise <run-id-or-prefix> [--poll-ms N] [--max-runtime-ms N]
       agent-workflow supervise --all [--poll-ms N] [--max-runtime-ms N]

Drive scheduling from this process until the run(s) are terminal. The run lease arbitrates with
any other supervisor. --all includes only runs observed running; failure takes precedence over
blocked; an empty batch succeeds. --max-runtime-ms 0 disables the deadline; by default a single
run with an unlimited loop has none and other runs stop after 4 hours.`,
	doctor: `Usage: agent-workflow doctor [--json]

Check this machine without calling a model: for pi, claude and codex whether the CLI is installed,
its version against the verified one, its login state (and the install/login command when it is
not usable); which executor a run here uses by default and why; the permission-mode default; the
Node version; AGENT_WORKFLOW_HOME and whether it is writable; Codex environment warnings (allow
rules, global AGENTS.md; counts only); stale run-index entries. Exit 0 when at least one executor is
usable, 1 otherwise.`,
	dashboard: `Usage: agent-workflow dashboard [--port <n>] [--readonly] [--open] [--detached | --status | --stop] [--project <dir>]

Serve the local web dashboard on 127.0.0.1 only. Prints a private session URL; Ctrl-C stops
the server, not the runs. --readonly rejects mutations. --open opens a one-time sign-in URL.
--detached prints only the listening address, not a session URL. --status shows pid/port/since;
--stop sends SIGTERM and waits up to 5 seconds for discovery cleanup.
Port defaults to an available ephemeral port. One server serves one project (default cwd).`,
	watch: `Usage: agent-workflow watch [<run-id-or-prefix>] [--follow] [--once] [--interval <seconds>]
                              [--bell]

Live view of this project's active runs, or of one run, in a terminal (for example a pane next to
Codex or Claude Code): tasks, status, elapsed time, pending approvals and, when the run is done, the
verdict and report paths. Redraws every 2 s (--interval 1-10). Read-only: it never drives a run; a
run without a live supervisor is flagged with the \`supervise\` command. Exits when the run (or every
watched run) finished or needs action; --follow keeps watching, --once prints one frame, --bell
rings the terminal bell at the end. Exit code with a run: 0 when it completed, 1 otherwise.`,
	statusline: `Usage: agent-workflow statusline

One line about this project's active runs, for a status bar such as Claude Code's
\`statusLine.command\`: "aw: deep-review 5/13 running 12m · +1 more"; nothing when idle. Reads the
JSON Claude Code passes on stdin (workspace.project_dir, workspace.current_dir, cwd) to find the
project, else the working directory. Read-only, no model call, never fails loudly (always exit 0).
Blocked runs show for a day as "needs action" or "awaiting approval".`,
	"notify-check": `Usage: agent-workflow notify-check [--host cli|claude-code|codex|generic] [--json] [--stamp <name>]
       agent-workflow notify-check --follow [--interval <seconds>] [--host …]

Print one line per run of this project that finished (or now needs the user) since the last check,
for example "workflow \"deep-review\" (run …) finished — verdict NEEDS_WORK, report …"; nothing
otherwise. Each settled state is printed once (receipts in .agent-workflow/notify-check/; the first
check also reports runs that settled in the hour before; a state that \`wait\` already returned
is not repeated). --host picks the follow-up hints (MCP tool calls for claude-code/codex/generic).
Meant for host hooks that add their output to the conversation (Claude Code plugin: a
UserPromptSubmit hook); no model call. Exit 0. --follow keeps checking every 5 s (--interval 1-60)
and prints each new line as it appears, for a long-lived feed such as a Claude Code plugin monitor.
--stamp <name> (for a prompt hook's idle test) writes .agent-workflow/notify-check/<name>.stamp
after a successful check, timed to the check's start.`,
	help: `Usage: agent-workflow help [<command>]`,
};

export const GENERAL_HELP = `agent-workflow — run multi-stage agent workflows on Pi, Codex or Claude Code

Usage: agent-workflow <command> [arguments] [options]

Workflows:
  list                 list discoverable workflows
  validate <workflow>  validate a workflow spec
  roles <workflow>     show compiled role context
  agents               list agent definitions
  show <workflow>      print a workflow spec
  profile ...          manage saved user profiles

Runs:
  run <workflow> <task...>   start a workflow (foreground; --detach for background)
  dynamic <task...>          start a spec-less dynamic workflow
  auto <task...>             recommend a workflow (asks before one classifier call), start it
  status [run]               show runs
  show <run>                 show run details
  inspect <run>              reliability summary and task results
  logs <run>                 bounded, redacted tail of task output, stderr and events
  wait <run>                 wait until a run is terminal or needs action
  resume <run>               resume a failed, interrupted or blocked run
  approve <run>              approve or reject a dynamic controller a run waits on
  stop <run>                 stop a run
  prune                      delete old terminal runs (dry run without --yes)
  notices ...                acknowledge unfinished-run notices
  supervise <run>|--all      drive runs from a standalone process
  dashboard                   local web dashboard (private loopback URL; --readonly available)
  watch [run]                live terminal view of active runs (read-only)
  statusline                 one-line run status for a status bar (Claude Code statusLine)
  notify-check               report runs that finished since the last check (host hooks)

Setup:
  doctor                     check executors, logins and the default executor (no model calls)

Common options: --json (one JSON result object), -h/--help (command help), --version.
Exit codes: 0 success or completed run, 1 failed/blocked/refused/timed out, 2 usage error.
Run \`agent-workflow help <command>\` for details.`;

/** `help [command]`. */
export function helpAction(command?: string): HostResult<{ command?: string }> {
	if (command === undefined) return result("help", "success", {}, GENERAL_HELP);
	const text = COMMAND_HELP[command];
	if (text === undefined)
		throw new HostUsageError(
			`Unknown command "${command}". Run agent-workflow help.`,
		);
	return result("help", "success", { command }, text);
}
