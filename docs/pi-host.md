# Pi host (`@agwab/agent-workflow/hosts/pi`)

WP11b. A minimal Pi extension over the host API (`docs/host-api.md`): the `/aw` command, four agent
tools (`aw_list`, `aw_run`, `aw_dynamic`, `aw_wait`) and an unfinished-run notice at session start.
The parent agent is Pi; the workflow **workers** run on whichever executor is selected (`--executor`,
a profile, or the default `pi`). Every action calls one host API handler, so the Pi host, the
`agent-workflow` CLI (`docs/cli.md`) and the stage-2 MCP host behave the same.

Sources: `src/hosts/pi/` — `index.ts` (package entry and Pi presence check), `extension.ts`
(registration), `command.ts` (`/aw`), `tools.ts` (`aw_*`), `notices.ts` (session start), `host.ts`
(host context, confirmation, output), `names.ts`, `pi-types.ts` (the Pi API subset used).

## Install

Pi 1.1 or newer. The Pi packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`) are optional
peer dependencies: Pi provides them to extensions, nothing else in agent-workflow needs them.

```sh
# one invocation, without changing Pi settings
pi -e ./node_modules/@agwab/agent-workflow/dist/hosts/pi/index.js
pi -e npm:@agwab/agent-workflow

# install as a Pi package (package.json "pi.extensions": ["./dist/hosts/pi/index.js"])
pi install npm:@agwab/agent-workflow        # personal; add -l for the project
```

The package manifest declares only the extension. The bundled `skills/` are not exposed through Pi:
their names (`workflow-guide`, `execution-router`) equal pi-workflow's skills.

Importing `@agwab/agent-workflow/hosts/pi` outside Pi without the peer fails with
`PiHostUnavailableError` ("… is a Pi extension and needs the Pi coding agent …") instead of a bare
module-resolution error. No other module of the package imports the Pi host (a unit test checks
`src/` and `dist/`).

## `/aw` command

`/aw help` lists the actions; `/aw help <action>` shows the shared help of one action (the CLI help
with `/aw`). Output is the handler's `text`, shown as a Pi notification (stdout/stderr in print/JSON
mode); errors are error notifications.

| `/aw …` | Host API handler |
|---|---|
| `help [action]` | `helpAction` (one action); the action list is Pi-specific |
| `list [--query T] [--offset N] [--limit N]` | `listWorkflowsAction` |
| `validate <workflow>`, `roles <workflow>` | `validateWorkflowAction`, `workflowRolesAction` |
| `agents` | `listAgentsAction` |
| `profile list \| show [name] \| set <name> … [--default] \| delete <name> \| default <name> \| default --clear` | `profileAction` (saved user profiles; same options as the CLI) |
| `run <workflow> <task> [options]` | `runWorkflowAction` |
| `dynamic <task> [options]` | `runDynamicAction` |
| `status [run]` | `statusAction` |
| `show <workflow>` / `show <run> [--raw]` | `showAction` |
| `inspect <run> [--failures] [--results]` | `inspectAction` |
| `wait <run> [--timeout D]` | `waitAction` — one call, at most 45 s |
| `resume <run> [--detach]` | `resumeAction` |
| `stop <run>` | `stopAction` |
| `prune [--keep N] [--older-than DAYS] [--yes]` | `pruneAction` |
| `notices list \| acknowledge <run> --state <sha256> --reason <text> \| clear <run>` | `noticesAction` |

Run options (leading or trailing, quoted text is literal; the host API parser
`parseWorkflowRunArgs`): `--executor <id> --profile <name> --permission-mode free|safe
--allow-unverified <a,b> --model <id> --effort <level> --input <key=value> (repeatable) --detach
--force-new`.

`/aw run` returns once the run is launched. The engine's in-process watcher keeps driving it while
the Pi session lives; `/aw wait`, `/aw status` or `aw_wait` show progress, `--detach` hands it to a
standalone supervisor that outlives the session. `supervise` is CLI-only.

Core formatters print pi-workflow-style `/workflow …` hints; the Pi host rewrites them to `/aw …`
(`/workflow <run>` → `/aw status <run>`, `/workflow logs <run> …` → `/aw inspect <run> --results`),
because `/workflow` belongs to pi-workflow and its own run store.

## Tools

Schemas, descriptions and prompt guidelines are adapted from pi-workflow's
`workflow_list/run/dynamic/wait` with executor-neutral wording.

| Tool | Parameters | Handler |
|---|---|---|
| `aw_list` | `query?`, `offset?`, `limit?` (1-20, default 20) | `listWorkflowsAction` |
| `aw_run` | `workflow`, `task`, `executor?`, `profile?`, `permissionMode?` (`free`/`safe`), `allowUnverified?` (string[]), `model?`, `effort?`, `detach?`, `forceNew?`, `inputs?` (object) | `runWorkflowAction` |
| `aw_dynamic` | `task` and the same options | `runDynamicAction` |
| `aw_wait` | `runId`, `timeoutMs?` (1000-45000) | `waitAction` |

Results: `content` is the handler text; `details` is the handler `data` plus `outcome`/`ok`.
Launches add `waitWith`; a refused launch is returned with `isError: true` (the refusal code is in
`details.refusal`). `aw_wait` returns `terminal`, `actionRequired`, `stillRunning`, `semanticStatus`,
`preview` (bounded authoritative result), `reportArtifacts`, `taskSummary`, … and streams progress
through `onUpdate`. Each call waits at most 45 s (the host API cap); the guidelines tell the agent to
call it again while `stillRunning` is true. Cancelling a tool call cancels only the wait. Unlike
pi-workflow, `aw_run`/`aw_dynamic` have no `awaitTerminal`.

`inputs` (WP12c) is the tool form of `--input`: an object of declared workflow inputs, passed to the
host API as `inputOverrides` and typed there like the CLI's strings (a string is converted for a
number, boolean or JSON default; any other value must already have the declared type; an undeclared
key is refused before anything starts; [`usage.md`](usage.md#workflow-inputs---input-keyvalue)).

Usage errors (unknown parameter, bad permission mode, undeclared or mistyped input, unknown run)
throw, so Pi reports a failed tool result with the host API message.

## Confirmation and profile choice

When the session has a dialog-capable UI (`ctx.hasUI`: TUI and RPC), launches from `/aw` and the
tools are interactive: a capability degradation that needs confirmation (WP4d) asks
`ctx.ui.confirm("Proceed with these executor capability degradations?", <preview>)`; declining
refuses the launch (`CAPABILITY_DEGRADATION_DECLINED`, no run). A workflow that declares execution
profiles and none is named offers them through `ctx.ui.select`. Without a UI (print/JSON mode)
launches are non-interactive: degradations are recorded (`non-interactive`) and the run proceeds.

Host context per call: `cwd` = Pi's cwd; `availableModels` = Pi's model registry (so saved
per-workflow Pi profile preferences apply); `runtimeDefaults` = Pi's current model and thinking level,
only when no executor or `pi` is selected — a `--executor codex` run does not inherit Pi's model.

## Session start

On `session_start` (not awaited, never delays startup) the host calls
`noticesAction({argv: ["list"]})` and shows one warning notification listing unfinished runs (port of
pi-workflow `notifyUnfinishedRuns`): top-level failed/interrupted runs and blocked runs waiting for a
dynamic approval or an executor decision, excluding mock runs, runs with an active acknowledgement
and runs not updated for 7 days; at most 5 listed, each with `/aw resume <run>`. A run is notified
again only when its status/updatedAt changed, its acknowledgement became stale, or 6 hours passed
(state: `.agent-workflow/workflows/unfinished-notices.json`). Silence a run with
`/aw notices acknowledge <run> --state <sha256> --reason <text>`.

## Process roles

With `AGENT_WORKFLOW_ROLE=worker` or `disabled` (a Pi worker that loads this package) the tools are not
registered and no notice is shown; `/aw help` and `/aw validate` still work and other actions are
refused by the host API.

## Coexistence with pi-workflow

pi-workflow (`@agwab/pi-workflow`) may be installed at the same time (A2-1/A2-2). The Pi host uses
`/aw` and `aw_*`, never `/workflow` or `workflow_*`; a unit test registers both name sets in one fake
`ExtensionAPI` (which throws on a duplicate) in both orders, and the live RPC check loads both
extensions in one real Pi. Run stores differ: agent-workflow uses `.agent-workflow/`, pi-workflow
`.pi/workflows/`; each command only sees its own runs.

## Verification

- `test/unit/host-pi-extension.test.mjs`: fake `ExtensionAPI`; every action and tool delegates to the
  right handler with the right arguments (a recording wrapper over the real host API); runs use the
  WP11a guarded test-executor hook; confirmation (decline, accept, no UI); session-start notices
  (eligibility, dedup, acknowledgement, non-blocking); worker role; no-collision; entry guard and
  import isolation.
- `test/unit/host-pi-rpc.test.mjs`: real Pi 1.1 in RPC mode with no model turn — `/aw help`,
  `/aw list`, `/aw validate deep-review` are answered with `disposition: "handled"` and the expected
  notification text; nothing but responses and extension UI records is emitted. The scrubbed
  transcript `test/fixtures/host-pi/rpc-aw-transcript.jsonl` is checked on every run; the live check
  runs with `AGENT_WORKFLOW_PI_BIN=<path to pi>` (re-record with `AGENT_WORKFLOW_PI_RPC_RECORD=1`; add
  `AGENT_WORKFLOW_PI_WORKFLOW_EXTENSION=<pi-workflow src/extension.ts>` for the coexistence check).

## Limits (stage 1)

- No board, widgets, status line or `/aw` with a bare run id (pi-workflow's board is stage 2).
- No completion-feedback delivery into the session, presentation lease or parent-usage tracking: the
  agent calls `aw_wait`, the user `/aw wait` / `/aw status`.
- No `/aw auto`, `/aw logs` or TUI profile picker (`/workflow profile`); `/aw profile` manages saved
  user profiles only.
- Runs left running by an earlier Pi session are not resumed at session start; `/aw wait`,
  `/aw resume` or `agent-workflow supervise` drive them.
- `runtimeDefaults` follow the explicit executor only: a profile that selects a non-Pi executor still
  receives Pi's current model as the lowest-precedence default.
