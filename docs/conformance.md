# Executor conformance kit

Import `@agwab/agent-workflow/sdk/conformance` to check an adapter against the
[SDK contract](sdk.md). Kit version: `CONFORMANCE_KIT_VERSION = "0.3.0"`; SDK contract: `0.1.0`.

## Tiers

| Tier | Requirements | Default |
|---|---|---|
| `offline` | Harness with stubs/fakes; no model calls | On |
| `live` | `harness.live === true`, real CLI; may cost money | Off |
| `runtime` | Reloadable executor descriptor and cross-process effect counts; real detached durable worker | Off |

Unavailable scenarios, unrequested tiers and capabilities declared `none` produce `skip` with a
reason, never an implicit pass.

## Running

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

## Harness contract

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
    readOnly?: string[];           // required on free + readOnly; no free-only setting
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

### Scenario contracts

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

## Catalog

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
| `permission.mode_mapping` | Documented free/safe settings and no free-only settings on readOnly; requires `permissionModes` and `launches` |
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

## Building blocks

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

## Limits

The runtime tier writes run locators to `AGENT_WORKFLOW_RUN_INDEX_DIR` (default under the user
home); the locator sweep prunes them. Owned cancel can wait `AGENT_WORKFLOW_CANCEL_GRACE_MS`
(default 10 s) when the adapter ignores cancellation.

Direct adapter checks require the adapter to deny unanswered approvals itself; the durable runtime
also applies `approvalPolicy.timeoutMs`. Revoked submit must reject with `AUTHORITY_REVOKED`.

The fake executor can return `accepted` to an immediate second answer before its script resumes;
the kit checks `too_late` after termination. The fake has no stop/dispose hook, so the harness cleans
up through its store.

Delivery checks cover declared CLI limits, not artifact-ledger assurance. The server's
[paging and ledger rules](mcp.md#paged-reads) independently determine required-read coverage.
Live isolation checks cover project instruction files only; a passing check is not an OS sandbox.
