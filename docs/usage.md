# Using agent-workflow

How to find, write, run, wait for, resume and stop workflows, how executors, profiles and permission
modes are chosen, what a run leaves on disk, and what to do when something goes wrong. Command
reference: [`cli.md`](cli.md) (CLI) and [`hosts.md`](hosts.md#pi) (Pi `/aw`). Install and quick
start: [`../README.md`](../README.md).

Examples use the CLI. In Pi, the same actions are `/aw <action> …` (and the `aw_list`, `aw_run`,
`aw_dynamic`, `aw_wait` tools).

**Contents:** [Workflows and specs](#workflows-and-specs) · [Bundled workflows](#bundled-workflows) · [Running](#running) · [Waiting, inspecting, resuming, stopping](#waiting-inspecting-resuming-stopping) · [Executors](#executors) · [Blocked actions](#blocked-actions) · [Permission modes](#permission-modes) · [Preflight: capability, tools, models and effort](#preflight-capability-tools-models-and-effort) · [Stage model](#stage-model) · [Artifacts and required reads](#artifacts-and-required-reads) · [Run records](#run-records) · [Support matrix](#support-matrix) · [Troubleshooting](#troubleshooting) · [Environment variables](#environment-variables)

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

Pi's directories (`~/.pi/agent/workflows/`, `<cwd>/.pi/workflows/`) are **not** read. A spec from elsewhere runs when copied into one of the roots above or passed by
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

Workflow and agent discovery do not use Pi's directories. See [run records](#run-records) for
run-state paths; user settings live under `$AGENT_WORKFLOW_HOME`. Pi web-tool diagnostics read Pi's web-search config;
`doctor --fix` changes it only with confirmation (or `--yes`). `logs`/`inspect` read only files inside
the state directory's `.agent-workflow/`; a file outside it shows as `(not read: path is outside the project's artifact
root …)`.

## Project-local workflow settings

Project-local intent is scoped to the physical project and a source-aware workflow key, not just
`spec.name`. Name, filename alias and physical path select the same key when they resolve to the
same definition. Source roots remain distinct; a shadowing definition has a different key. Bundled
keys do not depend on the package installation directory; external definitions use their physical
path. Stored keys can outlive discovery. Inspect them with `agent-workflow project-settings list`
and `show --key <key>` or MCP `workflow_project_settings`.

Intent has workflow `defaults` and exact canonical authored `slots`. Each explicit binding includes
an executor and optional model/effort; absent fields inherit rather than selecting Automatic.
Editable slots are authored model leaves/templates, including declared dynamic-profile templates,
not controllers, code/groups, generated task IDs or a separate child Run's settings. Dynamic-profile
executor bindings must agree with their controller. A workflow default supplies common values;
a slot overrides it. Field precedence is **explicit run flag > local slot > local defaults > shared
legacy resolution**. Executor selection also fences executor-bound model/effort: changing an executor
does not carry incompatible lower-layer values to it. Shared profile/preference resolution remains
the baseline when local values are absent. `--profile` selects that baseline, not a bypass of local
intent. Check and named launch use the same resolver; recorded values describe the requested/resolved
plan, not observed provider execution.

Shared `profile workflow` preferences are still user-level and keyed by workflow name, potentially
across projects. Manage them through CLI, MCP or Pi's profile picker, not the dashboard.
They are neither migrated into nor deleted by project-local settings. Dashboard **Executors** shows
readiness and one read-only permission fact from the doctor's effective default: **Free** means
workers run without approvals or sandbox; **Safe** means workers run sandboxed with approvals
limited to their tools. Use `--permission-mode safe` to restrict a run. There are no permission or
strict-capability editors on this page, including on read-only dashboards. Shared profiles and their
default selection remain available through CLI, MCP and Pi; the dashboard does not modify or delete them. Project-local
storage is private under the project's state base at `workflow-settings/v1/settings.json`.
In the dashboard, writable initial load and meaningful edits automatically calculate the draft without
saving or executing. **Save** and **Discard changes** sit in the sticky title row with an unsaved-changes indicator. Save applies one
complete snapshot; newer edits during Save remain unsaved and refresh with the returned revision.
Discard changes confirms a dirty discard and reloads saved settings; it does not delete them.
Calculation failures retain the draft and offer contextual Retry without an automatic retry loop.
The default **All tasks** panel edits workflow defaults. Its native **Preset** select offers
**Custom**, **codex**, **codex-high**, **claude** and **mixed**. Selecting a preset replaces the entire
draft: defaults use its `default` role, while authored slots get role-specific bindings only when
they differ. Role addresses come from the server, not task names; unknown roles keep defaults.
Dynamic templates cannot pin another executor: incompatible role models are omitted and inherit
from their actual controller. Every field remains manually editable. The select shows a preset
only while the complete draft exactly matches its fill (also on reload); otherwise **Custom**.
The name is not stored. Nothing is persisted until Save; Discard restores the saved intent.
Selecting a graph task shows **Use All tasks settings** or **Custom for this task**; fields appear only for Custom. Custom captures the current resolved values without changing the result. Returning to All tasks settings removes only that task binding in the draft. **← All tasks** and Escape return to the defaults panel.
Model is a selection-only dropdown that retains saved unlisted IDs on load, including on inventory failure; new arbitrary IDs remain supported through CLI/API and Pi's profile picker. Explicit executor changes clear a model only when the new executor's complete, available inventory excludes it, with a short inline note. Partial/unavailable inventories and listed models retain it.
**Use baseline settings** in Model/Effort unsets only that field, keeping the executor and sibling values.
Executor offers explicit IDs only and never pins a baseline just by opening the editor. Graph nodes show the current **model · effort** and a **Custom** marker for task bindings; stale values disappear until recalculated. Detailed lineage stays in the task panel. The title has one muted description line; About, routing tables and Workflow diagnostics (including launch Check, Source, Resolved spec and roles) are not on this page. Real spec problems remain visible. CLI/API Check is unchanged. Saves fence epoch, entry revision, definition fingerprint and alias resolution;
clears use exact stored keys and snapshot tokens without requiring the definition to remain available.
New named launches freeze settings; changing them later does not change existing Run Resume.
Spec-less direct dynamic runs do not read this named-workflow store.

For an orphan/invalid binding, explicitly remove only that whole defaults or slot binding with
`project-settings clear-binding`; siblings remain intact, even if they are independently invalid.
A per-field edit is a full validated intent save, not a partial deletion of a binding's executor.
Entry `reset` keeps an empty tombstone; `purge` removes it and rotates the epoch. `clear-project`
requires whole-project confirmation plus epoch/raw digest and empties only this project's local
settings. Shared preferences, other projects and existing Run records are preserved.

Malformed/unknown storage is preserved and blocks new named launches rather than falling back.
Use the noncreating `inspect-recovery`, review its raw digest/bytes and project scope, then explicitly
confirm `recover` with that digest. Recovery verifies an exact private backup before publishing an
empty store. It refuses valid stores, unsafe/unreadable files, invalid UTF-8 and originals over
16 MiB; no implicit repair, migration or overwrite retry occurs. Recovery and whole-project clear
are distinct from entry clearing. See [CLI syntax](cli.md#project-local-workflow-settings) and
[MCP confirmation](hosts.md#project-local-settings-recovery).

## Bundled workflows

Bundled workflows ship as directory-local bundles with a spec, schemas and support helpers.

### Workflows

| Workflow | Agent | Purpose |
|---|---|---|
| `deep-research` | `researcher` | Source-backed research, claim verification, synthesis and evidence audit |
| `deep-review` | `scout` | Independent code/design review, finding verification and deterministic report |
| `spec-review` | `scout` | Requirements extraction, implementation/test coverage and gap verification |
| `impact-review` | `scout` | Change scope, contract impact, regression risk and ship readiness |

`deep-research/tiered-verification.spec.json` is an alternative research spec that separates core
and tail verification. Every bundled spec opts into `allowReadOnlyDowngrade`; all model-backed
stages are readOnly. None requires Pi-only `fast`, `toolResultBudget` or `inheritHostTools`.

```sh
agent-workflow list
agent-workflow show deep-review
agent-workflow run deep-review "Review the current change." --executor claude
agent-workflow run deep-research "Compare the storage designs." --input depth=max --profile high
```

Pi exposes the same actions through `/aw`; MCP hosts use `workflow_list`, `workflow_run` and
`workflow_wait`. See [workflow inputs](#workflow-inputs---input-keyvalue), [profiles](#profiles),
[roles](#roles-presets-and-mixed-runs) and [bundle lookup priority](#where-workflows-are-found).

### Reports and evidence

Each workflow emits explicit limitations and the [standard report outputs](#run-records).
Full reports end with Related artifacts. Deep-research also writes
`executive.md` and `audit.md`; deep-review writes `review.md`; spec-review and impact-review write
`source-ledger.json`. Missing or inconsistent canonical inputs fail or block rendering rather than
produce a clean report.

Review verdicts are deterministic. Kept/weakened findings make deep-review `NEEDS_WORK`, with
incomplete coverage named as limitations; without findings, incomplete coverage is `PARTIAL_REVIEW`.
Grounded spec-review gaps on an intact ledger yield `GAPS_FOUND`; without gaps, unresolved
requirements yield `INCONCLUSIVE`, and `CONFORMS` requires complete coverage. When the narrative synthesis states a
different verdict, the deterministic one stands and the report and completion summary say so; a favourable verdict
needs the narrative's agreement (otherwise deep-review `REVIEW_COMPLETE` becomes `PARTIAL_REVIEW`, spec-review
`CONFORMS` becomes `INCONCLUSIVE`, impact-review `READY` becomes `UNKNOWN`). The run still completes. See
[local review evidence](#local-review-evidence) for requirement rechecks and repository-byte
citation checks.

Deep-research uses the CLI's `web_search` and `fetch_content` mappings and the
[web quote check](#support-helpers). The check accepts exact and formatting-folded quotes, with
symbol-spacing tolerance only for math; without it, source verification is model-reported.

Deep-research compares structured research observations by code: when workers report different dates
or numbers for the same fact slot and entity, the slot is contested (`slotConflicts` in the
normalizer's input packet); numbers are compared only when written with the same unit words ("1 MB" and
"1024 KB" are not; approximation words such as "about" do not count as units). The normalizer must route it to verification; the final packet keeps the slot
`conflicting` until verified claims that name the entity state exactly one of the values (a year and a
year-month of that year count as one) — a claim stating several values, or claims settling on different
values, leave it unresolved. Then the slot is `filled`, the other value named, and a `bestValue` stating the
rejected value is replaced by the settling claim (also on a slot the normalizer had already filled); the report lists the competing values, their sources and the settling
claim under "Contested values". Prose values are not compared, with one exception: an observation whose
entity is a local document (`notes.md`) and whose text states exactly one year-month is compared under
the one entity its text names (several only when an observation on that slot names them as one subject,
such as "RFC 9114 / HTTP/3" or "HTTP/3 (RFC 9114)"; "RFC 9000 vs RFC 9114" does not), on the
observation's own slot or else on exactly one other slot, so a note that misdates a fact meets the
external value; the audit names the document. The audit also lists reader-facing
sentences that tell the reader a local file is wrong while citing numbers or dates of a kind the file
does not contain ("Source attribution check"); they are warnings, not blockers. A claim the verifier did not
verify but corrected (`partially_supported` or `unsupported` with `correctionOrCounterclaim`) leaves its fact slot
`partial`, with the correction in the gap reason, even when other claims on the slot are verified; the audit's
claim ledger shows the correction.

Research synthesis requires a header and all sixteen indexed pages at `maxChars: 16000`, including
empty tails, exactly once. Pages are bounded in UTF-16 units and UTF-8 bytes, with 256,000 aggregate
page units plus a bounded header. Oversized rows or bank exhaustion block explicitly; larger/root
reads do not substitute for the required projections.

Reports use the task's requested language (otherwise its language), retaining verdict tokens,
identifiers, paths, code and evidence quotes. Impact-review's completion summary lists at most four
action rows, blocking first, and counts the remainder; the full report retains every row.

### Skills and agents

| Asset | Purpose |
|---|---|
| `skills/agent-workflow/SKILL.md` | Host MCP tool protocol |
| `skills/workflow-guide/SKILL.md` and `scaffolds/` | Workflow authoring, validation and starter patterns |
| `skills/execution-router/SKILL.md` | Recommendation-only execution-path selection |
| `agents/scout.md` | Local exploration for review workflows |
| `agents/researcher.md` | Research with `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content` |

Plugin skill copies are generated for the host's MCP tool names; see [plugins](hosts.md#claude-code-and-codex).
Unknown tool names do not grant tools: use `web_search` / `fetch_content`, not `workflow_web_*`.

### Worker prompt rendering

Write `workflow_artifact` or `{{workflow_artifact}}` in prompts. The engine renders it to the
executor-visible name, leaving evidence locators such as `workflow_artifact:<id>` unchanged.
Persisted prompts and their hashes retain canonical logical names. Workers with the artifact server
also receive its guidelines in the system prompt.

Logical tools are rendered per executor: Claude uses `Read`, `Grep`, `Glob`, `WebSearch` and
`WebFetch`; Codex uses read-only shell commands and hosted `web_search`; Pi keeps the logical names.
See [MCP](extending.md#visible-tool-names) for artifact tool naming.

### Support table

This is offline capability negotiation, not a model-quality comparison. Each spec is compiled with
its default profile, then negotiated in `free` (the run default) and `safe` modes. The policy is
non-interactive, with no unverified opt-in or strict profile, and uses the spec's
`allowReadOnlyDowngrade`.

“Declared table” uses `createExecutor(null).capabilities()`. “Probed, clean environment” merges
probe rows for Pi with `pi-web-access`, Codex without global `AGENTS.md` or allow rules, and Claude
with no changed negotiated row. Generator: `test/helpers/bundled-support-table.mjs --write`.

- **accept**: no degradation. **degrade**: accepted and recorded. **refuse**: nothing starts.
- `webTools.safetyPolicy:unknown`: CLI browsing policy is not engine-enforced.
- `CAPABILITY_MISSING:toolAllowlist.fine`: Codex cannot enforce precise tool lists. `free` records
  this; `safe` uses `forcedReadOnly` because these specs opt in. Bundled stages keep their authored
  readOnly intent; only `safe` enforces it.
- `CAPABILITY_MISSING:usage.cost`: token-only usage; unknown cost is `null`.
- `CAPABILITY_UNVERIFIED:webTools`: Pi's declared table cannot confirm `pi-web-access`; the probe
  must find it. Without it, research is refused with `CAPABILITY_MISSING:webTools`.
- Codex global instructions or allow rules can add isolation/readOnly warnings. `free` records
  isolation warnings but does not negotiate readOnly; `safe` records both, and strict capabilities
  can refuse them.

<!-- bundled-support-table:start -->
<!-- Generated by test/helpers/bundled-support-table.mjs; do not edit by hand. -->

| Workflow | Executor | Mode | Stages | Declared table | Probed, clean environment |
|---|---|---|---|---|---|
| `deep-research/spec.json` | pi | free | 6 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | pi | safe | 6 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | codex | free | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | codex | safe | 6 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | claude | free | 6 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/spec.json` | claude | safe | 6 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | pi | free | 7 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | pi | safe | 7 | refuse: `CAPABILITY_UNVERIFIED:webTools` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | codex | free | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | codex | safe | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly`, `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | claude | free | 7 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-research/tiered-verification.spec.json` | claude | safe | 7 | degrade: `webTools.safetyPolicy:unknown` | degrade: `webTools.safetyPolicy:unknown` |
| `deep-review/spec.json` | pi | free | 4 | accept | accept |
| `deep-review/spec.json` | pi | safe | 4 | accept | accept |
| `deep-review/spec.json` | codex | free | 4 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `deep-review/spec.json` | codex | safe | 4 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `deep-review/spec.json` | claude | free | 4 | accept | accept |
| `deep-review/spec.json` | claude | safe | 4 | accept | accept |
| `impact-review/spec.json` | pi | free | 12 | accept | accept |
| `impact-review/spec.json` | pi | safe | 12 | accept | accept |
| `impact-review/spec.json` | codex | free | 12 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `impact-review/spec.json` | codex | safe | 12 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `impact-review/spec.json` | claude | free | 12 | accept | accept |
| `impact-review/spec.json` | claude | safe | 12 | accept | accept |
| `spec-review/spec.json` | pi | free | 7 | accept | accept |
| `spec-review/spec.json` | pi | safe | 7 | accept | accept |
| `spec-review/spec.json` | codex | free | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost` |
| `spec-review/spec.json` | codex | safe | 7 | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` | degrade: `CAPABILITY_MISSING:toolAllowlist.fine`, `CAPABILITY_MISSING:usage.cost`, `forcedReadOnly` |
| `spec-review/spec.json` | claude | free | 7 | accept | accept |
| `spec-review/spec.json` | claude | safe | 7 | accept | accept |

<!-- bundled-support-table:end -->

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
When a run's driver dies (Pi session quit, killed supervisor) it stays `running` for a short time.
`status`, `show` and the run list say `no live driver — not progressing` (no lease and no live
supervisor process); `wait <run>` or `supervise <run>` drives it again. Reads never refresh the
driver heartbeat. Once the driver is clearly dead, the next read marks the run `interrupted`: the
driver process is gone, its last heartbeat is at least 2 minutes old and no live process holds the
run lock. Any worker still running is stopped and completed work is kept. The card says `Stopped:
the process running it ended (its host was closed). Completed work is kept. Resume to continue.`
(a user `stop` says it was a stop request), and `resume <run>` works in one step. The run then
appears in the unfinished-run reminder. Status, `show`, `logs`, the run list, the dashboard,
`notify-check`, the reminder and `resume` all do this; a run with a live driver is never touched.

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

Declared inputs (defaults with `--input` overrides applied) reach a task only as a `# Workflow
Input` JSON block in its prompt (`task.md`). Compiled stage tasks (single, reduce, support, dynamic
controller, loop and dag children) get it; `foreach` children do not. There is no `${input.x}`
substitution (`${item}` in `each.prompt` is the only placeholder), so a prompt that needs a value says
to read it from that block, and a foreach worker gets what it needs through its item.

### Letting agent-workflow pick the workflow (`auto`)

```sh
agent-workflow auto "Review the current diff for reliability and test coverage."
```

`auto` shortlists the dynamic workflow and discoverable workflows (at most 24), sends one
tool-free classifier request containing your task and bounded candidate descriptions, and starts
the top recommendation without asking. Classifier failure starts nothing; a workflow changed
since comparison is refused. All hosts, including Pi print/JSON and MCP clients without dialogs,
use the same behavior. The launch records consent source `command`.

The classifier uses the run's default executor and `--model`/`--effort` or profile settings;
otherwise the `default` role of that executor's [default profile](#executors) (Pi's current host
model with your saved `pi` changes; codex/claude: the built-in or edited one, with its fallback),
else the executor's own default. See [executor selection](#executors)
and [CLI `auto`](cli.md#auto) for selection, launch metadata and JSON outcomes.

The `execution-router` skill stays recommendation-only: it may suggest `auto`, but never runs it.

## Waiting, inspecting, resuming, stopping

```sh
agent-workflow status                         # top-level runs, newest first
agent-workflow status <run>                   # one run and its tasks
agent-workflow wait <run> --timeout 30m       # drive and wait (exit 1 if still running at the timeout)
agent-workflow inspect <run> --failures --results
agent-workflow show <run> --raw               # the run record
agent-workflow resume <run> [--detach]        # reset failed/interrupted/resumable blocked tasks, continue
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
an access blocker, or a foreach whose items cannot be expanded: any blocked task makes the run
`blocked`, ahead of `failed`). A support stage that declared itself blocked counts as resumable when one of
its sources is resumable (a renderer blocked by a failed audit reruns after the audit); with every
source completed it stays a blocker. `resume` resets failed, interrupted and resumable blocked tasks and keeps
completed task artifacts, except stages that declare `inputPolicy.invalidateOnDependencyResume`
(the bundled deep-review, deep-research and spec-review consumers do): those rerun, with everything after them,
when a source they read is reset, so a result never mixes old and new inputs. A run executes the copied `bundle/` in its run directory, so a newer
package version does not change a running workflow's schemas or helpers; start a fresh run to pick
up changed workflow code. Loop workflows cannot be resumed; start a fresh run. Right after `stop`,
`resume` waits up to 10 s for the stopped supervisor to let go of the run; if it has not by then,
`resume` changes nothing and says to try again in a few seconds.

