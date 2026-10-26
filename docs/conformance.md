# Executor conformance kit (WP9a)

Entry point: `@agwab/agent-workflow/sdk/conformance` (source `src/sdk/conformance/`, Pi-free).

The kit checks that a `WorkflowExecutor` keeps the SDK contract (stage-1 plan §2): idempotent submit,
fencing at the effect boundary, honest events and costs, the approval channel, cancel, reconcile,
error classes, MCP injection, and rediscovery. It was built before the adapters (WP6–WP8) so they can
be developed against it. WP9b runs the three adapters through it.

Kit version `CONFORMANCE_KIT_VERSION = 0.3.0` (WP4e: offline check `permission.mode_mapping`, area `permission`, harness `permissionModes`, `LaunchRecord.stdin`; 0.2.0 WP2b: runtime tier implemented; `runtime.broker_relay` renamed `runtime.control_relay` — it was a never-run placeholder), SDK contract `0.1.0`.

## Tiers

| Tier | What it needs | Default |
|---|---|---|
| `offline` | A harness with stubs or fakes. No model calls. | on (CI) |
| `live` | `harness.live === true` and a real CLI. May cost money. | off. Opt in with `tiers: ["offline", "live"]` |
| `runtime` | `harness.runtime(scenario)`: an executor descriptor the durable runtime can reload in a fresh process, and cross-process effect counts. The checks drive the real runtime (launch barrier, detached durable worker, reconcile, control mailbox, WP2b) | off. Opt in with `tiers: ["runtime"]`; offline with a fake/stub stage |

A check is never passed silently. If the tier was not requested, the scenario is unsupported, or the
capability is declared `none`, the check is reported as `skip` with a reason.

## Running

```js
import { test } from "node:test";
import {
 createFakeHarness,
 registerConformanceTests,
 runConformance,
} from "@agwab/agent-workflow/sdk/conformance";

// 1) JSON report (store it as evidence; `verifiedWith` can cite kitVersion + date)
const report = await runConformance(myHarness, { tiers: ["offline"], only: ["fencing."] });
// report: { kitVersion, contractVersion, harness, executor, tiers, ok, summary, results[] }

// 2) One node:test test per check (skips call t.skip(reason))
registerConformanceTests({ test, harness: myHarness });
```

Options:

- `tiers`
- `only` / `exclude`: id or id prefix
- `timeouts`: `callMs` 5s, `streamMs` 15s, `liveStreamMs` 300s, `checkMs` 60s
- `catalog`
- `onResult`

Every contract call and stream drain is time-bounded. A hanging `cancel()` therefore fails a check
instead of hanging the run.

## Harness contract

```ts
interface ConformanceHarness {
  name: string;
  scenarios: ConformanceScenario[];        // what this harness can stage
  open(scenario): Promise<HarnessSession>; // fresh executor per check
  request?(base, scenario): SubmitRequest; // e.g. set model/env; keep attemptKey/authority
  descriptor?(): Promise<{ descriptor; registry? }>; // R#15 reload check
  live?: boolean;
  runtime?(scenario, { workDir }): Promise<RuntimeStage>; // runtime tier (WP2b)
  permissionModes?: {                      // WP4e: documented launch settings per permission mode
    free: string[]; safe: string[];        // substrings of argv.join("\n") + stdin lines
    readOnly?: string[];                   // a free + readOnly launch must carry these, and no free-only one
    equivalent?: string;                   // reason, when both modes map to the same settings
  };
}
interface RuntimeStage {
  descriptor: ExecutorDescriptor;            // loadable by loadExecutor in a FRESH process (absolute module / package specifier, JSON config, no secrets)
  effectCount(attemptKey?): Promise<number>; // effects seen by any process (file-backed log)
  runInput?: Record<string, JsonValue>;      // extra run input (model, env, tools, …)
  dispose?(): Promise<void>;
}
interface HarnessSession {
  executor: WorkflowExecutor;
  effectCount(attemptKey?): Promise<number>;     // launches seen (probes excluded)
  launches?(attemptKey): Promise<LaunchRecord[]>; // argv/env keys (+ stdin lines), for argv/permission checks
  restart?(): Promise<WorkflowExecutor>;          // new instance, same durable state
  dispose?(): Promise<void>;
}
```

The kit issues its own authority for every attempt (a `FenceProbe`). Each `consume()` records the
harness effect count at the moment it is called. So "effect before consume", "effect without
consume" and "released twice" are all visible. Fencing evidence is only as good as `effectCount`.
For process adapters, count from the stub CLI invocation log, not from adapter state.

