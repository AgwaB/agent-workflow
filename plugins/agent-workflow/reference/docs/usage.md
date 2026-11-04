# Using agent-workflow

How to find, write, run, wait for, resume and stop workflows, how executors, profiles and permission
modes are chosen, what a run leaves on disk, and what to do when something goes wrong. Command
reference: [`cli.md`](cli.md) (CLI) and [`pi-host.md`](pi-host.md) (Pi `/aw`). Install and quick
start: [`../README.md`](../README.md).

Examples use the CLI. In Pi, the same actions are `/aw <action> …` (and the `aw_list`, `aw_run`,
`aw_dynamic`, `aw_wait` tools).

## Workflows and specs

A workflow is a JSON spec (`schemaVersion: 1`) whose `artifactGraph.stages` define a graph of model
stages (workers), deterministic support helpers and control containers. The concrete task is not in
the spec: you give it at run time. YAML specs are not supported.

### Where workflows are found

A workflow ref is a path (`./workflows/my.json`, `.agent-workflow/workflows/x/spec.json`) or a name.
A name resolves from the first root that has a match:

1. `<cwd>/workflows/` — repo-tracked, project-shared
2. `<cwd>/.agent-workflow/workflows/` — project-private
3. `$AGENT_WORKFLOW_HOME/workflows/` (default `~/.agent-workflow/workflows/`) — user
4. the package's bundled `workflows/`

Pi's directories (`~/.pi/agent/workflows/`, `<cwd>/.pi/workflows/`) are **not** read (2026-10-30
owner decision). A spec from elsewhere runs when copied into one of the roots above or passed by
path, written with agent-workflow's tool names (`web_search`, `fetch_content`, …).

A higher root shadows lower ones; more than one match in the winning root (for example both
`name.json` and `name/spec.json`) fails as ambiguous. Each root accepts a flat `<name>.json` or a
directory bundle `<name>/spec.json` with its `schemas/` and `helpers/`; use a bundle whenever the
workflow has schemas or helpers. `agent-workflow list` shows what resolves, `agent-workflow show
<name>` prints the resolved spec, and `agent-workflow validate <name-or-path>` compiles it without
running anything.

Agents (`agent:` in a spec) resolve the same way: `<cwd>/.agent-workflow/agents/`,
`$AGENT_WORKFLOW_HOME/agents/`, then the bundled `scout` and `researcher`. Pi's agent directories
(`~/.pi/agent/agents/`, `<cwd>/.pi/agents/`) are not read. To customise `scout` or `researcher`, put
a copy in `$AGENT_WORKFLOW_HOME/agents/` or `.agent-workflow/agents/`. `agent-workflow agents` lists
what resolves and from where.

agent-workflow never reads or writes Pi's directories; its runs and settings live under
`.agent-workflow/` and `$AGENT_WORKFLOW_HOME`. `logs`/`inspect` read only files inside
`.agent-workflow/`; a file outside it shows as `(not read: path is outside the project's artifact
root …)`.

### Bundled workflows