Workflow-level approvals were removed. Delete `dynamic.permissions.approval` from old specs;
validation rejects it. Capability degradations are recorded and shown without a question.
Security checks, capability refusals and worker permission modes still apply.

`stop` records a durable stop intent. A worker that had not started yet never starts (its launch is
revoked); a running worker is cancelled. If another supervisor owns the run, the stop is applied by
it: `stop` waits up to 15 s for that confirmation, and a run the supervisor has already stopped counts
as confirmed (exit 0). If no confirmation arrives in time, `stop` reports the stop as pending and
exits 1; the intent stays durable and is applied when the supervisor next runs.

### Provider rate-limit waits

For rate-limit failures, retry scheduling honors a provider's `Retry-After` duration or HTTP date,
absolute reset timestamp, or clock such as `resets 3:30pm (Asia/Seoul)`. A clock without a timezone
uses the local timezone. Invalid or unrecognized hints use the normal exponential backoff.
When several valid hints exist, the latest wins. Explicit reset times are minimum waits, not
truncated to the default backoff ceiling; shared model cooldowns survive process restarts.

A five-hour provider limit can therefore leave a task waiting for hours. Use `--detach` to avoid
occupying the terminal, and `status` or the dashboard to see the scheduled retry. Existing run
limits and stop controls still apply; the engine does not bypass the provider's limit.

When a provider is overloaded (rate limit, an HTTP 429/502/503/524/529 status, "overloaded", "busy", "saturated",
"too many requests"; not a bare number such as a line number, nor mid-stream or socket failures) the run pauses instead of burning retries. After
3 such failures of one provider within 5 minutes (across all runs on this machine) no task of that
provider launches for 5 minutes, then 10, 20, 40 and at most 60 on each repeat. After the wait one task
probes the provider; the others keep waiting until it succeeds (the pause closes) or hits the overload
again (the wait doubles). Overload failures that open the pause or happen during it do not use a task's
retry budget. `status`, `show` and `wait` show `provider <name> overloaded: paused until HH:MMZ (pause n, m
of 120 min)` while it lasts, and the run record keeps a `providerPause` summary per provider. A run pauses
for at most 120 minutes in total (`AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES`; time a run spends stopped does not count); after that its failures
are counted as usual and tasks fail as before. `AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES=0` turns the pause off.

## Executors

