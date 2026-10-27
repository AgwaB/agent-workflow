// New in agent-workflow (WP11a): command help shared by the `agent-workflow` CLI and the host API
// `help` action (stage-2 hosts reuse the same text). WP17: `doctor` and the default-executor line.
import { HostUsageError } from "./args.js";
import { type HostResult, result } from "./types.js";

const LAUNCH_FLAGS = `  --executor <id>              executor for this run (pi, codex, claude; run flag beats profiles;
                               default: first installed and logged-in of pi, claude, codex)
  --profile <name>             workflow-declared execution profile, else a saved user profile
  --permission-mode free|safe  approvals/sandbox mode (default free; see docs/permissions.md)
  --allow-unverified <a,b>     accept these unverified executor capabilities (B4 opt-in)
  --model <id>                 model override for every stage
  --effort <level>             effort override: off, minimal, low, medium, high, xhigh, max
  --input <key=value>          set a workflow input the spec declares (repeatable; typed like
                               the declared default, e.g. --input depth=quick)
  --detach                     start a background supervisor and return immediately
  --force-new                  skip the duplicate-launch guard
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
       agent-workflow profile set <name> [--executor <id>] [--model <id>] [--effort <level>]
                                  [--permission-mode free|safe] [--strict-capabilities <a,b>]
                                  [--unset <field,...>] [--default] [--json]
       agent-workflow profile delete <name> [--json]
       agent-workflow profile default <name> | --clear [--json]

Saved user profiles live in $AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json
(default ~/.agent-workflow). A launch uses: --profile <name>, else the workflow's declared default
profile, else the default saved profile. Precedence for the executor and permission mode:
run flag > workflow-declared profile > saved user profile > default.`,
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
	status: `Usage: agent-workflow status [<run-id-or-prefix>] [--json]

Show every top-level run, or one run.`,
	show: `Usage: agent-workflow show <run-id-or-prefix> [--raw] [--json]
       agent-workflow show <workflow-name-or-path>

Show run details (--raw: full record view) or a workflow spec. Arguments that start with
"workflow_" are run ids.`,
	inspect: `Usage: agent-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]

Reliability summary and task listing. --failures lists only failed/blocked/interrupted tasks;
--results prints task results (with --failures on a clean run: every result).`,
	wait: `Usage: agent-workflow wait <run-id-or-prefix> [--timeout <duration>] [--json]

Drive and wait for a run until it is terminal or needs action. Without --timeout it waits until
then; each underlying wait call is bounded to 45 s. Exit 0 when the run completed, 1 when it
failed, was interrupted, is blocked, or is still running at --timeout.`,
	resume: `Usage: agent-workflow resume <run-id-or-prefix> [--detach] [--timeout <duration>] [--json]

Reset failed, interrupted and resumable blocked tasks and continue the run (in the foreground,
or with --detach in a background supervisor).`,
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
  status [run]               show runs
  show <run>                 show run details
  inspect <run>              reliability summary and task results
  wait <run>                 wait until a run is terminal or needs action
  resume <run>               resume a failed, interrupted or blocked run
  stop <run>                 stop a run
  prune                      delete old terminal runs (dry run without --yes)
  notices ...                acknowledge unfinished-run notices
  supervise <run>|--all      drive runs from a standalone process

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
