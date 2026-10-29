# `agent-workflow` CLI

The host-neutral command line of agent-workflow (WP11a). It needs no Pi packages. Every command is
a thin argv layer over one host API handler (`docs/host-api.md`), so the CLI, the stage-2 host MCP
server and the Pi host behave the same.

```sh
npm install @agwab/agent-workflow      # provides the agent-workflow bin
npx agent-workflow --help
```

## Commands

| Command | What it does |
|---|---|
| `list [--query T] [--offset N] [--limit N]` | Discoverable workflows: project `.agent-workflow/workflows/`, `~/.agent-workflow/workflows/`, bundled; legacy Pi locations read-only. `--limit` (1-20) pages the output and bounds it to 50 KB. |
| `validate <workflow>` | Load and compile a spec without running it. |
| `roles <workflow>` | Compiled role context as injected into task prompts. |
| `agents` | Agent definitions. |
| `show <workflow>` | The resolved spec file. |
| `show <run> [--raw]` | Run details. Arguments that start with `workflow_` (or `--raw`) are runs. |
| `profile list \| show [name] \| set <name> … \| delete <name> \| default <name> \| default --clear \| presets` | Saved user profiles, roles and built-in presets (below). |
| `profile workflow list \| show <workflow> \| set <workflow> … \| clear <workflow>` | Saved per-workflow preferences (WP31, below). |
| `run <workflow> <task…>` | Start exactly the named workflow and wait in the foreground until it is terminal. |
| `dynamic <task…>` | Start a spec-less direct dynamic run; same options as `run`. |
| `auto <task…> [--yes]` | WP32: recommend a workflow for the task (one classifier request, only with your consent) and start the one you choose; same options as `run`. Below. |
| `status [run]` | All top-level runs, or one run. |
| `inspect <run> [--failures] [--results]` | Reliability summary and task listing. `--failures` lists failed/blocked/interrupted tasks; `--results` prints task results (with `--failures` on a clean run: every result). |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | Bounded tail of task output, stderr and executor events (the latest attempt's `exec-events.jsonl`); every started task by default (at most 6). Lines per stream 1-400 (default 20), lines cut at 400 characters, the text at 48 000. Credentials (WP19: also quoted structured fields such as `"Authorization":"Basic …"` and `"refresh_token":"…"`), bearer tokens, URL secrets, macOS/Linux/Windows home paths and values of sensitive environment variables are redacted, here and in `status`/`show`/`inspect`/`wait` text. WP19: only files inside the project's `.agent-workflow/` are read; a tampered absolute, `..` or symlink-escaping path is refused and the reason shown. |
| `wait <run> [--timeout D]` | Drive and wait until the run is terminal or needs action. |
| `resume <run> [--detach] [--timeout D]` | Reset failed, interrupted and resumable blocked tasks, then continue in the foreground or detached. |
| `approve <run> [--request <id>] [--reject] [--yes] [--detach] [--timeout D]` | WP29: answer a dynamic-controller approval the run is blocked on (below). |
| `stop <run>` | Stop a non-terminal run (durable stop intent; workers are cancelled). Waits up to 15 s for confirmation (below). |
| `prune [--keep N] [--older-than DAYS] [--yes]` | Delete terminal runs beyond the filters, and (WP18b) terminal executor attempt records older than 7 days (or `--older-than`) under `~/.agent-workflow/executors/` (WP19: a launched attempt's record becomes a compact tombstone that is never pruned, so reconcile never reports it absent; containment is physical: a symlinked `attempts/`, Pi `runs/` or other ancestor is refused and reported, never followed; WP19 round 7/8: orphans are removed only when the name is adapter-written — the adapter's own attemptKey digest of exactly its length (Claude 40, Codex 32, Pi 64 hex) alone or with `.events.jsonl`/`.log`/an atomic-write temp suffix — so other files there are never touched), and stale host launch claims (`.agent-workflow/host-launches/`, older than 1 h); WP39b: a pruned run's managed worktrees (merged branches deleted, unmerged kept) and the `auto` classifier's requests (`.agent-workflow/workflows/auto-router-runs/`, same filters); a dry run without `--yes`. |
| `notices list [--json] \| acknowledge <run> --state <sha256> --reason <text> \| clear <run> [--json]` | Notification-only acknowledgements of unfinished runs. |
| `supervise <run> \| --all [--poll-ms N] [--max-runtime-ms N]` | Drive scheduling from this process until the run(s) are terminal. |
| `watch [run] [--follow] [--once] [--interval S] [--bell]` | WP36: live terminal view of the project's active runs or one run (tasks, status, elapsed, pending approvals, verdict and report at the end). Read-only. Below. |
| `statusline` | WP36: one line about the active runs for a status bar (Claude Code `statusLine`); empty when idle; always exit 0. Below. |
| `notify-check [--host H] [--json] [--stamp N] [--follow [--interval S]]` | WP36: one line per run that finished (or needs the user) since the last check, each state once; for host hooks. Below. |
| `doctor [--json]` | Check this machine without a model call: executors (installed, version vs verified, login), the default executor here and why, permission-mode default, Node, `AGENT_WORKFLOW_HOME`, Codex environment warnings, stale run-index entries. Exit 0 when at least one executor is usable. Below. |
| `help [command]`, `<command> --help`, `--version` | Help and version. |

A run argument accepts the run id or an unambiguous prefix.

WP28: every command except `help`/`--version` (and the WP36 terminal views `watch`, `statusline`,
`notify-check`, whose data the `workflow_status`/`workflow_wait` tools already return) is also a host MCP tool (`workflow_<command>`,
[host-mcp.md](host-mcp.md#tools)); the MCP forms of `prune --yes`, `profile set|delete|default`, `profile workflow set|clear` and
`notices acknowledge|clear` ask the user to confirm through MCP elicitation (WP29: as does
`workflow_approve`, the MCP form of `approve`), and a client that
cannot ask is refused with the CLI command line to run here instead. `supervise` on MCP starts the
detached supervisor and returns at once.

## Launch options (`run`, `dynamic`, `auto`)

| Option | Meaning |
|---|---|
| `--executor <id>` | Executor for this run: `pi`, `codex`, `claude` (or a registered id). Highest precedence. |
| `--profile <name>` | A profile the workflow declares (`executionProfiles`), else a saved user profile with that name, else a built-in preset (`codex`, `claude`, `pi`, `mixed`). Without it: the workflow's saved preference profile, if any. |
| `--permission-mode free\|safe` | Approvals and sandbox (`docs/permissions.md`). Default `free`. |
| `--allow-unverified <a,b>` | Accept these `unverified` executor capabilities (B4 opt-in), e.g. `contextIsolation`. |
| `--model <id>` | Model override for every stage. |
| `--effort <level>` | Effort override: `off minimal low medium high xhigh max` (`--thinking`/`--reasoning` are aliases). |
| `--input <key=value>` | Set a workflow input the spec declares (repeatable; `--input=key=value` also works). Typed like the declared default: string as is, number, `true`/`false`, JSON for arrays, objects and `null`. An undeclared key, a wrong type, a repeated key or a missing `=` is a usage error (exit 2, nothing starts). Example: `--input depth=quick`. |
| `--detach` | Start a background supervisor (`agent-workflow supervise <id>`, log in `<run dir>/supervise.log`) and return the run id at once. |
| `--force-new` | Start a new run although an identical launch (same workflow, task, inputs and options) is still active; without it, the guard prints that run (`outcome: "existing"`, exit 0) and, in the foreground, waits for it. Applies to `--detach` too. |
| `--yes` | Never ask: record capability degradations and proceed. For `auto` it is also your explicit consent to the one classifier request. |
| `--timeout <d>` | Stop waiting after `d` (`30000`, `30s`, `5m`, `1h`). The run continues. Not with `--detach`. |
| `--json` | Print one JSON object `{action, ok, outcome, data}` (for `run`/`resume` without `--detach`, `data.wait` holds the final wait result). |

The task is every remaining positional word. Put `--` before task text that starts with `--`:
`agent-workflow run deep-review -- --literal text`.

### Precedence

Executor and permission mode: **run flag > workflow-declared profile > saved user profile >
default** (mode `free`; executor: below). Without `--profile` a launch uses the workflow's saved
preference profile (WP31), else its `defaultExecutionProfile` if it declares one, else the default
saved user profile. The precedence holds field by field (B2, WP37): a workflow-declared profile
that does not set the executor, the permission mode or `strictCapabilities` takes them from the
default saved user profile. WP31 extends it to roles: per stage, each of executor, model and effort
comes from the highest layer that has a value for that stage — run flag > per-workflow preference
roles > workflow-declared profile > saved user profile > default ([usage.md](usage.md#roles-presets-and-mixed-runs)).

**Default executor (WP17).** When nothing above selects one, the CLI uses the **first installed and
logged-in** of `pi` → `claude` → `codex`. Each candidate is checked with its adapter's probe (version
and login status commands, no model call): it must be installed and its login not `missing` or
`expired`. WP19 (review #9): a candidate with a *verified* login (auth `ok`) wins over an earlier
one whose login is `unknown`, so the order is walked until the first verified one (Pi with unknown
auth + Claude logged in → Claude). Only when none is verified does the first usable `unknown`
candidate win; the launch text and `doctor` then say its login could not be verified and how to log
in or pick `--executor`. Pi's readiness signal needs no model call and no credential read by the
engine: `pi --list-models` lists only models whose provider has configured auth in Pi (non-empty →
`ok`, empty → `missing`). The run records `executor.source: "installed-default"`, `executor.host: "cli"` and the
probed candidates. Hosts with their own CLI default to it instead (`host-default`): the Pi host →
`pi`, Claude Code → `claude`, Codex → `codex`. An explicit choice is never second-guessed. When
nothing is usable the launch is refused before any run record:

```text
Not started: no executor is usable: agent-workflow needs one of pi, claude, codex installed and logged in (checked in this order). The run was not started.
  - pi: not installed; install: see docs/usage.md#executors, check with `pi --version`
  - claude: installed (2.1.310), not logged in (auth missing); log in: run `claude auth login`
  - codex: installed (0.159.2), not logged in (auth missing); log in: run `codex login`
Then start the run again, or choose one explicitly with --executor <id>. `agent-workflow doctor` shows the details.
```

A chosen executor that is not installed or not logged in is refused the same way
(`EXECUTOR_NOT_INSTALLED` names the install command, `EXECUTOR_AUTH_NOT_READY` the login command).
Probe results that are usable are reused within one process for 60 s.

### Capability preview and confirmation (B4)

Every launch prints the capability preview (`Capability check (<executor>@<version>, <n> stages,
permission mode: …): …`). A refusal starts nothing: the command prints `Not started: …` and exits 1.

- **In a terminal** (stdin and stdout are TTYs) without `--yes`: when a stage degrades in a way that
  needs confirmation (for example a capability warning under `--permission-mode safe`), the preview
  is printed to stderr and the CLI asks `Proceed with these capability degradations? [y/N]`.
  Anything but `y`/`yes` declines; nothing is launched and the command exits 1. An accepted run
  records `confirmation: "confirmed"`.
- **With `--yes`, or without a terminal** (pipes, CI): the run is non-interactive. Degradations are
  recorded (`confirmation: "non-interactive"`) and the run proceeds.

### Foreground, detach, wait

`run` without `--detach` waits in the foreground: it drives the run in bounded 45 s waits and prints
progress to stderr. Ctrl-C stops waiting, not the run; continue with `agent-workflow wait <id>` (or
`resume`/`supervise`). With `--detach` a background supervisor keeps the run going after the CLI
exits; any later process can `status`, `wait` or `stop` it.

`wait` without `--timeout` loops until the run is terminal or blocked. With `--timeout` it returns
when the time is up; a run still running then exits 1 with `data.stillRunning: true`.

### `auto` (WP32)

`agent-workflow auto "<task>"` is pi-workflow's `/workflow auto` for the terminal. It compares the
trusted dynamic workflow and the discoverable workflows (at most 24) and starts the one you choose:

1. **Local shortlist, no model call.** The candidates are ranked by the task's words against each
   spec's `routing` hints (`useWhen`, `outputs`) and name.
2. **Consent.** Comparing them sends one request to a classifier model: your task and the bounded
   descriptions of the candidates, without tools. It runs on the run's default executor (owner
   decision Q5): `--executor`, else the executor of the saved user profile (`--profile <name>` or
   the default one), else the first installed and logged-in of `pi`, `claude`, `codex`; with
   `--model`/`--effort` or the profile's model, else the executor's default model. On a terminal
   you see the task, the candidate names and the executor/model and are asked
   `Send this task to <executor> to compare workflows? [y/N]`; anything but `y` sends nothing.
   `--yes` is your explicit consent instead of the question. Without a terminal and without
   `--yes` nothing is sent: the local shortlist is printed with the `run`/`dynamic` command of each
   candidate and how to consent (exit 1).
3. **Choice.** The ranked candidates (recommended first, with the classifier's fit and reason)
   are printed and you pick one: `Start which workflow? [1-N, Enter = 1, n = cancel]` (Enter takes
   the recommendation; without one Enter cancels). Without a terminal (`--yes` only) the ranking
   and the commands are printed and nothing starts (exit 0).
4. **Launch.** The chosen workflow starts like `run`/`dynamic` (duplicate guard, profiles,
   capability preview, approvals; foreground, or `--detach`). A named workflow that changed since
   the comparison is refused (`stale`); run `auto` again.

Cancelling at any step starts nothing. The run's launch metadata (`agent-workflow-run-launch-v2`)
records the offered candidates, the recommendation, your choice, the classifier executor/model and
the consent source (`prompt` or `flag`); the task only as its SHA-256. `show <run>` prints an
`Auto selection:` line. With `--json`, `data.phase` is `consent-unavailable`, `consent-declined`,
`consent-cancelled` (MCP/API only: no answer from the user),
`classifier-unavailable`, `ranked`, `cancelled`, `stale` or `launched` (`data.launch` then holds
the launch result).

### Dynamic-controller approval (WP29)

A dynamic stage that declares `dynamic.permissions.approval: "ask"` needs the user's approval before
its controller runs ([usage.md](usage.md#dynamic-approval)).

- **In a terminal**, foreground `run`, `dynamic`, `wait` and `resume` print the approval scope to
  stderr and ask `Run dynamic workflow controller? [y/n]`. `y` runs the controller; `n` rejects it
  for this run (`dynamic_approval_rejected`, never asked again); an empty answer, end of input or 5
  minutes without one leave it open (`dynamic_approval_timeout`, resumable). `--yes` does not approve
  controllers; it only skips the degradation question.
- **Without a terminal, and for `--detach`** (the background supervisor has no terminal), the run
  blocks as `dynamic_ui_unavailable`. `status <run>` and `wait <run>` print the question, its request
  id and the commands `Approve: agent-workflow approve <run> --request <id>` /
  `Reject: … --reject`; `--json` has `data.pendingApprovals` (status: `data.run.pendingApprovals`).

`approve <run>` answers it later, from any process: in a terminal it shows the question and asks
`y/n` (`n` rejects, no answer records nothing and exits 1); without a terminal `--yes` is required
(exit 2 otherwise) and the flags are the decision (`--reject` rejects). `--request <id>` (or a unique
prefix of 8+ characters) picks one of several open approvals. The decision is recorded on the run
with `decidedBy: {host: "cli", via: "approve"}`. An approval resumes the run like `resume` (in the
foreground, `--detach` in a background supervisor; completed tasks are not relaunched); when the run
also holds failed, interrupted or undecided-executor tasks it is not resumed (exit 1) and `resume` is
named. A rejection exits 0 and leaves the run blocked.

### Stop confirmation

`stop` records a durable stop intent and waits up to 15 s for it to be applied. When this process can
take the run lease it applies the stop itself. When another supervisor (a detached one, or a Pi
session) owns the run, `stop` only confirms: a run that is already terminal with no stop intent left
has been stopped by that supervisor and counts as confirmed (exit 0, `data.pending: false`); a
repeated attempt never requests the stop again. Without a confirmation within 15 s `stop` prints
`Stop requested for <run>; the active supervisor has not confirmed it yet` and exits 1 with
`data.pending: true`; the intent stays durable.

## Saved user profiles

```sh
agent-workflow profile set fast --executor codex --effort high --permission-mode safe \
  --strict-capabilities readOnly,contextIsolation --default
agent-workflow profile show            # the default profile
agent-workflow profile set fast --unset effort
agent-workflow profile default --clear
agent-workflow profile delete fast
```

Fields: `executor`, `model`, `effort`, `permissionMode`, `strictCapabilities` (capability names
that must be `native`), `roles` (WP31). Stored in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json` (default
`~/.agent-workflow`, private file). `model`/`effort` are run defaults (stage and agent settings
still win; `--model`/`--effort` override everything).

### Roles and presets (WP31)

```sh
agent-workflow profile presets                         # codex, claude, pi, mixed and their role tables
agent-workflow profile set team --preset mixed --default
agent-workflow profile set team --role verification=codex:gpt-5.6-luna:high
agent-workflow profile set team --role synthesis=:haiku   # model only (executor from other layers)
agent-workflow profile set team --unset roles.synthesis
```

`--role <role>=<executor>[:<model>[:<effort>]]` (repeatable; empty segments are unset). Roles:
`default`, `planning`, `research-execution`, `synthesis`, `verification`, `final-judgment`, or
`agent:<name>`. Entries merge role by role. `--preset` replaces the saved executor and roles with
the preset's (other fields stay; `--executor`/`--role` given with it still win). An unknown
executor id is refused when the profile is saved (exit 2); role models are checked against the
executor's probe when a run starts.

### Per-workflow preferences (WP31)

```sh
agent-workflow profile workflow set deep-research --profile mixed \
  --role verification=codex:gpt-5.6-luna:high
agent-workflow profile workflow show deep-research
agent-workflow profile workflow set deep-research --unset roles.verification
agent-workflow profile workflow clear deep-research
agent-workflow profile workflow list
```

A preference belongs to the workflow's `name` (`<workflow>` may be a name or a spec path). Its
`profile` (declared, saved or preset; checked when saved) is used when a launch names none; its
roles apply to every launch of that workflow, from the CLI, MCP hosts and Pi, below the run flags
and above the selected profile. Stored in
`$AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json`. pi-workflow's
`~/.pi/agent/workflow-profiles` is never read.

## `doctor`

`agent-workflow doctor [--json]` checks the machine without calling a model and writes nothing:

- per executor (`pi`, `claude`, `codex`): installed, CLI version against the version the adapter's
  capabilities were verified with, login state (`ok`/`missing`/`expired`/`unknown`, never a
  credential), and the install or login command when it is not usable;
- the executor a run here uses when no `--executor` or workflow-declared profile selects one, and
  why (saved default profile, host default, or the installed-default order);
- the permission-mode default (`free`, or the default saved profile's mode);
- the Node version (requires `>=22`); `AGENT_WORKFLOW_HOME` and whether it is writable;
- Pi's web tools (WP35): whether `pi-web-access` is installed in the user's Pi (`pi list`), shown under
  `pi`; when it is missing, the install command `pi install npm:pi-web-access` (it is not bundled);
- warnings: Codex allow rules under `$CODEX_HOME/rules` and a global `$CODEX_HOME/AGENTS.md`
  (counts and paths only, never rule contents), CLI versions that differ from the verified ones, an
  installed Pi without `pi-web-access`;
- run-index entries in this project whose `run.json` is gone or that `prune` would remove, with a
  hint to run `agent-workflow prune`.

Exit 0 when at least one executor is usable, 1 otherwise. `--json` prints `{action: "doctor", ok,
outcome, data}`.

## `statusline`, `watch`, `notify-check`

WP36 (owner decisions E1/E2, [host-ux-investigation.md](host-ux-investigation.md)): progress and
completion for hosts that have no session UI of their own. All three only read the project's run
records (the run index names the candidates), never drive a run, take no lease and call no model.

**`statusline`** prints `aw: deep-review 5/13 running 12m · +1 more` for the newest active
top-level run (and how many others), or nothing when idle. States: `running`, `running (no
supervisor)` (no live process holds the run lease: start `agent-workflow supervise <run>`),
`awaiting approval` (WP29), `needs action` (blocked; shown for a day after its last update). It reads
the JSON Claude Code pipes on stdin (`workspace.project_dir`, `workspace.current_dir`, `cwd`; at most
150 ms) and shows the runs of those directories, else of the working directory. Any error prints
nothing; the exit code is always 0. The bin loads only this command's module (typically ~50 ms).
Claude Code setup (a user setting; plugins cannot set it):

```json
{ "statusLine": { "type": "command", "command": "agent-workflow statusline", "refreshInterval": 2 } }
```

in `~/.claude/settings.json` or the project's `.claude/settings.json`. `refreshInterval` re-runs it
while the session is idle (Claude Code otherwise refreshes only on conversation events). Without a
global install use `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow statusline`
(slower). With an existing status-line script, append its output: `agent-workflow statusline`
prints a single line or nothing.

**`watch [run]`** redraws every 2 s (`--interval` 1-10 s): with a run, its header (status, progress,
elapsed), one row per task (icon, name, status, elapsed, executor/model or the failure message),
pending approvals with the `approve` commands, and at the end `Finished: <status> — verdict X` plus
the report paths; without a run, one line per active run of the project and, once a run ended, its
result. It exits when the run (or every watched run) is finished or needs the user (`--follow` keeps
going until Ctrl-C; `--once` draws one frame). Exit code with a run: 0 when it completed, 1
otherwise; without a run: 0. On a terminal it clears and redraws (ANSI colors unless `NO_COLOR`);
on a pipe it prints a frame only when a status changed. `--bell` rings the terminal bell when it
ends (a desktop notification in terminals that map the bell). Ctrl-C stops watching, never the run.
Typical use: a pane next to Codex or Claude Code, `agent-workflow watch <runId>`.

**`notify-check`** prints, per top-level run that settled since the last check (finished, or blocked
and needing the user), one line such as

```text
agent-workflow: workflow "deep-review" (run workflow_…) finished — verdict NEEDS_WORK, report .agent-workflow/workflows/workflow_…/final-report.md. Details: agent-workflow status workflow_…
```

and nothing otherwise (exit 0). Blocked runs name the approval (`approve`) or the
inspect/resume commands; `--host claude-code|codex|generic` words the follow-ups as MCP tool calls.
Receipts: `.agent-workflow/notify-check/` (created by the first check in a project that has runs,
or by the first `wait` that returns a settled state)
holds `baseline.json` (the first check also reports runs that settled in the hour before it) and one
marker per reported state, created exclusively so concurrent checks print a state once. A resumed
run that settles again is reported again. `wait` (CLI, MCP `workflow_wait`, Pi) marks the state it
returned, so a result the host already showed is not repeated; since WP39b also in a fresh project
(it creates the directory and the baseline; before, the first run of a project was announced once
more by the hook). At most 5 runs per check (the rest
next time); markers of pruned runs are removed. `--json` prints `{action, ok, outcome, data:
{notifications, deferred}}`. `--follow` checks every 5 s (`--interval` 1-60) and prints new lines as
they appear (a long-lived feed, for example a Claude Code plugin monitor). `--stamp <name>` (WP42,
the plugin hook's idle test) writes `.agent-workflow/notify-check/<name>.stamp` after a successful
check, with the check's start time as its mtime (a check that deferred runs removes it instead, so
the hook checks again until the backlog is drained); the receipts directory is created only as a real
directory inside a real `.agent-workflow` (a symlinked one is refused and nothing is written). Hook
setup: [plugins.md](plugins.md#completion-check-hook).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; a completed run (`run`, `wait`, `resume`, `supervise`); a launched detached run |
| 1 | A failed, interrupted or blocked run; a refused launch; a run still running at `--timeout`; a stop not confirmed in 15 s; any other error |
| 2 | Usage error: unknown command or option, missing or invalid argument, misconfigured test-executor hook |

`supervise` previously (pi-workflow) exited 2 for blocked runs; it now exits 1 like every other
command. Its log lines and its structured result still say `blocked`.

**Non-passing domain verdicts exit 1 (CI semantics, WP18b).** A workflow whose final step reports a
non-passing verdict as `failed` (for example deep-review's `PARTIAL_REVIEW`, statusDetail
`support_declared_failed`) leaves the run `failed`, so `run`/`wait` exit 1 and a CI job fails. The
text still presents it as a finished run, not as a crash: `Workflow finished — verdict: PARTIAL_REVIEW
(report ready)`, the run status on its own line, the result preview and the report path; `--json`
has `data.verdict` and `data.verdictGate: true`. WP19: only when the output task declared a
domain verdict *and* wrote its report inside the run directory; any other support failure is shown
as a failure. Passing verdicts (for example `NEEDS_WORK` and
`REVIEW_COMPLETE` in deep-review) complete the run and exit 0.

## Environment

| Variable | Meaning |
|---|---|
| `AGENT_WORKFLOW_HOME` | Per-user directory (profiles, user workflows and agents). Default `~/.agent-workflow`. |
| `AGENT_WORKFLOW_ROLE` | `worker`/`disabled` processes may only `validate`/`help`. |
| `AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR=1` | Keep the detached supervisor in the CLI's process group (tests). |
| `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE`, `AGENT_WORKFLOW_TEST_EXECUTOR_ACK` | Test-only executor hook, below. |

### Test-executor hook (tests only)

End-to-end tests (for example the packed-install test) run workflows without a real agent CLI by
registering a test executor:

```sh
AGENT_WORKFLOW_TEST_EXECUTOR_MODULE=/abs/path/test-executor.mjs \
AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only \
agent-workflow run wf.json "task" --executor test-fake
```

The module exports `testExecutorDescriptor` (an `ExecutorDescriptor`) and, as its descriptor module,
`createExecutor(config)`. Guards: the ack variable must be exactly `test-only` (otherwise the CLI
refuses every command with exit 2), the path must be absolute, and the id must start with `test-`, so
it can never replace `pi`, `codex` or `claude`. It is only registered, never the default: a run must
name it with `--executor`. Each command that registers it prints a warning to stderr.

## Examples

```sh
agent-workflow list
agent-workflow validate deep-review
agent-workflow run deep-review "review src/hosts for error handling" --executor claude
agent-workflow run spec-review "check docs/spec.md" --executor codex --permission-mode safe --yes
agent-workflow run deep-research "state of X" --input depth=quick
id=$(agent-workflow run deep-research "state of X" --detach --json | jq -r .data.runId)
agent-workflow wait "$id" --timeout 30m
agent-workflow inspect "$id" --failures --results
agent-workflow stop "$id" && agent-workflow resume "$id" --detach
agent-workflow prune --keep 20 --yes
```

## Change log

- **Live bundle 6: the `prune` dry run agreed with `--yes` only for removable worktrees.** A run
  whose managed worktree prune keeps (checked out on a user branch, not identified, unknown state)
  was listed under "Runs that would be deleted" and counted in the total bytes, with only the
  worktree line saying "kept"; `--yes` then kept the run ("protected: worktree removal failed: …").
  The dry run now marks such a run `protected: worktree kept: <path>: <reason>` and leaves its bytes
  out of the total; `--yes` is unchanged. Test:
  `test/unit/core-live6-prune-preview-kept-worktree.test.mjs` (fails on the old code:
  `protected` false).
- **Live bundle 5 (WP39): terminal answers were read as no answer.** On a real terminal every y/N
  question of the CLI (the `auto` consent and pick-list, `Proceed with these capability
  degradations?`, the dynamic-controller approval of foreground `run`/`dynamic`/`wait`/`resume`, and
  `approve`) received an empty answer whatever was typed: the readline prompt closed its interface
  before resolving the typed line, and the synchronous `close` event resolved `""` first. So `y` to
  the `auto` consent printed "Not sent: you did not agree", a degradation confirmation declined, and
  an approval stayed open (`dynamic_approval_timeout`). Nothing was sent or started by mistake (every
  path fails closed). The prompt (`readlinePrompt`) now settles the typed line before closing; end of
  input and an abort still answer `""`. The unit tests of these flows script `io.prompt` and never ran
  the real prompt; `test/unit/host-wp39-cli-readline-prompt.test.mjs` runs it on a stream (fails with
  the old ordering: `'' !== 'y'`).
- **WP39b (live bundle 5, O14): no progress output on an open question.** A foreground run whose
  dynamic-controller approval question stayed open past a wait slice printed `still running …` and
  progress lines right after `Run dynamic workflow controller? [y/n]`, on the question's line.
  Progress output now pauses while a question is open and the newest held line is printed after the
  answer. Test: `host-wp29-cli-approval.test.mjs` "no progress line is printed while the approval
  question is open" (fails on the old code).