| Executor | CLI | Notes |
|---|---|---|
| `pi` | `pi --mode json` | Pi 1.1+. deep-research needs the `pi-web-access` extension (`pi install npm:pi-web-access`; `agent-workflow doctor` checks it). |
| `codex` | `codex app-server` | codex-cli 0.159+. Coarse tool allowlist (a sandbox mode). |
| `claude` | `claude -p` (stream-json) | Claude Code 2.1+. |
| `antigravity` (experimental) | `agy_acp_server` (ACP) | Gemini models; see [ACP configuration and limits](executors.md#antigravity-acp). |

Each executor uses its own CLI login (agent-workflow never handles credentials). Choose with
`--executor <id>`, a profile, or a saved default profile. Precedence for both the executor and the
permission mode: **run flag > workflow-declared profile > saved user profile > default** (mode
`free`). The run records which layer chose (`run.executor.source`, `run.permissionMode.source`).

**Default executor.** Without a choice, a run uses the host's own CLI (`host-default`): `pi` in the
Pi host, `claude` in Claude Code, `codex` in Codex. The terminal CLI uses the first installed and
logged-in of `pi` → `claude` → `codex` (`installed-default`; a verified login wins over
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
   of `model`, `effort` and `foreachBatch`; plus an executor and permission mode per profile
   via `executionProfileExecutors` / `executionProfilePermissionModes`) and a
   `defaultExecutionProfile`. Select one with `--profile <name>`. A declared profile sits on top of
   your default saved user profile, field by field: whatever the declared profile does not set
   (executor, permission mode, `strictCapabilities`) comes from the default saved profile, and that
   profile's `model`/`effort` stay run defaults when it names no executor or the run's executor.
2. **Saved user profiles.** `agent-workflow profile set <name> --executor codex --effort high
   --permission-mode safe [--strict-capabilities readOnly,contextIsolation] [--default]`. Fields:
   `executor`, `model`, `effort`, `permissionMode`, `strictCapabilities` (capabilities that must be
   `native`, else the run is refused), `roles` (below). Stored in
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
saved profile are run defaults (stage and agent settings still win); `check --json` labels them with
source `host-default` (the run-defaults layer), while the executor shows `user-profile`.

`deep-research` declares `low`, `medium` (default) and `high` profiles: `low` and `medium` batch
compatible `verify-claims` items in pairs; `high` spends more reasoning and keeps singleton
verification. `low` is an explicit speed/cost-for-quality trade-off. No declared profile pins a
model. Evidence gates are the same in every profile.

Every model-backed stage in a bundled workflow declares a semantic `profileRole` (`planning`,
`research-execution`, `synthesis`, `verification`, `final-judgment`).

### Roles, presets and mixed runs

**Roles.** A saved user profile (`roles`), a workflow-declared profile
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
      "default": { "executor": "codex", "model": "gpt-6-luna", "effort": "medium" },
      "planning": { "executor": "claude", "model": "claude-opus-5-5", "effort": "high" },
      "verification": { "executor": "codex", "effort": "high" }
    }
  }
}
```

```sh
agent-workflow profile set team --preset mixed --default
agent-workflow profile set team --role verification=codex:gpt-6-luna:high
agent-workflow profile workflow set deep-research --profile team --role synthesis=::high
```

**Precedence, per stage and per field** (executor, model and effort each on its own):

| Layer (highest first) | Executor | Model / effort |
|---|---|---|
| Run flags `--executor`, `--model`, `--effort` | every stage | every stage |
| Per-workflow preference `roles` | its matching role entry | its matching role entry |
| Workflow-declared profile | role entry, else `executionProfileExecutors` | its stage overrides, else role entry |
| Saved user profile (or preset) | role entry, else `executor` | role entry; flat `model`/`effort` stay run defaults |
| Default | host default / installed default | stage, agent, host defaults, the executor's default profile, executor's own |

The highest layer that has a value for a stage wins that field. A role entry's model and effort
apply only when the stage runs on that entry's executor (or the entry names none): a model id belongs
to its executor, so `--executor codex` with a profile whose `verification` entry is
`claude:claude-opus-5-5` runs verification on codex with codex's model. Dynamic decision-loop slots
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
| `codex` | codex | planning: SOL/high; research: LUNA/medium; synthesis and verification: LUNA/high; final-judgment: SOL/xhigh |
| `codex-high` | codex | all SOL: research/high; planning, synthesis and final-judgment/xhigh; verification/max |
| `claude` | claude | all OPUS: research/medium; other roles/high |
| `mixed` | codex | planning, synthesis and final-judgment: OPUS/high; research: LUNA/medium; verification: LUNA/high |

SOL = codex `gpt-6.1-sol`, LUNA = codex `gpt-6-luna`, OPUS = claude `claude-opus-5-5`.
Research means `research-execution`; the extra `default` role exactly equals that entry, including
its executor (also the run executor). Preset efforts are requested values; executor/model negotiation
still applies. If your account lacks a model, override the role or use `--model`.
There is no built-in `pi` preset. `--profile pi` still selects a workflow-declared `pi` profile first,
then a saved user profile named `pi` (Pi has no built-in model table); without either it is an
unknown profile. To run Pi without a named profile, use `--executor pi`.

**Executor default profiles.** A stage on codex or claude that no layer above gives a model or
effort takes it from the executor's preset (`codex` or `claude` above): the lowest layer, below
the stage, its agent, workflow defaults, host defaults, every profile and `--model`. When the
executor's probe lists models but omits any model used by the preset, every such stage instead uses your own CLI
settings and the preview says so (`Notice: codex default profile: model "gpt-6-luna" is not
offered here; …`):

| Executor | Read from | Fields |
|---|---|---|
| codex | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); the active `profile` table wins | `model`, `model_reasoning_effort` |
| claude | `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) | `model`, `effortLevel` |

Claude workers run with user settings switched off, so these values are passed explicitly. When
neither is configured, the CLI's own defaults apply. Pi has no built-in default profile: its stages
keep Pi's current model and effort.

