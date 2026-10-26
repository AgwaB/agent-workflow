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
| `wait <run> [--timeout D]` | Drive and wait until the run is terminal or needs action. |
| `resume <run> [--detach] [--timeout D]` | Reset failed, interrupted and resumable blocked tasks, then continue in the foreground or detached. |
| `stop <run>` | Stop a non-terminal run (durable stop intent; workers are cancelled). |
| `prune [--keep N] [--older-than DAYS] [--yes]` | Delete terminal runs beyond the filters; a dry run without `--yes`. |
| `notices list [--json] \| acknowledge <run> --state <sha256> --reason <text> \| clear <run> [--json]` | Notification-only acknowledgements of unfinished runs. |
| `supervise <run> \| --all [--poll-ms N] [--max-runtime-ms N]` | Drive scheduling from this process until the run(s) are terminal. |
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
| `--detach` | Start a background supervisor (`agent-workflow supervise <id>`, log in `<run dir>/supervise.log`) and return the run id at once. |
| `--force-new` | Skip the duplicate-launch guard (an identical active run started in the last 10 minutes). |
| `--yes` | Never ask: record capability degradations and proceed. |
| `--timeout <d>` | Stop waiting after `d` (`30000`, `30s`, `5m`, `1h`). The run continues. Not with `--detach`. |
| `--json` | Print one JSON object `{action, ok, outcome, data}` (for `run`/`resume` without `--detach`, `data.wait` holds the final wait result). |

The task is every remaining positional word. Put `--` before task text that starts with `--`:
`agent-workflow run deep-review -- --literal text`.

### Precedence

Executor and permission mode: **run flag > workflow-declared profile > saved user profile >
default** (executor `pi`, mode `free`). Without `--profile` a launch uses the workflow's
`defaultExecutionProfile` if it declares one, else the default saved user profile. A
workflow-declared profile replaces the saved user profile as a whole (B2).

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

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; a completed run (`run`, `wait`, `resume`, `supervise`); a launched detached run |
| 1 | A failed, interrupted or blocked run; a refused launch; a run still running at `--timeout`; a stop not confirmed in 15 s; any other error |
| 2 | Usage error: unknown command or option, missing or invalid argument, misconfigured test-executor hook |

`supervise` previously (pi-workflow) exited 2 for blocked runs; it now exits 1 like every other
command. Its log lines and its structured result still say `blocked`.

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
id=$(agent-workflow run deep-research "state of X" --detach --json | jq -r .data.runId)
agent-workflow wait "$id" --timeout 30m
agent-workflow inspect "$id" --failures --results
agent-workflow stop "$id" && agent-workflow resume "$id" --detach
agent-workflow prune --keep 20 --yes
```
