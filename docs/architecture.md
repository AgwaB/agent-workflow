# Architecture

agent-workflow is one npm package with layered entry points. The engine never depends on a single
agent host or CLI: hosts call the engine through a shared host API, and the engine dispatches every
worker to an executor through the executor SDK.

```text
 hosts           CLI (agent-workflow)   Pi extension (/aw)   [stage 2: Codex/Claude host plugins]
                         \                  |                   /
 host API                 hosts/api — one handler per action (run, wait, status, stop, …)
                                            |
 core             compiler · engine · scheduler · artifact graph · B4 negotiation · run store
                     |                         |                               |
 runtime          durable worker · launch barrier · control mailbox · run registry · reconcile
                     |
 sdk              WorkflowExecutor contract · capabilities · events · errors · conformance kit
                     |
 executors        pi (pi --mode json)   codex (codex app-server)   claude (claude -p stream-json)
                     |
 mcp              workflow_artifact stdio server (workers read upstream artifacts through it)
```

| Layer | Entry point | Source | Depends on |
|---|---|---|---|
| core | `@agwab/agent-workflow` | `src/core/` | sdk, runtime |
| runtime | `@agwab/agent-workflow/runtime` | `src/runtime/` | sdk |
| sdk | `@agwab/agent-workflow/sdk`, `/sdk/testing`, `/sdk/conformance` | `src/sdk/` | nothing |
| executors | `@agwab/agent-workflow/executors/{pi,codex,claude}` | `src/executors/` | sdk |
| mcp | (spawned by path, `dist/mcp/artifact-server/server.js`) | `src/mcp/` | core tool body |
| host API | `@agwab/agent-workflow/hosts/api` | `src/hosts/*.ts` | core |
| CLI host | `agent-workflow` bin, `@agwab/agent-workflow/hosts/cli` | `src/hosts/cli/` | host API |
| Pi host | `@agwab/agent-workflow/hosts/pi` (Pi extension) | `src/hosts/pi/` | host API, Pi peers |

The package has no runtime `dependencies`. The Pi packages are optional peers needed only by the Pi
host; nothing else imports them (`npm run e2e` scans the packed files for this). The core loads an
executor adapter only through its descriptor, never by a static import.

## Core

The core is ported from pi-workflow 0.16.4 ([`core-port.md`](core-port.md)). It compiles a JSON spec
into tasks (`compiler.ts`), schedules them (`engine.ts`, launch slots, retries), validates each
worker's `<control>/<analysis>/<refs>` output, enforces required reads through the read ledger, runs
support helpers in process, and stores the run record. Before any launch it probes the selected
executor and negotiates every stage's requirements against the executor's capability table (B4):
`accept`, `degrade` (recorded, maybe confirmed) or `refuse` (nothing starts). The permission mode
(`free`/`safe`, [`permissions.md`](permissions.md)) is part of that policy and of every submit request.

Executor selection and permission mode follow one precedence: run flag > workflow-declared profile >
saved user profile > default (`pi`, `free`). The run record keeps the executor descriptor, so a
detached supervisor or a resumed run reloads the same adapter (R#15).

## Runtime: durable worker, launch barrier, control mailbox

The runtime is ported from pi-subagent 0.7.2 ([`runtime-port.md`](runtime-port.md)). Each task
attempt runs in a **durable worker**: a detached `node dist/runtime/workers/durable-worker.js
<worker.json>` process that reloads the executor from its descriptor, so the attempt survives the
host process exiting.

- **Launch barrier (v2).** Before the worker may cause any effect, it writes READY (with the digests
  of its payload and execution plan) and waits. The engine durably records the attempt, then
  resolves exactly one decision, `released` or `revoked`; the worker acknowledges it. A stop that
  wins the decision means the worker exits with no effect.
- **Execution authority.** The barrier sits behind the SDK's `ExecutionAuthority`. The adapter calls
  `authority.consume()` immediately before its first side effect (spawning the CLI, sending a turn).
  `consume()` is single use across processes (`authority.json`, created exclusively), so a resumed
  or duplicated worker cannot cause a second effect. On `revoked` the adapter does nothing.
- **Control mailbox.** Approval answers and cancel requests reach the process that executes the
  attempt through a file mailbox in the attempt directory (`control/<seq>-<type>.json`, one ack per
  sequence number). It survives host exits and supervisor restarts; any process that can read the run
  directory can answer an approval or request a cancel.
- **Reconcile.** After a crash the runtime asks the adapter `reconcile(attemptKey)`: `found` (adopt),
  `absent` (proven never launched; may retry) or `unknown` (the engine stops and asks a person; it
  never retries automatically, B3).
- **Terminal last write.** The worker writes logs, closes the mailbox, and only then writes
  `result.json`; a terminal finalizer drains ownership.

## SDK and executors

The SDK ([`sdk.md`](sdk.md)) defines the contract every adapter implements; the conformance kit
([`conformance.md`](conformance.md)) checks it. Stage 1 ships three adapters
([`executors/pi.md`](executors/pi.md), [`executors/codex.md`](executors/codex.md),
[`executors/claude.md`](executors/claude.md)); their live status is in [`support.md`](support.md).

## MCP artifact server

Workers read upstream workflow artifacts through one MCP tool, `workflow_artifact`, served by a
zero-dependency stdio server the engine attaches to each task that needs it
([`mcp.md`](mcp.md)). Every read appends a ledger row; required reads are checked against that
ledger, and page reads are sized to each executor's measured MCP delivery limit.

## Hosts

Hosts translate a user surface into host API calls ([`host-api.md`](host-api.md)): the CLI
([`cli.md`](cli.md)) and the Pi extension ([`pi-host.md`](pi-host.md)). Stage 2 adds a host MCP
server and Codex/Claude host plugins.

## Data layout

Project (`<cwd>/.agent-workflow/`, created on first run, never shared with pi-workflow's `.pi/`):

| Path | Content |
|---|---|
| `workflows/<run-id>/run.json` | Run record (status, tasks, executor, permission mode, capability negotiation, usage) |
| `workflows/<run-id>/{spec,compiled}.json`, `bundle/` | Spec, compiled snapshot and the copied workflow bundle the run executes |
| `workflows/<run-id>/tasks/<task-id>/` | `task.md`, `system-prompt.md`, `control.json`, `analysis.md`, `refs.json`, `raw.md`, `read-ledger.jsonl`, `source-manifest.json`, `artifact-access.json`, `result.json`, logs, the task's launch-barrier directory |
| `workflows/<run-id>/supervise.log` | Detached supervisor log (`--detach` only) |
| `workflows/index.json` | Run index of the project |
| `workflow-subagents/<run-id>/<task-id>/<runtime-run-id>/` | Runtime run of one task: `run.json`, `events.jsonl`, `attempts/<attempt-id>/` with `worker.json`, `executor.json`, `authority.json`, `control/`, `exec-events.jsonl`, raw CLI logs, `result.json` |
| `workflows/<name>.json`, `workflows/<name>/spec.json` | Project-private workflow specs (next to the run directories) |
| `agents/` | Project agents |
| `ocr-artifacts/` | deep-review OCR artifacts (trusted root) |

User (`$AGENT_WORKFLOW_HOME`, default `~/.agent-workflow/`): `workflows/`, `agents/`,
`user-profiles/v1/profiles.json`, `workflow-profiles/v1/`, `run-index/` (run locators),
`executors/<id>/` (adapter state, kept sessions).

Read-only legacy roots (F5): `<cwd>/.pi/workflows`, `~/.pi/agent/workflows`, `<cwd>/.pi/agents`,
`~/.pi/agent/agents` are searched after the agent-workflow roots and never written.