**Changing a default profile.** A saved profile named after an executor (`codex`, `claude`, `pi`,
…) holds your changes to that executor's default profile; edit it with the usual profile commands
(CLI `profile set`, MCP `workflow_profile` `set`, the dashboard's Executor default profiles, Pi
`/aw profile set` or the picker, which says so before saving under an executor's name):

```bash
agent-workflow profile show codex                                # built-in, or built-in + your changes
agent-workflow profile set codex --role planning=codex:gpt-6.1-sol:xhigh
agent-workflow profile set claude --model opus                   # every role: opus, efforts unchanged
agent-workflow profile set pi --effort high
agent-workflow profile delete codex                              # back to the built-in one
```

Its flat `model`/`effort` replace the built-in ones in every role; its role entries win field by
field (`--role planning=codex::xhigh` changes only the effort). Entries for another executor and,
when the profile's `executor` is another one, its flat values do not reach this executor's stages.
Your values are used as written: a model the probe does not list is noted, not replaced. Fields you
leave unset keep the built-in behavior, including the fallback above. In Pi, a saved `pi` profile
starts from Pi's current model and effort and stays at their layer (above workflow defaults): pi
stages it does not change keep Pi's current values. Applied on its own (no profile chosen) a
default profile is the lowest layer of its executor's stages (the Pi one: the host-defaults layer).
Choosing it by name (`--profile codex`) or making it the default saved profile applies the built-in
profile with your changes like any saved profile: on the profile tier, and it sets the run's
executor.

**Per-workflow preferences** (`agent-workflow profile workflow set <workflow> [--profile <name>]
[--role …]`, MCP `workflow_profile` `workflow-set`, Pi `/aw profile workflow set …`). Keyed by the
workflow's `name`, stored in `$AGENT_WORKFLOW_HOME/workflow-preferences/v1/preferences.json`, and
applied by every launch of that workflow from the CLI, MCP hosts and Pi: its `profile` when the
launch names none (before the declared default), its roles as the layer above the selected profile.

**Mixed runs.** When stages resolve to more than one executor, one run mixes
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

## Blocked actions

A worker can finish successfully even when a tool action was denied. Status and task lines
then say, for example, `2 actions blocked by provider policy`. This is a warning about work
that could not run, **not** a request for approval, a new run state, or a dashboard “Needs you” item.
Provider policy includes executor/provider restrictions (Claude permissions, Codex execpolicy,
and ACP permissions); engine policy includes the engine's readOnly and tool-kind decisions.

Use `agent-workflow inspect <run>` for each affected task's count and up to three redacted
samples (tool, optional command, reason; at most 300 characters per sample). For the normalized
events use `agent-workflow logs <run> --task <id> --stream events`. The dashboard shows warning
chips on the run and affected task nodes, with samples in run details and task logs. Completion
notices and waits also name the count; JSON/MCP data carry `blockedActions`.

Counting is deliberately literal: each normalized `tool_call` event with `status: "denied"`
counts once, including repeated denied updates for the same call. Approval requests alone,
failed calls, and text mentioning a denial do not count. A task records only the latest attempt
that produced its result, replacing rather than accumulating retry history. Run totals are
computed from task records (a shared foreach batch is counted on its physical leader only).
No denied events means no field or extra output; old records without the field mean none.

The record is `{count, provider, engine, samples: [{tool, command?, reason, source?}]}`.
An accepted engine denial is attributed only when a preceding same-kind approval request has
an exact request/call-id or command match (the command can come from that call's running event).
A preceding same-kind accepted denial without a reliable link leaves the source unknown; otherwise
the executor denial is attributed to provider policy. `count - provider - engine` is the unknown
count. Samples never claim a source when the link is ambiguous. Raw event/approval artifacts
remain the detailed audit; no old transcripts are reparsed or backfilled.

## Permission modes

Workers run in `free` mode by default. Choose `safe` for conservative approvals and sandbox settings.

### The two modes

| | `free` (default) | `safe` |
|---|---|---|
| Approval prompts | none: the worker CLI is started without them. A request that still arrives is answered `allow` by the engine and audited `engine-policy:free` | policy-based: kinds the stage's tools imply are allowed, everything else is denied (fail-closed) unless an interactive host answers |
| Sandbox | none, including authored `readOnly` stages | the adapter's narrowest mapping (no bypass flags) |
| Write-capable stage with spec `worktreePolicy: "off"` | runs in the shared checkout as written | still gets a worktree unless the run option `allowSharedCheckoutWrites` waives it |
| `worktreePolicy: "auto"` / `"on"` | a worktree for write-capable stages | same |
| Coarse tool allowlist (Codex) | accepted for every stage; recorded as a degradation `CAPABILITY_MISSING:toolAllowlist.fine` | refused, or run as readOnly when the spec sets `allowReadOnlyDowngrade` |
| `readOnly` | authored intent only; not enforced or negotiated; a short informational note is recorded | enforced and negotiated as required; mutating approvals denied |
| Environment warnings (Codex `~/.codex/rules` allow rules, global `AGENTS.md`) | recorded degradations; never refused (not even by a profile's `strictCapabilities`), no confirmation prompt | recorded degradations; never ask; `strictCapabilities` refuses |

**Kept in both modes:**

- Authored `readOnly` intent remains in prompts, records and engine-side compilation, worktree and
  scheduling decisions. **It is not a safety boundary in `free`**: unrestricted executors may mutate
  the shared checkout or access the network. Choose `safe` to enforce readOnly.
- Context isolation: workers do not load the user's settings, instructions, hooks or skills unless the
  agent opts in. `inheritProjectContext: true` loads instruction files (AGENTS.md…), `inheritSkills:
  true` loads skills; Pi loads only what was asked for and keeps everything else isolated, Claude and
  Codex inherit all user context when either is set.
- Capability checks for missing or unverified capabilities, MCP injection and web tools.

### Choosing a mode

Selection follows [executor precedence](#executors); the default is `free`.
Use CLI `--permission-mode safe` (or `free`), or the API/profile settings below.

| Where | How |
|---|---|
| Run flag | engine run option `permissionMode: "safe"` (or `"free"`) on `runWorkflowSpec` / `runDynamicTask` |
| Workflow-declared profile | spec top level `"executionProfilePermissionModes": { "<declared profile>": "safe" }`, selected with `executionProfile` |
| Saved user profile | `permissionMode: "safe"` on the captured profile (`WorkflowCapturedExecutionProfile`) |

An invalid value from any source fails before any run record or launch, naming the source. Nested runs
follow the parent run's recorded mode. Older runs without a recorded mode run as `safe`.

### Where the mode is visible

- Run record: `run.permissionMode = { mode, source, profile? }` (`source`: `run-flag`,
  `workflow-profile`, `user-profile`, `default`, `parent-run`).
- Capability preview, first line: `Capability check (<executor>@<version>, <n> stages, permission
  mode: free): …`; free-accepted entries are marked `(accepted: free mode)`. The recorded negotiation
  policy carries `permissionMode` too.
- Mixed runs: the mode is one per run; each stage's executor applies it its own way (the
  adapter table below), so a `free` run whose planning stage runs on Claude
  and research on Codex gets `bypassPermissions` there and `danger-full-access` here. The preview
  names every executor (`Capability check (mixed: claude@… ×n + codex@… ×m, …)`).
- Each attempt: `SubmitRequest.permissionMode` (execution plan, `executor.json`, durable worker payload);
  adapters record their resulting invocation in the attempt directory under `worker-runs/` (see
  [run records](#run-records)): `claude-invocation.json`, the Codex raw transcript. The task directory
  has neither, and its `result.json` carries no executor, model or permission metadata: those are in
  `run.json` (`executor`, `permissionMode`, `tasks[].runtime` with model and effort, and the executor in
  mixed runs), `show --json` and `inspect`.
- Approvals: `approvals.jsonl` and the result metadata record `by: "engine-policy:free"` for answers made
  by the free-mode policy.

### SDK contract and adapter obligations

`SubmitRequest.permissionMode?: "free" | "safe"` is additive and validated (`validateSubmitRequest`).
**Absent means `safe`** (`effectivePermissionMode`), so a third-party caller that omits it gets the
conservative behavior. The engine always sets it. `isUnrestricted(req)` is true for every `free` request.
`enforcesReadOnly(req)` is true only for a readOnly request in `safe` (including absent mode).

An adapter must:

1. For `safe` (or absent): use no bypass/auto-accept setting; route approvals to `respond()`.
2. For every `free` request: start the CLI without approval prompts and without sandbox
   restrictions, using the CLI's documented setting (prefer a documented mode value over a
   `--dangerously-*` alias). Keep the approval channel wired, so a request that still arrives reaches
   the engine.
3. Enforce readOnly only when `enforcesReadOnly(req)` is true; do not strip mutating tools or
   refuse foreign injected MCP servers just because a free request declares readOnly.
4. Keep context isolation independent of the mode.
5. Document both mappings and register them with the conformance kit (`harness.permissionModes`,
   offline check `permission.mode_mapping`). An adapter whose CLI has no approval or sandbox concept sets
   `equivalent` with the reason.

| Adapter | `free` (including readOnly) | `safe` |
|---|---|---|
| Claude (2.1.310) | `--permission-mode bypassPermissions` | `--permission-mode default` (+ `--disallowedTools` for readOnly) |
| Codex (0.159.2) | `thread/start` `sandbox: "danger-full-access"`, `approvalPolicy: "never"` | mapped sandbox (`workspace-write` / `read-only`), `approvalPolicy: "on-request"` |
| Pi (1.1.0) | every requested tool, including mutating/opted-in host tools (no approvals or sandbox) | readOnly drops mutating tools from `--tools` and disables host-tool inheritance |
| Gemini / Antigravity (ACP) | `yolo`; no readOnly tool filtering | Gemini readOnly: `plan`; Antigravity: `default` + readOnly tool filtering and engine policy |

The engine's approval decision (`decideApproval(policy, request, {readOnly, permissionMode})`): `free`
allows everything, including mutating kinds on a readOnly stage; `safe` uses the stage's approval policy
and always denies readOnly mutations.

### Read-only shell commands

An agent with no list, grep or find tool (Antigravity) runs
`ls` or `rg` through its shell tool, which reports every command as `execute`. On a safe readOnly
stage, an `execute` request whose `command` (the exact command line, when the adapter can see
it) is one plain inspection command is judged as `search`. A plain command has no shell
operators, `$`, backticks, unquoted globs or braces, word-initial `~`, backslashes or newlines.
The inspection commands are `cat du file find git grep head ls pwd rg stat tail tree wc`, with git
limited to `status log show diff blame rev-parse ls-files`. Options that write, run another program
or never end are refused per command: `rg --pre/--pre-glob/--hostname-bin/-z`, `tree -o`,
`file -C`, `find -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`, `tail -f/-F`, and
`git --output/--ext-diff/--textconv/--exec`. Everything else stays `execute` and is denied.
The command string must already be plain: the approval handler does not rewrite it.
The approval audit records the command and "read-only command judged as search".

## Preflight: capability, tools, models and effort

Before a run starts, the engine probes the executor (installed, CLI version, login, model list; no
model call) and checks every stage against the executor that would run it. Anything that would
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
- **capabilities** (below);
- **a managed worktree** for a write-capable stage: `check` (not `run`, which fails when the writer starts)
  refuses a working directory that is not inside a git repository or whose repository has no commit yet.

The same check runs alone with `agent-workflow check <workflow> [--executor …] [--model …] …`
(no run). The launch prints it short: the summary line, then each warning once with the stages it
affects:

```text
Capability check (codex@0.1.0, 12 stages, permission mode: free): accepted with 36 degradations
  free permission mode: authored readOnly is not enforced
  ⚠ toolAllowlist.fine — free permission mode: precise tool allowlist unavailable … (all 12 stages)
```

The full per-stage preview stays in `run.capabilityNegotiation.preview` (and `--json`).

Each need is `native`, `emulated`, **degraded** (runs, recorded in `run.capabilityNegotiation`) or
**refused** (nothing starts: `Not started: …`, exit 1, no run record). Typical entries:

| Entry | Meaning | What you can do |
|---|---|---|
| `CAPABILITY_MISSING:toolAllowlist.fine` | The executor cannot enforce the stage's precise `tools` list (Codex). A refusal line reads `(executor has native/probed; …)`: that is the level and source of the base capability `toolAllowlist` (the coarse list), not of the missing `.fine` part. | Accepted in `free`. In `safe`: the stage runs readOnly when the spec sets `allowReadOnlyDowngrade` (`forcedReadOnly`), else refused. |
| `CAPABILITY_WARNING:readOnly` / `:contextIsolation` | Something on this machine weakens the capability (Codex allow rules in `~/.codex/rules`; a global `~/.codex/AGENTS.md` when workers cannot get a private home — keyring login or no credentials). | ReadOnly is not negotiated in `free`; isolation warnings are recorded. In `safe` warnings are recorded; `strictCapabilities` refuses. Remove the rules/file for a clean result. |
| `webTools.safetyPolicy: unknown` | The stage uses the CLI's own web tools; URL, private-network and redaction controls are the CLI's, not the engine's. | Always recorded, never silent. |
| `CAPABILITY_UNVERIFIED:<cap>` | Nobody has verified the capability for this executor; refused by default. | `--allow-unverified <cap>` if you accept it. |
| `CAPABILITY_MISSING:<cap>` (refused) | The executor lacks something the stage requires (for example `mcpInjection` for required reads, `webTools`). | Choose another executor (or install the missing extension). |
| `CAPABILITY_STRICT:<cap>` | Your profile's `strictCapabilities` requires `native`. | Use another profile or executor. |

Capability degradations are recorded and shown on every host, without confirmation.

### Start from a pattern

`agent-workflow new <pattern> <name>` (`new --list` shows the patterns) writes a workflow bundle that
already passes `validate` with no warnings and `rehearse` with no findings: `single`, `foreach-reduce` (items from the task), `inventory-foreach` (items that exist in repo files, each
checked by code against its file: the row's name must occur there), `loop-refine`, `parallel-review-merge`, `classify-count`, `write-verify` (a worktree writer plus a code check of the
files it wrote) and `collect-render` (code only: git history to a Markdown changelog, no model). It carries closed control schemas with
`schema` and `digest`, helpers for the code stages, a `profileRole` on every model stage, a `minItems` and `maxItems` on
every foreach source array, and prompts whose `TODO:` paragraph you replace with your domain instructions;
the generated Contract paragraph and few-shot `<control>` skeleton after it come from the schema. Then
`validate`, `check`, `rehearse` and a cheap smoke run. It never overwrites files without `--force`
([cli.md](cli.md#new)).

### Rehearse a workflow

`agent-workflow rehearse <workflow> [<task...>]` runs a workflow through the real engine with a synthetic
worker instead of a model (the worker calls no model and uses no network; helpers are trusted code and run as
ordinary JavaScript), to catch wiring mistakes that `validate` cannot see: a stage that names `from` sources
but receives none, a required read whose path does not resolve, a foreach that fans out over nothing,
a loop whose `until` never holds, a helper that throws. Every model task gets a deterministic,
schema-valid control from its own control schema and performs its required reads through the real
artifact tool; helpers run for real; run state is temporary. Use `--loop exhaust` to exercise
`onExhausted` and `--items N` to change the fan-out. It does not judge prompts or output quality: a
rehearsal that exits 0 says no wiring fault was diagnosed, not that the wiring is proven or that a model will do the job. Run it after
`validate` and `check` ([cli.md](cli.md#rehearse)).

## Stage model

| Node | Behavior |
|---|---|
| `type: "single"` | One worker prompt; receives the runtime task. |
| `type: "foreach"` | Reads an array from an upstream `control.json` path (`from: {source, path}`) and starts one worker per item (`each.prompt` with `${item}`). |
| `type: "reduce"` | Fan-in over upstream artifacts (`from: [...]`), optional `sourceProjection` inline snippets. |
| `type: "loop"` | Repeats fixed child stages until a deterministic `until`, `maxRounds` or no progress. |
| `type: "dag"` | Container: lowers child stages to namespaced tasks and exposes an `outputFrom` child downstream. |
| `type: "dynamic"` | Trusted bundle-local controller code adds workflow tasks at run time. |
| `support: { uses }` | Runs a bundle-local `.mjs` helper over upstream `control.json` values, in process, no worker. It runs inline: stages that are ready at the same time launch before a helper runs, but a stage that becomes ready while a helper runs waits for it, so keep helpers short. |

Use `foreach.from` for data-driven fan-out, `reduce.from` for fan-in, support `from` for helper
inputs, and `dynamic` only when the work cannot be known before the run. A later plain `single` does
not see earlier output unless it declares `from` or has neither `from` nor `after`: that stage is chained
after the previous declared stage and reads it as a source (not after a loop; see "DAG authoring" below).
Set `injectRuntimeTask: true` on a `foreach` or `reduce` to give its workers the runtime task too.

### What `validate` checks

`validate` rejects specs that cannot run (unknown keys, dangling `from`/`after`, `requiredReads` outside the
stage's own `from`, a control schema with `additionalProperties: false` but no `schema`/`digest`, a loop
`until` path that the final child's closed control schema cannot carry). It also lists warnings, which are
design feedback to fix before the first run:

- a model stage (also loop and dag children, `onExhausted`, dynamic decision-loop profiles) without `profileRole`;
- a `${...}` placeholder that the engine does not substitute (only `${item}` in a foreach `each.prompt`);
- a `single`/`reduce` stage with sources whose prompt forbids tool use (sources are read through `workflow_artifact`);
- a foreach over a model stage's array that sets no `maxItems` (in the array's schema or on the foreach stage) or no
  `minItems` in the schema (`minItems: 1` if empty means failure, `0` if it is fine);
- a loop `until` path missing from the final child's open control schema, and a loop `until` key that the final
  child's prompt does not show as a JSON key;
- top-level stages (not the first) with neither `from` nor `after`: they read the previous stage implicitly (one
  warning per spec names them all);
- a `readOnly` model stage whose prompt forbids running commands (Codex reads files through shell commands; forbid
  effects such as writes, tests and builds instead);
- a model stage outside a `loop` whose prompt asks for its own retries or attempts ("at most 3 attempts", "retry up to
  N times", "until the tests pass") or for depth tiers by item difficulty ("depth cap", "for trivial inspect at most 1
  file"): the engine can neither enforce nor observe them; use a `loop` with a code-decided exit or one stage per tier;
- a write-verify support stage whose `options.files[].path` its writer's prompt (`options.writer`, default `write`)
  does not name;
- prompt/schema drift, a foreach or `sourceProjection` path the source schema lacks, and `readOnly` stages that lose
  tools.

Runtime-only facts (a `requiredReads` path, what a model returns, helper behavior) are not checked; use
`check` and a cheap smoke run for those.

### DAG authoring

Top-level `artifactGraph.stages` is a DAG.

- `from` is a data + order edge: the stage gets a manifest of the source's artifacts and reads them
  through `workflow_artifact`; deterministic decisions read the source's `control.json`.
- `after` is order-only for a model stage (no artifact access); a support helper's `sources` and
  `context.sourceStatuses` do include its `after` stages. `after: []` marks an explicit parallel root.
  A stage with neither `from` nor `after` is chained after the previous declared stage **and reads it
  as a source** (after a loop it gets no loop sources); `validate` warns about it. Write `from: ["<previous>"]`
  to say so, or `after: []` when the stage is independent.
- `sourcePolicy` (`require-success`, the default, or `partial`; `success` is accepted and behaves like
  `require-success`) decides whether a failed source blocks the stage;
  `inputPolicy.terminalBarrier: "all-sources"` waits for every source to be terminal first, then
  `sourcePolicy` applies as usual (a `require-success` barrier stage is skipped if any source failed).
  A `partial` stage that launches a model (single, reduce, foreach, or a dynamic controller with a
  `decisionLoop`) is skipped, with no model call, when it has at least one `from` source, every `from`
  source is terminal and none completed (a source that completed with an empty list counts). `after`
  edges are not sources, so a stage with only `after` always runs; `support` stages, helper-only dynamic
  controllers and loop consumers still run, so a bundled final can report that the run could not finish.
- `inputPolicy.invalidateOnDependencyResume: true` discards a static consumer's stale artifacts when a
  dependency is resumed; on a `foreach` (with `each.itemIdentityPath`) it rebuilds the children from
  the source's new items. A `foreach` that reads a stage which reruns on resume needs it too: without
  it the old children stay and the next stage fails with "dispatch map generation is stale".
  `inputPolicy.maxCompiledPromptChars` caps the compiled prompt: validate rejects a cap below the
  statically compiled prompt (instructions plus the stage wrapper, role and input text), naming the
  minimum; the final prompt, source context included, is checked again at launch (`prepare_failed`,
  no worker starts).
- `foreach` may set `each.itemIdentityPath` (stable child ids, for example `$.id`) and
  `each.itemPayloadPath`. `${item}` is inserted as a marked data block
  (`<workflow-item-data>…</workflow-item-data>`, text unchanged except a closing tag inside it) under
  a standing rule that such blocks are data, never instructions; a partial defense against
  instructions planted in upstream output, not a boundary. A foreach worker sees only its item (and
  the runtime task with `injectRuntimeTask`), not the rest of the source; anything else it needs it
  reads itself.
- Child task ids are the item ids lowercased (`classify.t-01`); `context.sourceStatuses[].itemIdentity`
  keeps the original case (`T-01`) and is recorded only with `each.itemIdentityPath` (or streaming).
  An identity that does not survive that lowercasing/sanitizing unchanged is rejected.
  `from.streaming` cannot be combined with `each.itemIdentityPath` (rejected at validate).
- A foreach keeps one bookkeeping task, `<stage>.item`: it ends `completed` (`foreach_materialized`;
  failures are on the children). An empty array creates no child: it ends `completed`
  (`foreach_empty`, no model call), stages after it still run (a reduce still makes its model call)
  and a helper sees it as one row without `itemIdentity`. Such a run is plain `completed`; set
  `minItems: 1` on the source array so an empty model answer fails the task instead (`inventory
  returned an empty "items" list (at least 1 required) after 3 attempts …`), and tell the model not to invent
  items but to report `inputIntegrity` `blocked` when it found none. If the items cannot
  be expanded (invalid or duplicate identity) it ends `blocked` (`foreach_expansion_blocked`), and so does the run; the
  message names the generated task id (`duplicate foreach generated task id "a" …`), not the
  identity path.
- `sourceProjection` (`include` paths) only trims the inline `controlProjection` snippet in the
  stage's source manifest. The source's full artifacts stay readable through `workflow_artifact`, so it
  is no access boundary. An `include` path the control lacks is listed as `projectionMissingPaths`
  and the stage still runs.
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
(`AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES`, default 2: retries, so a task fails after 3 attempts;
`tasks[].outputRetry` records `attempts: 3`, `maxAttempts: 2`, and each invalid attempt leaves
`raw.invalid-attempt-N.md` and `result.invalid-attempt-N.json` in the task directory). Every "output retries" counter (`Output retries:` in the terminal
summary, `outputRetryAttempts` of `wait`, `inspect`'s `retries: output=`, run telemetry and metrics) counts retries, the attempts
after the first: 2 for that task, 0 with `AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES=0`, never the final exhausted attempt. Before retrying, a few breaks are repaired and
recorded on the attempt: invalid JSON escapes inside strings (`json_invalid_escape`), and a `<control>` whose only
defect is the root object's missing closing brace — every inner container closed, no string open — when the stage's
`output.controlSchema` requires every root property it declares, allows no others, and the closed control passes it
(`json_missing_closers`). Under the same schema condition, a markup tag such as `</synthesis>` standing between JSON
tokens, outside every string, is removed (`json_stray_markup`). An open list or inner object is never completed,
other stray text is kept, and without such a schema the control stays invalid. `control.digest` is required and bounded by
`output.maxDigestChars`. `output.analysis.required: false` / `output.refs.required: false` make those
sections optional. When quoting a whole protocol response inside analysis, write `&lt;control>`.

`output.controlSchema: "./schemas/x.schema.json"` (relative to the spec) validates `control.json`
with a JSON Schema subset: `type`, `required`, `properties`, `items`, `enum`, `const`,
length/item/number bounds, `additionalProperties`, simple `allOf`/`anyOf`/`oneOf`. `$ref`, `$defs`,
`definitions` and `pattern` are rejected at load time. String lengths count code points. When the
schema pins `control.schema` with `const` or a one-value `enum`, the Workflow Output Protocol the engine appends
names that value, so the prompt need not repeat it (a larger `enum` still needs the value in the prompt). A root
`required` array with `minItems >= 1` that a `foreach` stage fans out over (its `from.path` starts with that key)
also adds one sentence to the protocol: do not invent items, report
`control.inputIntegrity` `blocked` instead (not added for lists no foreach reads; left out when the stage prompt already mentions `inputIntegrity`).

**Partial output for streaming foreach.** A producer may declare `output.partial.paths: ["$.items"]`
and publish stable items early in standalone `<partial-control>{"schema":"workflow-partial-output-v1",
"path":"$.items","items":[...]}</partial-control>` blocks; a `foreach` opts in with
`from: {source, path, streaming: {enabled: true, minChunk: 2}}`. Published items need a string `id`
and must not change in the final control. Downstream reducers still wait for every item.

**Task runtime limit.** A model task that exceeds its `maxRuntimeMs` (default 30 minutes; set per stage,
profile or `defaults`; `0` = no limit) is stopped and ends `failed` with `statusDetail: "timeout"`. Whatever
the worker had written is kept in the task's `output.log`, and `result.json` records `timedOutPartial`
(`outputBytes`, `validated: false`); the failure message names it. That text is evidence only: it is never
validated into a control or output artifact, so downstream stages and reports see an ordinary failed source.

### Support helpers

A support stage declares `support` and omits `type`; any `type` (including `"support"`) is rejected
at validate (`must be omitted when support is declared`).

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
`.agent-workflow/evidence-cache/` in the [state directory](#where-run-state-lives) (1 GiB, 24 h), and returns per quote `verified-captured`,
`verified-refetched` or `unverified` with a reason. deep-research uses it in its `check-web-quotes` stage: the final report's
audit summary gets a "Quote check" line and `audit.md` lists every quote that could not be checked.
`audit-claims` reads it too: a verified claim whose web quotes were all looked for on a fetched,
readable page and not found there is downgraded to `partially_supported` (`web_quote_not_on_page`);
a quote the engine could not check (fetch failed, unsupported media, too little text) changes no
verdict. Each page body the check read is kept with the run (`evidence/pages/<sha256>`, write-once) and
listed in the results (`page.stored`), so the check can be repeated later against exactly that text
(`recheckWebQuotesFromStore`; a URL without a kept body reports `not-stored`).

### Loop behavior

A `loop` stage repeats at least two child stages (`single`/`reduce`, run in order) per round, with
runtime ids such as `fix-loop.r01.check`. Children must not declare `from`/`after`: each child
sources the earlier children of its round, and the first child of a later round gets the previous
round plus a `# Loop Carry-Forward Context` block (only that first child gets it, so the final child
that `until` reads never sees it; every child gets a `# Loop Round` block with `loop`, `round` and
`childStage`). A `support`, `foreach`, `dag`, `dynamic` or `loop` child is rejected at validate.
Required: `id`, `maxRounds` (a positive integer, or `null` for no cap), `until` (must reference the
final child: `{"stage": "<final-child>", "path": "$.field", "equals": true}`, predicates `equals`, `notEquals`, `lengthEquals`, `exists`,
combinators `all`/`any`). A loop ends `completed` (until true), `exhausted` (positive `maxRounds`
used up), `stopped_no_progress` (the `progressPath` metric, default `$.blockingFailures`, did not
decrease; omitted `progressPath` on an unlimited loop disables this) or `failed`. Only `failed`
fails the loop task; `exhausted` and `stopped_no_progress` end it `completed` (`loop_exhausted`,
`loop_stopped_no_progress`), so the run can still complete. An unlimited loop ends `failed` after
any round with a non-completed child; a bounded loop retries in the next round, but ends `failed`
(not `exhausted`/`stopped_no_progress`) when the last round it runs has a non-completed child. Failed, skipped or interrupted tasks of an earlier round of a loop that did not end `failed` are superseded by
the later round: they stay in task lists and `taskSummary` counts and add to the run's degradation note, but do not
decide the run status (the final round and a `failed` loop still do). An optional
`onExhausted` stage runs once on exhaustion or no progress, never when the loop ends `failed`. There is no auto-merge of worktree output
(see "Worktrees" under Retention).

A `single`, `reduce` or `support` stage that names a loop in `from` receives the outputs of every
child of the loop's last executed round, as sources named `<loop>.<child>` (for example
`fix-loop.check`; `requiredReads` use the same names). A `single`/`reduce` also gets a `# Loop Results`
block (`status`, `roundsUsed`, `rubricMet`, `finalCheck`), so a consumer can tell that an `exhausted` or
`stopped_no_progress` loop did not meet its rubric. A `support` helper has no prompt, so it gets no such
block: each of its `context.sourceStatuses` rows for a loop child carries `loop: { loopId, status,
roundsUsed }` instead. A `failed` loop is an ordinary failed source under
the consumer's `sourcePolicy`; `after` stays ordering-only. `foreach`, `dynamic`, `dag` and `loop`
stages cannot read a loop (rejected at validate).

### Roles

Top-level `roles` declare reusable context injected as a `# Role Context` block: `fromAgent`
(extract safe sections of an agent's markdown), `includeSections` / `excludeSections`, `prompt`
(literal text) and `maxChars` (default 12000). A stage selects roles with `role`; `foreach` uses
`each.role`. `agent-workflow roles <workflow>` shows the compiled text. `profileRole` is a separate
classification for execution profiles, not a context role.

### Tool allowlists

`tools` (agent frontmatter < `defaults.tools` < stage `tools`; the most specific list wins) names
built-in tools: `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, `edit`, `write`,
`bash`. Other names are custom tools; `workflow_artifact` is the
[artifact MCP tool](#artifacts-and-required-reads). Each executor maps them (Claude: `Read`, `Grep`, `Glob`,
`WebSearch`, `WebFetch`; Codex: its shell and sandbox, hosted `web_search`; Pi: the same names) and
the engine tells the worker the mapping in its system prompt. The agent's frontmatter `tools` are the
ceiling: a spec cannot grant a tool the agent did not declare. Object entries
(`{name, classification, optional, fallbackTools}`) describe custom tools; unclassified custom tools
are blocked. `readOnly: true` is authored intent used by compilation, scheduling and worktree policy, not
filesystem isolation. Only `safe` enforces it at the executor (read-only tools/sandbox where available);
`free` removes no tool for `readOnly` and sets no sandbox, but the compiled tool list is still passed
where the CLI takes one (Claude `--tools`: the worker has only those built-in tools). Codex has only
its coarse sandbox.

**Write-capable stages.** A stage that is not `readOnly` and keeps a mutating tool (`edit`, `write`,
`bash`; the agent's frontmatter must declare it) can change files. Where it writes is the stage's (or
`defaults`') `worktreePolicy`: `"auto"` (default) and `"on"` give each write-capable task its own
managed git worktree (`.agent-workflow/workflows/<run>/worktrees/<task>` in the
[state directory](#where-run-state-lives), branch
`agent-workflow/<run>-<task>`); `"off"` writes in the shared checkout in `free` mode only — `safe`
still uses a worktree unless the run sets `allowSharedCheckoutWrites` ([permission modes](#permission-modes)). There is
no auto-merge: the user reviews and merges the branch (see "Worktrees" under Retention). A worktree
needs a git repository: outside one a task that needs a worktree does not start (`managed worktree
required … is not inside a git repository`); only `"off"` in `free` mode writes in the live
directory there. A later stage does not see
a worktree's changes through the project files, so put the check where the change is: let the
writing task run the build or tests in its worktree and report the result in its control, or give a
separate verification stage that worktree's path. Workers never commit.

### Local review evidence

Local review citations are checked against repository bytes. Unique matches can receive recorded
corrections for positions at most 10 lines away, whitespace/line endings, quote/dash/space folding,
soft-wrapped lines, and omitted inline-code/emphasis markers in Markdown files. Different words,
ambiguous matches and invalid UTF-8 still fail. Reports list Evidence corrections. See
the reader boundaries and source accounting below.

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
`covered`; any other answer stays `unclear` and is shown beside it in the coverage table.
`needsHuman` rows are not rechecked. The renderer rereads the source chain and rechecks citations before `passed`. `deep-review` applies the
same idea to reviewer `sourceCoverage` (`read`, `ocr-extracted`, `metadata-only`, `unreadable`):
a required source the reviewer could not verify sends that reviewer's findings in that file to
`needsHuman` (a failure that names no planned file holds back all of its findings); its findings in
verified files keep their verdict. The gap is listed in the report, and a review left without
kept or weakened findings is `PARTIAL_REVIEW`.

## Artifacts and required reads

Workers read upstream artifacts through one MCP tool, `workflow_artifact` (`list`, or `read` with
`source`, `artifact` = `control`, `analysis`, `refs`, `raw`, `prompt`, `system-prompt`, `stderr`,
`result`, optional `path` / `maxItems` / `maxChars` projections, or `offset` for paging). Prompts
name it `workflow_artifact`; the engine renders the name each executor shows its model
(`mcp__workflow_artifact__workflow_artifact` on Pi, Codex and Claude Code). Every read appends a row to
the task's `read-ledger.jsonl`. Details: [`mcp.md`](extending.md#workflow-artifact-mcp-server).

`inputPolicy.requiredReads` (with `enforcement: "fail"`) makes a stage prove it read named
artifacts before its output is accepted. A string entry (`"plan.control"`) requires a complete read;
an object entry can require a `path` projection with `maxChars`/`maxItems` and an exact `count`.
Truncated reads never count. A required read must name one of the stage's own sources (its `from`; `after` is ordering-only and adds none), and a `path` must resolve in that artifact, or the read stays missing. Direct file reads do not satisfy it: the ledger proves artifact access,
not semantic use. It also proves delivery to the executor, not what reached the model: an executor
whose model reads tools through scripts (Codex `gpt-5.6-luna`, [code mode](executors.md#codex))
may pass on only part of a large batch of reads. A stage whose required reads stay missing after its repair retries fails
(`required_reads_missing_exhausted`).

**Input integrity.** A stage may report in its control whether it could use its inputs:
`"inputIntegrity": {"status": "complete"}` or `{"status": "blocked", "reason": …, "detail": …}`
with `truncated_read`, `missing_read`, `inconsistent_input` or `budget_block`. Once the required
reads passed, the ledger proves every one was delivered complete, so a `truncated_read` or
`missing_read` block is a misjudgment: the engine repeats the attempt with that evidence and fails
the stage if the claim persists (`input_integrity_contradicted_exhausted`). `inconsistent_input` and
`budget_block` are about content, which the engine cannot judge: such a block is accepted as the
worker's blocked handoff and the stage fails with `input_integrity_blocked` (the output is kept as
`raw.invalid-attempt-N.md`), so a run never completes on a result its author declared unusable;
`resume` reruns the stage, and a repeated block points at the stage's input. deep-research's final
audit requires the field, and its renderer refuses a blocked synthesis for the same reason. The
block is also a model's honest exit from a list it cannot fill: it is honoured before the schema
check (an empty `items` under `minItems: 1`, or a closed schema without the field, fails once with
`input_integrity_blocked` and the model's `detail`, not a retry), so tell the model to report it
instead of inventing items.

**Paging.** Each executor's CLI cuts long MCP results (Pi 1.1 at about 20 KB, Claude at 22,500
chars, Codex at about 32,000 chars). The engine starts the artifact server with a limit below the
executor's measured cut, so nothing is cut silently: a whole-artifact read that does not fit is
served page by page, each response ending with `[workflow_artifact page: chars X–Y of N; call again
with offset=Y to continue]`. A required whole-artifact read is satisfied once page rows of the same
artifact version cover every character; the failure message names missing ranges. Projected reads
are not paged: when one does not fit it is cut, marked `deliveryUnverified`, and does not count;
re-read with a narrower `path`/`maxItems`/`maxChars`.

## Run records

### Where run state lives

Each project has a private state directory at `$AGENT_WORKFLOW_HOME/projects/<project-id>/`
(default `~/.agent-workflow/projects/<project-id>/`), with mode `0700`. The project id is a
lowercased folder-name slug plus the first 12 hex digits of the SHA-256 of the canonical
(realpath) project path, for example `my-app-2292b65412f1`. A renamed or relocated project,
or a second clone, is a separate project. `project.json` (mode `0600`) records `schema`, `id`,
`path`, `name`, `createdAt` and `lastSeenAt`; a different registered path is refused.

Paths shown as `.agent-workflow/…` in run output, records and logs are relative to this state
directory, not the repository. It holds run records and worker artifacts (below), plus
`.agent-workflow/notify-check/`, `.agent-workflow/host-launches/`, `.agent-workflow/evidence-cache/`,
`.agent-workflow/workflows/unfinished-notices.json`. Auto-router runs and managed worktrees
also live here. Workers still run in the project directory or its managed worktree. One user-level dashboard serves all registered projects. Its private files are
`<home>/dashboard.json`, `<home>/dashboard-session`, `<home>/dashboard-port` and the start lock
`<home>/dashboard.lock`, not per-project state (`<home>` = `AGENT_WORKFLOW_HOME` or `~/.agent-workflow`).
It defaults to port 7417, then 7418–7426, then ephemeral; explicit `--port` /
`AGENT_WORKFLOW_DASHBOARD_PORT` is strict. Custom homes reuse the last port or use an ephemeral one.
`dashboard --project DIR` chooses only the opened view. The sidebar offers All projects and a
remembered project choice. Project navigation separates Overview, Workflows and Run history from shared
Executors in a footer after the Run rows. Old `view=profiles` links open Executors. Workflow settings edit one project/source draft for future Runs; existing Runs show
recorded model/effort and executor-reported model/usage separately, with unknown values left unknown.
Overview's Last result links the exact Run/report, separately from future workflow settings.
Run history opens the rich Run list beside the current/latest eligible Run, with graph, results, logs and
reports. Its secondary **Delete run records…** action in the Run-list **⋯** controls (legacy `view=history`) deletes only explicitly
selected terminal IDs after a resource/digest confirmation; owned
worktrees (including dirty changes) and supported engine-owned sessions may be removed, with no
guaranteed undo. Broad keep/age cleanup is separately labelled Advanced maintenance.
See [Dashboard](hosts.md#dashboard) for scope, identity, security and lifecycle.

Definitions stay in the repository: `<project>/workflows/`,
`<project>/.agent-workflow/workflows/` (specs) and `<project>/.agent-workflow/agents/`.
Old `<project>/.agent-workflow/workflows/workflow_*` run directories are ignored: they are
not listed, resumed or migrated, and you may delete them. A launch from the directory holding
the user-level `~/.agent-workflow` uses `~/.agent-workflow/home-runs` as its project and worker
cwd; that project has its own state directory by the same rule.

Run files, relative to the project's state directory:

```text
.agent-workflow/workflows/<run-id>/
  run.json             run record: status, tasks, executor, permission mode, capability negotiation,
                       code revisions, usage
  spec.json, compiled.json, bundle/   what the run executes
  supervise.log        detached supervisor log (--detach)
  tasks/<task-id>/     task.md, system-prompt.md, control.json, analysis.md, refs.json, raw.md,
                       read-ledger.jsonl, source-manifest.json, artifact-access.json, result.json,
                       output.log, stderr.log
.agent-workflow/worker-runs/<run-id>/<task-id>/<runtime-run>/attempts/<attempt>/
                       worker.json, executor.json, authority.json, control/, exec-events.jsonl,
                       raw CLI logs, the adapter's invocation record (Claude: claude-invocation.json),
                       result.json
```

**Task ids.** `tasks/task-N/` is the task's position in `run.json` `tasks[]`, whose `specId` names the
stage: `<stage>.main` (single, reduce, support), `<stage>.item` (a foreach's bookkeeping task) and
`<stage>.<item-id>` (its children), `<stage>.controller` (dynamic), `<loop>.loop` (a loop's
placeholder), `<dag>.<child>.main` (a dag's children). A foreach or loop expands at run time, so a
run has more tasks than the `Tasks:` count `validate` prints (a foreach or loop counts once) and than
`run --json` `data.taskSummary`, a launch-time snapshot: the final state is in `data.wait` and
`status`. Before `resume` resets a task it appends an entry to `tasks[].resumeEvents[]` (`at`,
`fromStatus`, `fromStatusDetail`, `lastMessage`, worker run and attempt ids, retry counts), which is
where an interrupted attempt stays visible.

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
subscription: see [support matrix](#support-matrix). Each attempt also records `peakContextTokens`,
the largest prompt one model call saw (input + cache-read + cache-write tokens), with `usageEvents`;
the task aggregate keeps the largest. Pi reports one event per assistant message and Codex the largest
request of each turn, so there it is a per-call peak; Claude reports one event per attempt, so there it
equals the attempt's whole input side. Not summed into any total.

**Code revisions.** Each run records, at launch, `run.codeRevisions`: the engine `version` (plus its
`checkout` state when it runs from a git checkout of itself, read once per process) and the `target`
state of the run's repository: `head`, `branch` (absent when detached), `dirty`, `statusSha256`
(SHA-256 of `git status --porcelain=v1 -z`: changed, deleted and untracked paths) and `diffSha256`
(SHA-256 of a canonical `git diff HEAD --binary`, independent of your diff settings: tracked
content changes; untracked file contents are not included). Outside a repository it is
`{"repository": false}` and no git command runs. Only hashes are stored, never file content or
remote URLs. Git runs with fsmonitor off, without optional locks, external diff or textconv
commands, and with a 5 s limit per command; a failure or timeout is listed under `issues` and never
blocks the launch. Nested runs keep their parent's record; runs created before this have none.

**Worker sessions.** By default no worker keeps a CLI session: workers run without session
persistence (Claude `--no-session-persistence`, Codex ephemeral threads, Pi `--no-session`), and output
repairs, launch retries and resumes start fresh attempts. Only the experimental same-session repair
(`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`) requests kept sessions. Only such a run negotiates
`resume` before launch. Sessions the engine did
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
and never hold back the pruning of runs.

What prune removes and what it keeps:

- Nothing is listed or deleted when `.agent-workflow` or `.agent-workflow/workflows` is a symlink
  or otherwise not a real directory inside the project's state directory; prune reports `unsafe retention root`.
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
  recommendation is `routing-unavailable` and no classifier is called; only a
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
The run's attempt state stays in the project's state directory; run state is not copied
into a worktree. To remove one yourself:
`git worktree remove <path>` (add `--force` to discard uncommitted changes) and
`git branch -D agent-workflow/<run>-<task>`. `agent-workflow prune` includes them: the dry run lists
each worktree of a run it would delete with its branch, `uncommitted changes` and the number of
commits on the branch that your checkout's HEAD does not contain; `--yes` removes them
(`git worktree remove --force`, so uncommitted changes in them are discarded only with `--yes`).
Prune touches a worktree only when agent-workflow created it for that task or loop: the
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
`~/.agent-workflow/executors/{claude,codex,pi}/attempts/`. Terminal attempt records
older than 7 days are removed with their event logs and per-attempt dirs, in the background when a
worker is submitted (at most every 6 h) and by `agent-workflow prune` (same dry-run rule;
`--older-than DAYS` sets the window). Records of attempts that may still run are never removed.
An attempt that was launched leaves a small tombstone in place of its record (never
pruned), so a later reconcile reports it as "launched, outcome unknown or as recorded" and never
as "never started": nothing is retried automatically.

Attempt cleanup refuses symlinked ancestors (including `attempts/` and Pi `runs/`). Orphans are
removed only when named with the adapter's attemptKey hex digest (Claude 40, Codex 32, Pi 64
characters), alone or with `.events.jsonl`, `.log` or an atomic-write temp suffix. Other files
are left untouched.

## Support matrix

Hosts call the shared host API; workers run on the executor selected for each stage. An explicit
run choice takes precedence over profiles and host defaults. See the generated
[bundled workflow support table](#support-table) for capability negotiation in
`free` and `safe` modes.

### Verified CLI versions

| Executor | Adapter | Verified CLI | Documentation |
|---|---|---|---|
| `pi` | 0.1.0 | Pi 1.1.0 (minimum 1.1.0 for native MCP) | [Pi](executors.md#pi) |
| `codex` | 0.1.0 | codex-cli 0.166.0 | [Codex](executors.md#codex) |
| `claude` | 0.1.0 | claude-code 2.1.322 | [Claude](executors.md#claude-code) |
| `antigravity` (experimental) | ACP adapter | `agy_acp_server` 1.4.5 | [ACP](executors.md#antigravity-acp) |

These versions were checked on macOS. SDK contract: `0.1.0`. `probe()` notes a CLI version that
differs from the verified version; run the [conformance kit](extending.md#conformance-kit) before relying on it.
Authentication is the CLI's own login.

### Hosts

| Host | Integration | Default executor | Worker executors |
|---|---|---|---|
| Pi 1.1.0 | [Extension](hosts.md#pi), `/aw` commands and `aw_*` tools | `pi` | pi, codex, claude; experimental antigravity |
| Claude Code 2.1.318 | [Plugin](hosts.md#claude-code-and-codex) or [host MCP server](hosts.md#claude-code-and-codex) | `claude` | pi, codex, claude; experimental antigravity; mixed roles |
| Codex 0.166.0 | [Plugin](hosts.md#claude-code-and-codex) or [host MCP server](hosts.md#claude-code-and-codex) | `codex` | pi, codex, claude; experimental antigravity; mixed roles |
| Terminal CLI | `agent-workflow` | First installed and logged-in of pi → claude → codex | Any registered executor |

MCP hosts use `workflow_*` tools. Pi uses `aw_*` tools and `/aw` commands. All worker executors must
be installed and logged in before launch; mixed runs probe each executor once.

| Host | Progress and completion | Limits |
|---|---|---|
| Pi | Footer, run board, one completion message | RPC, print and JSON modes use text commands instead of the board |
| Claude Code | `workflow_wait` / `workflow_status`, optional status line and prompt hook, terminal `agent-workflow watch` | Print mode (`-p`) cancels elicitation, so actions requiring a dialog cannot obtain consent there |
| Codex | `workflow_wait` / `workflow_status`, interactive-session completion wake, optional prompt hook, terminal `agent-workflow watch --bell` | `approval_policy="never"` auto-accepts empty confirmation forms and cancels enum forms; use `on-request` to be asked |

Interactive Codex runs linked through MCP wake the host with `codex queue` once on settlement;
`codex exec` uses polling instead. `AGENT_WORKFLOW_HOST_WAKE=0` disables wake delivery. A result
already received through `workflow_wait` is not delivered again.

### Offline matrix

See the [generated support table](#support-table) for both permission modes and both
deep-research specs.

A domain verdict such as `NEEDS_WORK`, `GAPS_FOUND` or `BLOCKED` describes the reviewed target, not
an executor failure. A final verdict gate may still mark the run `failed`; hosts present a declared
verdict with an existing in-run report as “finished — verdict: X (report ready)”.

### Known limits per executor

Full adapter limits: [Pi](executors.md#known-limits), [Codex](executors.md#known-limits-1),
[Claude](executors.md#known-limits-2), [ACP](executors.md#antigravity-acp).

| Executor | Limits |
|---|---|
| Pi | No approvals or sandbox: both modes keep requested tools except safe readOnly removes mutating tools. `sessionBound`: cannot re-attach after the owning process dies. Deep-research needs `pi install npm:pi-web-access`. Cost is a catalog estimate, including on subscriptions. Fast tier remains unverified and requires `allowUnverifiedCapabilities: ["fastTier"]`; guard failure is `config`, degradation is `payload-only`, recorded in `pi-fast-tier.json`. |
| Codex | Only a coarse tool allowlist. `free` records precise-list degradation; `safe` forces readOnly if the spec permits, otherwise refuses. Isolated workers run in a private `CODEX_HOME` (linked auth/config/rules, no global `AGENTS.md`) when the login is file-based; otherwise the global `AGENTS.md` and rules cannot be disabled per run and the probe warns about weakened isolation/readOnly. Tokens only: cost is `null`, never `0`. Hosted `web_search` has no separate fetch. `fetch_content`, `grep`, `find`, `ls` mappings and token-refresh contention are unverified. See [run records](#run-records) for attempt-record retention. |
| Claude | `sessionBound`: lost stdio requires a reconcile decision. The CLI auto-allows reads inside cwd and read-only Bash commands. The full environment is inherited; `ANTHROPIC_API_KEY` selects API-key billing. Cost is `total_cost_usd`, notional on subscriptions. The runtime, not the adapter, enforces timeouts. |
| Antigravity | Experimental; capabilities remain `declared`. Workspace `AGENTS.md` / `GEMINI.md` are not isolated. No session ownership or resume. |

### Shared limits

- CLI browsing safety limits are described in [capability preflight](#preflight-capability-tools-models-and-effort).
- See [run records](#run-records) for normalized usage, cost and worker-session retention.
- Pi executors may inherit opted-in native host codemode/MCP tools even for free readOnly requests;
  safe readOnly requests never do. The engine still uses authored intent when preparing host-tool policy. Project `.pi/mcp.json` servers do not reach workers. Other executors'
  user-MCP inheritance is a separate opt-in.
- See [roles, presets and mixed runs](#roles-presets-and-mixed-runs) for per-stage negotiation
  and model availability. A run-level `--model` is not checked against the probe's model list.
- Host text carrying worker output redacts structured credentials and home paths.
  See [discovery and artifact boundaries](#where-workflows-are-found) for log-read restrictions.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Not started: no executor is usable` | No `--executor`/profile chose one and none of `pi`, `claude`, `codex` is installed and logged in. The message lists each CLI's state and its install or login command; `agent-workflow doctor` shows the same. |
| `Not started: … EXECUTOR_NOT_INSTALLED` / `EXECUTOR_AUTH_NOT_READY` | The executor CLI is missing or not logged in. The message names the install command or the login command (`pi` then `/login`, `codex login`, `claude auth login`; antigravity: sign its worker home in once, `docs/executors.md#antigravity-acp`); or pick another `--executor`. Every executor a run uses is checked before anything starts: a mixed run lists each one it cannot use with the stages that use it (`2 executors this run needs cannot be used: …`). |
| `Not started: … CAPABILITY_REFUSED` | A stage needs something the executor cannot do. The message lists each refusal and its opt-in, if any (`--allow-unverified`, `allowReadOnlyDowngrade`, `--permission-mode free`). |
| deep-research refused on Pi with `webTools` | Your Pi has no `pi-web-access` (not bundled). Install it with `pi install npm:pi-web-access` (check with `pi list` or `agent-workflow doctor`), or use `--executor claude`/`codex`. The refusal and the preview name the same command. |
| Provider-policy `CAPABILITY_WARNING:contextIsolation` in `check` / `doctor` | Codex forbidden/prompt rules or managed requirements, or Claude managed bypass/deny/ask settings (or root execution), can block auto-approved workers. Read the count/path and suggested remedy; review managed policy with your administrator or select a compatible executor/profile. Free mode records warnings; it does not override provider policy. See [executor preflight](executors.md#environment-probe). |
| Codex `executor_config`: effective permissions differ from the request | Codex changed the requested sandbox/approval policy or returned unexpected profile provenance, likely due to managed requirements. The attempt stopped before a model turn. Check requested/effective values in executor events and startup warnings in `codex-app-server.jsonl`; ask your administrator to permit the mode or use a compatible executor/profile. |
| A run completed but a command did not execute | Provider denials do not automatically fail the run. Inspect `exec-events.jsonl` for denied tool calls: Codex verified execpolicy stderr rejections and Claude permission-denied events are normalized there. Raw provider transcripts retain more context. |
| Codex runs show `readOnly`/`contextIsolation` warnings about allow rules/global instructions | Your `~/.codex/rules` has allow rules or a global `~/.codex/AGENTS.md` exists. Review them for a clean run; these are separate from provider blocking rules. |
| A workflow or agent from `~/.pi/agent/` is missing in `agent-workflow list`/`agents` | By design: Pi's directories are Pi configuration and are not read. Copy what you want into `$AGENT_WORKFLOW_HOME/workflows/` or `…/agents/` (or the project's `.agent-workflow/`), or pass a spec path. |
| `input <key> is not declared by this workflow (declared: …)`, `input <key> must be a number` (exit 2) | `--input` / `inputs` names a key the spec does not declare or a value of the wrong type. Use a declared key (`agent-workflow show <workflow>` shows `input`) and a value of the default's type. |
| Usage shows `cost unknown` | The executor reported no cost (Codex always; any task without a cost). Token counts are still recorded; nothing is estimated. |
| The run is `failed` but the report looks fine | A final render declares failure (`support_declared_failed`) when the review could not be completed — deep-review `PARTIAL_REVIEW` without confirmed findings, spec-review `INCONCLUSIVE`; the report says what is missing. Verdicts about the target (`NEEDS_WORK`, `GAPS_FOUND`, impact-review `BLOCKED`, or `UNKNOWN` when the evidence is insufficient) finish the run normally. Read `final-report.md`. |
| A task failed with `required_reads_missing_exhausted` | The worker did not read every required artifact (or only part of a paged one). `inspect <run> --failures --results` shows which; `resume` retries. |
| A task is `blocked` with `executor_needs_decision` | After a crash the executor could not prove whether the attempt ran. Nothing retries automatically. Check the CLI's own state, then `resume` (new attempt) or `stop`. |
| `wait` returns `stillRunning` | The bounded wait ended; call `wait` again, or use `--detach` and check later. |
| `stop` says pending (exit 1) | Another supervisor owns the run and did not confirm within 15 s; it applies the durable stop intent. Check with `agent-workflow status <run>`. |
| The CLI prints a test-executor warning or exits 2 on every command | `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` is set; unset it (test-only hook). |
| Changed a bundled workflow but the run still uses the old one | Runs execute their copied `bundle/`; start a new run. |
| `resume` of an older run stops with `launch-bootstrap provenance is malformed` | A rebuilt `foreach` child of that run had a launch retry, output repair or resume under an earlier version, whose session ids did not carry the rebuild generation. The check refuses those records rather than guess, and they are not migrated; start a fresh run. Runs without rebuilt children are not affected. |

## Environment variables

Every `AGENT_WORKFLOW_*` variable that the package reads (`src/`), what it does and its default,
followed by the variables only the test suites and release tools read. Set user controls before you
start the CLI, the Pi host or a detached supervisor: child processes (durable workers, supervisors,
the artifact MCP server) inherit them. None of these variables grants a worker more tool authority or
weakens an evidence gate.

Boolean flags marked "flag" are on for `1`, `true`, `yes` or `on` (case-insensitive) and off
otherwise.

### Supported configuration

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_DASHBOARD_PORT` | Strict user-dashboard port override (1–65535). Custom homes otherwise reuse the last port or select an ephemeral port. | `7417` (default home; fallback 7418–7426, then ephemeral) |
| `AGENT_WORKFLOW_DASHBOARD_AUTH` | Exactly `1`: dashboards started without `--auth` (including auto-started detached ones) require the browser sign-in session instead of the default open loopback mode. | off |
| `AGENT_WORKFLOW_DASHBOARD_AUTOSTART` | Exactly `0` disables detached dashboard auto-start after successful run/dynamic/auto launches; worker roles and read-only contexts never auto-start. Does not open a browser. | on |
| `AGENT_WORKFLOW_DASHBOARD_IDLE_MS` | Detached dashboard idle exit interval (milliseconds); no SSE clients and no running/blocked run in any project. Minimum 60000; invalid values are usage errors. Foreground dashboards never idle out. | `7200000` (2 h) |
| `AGENT_WORKFLOW_DASHBOARD_POLL_MS` | Dashboard polling interval; accepts 500–10000 ms with a 1000 ms minimum effective interval. | `1000` |
| `AGENT_WORKFLOW_DASHBOARD_OPEN` | Exactly `1`: open a dashboard after CLI run/dynamic/auto launches on a terminal; suppressed in agent environments. Explicit `--open` overrides suppression and non-TTY checks. | off |
| `BROWSER`, `BROWSER_ARGS` | Program (and extra arguments) used to open dashboard URLs instead of the platform opener (`open` / `xdg-open` / `rundll32`); `BROWSER=none` opens nothing. Vite/Jupyter convention. | platform opener |
| `AGENT_WORKFLOW_CODEX_REQUIREMENTS_PATH` | Codex preflight/doctor requirements file override for hermetic diagnostics; does not change the provider's policy or effective-mode check. | `/etc/codex/requirements.toml` (Unix); `%ProgramData%/OpenAI/Codex/requirements.toml` (Windows) |
| `AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH` | Claude preflight/doctor managed-settings file override for hermetic diagnostics; does not change the provider's policy. | Platform managed-settings path; see [executors](executors.md#managed-policy-preflight) |
| `AGENT_WORKFLOW_AGY_ACP_SERVER` | Antigravity ACP server command override. | `agy_acp_server` on PATH |
| `AGENT_WORKFLOW_HOST_WAKE` | `0` disables completion messages queued into the interactive Codex session that launched a run through MCP. Already reported states do not wake the session. | on |
| `AGENT_WORKFLOW_LOGIN_SHELL_PATH` | `0` disables importing missing absolute PATH entries from the user's login shell for the MCP server. Existing PATH entries keep priority. On non-Windows systems, tries login and interactive-login shells, each with a 10 s timeout; unavailable output leaves PATH unchanged. | on |
| `AGENT_WORKFLOW_EVIDENCE_REFETCH` | `0` disables the engine-side web quote check for new runs. The run records the setting for later supervisors and resumes. See [support helpers](usage.md#support-helpers). | on |
| `AGENT_WORKFLOW_HOME` | Per-user directory: user workflows (`workflows/`), user agents (`agents/`), saved user profiles (`user-profiles/v1/profiles.json`), per-workflow profile preferences, executor state (`executors/<id>/`), [project run state](#where-run-state-lives) (`projects/<project-id>/`). | `~/.agent-workflow` |
| `AGENT_WORKFLOW_RUN_INDEX_DIR` | Directory of the runtime's run locator index (lets `status`/`wait` find a run by id from another process). | `~/.agent-workflow/run-index` |
| `AGENT_WORKFLOW_RUN_LOCATOR_PRUNE_AFTER_MS` | Age after which stale run locators are pruned from the index. | 30 days |
| `AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA` | `1`: reject a named workflow before launch when its prompt/schema diagnostics are strict-blocking (direct dynamic runs are excluded). Ordinary validation applies either way. | off |
| `AGENT_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS` | Tool-result budget for dynamic generated tasks (static stages keep their spec budgets). `0` or a negative value disables it. | `320000` |
| `AGENT_WORKFLOW_TOOL_EXPOSURE` | Pi host only: `deferred` registers the `aw_*` tools with deferred exposure, so they stay out of every model request until Pi's `tool_search` loads them (enable it with `"defaultTools": ["+tool_search"]`). Any other value: normal registration. The `/aw` command and the host MCP server are unaffected (Claude Code already loads MCP tool schemas on demand). | unset (normal) |

`PI_CODING_AGENT_DIR` locates Pi's `web-search.json` for web-tool diagnostics and the confirmed
`doctor --fix` action. It does not add workflow or agent discovery roots. Executor CLIs keep their
own variables (`CODEX_HOME`, `ANTHROPIC_API_KEY`, …); see [executors.md](executors.md).

### Operational limits

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES` | Positive cap on concurrent worker launches per process (launch gate). | `max(2, floor(cores / 2))` |
| `AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS` | Optional positive ceiling on live model workers. | unset (no ceiling) |
| `AGENT_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES` | Retries of a task after a transient model/executor failure (non-negative). | `5` |
| `AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES` | Retries of a task whose output fails the output contract (non-negative). | `2` |
| `AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES` | Most minutes one run waits in a provider pause (overload circuit breaker, [Provider rate-limit waits](#provider-rate-limit-waits)); `0` turns the pause off, an invalid value uses the default. | `120` |
| `AGENT_WORKFLOW_CANCEL_GRACE_MS` | Grace period between a cancel request and forced termination of a worker. | `10000` |
| `AGENT_WORKFLOW_HEARTBEAT_MS` | Durable worker heartbeat interval (minimum 50). | `5000` |
| `AGENT_WORKFLOW_CONTROL_POLL_MS` | Poll interval of the durable control mailbox (approval answers, cancel requests; minimum 5). | `50` |
| `AGENT_WORKFLOW_EVENT_READ_CACHE_MAX` | Entries in the run-event read cache (`0` disables it). | `64` |
| `AGENT_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS` | Delay before a launch slot is released after a launch. | `3000` (`250` with `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP`) |

Lower retries or higher concurrency trade reliability or quality for speed; they are not
recommended defaults.

### Worktree runtime artifacts

These belong to the managed-worktree implementation (write-capable stages), not to portable specs.

| Variable | What it does | Default |
|---|---|---|
| `AGENT_WORKFLOW_PRIVATE_RUNTIME_ARTIFACT_NAMES` | Comma-separated directory names (for example build outputs) that each worktree gets a private copy of. `0`/`false`/`off`/`none`/`no` disables. | `target` |
| `AGENT_WORKFLOW_CLONE_RUNTIME_ARTIFACT_DIRS` | Flag: clone those directories into new worktrees (copy-on-write `cp -c`). | off |
| `AGENT_WORKFLOW_ALLOW_FULL_RUNTIME_ARTIFACT_COPY` | Flag: fall back to a full copy when copy-on-write cloning fails. | off |

### Experimental (default off)

Flags. No general speed or quality claim is implied by any of them.

| Variable | What it does |
|---|---|
| `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP` | The artifact server suppresses an identical re-read (ledger row with `returnedBytes: 0`). An adapter that wants it must pass it in `McpServerSpec.env` ([`mcp.md`](extending.md#workflow-artifact-mcp-server)). |
| `AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH` | Foreach prompts keep the item payload out of the instruction text (cache-stable prefix). |
| `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP` | Shorter launch-slot release delay. |
| `AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR` | Output repair retries continue the worker's kept session instead of a fresh attempt. The only setting that makes the engine request kept worker sessions; without it no attempt keeps one. Kept sessions are released at task/run end ([`usage.md`](usage.md#run-records) "Worker sessions"). |
| `AGENT_WORKFLOW_EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW` | Output repair retries omit the failed attempt's preview; the validation error, its JSON excerpt and the retry instructions stay. |
| `AGENT_WORKFLOW_PER_ITEM_DISPATCH` | Streaming foreach children whose projection is satisfiable from published partial output start per item. |
| `AGENT_WORKFLOW_ADAPTIVE_LIVE_WORKERS` | Adaptive live-worker limit (floor 4, ceiling `AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS` or 16). |

Defined but inactive (they enable no behavior): `AGENT_WORKFLOW_CACHE_SHAPE_METRICS`,
`AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER`.

### Internal (set by the engine or for integrations; leave unset)

| Variable | What it is |
|---|---|
| `AGENT_WORKFLOW_ROLE` | Process role: `supervisor` (default), `worker`, `disabled`. Workers get `worker`; `worker`/`disabled` processes may only `help`/`validate` and the Pi host registers no tools. |
| `AGENT_WORKFLOW_HOST_CONTEXT` | JSON host context (`version`, `cwd`, `homeDir`, `projectTrusted`) passed to headless children. |
| `AGENT_WORKFLOW_PARENT_WORKER_CWD`, `AGENT_WORKFLOW_PARENT_WORKER_RUNS_DIR`, `AGENT_WORKFLOW_PARENT_WORKER_RUN_ID`, `AGENT_WORKFLOW_PARENT_WORKER_ATTEMPT_ID` | Identify the parent runtime attempt of a nested workflow so child events and usage are recorded on it. |
| `AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` | Barrier binding handed to a durable worker. |
| `AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON` | Env values (`SubmitRequest.env`, MCP server env) for a durable worker; removed from the worker's `process.env` at startup, never written to disk. |
| `AGENT_WORKFLOW_PI_RUN_SECRETS_JSON` | Secret part of the Pi executor's per-run config; deleted as soon as the in-Pi extension loads. |
| `AGENT_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256` | Lowercase SHA-256 of an external launch grant bound into launch provenance. |
| `AGENT_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT` | `1`: a launch without the grant digest fails. |
| `AGENT_WORKFLOW_CAPTURE_TOOL_CALLS` | Flag: record worker tool calls in launch provenance (diagnostics). |

### Test-only (the package reads them; never set them in normal use)

| Variable | What it does |
|---|---|
| `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` | Absolute path of a test executor module for the CLI's guarded hook ([`cli.md`](cli.md)). |
| `AGENT_WORKFLOW_TEST_EXECUTOR_ACK` | Must be exactly `test-only` when the module is set; otherwise every CLI command exits 2. |
| `AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR` | `1`: the detached supervisor stays in the CLI's process group (test cleanup). |
| `AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS` | Delays durable worker startup (race tests). Default `0`. |
| `AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS` | Delays the durable worker's terminal write (race tests). Default `0`. |

### Read only by the test suites and release tools

Not read by the package.

| Variable | Used by |
|---|---|
| `AGENT_WORKFLOW_TEST_CONCURRENCY`, `AGENT_WORKFLOW_KEEP_TEST_HOME` | `test/run-unit.mjs`: parallel test files (`--tier=integration` defaults to 2); keep the per-file test homes. |
| `AGENT_WORKFLOW_LIVE`, `AGENT_WORKFLOW_LIVE_PI_MODEL`, `AGENT_WORKFLOW_LIVE_CLAUDE_MODEL`, `AGENT_WORKFLOW_LIVE_REPORT`, `AGENT_WORKFLOW_CODEX_LIVE_MODEL`, `AGENT_WORKFLOW_CODEX_LIVE_REPORT` | Live executor tiers (real CLIs and models; cost money). Off unless `AGENT_WORKFLOW_LIVE=1`. |
| `AGENT_WORKFLOW_PI_BIN`, `AGENT_WORKFLOW_PI_RPC_RECORD` | Live Pi host RPC check ([`hosts.md`](hosts.md#pi)). |
| `AGENT_WORKFLOW_ROOT` | Replay fixture builder. |
| `AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS`, `AGENT_WORKFLOW_E2E_PROCESS_LOG`, `AGENT_WORKFLOW_E2E_REAL_NPM` | `npm run e2e`: the no-external-actions guard and its command shims (set by `test/e2e/run.mjs`). |
| `AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION` | `tools/release/release-check.mjs`: allow a validation-only rerun of an already published version. |
