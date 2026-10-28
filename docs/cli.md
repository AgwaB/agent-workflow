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
| `profile list \| show [name] \| set <name> … \| delete <name> \| default <name> \| default --clear` | Saved user profiles (below). |
| `run <workflow> <task…>` | Start exactly the named workflow and wait in the foreground until it is terminal. |
| `dynamic <task…>` | Start a spec-less direct dynamic run; same options as `run`. |
| `status [run]` | All top-level runs, or one run. |
| `inspect <run> [--failures] [--results]` | Reliability summary and task listing. `--failures` lists failed/blocked/interrupted tasks; `--results` prints task results (with `--failures` on a clean run: every result). |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | Bounded tail of task output, stderr and executor events (the latest attempt's `exec-events.jsonl`); every started task by default (at most 6). Lines per stream 1-400 (default 20), lines cut at 400 characters, the text at 48 000. Credentials (WP19: also quoted structured fields such as `"Authorization":"Basic …"` and `"refresh_token":"…"`), bearer tokens, URL secrets, macOS/Linux/Windows home paths and values of sensitive environment variables are redacted, here and in `status`/`show`/`inspect`/`wait` text. WP19: only files inside the project's `.agent-workflow/` are read; a tampered absolute, `..` or symlink-escaping path is refused and the reason shown. |
| `wait <run> [--timeout D]` | Drive and wait until the run is terminal or needs action. |
| `resume <run> [--detach] [--timeout D]` | Reset failed, interrupted and resumable blocked tasks, then continue in the foreground or detached. |
| `stop <run>` | Stop a non-terminal run (durable stop intent; workers are cancelled). Waits up to 15 s for confirmation (below). |
| `prune [--keep N] [--older-than DAYS] [--yes]` | Delete terminal runs beyond the filters, and (WP18b) terminal executor attempt records older than 7 days (or `--older-than`) under `~/.agent-workflow/executors/` (WP19: a launched attempt's record becomes a compact tombstone that is never pruned, so reconcile never reports it absent; containment is physical: a symlinked `attempts/`, Pi `runs/` or other ancestor is refused and reported, never followed), and stale host launch claims (`.agent-workflow/host-launches/`, older than 1 h); a dry run without `--yes`. |
| `notices list [--json] \| acknowledge <run> --state <sha256> --reason <text> \| clear <run> [--json]` | Notification-only acknowledgements of unfinished runs. |
| `supervise <run> \| --all [--poll-ms N] [--max-runtime-ms N]` | Drive scheduling from this process until the run(s) are terminal. |
| `doctor [--json]` | Check this machine without a model call: executors (installed, version vs verified, login), the default executor here and why, permission-mode default, Node, `AGENT_WORKFLOW_HOME`, Codex environment warnings, stale run-index entries. Exit 0 when at least one executor is usable. Below. |
| `help [command]`, `<command> --help`, `--version` | Help and version. |

A run argument accepts the run id or an unambiguous prefix.

## Launch options (`run`, `dynamic`)

| Option | Meaning |
|---|---|
| `--executor <id>` | Executor for this run: `pi`, `codex`, `claude` (or a registered id). Highest precedence. |
| `--profile <name>` | A profile the workflow declares (`executionProfiles`), else a saved user profile with that name. |
| `--permission-mode free\|safe` | Approvals and sandbox (`docs/permissions.md`). Default `free`. |
| `--allow-unverified <a,b>` | Accept these `unverified` executor capabilities (B4 opt-in), e.g. `contextIsolation`. |
| `--model <id>` | Model override for every stage. |
| `--effort <level>` | Effort override: `off minimal low medium high xhigh max` (`--thinking`/`--reasoning` are aliases). |
| `--input <key=value>` | Set a workflow input the spec declares (repeatable; `--input=key=value` also works). Typed like the declared default: string as is, number, `true`/`false`, JSON for arrays, objects and `null`. An undeclared key, a wrong type, a repeated key or a missing `=` is a usage error (exit 2, nothing starts). Example: `--input depth=quick`. |
| `--detach` | Start a background supervisor (`agent-workflow supervise <id>`, log in `<run dir>/supervise.log`) and return the run id at once. |
| `--force-new` | Start a new run although an identical launch (same workflow, task, inputs and options) is still active; without it, the guard prints that run (`outcome: "existing"`, exit 0) and, in the foreground, waits for it. Applies to `--detach` too. |
| `--yes` | Never ask: record capability degradations and proceed. |
| `--timeout <d>` | Stop waiting after `d` (`30000`, `30s`, `5m`, `1h`). The run continues. Not with `--detach`. |
| `--json` | Print one JSON object `{action, ok, outcome, data}` (for `run`/`resume` without `--detach`, `data.wait` holds the final wait result). |

The task is every remaining positional word. Put `--` before task text that starts with `--`:
`agent-workflow run deep-review -- --literal text`.

### Precedence

Executor and permission mode: **run flag > workflow-declared profile > saved user profile >
default** (mode `free`; executor: below). Without `--profile` a launch uses the workflow's
`defaultExecutionProfile` if it declares one, else the default saved user profile. A
workflow-declared profile replaces the saved user profile as a whole (B2).

**Default executor (WP17).** When nothing above selects one, the CLI uses the **first installed and
logged-in** of `pi` → `claude` → `codex`. Each candidate is checked with its adapter's probe (version
and login status commands, no model call): it must be installed and its login not `missing` or
`expired`; an `unknown` login (Pi cannot report it without a model call) counts as usable and is
recorded. The run records `executor.source: "installed-default"`, `executor.host: "cli"` and the
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
that must be `native`). Stored in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json` (default
`~/.agent-workflow`, private file). `model`/`effort` are run defaults (stage and agent settings
still win; `--model`/`--effort` override everything).

## `doctor`

`agent-workflow doctor [--json]` checks the machine without calling a model and writes nothing:

- per executor (`pi`, `claude`, `codex`): installed, CLI version against the version the adapter's
  capabilities were verified with, login state (`ok`/`missing`/`expired`/`unknown`, never a
  credential), and the install or login command when it is not usable;
- the executor a run here uses when no `--executor` or workflow-declared profile selects one, and
  why (saved default profile, host default, or the installed-default order);
- the permission-mode default (`free`, or the default saved profile's mode);
- the Node version (requires `>=22`); `AGENT_WORKFLOW_HOME` and whether it is writable;
- warnings: Codex allow rules under `$CODEX_HOME/rules` and a global `$CODEX_HOME/AGENTS.md`
  (counts and paths only, never rule contents), CLI versions that differ from the verified ones;
- run-index entries in this project whose `run.json` is gone or that `prune` would remove, with a
  hint to run `agent-workflow prune`.

Exit 0 when at least one executor is usable, 1 otherwise. `--json` prints `{action: "doctor", ok,
outcome, data}`.

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
has `data.verdict` and `data.verdictGate: true`. Passing verdicts (for example `NEEDS_WORK` and
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
