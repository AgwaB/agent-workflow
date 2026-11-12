# Extending agent-workflow

For developers writing executor adapters, building hosts, or working on the engine and durable runtime.

**Contents:** [Architecture](#architecture) · [Writing an executor adapter](#writing-an-executor-adapter) · [Conformance kit](#conformance-kit) · [Host API](#host-api) · [Workflow artifact MCP server](#workflow-artifact-mcp-server)

## Architecture

agent-workflow is one npm package with layered entry points. The engine never depends on a single
agent host or CLI: hosts call the engine through a shared host API, and the engine dispatches every
worker to an executor through the executor SDK.

```text
 hosts           CLI (agent-workflow)   Pi extension (/aw)   Codex/Claude host plugins
                         \                  |                   /
 host API                 hosts/api — one handler per action (run, wait, status, stop, …)
                                            |
 core             compiler · engine · scheduler · artifact graph · capability negotiation · run store
                     |                         |                               |
 runtime          durable worker · launch barrier · control mailbox · run registry · reconcile
                     |
 sdk              WorkflowExecutor contract · capabilities · events · errors · conformance kit
                     |
 executors        pi (JSON)   codex (app-server)   claude (stream-json)   antigravity (ACP)
                     |
 mcp              workflow_artifact stdio server (workers read upstream artifacts through it)
```

| Layer | Entry point | Source | Depends on |
|---|---|---|---|
| core | `@agwab/agent-workflow` | `src/core/` | sdk, runtime |
| runtime | `@agwab/agent-workflow/runtime` | `src/runtime/` | sdk |
| sdk | `@agwab/agent-workflow/sdk`, `/sdk/testing`, `/sdk/conformance` | `src/sdk/` | nothing |
| executors | `@agwab/agent-workflow/executors/{pi,codex,claude,acp}` | `src/executors/` | sdk |
| mcp | (spawned by path, `dist/mcp/artifact-server/server.js`) | `src/mcp/` | core tool body |
| host API | `@agwab/agent-workflow/hosts/api` | `src/hosts/*.ts` | core |
| CLI host | `agent-workflow` bin, `@agwab/agent-workflow/hosts/cli` | `src/hosts/cli/` | host API |
| Pi host | `@agwab/agent-workflow/hosts/pi` (Pi extension) | `src/hosts/pi/` | host API, Pi peers |

The package has no runtime `dependencies`. The Pi packages are optional peers needed only by the Pi
host; nothing else imports them. The core loads an
executor adapter only through its descriptor, never by a static import.

### Core

The core compiles a JSON spec
into tasks (`compiler.ts`), schedules them (`engine.ts`, launch slots, retries), validates each
worker's `<control>/<analysis>/<refs>` output, enforces required reads through the read ledger, runs
support helpers in process, and stores the run record. Before any launch it probes the selected
executor and negotiates every stage's requirements against the executor's capability table:
`accept`, `degrade` (recorded without confirmation) or `refuse` (nothing starts). The permission mode
(`free`/`safe`, [permissions](usage.md)) is part of that policy and of every submit request.

For host API launches, executor selection and permission mode follow one precedence: run flag > workflow-declared profile >
saved user profile > default (executor: the host's own CLI, in the terminal CLI the first installed
and logged-in of pi → claude → codex; mode `free`). The run record keeps the executor descriptor, so a
detached supervisor or a resumed run reloads the same adapter. A record without an executor fails
closed; it does not select a fallback. One-shot calls require an explicit executor. Every task runs through one
task runner on the runtime API.

### Durable worker, launch barrier, control mailbox

Each task attempt runs in a **durable worker**: a detached `node dist/runtime/workers/durable-worker.js
<worker.json>` process that reloads the executor from its descriptor, so the attempt survives the
host process exiting.

- **Launch barrier (v2).** Before the worker may cause any effect, it writes READY (with the digests
  of its payload and execution plan) and waits. The engine durably records the attempt, then
  resolves exactly one decision, `released` or `revoked`; the worker acknowledges it. A stop that
  wins the decision means the worker exits with no effect.
  Durable schema ids are `agent-workflow-durable-launch-barrier-v2`,
  `agent-workflow-durable-launch-barrier-ready-v2`,
  `agent-workflow-durable-launch-barrier-decision-v2` and
  `agent-workflow-durable-launch-barrier-ack-v2`. Worker binding uses
  `agent-workflow-durable-worker-binding-v2` and
  `agent-workflow-durable-worker-binding-preflight-v2`.
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
  never retries automatically).
- **Terminal last write.** The worker writes logs, closes the mailbox, and only then writes
  `result.json`; a terminal finalizer drains ownership.

### Failure kinds

The runtime maps executor `failed.class` events to attempt status and `failureKind`:

| Failure class or outcome | Status | `failureKind` | Automatic retry |
|---|---|---|---|
| `cancelled` | `cancelled` | `cancelled`, or the runtime's stop kind | No |
| Engine revoke before release | `cancelled` | `revoked` (nothing ran) | No |
| `transient` | `failed` | `transient` | Allowed |
| `rate_limit` | `failed` | `rate_limit` | Allowed after backoff |
| `auth` | `failed` | `executor_auth` | No |
| `config` | `failed` | `executor_config` | No |
| `permanent` | `failed` | `executor_permanent` | No |
| `unknown` | `failed` | `executor_unknown` | No |
| Orphan reconcile proves `absent` | `failed` | `not_started` | Safe to relaunch with a new attempt |
| Reconcile cannot establish ownership/outcome | `failed` | `needs_decision` | Never; ask a person |

`executor_unknown` means an adapter could not classify a known failure. `needs_decision` means
execution or ownership cannot be proved; it must not be treated as absence. The runtime never
relaunches an attempt itself.

Before release, adapter refusals become `validation` (`INVALID_REQUEST` / capability errors) or
`spawn`; authority/descriptor integrity failures become `guard_failure`. A submit error after
release triggers reconcile: `found` is observed, `absent` becomes `spawn` (or the error's explicit
failure kind), and unknown/error becomes `needs_decision`. Descriptor rediscovery failures, fence
violations, invalid event sequences and streams ending without a terminal event are `guard_failure`.

Runtime stops use `timeout` (`failed`), `abort` or `user_cancelled` (`cancelled`). The runtime sends
`cancel(ref, "owned")` and waits `AGENT_WORKFLOW_CANCEL_GRACE_MS` (default 10 s) for a terminal
event. Without one, it records `metadata.executor.termination: "unconfirmed"`; a cancel ack is not
termination evidence. Partial streamed output remains marked `outputPartial: true`.

### Data layout

