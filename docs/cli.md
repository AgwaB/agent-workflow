# `agent-workflow` CLI

The CLI needs no Pi packages. It shares [host API handlers](extending.md#host-api) with the MCP server
and Pi host.

```sh
npm install @agwab/agent-workflow      # provides the agent-workflow bin
npx agent-workflow --help
```

**Project directory.** The CLI works on the nearest enclosing project: walking up from the current
directory, the first directory with a `.agent-workflow/` or a `.git` (never the one that holds the
user-level `~/.agent-workflow`), else the current directory. Its `workflows/` and `.agent-workflow/workflows/` are searched; runs are recorded
in its [state directory](usage.md#where-run-state-lives). Workers run in the project, so paths in a task are read from the project root.
When that is not the current directory the CLI says so on stderr ("agent-workflow: project <dir> (the
current directory is inside it …)"). To make a subdirectory its own project, create
`.agent-workflow/` in it. The directory that holds the user-level `~/.agent-workflow` (usually ~) is
never a project, in the CLI, the MCP server and the Pi host alike: runs started there are recorded in
`~/.agent-workflow/home-runs` and their workers run in it (the CLI says so on stderr). The MCP server and the Pi host otherwise use the directory their host gives them; a
workflow name that only an enclosing project has then fails with "not found in <dir>; the project
<ancestor> has it — … run from <ancestor> (or pass the spec path)".

**Contents:** [Commands](#commands) · [`new`](#new) · [`check`](#check) · [`rehearse`](#rehearse) · [Launch options (`run`, `dynamic`)](#launch-options-run-dynamic) · [Saved user profiles](#saved-user-profiles) · [`doctor`](#doctor) · [`dashboard`](#dashboard) · [`statusline`, `watch`, `notify-check`](#statusline-watch-notify-check) · [Exit codes](#exit-codes) · [Environment](#environment) · [Examples](#examples) · [`host-command` hook entry](#host-command-hook-entry)

## Commands

| Command | What it does |
|---|---|
| `list [--query T] [--offset N] [--limit N]` | Discoverable workflows: project `workflows/` and `.agent-workflow/workflows/`, `~/.agent-workflow/workflows/`, bundled (Pi's directories are not read). `--limit` (1-20) pages the output and bounds it to 50 KB. |
| `validate <workflow>` | Load and compile a spec without running it. Its `Tasks:` count is the compiled task count: a `foreach` or `loop` counts once, so a run has more ([task ids](usage.md#run-records)). Lists `Warnings:` ([what it checks](usage.md#what-validate-checks)). |
| `new <pattern> <name> [--scope private\|shared\|global] [--force]` / `new --list` | Create a workflow from a pattern (`single`, `foreach-reduce`, `loop-refine`, `parallel-review-merge`, `classify-count`, `write-verify`, `collect-render`) that already validates and rehearses clean; you replace the `TODO:` prompts (below). No model call. |
| `check <workflow> [<task…>] [launch options]` | The launch preflight without the launch: executor, tools, models and effort for the executor that would run each stage (below). No run, no model call. |
| `rehearse <workflow> [<task…>] [--items N] [--loop pass\|exhaust] [--keep] [--json]` | Run a workflow through the real engine with a synthetic worker (no model call or network by the worker; temporary engine run state; helpers are trusted code, below). Reports the wiring per stage. |
| `roles <workflow>` | Compiled role context as injected into task prompts. |
| `agents` | Agent definitions. |
| `show <workflow>` | The resolved spec file. |
| `show <run> [--raw]` | Run details. Arguments that start with `workflow_` (or `--raw`) are runs; any other argument is looked up as a workflow, so a mistyped run id without that prefix fails with `workflow name or spec file not found`. |
| `profile list \| show [name] \| set <name> … \| delete <name> \| default <name> \| default --clear \| presets` | Saved user profiles, roles and built-in presets (below). |
| `profile workflow list \| show <workflow> \| set <workflow> … \| clear <workflow>` | Shared user-level, name-keyed workflow preferences (below). |
| `project-settings list \| show \| clear-binding \| reset \| purge \| clear-project \| inspect-recovery \| recover` | Separate project-local inspection and recovery, including undiscovered keys (below). |
| `run <workflow> <task…>` | Start exactly the named workflow and wait in the foreground until it is terminal. |
| `dynamic <task…>` | Start a spec-less direct dynamic run; same options as `run`. |
| `auto <task…>` | Classify the task once and start the top recommendation without asking; same options as `run`. Below. |
| `status [run]` | All top-level runs, or one run. |
| `inspect <run> [--failures] [--results]` | Reliability summary and task listing. `--failures` lists failed/blocked/interrupted tasks; `--results` prints task results (with `--failures` on a clean run: every result). |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | Bounded tail of task output, stderr and executor events (the latest attempt's `exec-events.jsonl`); every started task by default (at most 6). Lines per stream 1-400 (default 20), lines cut at 400 characters, the text at 48 000. Credentials (including quoted structured fields such as `"Authorization":"Basic …"` and `"refresh_token":"…"`), bearer tokens, URL secrets, macOS/Linux/Windows home paths (except managed worktree paths under your own home, shown as `~/…`) and values of sensitive environment variables are redacted, here and in `status`/`show`/`inspect`/`wait` text. Only files inside the [state directory](usage.md#where-run-state-lives)'s `.agent-workflow/` are read; a tampered absolute, `..` or symlink-escaping path is refused and the reason shown. |
| `wait <run> [--timeout D]` | Drive and wait until the run is terminal or needs action. |
| `resume <run> [--detach] [--timeout D]` | Reset failed, interrupted and resumable blocked tasks, then continue in the foreground or detached. |
| `stop <run>` | Stop a non-terminal run (durable stop intent; workers are cancelled). Waits up to 15 s for confirmation (below). |
| `prune --run <run-id>… [--yes]` | Delete exactly the named terminal runs (exact ids, repeatable; not combinable with `--keep`/`--older-than`). Any id that is not a terminal run in the project fails the call and deletes nothing; the run protections (live lease, retained children, worktree rules, owned sessions) apply as below; the age-based sweeps (executor attempt records, host launch claims, `auto` requests) are skipped. A dry run without `--yes`. |
| `prune [--keep N] [--older-than DAYS] [--yes]` | Preview deletion of old terminal runs (default: keep newest 50), classifier requests, managed worktrees, terminal executor attempts older than 7 days (or `--older-than`), and host launch claims older than 1 h. `--yes` applies it. See [retention](usage.md#run-records) for protections and cleanup rules. |
| `notices list [--json] \| acknowledge <run> --state <sha256> --reason <text> \| clear <run> [--json]` | Notification-only acknowledgements of unfinished runs. |
| `supervise <run> \| --all [--poll-ms N] [--max-runtime-ms N]` | Drive scheduling from this process until the run(s) are terminal. |
| `dashboard [--port N] [--readonly] [--auth] [--open] [--project DIR]` | One user-level localhost dashboard for all projects: Overview (needs, clean-up), Runs, Workflows/Check, Profiles/preferences and Executors; Stop/Resume/Approve/Reject. |
| `watch [run] [--follow] [--once] [--interval S] [--bell]` | Live terminal view of the project's active runs or one run (tasks, status, elapsed, blockers, verdict and report at the end). Read-only. Below. |
| `statusline` | One line about the active runs for a status bar (Claude Code `statusLine`); empty when idle; always exit 0. Below. |
| `notify-check [--host H] [--json] [--stamp N] [--run ID] [--follow [--interval S]]` | One line per run that finished (or needs the user) since the last check, each state once; for host hooks. Below. |
| `host-command --host claude-code\|codex` | Hook entry: read JSON on stdin, handle the six in-host `aw` forms; block JSON or empty stdout, always exit 0. Not an interactive CLI. |
| `doctor [--fix [--yes]] [--json]` | Check this machine without a model call: executors (installed, version vs verified, login), the default executor here and why, permission-mode default, Node, `AGENT_WORKFLOW_HOME`, Codex environment warnings, stale run-index entries. Exit 0 when at least one executor is usable. Below. |
| `help [command]`, `<command> --help`, `--version` | Help and version. |

A run argument accepts the run id or an unambiguous prefix.

Every command except `help`/`--version`, the hook entry `host-command` (below), the authoring commands `new` and `rehearse`, and the terminal views `watch`, `dashboard`, `statusline`,
`notify-check`, whose data the `workflow_status`/`workflow_wait` tools already return, is also a host MCP tool (`workflow_<command>`,
[host-mcp.md](hosts.md#tools)); the MCP forms of `prune --yes`, `profile set|delete|default`, `profile workflow set|clear` and
`notices acknowledge|clear` and changing `project-settings` operations ask the user to confirm through MCP elicitation, and a client that
cannot ask is refused with the CLI command line to run here instead. `supervise` on MCP starts the
detached supervisor and returns at once.

## Project-local workflow settings

This is separate from shared `profile workflow` preferences. Work in the intended project, inspect
first, and use its returned `projectId`, exact 64-hex workflow `key` and CAS tokens. `list` includes
empty and undiscovered/orphan entries; `show` does not discover or load a definition. Read operations
create no files or directories. Unknown arguments and fields are errors.

```sh
agent-workflow project-settings list --json
agent-workflow project-settings show --key "$KEY" --json
# Remove one complete stored slot binding, not a model/effort field:
agent-workflow project-settings clear-binding --key "$KEY" --binding slot --slot "$SLOT" \
  --store-epoch "$EPOCH" --revision "$REVISION" --confirm-project "$PROJECT_ID"
# For workflow defaults use --binding defaults, without --slot.
agent-workflow project-settings reset --key "$KEY" \
  --store-epoch "$EPOCH" --revision "$REVISION" --confirm-project "$PROJECT_ID"
agent-workflow project-settings purge --key "$KEY" \
  --store-epoch "$EPOCH" --revision "$REVISION" --confirm-project "$PROJECT_ID"
# Distinct whole-project operation; use epoch and digest from a fresh list:
agent-workflow project-settings clear-project --store-epoch "$EPOCH" \
  --raw-digest "$DIGEST" --confirm-project "$PROJECT_ID"
```

Review the affected values returned by inspection before supplying `--confirm-project`; this flag
is explicit destructive consent for that project, not a discovery path. The CLI also prints the
scope and affected values on stderr. A stale epoch/revision/digest conflicts without overwriting;
inspect again and review rather than automatically retrying. `clear-binding` preserves defaults,
sibling slots and every other entry. It does not repair unrelated invalid intent. `reset` retains
an empty entry with a new revision; `purge` removes the entry and rotates the store epoch.
`clear-project` writes an empty store with a new epoch. Shared profiles/preferences, other projects
and existing Runs are unchanged. Clearing restores lower-layer behavior for future launches; it
does not guarantee a launch will pass Check.

Malformed stores block ordinary local reads and new named launches; there is no fallback repair.
Inspection/recovery remains separate, and existing Run Resume uses its captured configuration.

```sh
agent-workflow project-settings inspect-recovery --json
# Use the rawDigest and projectId returned by that inspection:
agent-workflow project-settings recover --raw-digest "$RAW_DIGEST" --confirm-project "$PROJECT_ID"
```

Recovery requires the inspected raw digest, preserves an exact verified private backup and then
replaces only malformed project-local storage. It refuses a valid store (use `clear-project`),
unsafe/unreadable files, invalid UTF-8 and originals over 16 MiB; those require manual safe repair.
Ordinary stores are limited to 512 entries and 1 MiB. Neither clear nor recovery migrates shared
settings, discovers vanished definitions, supplies replacement metadata or edits existing Runs.
For identity and precedence see [usage](usage.md#project-local-workflow-settings). The MCP tool is
`workflow_project_settings`, with an additional user confirmation dialog for every change.

## `new`

```sh
agent-workflow new <pattern> <name> [--scope private|shared|global] [--force] [--json]
agent-workflow new --list
```

`new` writes a complete workflow bundle for a pattern, so authoring starts from something that already
passes `validate` with no warnings and `rehearse` with no findings, and the one thing you must edit is the
prompts. `new --list` prints the patterns:

| Pattern | Stages |
|---|---|
| `single` | `run`: one model stage with a closed control schema |
| `foreach-reduce` | `plan` → `work` (foreach over the plan's items) → `report` (partial fan-in) |
| `loop-refine` | `refine` loop (`draft`, `review`; at most 3 rounds, until the review approves) → `publish` (reads the loop through `from`) |
| `parallel-review-merge` | `reviewer-1..3` (independent roots) → `merge-findings` (code) → `summary` (`require-success`, required read of the merge) |
| `classify-count` | `load` → `classify` (foreach with `itemIdentityPath`) → `count` (code; reconciles ids, lists missing ones) → `report` |
| `write-verify` | `write` (write-capable, `readOnly: false`, `worktreePolicy: "on"`, edits files in its managed worktree; never merged) → `verify` (code; the files exist, are non-empty and hold the markers set in `support.options.files`, else the run fails) |
| `collect-render` | `collect` (code; `git log` → commit list) → `render` (code; grouped Markdown changelog). No model stage, no `TODO:` prompt, no model call at run time |

Each bundle has `spec.json`, closed control schemas (`additionalProperties: false`, including `schema`
and `digest`), support helpers where the pattern has code stages, a `profileRole` on every model stage and
a `minItems` and `maxItems` on every foreach source array. Every prompt starts with a `TODO:` paragraph that already works
as generic placeholder text: replace it with your domain instructions. The paragraph after it (the
Contract) is generated from the stage's schema (allowed keys, exact enum values, caps, and a few-shot
`<control>` skeleton that is checked against the schema); keep it, and if you change a schema, change its
stage's Contract sentences and example with it. The same arguments always write byte-identical files.

`write-verify` also writes the writer agent, `<name>-writer.md` (tools `read, grep, find, ls, edit, write`, `readOnly:
false`), because a bundle cannot carry its own agent: it goes to `<project>/.agent-workflow/agents/` (scopes `private` and
`shared`; commit it with a shared workflow) or `$AGENT_WORKFLOW_HOME/agents/` (`global`), is listed in the output and is
refused without `--force` like every other file. Set the files to check in the `verify` stage's `support.options.files`
(`[{"path": "OUTPUT.md", "markers": ["# Output"]}]`, paths relative to the worktree root) and keep the `write` prompt in step.
The project must be a git repository with a commit: the writer runs in a managed worktree (branch
`agent-workflow/<run>-<task>`) that is kept for review; nothing merges or commits. `collect-render` reads `git log` in the
project (`support.options`: `maxCommits`, `range`) and renders Conventional Commits groups; in a directory that is not a
git repository the run fails (only `rehearse` gets an empty list); `run` still wants a task argument, any text will do. While `rehearse` runs, helpers see
`AGENT_WORKFLOW_REHEARSAL=1`: `verify` then still looks up the worktree but skips the file checks, which the synthetic
writer cannot satisfy. A `rehearse` of a workflow with a write stage runs in a throwaway clone of the project's `HEAD` plus the current
`.agent-workflow/agents` and `.agent-workflow/workflows` (other uncommitted changes are not copied), so the project's worktrees, branches and working tree stay unchanged.

`--scope private` (default) writes `.agent-workflow/workflows/<name>/` in the project, `shared` writes
`workflows/<name>/`, `global` writes under `$AGENT_WORKFLOW_HOME/workflows/` ([where workflows are
found](usage.md#where-workflows-are-found)). Existing files are never overwritten: the command lists them and
exits 2, and `--force` replaces only the files the pattern writes (other files in the directory stay). A
symlinked workflow directory, `schemas/` or `helpers/` directory, or target file is refused even with
`--force`, and so is a flat `<name>.json` beside the new directory. Names Windows reserves (`CON`, `PRN`, `AUX`,
`NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, any case, with or without an extension) are a usage error. The bundle is
written all-or-nothing: if a write fails part-way, the files and directories this call created are removed and
replaced files are restored. When the same name exists in a
higher-priority scope the output says it takes priority. The output lists the created paths and the next
steps: edit the prompts → `validate` → `check` → `rehearse` → a smoke run on the cheapest model. Exit 0
on success, 2 for a usage error or a refused write. Terminal CLI only (no MCP tool, no Pi command).

## `check`

```sh
agent-workflow check <workflow> [<task...>] [--executor <id>] [--profile <name>]
                     [--model <id>] [--effort <level>] [--permission-mode free|safe] [--json]
```

The launch preflight without the launch: the same executor selection, compile and
checks as `run` — executor installed and logged in, every stage's tools, model and effort available
on the executor that would run it (names rewritten to that tool's form), capabilities, and a git repository with a commit for
every write-capable stage (its managed worktree). Prints the
short check and exits 0, or `Not started: …` with each problem (`✗`) and exits 1. No run, no
duplicate-launch claim, no model call. See [usage.md](usage.md#preflight-capability-tools-models-and-effort).

## `rehearse`

```sh
agent-workflow rehearse <workflow> [<task...>] [--items N] [--loop pass|exhaust] [--keep] [--json]
```

`validate` checks form; `rehearse` checks wiring. It runs the workflow through the real engine
(scheduler, foreach, loops, source manifests, support helpers, dynamic controllers, the final render) but
every model task is answered by a synthetic worker: a control generated from the stage's own control
schema (required fields, enums, bounds, `schema` and `digest`), with the required `workflow_artifact`
reads made through the real tool. The synthetic worker calls no model and uses no network. The engine's
run state goes to a temporary directory that is removed afterwards (`--keep` keeps it and prints its
path); the engine does not touch the user's run state, credentials or provider pause, and nothing can
select the synthetic executor for a real run. Support helpers are trusted code that is not confined
(see "What a rehearsal confines" below). The same spec and options give the same report.

The report lists per stage the tasks and their statuses, whether a stage that names `from` sources
received any, each required read (and the tool's message when its path does not resolve), foreach
item counts, loop rounds and end status, helper errors with their message, and whether the final
report rendered. `--items N` (0-20, default 2) sets how many items an unbounded array gets;
`--loop exhaust` keeps every bounded loop's `until` false so `onExhausted` and the `exhausted`
status are exercised (default `pass`: `until` holds on round 1). A support helper that itself
declares `failed` or `blocked` on the synthetic data is listed as a declared failed/blocked, not as a wiring problem:
the text names each such helper and its reason and says the rehearsal cannot tell a content check from a setup
problem (the reason is the only evidence: a message about placeholder data versus one naming a missing source or
setup, which is a wiring problem), and lists the stages it made skip; `data.status` is then `content-gates` (the name
is kept; `data.runStatus` keeps `failed` or `blocked`).
A support helper whose text looks up a literal source name its stage cannot receive (`sources.x`, `sources["x"]`,
`Object.hasOwn(sources, "x")`, `"x" in sources`, `const { x } = sources`) gets a `validate`/`compile` warning, and
`rehearse` prints it among its warnings; it is advisory and never changes the exit code. It is a static scan of the
helper file: computed or template names, field checks on a declared source (`"x" in sources.a`), object literals
and regular expressions are not lookups, and a helper that reassigns `sources` is not judged. The helper itself runs
exactly as in the engine.
Exit 0 means no wiring fault was diagnosed (`wiring OK`, with or without declared failed/blocked), not that the
wiring is proven; 1 means it found wiring problems (a helper that throws is one) or the spec is invalid, 2 a usage
error. `--json` prints
`{action, ok, outcome, data}` with the report in `data`.
What a rehearsal confines: the engine's managed worktrees, branches and run state live in the temporary root
(a write stage, also inside a `loop` or `onExhausted`, runs in a throwaway clone), its own git commands run without your
system or global git config and with an empty template and hooks path, and a managed writer whose `cwd` names the real
project is refused with an error. It does not sandbox helpers: a support helper is trusted bundle code run as ordinary
JavaScript in the rehearsing process and can write anywhere you can (its fallback `cwd` can even be the real project),
so only rehearse workflows whose helpers you trust. The clone holds the repository's raw blobs: no clean/smudge filter
or LFS download runs (the global config is ignored), so a tracked file that normally materializes through a filter
appears as its stored text. Rehearsals in one process run one after another. An in-process rehearsal swaps process-wide environment (the state home, the run index and git settings), so an embedding host must not run other engine work in the same process at the same time (the CLI runs it in its own process); a rehearsal waits for the supervision and index work of its run and of every nested workflow it started before restoring that environment. If a process still uses the temporary
root when the wait ends (or `ps` cannot say), the root is kept and its path reported as left behind (also on the error
when a rehearsal throws). Only a root whose last check found no process using it is safe to delete by hand; when the
report says a worker may still use it, or that this could not be checked, wait for workers to exit before removing it.
See [usage.md](usage.md#rehearse-a-workflow).

## Launch options (`run`, `dynamic`)

These options also apply to `auto`.

| Option | Meaning |
|---|---|
| `--executor <id>` | Executor for this run: `pi`, `codex`, `claude` (or a registered id). Highest precedence. |
| `--profile <name>` | A profile the workflow declares (`executionProfiles`), else a saved user profile with that name, else a built-in preset (`codex`, `codex-high`, `claude`, `mixed`). Without it: the workflow's saved preference profile, if any. |
| `--permission-mode free\|safe` | Approvals and sandbox (`docs/usage.md#permission-modes`). Default `free`. |
| `--allow-unverified <a,b>` | Accept these `unverified` executor capabilities, e.g. `contextIsolation`. |
| `--model <id>` | Model override for every stage. |
| `--effort <level>` | Effort override: `off minimal low medium high xhigh max ultra`. Each executor and model gets the nearest level it supports, the lower one on a tie (Codex `ultra` on Luna → `max`; Claude/Pi `ultra` → `max`; Codex `off`/`minimal` → `low`), and `check`/the launch text says so. |
| `--input <key=value>` | Set a workflow input the spec declares (repeatable; `--input=key=value` also works). Typed like the declared default: string as is, number, `true`/`false`, JSON for arrays, objects and `null`. An undeclared key, a wrong type, a repeated key or a missing `=` is a usage error (exit 2, nothing starts). Declared inputs reach prompts only as a `# Workflow Input` block, never as `${input.x}` ([details](usage.md#workflow-inputs---input-keyvalue)). Example: `--input depth=quick`. |
| `--detach` | Start a background supervisor (`agent-workflow supervise <id>`, log in `<run dir>/supervise.log`) and return the run id at once. |
| `--force-new` | Start a new run although an identical launch (same workflow, task, inputs and options) is still active; without it, the guard prints that run (`outcome: "existing"`, exit 0) and, in the foreground, waits for it. Applies to `--detach` too. |
| `--timeout <d>` | Stop waiting after `d` (`30000`, `30s`, `5m`, `1h`). The run continues. Not with `--detach`. |
| `--json` | Print one JSON object `{action, ok, outcome, data}` (for `run`/`resume` without `--detach`, `data.wait` holds the final wait result; `ok` and `outcome` describe that wait, while the rest of `data`, including `status` and `taskSummary`, is the launch snapshot, so read the final state from `data.wait`). |

The task is every remaining positional word. Put `--` before task text that starts with `--`:
`agent-workflow run deep-review -- --literal text`.

### Precedence

Project-local executor/model/effort intent adds the layers described in [Project-local workflow settings](#project-local-workflow-settings); the following describes the shared baseline without that intent.

Executor and permission mode: **run flag > workflow-declared profile > saved user profile >
default** (mode `free`; executor: below). Without `--profile` a launch uses the workflow's saved
preference profile, else its `defaultExecutionProfile` if it declares one, else the default
saved user profile. The precedence holds field by field: a workflow-declared profile
that does not set the executor, the permission mode or `strictCapabilities` takes them from the
default saved user profile. For roles: per stage, each of executor, model and effort
comes from the highest layer that has a value for that stage — run flag > per-workflow preference
roles > workflow-declared profile > saved user profile > default ([usage.md](usage.md#roles-presets-and-mixed-runs)).

**Default executor.** When nothing above selects one, the CLI uses the **first installed and
logged-in** of `pi` → `claude` → `codex`. Each candidate is checked with its adapter's probe (version
and login status commands, no model call): it must be installed and its login not `missing` or
`expired`. A candidate with a *verified* login (auth `ok`) wins over an earlier
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
A run that mixes executors (roles) probes all of them first and names every one it cannot use,
with the stages that use it, in one refusal; nothing starts.
Probe results that are usable are reused within one process for 60 s.

### Capability preview

Every launch prints the short preflight (`Capability check (<executor>@<version>, <n> stages,
permission mode: …): …`, then each warning once with the stages it affects; the full per-stage
preview is in the run record and `--json`). Tools, models and effort the executor cannot provide
are refused before anything starts; model and effort names are rewritten to the executor's form
(see `check` above). A refusal starts nothing: the command prints `Not started: …` and exits 1.

Degradations are always recorded and shown, never confirmed. Refusals still start nothing.

### Foreground, detach, wait

`run` without `--detach` waits in the foreground: it drives the run in bounded 45 s waits and prints
progress to stderr. Ctrl-C stops waiting, not the run; continue with `agent-workflow wait <id>` (or
`resume`/`supervise`). With `--detach` a background supervisor keeps the run going after the CLI
exits; any later process can `status`, `wait` or `stop` it.

`wait` without `--timeout` loops until the run is terminal or blocked. With `--timeout` it returns
when the time is up; a run still running then exits 1 with `data.stillRunning: true`.

### `auto`

`agent-workflow auto "<task>"` builds a local shortlist (at most 24), sends one tool-less
classifier request with your task and bounded candidate descriptions, and starts the top
recommendation without consent or choice prompts. There is no `--yes` launch option.
Classifier failure or no usable recommendation starts nothing; there is no local fallback.

The classifier uses `--executor`, else the saved user profile, else the first installed and
logged-in executor of Pi, Claude, Codex. Model/effort follow explicit options, the profile,
then executor defaults. Launches use normal profiles, duplicate guards, capability refusals
and foreground/detach behavior. Changed named specs return `stale`.

Launch metadata records candidates, recommendation, selection, classifier executor/model,
consent source `command`, and only the task's SHA-256. JSON phases: `classifier-unavailable` (no classifier executor resolved; nothing sent), `not-launched`
(the comparison ran or was cancelled and no workflow started; see `status`/`reason`, e.g. `no-fit`),
`stale` and `launched` (with `data.launch`).

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
that must be `native`), `roles`. Stored in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json` (default
`~/.agent-workflow`, private file). `model`/`effort` are run defaults (stage and agent settings
still win; `--model`/`--effort` override everything).

### Roles and presets

```sh
agent-workflow profile presets                         # codex, codex-high, claude, mixed and their role tables
agent-workflow profile set team --preset mixed --default
agent-workflow profile set team --role verification=codex:gpt-6-luna:high
agent-workflow profile set team --role synthesis=:haiku   # model only (executor from other layers)
agent-workflow profile set team --unset roles.synthesis
```

`--role <role>=<executor>[:<model>[:<effort>]]` (repeatable; empty segments are unset). Roles:
`default`, `planning`, `research-execution`, `synthesis`, `verification`, `final-judgment`, or
`agent:<name>`. Entries merge role by role. `--preset` replaces the saved executor and roles with
the preset's (other fields stay; `--executor`/`--role` given with it still win). An unknown
executor id is refused when the profile is saved (exit 2); role models are checked against the
executor's probe when a run starts.

### Executor default profiles

```sh
agent-workflow profile list                     # also lists the codex, claude and pi default profiles
agent-workflow profile show codex               # built-in, or built-in with your changes
agent-workflow profile set codex --role planning=codex::xhigh
agent-workflow profile delete codex             # back to the built-in one
```

A profile named after an executor holds your changes to that executor's default profile: the
model/effort of its stages where the workflow, the launch and the chosen profile set none. Rules,
the built-in profiles and their fallback: [usage](usage.md#executors). The dashboard's Profiles view
shows and edits them; `doctor` reports what each one resolves to on this machine.

### Per-workflow preferences

```sh
agent-workflow profile workflow set deep-research --profile mixed \
  --role verification=codex:gpt-6-luna:high
agent-workflow profile workflow show deep-research
agent-workflow profile workflow set deep-research --unset roles.verification
agent-workflow profile workflow clear deep-research
agent-workflow profile workflow list
```

A preference belongs to the workflow's `name` (`<workflow>` may be a name or a spec path). Its
`profile` (declared, saved or preset; checked when saved) is used when a launch names none; its
roles apply to every launch of that workflow, from the CLI, MCP hosts and Pi, below the run flags
and above the selected profile. Stored in
`$AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json`.

## `doctor`

`agent-workflow doctor [--fix [--yes]] [--json]` checks the machine without calling a model and writes nothing:

- per executor (`pi`, `claude`, `codex`): installed, CLI version against the version the adapter's
  capabilities were verified with, login state (`ok`/`missing`/`expired`/`unknown`, never a
  credential), and the install or login command when it is not usable;
- the executor a run here uses when no `--executor` or workflow-declared profile selects one, and
  why (saved default profile, host default, or the installed-default order);
- the permission-mode default (`free`, or the default saved profile's mode);
- each executor's default profile (codex, claude, pi, and any other with a saved profile): the
  built-in one, your own CLI settings when its model is not offered here (from the probe's model
  list), your saved changes, or the CLI's own defaults, as `model/effort` per role;
- the Node version (requires `>=22`); `AGENT_WORKFLOW_HOME` and whether it is writable;
- Pi's web tools: whether `pi-web-access` is installed in the user's Pi (`pi list`), shown under
  `pi`; when it is missing, the install command `pi install npm:pi-web-access` (it is not bundled);
  which of `web_search` / `fetch_content` it actually registers (checked without a model request); a tool turned off in its config is a warning, and stages that
  need it are refused before a run;
- warnings: Codex allow rules under `$CODEX_HOME/rules` and a global `$CODEX_HOME/AGENTS.md`
  (counts and paths only, never rule contents), CLI versions that differ from the verified ones, an
  installed Pi without `pi-web-access`;
- run-index entries in this project whose `run.json` is gone or that `prune` would remove, with a
  hint to run `agent-workflow prune`.

Exit 0 when at least one executor is usable, 1 otherwise. `--json` prints `{action: "doctor", ok,
outcome, data}`.

`doctor --fix` then offers the changes it can make, one question each on a terminal (`--yes`
applies them without asking; without a terminal and `--yes` nothing changes): today only a Pi web
tool turned off in pi-web-access's own config (`tools.<tool>.enabled: false` in its
`web-search.json`; that one key becomes `true`, nothing else in the file changes or is printed).
It re-runs the check afterwards.

## `dashboard`

```sh
agent-workflow dashboard [--port <n>] [--readonly] [--auth] [--open] [--detached | --status | --stop | --reset-session] [--project <dir>]
```

Serves all registered projects on **127.0.0.1 only**. Default port **7417**, then 7418–7426, then
an ephemeral port when occupied; output always gives the real URL and explains default-port fallback.
Explicit `--port` / `AGENT_WORKFLOW_DASHBOARD_PORT` (1–65535) is strict. With `AGENT_WORKFLOW_HOME` set,
reuse `<home>/dashboard-port` if free, else use an ephemeral port (never the default range automatically).
Prints `Dashboard: http://127.0.0.1:<port>/?project=<id>` once. **No
sign-in by default:** any browser on this computer opens it directly (loopback bind, `Host`
allowlist, same-origin/CSRF checks on every action; another local user or process could see runs
and press the controls — see [docs/hosts.md#dashboard](hosts.md#dashboard)). `--auth` (or
`AGENT_WORKFLOW_DASHBOARD_AUTH=1`, which auto-started dashboards inherit) turns sign-in on for
shared machines: the printed URL then carries a session token (`/?token=…`) that establishes the
browser session; the session persists across restarts in `<home>/dashboard-session` (`<home>` = `AGENT_WORKFLOW_HOME` or `~/.agent-workflow`)
(mode 0600), and browsers without it see a sign-in page with a one-click button. `--reset-session`
stops a running dashboard first, rotates that token and exits; every browser must sign in again. It
also works when no dashboard is running. `--readonly` adds a read-only badge and rejects all mutations on the server.
`--open` opens the dashboard in the browser (under `--auth` via a one-time sign-in URL: 60-second expiry, single use), including on pipes when explicitly requested; it reuses an existing dashboard. `--project` selects the opened view (an existing directory, default cwd), not the server scope.
The sidebar offers a project switcher and All projects overview; the last view is remembered. A project opens on its Overview; the Workflows, Profiles and Executors views are deep-linkable with `?project=<id>&view=workflows|profiles|executors`. Profiles/preferences and executor health are user-level; workflows, run history and notices use the selected project. Check starts no run and makes no model call. The Overview's clean-up Delete requires the digest of a fresh server preview; a changed preview returns 409 without deletion. See [Dashboard management](hosts.md#what-it-shows). Ctrl-C/SIGTERM stops the dashboard, never the runs; exit 0.
Invalid ports, occupied ports and non-directories exit 2. No `--json` mode.

`--detached` is the background-process mode: prints only `Dashboard listening on 127.0.0.1:<port>`,
never a session token, and exits after 2 hours without SSE clients when no running/blocked run remains in any project. `AGENT_WORKFLOW_DASHBOARD_IDLE_MS` sets the interval in
milliseconds (minimum 60000; invalid values exit 2). Foreground servers never idle out. Discovery is written privately (0600) to
`<home>/dashboard.json` and removed on close, SIGINT or SIGTERM.
`--status` prints pid, port, start time and `auth on|off`, plus `idle exit in <m>m` for detached servers; `--stop` sends authenticated shutdown and waits up to 5 seconds for
cleanup. Both accept `--project` but manage the same user-level server, and exit 1 if none is running.
Discovery uses nonce HMAC identity before any credentials are sent, a private start lock and protocol-version takeover.
Per-project dashboard files are ignored. EPERM/EACCES bind errors do not retry; start from a terminal, hook or MCP server.
Bookmarks to 7417 may break if another program takes the port after idle exit.

`run`, `dynamic` and `auto` print a token-free `Dashboard: http://127.0.0.1:<port>/?project=<project-id>&run=<id>`
on every successful launch, starting a detached loopback server if needed (at most 3 seconds); the
link opens directly. A newly started server sets launch data `dashboard.started: true`; under
`AGENT_WORKFLOW_DASHBOARD_AUTH=1` the data also carries `dashboard.auth: true` and a newly started
server's line adds `· first time in this browser? agent-workflow dashboard --open`. Set `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0` to opt out;
worker roles, read-only contexts and failed launches never auto-start. When disabled or startup
fails, the line is `Dashboard: not running · agent-workflow dashboard --open`; dashboard failure
never fails the run. Auto-start does not open a browser. Opt in to opening after a successful launch:

```sh
agent-workflow run deep-review "Review this change" --open
```

`--open` ensures a dashboard runs (starts it detached when absent, waiting at most 3 seconds),
mints a one-time URL for the run and opens it. `AGENT_WORKFLOW_DASHBOARD_OPEN=1` does the same on
terminals only, but is suppressed when `CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`,
`CURSOR_AGENT` or `AI_AGENT` is set, or the host is Pi/Codex/Claude Code. Suppression reports
"not opened: AI agent environment; pass --open to force". Explicit `--open` always overrides
agent and non-TTY suppression. Browser failures never fail the workflow.

Run/task state, bounded redacted logs, text reports and Stop / Resume / Approve / Reject use the
same host API as the Pi board. Live updates use SSE (default 1 s polls; environment
`AGENT_WORKFLOW_DASHBOARD_POLL_MS` accepts 500–10000, with a 1 s minimum effective interval).
Security and HTTP contract: [dashboard.md](hosts.md#dashboard).

## `statusline`, `watch`, `notify-check`

Progress and completion for hosts that have no session UI of their own. All three only read the project's run
records (the run index names the candidates), never drive a run, take no lease and call no model.

**`statusline`** prints `aw: deep-review 5/13 running 12m · +1 more` for the newest active
top-level run (and how many others), or nothing when idle. States: `running`, `running (no
supervisor)` (no live process holds the run lease: start `agent-workflow supervise <run>`),
`needs action` (blocked; shown for a day after its last update). It reads
the JSON Claude Code pipes on stdin (`workspace.project_dir`, `workspace.current_dir`, `cwd`; at most
150 ms) and shows the runs of those directories, else of the working directory. Any error prints
nothing; the exit code is always 0. The bin loads only this command's module.
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
blockers, and at the end `Finished: <status> — verdict X` plus
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

and nothing otherwise (exit 0). `--run <id>` looks at that run only; with `--follow` it exits once
the run has settled (after printing its line, or at once when that state was already reported).
`--session <id>` reports only the runs that Claude Code session launched and keeps
its monitor stamp fresh: the Claude Code plugin's completion monitor ([host-mcp.md](hosts.md#claude-code-and-codex)). Blocked runs name the
inspect/resume commands; `--host claude-code|codex|generic` words the follow-ups as MCP tool calls.
Receipts: `.agent-workflow/notify-check/` in the [state directory](usage.md#where-run-state-lives) (created by the first check in a project that has runs,
or by the first `wait` that returns a settled state)
holds `baseline.json` (the first check also reports runs that settled in the hour before it) and one
marker per reported state, created exclusively so concurrent checks print a state once. A resumed
run that settles again is reported again. `wait` (CLI, MCP `workflow_wait`, Pi) marks the state it
returned, creating the directory and baseline if needed, so a result the host already showed is
not repeated. At most 5 runs per check (the rest
next time); markers of pruned runs are removed. `--json` prints `{action, ok, outcome, data:
{notifications, deferred}}`. `--follow` checks every 5 s (`--interval` 1-60) and prints new lines as
they appear (a long-lived feed, for example a Claude Code plugin monitor). `--stamp <name>` writes `.agent-workflow/notify-check/<name>.stamp` after a successful
check, with the check's start time as its mtime (a check that deferred runs removes it instead, so
the hook checks again until the backlog is drained); the receipts directory is created only as a real
directory inside the state directory's real `.agent-workflow` (a symlinked one is refused and nothing is written). Hook
setup: [plugins.md](hosts.md#completion-check-hook).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; a completed run (`run`, `wait`, `resume`, `supervise`); a launched detached run |
| 1 | A failed, interrupted or blocked run; a refused launch; a run still running at `--timeout`; a stop not confirmed in 15 s; any other error |
| 2 | Usage error: unknown command or option, missing or invalid argument, misconfigured test-executor hook |

`supervise` exits 1 for blocked runs, like every other command. Its log lines and its structured
result say `blocked`.

**Non-passing domain verdicts exit 1 (CI semantics).** A workflow whose final step reports a
non-passing verdict as `failed` (for example deep-review's `PARTIAL_REVIEW`, statusDetail
`support_declared_failed`) leaves the run `failed`, so `run`/`wait` exit 1 and a CI job fails. The
text still presents it as a finished run, not as a crash: `Workflow finished — verdict: PARTIAL_REVIEW
(report ready)`, the run status on its own line, the result preview and the report path; `--json`
has `data.verdict` and `data.verdictGate: true`. This applies only when the output task declared a
domain verdict *and* wrote its report inside the run directory; any other support failure is shown
as a failure. Passing verdicts (for example `NEEDS_WORK` and
`REVIEW_COMPLETE` in deep-review) complete the run and exit 0.

## Environment

See [environment variables](usage.md#environment-variables) for configuration and defaults.

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
agent-workflow run spec-review "check docs/spec.md" --executor codex --permission-mode safe
agent-workflow run deep-research "state of X" --input depth=quick
id=$(agent-workflow run deep-research "state of X" --detach --json | jq -r .data.runId)
agent-workflow wait "$id" --timeout 30m
agent-workflow inspect "$id" --failures --results
agent-workflow stop "$id" && agent-workflow resume "$id" --detach
agent-workflow prune --keep 20 --yes
```

## `host-command` hook entry

Like `notify-check`, `agent-workflow host-command --host claude-code|codex` is a host-hook entry,
not a user-facing interactive command. The generated plugin shell prefilters the JSON before
starting Node/npx; ordinary prompts do not start this CLI. Input is read only from stdin JSON
(`prompt`, `cwd`, `session_id`, or Claude's slash-command expansion fields), never shell arguments
constructed from prompt text.

Recognized requests print `{"decision":"block","reason":"agent-workflow: …"}`; unrelated or
malformed input prints nothing. The handler always exits 0, contains errors, redacts output and
bounds the reason to 1,200 characters. Launches use the shared host API, detach, preserve profile
defaults and link the host session for completion delivery. `aw auto` records consent source
`command`, compares once and starts the top recommendation without a dialog; classifier failure
starts nothing. Other CLI options are not available through this hook. See
[in-host commands](hosts.md#in-host-aw-commands) for recognition and the six forms.