| Workflow | Agent | Use when |
|---|---|---|
| `deep-research` | `researcher` | You need a grounded answer based on source material (uses the executor's web tools). |
| `deep-review` | `scout` | You want code or design reviewed carefully from several angles. |
| `spec-review` | `scout` | You want to check whether requirements, an API spec or a contract are reflected in the implementation and tests. |
| `impact-review` | `scout` | Before merging or releasing: affected areas, risks, missing tests and docs. |

Every bundled stage is read-only. Which executor runs which bundled workflow, and with which
degradations: [`support.md`](support.md). Per-workflow detail: [`../workflows/README.md`](../workflows/README.md).

## Running

```sh
agent-workflow run deep-review "Review the current diff for security, reliability and test coverage."
agent-workflow dynamic "Map the error handling in src/hosts and propose fixes."   # spec-less dynamic run
```

The task is required. `run` prints the capability preview, starts the run (id `workflow_…`) and
waits in the foreground, printing progress to stderr, until it is terminal; then it prints the
result. Ctrl-C stops waiting, not the run. Use `--detach` to hand the run to a background supervisor
(`agent-workflow supervise <id>`, log in `<run dir>/supervise.log`) and return immediately. In Pi,
`/aw run` returns once the run is launched; the Pi session keeps driving it while it lives.

`--json` prints one JSON object (`{action, ok, outcome, data}`) for scripting. An identical active run
started in the last 10 minutes is not started twice (`--force-new` overrides). Options:
[`cli.md` "Launch options"](cli.md#launch-options-run-dynamic).

### Workflow inputs (`--input key=value`)

A spec may declare `input` values with defaults (for example `deep-research`'s
`"input": {"depth": "standard"}`). Override them per run with `--input key=value`, repeatable,
before or after the task (`/aw run|dynamic` take the same option; the `aw_run`/`aw_dynamic` tools take
an `inputs` object; host API callers pass `inputOverrides`):

```sh
agent-workflow run deep-research "State of X" --input depth=quick
```

The value is typed by the declared default: a string default keeps the text as is; a number default
needs a finite number (`--input count=3`); a boolean default needs `true` or `false`; an array, object
or `null` default takes JSON (`--input 'tags=["a","b"]'`). In the `inputs` object a string is
converted the same way and any other value must already have the declared type. Usage errors (exit 2,
nothing starts): a key the spec does not declare (the message lists the declared keys), a value of the
wrong type, a key given twice, an assignment without `key=`. Undeclared inputs are never dropped
silently.

### Letting agent-workflow pick the workflow (`auto`)

```sh
agent-workflow auto "Review the current diff for reliability and test coverage."
```

`auto` (WP32) recommends one of the existing workflows for a task
and starts the one you choose. It never chats instead of running a workflow and never starts
anything on its own:

1. **Local shortlist (no model call).** The dynamic workflow and the discoverable workflows (at most
   24), ranked by the task's words against each spec's `routing` hints (`useWhen`, `outputs`) and
   name. Specs are read as bounded metadata only (no helpers or controllers are loaded).
2. **Consent before any transmission (owner decision Q5).** Comparing the candidates takes one
   classifier request that sends your task and the bounded candidate descriptions to a model,
   without tools. It runs on the run's **default executor**, chosen by the same rule as a run's
   executor: `--executor`, else the saved user profile (`--profile <name>` or the default one), else
   the host's own CLI (Claude Code → `claude`, Codex → `codex`, Pi → `pi`; the terminal CLI and a
   generic MCP client → the first installed and logged-in of `pi`, `claude`, `codex`), with
   `--model`/`--effort` or the profile's model, else the host's current model (Pi) or the
   executor's default. Before the request you see the task, the candidate names and the executor
   and model, and are asked: a `y/N` question in a terminal, `ctx.ui.confirm` in Pi, an MCP
   elicitation dialog in Claude Code and Codex. Only an explicit yes sends it; the CLI's `--yes` is
   that yes given in advance. **Where the question cannot be asked** — no terminal and no `--yes`,
   Pi print/JSON mode, an MCP client without elicitation — **no request is sent**: you get the local
   shortlist and the command (or tool call) that starts each candidate directly.
3. **Choice.** The ranked candidates, the recommendation first with the classifier's confidence and
   reasons, then your pick: a numbered list in a terminal (Enter takes the recommendation), Pi's
   select plus a final confirmation, an MCP form with one choice field. Cancelling or declining
   starts nothing.
4. **Launch.** The chosen workflow starts through the normal launch path (duplicate guard,
   profiles, capability preview, approvals), exactly as `run`/`dynamic` would. A named workflow that
   changed after the comparison is refused; run `auto` again.

The run records the selection in its launch metadata (`agent-workflow-run-launch-v2`): the offered
candidates (opaque id, kind, name), the recommendation, your choice, the classifier executor and
model and how you consented (`prompt`, `flag` or `elicitation`); the task only as a SHA-256, never
the classifier's prose. `show <run>` prints an `Auto selection:` line. The classifier request's own
record lives under `.agent-workflow/workflows/auto-router-runs/`. Commands: [cli.md](cli.md#auto-wp32),
[pi-host.md](pi-host.md#aw-auto-wp32-owner-decision-q5), [host-mcp.md](host-mcp.md#auto-workflow-selection-wp32-owner-decision-q5).

The `execution-router` skill stays recommendation-only: it may suggest `auto`, but never runs it.

## Waiting, inspecting, resuming, stopping

```sh
agent-workflow status                         # top-level runs, newest first
agent-workflow status <run>                   # one run and its tasks
agent-workflow wait <run> --timeout 30m       # drive and wait (exit 1 if still running at the timeout)
agent-workflow inspect <run> --failures --results
agent-workflow show <run> --raw               # the run record
agent-workflow resume <run> [--detach]        # reset failed/interrupted/resumable blocked tasks, continue
agent-workflow approve <run> [--reject]       # answer a dynamic-controller approval the run waits on
agent-workflow stop <run>                     # durable stop intent; workers are cancelled
agent-workflow watch [<run>]                  # live terminal view (read-only), e.g. next to Codex
agent-workflow statusline                     # one-line status, e.g. Claude Code's statusLine.command
agent-workflow notify-check                   # runs that finished since the last check (host hooks)
agent-workflow prune --keep 20 --yes          # delete old terminal runs (dry run without --yes)
```

A run argument accepts the id or an unambiguous prefix. Any process can wait for, inspect or stop a
run, including one started elsewhere with `--detach`. `wait` drives scheduling in bounded steps
(45 s per call over MCP and in the host API; the CLI loops; the Pi tools and `/aw wait` wait until
the run settles or their timeout passes, up to 4 h).

Run states: `running`, `completed`, `failed`, `interrupted` (stopped, or a worker was revoked) and
`blocked` (needs a person: an unprovable executor state, an exhausted required-read or output repair,
a dynamic approval). `resume` resets failed, interrupted and resumable blocked tasks and keeps
completed task artifacts. A run executes the copied `bundle/` in its run directory, so a newer
package version does not change a running workflow's schemas or helpers; start a fresh run to pick
up changed workflow code. Loop workflows cannot be resumed; start a fresh run. Right after `stop`,
`resume` waits up to 10 s for the stopped supervisor to let go of the run; if it has not by then,
`resume` changes nothing and says to try again in a few seconds.

### Dynamic approval

A dynamic stage whose controller declares `dynamic.permissions.approval: "ask"` runs its trusted
helper code only after the user approved it. The question is "Run dynamic workflow controller?" with
the scope: the run and controller, the bundle spec, an approval digest, the task preview and digest,
the controller helper, whether generated agents may request dynamic roles/tools, the budget and the
declared helpers and nested workflows. Yes runs the controller (its generated agents do not ask
again); **no rejects it for this run**: the task stays blocked as `dynamic_approval_rejected` and is
never asked again (start a new run to approve later). An unanswered question (5 minutes, or no
answer) leaves the run blocked as `dynamic_approval_timeout`, still open.

Who asks:

- **Pi with a dialog UI** asks through Pi's confirm dialog while the session drives the run (attached
  `/aw run|dynamic`, `aw_run`/`aw_dynamic` with `awaitTerminal`, `/aw wait`, `aw_wait`, `/aw resume`).
- **The CLI on a terminal** asks `y/n` for foreground `run`, `dynamic`, `wait` and `resume` (`y`
  approves, `n` rejects, an empty answer leaves it open).
- **Nothing asks** in Pi print/JSON mode, without a terminal, for `--detach` runs and resumes (their
  supervisor has no UI) and over MCP (the server can ask only inside a tool call). The run blocks as
  `dynamic_ui_unavailable`; `status`/`wait` show the open approval (question and request id) and the
  approve command.

Answer an open approval later from any host: `agent-workflow approve <run>` (asks `y/n` on a
terminal; `--yes` without one, `--reject` to reject, `--request <id>` when several are open), Pi
`/aw approve <run>` (confirm dialog), or the MCP tool `workflow_approve {runId, requestId, decision}`
(asks the user through an MCP dialog; refused on clients without dialogs). An approval resumes the
run; completed tasks are not relaunched. A run that also has failed, interrupted or
undecided-executor tasks is not resumed automatically: the decision is recorded and `resume` is
named. Every decision is recorded on the run (`dynamic/events.jsonl`, `approval.resolved` with
`decidedBy: {host, via}`, for example `{"host": "cli", "via": "approve"}`), never with secrets. A
nested workflow that waits for its own approval is approved with its own run id, then the parent run
is resumed.

`stop` records a durable stop intent. A worker that had not started yet never starts (its launch is
revoked); a running worker is cancelled. If another supervisor owns the run, the stop is applied by
it: `stop` waits up to 15 s for that confirmation, and a run the supervisor has already stopped counts
as confirmed (exit 0). If no confirmation arrives in time, `stop` reports the stop as pending and
exits 1; the intent stays durable and is applied when the supervisor next runs.

## Executors

| Executor | CLI | Notes |
|---|---|---|
| `pi` | `pi --mode json` | Pi 1.1+. deep-research needs the `pi-web-access` extension (`pi install npm:pi-web-access`; `agent-workflow doctor` checks it). |
| `codex` | `codex app-server` | codex-cli 0.159+. Coarse tool allowlist (a sandbox mode). |
| `claude` | `claude -p` (stream-json) | Claude Code 2.1+. |

Each executor uses its own CLI login (agent-workflow never handles credentials). Choose with
`--executor <id>`, a profile, or a saved default profile. Precedence for both the executor and the
permission mode: **run flag > workflow-declared profile > saved user profile > default** (mode
`free`). The run records which layer chose (`run.executor.source`, `run.permissionMode.source`).

**Default executor.** Without a choice, a run uses the host's own CLI (`host-default`): `pi` in the
Pi host, `claude` in Claude Code, `codex` in Codex. The terminal CLI uses the first installed and
logged-in of `pi` → `claude` → `codex` (`installed-default`; since WP19 a verified login wins over
an earlier `unknown` one, and an `unknown` login is used only when none is verified, with a note in
the launch text and in `doctor`; recorded in `run.executor.candidates`). Pi counts as logged in
when `pi --list-models` lists at least one model (Pi lists only models whose provider has auth). `run.executor.host` names the host. Nested runs keep their
parent's executor. If nothing is usable, nothing starts and the message lists each CLI's state and
the command to fix it. `agent-workflow doctor` shows the same check without starting a run.

| Executor | Install | Log in |
|---|---|---|
| `pi` | `npm i -g @earendil-works/pi-coding-agent` | run `pi`, then `/login` |
| `claude` | `npm i -g @anthropic-ai/claude-code` | `claude auth login` |
| `codex` | `npm i -g @openai/codex` | `codex login` |

### Profiles

Two layers:

1. **Workflow-declared execution profiles.** A spec may declare `executionProfiles` (stage overrides
   of `model`, `thinking`/effort and `foreachBatch`; plus an executor and permission mode per profile
   via `executionProfileExecutors` / `executionProfilePermissionModes`) and a
   `defaultExecutionProfile`. Select one with `--profile <name>`. A declared profile sits on top of
   your default saved user profile, field by field: whatever the declared profile does not set
   (executor, permission mode, `strictCapabilities`) comes from the default saved profile, and that
   profile's `model`/`effort` stay run defaults when it names no executor or the run's executor.
2. **Saved user profiles.** `agent-workflow profile set <name> --executor codex --effort high
   --permission-mode safe [--strict-capabilities readOnly,contextIsolation] [--default]`. Fields:
   `executor`, `model`, `effort`, `permissionMode`, `strictCapabilities` (capabilities that must be
   `native`, else the run is refused), `roles` (WP31, below). Stored in
   `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json`.
   `--profile <name>` picks a declared profile first, then a saved one, then a built-in preset;
   without `--profile` a launch uses the workflow's saved preference profile, else the declared
   default profile (over the default saved profile, as above), else the default saved profile. A
   saved profile named with `--profile` is used on its own.

Example: the default saved profile sets `--executor codex --permission-mode safe`; a workflow's
declared profile `high` sets only stage efforts. `--profile high` runs on `codex` in `safe` mode
with `high`'s stage efforts; `--profile high --executor claude` runs on `claude` (run flag), still
`safe`.

`--model` and `--effort` override every stage and win over both layers. `model`/`effort` from a
saved profile are run defaults (stage and agent settings still win).

`deep-research` declares `low`, `medium` (default) and `high` profiles: `low` and `medium` batch
compatible `verify-claims` items in pairs; `high` spends more reasoning and keeps singleton
verification. `low` is an explicit speed/cost-for-quality trade-off. No declared profile pins a
model. Evidence gates are the same in every profile.

Every model-backed stage in a bundled workflow declares a semantic `profileRole` (`planning`,
`research-execution`, `synthesis`, `verification`, `final-judgment`).

### Roles, presets and mixed runs

**Roles (WP31, owner decision B2).** A saved user profile (`roles`), a workflow-declared profile
(`executionProfileRoles`) and a per-workflow preference can map *roles* to
`{executor?, model?, effort?}`. A role addresses model-backed stages without naming stage ids, so one
profile fits every workflow:

| Role key | Matches |
|---|---|
| `agent:<name>` | stages whose agent is `<name>` (`each.agent` for foreach, else `agent`, else `defaults.agent`) |
| `planning`, `research-execution`, `synthesis`, `verification`, `final-judgment` | stages with that `profileRole` |
| `default` | every stage no other key matches |

Inside one profile the most specific key wins (`agent:` > profileRole > `default`). A profile's flat
`executor` counts for every stage it has no role entry for; its `default` role's executor is also the
run's executor (`run.executor`) when nothing higher names one.

```json
{
  "executionProfiles": { "mixed": {} },
  "executionProfileRoles": {
    "mixed": {
      "default": { "executor": "claude", "model": "sonnet", "effort": "medium" },
      "research-execution": { "executor": "codex", "model": "gpt-5.6-luna" },
      "verification": { "executor": "claude", "effort": "high" }
    }
  }
}
```

```sh
agent-workflow profile set team --preset mixed --default
agent-workflow profile set team --role verification=codex:gpt-5.6-luna:high
agent-workflow profile workflow set deep-research --profile team --role synthesis=::high
```

**Precedence, per stage and per field** (executor, model, effort each on its own; WP37 extended to
roles):

| Layer (highest first) | Executor | Model / effort |
|---|---|---|
| Run flags `--executor`, `--model`, `--effort` | every stage | every stage |
| Per-workflow preference `roles` | its matching role entry | its matching role entry |
| Workflow-declared profile | role entry, else `executionProfileExecutors` | its stage overrides, else role entry |
| Saved user profile (or preset) | role entry, else `executor` | role entry; flat `model`/`effort` stay run defaults |
| Default | host default / installed default | stage, agent, host defaults, executor's own |

The highest layer that has a value for a stage wins that field. A role entry's model and effort
apply only when the stage runs on that entry's executor (or the entry names none): a model id belongs
to its executor, so `--executor codex` with a profile whose `verification` entry is
`claude:sonnet` runs verification on codex with codex's model. Dynamic decision-loop slots
(`$planner`, `$verifier`, …) and the workers a dynamic stage generates run on the dynamic stage's
executor (a note says so when a role asked for another one). Nested workflow runs keep their
parent's executor.

**Validation.** An unknown executor id (flat or in a role) is refused when a profile or preference
is saved and when a run starts. A role model is checked before launch against the model list the
executor's probe reports (no model call: Pi `pi --list-models`, Codex `codex debug models`, Claude
Code's model aliases `default`/`haiku`/`sonnet`/`opus`). Each probe says whether its list is
exhaustive (`modelListComplete`). None of the built-in ones is: Pi's `--model` also resolves
patterns (`sonnet`, `provider/…`), Claude's list holds aliases only (full ids such as
`claude-opus-4-8` are valid) and Codex's holds the visible catalog only, so a model missing from
them is noted (`model "x" for <stages> is not verified by probe: …`) and the
run proceeds; when a probe lists no models at all, the preview notes `model "x" for <stages> is
not verified`.

**Presets** (`agent-workflow profile presets`; `--profile <preset>` when no declared or saved
profile has that name, or `profile set <name> --preset <preset>`):

| Preset | Run executor | Roles |
|---|---|---|
| `codex` | codex | every role codex `gpt-5.6-luna` |
| `claude` | claude | every role claude `sonnet` |
| `pi` | pi | every role pi, Pi's configured default model |
| `mixed` | claude | planning, synthesis, verification, final-judgment: claude `sonnet`; research/implementation (`research-execution`): codex `gpt-5.6-luna` |

Efforts in every preset: `high` for planning, verification and final judgment, `medium` otherwise.
In `mixed`, verification runs on a different model family from the codex workers whose findings it
checks (owner decision E4). Preset models are names the CLIs accept today; if your account lacks
one, override the role (`--role research-execution=codex:<model>`) or use `--model`.

**Per-workflow preferences** (`agent-workflow profile workflow set <workflow> [--profile <name>]
[--role …]`, MCP `workflow_profile` `workflow-set`, Pi `/aw profile workflow set …`). Keyed by the
workflow's `name`, stored in `$AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json`, and
applied by every launch of that workflow from the CLI, MCP hosts and Pi: its `profile` when the
launch names none (before the declared default), its roles as the layer above the selected profile.

**Mixed runs (owner decision Q4).** When stages resolve to more than one executor, one run mixes
them. Each executor is probed once; every stage is negotiated against *its* executor (readOnly,
artifact MCP, web tools, isolation, permission mode) and a stage whose executor cannot satisfy it is
refused before launch, naming the stage and executor (`stage "search.main" on codex: webTools —
CAPABILITY_MISSING:webTools`), unless the usual degrade/opt-in rules allow it. The preview's first
line names every executor (`Capability check (mixed: claude@0.1.0 ×3 + codex@0.1.0 ×2, …)`) and each
stage line names its executor; the launch text adds a `Role profile` table (stage → executor, model,
effort, role, source). The run records `run.roleExecution` (per-stage assignment, every executor's
descriptor) and each task's `runtime.executor`; resume, reconcile, owned-session release and prune
use each task's own executor. `status`, `inspect` and `show --raw` show the executor per task.
Host model defaults (Pi's current model) and the Pi model registry apply only to stages on their
executor.

## Permission modes

**The default is `free`.** Workers start without approval prompts and without sandbox restrictions,
except on stages the workflow declares `readOnly`, which stay read-only in both modes. Workers still
do not load your personal settings, instructions, hooks or skills unless a stage opts in (`inherit`).
Approval requests that still arrive are allowed by engine policy and audited
(`engine-policy:free`); mutating requests on a readOnly stage are denied.

Choose **`safe`** for the conservative behavior: no bypass flags, policy-based approvals that fail
closed, a worktree for every write-capable stage, and capability warnings that need confirmation in
an interactive host. Select it with `--permission-mode safe`, a declared profile's mode, or
`permissionMode` on a saved profile. An invalid value fails before anything starts. Nested runs follow
their parent's mode.

| Executor | `free` (stage not readOnly) | `safe` / readOnly stage |
|---|---|---|
| Claude | `--permission-mode bypassPermissions` | `--permission-mode default` (+ disallowed write tools for readOnly) |
| Codex | sandbox `danger-full-access`, approvals `never` | `workspace-write` / `read-only` sandbox, approvals `on-request` |
| Pi | every requested tool (Pi has no approvals or sandbox) | readOnly drops mutating tools |

Details: [`permissions.md`](permissions.md).

## Preflight: capability, tools, models and effort

Before a run starts, the engine probes the executor (installed, CLI version, login, model list; no
model call) and checks every stage against the executor that would run it (B4). Anything that would
fail a stage mid-run stops the launch instead, with the reason and what to do (`Not started: …`,
exit 1, no run record):

- **tools** the executor has no mapping for (a name it does not know), or that its
  probe reports unavailable on this machine (for example `fetch_content` turned off in pi-web-access's
  own config): the stage would only return a weaker result, so the run is refused with the reason
  and the fix; `agent-workflow doctor --fix` applies the fixable case after asking;
- **models**: a name is the executor's — the engine rewrites it to that tool's form
  (`openai-codex/gpt-6.1-sol` → `gpt-6.1-sol` on codex; `anthropic/claude-opus-5-5` →
  `claude-opus-5-5` on claude; a bare `gpt-6.1-sol` → `openai-codex/gpt-6.1-sol` on pi, found in
  Pi's model list; `google/gemini-3.8-flash` → `gemini-3.8-flash` on antigravity) and refuses a model
  the tool cannot run (a Claude model on codex, an OpenAI model on claude, anything but a Gemini model
  on antigravity, a malformed name such as `openai-codex/`). On pi a name that is not an exact Pi id
  (`opus`) is passed on with a notice: Pi resolves such patterns itself. It never moves a stage to another executor by
  itself: use `--executor`, `--profile mixed` or a role for that. A name the probe list cannot
  confirm (Codex and Claude lists are not exhaustive) gets a one-line notice;
- **effort** levels: a level the tool lacks becomes its nearest level with a notice (`minimal` →
  `low` on codex/claude, `ultra` → `max` on claude/pi); an unknown level is refused;
- **capabilities** (below).

The same check runs alone with `agent-workflow check <workflow> [--executor …] [--model …] …`
(no run). The launch prints it short: the summary line, then each warning once with the stages it
affects:

```text
Capability check (codex@0.1.0, 12 stages, permission mode: free): accepted with 48 degradations
  ⚠ readOnly — 152 allow rules in ~/.codex/rules let matching commands run without approval (all 12 stages)
  ⚠ toolAllowlist.fine — free permission mode: precise tool allowlist unavailable … (all 12 stages)
```

The full per-stage preview stays in `run.capabilityNegotiation.preview` (and `--json`).

Each need is `native`, `emulated`, **degraded** (runs, recorded in `run.capabilityNegotiation`) or
**refused** (nothing starts: `Not started: …`, exit 1, no run record). Typical entries:

| Entry | Meaning | What you can do |
|---|---|---|
| `CAPABILITY_MISSING:toolAllowlist.fine` | The executor cannot enforce the stage's precise `tools` list (Codex). | Accepted in `free`. In `safe`: the stage runs readOnly when the spec sets `allowReadOnlyDowngrade` (`forcedReadOnly`), else refused. |
| `CAPABILITY_WARNING:readOnly` / `:contextIsolation` | Something on this machine weakens the capability (Codex allow rules in `~/.codex/rules`, a global `~/.codex/AGENTS.md`). | Recorded in `free`. In `safe` an interactive host asks; `strictCapabilities` refuses. Remove the rules/file for a clean result. |
| `webTools.safetyPolicy: unknown` | The stage uses the CLI's own web tools; URL, private-network and redaction controls are the CLI's, not the engine's. | Always recorded, never silent. |
| `CAPABILITY_UNVERIFIED:<cap>` | Nobody has verified the capability for this executor; refused by default. | `--allow-unverified <cap>` if you accept it. |
| `CAPABILITY_MISSING:<cap>` (refused) | The executor lacks something the stage requires (for example `mcpInjection` for required reads, `webTools`). | Choose another executor (or install the missing extension). |
| `CAPABILITY_STRICT:<cap>` | Your profile's `strictCapabilities` requires `native`. | Use another profile or executor. |

In a terminal (stdin and stdout are TTYs) a degradation that needs confirmation asks `Proceed with
these capability degradations? [y/N]`. With `--yes`, or without a terminal, degradations are
recorded (`confirmation: "non-interactive"`) and the run proceeds. In Pi with a UI the host asks
through a dialog.

## Stage model

| Node | Behavior |
|---|---|
| `type: "single"` | One worker prompt; receives the runtime task. |
| `type: "foreach"` | Reads an array from an upstream `control.json` path (`from: {source, path}`) and starts one worker per item (`each.prompt` with `${item}`). |
| `type: "reduce"` | Fan-in over upstream artifacts (`from: [...]`), optional `sourceProjection` inline snippets. |
| `type: "loop"` | Repeats fixed child stages until a deterministic `until`, `maxRounds` or no progress. |
| `type: "dag"` | Container: lowers child stages to namespaced tasks and exposes an `outputFrom` child downstream. |
| `type: "dynamic"` | Trusted bundle-local controller code adds workflow tasks at run time. |
| `support: { uses }` | Runs a bundle-local `.mjs` helper over upstream `control.json` values, in process, no worker. |

Use `foreach.from` for data-driven fan-out, `reduce.from` for fan-in, support `from` for helper
inputs, and `dynamic` only when the work cannot be known before the run. A later plain `single` does
not see earlier output unless it declares `from`. Set `injectRuntimeTask: true` on a `foreach` or
`reduce` to give its workers the runtime task too.

### DAG authoring

Top-level `artifactGraph.stages` is a DAG.

- `from` is a data + order edge: the stage gets a manifest of the source's artifacts and reads them
  through `workflow_artifact`; deterministic decisions read the source's `control.json`.
- `after` is order-only (no artifact access); `after: []` marks an explicit parallel root.
- `sourcePolicy` (`require-success`, `partial`) decides whether a failed source blocks the stage;
  `inputPolicy.terminalBarrier: "all-sources"` waits for every source to be terminal first.
- `inputPolicy.invalidateOnDependencyResume: true` discards a static consumer's stale artifacts when a
  dependency is resumed; `inputPolicy.maxCompiledPromptChars` caps the compiled prompt.
- `foreach` may set `each.itemIdentityPath` (stable child ids, for example `$.id`) and
  `each.itemPayloadPath`.
- A `dag` container's children reference only siblings; `outputFrom` names the child that represents
  the container downstream (`from: "analysis"` reads `analysis.<outputFrom>`). Validation rejects
  unknown references, cycles, duplicate ids, unsafe schema paths and unknown fields.

```json
{
  "schemaVersion": 1,
  "defaults": { "agent": "scout", "readOnly": true, "tools": ["read", "grep", "find", "ls"] },
  "artifactGraph": {
    "stages": [
      { "id": "plan", "type": "single", "profileRole": "planning",
        "prompt": "Put machine-readable JSON in <control> with an items array." },
      { "id": "scan", "type": "foreach", "profileRole": "research-execution",
        "from": { "source": "plan", "path": "$.items" },
        "each": { "itemIdentityPath": "$.id", "prompt": "Scan this item: ${item}" } },
      { "id": "merge", "type": "reduce", "profileRole": "synthesis", "from": ["scan"],
        "sourceProjection": { "include": ["$.digest"] }, "prompt": "Merge the scan outputs." },
      { "id": "report", "type": "reduce", "profileRole": "final-judgment", "from": "merge",
        "inputPolicy": {
          "requiredReads": [{ "source": "merge", "artifact": "control", "path": "$", "maxChars": 4000, "count": 1 }],
          "enforcement": "fail"
        },
        "prompt": "Write the final report from the merge control artifact." }
    ]
  }
}
```

### Output contracts

Every worker stage answers in the section protocol:

```text
<control>{"schema":"stage-control-v1","digest":"..."}</control>
<analysis>Reasoning and evidence.</analysis>
<refs>[]</refs>
```

Exactly one of each, in this order, no prose outside. The engine writes `control.json`,
`analysis.md`, `refs.json` and `raw.md`, and retries invalid output within the stage's repair budget
(`AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES`, default 2). `control.digest` is required and bounded by
`output.maxDigestChars`. `output.analysis.required: false` / `output.refs.required: false` make those
sections optional. When quoting a whole protocol response inside analysis, write `&lt;control>`.

`output.controlSchema: "./schemas/x.schema.json"` (relative to the spec) validates `control.json`
with a JSON Schema subset: `type`, `required`, `properties`, `items`, `enum`, `const`,
length/item/number bounds, `additionalProperties`, simple `allOf`/`anyOf`/`oneOf`. `$ref`, `$defs`,
`definitions` and `pattern` are rejected at load time. String lengths count code points. When the
schema pins `control.schema` with `const`/`enum`, prompts must emit exactly that value.

**Partial output for streaming foreach.** A producer may declare `output.partial.paths: ["$.items"]`
and publish stable items early in standalone `<partial-control>{"schema":"workflow-partial-output-v1",
"path":"$.items","items":[...]}</partial-control>` blocks; a `foreach` opts in with
`from: {source, path, streaming: {enabled: true, minChunk: 2}}`. Published items need a string `id`
and must not change in the final control. Downstream reducers still wait for every item.

### Support helpers

```json
{ "id": "audit", "from": "verify", "sourcePolicy": "partial",
  "support": { "uses": "./helpers/claim-evidence-gate.mjs", "options": { "strict": true } } }
```

```js
export default async function helper({ sources, options, context }) {
  // sources: upstream control.json values keyed by source names (see below); context: specPath,
  // runId, taskId, stageId, cwd, signal, sourceStatuses, evidence (experimental engine-side web
  // quote check, below)
  return { schema: "my-merge-control-v1", digest: "merged 3 reviews", items: [/* … */] };
}
```

**Source names.** A `single`/`reduce` stage's control is keyed by its stage id. Foreach items are
keyed by name too, but **the first item takes the bare stage id** and the others
`<stage>.<item id>` (`analyze`, `analyze.durable-runtime`, …). Do not collect a stage's items by key
prefix: use `context.sourceStatuses`, one row per source with `source` (the key in `sources`),
`stageId`, `specId` (`<stage>.<item id>` for every item), `taskId`, `status` and, for foreach
items, `itemIdentity` and `placeholderSpecId`:

```js
const items = context.sourceStatuses
  .filter((row) => row.stageId === "analyze" && row.itemIdentity !== undefined)
  .map((row) => ({ id: row.itemIdentity, status: row.status, control: sources[row.source] }));
```

(2026-11-04: a workflow authored with the workflow-guide skill filtered `analyze.` keys and lost its
first subsystem.)

**Report.** A final support stage publishes the run's report as its `markdown` (or `analysis`)
field — hosts and the dashboard open that `analysis.md` as the report — or by writing
`final-report.md` into its own task directory and returning `sidecarPath: "final-report.md"` (the
bundled renders do both). `completionSummaryMarkdown` is the short result hosts print first.

In an artifact-graph workflow the returned object is the support node's `control.json` (a missing
`schema` becomes `stage-control-v1`, a missing `digest` a fixed text) and is validated against the
stage's `controlSchema` like a worker's control. A string `analysis` (or `markdown`) field becomes
`analysis.md`, an array `refs` field `refs.json`. A control with `status: "failed"` or `"blocked"`,
or `gates.passed: false`, ends the task as declared (`support_declared_failed` /
`support_declared_blocked`); the bundled final renders use this for verdicts such as
`PARTIAL_REVIEW`. Async helpers get `context.signal` for cooperative stop. Helper refs must start with `./`, end in `.mjs` and stay
inside the bundle. That is path containment, not a sandbox: helpers run in the engine process with
its permissions and are not limited by tool allowlists, so bundle only trusted code. A read-only
workflow's helpers must not cause undeclared side effects.

**Web quote check.** On by default; `AGENT_WORKFLOW_EVIDENCE_REFETCH=0` in the environment of the
process that launches a run turns it off for that run (the decision is recorded on the run, so a
later supervisor or resume follows it; runs started before the check existed have it off). When on,
`context.evidence.refetchEnabled` is true and
`context.evidence.checkWebQuotes([{ key, url, quote, taskId }])` looks for each quote in the page text
the task's own web tools returned for that URL, otherwise fetches the cited page itself (no model
call). It reaches public addresses only, caps pages at 5 MB (PDF 10 MB, through
the system `pdftotext` when installed), caches pages by content hash in
`.agent-workflow/evidence-cache/` (1 GiB, 24 h), and returns per quote `verified-captured`,
`verified-refetched` or `unverified` with a reason. deep-research uses it in its `check-web-quotes` stage: the final report's
audit summary gets a "Quote check" line and `audit.md` lists every quote that could not be checked.
Verdicts are not changed.

### Loop behavior

A `loop` stage repeats at least two child stages (`single`/`reduce`, run in order) per round, with
runtime ids such as `fix-loop.r01.check`. Children must not declare `from`/`after`: each child
sources the earlier children of its round, and the first child of a later round gets the previous
round plus a `# Loop Carry-Forward Context` block. Required: `id`, `maxRounds` (a positive integer,
or `null` for no cap), `until` (must reference the final child: `{"stage": "<final-child>",
"path": "$.field", "equals": true}`, predicates `equals`, `notEquals`, `lengthEquals`, `exists`,
combinators `all`/`any`). A loop ends `completed` (until true), `exhausted` (positive `maxRounds`
used up), `stopped_no_progress` (the `progressPath` metric, default `$.blockingFailures`, did not
decrease; omitted `progressPath` on an unlimited loop disables this) or `failed`. An optional
`onExhausted` stage runs once on exhaustion or no progress. There is no auto-merge of worktree output
(see "Worktrees" under Retention).

### Roles

Top-level `roles` declare reusable context injected as a `# Role Context` block: `fromAgent`
(extract safe sections of an agent's markdown), `includeSections` / `excludeSections`, `prompt`
(literal text) and `maxChars` (default 12000). A stage selects roles with `role`; `foreach` uses
`each.role`. `agent-workflow roles <workflow>` shows the compiled text. `profileRole` is a separate
classification for execution profiles, not a context role.

### Tool allowlists

`tools` (agent frontmatter < `defaults.tools` < stage `tools`; the most specific list wins) names
tools with Pi names: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `web_search`,
`fetch_content`, `workflow_artifact`. Each executor maps them (Claude: `Read`, `Grep`, `Glob`,
`WebSearch`, `WebFetch`; Codex: its shell and sandbox, hosted `web_search`; Pi: the same names) and
the engine tells the worker the mapping in its system prompt. The agent's frontmatter `tools` are the
ceiling: a spec cannot grant a tool the agent did not declare. Object entries (`{name, extensions,
classification, optional, fallbackTools}`) describe custom tools; unclassified custom tools are
blocked. `readOnly: true` is a safety declaration (read-only tools, read-only sandbox where the
executor has one), not filesystem isolation.

**Write-capable stages.** A stage that is not `readOnly` and keeps a mutating tool (`edit`, `write`,
`bash`; the agent's frontmatter must declare it) can change files. Where it writes is the stage's (or
`defaults`') `worktreePolicy`: `"auto"` (default) and `"on"` give each write-capable task its own
managed git worktree (`.agent-workflow/workflows/<run>/worktrees/<task>`, branch
`agent-workflow/<run>-<task>`); `"off"` writes in the shared checkout in `free` mode only — `safe`
still uses a worktree unless the run sets `allowSharedCheckoutWrites` (docs/permissions.md). There is
no auto-merge: the user reviews and merges the branch (see "Worktrees" under Retention). A worktree
needs a git repository: outside one a task that needs a worktree does not start (`managed worktree
required … is not inside a git repository`); only `"off"` in `free` mode writes in the live
directory there. A later stage does not see
a worktree's changes through the project files, so put the check where the change is: let the
writing task run the build or tests in its worktree and report the result in its control, or give a
separate verification stage that worktree's path. Workers never commit.
(2026-11-04: a workflow authored with the workflow-guide skill could not find these keys in this
guide and left its write stage without a policy or a check.)

### Local review evidence

`spec-review` verifiers cite typed local evidence rows `{file, lineStart, lineEnd, quote,
relevance?}` (at most 64 per array). KEEP/WEAKEN need verified evidence, DROP needs verified
counter-evidence, positive requirement coverage needs typed bytes; every typed citation must pass.
Plain strings (file:line text, URLs, opaque web refs) are display-only and never count as proof.

The `spec-review` bundle and the `support-partition` scaffold carry equivalent
`local-evidence-reader.mjs` readers. They check **current** local UTF-8 bytes under the canonical
workflow cwd and reject escapes, symlinked descendants, non-regular files, files over 4 MiB, invalid
UTF-8, cancellation and observed file or ancestry mutation; reads are bounded descriptor reads
(64 KiB chunks, at most 4 MiB + 1 byte). Ranges are inclusive and 1-based, split on LF, keep CR, BOM,
diff markers and whitespace, and never clamp past the end; a terminal LF creates an empty last line.
A quote must be an exact substring inside the range. spec-review requires both endpoints; only the
scaffold allows an omitted range as explicit file-wide evidence. This proves byte presence now, not
semantic entailment, that a worker read the file, or isolation from a racing same-user process.

The partition keeps per-row `evidenceGate` results and file SHA-256 values; ungrounded dispositions
stay `needsHuman`. Requirement reconciliation needs exactly one explicit `requirementId`/`status` row
per unique extracted requirement id (`covered`, `gap`, `partial`, `unclear`, `needsHuman`); `CONFORMS`
needs every requirement covered by typed bytes, and anything unresolved stays `INCONCLUSIVE`.
Requirements the candidate stage leaves `unclear` (at most 8) get one more look in
`recheck-requirements`: a recheck that finds the behavior with verified citations makes the row
`covered`; any other answer stays `unclear` and is shown beside it in the coverage table. The
renderer rereads the source chain and rechecks citations before `passed`. `deep-review` applies the
same idea to reviewer `sourceCoverage` (`read`, `ocr-extracted`, `metadata-only`, `unreadable`):
unverifiable required sources force `PARTIAL_REVIEW`.

## Artifacts and required reads

Workers read upstream artifacts through one MCP tool, `workflow_artifact` (`list`, or `read` with
`source`, `artifact` = `control`, `analysis`, `refs`, `raw`, `prompt`, `system-prompt`, `stderr`,
`result`, optional `path` / `maxItems` / `maxChars` projections, or `offset` for paging). Prompts
name it `workflow_artifact`; the engine renders the name each executor shows its model
(`mcp__workflow_artifact__workflow_artifact` on all three stage-1 CLIs). Every read appends a row to
the task's `read-ledger.jsonl`. Details: [`mcp.md`](mcp.md).

`inputPolicy.requiredReads` (with `enforcement: "fail"`) makes a stage prove it read named
artifacts before its output is accepted. A string entry (`"plan.control"`) requires a complete read;
an object entry can require a `path` projection with `maxChars`/`maxItems` and an exact `count`.
Truncated reads never count. Direct file reads do not satisfy it: the ledger proves artifact access,
not semantic use. A stage whose required reads stay missing after its repair retries fails
(`required_reads_missing_exhausted`).

**Input integrity.** A stage may report in its control whether it could use its inputs:
`"inputIntegrity": {"status": "complete"}` or `{"status": "blocked", "reason": …, "detail": …}`
with `truncated_read`, `missing_read`, `inconsistent_input` or `budget_block`. Once the required
reads passed, the ledger proves every one was delivered complete, so a `truncated_read` or
`missing_read` block is a misjudgment: the engine repeats the attempt with that evidence and fails
the stage if the claim persists (`input_integrity_contradicted_exhausted`). `inconsistent_input` and
`budget_block` are about content and are accepted as reported. deep-research's final audit requires
the field (2026-11-01: a model withheld a complete packet as "truncated").

**Paging.** Each executor's CLI cuts long MCP results (Pi 1.1 at about 20 KB, Claude at 22,500
chars, Codex at about 32,000 chars). The engine starts the artifact server with a limit below the
executor's measured cut, so nothing is cut silently: a whole-artifact read that does not fit is
served page by page, each response ending with `[workflow_artifact page: chars X–Y of N; call again
with offset=Y to continue]`. A required whole-artifact read is satisfied once page rows of the same
artifact version cover every character; the failure message names missing ranges. Projected reads
are not paged: when one does not fit it is cut, marked `deliveryUnverified`, and does not count;
re-read with a narrower `path`/`maxItems`/`maxChars`.

## Run records

Everything a run writes is under the project's `.agent-workflow/`:

```text
.agent-workflow/workflows/<run-id>/
  run.json             run record: status, tasks, executor, permission mode, capability negotiation, usage
  spec.json, compiled.json, bundle/   what the run executes
  supervise.log        detached supervisor log (--detach)
  tasks/<task-id>/     task.md, system-prompt.md, control.json, analysis.md, refs.json, raw.md,
                       read-ledger.jsonl, source-manifest.json, artifact-access.json, result.json,
                       output.log, stderr.log
.agent-workflow/workflow-subagents/<run-id>/<task-id>/<runtime-run>/attempts/<attempt>/
                       worker.json, executor.json, authority.json, control/, exec-events.jsonl,
                       raw CLI logs, result.json
```

Bundled workflows end with a `completionSummaryMarkdown` (printed as the run result) and a
`final-report.md` in the final task directory; `inspect --results` lists the report paths.

**Usage.** Each task records its executor-reported usage (`tasks[].usage`) and the model that served
it; a terminal or blocked run records a roll-up with `tasksReporting`/`taskCount`. Every executor
reports the same shape: input tokens **excluding** cache reads and writes, cache-read tokens,
cache-write (cache-creation) tokens, output tokens (reasoning included), and a total that is the sum
of all four. Support helpers make no model call and report nothing (not zeros). Cost is
reported, estimated or **unknown**: an unknown cost is `null` in the records and `cost unknown` in the
host text (`cost=unknown` in the detailed run view), never `0` or `$0`; the run roll-up's `costUsd` is `null` when no
task reported a cost. Codex reports no cost; Pi's is an estimate; Claude's is notional on a
subscription: see [`support.md`](support.md).

**Worker sessions.** By default no worker keeps a CLI session (D3): workers run without session
persistence (Claude `--no-session-persistence`, Codex ephemeral threads, Pi `--no-session`), and output
repairs, launch retries and resumes start fresh attempts. Only the experimental same-session repair
(`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`) requests kept sessions. Sessions the engine did
request are released through the executor's `deleteOwnedSession`: a completed or skipped task's at
once, every remaining one when the run completes or fails. A blocked or interrupted run keeps the
sessions of its failed, blocked and interrupted tasks until it is resolved or pruned. Each released
session is recorded on the task (`ownedSessions[].release.outcome`: `deleted`, `not_found`,
`unsupported`, `refused`, `failed`).

**Retention.** Run directories are not deleted automatically. `agent-workflow prune` previews terminal
runs beyond the newest 50 (`--keep N`, `--older-than DAYS`); `--yes` deletes them. Live supervisors
and runs with retained children are protected. Pruning a run also deletes the worker CLI sessions
still recorded as owned (where the adapter supports `deleteOwnedSession`; already `deleted` or
`not_found` entries are skipped, the rest retried); a run whose session deletion fails is kept.
The `auto` classifier's requests (`.agent-workflow/workflows/auto-router-runs/run_*`, one per
comparison) follow the same rules (terminal only, the newest `--keep` kept, `--older-than`, deleted
only with `--yes`) and are listed separately as "Classifier requests"; they are never shown as runs
and never hold back the pruning of runs (WP39b).

What prune removes and what it keeps (WP42):

- Nothing is listed or deleted when `.agent-workflow` or `.agent-workflow/workflows` is a symlink
  or otherwise not a real directory inside the project; prune reports `unsafe retention root`.
- A classifier request is removed only when its directory is reached through real directories
  (no symlinked `.agent-workflow`, `workflows` or `auto-router-runs`) and its `run.json` is the
  runtime's run record of the router's comparison call: schema 2, correlation id
  `workflow-auto-compare-v1`, `runsDir` `.agent-workflow/workflows/auto-router-runs`, and a
  runtime-generated id (`run_<base36>_<6 hex>`) equal to the directory name. Anything else there
  (other directories or files, foreign or malformed records, leftovers of an interrupted prune) is
  kept, whatever its age, and listed under "Kept in auto-router-runs (not identified as classifier
  requests)". Each deletion rechecks the directory chain, the directory's identity and its record
  under the runtime's lock for that run right before it is removed.
- A classifier request whose caller has not read its result yet is kept: an `auto` recommendation
  pins its requests (`auto-router-runs/.pins/`) from launch until the output is consumed, and prune
  lists records updated since a live pin as `protected`. Pins of processes that are gone are
  ignored and removed. When a pin cannot be created (for example an unwritable `.pins`), the
  recommendation is `routing-unavailable` and no classifier is called (WP42 review round 2); only a
  layout prune never deletes in (a symlinked or non-directory `.agent-workflow`, `workflows` or
  `auto-router-runs`) runs without a pin.
- A run directory is kept, with the reason listed, while it contains a worktree that your
  repository's `git worktree list` still registers after prune removed the identified managed ones
  (for example one created there by hand), or while one of its enabled worktree records cannot be
  identified (below). Prune never removes a registered git worktree by deleting its run directory.
  When git cannot list registrations (git is not installed, or the project is not a git
  repository), a git checkout found inside the run directory (a `.git` file or directory) keeps
  the run instead; a hung `git` (30 s) also keeps it.

**Worktrees.** A write-capable stage that runs in a managed worktree
(`.agent-workflow/workflows/<run>/worktrees/<task>`, branch `agent-workflow/<run>-<task>`) leaves it
in place after the run: there is no auto-merge, the worktree and its branch
hold the result for you to review and merge (`show`/`inspect`/`status` name the path and branch).
The run's attempt state stays in the project's own `.agent-workflow/`, and the project's
`.agent-workflow/` is never copied into a worktree (WP39b). To remove one yourself:
`git worktree remove <path>` (add `--force` to discard uncommitted changes) and
`git branch -D agent-workflow/<run>-<task>`. `agent-workflow prune` includes them: the dry run lists
each worktree of a run it would delete with its branch, `uncommitted changes` and the number of
commits on the branch that your checkout's HEAD does not contain; `--yes` removes them
(`git worktree remove --force`, so uncommitted changes in them are discarded only with `--yes`).
Prune touches a worktree only when agent-workflow created it for that task or loop (WP42): the
recorded branch is the managed `agent-workflow/<run>-<task>`; every directory from the project down
to `<run>/worktrees/<task>` is a real directory (no symlinked parent); and your repository's
`git worktree list` registers that path checked out on that branch (the recorded `baseCwd` is not
trusted). A missing worktree's stale registration is removed for that path only. The managed branch
is deleted only when `git merge-base --is-ancestor <branch tip> HEAD` holds in your checkout,
whatever its upstream, and it still points at that tip; otherwise it is kept and named, also when
its worktree directory is gone. A recorded path that spells the project through an alias (macOS
`/tmp` for `/private/tmp`, a symlinked project parent) is mapped onto the canonical project root
first; a symlink below the project root is still refused. A worktree that is not identified this
way, an enabled worktree record whose project root cannot be resolved or that points elsewhere, or
one whose state is unknown is kept with its branch and its run, and the reason is listed (the dry
run already lists that run as `protected: worktree kept: …`).

Executor adapters keep one attempt record per worker attempt under
`~/.agent-workflow/executors/{claude,codex,pi}/attempts/`. Since WP18b, terminal attempt records
older than 7 days are removed with their event logs and per-attempt dirs, in the background when a
worker is submitted (at most every 6 h) and by `agent-workflow prune` (same dry-run rule;
`--older-than DAYS` sets the window). Records of attempts that may still run are never removed.
Since WP19 an attempt that was launched leaves a small tombstone in place of its record (never
pruned), so a later reconcile reports it as "launched, outcome unknown or as recorded" and never
as "never started": nothing is retried automatically.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Not started: no executor is usable` | No `--executor`/profile chose one and none of `pi`, `claude`, `codex` is installed and logged in. The message lists each CLI's state and its install or login command; `agent-workflow doctor` shows the same. |
| `Not started: … EXECUTOR_NOT_INSTALLED` / `EXECUTOR_AUTH_NOT_READY` | The executor CLI is missing or not logged in. The message names the install command or the login command (`pi` then `/login`, `codex login`, `claude auth login`; antigravity: sign its worker home in once, `docs/executors/acp.md`); or pick another `--executor`. Every executor a run uses is checked before anything starts: a mixed run lists each one it cannot use with the stages that use it (`2 executors this run needs cannot be used: …`). |
| `Not started: … CAPABILITY_REFUSED` | A stage needs something the executor cannot do. The message lists each refusal and its opt-in, if any (`--allow-unverified`, `allowReadOnlyDowngrade`, `--permission-mode free`). |
| deep-research refused on Pi with `webTools` | Your Pi has no `pi-web-access` (not bundled). Install it with `pi install npm:pi-web-access` (check with `pi list` or `agent-workflow doctor`), or use `--executor claude`/`codex`. The refusal and the preview name the same command. |
| Codex runs show `readOnly`/`contextIsolation` warnings | Your `~/.codex/rules` has allow rules or a global `~/.codex/AGENTS.md` exists. Recorded only; remove them for a clean run. |
| A workflow or agent from `~/.pi/agent/` is missing in `agent-workflow list`/`agents` | By design (2026-10-30): Pi's directories are Pi configuration and are not read. Copy what you want into `$AGENT_WORKFLOW_HOME/workflows/` or `…/agents/` (or the project's `.agent-workflow/`), or pass a spec path. |
| `input <key> is not declared by this workflow (declared: …)`, `input <key> must be a number` (exit 2) | `--input` / `inputs` names a key the spec does not declare or a value of the wrong type. Use a declared key (`agent-workflow show <workflow>` shows `input`) and a value of the default's type. |
| Usage shows `cost unknown` | The executor reported no cost (Codex always; any task without a cost). Token counts are still recorded; nothing is estimated. |
| The run is `failed` but the report looks fine | A final render declares failure (`support_declared_failed`) when the review could not be completed — deep-review `PARTIAL_REVIEW` without confirmed findings, spec-review `INCONCLUSIVE`; the report says what is missing. Verdicts about the target (`NEEDS_WORK`, `GAPS_FOUND`, impact-review `BLOCKED`) finish the run normally. Read `final-report.md`. |
| A task failed with `required_reads_missing_exhausted` | The worker did not read every required artifact (or only part of a paged one). `inspect <run> --failures --results` shows which; `resume` retries. |
| A task is `blocked` with `executor_needs_decision` | After a crash the executor could not prove whether the attempt ran. Nothing retries automatically. Check the CLI's own state, then `resume` (new attempt) or `stop`. |
| `wait` returns `stillRunning` | The bounded wait ended; call `wait` again, or use `--detach` and check later. |
| `stop` says pending (exit 1) | Another supervisor owns the run and did not confirm within 15 s; it applies the durable stop intent. Check with `agent-workflow status <run>`. |
| The CLI prints a test-executor warning or exits 2 on every command | `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` is set; unset it (test-only hook). |
| Changed a bundled workflow but the run still uses the old one | Runs execute their copied `bundle/`; start a new run. |

Environment variables: [`environment.md`](environment.md).
