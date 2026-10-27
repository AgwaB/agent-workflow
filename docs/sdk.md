# Writing an executor adapter

An executor adapter lets agent-workflow run workflow workers on one agent CLI. The engine never
talks to a CLI directly: it builds a `SubmitRequest` per task attempt and hands it to a
`WorkflowExecutor`. This page is the contract an adapter keeps. Entry points:

| Import | Content |
|---|---|
| `@agwab/agent-workflow/sdk` | Contract, capabilities, events, errors, descriptors, tool mapping, permission and approval helpers, negotiation |
| `@agwab/agent-workflow/sdk/testing` | `createFakeExecutor` (scripted, in memory) |
| `@agwab/agent-workflow/sdk/conformance` | The conformance kit ([`conformance.md`](conformance.md)) |

The SDK has no Pi imports and no runtime dependencies. Contract version:
`EXECUTOR_CONTRACT_VERSION = "0.1.0"`. For 0.x, compatible means the same major and minor; from 1.0
the same major. The three stage-1 adapters are references: [`executors/pi.md`](executors/pi.md),
[`executors/codex.md`](executors/codex.md), [`executors/claude.md`](executors/claude.md).

## The contract

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
| `probe()` | Readiness without a model call: `installed`, `cliVersion`, `auth` (`ok`/`missing`/`expired`/`unknown`; auth is the CLI's own, D1), optional `capabilities` rows confirmed on this machine (merged as `source: "probed"`), `mcpOutputLimitChars` / `mcpOutputNoticeChars` (below), `notes`. |
| `capabilities()` | The declared capability table (below). Pure; no I/O. |
| `submit(req)` | Start the attempt, or return the existing `ExecRef` for a known `attemptKey` (idempotent: the same key never causes a second effect). Calls `req.authority.consume()` immediately before the first side effect (next section). |
| `observe(ref)` | The normalized event stream of the attempt: `started` first and once, then any events, then exactly one terminal event (`completed` or `failed`). Another process may call it (`sessionBound` says whether that can re-attach). |
| `respond(ref, id, decision)` | Answer an `approval_request` the stream emitted (R#4). |
| `cancel(ref, scope)` | `turn` interrupts the current turn; `owned` stops everything the attempt owns. The result is not evidence of termination: `observe`/`reconcile` decide that. Waiting past a deadline is never a cancel. |
| `reconcile(attemptKey)` | After a crash: `found` (the attempt exists), `absent` (proven never launched) or `unknown` (cannot prove either way). `unknown` is not `absent`: the engine stops and asks a person instead of retrying (B3). |
| `deleteOwnedSession(session)` | Optional (D3, R#10). Delete a CLI session the adapter kept and reported as `ownedSession` on a terminal event. The engine calls it only with locators recorded as owned by this executor id: when the task completes or is skipped, when the run completes or fails, and on `prune` (below). Refuse anything else (`refused`). `not_found` is not an error; `failed` means the deletion did not complete (retried on prune). Without the method the engine records `unsupported`. |

`SubmitRequest` carries `attemptKey`, `authority`, `cwd` (always explicit), `prompt`, optional
`systemPrompt`, `model`, `effort`, `tools` (Pi tool names), `readOnly`, `mcpServers`, optional
`sessionId` / `resumeSessionId` (only when the engine wants a kept session, below), `deadlineMs`
(absolute epoch ms), `env` (secrets; never persisted),
`isolation: {inherit}`, `approvalPolicy`, `permissionMode`, and `artifactsDir` (absolute directory
owned by the runtime, where the adapter may keep raw CLI logs; may be absent). The engine validates
it with `validateSubmitRequest` (for example: an MCP server env value that also appears on its argv
is rejected).

## Execution authority

Every request carries a one-time `ExecutionAuthority` (R#1). The durable runtime backs it with the
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

## Capabilities

`ExecutorCapabilities` describes what the adapter can enforce or provide. Most rows are a `Level`:

```ts
interface Level {
  level: "native" | "emulated" | "none";
  source: "declared" | "probed" | "unverified";
  verifiedWith?: string;   // e.g. "codex-cli 0.159.2, conformance 2026-10-26"
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

How the engine reads a row (B4, `negotiateCapabilities`):

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
  `contextIsolation`). In `free` mode such warnings are recorded and never refused; in `safe` mode an
  interactive host asks and a profile's `strictCapabilities` refuses.
- **Details** are ranked (`toolAllowlist`: none < coarse < fine; `usage`: none < tokens < cost;
  `webTools`: none < search < search+fetch).
- **`usage.cost`** below `cost` (an adapter that reports tokens only): the engine has no price table
  and does not emulate cost. A preferred `usage.cost` degrades with `recordOnly: true` (the cost is
  recorded as unknown, `null`, never `0`; no confirmation needed, `strict` still refuses it); a
  required one is refused.
- **`webTools.safetyPolicy`** other than `engine` always records a degradation (`unknown` for every
  stage-1 CLI: URL, private-network and redaction controls are the CLI's).
- **`toolAllowlist`** below `fine` on a stage with a precise `tools` list: `free` mode records it
  (`acceptedByFreeMode`); `safe` mode refuses unless the spec sets `allowReadOnlyDowngrade` (then the
  stage runs with readOnly enforced, `forcedReadOnly`).

Stage requirements come from the spec (readOnly, required reads → `mcpInjection`, tools, web tools,
partial output, same-session repair, B5 `inherit`). The run records the negotiation; the user sees
it as the capability preview before launch.

## Tools

Specs name tools with Pi names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `web_search`,
`fetch_content`, `workflow_artifact`). Ship a `ToolMapping` (`entries` keyed by Pi name): `tool`
(native names, fine), `sandbox` (`read-only` / `workspace-write`, coarse), `mcp` (served by an
injected server) or `none`. `mapTools(requested, mapping)` returns the native tools, the sandbox mode,
unmapped names and whether anything mutates. `PI_TOOL_KINDS` gives each tool's ACP kind; mutating
kinds (`edit`, `delete`, `move`, `execute`) are denied on readOnly stages.

## Events and usage

`observe` yields `ExecEvent`s (validated by `validateExecEvent`, ordered by `validateEventSequence`):

| Event | Fields |
|---|---|
| `started` | `sessionId: string \| null` |
| `message_delta` | `text` |
| `tool_call` | `name`, `kind` (ACP kind), `status` (`pending`, `approval_pending`, `running`, `completed`, `failed`, `denied`, `timed_out`), optional `callId`, `input`, `output` |
| `usage` | `input`, `output`, `cached` (integers or `null`), optional `cacheWrite` (integer or `null`) and `model` (string), `cost` (number or `null`), `source` (`reported`, `estimated`, `unknown`) |
| `approval_request` | `requestId` (unique per stream), `kind`, `detail` |
| `completed` | `finalText`, optional `ownedSession` |
| `failed` | `class` (below), `message`, `raw` (JSON or `null`), optional `ownedSession` |

Usage shape (WP12a, the same for every adapter whatever its CLI reports): `input` = input tokens
**excluding** cache reads and cache writes (subtract them when the CLI counts them inside its input),
`cached` = cache-read input tokens, `cacheWrite` = cache-creation input tokens (absent = none),
`output` = output tokens with reasoning included, `model` = the model that served the request (the
resolved name, not a request alias such as `haiku`). Do not send a total: the runtime computes
input + cached + cacheWrite + output (`null` when a part is `null`) and the engine records it with the
model on the task. `validateExecEvent` checks `cacheWrite` and `model` when present (additive;
contract 0.1.0).

Usage rules: `null` means unknown and is different from `0`. `source: "unknown"` always pairs with
`cost: null`, and `cost: null` always with `source: "unknown"`; never invent a cost. `estimated`
marks a cost you computed (for example from the CLI's price catalog). The runtime sums usage events
per attempt; a field is `null` when any event reported it unknown. Keep raw CLI output in
`artifactsDir`; events are a view over it (D3).

### Sessions and retention

Workers keep no CLI session by default (D3, WP12a). The engine sets `SubmitRequest.sessionId` only
when a task needs a kept session (today: the experimental same-session repair,
`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`). Without a `sessionId` run the CLI without session
persistence (the stage-1 adapters use Claude `--no-session-persistence`, Codex `ephemeral: true`, Pi
`--no-session`) and report no `ownedSession`. With one, report the kept session as `ownedSession` on
the terminal event; the engine records it on the task and later passes exactly that locator to
`deleteOwnedSession`: at once for a completed or skipped task, for every remaining entry when the run
completes or fails, and on `prune` for entries not yet `deleted`/`not_found`. Blocked and interrupted
runs keep the sessions of their failed, blocked and interrupted tasks until resolved or pruned. A
locator recorded for another executor id is `refused` by the engine and never passed on.

## Errors and classification

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

## Descriptor and `version.ts`

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
- Register a third-party adapter in process with `registerWorkflowExecutor(descriptor)` (from
  `@agwab/agent-workflow`); a run then selects it with `executor: "<id>"` (CLI `--executor <id>`).

## Permission modes

Every request says `permissionMode: "free" | "safe"` (the engine always sets it; **absent means
`safe`**, `effectivePermissionMode`). `isUnrestricted(req)` is true only for `free` on a request that
is not `readOnly`. An adapter must:

1. `safe` (or absent): use no bypass or auto-accept setting; route approvals to `respond()`.
2. `free` on a non-readOnly request: start the CLI without approval prompts and without sandbox
   restrictions, with the CLI's documented setting (prefer a documented mode value over a
   `--dangerously-*` alias). Keep the approval channel wired.
3. readOnly: exactly the `safe` settings in both modes.
4. Keep B5 isolation (no user settings, instructions, hooks, skills unless `isolation.inherit`)
   independent of the mode.
5. Document both mappings and register them with the conformance kit (`harness.permissionModes`,
   check `permission.mode_mapping`); a CLI without approvals or a sandbox declares `equivalent` with
   the reason.

| Adapter | `free` (not readOnly) | `safe` / readOnly |
|---|---|---|
| Claude | `--permission-mode bypassPermissions` | `--permission-mode default` (+ `--disallowedTools` for readOnly) |
| Codex | `sandbox: "danger-full-access"`, `approvalPolicy: "never"` | mapped sandbox (`workspace-write` / `read-only`), `approvalPolicy: "on-request"` |
| Pi | same as `safe` (no approvals or sandbox) | readOnly drops mutating tools from `--tools` |

Approvals that still arrive are answered by the engine (`decideApproval`): `free` allows everything
except mutating kinds on a readOnly stage; `safe` allows the policy's `allowKinds`, asks an
interactive host, and otherwise denies (fail closed, also on timeout). Details:
[`permissions.md`](permissions.md).

## MCP injection and delivery limits

`req.mcpServers` lists stdio servers to attach to the worker (`name`, `command`, `args`, `env`). The
engine uses it for the `workflow_artifact` server ([`mcp.md`](mcp.md)); a stage with required reads
needs `mcpInjection` and is refused on an executor without it.

- Attach each server under exactly its `name`; the model sees the tool under the CLI's naming scheme
  (all stage-1 CLIs: `mcp__<server>__<tool>`). The engine renders `workflow_artifact` in prompts per
  executor id (`ARTIFACT_TOOL_NAME_MAPPINGS`); an id without a row gets
  `mcp__workflow_artifact__workflow_artifact`, so a CLI with a different scheme needs a row there.
- Pass `env` to the server process only; never put an env value on argv.
- Do not merge in the user's own MCP servers unless the request inherits context (B5).
- **Delivery limit (R#9).** If the CLI cuts long tool results, declare it in `probe()`:
  `mcpOutputLimitChars` (results up to this size pass unchanged) and `mcpOutputNoticeChars` (what the
  CLI adds around a cut result). The engine then starts the artifact server with
  `artifactServerOutputLimit(probe)` = limit − notice − max(256, 5 % of the limit), clamped to
  [512, 16 MiB]; a text fits when both its UTF-16 length and its UTF-8 byte length are within it. Without
  a declaration the server uses 8192. Measured stage-1 limits are in [`mcp.md`](mcp.md).

## Conformance

Run the kit before claiming a capability: an offline tier with your harness's stub or fake CLI (no
model calls; runs in CI), an optional live tier against the real CLI, and a runtime tier that drives
the durable worker in a fresh process. Write a `ConformanceHarness` (scenarios such as `complete`,
`usage_unknown`, `approval`, `crash_after_consume`, `mcp_tool`, `fail_*`), then:

```js
import { test } from "node:test";
import { registerConformanceTests, runConformance } from "@agwab/agent-workflow/sdk/conformance";

registerConformanceTests({ test, harness: myHarness });            // one node:test test per check
const report = await runConformance(myHarness, { tiers: ["offline"] }); // JSON evidence
```

Cite the report (kit version and date) in `verifiedWith`. The harness contract, scenario contracts
and the check catalog are in [`conformance.md`](conformance.md).