### Scenario contracts

| Scenario | The staged executor must… |
|---|---|
| `complete` | emit `started`, then output, optionally `usage`, then `completed` |
| `usage_unknown` | complete, with the CLI reporting no cost. Usage must be `cost: null, source: "unknown"` |
| `slow` | emit `started`, then keep running for several seconds (cancel target) |
| `approval` | emit one `approval_request` (kind `execute`). On allow it completes. On deny or timeout the execute tool never shows `completed` |
| `crash_after_consume` | consume authority, then fail before launch evidence (adapter fault hook) |
| `mcp_tool` | call tool `echo` on the injected MCP server `conformance` with the nonce from the prompt (`conformance-nonce:<nonce>`) and report it as a `tool_call` |
| `fail_transient` … `fail_permanent` | fail with CLI error text that the adapter's table maps to that class |
| `fail_unknown` | fail with unrecognized error text. The class must be `unknown` |

## Catalog (35 offline, 5 live, 3 runtime)

| Id | Tier | Asserts | Scenarios | Refs |
|---|---|---|---|---|
| `identity.shape` | offline | id, semver version, compatible contractVersion, all methods; stable across restart | complete | §2.1, B1 |
| `probe.shape` | offline | well-formed, JSON-serializable probe | complete | §2.1, D1 |
| `probe.side_effect_free` | offline | probe/capabilities never consume authority or cause effects | complete | R#1, D1 |
| `capabilities.valid` | offline | valid, stable, JSON-serializable table | complete | §2.2, B4 |
| `capabilities.probe_merge` | offline | probed rows merge into a valid table | complete | §2.2 |
| `submit.idempotent_sequential` | offline | same attemptKey ⇒ same ExecRef, 1 effect | complete | B3 |
| `submit.idempotent_concurrent` | offline | concurrent same-key submits share one launch | complete | B3 |
| `submit.idempotent_after_restart` | offline | restarted executor returns the recorded ref, no new effect | complete | B3, R#15 |
| `submit.rejects_invalid` | offline | mismatched authority / empty cwd refused before consume or effect | complete | R#1 |
| `fencing.consume_before_effect` | offline | consumed once, released, before the first effect | complete | R#1 |
| `fencing.revoked_before_consume` | offline | stop before consume ⇒ rejection, 0 effects, reconcile not found | complete | R#1 |
| `fencing.crash_after_consume` | offline | crash after consume ⇒ resubmit (same/restarted) adds no effect | crash_after_consume | R#1, B3 |
| `events.sequence` | offline | started first, one terminal last, nothing after terminal (100 ms grace) | complete | §2.3 |
| `events.json_serializable` | offline | events and ExecRef survive JSON | complete | §2.3, D3 |
| `events.observe_replay` | offline | observe after completion replays the identical stream | complete | §2.3 |
| `events.unknown_ref` | offline | unknown ref rejects (no hang, no events) | complete | §2.1 |
| `events.partial_stream` | offline | declared partialStream ⇒ message_delta | complete | §2.2 |
| `usage.cost_honesty` | offline | unknown cost is null/unknown, never 0; no cost unless usage.detail = cost | usage_unknown, complete | §2.3, prior-art §5 |
| `approval.allow` | offline | respond(allow) accepted, run completes | approval | R#4, D2 |
| `approval.deny` | offline | respond(deny) ⇒ requested kind never completes | approval | R#4, D2 |
| `approval.respond_unknown` | offline | unknown id ⇒ `unknown_request`; answered id ⇒ `too_late` | approval | R#4 |
| `approval.timeout_fail_closed` | offline | no answer + non-interactive policy ⇒ deny | approval | R#4, D2 |
| `permission.mode_mapping` | offline | `free` and `safe` (tools `read, bash`) launch with the harness's documented settings; the two differ unless `equivalent` names a reason; a `free` + `readOnly` launch carries no free-only setting (skips without `harness.permissionModes` or `launches`) | complete | D2 revised, WP4e |
| `cancel.active` | offline | cancel(turn) settles in time; `cancelled` ⇒ failed class `cancelled`; `uncertain` ⇒ reconcile not absent | slow | prior-art §3 #4 |
| `cancel.declared_matches` | offline | cancel level `none` ⇔ `unsupported`, both scopes, within callMs | slow (or complete) | §2.2 |
| `cancel.inactive` | offline | after terminal ⇒ too_late/no_active; unknown attempt ⇒ no_active | complete | §2.1 |
| `reconcile.found` | offline | launched ⇒ found(same ref), also after restart | complete | B3 |
| `reconcile.absent` | offline | never submitted ⇒ absent | complete | B3 |
| `reconcile.unknown` | offline | consumed without launch evidence ⇒ unknown, never absent | crash_after_consume | B3, R#1 |
| `errors.failure_classes` | offline | fail_* map to their classes | fail_* | §2.3 |
| `errors.unknown_class` | offline | unrecognized error ⇒ `unknown` | fail_unknown | §2.3, B3 |
| `descriptor.reload` | offline | `loadExecutor(descriptor)` ⇒ same id, compatible version | complete | R#15 |
| `mcp.injection` | offline | stub MCP server started with its env, echo called, result reported | mcp_tool | R#9 |
| `mcp.argv_no_secrets` | offline | MCP env secret absent from every argv (CLI launches + server) | mcp_tool | prior-art §3 #8 |
| `mcp.delivery_bound` | offline | delivered tool output ≤ `probe().mcpOutputLimitChars` + `probe().mcpOutputNoticeChars` (the CLI's own truncation notice, default 0; served at 2×) | mcp_tool | R#9 |
| `live.readonly_enforced` | live | readOnly run cannot create a requested file | complete | B4, R#4 |
| `live.tool_allowlist` | live | `tools: ["read"]` ⇒ shell command does not run | complete | §2.4, B4 |
| `live.isolation` | live | `inherit: false` ignores AGENTS.md/CLAUDE.md in cwd | complete | B5, R#6 |
| `live.session_ownership` | live | requested sessionId ⇒ terminal `ownedSession` | complete | R#10, D3 |
| `live.resume` | live | resumeSessionId recalls the earlier turn | complete | R#10 |
| `runtime.durable_authority` | runtime | through a real detached worker: 0 effects while the V2 barrier holds `consume`, then completed with exactly 1 effect and `authority.json` released; barrier revoked before consume ⇒ `cancelled/revoked`, 0 effects; worker SIGKILLed after its effect ⇒ `executor.reconcile` never `absent`, `marked-needs-decision` (adoption off), second reconcile `already-terminal`, still 1 effect | complete, slow | R#1, B3 |
| `runtime.detach_rediscovery` | runtime | launched from a process that exits; the worker reloads the adapter from the descriptor and completes (1 effect); `executor.json` holds the descriptor and attemptKey; a fresh process reloads it; an incompatible recorded version ⇒ `failed/guard_failure`, 0 effects | complete | R#15 |
| `runtime.control_relay` | runtime | launched from a process that exits (interactive policy, `readOnly: false`): the pending approval is listed and a relayed deny/allow is acked `accepted`, applied (deny ⇒ no completed execute tool; allow ⇒ completed) and recorded `by: host`; `cancel(owned)` through the mailbox ⇒ acked `CancelResult`, `cancelled/user_cancelled` with a confirmed terminal event; after terminal ⇒ `no_active` | approval, slow | R#2, R#4, D2 |

## Building blocks

- **`createFakeHarness(options)`** stages every scenario on the SDK fake executor. Every offline check
  passes against it.
  - Options: `executor` (base fake options), `scripts` / `faults` per scenario, `scenarios` (restrict),
    `wrap(executor, {scenario, store, generation})` (bug injection), `descriptor`, and
    `mcpOutputLimitChars` (default 4096, `null` = unknown).
  - For `mcp_tool`, the fake acts as the MCP client for the injected server. It truncates the result to
    the declared limit.
- **`createStubCli({dir, name?, scripts})`** writes an executable: a POSIX `sh` launcher that `exec`s
  Node on an ESM body.
  - Scripts are matched by `when.argvIncludes`, first match wins.
  - Steps: `stdout` (string or JSON line), `stderr`, `sleepMs`, `exit`, `hang` (block until a signal),
    and `awaitStdin` (branch on an answer line, with `otherwise` for timeout or EOF).
  - Each invocation is logged with argv, cwd, env keys (never values), stdin lines, signals and exit
    code. Mark `effect: false` on probe scripts such as `--version`.
  - API: `invocations()`, `launches(filter)`, `effectCount(filter)`, `setScripts`, `reset`.
- **`createStubMcpServer({dir, name?, padChars?, env?})`** writes a stdio MCP server that speaks
  newline-delimited JSON-RPC 2.0.
  - Methods: `initialize`, `ping`, `tools/list`, `tools/call`.
  - Tools: `echo{text}`, padded to `padChars`, and `fail` (`isError`).
  - It returns an `McpServerSpec` (Node binary + script; secrets only in `env`) and log readers:
    `log()` (start argv and env keys, requests) and `toolCalls()`.
- **`callMcpTool(spec, tool, args)`** is a minimal stdio MCP client (initialize → tools/list →
  tools/call). It has a timeout.
- **Example process adapter**: `test/conformance/stub-cli-adapter.mjs`. It spawns the stub CLI, parses
  one event per line, writes MCP config to a 0600 file, cancels with SIGTERM, and denies unanswered
  approvals when the policy timeout expires. Its harness counts launches from the invocation log. It
  passes every offline check it can stage. The checks for `crash_after_consume` and `mcp_tool` are
  skipped. Use it as the template for WP6–WP8 harnesses.

## Negative tests (`test/unit/conformance-negative.test.mjs`)

| Injected bug | Failing check |
|---|---|
| a resubmit with the same key launches again | `submit.idempotent_sequential` |
| launch without `consume()` (fake `skipConsume`) | `fencing.consume_before_effect`, `fencing.revoked_before_consume` |
| unknown cost reported as `0` (`source: estimated`, `usage.detail: tokens`) | `usage.cost_honesty` |
| event emitted after the terminal event | `events.sequence` |
| `cancel()` hangs while capabilities declare cancel `none` | `cancel.declared_matches`, `cancel.active` |
| `probe()` consumes a stored authority | `probe.side_effect_free` |
| reconcile reports `absent` after a consume-crash | `reconcile.unknown` |
| approval auto-allowed without an answer | `approval.deny`, `approval.timeout_fail_closed` |
| adapter ignores `permissionMode`; free mode unlocks a readOnly stage | `permission.mode_mapping` |
| runtime stage launches without `consume()` (`runtime.faults.complete.skipConsume`) | `runtime.durable_authority` |
| runtime stage reconciles `absent` after an effect (`reconcileAbsent`) | `runtime.durable_authority` |
| runtime stage answers every approval `allow` (`ignoreDeny`) | `runtime.control_relay` |

## Known gaps

- **Runtime tier (WP2b).** Implemented against the real runtime (imported lazily by
  `checks-runtime.ts`). `createFakeHarness` stages it through `runtime-fake-module.js` (`runtime:
  false` disables it; `runtime.faults` injects bugs). The stub-CLI example adapter has no runtime stage:
  its attempt store is in memory, so a fresh-process reconcile could not answer; WP6–WP8 adapters must
  keep durable launch evidence and provide `runtime()`. The checks write run locators to the run index
  (`AGENT_WORKFLOW_RUN_INDEX_DIR`, default under the home directory); the locator sweep prunes them.
  The `cancel(owned)` half waits up to `AGENT_WORKFLOW_CANCEL_GRACE_MS` (default 10 s) for an adapter
  that ignores the cancel.
- **Fake `respond` race.** The fake executor removes a pending approval only after its script resumes.
  A second `respond` issued immediately after the first therefore returns `accepted`. The kit checks
  `too_late` after the run has terminated.
- **Fake stop hook.** The SDK fake has no stop or dispose hook. `createFakeHarness` stops leftover runs
  through the store structure.
- **Revoked submit.** The contract does not say how `submit` ends after a revoked consume. The kit
  requires a rejection; the fake throws `AUTHORITY_REVOKED`.
- **Approval timeout owner.** Since WP2b the runtime applies `approvalPolicy.timeoutMs` for interactive
  policies (deny by `default-timeout`, see docs/runtime-port.md); `approval.timeout_fail_closed` still
  expects the adapter to fail closed on its own when driven directly.
- **Delivery bound.** `mcp.delivery_bound` only checks a declared limit against delivered output. A CLI
  that wraps a cut result in its own notice declares that allowance as `probe().mcpOutputNoticeChars`
  (WP6: Pi 1.1 keeps 20 KiB of the result plus a header, a `…N chars truncated…` marker and a footer
  naming the full-output file).
  Recording `deliveryUnverified` in the ledger belongs to the WP5 artifact server.
- **Live checks.** These are implemented but have not been run against a real CLI; WP9b does that. The
  isolation check covers project-level instruction files only.
