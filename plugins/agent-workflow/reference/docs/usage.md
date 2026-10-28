# Using agent-workflow

How to find, write, run, wait for, resume and stop workflows, how executors, profiles and permission
modes are chosen, what a run leaves on disk, and what to do when something goes wrong. Command
reference: [`cli.md`](cli.md) (CLI) and [`pi-host.md`](pi-host.md) (Pi `/aw`). Install and quick
start: [`../README.md`](../README.md).

Examples use the CLI. In Pi, the same actions are `/aw <action> …` (and the `aw_list`, `aw_run`,
`aw_dynamic`, `aw_wait` tools). pi-workflow's `/workflow …` commands belong to pi-workflow and its own
run store; they do not drive agent-workflow runs.

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
4. legacy pi-workflow locations, **read-only**: `<cwd>/.pi/workflows/`, then `~/.pi/agent/workflows/`
   (`$PI_CODING_AGENT_DIR/workflows/`)
5. the package's bundled `workflows/`

A higher root shadows lower ones; more than one match in the winning root (for example both
`name.json` and `name/spec.json`) fails as ambiguous. Each root accepts a flat `<name>.json` or a
directory bundle `<name>/spec.json` with its `schemas/` and `helpers/`; use a bundle whenever the
workflow has schemas or helpers. `agent-workflow list` shows what resolves, `agent-workflow show
<name>` prints the resolved spec, and `agent-workflow validate <name-or-path>` compiles it without
running anything.

Agents (`agent:` in a spec) resolve the same way: `<cwd>/.agent-workflow/agents/`,
`$AGENT_WORKFLOW_HOME/agents/`, legacy `<cwd>/.pi/agents/` and `~/.pi/agent/agents/` (read-only),
then the bundled `scout` and `researcher`. A legacy user agent with a bundled agent's name therefore
replaces the bundled one; the capability preview announces it with a `Notice:` line. Put a copy of
the bundled agent in `.agent-workflow/agents/` to pin it.
`agent-workflow agents` lists what resolves and from where.

agent-workflow never writes to the legacy locations; its runs and settings live under
`.agent-workflow/` and `$AGENT_WORKFLOW_HOME`. pi-workflow can stay installed next to it; each only
sees its own runs. Legacy discovery covers specs and agents only: pi-workflow runs under
`.pi/workflows/` are never listed, and `logs`/`inspect` read only files inside `.agent-workflow/`, so
a pi-workflow run copied into `.agent-workflow/workflows/` (its record still points at `.pi/…`)
shows those files as `(not read: path is outside the project's artifact root …)`.

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

## Waiting, inspecting, resuming, stopping

```sh
agent-workflow status                         # top-level runs, newest first
agent-workflow status <run>                   # one run and its tasks
agent-workflow wait <run> --timeout 30m       # drive and wait (exit 1 if still running at the timeout)
agent-workflow inspect <run> --failures --results
agent-workflow show <run> --raw               # the run record
agent-workflow resume <run> [--detach]        # reset failed/interrupted/resumable blocked tasks, continue
agent-workflow stop <run>                     # durable stop intent; workers are cancelled
agent-workflow prune --keep 20 --yes          # delete old terminal runs (dry run without --yes)
```

A run argument accepts the id or an unambiguous prefix. Any process can wait for, inspect or stop a
run, including one started elsewhere with `--detach`. `wait` drives scheduling in bounded steps
(45 s per call in the Pi tool and the host API; the CLI loops).

Run states: `running`, `completed`, `failed`, `interrupted` (stopped, or a worker was revoked) and
`blocked` (needs a person: an unprovable executor state, an exhausted required-read or output repair,
a dynamic approval). `resume` resets failed, interrupted and resumable blocked tasks and keeps
completed task artifacts. A run executes the copied `bundle/` in its run directory, so a newer
package version does not change a running workflow's schemas or helpers; start a fresh run to pick
up changed workflow code. Loop workflows cannot be resumed; start a fresh run. Right after `stop`,
`resume` waits up to 10 s for the stopped supervisor to let go of the run; if it has not by then,
`resume` changes nothing and says to try again in a few seconds.

`stop` records a durable stop intent. A worker that had not started yet never starts (its launch is
revoked); a running worker is cancelled. If another supervisor owns the run, the stop is applied by
it: `stop` waits up to 15 s for that confirmation, and a run the supervisor has already stopped counts
as confirmed (exit 0). If no confirmation arrives in time, `stop` reports the stop as pending and
exits 1; the intent stays durable and is applied when the supervisor next runs.

## Executors