Run state (paths below are relative to `.agent-workflow/` inside the
[project state directory](usage.md#where-run-state-lives), created on first run):

| Path | Content |
|---|---|
| `workflows/<run-id>/run.json` | Run record (status, tasks, executor, permission mode, capability negotiation, usage) |
| `workflows/<run-id>/{spec,compiled}.json`, `bundle/` | Spec, compiled snapshot and the copied workflow bundle the run executes |
| `workflows/<run-id>/tasks/<task-id>/` | `task.md`, `system-prompt.md`, `control.json`, `analysis.md`, `refs.json`, `raw.md`, `read-ledger.jsonl`, `source-manifest.json`, `artifact-access.json`, `result.json`, logs, the task's launch-barrier directory |
| `workflows/<run-id>/supervise.log` | Detached supervisor log (`--detach` only) |
| `workflows/index.json` | Run index of the project |
| `worker-runs/<run-id>/<task-id>/<runtime-run-id>/` | Runtime run of one task: `run.json`, `events.jsonl`, `attempts/<attempt-id>/` with `worker.json`, `executor.json`, `authority.json`, `control/`, `exec-events.jsonl`, raw CLI logs, `result.json` |
| `ocr-artifacts/` | deep-review OCR artifacts (trusted root) |

Repository definitions stay in `<cwd>/workflows/`, `<cwd>/.agent-workflow/workflows/` (specs)
and `<cwd>/.agent-workflow/agents/`; they are separate from run state.

User (`$AGENT_WORKFLOW_HOME`, default `~/.agent-workflow/`): `workflows/`, `agents/`,
`user-profiles/v1/profiles.json`, `workflow-preferences/v1/`, `run-index/` (run locators),
`executors/<id>/` (adapter state; session records only for sessions the engine asked to keep),
`projects/<project-id>/` (project run state).

Workflow lookup order is project-shared `<cwd>/workflows/`, project-private
`<cwd>/.agent-workflow/workflows/`, user `workflows/`, then bundled workflows. Pi configuration
directories are not searched for workflows or agents.

## Writing an executor adapter

An executor adapter lets agent-workflow run workflow workers on one agent CLI. The engine never
talks to a CLI directly: it builds a `SubmitRequest` per task attempt and hands it to a
`WorkflowExecutor`. This section is the contract an adapter keeps. Entry points:

| Import | Content |
|---|---|
| `@agwab/agent-workflow/sdk` | Contract, capabilities, events, errors, descriptors, tool mapping, permission and approval helpers, negotiation |
| `@agwab/agent-workflow/sdk/testing` | `createFakeExecutor` (scripted, in memory) |
| `@agwab/agent-workflow/sdk/conformance` | The conformance kit ([conformance kit](#conformance-kit)) |

The SDK has no Pi imports and no runtime dependencies. Contract version:
`EXECUTOR_CONTRACT_VERSION = "0.1.0"`. For 0.x, compatible means the same major and minor; from 1.0
the same major. See [built-in adapters](executors.md) for implementation references.

### SDK contract

```ts
interface WorkflowExecutor {
  readonly id: string;               // "pi" | "codex" | "claude" | your id
  readonly version: string;          // adapter version (semver)
  readonly contractVersion: string;  // EXECUTOR_CONTRACT_VERSION you implement
  probe(): Promise<ExecutorProbe>;
  capabilities(): ExecutorCapabilities;
  submit(req: SubmitRequest): Promise<ExecRef>;
  observe(ref: ExecRef): AsyncIterable<ExecEvent>;
  respond(ref, requestId, decision: "allow" | "deny"): Promise<"accepted" | "unknown_request" | "too_late">;
  cancel(ref, scope: "turn" | "owned"): Promise<"cancelled" | "too_late" | "unsupported" | "uncertain" | "no_active">;
  reconcile(attemptKey: string): Promise<{ found: ExecRef } | { absent: true } | { unknown: true; reason?: string }>;
  deleteOwnedSession?(session: { kind; locator }): Promise<"deleted" | "not_found" | "refused" | "failed">;
}
```

`assertWorkflowExecutor(value)` checks the shape (id, semver version, compatible contract version,
every method).

| Method | Obligation |
|---|---|
| `probe()` | Readiness without a model call: `installed`, `cliVersion`, `auth` (`ok`/`missing`/`expired`/`unknown`; auth is the CLI's own), optional `capabilities` rows confirmed on this machine (merged as `source: "probed"`), `mcpOutputLimitChars` / `mcpOutputNoticeChars` (below), `modelListComplete` (the reported model list names every model the CLI accepts; absent/`false` = a missing role model is only noted, `true` = it is refused), `notes`. |
| `capabilities()` | The declared capability table (below). Pure; no I/O. |
| `submit(req)` | Start the attempt, or return the existing `ExecRef` for a known `attemptKey` (idempotent: the same key never causes a second effect). Calls `req.authority.consume()` immediately before the first side effect (next section). |
| `observe(ref)` | The normalized event stream of the attempt: `started` first and once, then any events, then exactly one terminal event (`completed` or `failed`). Another process may call it (`sessionBound` says whether that can re-attach). |
| `respond(ref, id, decision)` | Answer an `approval_request` the stream emitted. |
| `cancel(ref, scope)` | `turn` interrupts the current turn; `owned` stops everything the attempt owns. The result is not evidence of termination: `observe`/`reconcile` decide that. Waiting past a deadline is never a cancel. |
| `reconcile(attemptKey)` | After a crash: `found` (the attempt exists), `absent` (proven never launched) or `unknown` (cannot prove either way). `unknown` is not `absent`: the engine stops and asks a person instead of retrying. |
| `deleteOwnedSession(session)` | Optional. Delete a CLI session the adapter kept and reported as `ownedSession` on a terminal event. The engine calls it only with locators recorded as owned by this executor id: when the task completes or is skipped, when the run completes or fails, and on `prune` (below). Refuse anything else (`refused`). `not_found` is not an error; `failed` means the deletion did not complete (retried on prune). Without the method the engine records `unsupported`. |

`SubmitRequest` carries `attemptKey`, `authority`, `cwd` (always explicit), `prompt`, optional
`systemPrompt`, `model`, `effort`, `tools` (workflow tool names), `readOnly`, `mcpServers`, optional
`sessionId` / `resumeSessionId` (only when the engine wants a kept session, below), `deadlineMs`
(absolute epoch ms), `env` (secrets; never persisted),
`isolation: {inherit, scope?: {contextFiles, skills}}` (an adapter that cannot load the scoped parts separately inherits all user context), `approvalPolicy`, `permissionMode`, and `artifactsDir` (absolute directory
owned by the runtime, where the adapter may keep raw CLI logs; may be absent). The engine validates
it with `validateSubmitRequest` (for example: an MCP server env value that also appears on its argv
is rejected).

### Execution authority

Every request carries a one-time `ExecutionAuthority`. The durable runtime backs it with the
launch barrier: `consume()` waits for the engine's `released`-or-`revoked` decision.

1. Do all preparation that has no external effect first (build argv, write private config files in
   `artifactsDir`, validate).
2. Call `await req.authority.consume()` **immediately before the first effect** (spawning the CLI,
   sending `turn/start`, …). Never call it earlier "to be safe" and never cause an effect before it.
3. If the decision is `revoked` (the user stopped the run, the lease was lost), make **no** effect:
   `submit` must reject with an `SdkError` coded `AUTHORITY_REVOKED` (`requireReleased(decision)`
   throws exactly that). It must not resolve with a ref or emit events.
4. `consume()` resolves `released` at most once per attempt; a second call rejects with
   `AUTHORITY_ALREADY_CONSUMED`. That is what blocks duplicate effects across resume rounds and
   processes: on a repeated `submit` for a known `attemptKey`, return the recorded ref instead of
   consuming again.

The runtime treats a ref or an event without a released authority as a fence violation. The
conformance kit's `fencing.*` checks verify the order with an effect counter from your harness.

### Capabilities

`ExecutorCapabilities` describes what the adapter can enforce or provide. Most rows are a `Level`:

```ts
interface Level {
  level: "native" | "emulated" | "none";
  source: "declared" | "probed" | "unverified";
  verifiedWith?: string;   // e.g. CLI version and conformance kit version
  warning?: string;        // environment weakness on this machine (no secrets, no user patterns)
}
```

Rows: `mcpInjection`, `readOnly`, `toolAllowlist` (`detail: fine | coarse | none`), `systemPrompt`
(`replace | append | none`), `modelSelect`, `resume` (`native | fork | replay | none`),
`partialStream`, `usage` (`cost | tokens | none`), `toolTelemetry`, `cancel` (`notify | interrupt |
kill`), `nativeSchema`, `contextIsolation`, `fastTier`, `toolResultBudget`, `webTools` (`detail:
search | search+fetch | none`, `safetyPolicy: engine | cli | unknown`), plus `toolLoop`, `context`,
`sessionBound` and `effortLevels`. Start from `noneCapabilities()` and spread your rows over it;
`validateCapabilities` checks the table.

How `negotiateCapabilities` reads a row:

- **`source`.** `declared`: you claim it. `probed`: your `probe()` confirmed it on this machine (it
  overrides the declared row). `unverified`: nobody has confirmed it yet; it is **refused** wherever
  a stage needs it, unless the user opts in (`--allow-unverified <name>`). Do not declare `native`
  for something you have not verified; declare `unverified`.
- **`level`.** `native` passes. `emulated` passes as "emulated by executor". `none` is missing: per
  requirement the stage is refused (`CAPABILITY_MISSING:<key>`), degraded and recorded, or emulated
  by the engine.
- **`warning`.** An `emulated` row with a `warning` negotiates as a degradation
  (`CAPABILITY_WARNING:<key>`) instead of a silent pass. Use it for environment facts that weaken a
  capability (Codex: `~/.codex/rules` allow rules weaken `readOnly`; a global `AGENTS.md` weakens
  `contextIsolation`). In `free` mode such warnings are recorded and never refused; in `safe` mode a
  profile's `strictCapabilities` can refuse them. Neither mode asks.
- **Details** are ranked (`toolAllowlist`: none < coarse < fine; `usage`: none < tokens < cost;
  `webTools`: none < search < search+fetch).
- **`usage.cost`** below `cost` (an adapter that reports tokens only): the engine has no price table
  and does not emulate cost. A preferred `usage.cost` degrades with `recordOnly: true` (the cost is
  recorded as unknown, `null`, never `0`; no confirmation needed, `strict` still refuses it); a
  required one is refused.
- **`webTools.safetyPolicy`** other than `engine` always records a degradation (`unknown` for the built-in
  CLIs: URL, private-network and redaction controls are the CLI's).
- **`toolAllowlist`** below `fine` on a stage with a precise `tools` list: `free` mode records it
  (`acceptedByFreeMode`); `safe` mode refuses unless the spec sets `allowReadOnlyDowngrade` (then the
  stage runs with readOnly enforced, `forcedReadOnly`). The forced `readOnly` is then negotiated
  like an authored readOnly stage: `strict` readOnly refuses an emulated one, and an environment
  warning is recorded as `CAPABILITY_WARNING:readOnly` (without confirmation).
  Free never forces a readOnly downgrade or negotiates a readOnly requirement (including explicit
  overrides); authored readOnly instead gets a short informational note, not a warning/refusal.

Stage requirements come from the spec (readOnly only when enforced in safe mode, required reads → `mcpInjection`, tools, web tools,
partial output, same-session repair, context inheritance). The run records the negotiation; the user sees
it as the capability preview before launch.

### Tool vocabulary

Specs name tools with workflow names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `web_search`,
`fetch_content`, `workflow_artifact`). Ship a `ToolMapping` (`entries` keyed by workflow name): `tool`
(native names, fine), `sandbox` (`read-only` / `workspace-write`, coarse), `mcp` (served by an
injected server) or `none`. `mapTools(requested, mapping)` returns the native tools, the sandbox mode,
unmapped names and whether anything mutates. `WORKFLOW_TOOL_NAMES` and `WorkflowToolName` define the vocabulary;
`WORKFLOW_TOOL_KINDS` gives each tool's ACP kind; mutating
kinds (`edit`, `delete`, `move`, `execute`) are denied on safe readOnly stages; free allows all kinds.

### Events and usage

`observe` yields `ExecEvent`s (validated by `validateExecEvent`, ordered by `validateEventSequence`):

| Event | Fields |
|---|---|
| `started` | `sessionId: string \| null` |
| `message_delta` | `text` |
| `tool_call` | `name`, `kind` (ACP kind), `status` (`pending`, `approval_pending`, `running`, `completed`, `failed`, `denied`, `timed_out`), optional `callId`, `input`, `output` |
| `usage` | `input`, `output`, `cached` (integers or `null`), optional `cacheWrite` and `peakContext` (integers or `null`) and `model` (string), `cost` (number or `null`), `source` (`reported`, `estimated`, `unknown`) |
| `approval_request` | `requestId` (unique per stream), `kind`, `detail` |
| `completed` | `finalText`, optional `ownedSession`, optional `toolResultBudget` |
| `failed` | `class` (below), `message`, `raw` (JSON or `null`), optional `ownedSession`, optional `toolResultBudget` |

`toolResultBudget` (optional on either terminal event; additive, 2026-11-08): what the adapter's own
tool-result eviction did during the attempt — `enabled` (boolean, required), and optional
`maxTotalChars`, `toolResults`, `retainedChars`, `evictedCount`, `evictedChars`, `evictableCount`,
`forcedEvictionApplied`, `warning`. Pi reports its context-hook state; adapters without eviction omit
it. The runtime copies it into the attempt result's `metadata.toolResultBudget`, where the engine's
per-task telemetry (`tasks[].toolResultBudget`) reads it; without it the engine records the attempt as
`unavailable`.

Usage shape (the same for every adapter): `input` = input tokens
**excluding** cache reads and cache writes (subtract them when the CLI counts them inside its input),
`cached` = cache-read input tokens, `cacheWrite` = cache-creation input tokens (absent = none),
`output` = output tokens with reasoning included, `model` = the model that served the request (the
resolved name, not a request alias such as `haiku`). Do not send a total: the runtime computes
input + cached + cacheWrite + output (`null` when a part is `null`) and the engine records it with the
model on the task. An event that sums several model requests (Codex reports per turn) may add
`peakContext`, the largest single request's prompt (input + cache reads + cache writes); without it the
runtime takes the event's input side as one request. `validateExecEvent` checks `cacheWrite`,
`peakContext` and `model` when present (additive; contract 0.1.0).

Usage rules: `null` means unknown and is different from `0`. `source: "unknown"` always pairs with
`cost: null`, and `cost: null` always with `source: "unknown"`; never invent a cost. `estimated`
marks a cost you computed (for example from the CLI's price catalog). The runtime sums usage events
per attempt; a field is `null` when any event reported it unknown. Keep raw CLI output in
`artifactsDir`; events are a view over it.

#### Sessions and retention

Workers keep no CLI session by default. The engine sets `SubmitRequest.sessionId` only
when a task needs a kept session (today: the experimental same-session repair,
`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`). Without a `sessionId` run the CLI without session
persistence (the built-in adapters use Claude `--no-session-persistence`, Codex `ephemeral: true`, Pi
`--no-session`) and report no `ownedSession`. With one, report the kept session as `ownedSession` on
the terminal event; the engine records it on the task and later passes exactly that locator to
`deleteOwnedSession`: at once for a completed or skipped task, for every remaining entry when the run
completes or fails, and on `prune` for entries not yet `deleted`/`not_found`. Blocked and interrupted
runs keep the sessions of their failed, blocked and interrupted tasks until resolved or pruned. A
locator recorded for another executor id is `refused` by the engine and never passed on.

### Errors and classification

A `failed` event carries a `FailureClass`: `transient`, `rate_limit`, `auth`, `config`, `permanent`,
`cancelled`, `unknown`. Map CLI error text with an ordered rule table and `classifyFailure(input,
rules)` (first match wins; `exitCode` may narrow a rule). Anything unmatched is `unknown`, never
guessed as `transient`. Only `transient` and `rate_limit` are retried automatically
(`isAutoRetryable`); `unknown` stops the run for a person to decide. `cancelled` means terminated by
an engine or user cancel.

Thrown errors are `SdkError` with a stable `code` (`AUTHORITY_REVOKED`, `AUTHORITY_ALREADY_CONSUMED`,
`INVALID_REQUEST`, `UNKNOWN_EXEC_REF`, `DESCRIPTOR_*`, `CONTRACT_VERSION_MISMATCH`, …) and an optional
`subject` (`qualifiedCode`, e.g. `CAPABILITY_MISSING:toolAllowlist.fine`). Throw errors from `submit`
only before any effect; after the effect, report failure through the stream.

### Descriptors and `version.ts`

A detached supervisor or a resumed run cannot receive adapter objects. The run record stores an
`ExecutorDescriptor` (data), and every process reloads the adapter with `loadExecutor(descriptor)`:

```ts
{ id: "my-cli", version: "0.1.0", contractVersion: "0.1.0",
  module: "@scope/my-adapter" /* or an absolute path / file: URL */, config: { /* JSON */ } }
```

- The module exports `createExecutor(config)` (or a default export with it). `loadExecutor` refuses,
  never substitutes, when the module is missing (`DESCRIPTOR_MODULE_NOT_FOUND`), the built id differs
  (`DESCRIPTOR_ID_MISMATCH`), or the adapter or contract version is incompatible.
- `config` is persisted in plain text (`worker.json`, `executor.json`, run records). Never put a
  secret in it: values that look like tokens are refused by `validateExecutorDescriptor`. Secrets go
  through `SubmitRequest.env` or `McpServerSpec.env`, which the runtime keeps off disk.
- **`version.ts` convention.** Keep the adapter's id and version in a dependency-free module
  (`src/executors/<id>/version.ts` exports `<ID>_EXECUTOR_ID` and the adapter version). The core
  registry imports only that file to build the built-in descriptor, so the core never pulls an
  adapter (or its CLI-specific code) into its import graph.
- **Executor policy.** Rules the engine must apply before launch for one built-in executor live in
  that adapter's `policy.ts` (Pi: host tools its workers inherit, `provider/model` naming, the fast
  tier, per-task descriptor config, the pi-web-access doctor fix), reached through
  `src/core/executor-policy.ts`. The engine asks what an executor supports instead of testing its id;
  a registered third-party executor has no policy (no host tools, no fast tier).
- Register a third-party adapter in process with `registerWorkflowExecutor(descriptor)` (from
  `@agwab/agent-workflow`); a run then selects it with `executor: "<id>"` (CLI `--executor <id>`).

### Permission modes

Every request says `permissionMode: "free" | "safe"` (the engine always sets it; **absent means
`safe`**, `effectivePermissionMode`). `isUnrestricted(req)` is true for every `free` request.
`enforcesReadOnly(req)` is true only for readOnly in `safe` (including absent mode). An adapter must:

1. `safe` (or absent): use no bypass or auto-accept setting; route approvals to `respond()`.
2. Every `free` request: start the CLI without approval prompts and without sandbox
   restrictions, with the CLI's documented setting (prefer a documented mode value over a
   `--dangerously-*` alias). Keep the approval channel wired.
3. Enforce readOnly only when `enforcesReadOnly(req)` is true. Free requests keep requested tools,
   opted-in host tools and foreign injected MCP servers without readOnly filtering/refusals. Preserve
   the authored flag in prompts/records and engine-side scheduling/worktree decisions.
4. Keep context isolation (no user settings, instructions, hooks, skills unless `isolation.inherit`)
   independent of the mode.
5. Document both mappings and register them with the conformance kit (`harness.permissionModes`,
   check `permission.mode_mapping`); a CLI without approvals or a sandbox declares `equivalent` with
   the reason.

| Adapter | `free` (including readOnly) | `safe` |
|---|---|---|
| Claude | `--permission-mode bypassPermissions` | `--permission-mode default` (+ `--disallowedTools` for readOnly) |
| Codex | `sandbox: "danger-full-access"`, `approvalPolicy: "never"` | mapped sandbox (`workspace-write` / `read-only`), `approvalPolicy: "on-request"` |
| Pi | every requested tool, including opted-in host tools (no approvals or sandbox) | readOnly drops mutating tools from `--tools` and disables host-tool inheritance |
| Gemini / Antigravity (ACP) | `yolo`, no readOnly tool filtering | readOnly: Gemini `plan`; Antigravity `default` + filtering and engine policy |

Approvals that still arrive are answered by the engine (`decideApproval`): `free` allows everything,
including mutating kinds on a readOnly stage; `safe` allows the policy's `allowKinds`, asks an
interactive host, and otherwise denies (fail closed, also on timeout). Details:
[permissions](usage.md).

### MCP injection

`req.mcpServers` lists stdio servers to attach to the worker (`name`, `command`, `args`, `env`). The
engine uses it for the `workflow_artifact` server ([artifact server](#workflow-artifact-mcp-server)); a stage with required reads
needs `mcpInjection` and is refused on an executor without it.

- Attach each server under exactly its `name`; the model sees the tool under the CLI's naming scheme
  (Pi, Codex and Claude: `mcp__<server>__<tool>`). The engine renders `workflow_artifact` in prompts per
  executor id (`ARTIFACT_TOOL_NAME_MAPPINGS`); an id without a row gets
  `mcp__workflow_artifact__workflow_artifact`, so a CLI with a different scheme needs a row there.
- Pass `env` to the server process only; never put an env value on argv.
- Do not merge in the user's own MCP servers unless the request inherits context.
- **Delivery limit.** If the CLI cuts long tool results, declare it in `probe()`:
  `mcpOutputLimitChars` (results up to this size pass unchanged) and `mcpOutputNoticeChars` (what the
  CLI adds around a cut result). See [Measured limits](#measured-limits) for the server budget
  calculation and [Delivery bound](#delivery-bound) for truncation rules.

## Conformance kit

Run the kit before claiming a capability, then cite the report (kit version and date) in
`verifiedWith`. Import `@agwab/agent-workflow/sdk/conformance` to check an adapter against the
[SDK contract](#writing-an-executor-adapter). Kit version: `CONFORMANCE_KIT_VERSION = "0.3.0"`; SDK contract: `0.1.0`.

### Tiers

| Tier | Requirements | Default |
|---|---|---|
| `offline` | Harness with stubs/fakes; no model calls | On |
| `live` | `harness.live === true`, real CLI; may cost money | Off |
| `runtime` | Reloadable executor descriptor and cross-process effect counts; real detached durable worker | Off |

Unavailable scenarios, unrequested tiers and capabilities declared `none` produce `skip` with a
reason, never an implicit pass.

### Running the kit

```js
import { test } from "node:test";
import { registerConformanceTests, runConformance } from "@agwab/agent-workflow/sdk/conformance";

registerConformanceTests({ test, harness: myHarness });
const report = await runConformance(myHarness, { tiers: ["offline"], only: ["fencing."] });
// { kitVersion, contractVersion, harness, executor, tiers, ok, summary, results[] }
```

Options: `tiers`, `only` / `exclude` (check id or prefix), `timeouts`, `catalog`, `onResult`.
Default timeouts: `callMs` 5 s, `streamMs` 15 s, `liveStreamMs` 300 s, `checkMs` 60 s. Contract calls
and stream drains are time-bounded.

### Harness contract

```ts
interface ConformanceHarness {
  name: string;
  scenarios: ConformanceScenario[];
  open(scenario): Promise<HarnessSession>; // fresh executor per check
  request?(base, scenario): SubmitRequest; // retain attemptKey and authority
  descriptor?(): Promise<{ descriptor; registry? }>;
  live?: boolean;
  runtime?(scenario, { workDir }): Promise<RuntimeStage>;
  permissionModes?: {
    free: string[]; safe: string[]; // substrings of argv.join("\n") + stdin lines
    readOnly?: string[];           // required on safe + readOnly; no free-only setting
    equivalent?: string;           // explanation if modes use identical settings
  };
}
interface HarnessSession {
  executor: WorkflowExecutor;
  effectCount(attemptKey?): Promise<number>;
  launches?(attemptKey): Promise<LaunchRecord[]>; // argv, env keys, stdin lines
  restart?(): Promise<WorkflowExecutor>;          // same durable state
  dispose?(): Promise<void>;
}
interface RuntimeStage {
  descriptor: ExecutorDescriptor; // reloadable in a fresh process; JSON config, no secrets
  effectCount(attemptKey?): Promise<number>; // file-backed or equivalent
  runInput?: Record<string, JsonValue>;
  dispose?(): Promise<void>;
}
```

Each attempt gets a `FenceProbe` authority. It records the effect count at each `consume()` so the
kit can detect effects before consume, missing consume and duplicate release. Count effects from
the stub CLI's invocation log, not adapter state. Probes must not count as launches.

#### Scenario contracts

| Scenario | Required behavior |
|---|---|
| `complete` | `started`, output, optional usage, `completed` |
| `usage_unknown` | Complete without reported cost: `cost: null`, `source: "unknown"` |
| `slow` | Start and stay running for several seconds so cancel can be checked |
| `approval` | Request kind `execute`; allow completes; deny/timeout never completes the execute tool |
| `crash_after_consume` | Consume authority, then fail before launch evidence |
| `mcp_tool` | Call injected server `conformance`, tool `echo`, with prompt nonce `conformance-nonce:<nonce>`; report a `tool_call` |
| `fail_transient` … `fail_permanent` | CLI error text maps to the requested failure class |
| `fail_unknown` | Unrecognized text maps to `unknown` |

### Catalog

| Check ids | What they check |
|---|---|
| `identity.shape`, `probe.shape` | Method shape, versions, stable identity, serializable probe |
| `probe.side_effect_free` | Probe/capabilities cause no effects or authority consumption |
| `capabilities.valid`, `capabilities.probe_merge` | Stable valid declared table and valid probe merge |
| `submit.idempotent_sequential`, `submit.idempotent_concurrent`, `submit.idempotent_after_restart` | Same key returns the same ref with one effect, including restart |
| `submit.rejects_invalid` | Mismatched authority or empty cwd refused before effects |
| `fencing.consume_before_effect` | One released consume immediately before effect |
| `fencing.revoked_before_consume` | Rejection, zero effects, no found attempt |
| `fencing.crash_after_consume` | Same-key resubmission after a crash adds no effect |
| `events.sequence` | Started first, one terminal last, no later event (100 ms grace) |
| `events.json_serializable`, `events.observe_replay`, `events.unknown_ref` | JSON refs/events, identical completed replay, unknown-ref rejection |
| `events.partial_stream` | Declared partial streaming produces deltas |
| `usage.cost_honesty` | Unknown cost is null/unknown, never zero; cost requires `usage.detail: cost` |
| `approval.allow`, `approval.deny`, `approval.respond_unknown`, `approval.timeout_fail_closed` | Allow/deny, unknown request, too-late answer, timeout denial |
| `permission.mode_mapping` | Documented free/safe settings; free readOnly is unrestricted, safe readOnly has no free-only settings; requires `permissionModes` and `launches` |
| `cancel.active`, `cancel.declared_matches`, `cancel.inactive` | Bounded cancellation, honest unsupported/uncertain results, terminal and unknown refs |
| `reconcile.found`, `reconcile.absent`, `reconcile.unknown` | Found launch after restart, proven absence, consume-crash never called absent |
| `errors.failure_classes`, `errors.unknown_class` | Ordered error mapping and unknown fallback |
| `descriptor.reload` | Same id and compatible version after descriptor reload |
| `mcp.injection`, `mcp.argv_no_secrets` | Injected server receives env and is called; secret absent from argv |
| `mcp.delivery_bound` | Output at twice the declared limit arrives within limit plus notice allowance |
| `mcp.paged_read` | One engine-sized ASCII page arrives whole; skips without limit or if normalized tool-output cap is smaller |

Live checks:

| Id | What it checks |
|---|---|
| `live.readonly_enforced` | Cannot create a requested file |
| `live.tool_allowlist` | `tools: ["read"]` prevents shell execution |
| `live.isolation` | `inherit: false` ignores project instruction files |
| `live.session_ownership` | Requested session is reported as `ownedSession` |
| `live.resume` | Resume recalls the prior turn |

Runtime checks:

| Id | What it checks |
|---|---|
| `runtime.durable_authority` | Zero effects before V2 release, exactly one after; revoke yields `cancelled/revoked`; killing a worker after its effect never reconciles absent or launches again |
| `runtime.detach_rediscovery` | Launcher exits; fresh worker reloads descriptor and completes; incompatible recorded version yields `failed/guard_failure`, zero effects |
| `runtime.control_relay` | Fresh host relays allow/deny through durable mailbox with audit and accepted ack; owned cancel yields confirmed `cancelled/user_cancelled`; terminal request returns `no_active` |

### Building blocks

- `createFakeHarness(options)` stages scenarios with the SDK fake executor. Options: `executor`,
  `scripts` / `faults` per scenario, `scenarios`, `wrap(executor, {scenario, store, generation})`,
  `descriptor`, `mcpOutputLimitChars` (default 4096; `null` unknown). `runtime: false` disables its
  runtime stage; `runtime.faults` supports fault injection. Declare `toolOutputEventLimitChars`
  when normalized tool events are clipped (Codex: 16,384).
- `createStubCli({dir, name?, scripts})` writes a POSIX launcher for a Node ESM script. First
  `when.argvIncludes` match wins. Steps: `stdout`, `stderr`, `sleepMs`, `exit`, `hang`,
  `awaitStdin` (with `otherwise`). Invocation logs include argv, cwd, env keys, stdin lines,
  signals and exit code, not env values. Mark probe scripts `effect: false`. Readers:
  `invocations()`, `launches(filter)`, `effectCount(filter)`; setters: `setScripts`, `reset`.
- `createStubMcpServer({dir, name?, padChars?, env?})` provides `initialize`, `ping`, `tools/list`
  and `tools/call`, tools `echo{text}` and `fail`. Returns an `McpServerSpec`, `log()` and
  `toolCalls()` readers. Secrets go only in `env`.
- `callMcpTool(spec, tool, args)` is a time-bounded stdio client.
- `test/conformance/stub-cli-adapter.mjs` is a process-adapter example: event-line parsing, 0600
  MCP config, SIGTERM cancel and fail-closed approvals. It skips consume-crash and MCP scenarios
  and has no runtime stage because its attempt store is in memory.

### Conformance limits

The runtime tier writes run locators to `AGENT_WORKFLOW_RUN_INDEX_DIR` (default under the user
home); the locator sweep prunes them. Owned cancel can wait `AGENT_WORKFLOW_CANCEL_GRACE_MS`
(default 10 s) when the adapter ignores cancellation.

Direct adapter checks require the adapter to deny unanswered approvals itself; the durable runtime
also applies `approvalPolicy.timeoutMs`. Revoked submit must reject with `AUTHORITY_REVOKED`.

The fake executor can return `accepted` to an immediate second answer before its script resumes;
the kit checks `too_late` after termination. The fake has no stop/dispose hook, so the harness cleans
up through its store.

Delivery checks cover declared CLI limits, not artifact-ledger assurance. The server's
[paging and ledger rules](#paged-reads) independently determine required-read coverage.
Live isolation checks cover project instruction files only; a passing check is not an OS sandbox.

## Host API

The CLI, Pi extension and host MCP server call shared typed handlers. The module has no Pi imports.

```ts
import { runWorkflowAction, waitAction } from "@agwab/agent-workflow/hosts/api";
const launched = await runWorkflowAction({ cwd }, {
  workflow: "deep-review", task: "…", executor: "claude",
});
let waited;
do waited = await waitAction({ cwd }, { runId: launched.data.runId! });
while (waited.data.stillRunning);
```

### Common contract

`HOST_API_VERSION = "1"`. `HostApiContext`:

| Field | Meaning |
|---|---|
| `cwd` | Project directory; runs live in its [state directory](usage.md#where-run-state-lives) |
| `env?` | Role checks and user home; defaults to `process.env` |
| `host?` | `claude-code`, `codex`, `pi`, `cli`, `generic`; selects host-aware hints and default executor |
| `defaultExecutor?` | Explicit host default, below the saved user profile |
| `runtimeDefaults?` | Host model/effort; lowest-precedence runtime defaults |
| `availableModels?` | Host model registry; enables per-workflow Pi profile preferences |
| `hostTools?` | `{projectTrusted: boolean}` for Pi native codemode/MCP inheritance |
| `readonly?` | Prevent automatic dashboard process startup |

Host defaults: Claude Code → `claude`, Codex → `codex`, Pi → `pi`; CLI/generic/absent → first
installed and logged-in of pi → claude → codex.

`HostResult<T>` has `action`, `outcome`, `ok`, JSON-serializable `data` and human-readable `text`.
Outcomes: `success`, `running`, `completed`, `failed`, `blocked`, `interrupted`, `refused`,
`existing`, `timeout`. `ok` is true only for success/running/existing/completed. Hosts print `text`
unchanged; follow-up hints use CLI commands, `/aw`, or MCP tool calls according to `ctx.host`.

Caller mistakes throw `HostUsageError`; invalid specs throw `WorkflowValidationError`.
`formatHostError(error)` renders either. Launch refusals are results, not exceptions. Role checks
allow `worker` / `disabled` processes only `validate` and `help`.

`exitCodeFor`: `ok` → 0, otherwise 1; a still-running wait (`data.stillRunning`) or pending stop
(`data.pending`) → 1; usage error → 2. The [host MCP server](hosts.md) returns usage errors with
`isError` and `error.kind: "usage"`.

### Handlers

| Handler | Request | Data |
|---|---|---|
| `helpAction` | command? | `{command?}` |
| `listWorkflowsAction` | `{query?, offset?, limit?}` | `{workflows, total, nextOffset?, omitted}`; entries include name, aliases, specPath, description?, agent?, readOnly? |
| `validateWorkflowAction` | `{workflow}` | `{valid, name?, specPath, workflowName?, type, tasks, roles, maxConcurrency, blockedPermissionPreviews, warnings}` |
| `workflowRolesAction` | `{workflow}` | `{specPath, roles}` |
| `listAgentsAction` | — | `{agents}` with name, displayName, description?, scope, model?, effort?, tools?, readOnly?, sourcePath |
| `showAction` | `{ref, raw?, snapshot?, includeTaskLogs?, includeReport?, includeTask?}` | Run: `{kind: "run", run, launch?, taskLogIds?, report?, runtimeTask?}`; workflow: `{kind: "workflow", specPath, spec}` |
| `profileAction` | list/show/set/delete/default/presets (below) | `{op, path, default?, profiles?, profile?, deleted?, presets?}` |
| `workflowPreferenceAction` | `{op: "list"}` / `{op: "show", workflow}` / `{op: "set", workflow, profile?, roles?, unset?}` / `{op: "clear", workflow}` | `{op, path, workflow?, preference?, preferences?, cleared?}` |
| `runWorkflowAction` | Launch options plus `workflow` | `LaunchData` |
| `runDynamicAction` | Launch options, no `workflow` | `LaunchData`, `mode: "direct-dynamic"` |
| `statusAction` | `{runId?}` | One `{run}` with tasks, pendingApprovals?, parentUsage?; otherwise `{runs}` top-level, newest first |
| `inspectAction` | `{runId, failures?, results?}` | `{run, reliability: {health, outputRetries, launchRetries, resumeEvents, contextLimitFailures}, listed, parentUsage?, launch?}` |
| `logsAction` | `{runId, task?, lines?, stream?}` | Bounded task log tails (below) |
| `waitAction` | `{runId, timeoutMs?, longWait?, signal?, onProgress?}` | `WaitData` |
| `resumeAction` | `{runId, detach?}` | `{runId, status, resetTaskIds, taskSummary, detached?}` |
| `autoAction` | Consent, choice and launch options (below) | `AutoData` |
| `stopAction` | `{runId, timeoutMs?}` | `{runId, status, interruptedTaskIds, pending}` |
| `pruneAction` | `{keep?, olderThanDays?, yes?}` or `{argv}` | `WorkflowPruneSummary` |
| `noticesAction` | `{argv}`: list, acknowledge, clear | List: `{notices, acknowledgements, warnings}`; mutation: `{action, runId, notificationOnly}` |
| `doctorAction` | `{prober?, probeTimeoutMs?, nodeVersion?}` | `{host, executors, defaultExecutor, permissionMode, node, home, warnings, runIndex, usable}`; no model call or writes |
| `executorModelsAction` | `{executors?, prober?, timeoutMs?}` | `{executors: [{id, usable, state, models, modelListComplete, note, error?}]}`; default pi/claude/codex, shared 60 s probe cache |
| `superviseAction` | `{runId? \| all, pollMs?, maxRuntimeMs?, onLog?, signal?, testHooks?}` | `{runIds, maxRuntimeMs, runs, result}` |
| `redriveRunsAction` | — | `{redriven, skipped: [{runId, reason: "live-supervisor"}], errors}` |
| `superviseDetachedAction` | `{runId}` | `{runId, status, started, reason?: "not-running" \| "live-supervisor", detached?: {pid, logPath}}` |

Queries and ordinary mutations return `success`; launch/wait/resume return the applicable
run outcome. Prune fails on `summary.error`; doctor fails when no executor is usable. Pending stop
returns `running`. An identical active launch returns `existing`.

Paged catalog output is bounded to 50 KB / 2000 lines; `limit` accepts 1–20, omitted lists every workflow.
`show.snapshot` reads persisted state without refresh, lease or executor polling. `includeTaskLogs`
returns ids with host-verified logs; `includeReport` returns bounded report text; `includeTask`
returns redacted task text up to 8,000 characters, not the workflow description.

`RunSummary` contains runId, name?, status, type, createdAt, updatedAt, parentRunId?, executor?,
executors?, permissionMode?, statusDetail? (`driver_lost`: an `interrupted` run the engine stopped because its driver process ended, not a user stop), taskSummary. Mixed-run task summaries include executor/model/effort.

#### `run` / `dynamic`

| Launch option | Contract |
|---|---|
| `task` | Required runtime task |
| `executor`, `permissionMode` | Run overrides; mode `free` / `safe` |
| `profile` | Declared profile, saved user profile, then built-in preset (`codex`, `claude`, `pi`, `mixed`); unknown names throw |
| `allowUnverifiedCapabilities` | Capability opt-in keys |
| `model`, `effort` | Overrides for every stage |
| `inputOverrides` | Typed values for declared inputs |
| `detach` | Spawn detached `agent-workflow supervise`; return `{pid, logPath}`, log at `<run dir>/supervise.log` |
| `forceNew` | Bypass duplicate guard |
| `selectProfile(title, options, meta?)` | Declared-profile chooser; `meta.headlessOption` is the default profile, otherwise Base |
| `launchOrigin` | Host command/tool provenance |

With no requested profile: saved workflow preference > saved Pi per-workflow preference (hosts with
`availableModels`) > declared default/chooser > default saved user profile > none. Saved workflow
role assignments apply on every host. A captured user profile supplies executor, permission mode,
strict capabilities and model/effort defaults. Without an artifact graph, executor/mode are run
options and strict capabilities refuse.

`LaunchData` includes mode, runId?, status?, name?, specPath?, executor? `{id, source, profile?,
host?}`, permissionMode? `{mode, source, profile?}`, profile? `{name, kind, source}`, roles?
`{mixed, executors, stages, warnings?}`, capability? `{preview, degradations,
forcedReadOnly}`, taskSummary?, detached?, promptSchemaNotice?, duplicateOf?, refusal? `{code,
executorId?, preview?}`. Profile kinds: declared/user/workflow-preference/preset; sources:
request/workflow-default/user-default/workflow-preference. Text starts with capability preview,
then role table and launch card.

Refusals start no run: `EXECUTOR_PROBE_FAILED`, `EXECUTOR_NOT_INSTALLED`,
`EXECUTOR_AUTH_NOT_READY`, `CAPABILITY_REFUSED`, `MODEL_UNKNOWN`,
`EXECUTOR_UNAVAILABLE`,
`DUPLICATE_LAUNCH_IN_PROGRESS`, `WORKFLOW_DEFINITION_CHANGED`. Missing role models are refused only
when the probe's model list is complete; partial lists produce a note.

**Duplicate-launch guard.** Every host API launch hashes kind, cwd, resolved spec path/name,
trimmed task, typed inputs, requested execution options, resolved host/executor/profile/preference
snapshot, inherited defaults and workflow definition fingerprint. `detach` and UI hooks are not
part of identity. Settings are resolved once; the engine refuses a changed definition before launch.
CLI/generic installed-default login changes within the guard window are not detected.

An identical non-terminal run (`running`, `pending`, `blocked`) created within 10 minutes returns
`existing`, with `duplicateOf`, and starts no supervisor. Terminal/pruned/older runs or `forceNew`
start a new run. Claims live at `.agent-workflow/host-launches/<sha256>.json` in the
[state directory](usage.md#where-run-state-lives); concurrent callers
wait up to 15 s for the first run id. Claims use owner tokens, per-identity locks and a 60 s lease
renewed every 15 s. Dead same-host owners allow takeover; live or unverifiable owners retain claims
until 1 hour after lease expiry. An ownership check immediately before start prevents stale owners
launching. Background launch cleanup and prune remove old inactive claims; symlinked control roots
refuse pruning, and unrelated files are retained. Direct SDK launches are not guarded.

The handler returns after launch; long-lived hosts retain an unref'd in-process watcher. Short-lived
hosts must wait or detach. Returning an existing attached run does not attach a new supervisor;
`wait`, `resume` or `supervise` can drive it.

**Launch capture.** `run.launch` uses `agent-workflow-run-launch-v1`: source, entry, requestKind,
`routingMode: "off"`, profile, task character/line counts and command size/SHA-256. The redacted
command/tool call is stored as `<run dir>/launch-command.txt` (0600). Sources: cli, pi,
`mcp:<host>`; entries: command/action or tool/name. Missing origin synthesizes a CLI command.
`show` and `inspect` return launch metadata and command text.

Auto launches use `agent-workflow-run-launch-v2`, `routingMode: "auto"`, and
selection: offered candidates, recommendation or null, selected candidate, choseRecommendation,
classifier executor/model, consent source `command`, taskSha256. The selected candidate must
match requestKind. Classifier reasons are not persisted.

#### `logs`

`LogsData`: runId, name?, status, lines, streams, tasks (taskId, specId, status, statusDetail,
streams with kind/path/lines/truncated), omittedTasks, truncated. `stream` selects output, stderr
or events. `task` accepts task/spec id; unknown throws. Without task, return at most six most
recently started tasks. Lines per stream: 1–400, default 20; each line capped at 400 characters;
text and data stop at 48,000 characters. The run is refreshed first.

Read paths must be relative to the [state directory](usage.md#where-run-state-lives), without
`..`, and resolve inside its `.agent-workflow/`; absolute,
traversal and symlink escapes are not read and get `refused` reasons. Inspect results and result
presentation enforce the same artifact boundary. Credential assignments, structured/escaped JSON
secrets, authorization/cookie/API-key headers, bearer tokens, URL secrets, sensitive environment
values (8+ characters), and macOS/Linux/Windows home paths are redacted. Malformed quoted
credentials fail closed through the rest of the line. The same redactor covers show/status/inspect,
wait previews and Pi completion messages.

#### `wait`

A normal call drives scheduling for at most 45 s (default and cap; minimum 1 s). Repeat while
`stillRunning`. Cancelling `signal` cancels only the wait. `longWait: true` is for hosts without
per-call limits: default 30 minutes, cap 4 hours. `timeoutMs` in data is the effective bound.

`WaitData`: runId, status, semanticStatus, terminal, actionRequired, stillRunning, timeoutMs,
blockedTaskIds, taskSummary, outputTaskIds, outputRetryAttempts, launchRetryAttempts, artifactRoot,
nextRetry?, verdict?, verdictGate?, preview?, reportArtifacts, usage?, degradation?, pendingApprovals?,
dashboard?. `onProgress` receives a RunSummary.

| State | terminal | actionRequired | stillRunning |
|---|---|---|---|
| Bound reached while running | false | false | true |
| Blocked | false | true | false |
| Completed/failed/interrupted | true | false | false |

`preview` is the first completed output task's `completionSummaryMarkdown`, otherwise summaries/
reports, capped at 6,000 characters. Successful text is the preview alone. `reportArtifacts` lists
report/audit paths; dashboard links open report view when appropriate.

`verdictGate` also permits a declared-failed output task when every other task completed/skipped,
the task has a nonempty domain verdict, and an existing final report resolves inside the run's own
directory. Text then says “Workflow finished — verdict: X (report ready)”; status/outcome remain
failed (CLI exit 1). Generic support failures do not qualify. Terminal `statusAction` uses the same
presentation. `nextRetry` is `{at, retryAfterMs, reason?, message?, taskIds}` when the only remaining
work is in retry backoff.

#### `auto`

`AutoRequest` takes launch options without workflow, plus optional `compare` and `signal`.
It sends one classifier request and starts the top recommendation without consent or choice hooks.
The classifier follows request > saved profile > host executor precedence. Task transmission
restrictions, size bounds and cancellation still start nothing. The selected named spec is
rehashed before launch; changed specs return `stale`. There is no classifier-failure fallback.

`compare(operation)` wraps the classifier call with cancellation (Pi loader); late output is
discarded when the action signal aborts. `AutoData` includes phase, classifierCalled, classifier?,
consent? (`command`), shortlist, status?, reason?, recommendation?, ranked?, selected?, launch?, next?.
Phases: `classifier-unavailable`, `stale`, `launched`.

#### `stop`

Writes durable stop intent. If another supervisor holds the lease, retry for `timeoutMs` (default
15 s), then return `pending: true`, outcome running. The active supervisor applies the intent.

#### `supervise`

Schedules a run or all running top-level runs until terminal; failure takes precedence over blocked;
an empty batch succeeds. `maxRuntimeMs`: default 4 hours, 0 unlimited; a single running workflow
with `maxRounds: null` defaults to unlimited. `onLog` receives progress lines; testHooks are test-only.

`redriveRunsAction` schedules once, then watches runs with scheduler work that no other live process
drives; blocked stays blocked, unknown reconcile needs a decision. It binds no delivery audience.
`superviseDetachedAction` starts a standalone supervisor unless no work remains or another process
holds the lease/has a live-pid heartbeat younger than 30 s.

### Parsers

String-based hosts can use `parseWorkflowRunArgs`, `parseWorkflowDynamicArgs`,
`parseWorkflowPruneArgs`, `parseSuperviseArgs`, `tokenizeWorkflowArgs`, `parseDuration`,
`parsePermissionMode`, `parseEffortLevel`, `parseCapabilityList`. Run/dynamic accept leading or
trailing options; quoted text is literal. Duplicate options and `--route` / `--no-route` are
rejected. Options include model, profile, effort, executor,
permission-mode, allow-unverified, detach and force-new.

Also exported: `selectWorkflowExecutionProfile`, `resolveWorkflowExecutionProfileForLaunch`,
`spawnDetachedSupervisor`, `agentWorkflowCliPath`, `readWorkflowResultPresentation`.

### Saved user profiles

`profileAction` operations: list, show(name?), set(name, values?, unset?, makeDefault?, preset?),
delete(name), default(name or null), presets. Role values and `unset: ["roles.<role>"]` are
supported. Workflow preferences accept name/spec path, key by spec.name, and validate referenced
profiles and executor ids.

Profiles live in `$AGENT_WORKFLOW_HOME/user-profiles/v1/profiles.json`, private file/directory,
schema `agent-workflow-user-profiles-v1`, with default? and profiles keyed by name. Values include
executor?, model?, effort?, permissionMode?, strictCapabilities?, roles?, updatedAt. Names are
1–64 characters of `[A-Za-z0-9._-]`. Reads/writes reject unknown fields and invalid values; malformed
files are reported, never rewritten. Workflow preferences use `workflow-preferences/v1` separately.

### Test-executor hook

CLI-only `registerTestExecutorFromEnv(env)` loads `testExecutorDescriptor` from an absolute
`AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` only with `AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only` and an
id beginning `test-`; otherwise throws `TestExecutorHookError`. Handlers never invoke it.

### Not in the host API

Pi completion delivery/audiences/receipts, footer, parent-session usage tracking, session-start
notices, board and profile-picker UI belong to the [Pi host](hosts.md), not shared handlers.

## Workflow artifact MCP server

Workers read upstream workflow artifacts through one MCP tool, `workflow_artifact`. The server is
`dist/mcp/artifact-server/server.js` (source `src/mcp/artifact-server/`). It is hand-written and has
zero runtime dependencies. It wraps the core tool body from `src/core/workflow-artifact-tool.ts`
and preserves its tool contract.

### Launching the artifact server

```
node dist/mcp/artifact-server/server.js --config <task>/artifact-access.json [--max-output-chars <n>]
```

- `artifactMcpServerSpec(config)` (core) returns `[server.js, "--config", path]`.
- `artifactMcpServerSpecWithOutputLimit(config, limit)` (`src/mcp/artifact-server/spec.ts`) adds
  `--max-output-chars <limit>`. Pass `null` when the limit is unknown. It wraps the core
  `withArtifactMcpOutputLimit(spec, limit)`.
- **Measured limit.** The engine launches the server itself with the right limit; adapters
  pass the spec through unchanged. See [Measured limits](#measured-limits).
- The limit is a flag and not a config field. Launch provenance digests the config bytes, and
  `assertArtifactAccessConfig` rejects unknown keys.
- Exit codes:
  - `2`: usage error (missing `--config`, unknown flag, bad `--max-output-chars`).
  - `1`: the server refused to start (see Security).
  - `0`: graceful exit on stdin EOF, SIGTERM or SIGINT. Requests already in flight are answered first, and their ledger rows are written. SIGTERM gives them at most 5 s.

### Protocol

- **Transport:** stdio, newline-delimited UTF-8 JSON-RPC 2.0.
  - stdout carries protocol messages only. `console.*` is redirected to stderr.
  - stderr carries short diagnostics only: startup refusal, internal errors. It never prints env values or artifact content.
- **Accepted input framing:** `\r\n`, blank lines, messages split across chunks, and a final line without a newline. Lines over 4 MiB get a parse error and are discarded.
- **Versions:** `2025-11-25` (latest), `2025-06-18`, `2025-03-26`, `2024-11-05`.
  - The server only uses lifecycle, `ping` and tools with text content, and these are the same in all four revisions.
  - **Negotiation:** if the client's `protocolVersion` is supported, the server echoes it. Otherwise it answers `2025-11-25` and the client decides.
- **Version-gated details:**
  - JSON-RPC batches are accepted only in a `2025-03-26` session, the only revision that has them. Other sessions get `-32600`.
  - Tool `annotations` are sent from `2025-03-26` on.
  - Tool `title` is sent from `2025-06-18` on.
- **Methods:**
  - `initialize` returns:
    - `capabilities: {tools: {listChanged: false}}`
    - `serverInfo: {name: "agent-workflow-artifact", version}`
    - `instructions`: the tool guidelines
  - `notifications/initialized` and other notifications are accepted and get no response. A
    `notifications/cancelled` for a request still in flight suppresses that request's response
    (MCP cancellation rule).
  - `ping` → `{}`.
  - `tools/list` and `tools/call` need a completed `initialize`. The server does not wait for `notifications/initialized`, because some clients pipeline requests.
- **Errors:**

  | Code | When |
  |---|---|
  | `-32700` | parse error (`id: null`) |
  | `-32600` | bad request: no `jsonrpc: "2.0"`, null or invalid id, unsupported batch, request before `initialize`, second `initialize` |
  | `-32601` | unknown method |
  | `-32602` | bad params: `initialize` without `protocolVersion`, missing tool name, unknown tool, non-object `arguments` |
  | `-32603` | unexpected internal failure |

  Invalid tool *arguments* are not protocol errors. They return a tool result with `isError: true`, so the model can correct itself (2025-11-25 guidance).
- **Shared layer:** the transport and method dispatch live in `src/mcp/stdio-server.ts`,
  shared with the host MCP server ([host MCP server](hosts.md)); this server supplies its tool,
  instructions and call handler (`src/mcp/artifact-server/stdio.ts`).

### Artifact tool contract

- `name`: `workflow_artifact`.
- `description`: `WORKFLOW_ARTIFACT_TOOL_DESCRIPTION`, verbatim.
- `inputSchema`: `WORKFLOW_ARTIFACT_TOOL_PARAMETERS`, verbatim:
  - `action`: `list` | `read`, required.
  - `source`: a canonical source name.
  - `artifact`: one of `control`, `analysis`, `refs`, `raw`, `prompt`, `system-prompt`, `stderr`, `result`.
  - `path`: a simple JSON path.
  - `maxItems` and `maxChars`: integers ≥ 0. They require `path`.
  - `offset`: integer ≥ 0, a character offset for a paged whole-artifact read. It cannot be
    combined with `path`, `maxItems` or `maxChars` (tool error). See [Paged reads](#paged-reads).
- `annotations`: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: false` (each read appends a ledger row), `openWorldHint: false`.
- **Guidelines:** `WORKFLOW_ARTIFACT_TOOL_GUIDELINES` are sent as the server `instructions`, one `-` bullet per line. Not every client puts server instructions into the model context (Pi 1.1 does not), so the task runner also puts the guidelines into the worker system prompt.
- **Results:**
  - The result is a single `content` text item. Its text is identical to the core tool's text whenever it fits the delivery bound.
  - Tool-level failures return `isError: true` and the core failure payload (`status: "blocked"`, `code: "artifact_read_failed"`, …).
  - **No `structuredContent`.** Some clients prefer `structuredContent` over `content` when both are present, so the model would lose the artifact text. It would also double the bytes counted against the client limit.

### Read ledger

Every successful `read` appends one row to `config.ledgerPath` (`<task>/read-ledger.jsonl`). The
row is the core `WorkflowArtifactReadLedgerRecord`, with the same keys and key order, written as one
JSON object per line:

| Field | Meaning |
|---|---|
| `schema` | `workflow-artifact-read-v1` |
| `runId`, `taskId` | from the config |
| `source`, `artifact` | what was read |
| `at` | ISO time of the read |
| `bytes` | artifact size in bytes |
| `returnedBytes` | artifact bytes returned. `0` for a duplicate-suppressed read. If the response was cut, this is the prefix that was actually delivered |
| `truncated` | the content is incomplete (core limits, projection limits, or the delivery bound) |
| `rawAssurance` | only for `raw` reads |
| `path`, `maxItems`, `maxChars` | projection parameters as the core resolved them |
| `deliveryUnverified` | `true` when the server cut the response to fit the delivery bound. `false` on page rows: the page was delivered whole within the limit. Absent otherwise |
| `rangeStart`, `rangeEnd`, `totalChars`, `contentSha256` | Page rows only. The row covers UTF-16 chars `[rangeStart, rangeEnd)` of the artifact text (`totalChars` long). `contentSha256` is the sha256 (hex) of the whole artifact file *version* that was paged. All four are present together, never with `path` |

The core tool hands its row to the server (`appendLedger: false` + `onLedgerRecord`). The server
appends it through `appendWorkflowArtifactReadLedger`, adjusting
`truncated`/`returnedBytes`/`deliveryUnverified` when the response was cut.

**Dedup.** The core caches live for one server process, which is
one task attempt.

- Completed sources are memoized, and every read still writes a full row.
- With `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP=1` in the server env, an identical re-read is suppressed and writes a row with `returnedBytes: 0`. Raw reads are never suppressed.
- MCP clients may filter the env they pass to servers. An adapter that wants this flag must put it in `McpServerSpec.env`.
- A suppressed re-read of a read whose delivery was cut is also written `truncated: true, deliveryUnverified: true`. A repeat call therefore cannot turn into clean evidence.

The `tools/call` requests are serialized, so rows keep call order. The ledger reader rejects
inconsistent page fields: partial sets, start greater than end, end greater than total, invalid
SHA-256, or ranges combined with `path`. Non-page row shapes remain valid.

### Paged reads

Whole-artifact reads can span pages while preserving required-read assurance.

- **Contract.** `read` without `path` takes `offset` (default 0). The response is
  `# workflow_artifact: <source>.<artifact>\n\n` + the artifact text `[offset, end)` (+ the raw
  assurance line for `raw`) + a footer:
  - `[workflow_artifact page: chars X–Y of N; call again with offset=Y to continue]`, or
  - `[workflow_artifact page: chars X–N of N; end of artifact]` on the last page.
- **Size.** The whole response, footer included, fits the server's output limit in UTF-16 chars
  *and* UTF-8 bytes (the footer is budgeted at its widest). A page never starts or ends inside a
  surrogate pair: an `offset` on the second half of a pair starts one char earlier, and the footer
  and row report the real start.
- **When.** A read with `offset` is always paged. A read without `offset` uses the core text and
  row (including the core 50 KiB / 2000-line truncation) when its response fits the limit; when it does not fit, it is served as its first page instead of being cut. Projections
  (`path`) and `list` are never paged; they are still cut (see Delivery bound).
- **Whole file.** A paged read decodes the whole file (UTF-8), so config `maxBytes`/`maxLines` do
  not apply to it; the page size is the bound. Files over 64 MiB are refused. Each page re-reads
  and re-validates the file (raw integrity included), so an artifact that changes between pages
  gets a new `contentSha256`.
- **Errors (tool results, no row).** `offset` ≥ the length (except 0 on an empty artifact), a
  negative or non-integer `offset`, `offset` with `path`/`maxItems`/`maxChars`.
- **Caches.** Paged reads never use the duplicate-read or completed-read caches, and they never
  populate the duplicate-read cache.
- **Rows.** One row per page: `bytes` (artifact), `returnedBytes` (UTF-8 bytes of the page),
  `truncated` (`true` unless the page covers the whole artifact, so a
  `!truncated` check never takes one page for a whole read), the four range fields and
  `deliveryUnverified: false`. A page row the server had to cut anyway (it should not happen) gets
  `deliveryUnverified: true` like any cut read.
- **Coverage rule (engine, `src/core/required-reads.ts`).** A whole-artifact required read is
  satisfied by one whole verified row, as before, **or** by verified page rows
  (`deliveryUnverified: false`, `truncated: true`) of the **same** `contentSha256`/`totalChars`
  whose ranges cover `[0, totalChars)` (any order, overlaps allowed). Unverified or cut rows never
  count, and pages of different versions never combine. With `count`, each complete page set counts
  as one read. Projected requirements (`path`/`maxItems`/`maxChars`) and `requiredReadPolicy`
  checks are unchanged (pages carry no `path`; a page is `truncated`). When coverage is incomplete,
  the failure message names the missing ranges, e.g. `incomplete paged reads (read the missing
  ranges with offset): producer.analysis: paged read incomplete, missing chars 300–500, 900–1000 of
  1000`; with pages of several versions it says so.
- **Tool text.** The description and guidelines tell the worker to page on with the footer's
  offset and that a required read counts only once every page was read. Bundled prompts should say the same.

### Measured limits

- `probe()` declares `mcpOutputLimitChars` / `mcpOutputNoticeChars`. The run record keeps
  them in `run.capabilityNegotiation.probe`, present only when the probe reports them.
- The server limit is `artifactServerOutputLimit(probe)` (`src/sdk/mcp-delivery.ts`):
  `limit − notice − max(256, ⌈5 % × limit⌉)`, clamped to 512 … 16 MiB; `null` without a declared
  limit (the server then keeps 8192).
  - The notice allowance is subtracted although results up to the declared limit pass unchanged:
    a CLI whose real cut point is a little lower than declared still never cuts a page.
  - The margin covers client framing the declaration may not count (content joins, escaping,
    token-vs-char rounding).

  | Executor | Declared limit | Notice | Margin | Server `--max-output-chars` |
  |---|---|---|---|---|
  | Pi 1.1 | 20,480 bytes | 1,024 (declared bound; ~220 measured) | 1,024 | **18,432** |
  | Claude | 22,500 chars (`floor(0.9 × MAX_MCP_OUTPUT_TOKENS 25,000)`) | 0 | 1,125 | **21,375** |
  | Codex | 32,000 chars (`tool_output_token_limit` 10,000 pinned) | 0 | 1,600 | **30,400** |
  | unknown | — | — | — | none (server default 8,192) |

- `preparedMcpServers(launch, {artifactOutputLimitChars})` (task runner) appends the flag to the
  `workflow_artifact` server, with `artifactServerOutputLimitForRun(run)`. Other servers are not
  touched.
- **Provenance.** `launch-bootstrap-provenance` digests `artifacts.serverSpecSha256` over the spec
  *with* the same flag (same derivation from the same recorded probe), so the digest binds the
  limit actually launched. Runs without a recorded limit digest the plain spec as before.
  `effectiveLaunch.artifactBinding.serverSpecSha256` still digests the sealed (plain) spec.

### Delivery bound

A CLI may cut an MCP result again after the server returns it. The server therefore cuts first:

- **Limit:** `--max-output-chars <n>` (512 … 16 MiB). Without the flag the default is **8192**.
  - The default is below every limit found for the built-in executors:
    - Pi 1.1 cuts the middle of text results over 20 KB.
    - Claude Code caps MCP output at `MAX_MCP_OUTPUT_TOKENS`, default 25,000 tokens.
    - Codex has per-tool and per-server output token limits of about 10k by default.
  - It also leaves headroom for client wrapping and escaping.
  - The engine passes the measured limit (see Measured limits).
- **Units:** a response fits when *both* its UTF-16 length and its UTF-8 byte length are ≤ the limit. This holds whether the client counts chars, code points or bytes. Cuts never split a surrogate pair.
- **Fits:** the response is returned unchanged and the row is written as the core wrote it.
- **Does not fit (whole read):** served as its first page (see Paged reads); not cut.
- **Does not fit (projected read):**
  - The server returns the longest prefix plus a notice. The notice says that the read is truncated and `deliveryUnverified`, that it does not satisfy required reads, and that a `path` + `maxItems`/`maxChars` re-read gives a smaller projection.
  - The row gets `truncated: true`, `deliveryUnverified: true` and the delivered `returnedBytes`.
- **Does not fit (list / failure):** the output is cut with a short notice. No row is written, because lists and failures are not ledgered.
- **Unknown limit:** the default applies, and every row whose content was cut is marked `deliveryUnverified: true`.
- **Engine rule:** rows with `deliveryUnverified: true` never satisfy a required read. These rows also carry `truncated: true`, which the check already rejects. Page coverage can satisfy a whole read (see Paged reads).

### Artifact server security

- **Startup refuses** (exit 1, no stdout) on:
  - a missing, unreadable, symlinked or non-regular config;
  - invalid JSON, or anything `assertArtifactAccessConfig` rejects (unknown keys, version ≠ 1, relative paths, bad `accessMode` or limits);
  - NUL bytes in config paths;
  - a config that is not the task's `artifact-access.json` next to its manifest;
  - `manifestPath` or `ledgerPath` outside `runDir`;
  - a missing `runDir`;
  - a manifest that is missing, symlinked or a non-regular file;
  - a manifest or ledger whose real path leaves the real `runDir`;
  - a symlinked, hard-linked or non-regular ledger;
  - a manifest that fails core validation (for example an artifact path outside `runDir`);
  - a manifest `runId`/`taskId` that differs from the config.
- **Per call:** the tool accepts no filesystem paths. Sources must match `^[A-Za-z0-9_.:-]+$` without `..`, so traversal, absolute paths, `/` and NUL are rejected. Artifacts must be one of the enum kinds. The core then refuses symlinked or hard-linked artifacts, artifacts whose real path leaves the run dir (including through symlinked directories), and files that change during validation. The file is opened with `O_NOFOLLOW`.
- **Ledger writes:** the server re-checks that the ledger is a single-link regular file inside the run dir, then appends with the core writer: `O_APPEND|O_CREAT|O_NOFOLLOW`, mode `0600`; the opened descriptor must be a single-link regular file, the same file as the path (dev/inode) with an unchanged, non-symlinked parent directory, and its fully resolved path must be inside the real run dir. A hard link or a symlinked directory swapped in between the check and the open is refused (`isError`) and nothing is written through it (a swapped ancestor can leave an empty file created by `O_CREAT` in the swapped-in directory).
- **Reads:** the server reads only the config, the manifest, the artifacts the manifest lists inside `runDir`, and its ledger.
- **Debug artifacts:** `prompt`, `system-prompt`, `stderr` and `result` are readable only when the *config* says `accessMode: "human-debug"`. The manifest `policy` cannot raise access, because the config `accessMode` always wins.
- **Secrets:** env values never appear in logs, results or the ledger. The spec argv carries only the entry, the config path and the limit.

### Visible tool names

`artifactToolVisibleName(executorId)` and `ARTIFACT_TOOL_NAME_MAPPINGS` live in `src/core/artifact-tool-names.ts`
(the core prompt renderer uses them); `src/mcp/visible-names.ts` and `dist/mcp/artifact-server/index.js` re-export them. MCP server name: `workflow_artifact`.

| Executor | Visible name | Naming rule |
|---|---|---|
| `claude` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>` |
| `codex` | `mcp__workflow_artifact__workflow_artifact` | `mcp__<server>__<tool>` unless `non_prefixed_mcp_tool_names` is enabled |
| `pi` | `mcp__workflow_artifact__workflow_artifact` | Non-alphanumeric/underscore characters become `_`; collision gets a hash suffix |
| other | `mcp__workflow_artifact__workflow_artifact` | Fallback convention |

The task runner renders worker prompts with this name and includes the tool guidelines in each
worker system prompt that has the artifact server.