| Executor | CLI | Notes |
|---|---|---|
| `pi` | `pi --mode json` | Pi 1.1+. deep-research needs the `pi-web-access` extension. |
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
   `native`, else the run is refused). Stored in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json`.
   `--profile <name>` picks a declared profile first, then a saved one; without `--profile` a launch
   uses the declared default profile (over the default saved profile, as above), else the default
   saved profile. A saved profile named with `--profile` is used on its own.

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
`research-execution`, `synthesis`, `verification`, `final-judgment`). pi-workflow's per-workflow
role picker (`/workflow profile`: Codex / Codex High / Claude / Mixed / Custom) is not exposed by the
stage-1 hosts; the Pi host still honors a preference saved under
`$AGENT_WORKFLOW_HOME/workflow-profiles/v1/` when no profile is named.

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

## Capability preview and degradations

Before a run starts, the engine probes the executor (installed, CLI version, login; no model call)
and matches every stage's needs against the executor's capability table (B4). The first output line
is the preview:

```text
Capability check (codex@0.1.0, 4 stages, permission mode: free): accepted with degradations
  …CAPABILITY_MISSING:toolAllowlist.fine (accepted: free mode)…
```

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
  // sources: upstream control.json values keyed by stable source names (foreach items as
  // "<stage>.<item id>"); context: specPath, runId, taskId, stageId, cwd, signal, sourceStatuses
  return { schema: "my-merge-control-v1", digest: "merged 3 reviews", items: [/* … */] };
}
```

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
`onExhausted` stage runs once on exhaustion or no progress. There is no auto-merge of worktree output.

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
needs every requirement covered by typed bytes, and anything unresolved stays `INCONCLUSIVE`. The
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
| `Not started: … EXECUTOR_NOT_INSTALLED` / `EXECUTOR_AUTH_NOT_READY` | The executor CLI is missing or not logged in. The message names the install command or the login command (`pi` then `/login`, `codex login`, `claude auth login`); or pick another `--executor`. |
| `Not started: … CAPABILITY_REFUSED` | A stage needs something the executor cannot do. The message lists each refusal and its opt-in, if any (`--allow-unverified`, `allowReadOnlyDowngrade`, `--permission-mode free`). |
| deep-research refused on Pi with `webTools` | Install the `pi-web-access` Pi extension, or use `--executor claude`/`codex`. |
| Codex runs show `readOnly`/`contextIsolation` warnings | Your `~/.codex/rules` has allow rules or a global `~/.codex/AGENTS.md` exists. Recorded only; remove them for a clean run. |
| `Notice: agent "scout": legacy … shadows the bundled agent of the same name` in the preview | A legacy user agent (`~/.pi/agent/agents/scout.md`, …) takes precedence over the bundled one; the notice is also a compile warning and is recorded in `run.capabilityNegotiation.notices`. Rename or remove the legacy file, or copy the bundled agent into `.agent-workflow/agents/` to pin it. A project's own `.pi/agents/` override is not announced. |
| `input <key> is not declared by this workflow (declared: …)`, `input <key> must be a number` (exit 2) | `--input` / `inputs` names a key the spec does not declare or a value of the wrong type. Use a declared key (`agent-workflow show <workflow>` shows `input`) and a value of the default's type. |
| Usage shows `cost unknown` | The executor reported no cost (Codex always; any task without a cost). Token counts are still recorded; nothing is estimated. |
| The run is `failed` but the report looks fine | Final renders mark verdicts such as `PARTIAL_REVIEW`, `INCONCLUSIVE`, `GAPS_FOUND`, `BLOCKED` as declared failures (`support_declared_failed`): the workflow worked and reported a finding about the target. Read `final-report.md`. |
| A task failed with `required_reads_missing_exhausted` | The worker did not read every required artifact (or only part of a paged one). `inspect <run> --failures --results` shows which; `resume` retries. |
| A task is `blocked` with `executor_needs_decision` | After a crash the executor could not prove whether the attempt ran. Nothing retries automatically. Check the CLI's own state, then `resume` (new attempt) or `stop`. |
| `wait` returns `stillRunning` | The bounded wait ended; call `wait` again, or use `--detach` and check later. |
| `stop` says pending (exit 1) | Another supervisor owns the run and did not confirm within 15 s; it applies the durable stop intent. Check with `agent-workflow status <run>`. |
| The CLI prints a test-executor warning or exits 2 on every command | `AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` is set; unset it (test-only hook). |
| Changed a bundled workflow but the run still uses the old one | Runs execute their copied `bundle/`; start a new run. |

Environment variables: [`environment.md`](environment.md).
