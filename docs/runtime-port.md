# Runtime port (WP2a-1, WP2a-2, WP2c)

Source: `@agwab/pi-subagent` 0.7.2, repository `pi-subagent-engine` at `ab91a74` (MIT, same author).
Destination: `src/runtime/` (entry point `@agwab/agent-workflow/runtime`, compiled to `dist/runtime/`).

WP2a-1 moves the modules that do not depend on Pi at import level. Every ported TypeScript file starts with a
`// Ported from …` header that names its source path and its changes. Two rules apply to every file:

- relative imports were rewritten from `.ts` to `.js` (NodeNext, compiled output);
- files were reformatted with biome.

Neither changes behavior. The headers do not repeat them.

## Runtime loading and workers

- **No jiti, zero runtime dependencies.** Everything runs from compiled `dist/` with plain `node`.
  `package.json` has no `dependencies`. `proper-lockfile`, pi-subagent's only runtime dependency that the
  ported code used, is replaced by `src/runtime/artifacts/dir-lock.ts` (see change log).
- **Workers: option (a), converted to TypeScript.** `workers/process-gate.mjs` and
  `workers/durable-worker-binding.mjs` became `src/runtime/workers/*.ts`. tsc compiles them to
  `dist/runtime/workers/*.js`.
  - The package is `"type": "module"`, so those files run as ESM with `node <file>`. tsc keeps the shebang.
  - Reasons for (a):
    - one build pipeline, with no copy step that can drift;
    - strict type checking;
    - the binding module gets typed exports that the WP2a-2 durable worker (TypeScript) can import;
    - no execute bit is needed, because callers use `spawn(process.execPath, [path])`.
  - `runtimeWorkerPath("process-gate" | "durable-worker-binding")` returns the installed absolute path. The
    package `exports` map does not expose `dist/runtime/workers/*` as import specifiers.
- **Native helper.** `src/runtime/native/darwin-process-identity` is a universal Mach-O binary (mode 0755 in git).
  - `npm run build` runs `tools/release/copy-runtime-assets.mjs`, which copies the helper and its manifest to
    `dist/runtime/native/` and runs `chmod 0755` explicitly. The build fails if the mode does not stick.
  - `test/unit/runtime-packed-install.test.mjs` asserts that both tarball copies (`dist/` and `src/`) are
    executable and that the installed copy keeps its exec bit.
  - The `.c` source, the binary and the manifest are byte-identical copies with no header: the manifest binds
    the source and binary SHA-256, and a header would break that check.
  - biome now skips `src/runtime/native/**`, so it cannot rewrite the generated manifest.
  - Rebuild with `npm run build:native:darwin`, which runs `tools/release/build-darwin-process-identity.mjs`.

## Module table

| Source (`pi-subagent-engine/…`) | Destination | Status | Reason / note |
|---|---|---|---|
| `src/durable-launch-barrier.ts` | `src/runtime/durable-launch-barrier.ts` | ported | Two doc comments say "the runtime" instead of "pi-subagent". Schema ids unchanged |
| `src/durable-worker-payload.ts` | `src/runtime/durable-worker-payload.ts` | ported-adapted | Payload `backend` must be a resolved executor id; WP2a-2: optional `executor` descriptor (validated, `id` = `backend`) |
| `src/process-identity.ts` | `src/runtime/process-identity.ts` | ported | Helper resolved next to the compiled file |
| `src/native/darwin-process-identity` (+ `.c`, `.manifest.json`) | `src/runtime/native/…` (+ copied to `dist/runtime/native/`) | ported | Byte-identical; see above |
| `scripts/build-darwin-process-identity.mjs` | `tools/release/build-darwin-process-identity.mjs` | ported-adapted | Paths moved to `src/runtime/native` |
| `src/shell-environment.ts` | `src/runtime/shell-environment.ts` | ported | |
| `src/core/constants.ts` | `src/runtime/core/constants.ts` | ported-adapted | Generic backends, `DEFAULT_RUNS_DIR`, srt helper removed |
| `src/core/validation.ts` | `src/runtime/core/validation.ts` | ported-adapted | Backend rules generalized; tmux and inline rules removed |
| `src/core/text-width.ts` | — | dropped | Used only by `panel.ts` and `index.ts`, which are not ported |
| `src/core/resolver.ts` | — | dropped (WP2a-2) | Picked inline/headless/tmux from `auto`. The runtime no longer selects: the caller names the executor with an `ExecutorDescriptor`; role → executor selection (B2) belongs to the core (WP4) |
| `src/workspace/intent.ts` | `src/runtime/workspace/intent.ts` | ported | |
| `src/workspace/worktree.ts` | `src/runtime/workspace/worktree.ts` | ported-adapted | Worktree parent dir and diff excludes |
| `src/artifacts/index.ts` | `src/runtime/artifacts/index.ts` | ported | |
| `src/artifacts/result.ts` | `src/runtime/artifacts/result.ts` | ported | `ResultTmuxMetadata` and `tmux?` fields kept as optional record data (see notes) |
| `src/artifacts/store.ts` | `src/runtime/artifacts/store.ts` | ported-adapted | Default runs dir |
| `src/artifacts/registry.ts` | `src/runtime/artifacts/registry.ts` (+ new `dir-lock.ts`) | ported-adapted | Lock implementation, default runs dir, env name |
| `src/artifacts/preview.ts` | `src/runtime/artifacts/preview.ts` | ported | |
| `src/orchestrate/run-ref.ts` | `src/runtime/orchestrate/run-ref.ts` | ported-adapted | Runs dir, locator index dir, env names |
| `src/orchestrate/status.ts` | `src/runtime/orchestrate/status.ts` | ported-adapted | Generic backend check; missing backend reported as `"unknown"` |
| `src/orchestrate/prune.ts` | `src/runtime/orchestrate/prune.ts` | ported-adapted | Default runs dir in the locator ownership check |
| `src/orchestrate/interrupt.ts` | `src/runtime/orchestrate/interrupt.ts` | ported | Comment wording only |
| `src/orchestrate/index.ts` | `src/runtime/orchestrate/index.ts` | ported-adapted | Re-exports run/async/reconcile again (WP2a-2) plus the new modules |
| `src/orchestrate/run.ts` | `src/runtime/orchestrate/run.ts` | ported-adapted (WP2a-2) | Agent loading removed; descriptor instead of `resolveBackend`; runners replaced by `executeAttempt`; workspace/worktree logic kept |
| `src/orchestrate/async.ts` | `src/runtime/orchestrate/async.ts` | ported-adapted (WP2a-2) | Inline hooks removed; payload carries the descriptor and an explicit `attemptKey` |
| `src/orchestrate/reconcile.ts` | `src/runtime/orchestrate/reconcile.ts` | ported-adapted (WP2a-2) | tmux ownership removed; orphaned attempts ask `executor.reconcile` (see below) |
| `src/workers/process-gate.mjs` | `src/runtime/workers/process-gate.ts` → `dist/runtime/workers/process-gate.js` | ported-adapted | TypeScript conversion only |
| `src/workers/durable-worker-binding.mjs` | `src/runtime/workers/durable-worker-binding.ts` → `dist/…/durable-worker-binding.js` | ported-adapted | TypeScript; env name; default runs dir |
| `src/workers/durable-worker.mjs` | `src/runtime/workers/durable-worker.ts` → `dist/runtime/workers/durable-worker.js` | ported-adapted (WP2a-2) | `loadExecutor` + durable authority; see below |
| `src/workers/terminal-finalizer.mjs` | `src/runtime/workers/terminal-finalizer.ts` → `dist/…/terminal-finalizer.js` | ported (WP2a-2) | TypeScript conversion only |
| `src/runners/headless-model.ts` | — | deferred-WP6 | `buildPiArgv` and the JSON parser go to `executors/pi/` (plan §3.4) |
| `src/runners/tool-call-telemetry.ts` | `src/runtime/telemetry/tool-call-telemetry.ts` | ported-adapted (WP2a-2) | Collector unchanged; new `processExecToolCall` feeds it normalized `tool_call` events (`captureToolCalls`) |
| `src/runners/tool-result-budget.ts`, `tool-result-budget-extension.ts` | — | deferred-WP6 | Plan §3.4: goes to `executors/pi/` |
| `src/runners/inline.ts` | — | dropped | Plan §3.4 "not taken" (Pi SDK in-process) |
| `src/runners/tmux.ts`, `tmux-control.ts` | — | dropped | Plan §3.4 "not taken" |
| `src/sandbox/srt.ts` | — | deferred-WP6 | Pi path allow-list; generalize if needed (plan §3.4) |
| `src/agents.ts` | — | dropped | Pi agent discovery; duplicates core `agents.ts` (plan §3.4) |
| `src/api.ts`, `api.mjs` | `src/runtime/api.ts` (exported from `./runtime`) | ported-adapted (WP2a-2) | See "SubagentApi → runtime API". `api.mjs` (jiti shim) dropped |
| `src/index.ts` | — | dropped | Pi extension entry point (Pi host = `hosts/pi`) |
| `src/panel.ts` | — | dropped | TUI |
| — | `src/runtime/durable-authority.ts` | new (WP2a-2) | Durable `ExecutionAuthority` (launch barrier behind `consume()`) |
| — | `src/runtime/orchestrate/request.ts` | new (WP2a-2) | Runtime run input, validation, SubmitRequest fields, execution plan digest |
| — | `src/runtime/orchestrate/execute.ts` | new (WP2a-2) | `executeAttempt` / `observeAttempt`: submit/observe under the runtime fence, artifacts |
| — | `src/runtime/orchestrate/executor-record.ts` | new (WP2a-2) | Per-attempt `executor.json` (descriptor + attemptKey) for reconcile |
| — | `src/runtime/orchestrate/env-values.ts` | new (WP2c) | Env values off disk: split into persisted keys + spawn-env channel, restore in the worker, plan-digest form |

`src/runtime/index.ts` exports a curated surface:

- all modules above;
- `artifacts/result.ts` without its duplicate `WORKSPACE_MODES`/`WorkspaceMode`, which are identical to the
  `core/constants` ones;
- `run-ref.ts` without its `…ForTests` seams;
- `MODULE`, `RUNTIME_WORKERS` and `runtimeWorkerPath`;
- WP2a-2: run/async/reconcile, request/execute/executor-record, the durable authority, the tool-call
  telemetry collector and the runtime API (`api.ts`). `RUNTIME_WORKERS` adds `durable-worker` and
  `terminal-finalizer`.

`dir-lock.ts` is internal: it is not exported from the entry point.

## Test table

All 44 pi-subagent check and integration files. "→" names the destination under `test/unit/`. Ported fixtures
live in `test/fixtures/runtime/`. Each ported test calls one `node:test` `test()` around the original body and
imports from `dist/`.

| Source | Status | Destination / reason |
|---|---|---|
| `checks/agents.mjs` | deferred-WP6 | `agents.ts` and `buildPiArgv` (Pi agent discovery and argv) |
| `checks/answer-preview.mjs` | partial | → `runtime-answer-preview.test.mjs` (store and preview unit half, 16 of 39). WP2a-2: the preview over an executor run (completed = final, failed = partial/truncated) → `runtime-api.test.mjs`. Dropped: the extension-tool half (fake `pi`; Pi tool sync/wait/status/parallel/notify response formatting) — it tests the Pi tool host (`src/index.ts`), not the runtime; it belongs to `hosts/pi` |
| `checks/api.mjs` | ported (WP2a-2) | → `runtime-api.test.mjs`. Dropped: `pkg.exports["./api"]` and `supportsExplicitExtensionIsolation` assertions (no `./api` export; Pi-only probe). `runSubagent({backend:"inline"})` validation now asserts missing task / missing executor |
| `checks/artifacts.mjs` | ported | → `runtime-artifacts.test.mjs` (26/26; path `.agent-workflow/runs`) |
| `checks/contracts.mjs` | partial | → `runtime-contracts.test.mjs` (74 of 81). Dropped: 5 `parsePiJsonLines`/`detectContextLengthExceeded` assertions (deferred-WP6, headless-model) and 2 "inline backend cannot provide" assertions (rule removed with the inline backend) |
| `checks/darwin-process-identity-helper.mjs` | ported | → `runtime-darwin-process-identity-helper.test.mjs` (31/31, plus 2 for the dist copy) |
| `checks/durable-launch-barrier.mjs` | ported | → `runtime-durable-launch-barrier.test.mjs` (53/53, plus 1). The jiti `lstat` instrumentation is replaced by a temp copy of the compiled `.js` with the `node:fs/promises` import rewritten. Fixtures: `durable-launch-barrier-worker.mjs`, `barrier-temp-alias-race.mjs` (10/10) |
| `checks/durable-worker-binding.mjs` | ported | → `runtime-durable-worker-binding.test.mjs` (11/11; runs-dir digest now over `.agent-workflow/runs`) |
| `checks/durable-worker-payload.mjs` | ported | → `runtime-durable-worker-payload.test.mjs` (sections 1–5, WP2a-1) and `runtime-durable-worker-lifecycle.test.mjs` (5b–7, WP2a-2). Sections 6–7 run provider-free with the fake executor fixture instead of a live model; 5d gains "no executor", "executor/backend mismatch" and "relative executor module" cases |
| `checks/durable-worker-preflight.mjs` | ported | → `runtime-durable-worker-preflight.test.mjs` (6/6; fixture `durable-worker-preflight-invalid.mjs`) |
| `checks/extension-isolation.mjs` | deferred-WP6 | `api.ts` and `runners/inline.ts` (also not wired into pi-subagent's `check:static`) |
| `checks/fail-fast.mjs` | ported (WP2a-2) | → `runtime-api.test.mjs` "fail-fast". Failures come from a scripted `failed` event (the agent tools-ceiling error no longer exists), so the failed run records `attempt.started` instead of the synthesized `run.started`; the async prevalidation case uses an invalid per-task executor instead of an invalid backend |
| `checks/headless-streaming.mjs` | deferred-WP6 | `runners/headless-model.ts` |
| `checks/host-peer-dependencies.mjs` | partial | → `runtime-packed-install.test.mjs` ("not a runtime dependency / not bundled", now "zero dependencies"). Dropped: the wildcard-peer, devDependency and lockfile-drift assertions; agent-workflow's Pi peers are optional and its lock drift is checked by `check:scripts` |
| `checks/inline-extension-providers.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-host-sdk.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-metadata.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-sdk-compat.mjs` | deferred-WP6 | Inline runner |
| `checks/lifecycle.mjs` | ported (WP2a-2) | → `runtime-durable-worker-lifecycle.test.mjs`. Dropped: the stubborn headless-Pi interrupt (fake `pi` with an orphaned child group): executors own their processes; the runtime's equivalent (SIGTERM → `cancel(owned)`) is in `runtime-durable-worker.test.mjs` "interrupt", the Pi child group goes to the WP6 adapter |
| `checks/no-chain.mjs` | ported | → `runtime-validation.test.mjs` "no-chain" (4/4) |
| `checks/output-recovery.mjs` | partial | → `runtime-validation.test.mjs` (envelope `outputPartial`). WP2a-2 → `runtime-execute.test.mjs`: completed output is the final text only (stale progress never promoted), timeout keeps partial deltas with `outputPartial: true`, a deadline before release launches nothing and sets no partial marker. The headless/tmux runner assertions stay deferred-WP6 / dropped with tmux |
| `checks/panel-session-scope.mjs` | ported | → `runtime-panel-session-scope.test.mjs` (4/4) |
| `checks/panel.mjs` | dropped | `panel.ts` (TUI) is not ported |
| `checks/parent-session.mjs` | ported | → `runtime-parent-session.test.mjs` (4/4) |
| `checks/prune.mjs` | partial | → `runtime-prune.test.mjs` (53 of 68). See the prune note below |
| `checks/reconcile.mjs` | ported (WP2a-2) | → `runtime-reconcile.test.mjs`. tmux cases converted (stale worktree attempt; unrelated process via a worker identity mismatch). Dropped: the orphaned headless-Pi child group (WP6) and the Pi tool `reconcile` action (`src/index.ts`) |
| `checks/release-version.mjs` | dropped | pi-subagent release tooling (agent-workflow has `tools/release/`) |
| `checks/release-workflow.mjs` | dropped | Same |
| `checks/resolver.mjs` | dropped (WP2a-2) | `core/resolver.ts` is dropped (no backend selection in the runtime) |
| `checks/run-locator-sweep.mjs` | ported | → `runtime-run-locator-sweep.test.mjs` (8/8; `AGENT_WORKFLOW_RUN_*` env names) |
| `checks/run-lock.mjs` | ported | → `runtime-run-lock.test.mjs` (13/13). The live holder is now taken with `acquireDirectoryLock` instead of `proper-lockfile` |
| `checks/sandbox-agent-locks.mjs` | deferred-WP6 | `sandbox/srt.ts` |
| `checks/schema-sync.mjs` | partial | → `runtime-validation.test.mjs`. The probe-value table is checked against `validateResolveInput`. Dropped: the assertions that read the Pi tool schema from `src/index.ts` |
| `checks/thinking-levels.mjs` | partial | → `runtime-validation.test.mjs`. Kept: the `THINKING_LEVELS` assertion and the validation assertions. Deferred to WP6: tool schema, agent frontmatter, `buildPiArgv`, inline runner |
| `checks/tmux-ownership.mjs` | deferred-WP6 | tmux runner and srt |
| `checks/tool-result-budget.mjs` | partial | → `runtime-validation.test.mjs`. Kept: the validation passthrough assertions. The enforcer and extension assertions are deferred to WP6 |
| `checks/usage-accumulation.mjs` | partial (WP2a-2) | The runtime half → `runtime-execute.test.mjs` "usage": sums across `usage` events, null stays null, source kept, no usage → absent, invalid numbers rejected by event validation. The Pi JSON parsing half (`message_end`/`turn_end` dedup, `cacheRead`/`cacheWrite`) stays deferred-WP6; the inline half is dropped with the inline runner |
| `checks/workspace-policy.mjs` | ported | → `runtime-workspace-policy.test.mjs` (7/7) |
| `checks/worktree-cleanup.mjs` | ported | → `runtime-worktree-cleanup.test.mjs`. Paths moved to `.agent-workflow`, plus an `.agent-workflow/runs` exclusion assertion |
| `integration/confirmed-fixes.mjs` | deferred-WP6 | Live model run through `api.mjs` |
| `integration/headless-model.mjs` | deferred-WP6 | Live headless Pi |
| `integration/inline-model.mjs` | deferred-WP6 | Live inline Pi (inline is dropped; re-evaluate with the Pi executor) |
| `integration/parent-session-e2e.mjs` | ported (WP2a-2) | → `runtime-api.test.mjs` "parent session id" (provider-free with the fake executor) |
| `integration/tmux-model.mjs` | deferred-WP6 | Live tmux Pi |

**Prune note** (`runtime-prune.test.mjs`):

- **Section 5, rewritten.** It drove the Pi tool action. The same dry-run and delete selections are now asserted
  on `pruneSubagentRuns` directly (7 assertions replace 10).
- **Section 6, dropped.** It tested the `/subagent prune` command parser and handler in `src/index.ts`
  (13 assertions).
- **Section 11.** It now checks the `./runtime` export instead of `api.mjs` (+1 assertion).

New agent-workflow tests (no pi-subagent counterpart):

| Test file | Covers |
|---|---|
| `runtime-dir-lock.test.mjs` | Lock exclusivity, `ELOCKED`, release, and cleanup on exit and on SIGTERM |
| `runtime-dir-lock-owner.test.mjs` (WP2c) | Owner-aware stealing: a SIGKILLed real holder's run lock is stolen and a later reconcile completes; a live holder survives 8 in-process + 6 cross-process contenders; 8 in-process and 6 cross-process stealers of one stale lock → exactly one winner; garbage / no-birth-identity / other-host / token-mismatch / missing owner records are never stolen; a live pid with a different birth identity (pid reuse) is stolen; `process.exit` during an acquisition never leaves an ownerless lock |
| `runtime-status-interrupt.test.mjs` | Status snapshots and wait; interrupt of an identity-verified process; a forged identity is refused |
| `runtime-workers.test.mjs` | process-gate exit 125/127, exit code and signal passthrough, `--file` mode |
| `runtime-packed-install.test.mjs` | `npm pack` → install in a Pi-free temp project → import `./runtime`, spawn both workers; helper mode bits. Skips with a message when npm or the network is unavailable |
| `runtime-validation.test.mjs` "generic backends" | The generic backend behavior |
| `runtime-durable-worker.test.mjs` (WP2a-2) | Fencing trio end to end through real worker processes; happy path with a released V2 barrier (READY digests, binding seen by the adapter, usage with `cost: null`); rediscovery refusals (wrong id, version mismatch, missing module) before any effect; resubmitting a terminal attempt; SIGTERM → `cancel(owned)` |
| `runtime-durable-authority.test.mjs` (WP2a-2) | Single use in-process and across instances; abort → revoked; V2 release/revoke; binding only after release; typed guard errors |
| `runtime-pre-release-terminal.test.mjs` (WP2c) | Barrier timeout before release (worktree) → `failed/guard_failure`, terminal `result.json`, attempt inactive, finalizer events, worktree removed; engine revoke → `cancelled/revoked`, same terminal checks |
| `runtime-env-at-rest.test.mjs` (WP2c) | Async run with a released V2 barrier and `env: { SECRET_TOKEN }` + an MCP server env value: every file under the run cwd, the barrier dir and the run index is scanned → zero hits; `worker.json` has keys only; the fixture executor received the values (it logs their SHA-256); a sync run writes no value either; the plan object holds `sha256:` digests and its digest changes when only a value changes; a worker without the env channel fails closed with `guard_failure` naming the key |
| `runtime-execute.test.mjs` (WP2a-2) | `failed.class` table; invalid events/sequences; post-release submit failure → reconcile; timeouts; approval answers; usage; output recovery; idempotent resubmission; input validation; plan digest; `captureToolCalls` |
| `runtime-packed-install.test.mjs` (WP2a-2 addition) | The installed `durable-worker.js` runs the fake executor fixture end to end (offline) |

Test fixture: `test/fixtures/runtime/fake-executor-module.mjs` — an executor module (`createExecutor(config)`)
that wraps the SDK fake executor and appends `submit` / `consume` (with outcome and the binding schema the
adapter saw) / `effect` (`authorized` = a released consume preceded it) / `ref` / `cancel` / `reconcile`
entries to an effect log file, so a test observes effects that happened in another process. Modes:
`normal`, `hang-after-effect`, `skip-consume`, `crash-after-consume`; `reconcile: "found"` and `sessionBound`
drive the reconcile outcomes. Its `reconcile` reads the effect log when the attempt ran in another process
(effect or released consume → `unknown`, nothing → `absent`).

Test-only fix in a WP2a-1 file: `runtime-workers.test.mjs` "--file" now publishes the payload atomically
(write + rename). The non-atomic write raced the gate's poll and failed under the heavier WP2a-2 test load.

## WP2a-2 executor seam

### Durable LaunchAuthority (`src/runtime/durable-authority.ts`)

`createDurableLaunchAuthority(options)` implements the SDK `ExecutionAuthority` for one attempt. Construction
runs the binding preflight (`prepareDurableWorkerBinding`), so a malformed payload or digest fails before
`submit`. `consume()` is single use and does, in order:

1. abort check → `revoked`;
2. create `authority.json` in the attempt directory with `O_EXCL` (the cross-process single-use record;
   an existing record → `AUTHORITY_ALREADY_CONSUMED`);
3. barrier await — V2: write READY (with `launchPayloadSha256` and `executionPlanSha256`), wait for the
   engine decision, write ACK (V1 descriptors still use READY/RELEASE/ACK); a revoked decision or an abort
   during the wait → `revoked`;
4. `installDurableWorkerBinding`;
5. abort check → `revoked`;
6. `assertDurableLaunchBarrierV2ExecutionAuthorized` (V2);
7. abort check → `revoked`;
8. `released` (`grantId` = V2 decision digest, V1 release digest, or a digest of the record without a barrier).

`authority.json` is rewritten with the final phase (`released` / `revoked`). `revoked` is returned, never
thrown; guard and integrity failures throw (`DurableAuthorityError`, `DurableLaunchBarrierError`,
`DurableWorkerGuardError`; `isDurableAuthorityError` covers all three). A second `consume()` rejects with
`AUTHORITY_ALREADY_CONSUMED`; after `revoked` it returns `revoked` again. Without a barrier the authority is
local: abort check + single-use record.

After `released`, `binding()` returns the installed worker binding. Adapters get it through
`durableWorkerBindingEnv(req.authority)` → `{ AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON: … }` (the runtime's
fence forwards `binding()`). **WP6:** the Pi adapter must also set the legacy
`PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` (`LEGACY_PI_DURABLE_WORKER_BINDING_ENV`) for Pi children. Both
names are stripped from the durable worker's environment and from `SubmitRequest.env`.

### Execution plan digest (`buildExecutionPlan`, `executionPlanDigest`)

Computed by the worker in `prepareSubagentExecution`, before `submit`, and reported in READY. SHA-256 over
canonical JSON (keys sorted, `undefined` dropped; `durableLaunchBarrierDigest`) of:

- `schema: "agent-workflow-durable-execution-plan-v1"`, `backend` (= executor id);
- `executor`: the full descriptor (`id`, `version`, `contractVersion`, `module`, `config`);
- `runId`, `attemptId`;
- `cwd`: the execution cwd (the worktree path in worktree mode);
- `workspace`: `{ mode, cwd (base), worktreePath }`;
- `request`: every `SubmitRequest` field except `authority` — `attemptKey`, `cwd`, `prompt`, `systemPrompt`,
  `model`, `effort`, `tools`, `readOnly`, `mcpServers` (including their `env`), `sessionId`,
  `resumeSessionId`, `deadlineMs`, `env`, `isolation`, `approvalPolicy`, `artifactsDir`.
- WP2c: in `request.env` and `request.mcpServers[].env` each value is replaced by
  `"sha256:" + hex(SHA-256(UTF-8 value))`. The plan object never holds a credential, and the digest still
  changes when only a value changes (same key set, different value → different plan digest). Unsalted, so a
  low-entropy value could be confirmed by guessing against a known plan; the plan object itself is never
  written, only its digest (READY, `executor.json`).

`deadlineMs` = payload `startedAt` + `timeoutMs`, or `NO_DEADLINE_MS` (8.64e15, the largest `Date`) when no
timeout is set, so the digest is deterministic. The launch payload digest (`launchPayloadSha256`) still binds
the exact `worker.json` bytes, which now include the descriptor.

### Runtime-enforced fencing (`executeAttempt`)

The adapter receives a fence around the durable authority. The runtime fails the attempt with
`guard_failure`, calls `cancel(ref, "owned")` and records the reason in `metadata.executor.fenceViolation`
when `submit` resolves with a ref, or an event arrives, while the authority is unconsumed, revoked or failed.
Every event goes through `validateExecEvent` and the SDK order rules (started first and once, unique approval
ids, nothing after the terminal event; `validateEventSequence` once more at the end); a violation or a stream
that ends without a terminal event is `guard_failure`. Other rules:

- `submit` throws before release → no effect (`ExecutionNotStartedError`; the worktree stays discardable):
  revoked → `cancelled/revoked` (WP2c; was `user_cancelled`); stop → `user_cancelled`/`abort`/`timeout`; authority guard →
  `guard_failure`; adapter refusal → `validation` (INVALID_REQUEST / CAPABILITY_*), `guard_failure`
  (claims an authority state the runtime never produced) or `spawn`.
- `submit` throws after release → `executor.reconcile(attemptKey)`: `found` → observe that ref; `absent` →
  `failed/spawn`; `unknown`/error → `failed/needs_decision`.
- Stop (SIGTERM → `user_cancelled`, abort, `timeoutMs` → `timeout`): `cancel(ref, "owned")`, then wait
  `AGENT_WORKFLOW_CANCEL_GRACE_MS` (default 10 s) for a terminal event. Without one the attempt ends with the
  stop kind and `metadata.executor.termination: "unconfirmed"` (an ACK is never termination evidence).
- `approval_request` is answered through `executor.respond` with `decideApproval`; `ask` is answered `deny`
  (no interactive channel until WP2b).

### Attempt artifacts

- `exec-events.jsonl` (new artifact type `exec-events`): every accepted normalized event, appended as it
  arrives.
- `output.log`: `completed.finalText` for a completed attempt; otherwise the concatenated `message_delta`
  text with `metadata.outputPartial: true` (same contract as the ported answer preview).
- `stderr.log`: runtime diagnostics (empty on a clean completion).
- `executor.json`: descriptor, attemptKey, readOnly, approval policy, plan digest (read by reconcile).
- `authority.json`: the consumption record (above). `SubmitRequest.artifactsDir` = the attempt directory.
- `tool-calls.jsonl` / `tool-calls-summary.json` when `captureToolCalls` is set (ported collector).
- `result.json`: `metadata.usage` = sum of `usage` events — `{ input, output, cached, cost, source, events }`;
  a field is `null` when any event reported it `null` (never 0), `source` is `unknown` if any event was,
  else `estimated` if any was, else `reported`; absent when no usage event arrived. `metadata.executor`
  records id, version, attemptKey, ref, authority outcome, failure class, fence violation, cancel result,
  termination, reconcile outcome and approvals. `metadata.sessionId` comes from `started.sessionId`.

### Failure kinds (new in `FAILURE_KINDS`)

| `failed.class` / outcome | status | failureKind | Auto-retry by the core |
|---|---|---|---|
| `cancelled` | `cancelled` | `cancelled` (or the stop kind when the runtime asked) | no |
| engine revoke before release (WP2c) | `cancelled` | `revoked` | no (the engine decided) |
| `transient` | `failed` | `transient` | allowed |
| `rate_limit` | `failed` | `rate_limit` | allowed (after backoff) |
| `auth` | `failed` | `executor_auth` | no |
| `config` | `failed` | `executor_config` | no |
| `permanent` | `failed` | `executor_permanent` | no |
| `unknown` | `failed` | `executor_unknown` | no |
| reconcile `absent` | `failed` | `not_started` | relaunch with a new attempt is safe |
| reconcile `unknown` / unprovable | `failed` | `needs_decision` | **never**: stop and ask a person (B3) |

`executor_unknown` (the adapter could not classify a failure) is different from `needs_decision` (nobody can
prove whether the attempt launched). Rediscovery refusals (missing module, id/version/contract mismatch) are
`guard_failure`.

### Reconcile outcomes

When the owner process is gone, no terminal result exists, the attempt was not interrupted and it has an
`executor.json` (or a durable `worker.json` with `executor`), `reconcileSubagentRun` loads the executor from
the persisted descriptor and calls `executor.reconcile(attemptKey)` once, appending a
`reconcile.executor_outcome` event and returning `executorReconcile`:

| Outcome | Reconcile status | Record |
|---|---|---|
| `found`, executor not `sessionBound`, `adoptTimeoutMs > 0` (default 5000) | `adopted-result` | observe the ref here (no cancel), write artifacts, commit its terminal status |
| … adoption window ends first | `running` | unchanged; a later reconcile observes again |
| `found`, `sessionBound` or adoption disabled | `marked-needs-decision` | `failed/needs_decision`, ref recorded |
| `absent` | `marked-not-started` | `failed/not_started` |
| `unknown`, reconcile threw, descriptor unloadable/invalid | `marked-needs-decision` | `failed/needs_decision` |

Attempts without a persisted descriptor keep the pi-subagent result (`marked-stale`, `failed/stale`);
interrupted attempts keep `marked-cancelled`. The runtime never relaunches.

### Durable worker (`dist/runtime/workers/durable-worker.js`)

Same sequence as pi-subagent (payload read/shape/location checks → ownership → heartbeat → prepare → run →
terminal result → finalizer), with: `loadExecutor(payload.executor)` before prepare (refusals →
`guard_failure` before READY or any effect); the barrier handled by the authority inside `submit`;
`ExecutionNotStartedError` keeping its status/failureKind; an explicit `process.exit` after the terminal
write (adapters may hold handles). The payload is `{ input, cwd, backend: executor.id, executor, runId,
attemptId, startedAt }`; `input` is the validated runtime input without `executor` and with `attemptKey`.

**Env values at rest (WP2c, D1).** `input.env` and `input.mcpServers[i].env` are not written to `worker.json`;
it holds `input.envKeys` / `input.mcpServers[i].envKeys` (sorted key lists) instead. The launcher passes the
values to the detached worker in its spawn environment as `AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON`
(`{ env?, mcpServers?: (map | null)[] }`); the worker deletes that variable from `process.env` as its first
statement (no grandchild, finalizer or diagnostic inherits it) and merges the values back after the payload
checks. A missing, unparsable or mismatching channel (keys differ, undeclared values, both `env` and
`envKeys`) is `guard_failure` before READY or any effect; error messages name keys, never values. A payload
with inline `env` and no `envKeys` (written before WP2c) is still accepted. Why the spawn environment: it is
the only channel to a detached process that is not a file and survives the launcher's exit; it is visible to
the same user through process inspection (`ps eww`, `/proc/<pid>/environ`), the same exposure as any env var
the caller already holds. A fresh-process reconcile never relaunches, so it never needs the values. Sync
(in-process) runs keep the values in memory only.

### SDK change

`SubmitRequest.artifactsDir?: string` (absolute; adapters may write raw CLI logs there).
`validateSubmitRequest` rejects a relative value. Test: `sdk-contract.test.mjs`.

## SubagentApi → runtime API (for WP4)

The engine (`pi-subagent-flow` `src/subagent-backend.ts`) calls `@agwab/pi-subagent/api` through the
`SubagentApi` interface. WP4 switches it to `@agwab/agent-workflow/runtime`:

| SubagentApi member / option | Runtime API | Note |
|---|---|---|
| `runSubagent(options)` | `runSubagent(options)` | Same modes (single/parallel, sync/async/detach/notify), same result shapes |
| option `backend: "headless"` | `executor: ExecutorDescriptor` | Required. The descriptor is persisted in `worker.json` / `executor.json` |
| option `task` | `task` | Becomes `SubmitRequest.prompt` |
| option `systemPrompt`, `model`, `tools`, `sessionId`, `timeoutMs` | same names | `model` is passed verbatim (no Pi `provider/model` parsing); `tools` are Pi tool names the adapter maps; default `[]` |
| option `thinking` | `effort` | Passed verbatim |
| option `agent`, `agentScope`, `confirmProjectAgents`, `roleContext`, `skills` | — | Refused: the core resolves agents and supplies prompt/system prompt/model/tools |
| option `extensions`, `noExtensions` | `mcpServers`, `isolation`, executor `config` | Refused. The workflow-artifact extension becomes an MCP server (`mcpServers`) |
| option `toolResultBudget`, `visible` | — | Refused (Pi/tmux-only; Pi budget goes to the WP6 adapter config) |
| — | `readOnly`, `env`, `approvalPolicy`, `resumeSessionId`, `attemptKey` | New SubmitRequest fields. `attemptKey` default `<runId>:<attemptId>`; the engine should pass its own (B3) |
| options `async`, `onComplete`, `asyncDependency`, `workspace`, `worktree`, `worktreePolicy`, `cwd`, `runsDir`, `correlationId`, `durableLaunchBarrier`, `mode`, `tasks`, `concurrency`, `failFast`, `cancelSiblingsOnFailure`, `sandbox`, `captureToolCalls` | same | `tasks[i]` may override `executor`. `parentSessionId` is now accepted from code callers |
| `supportsExplicitExtensionIsolation()` | — | Dropped; WP4 removes `assertSubagentExtensionsLoadable` / the extension preflight |
| `getSubagentStatus`, `getSubagentLogs`, `waitForSubagent`, `interruptSubagent`, `recordSubagentChildEvent` | same | Unchanged shapes |
| `reconcileSubagentRun(options)` | same | New options `registry`, `adoptTimeoutMs`; new statuses `adopted-result`, `marked-not-started`, `marked-needs-decision` and field `executorReconcile` — WP4 must stop and ask on `needs_decision` |
| `pruneSubagentRuns`, `formatPruneSubagentRunsSummary` | same | |
| `SubagentValidationError` | same | |
| barrier: `createDurableLaunchBarrierV2`, `durableLaunchBarrierDigest`, `waitForDurableLaunchBarrierV2Ready`, `resolveDurableLaunchBarrierV2Release`, `revokeDurableLaunchBarrierV2`, `readDurableLaunchBarrierV2State`, `waitForDurableLaunchBarrierV2Ack` | same names | **The engine side keeps using exactly these** (plus `assertDurableLaunchBarrierV2ExecutionAuthorized`, `isDurableLaunchBarrier(Revoked)Error`). Schema ids are unchanged, so READY validation in `subagent-backend.ts` (~3315–3460) keeps working; `executionPlanSha256` now has the agent-workflow plan schema |
| V1 barrier functions | same names | Still exported and still accepted by the worker |

Run results, statuses and `RunStatusSnapshot` keep their shapes; `backend` is the executor id.

## Change log (behavior-relevant)

1. **Backends.**
   - `BACKENDS`/`RESOLVED_BACKENDS` (`inline`/`headless`/`tmux`/`auto`) are removed.
   - `Backend` and `ResolvedBackend` are now `string`: an executor id (`ExecutorDescriptor.id`) matching
     `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`. `"auto"` (`AUTO_BACKEND`) remains the unresolved marker.
   - New helpers `isBackend` and `isResolvedBackend`.
   - Validation reports `unsupported backend …; backend must be "auto" or an executor id`.
   - `status.ts` accepts any resolved id in a stored `result.json`, where it used to require one of the
     three names.
   - `durable-worker-payload.ts` checks the payload `backend` the same way.
   - A record without a backend now reports `backend: "unknown"` (`UNKNOWN_BACKEND`) instead of `"headless"`.
2. **Removed validation rules.**
   - "visible requires tmux/auto": removed with tmux. `visible` is still validated as a boolean and carried
     through.
   - "inline backend cannot provide a sandbox": removed with inline. `sandbox` input validation (`true` or
     `{allowedDomains}`) is unchanged and generic.
3. **Removed helper.** `sandboxAllowedDomains` (consumed only by srt, tmux and headless) is removed.
4. **Chain error message.** "chain mode is not supported by pi-subagent; …" is now "chain mode is not
   supported; …".
5. **Default runs dir.**
   - `.pi/agent/runs` is now `.agent-workflow/runs` (`DEFAULT_RUNS_DIR` in `core/constants.ts`), used by
     store, registry, run-ref, status, prune and durable-worker-binding.
   - The binding's `runsDirSha256` changes accordingly.
   - There is no legacy `.pi/agent/runs` read anywhere. Nothing needed it.
6. **Run locator index.**
   - The index moved from `~/.pi/agent/subagent-runs` to `~/.agent-workflow/run-index`
     (`DEFAULT_RUN_INDEX_DIR_SEGMENTS`).
   - Environment variables renamed:
     - `PI_SUBAGENT_RUN_INDEX_DIR` → `AGENT_WORKFLOW_RUN_INDEX_DIR`
     - `PI_SUBAGENT_RUN_LOCATOR_PRUNE_AFTER_MS` → `AGENT_WORKFLOW_RUN_LOCATOR_PRUNE_AFTER_MS`
     - `PI_SUBAGENT_EVENT_READ_CACHE_MAX` → `AGENT_WORKFLOW_EVENT_READ_CACHE_MAX`
     - `PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` → `AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` (only the
       exported constant name; no WP2a-1 module reads or writes the variable). In pi-subagent, the deferred
       `run.ts`, `async.ts` and runners put the binding into a Pi child's environment under the Pi name. The
       WP2a-2/WP6 Pi executor must keep using that Pi-side name when it hands the binding to a Pi child.
7. **Worktrees.**
   - The default worktree parent `.pi-subagent-worktrees` is now `.agent-workflow-worktrees`.
   - The diff/status capture also excludes `**/.agent-workflow/runs/**`.
   - The `.pi/agent/runs` and `.pi/workflows/index.{json,lock}` excludes are kept: they hide state written by
     Pi children, and they are path filters, not reads.
8. **Run lock.** `proper-lockfile` is replaced by `artifacts/dir-lock.ts`.
   - Unchanged:
     - an atomic `mkdir` lock directory beside the run (`<runsDir>/.locks/<runId>.lock`);
     - no stale stealing;
     - 200 retries at a fixed 25 ms (the original `randomize` was a no-op because `maxTimeout == minTimeout`);
     - the error `Lock file is already being held` with code `ELOCKED`;
     - lock removal on process exit and on SIGINT/SIGTERM/SIGHUP. `signal-exit` covered more signals.
   - Not kept:
     - the 1 s mtime refresh;
     - the "compromised" uncaught throw when the lock directory disappears while held.

     Both matter only when stale stealing is on.
   - **WP2c: owner-aware stealing** (supersedes "no stale stealing" above; elapsed time still never
     steals). The holder records `owner-<token>.json` = `{ schema: "agent-workflow-dir-lock-owner-v1", token,
     pid, birthIdentity, host, acquiredAt }` inside the lock directory (staged beside it, renamed in right
     after `mkdir`). On contention the record is inspected and the lock is stolen only when the owner is
     provably dead: same host, a recorded birth identity, and `inspectProcessIdentity` says the pid is gone
     or has a different birth identity (pid reused). No record, an unreadable/ambiguous record, a token that
     does not match its file name (a steal in progress), another host, no birth identity or an `unknown`
     liveness answer → not stolen; the reason is appended to the ELOCKED message
     (`Lock file is already being held (<reason>)`, `error.reason`). The steal renames the dead owner's
     uniquely named record to the stealer's name inside the same directory (one atomic rename; tokens are
     never reused, so exactly one concurrent stealer wins and the losers retry normally); the directory is
     never removed during a steal, so no fresh `mkdir` can create a second owner. Create, claim and release
     use synchronous fs calls back to back so a `process.exit` cannot land between `mkdir` and the record
     (with async calls an exit during an in-flight `mkdir` left an ownerless, never-stealable directory —
     the durable worker exits while a heartbeat may be acquiring). "Alive" answers are reused for 500 ms per
     acquisition (the Darwin helper is an exec). Residual: a SIGKILL between `mkdir` and the record rename
     (adjacent syscalls) leaves an ownerless lock that needs operator removal. Release removes our record,
     then the directory; a directory that lost our record raises `ECOMPROMISED` instead of being removed.
9. **Barrier, binding and helper schema ids are unchanged** (`pi-subagent-durable-launch-barrier-v1/v2`, `…-worker-binding-…`,
   `pi-subagent-darwin-process-identity-helper-v1`). They are wire and data identifiers, and keeping them keeps
   barrier compatibility with existing pi-workflow callers. Renaming them would be a protocol change, which is
   outside this port.
10. **Kept for WP2a-2/WP6 to decide.**
    - The `tmux` metadata fields on result and attempt records (`ResultTmuxMetadata`): optional data with no
      tmux code behind it.
    - The ResolveInput fields `agentScope`, `confirmProjectAgents`, `extensions`, `noExtensions`, `skills`,
      `toolResultBudget` and `sessionId`: still validated as before.
11. **WP2a-2 executor seam** (behavior changes against pi-subagent; everything else in run/async/reconcile/
    durable worker/finalizer/api is ported as is):
    - **Runners → executors.** `run.ts` calls `executeAttempt` (SDK `submit`/`observe`) instead of the
      headless/inline/tmux runners; no Pi agent loading and no agent tools ceiling (the core supplies
      prompt/system prompt/model/tools). `backend` in records is the executor id.
    - **Barrier position.** The barrier wait moved from "between prepare and run" into `authority.consume()`,
      i.e. after the attempt is upserted `running` and the executor is loaded. Ownership stays `prepared`
      (discardable worktree) until the authority releases, so revoke/abort before release still discards the
      worktree as before. The binding preflight still runs before the barrier.
    - **Plan schema.** `pi-subagent-durable-execution-plan-v1` (backend, agent, tools, …) is replaced by
      `agent-workflow-durable-execution-plan-v1` (descriptor + full request); see above.
    - **Single use across processes.** New `authority.json` record: a second consume for the same attempt
      directory is `AUTHORITY_ALREADY_CONSUMED` (pi-subagent relied on the barrier's exclusive READY only).
    - **Pre-effect results in sync runs.** `runSubagentTask` writes a terminal result for
      `ExecutionNotStartedError` (revoked/abort/timeout/refusal before launch) instead of rethrowing.
    - **Timeout.** `timeoutMs` is enforced by the runtime (cancel(owned) + grace) and recorded as
      `failed/timeout`; a deadline before release launches nothing. Without `timeoutMs`, `deadlineMs` is
      `NO_DEADLINE_MS`.
    - **Output.** `output.log` is `finalText` (completed) or the streamed deltas (partial); usage is the
      normalized summary above instead of Pi's `{ input, output, cacheRead, cacheWrite, cost: {…} }`.
    - **Failure kinds.** New kinds (table above). Rediscovery refusals are `guard_failure`. Executor
      `failed.class` maps as in the table instead of Pi's `model`/`provider_error`/`exit` kinds.
    - **Reconcile.** Orphaned attempts with a persisted descriptor ask `executor.reconcile` (`adopted-result`,
      `marked-not-started`, `marked-needs-decision`) instead of always `marked-stale`. tmux ownership
      cleanup is gone (tmux metadata stays readable). Missing backend in a stale result is `"unknown"`
      (was `"headless"`).
    - **Durable worker.** Loads the executor from the payload descriptor; a payload without `executor`, or
      with `executor.id !== backend`, is a `guard_failure`. Unreadable-payload fallback backend is
      `"unknown"` (was `"headless"`). Env names `AGENT_WORKFLOW_HEARTBEAT_MS`,
      `AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS`, `AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS`
      (were `PI_SUBAGENT_*`); new `AGENT_WORKFLOW_CANCEL_GRACE_MS`. The worker calls `process.exit` after its
      terminal write. Worker process metadata `command` is `"agent-workflow durable-worker"`.
    - **API.** Pi-specific options are refused with a validation error; `parentSessionId` is accepted from
      code callers (pi-subagent's validation dropped it); project-agent approval and
      `supportsExplicitExtensionIsolation` are gone. `reconcileSubagentRun` is re-exported directly.
    - **Async parallel.** Per-task executors are validated before any spawn (was per-task backend resolution).
    - **Results/registry.** New artifact type `exec-events`, `ResultMetadata.executor`, run event types
      `attempt.executor_submitted` and `reconcile.executor_outcome`.

12. **WP2c runtime hardening** (fixes for defects inherited from pi-subagent 0.7.2; see "Inherited from
    pi-subagent 0.7.2"):
    - **Pre-release failures are terminal.** The durable worker no longer calls
      `discardSubagentExecution` before writing its terminal result. That call marked the attempt
      `cancelled/user_cancelled` in `run.json` (with `activate: false`, so `activeAttemptId` stayed set),
      after which the worker's terminal write saw a terminal attempt with a different status and skipped
      `result.json` (left `running`) and the finalizer. Now the worker discards only the pristine
      workspace (`discardPreparedExecutionWorkspace`, worktree `removed`), writes `result.json`, and spawns
      the terminal finalizer, which drains ownership and commits through the normal path. A guard or
      integrity failure before release (barrier timeout, barrier/binding/authority errors, rediscovery
      refusals) is `failed/guard_failure` with the reason in `stderr.log`.
    - **Engine revoke = new failure kind `revoked`** (status `cancelled`). Chosen over `user_cancelled` so
      the core can tell "the engine withdrew the launch" (barrier revoke, nothing ran) from "an operator
      interrupted the worker" (SIGINT/SIGTERM → `user_cancelled`). `DurableLaunchBarrierRevokedError.failureKind`
      is unchanged (`user_cancelled`, barrier wire compatibility); the runtime maps it to `revoked`.
    - `discardSubagentExecution` (in-process callers) now clears `activeAttemptId` when it cancels the active
      attempt (`onlyIfActive` still spares a successor).
    - **Owner-aware run lock** (a SIGKILLed holder no longer blocks reconcile forever): see item 8.
    - **No env values at rest:** `worker.json` keeps env keys only, values go through the worker's spawn
      environment, the plan digest hashes each value (see "Env values at rest" and "Execution plan digest").
      Adapters must still keep values out of their own logs and `artifactsDir` files (the runtime cannot
      redact what an executor writes).

## Inherited from pi-subagent 0.7.2

The WP2c defects as they exist in `pi-subagent-engine` at `ab91a74` (read-only check; paths relative to that
repository), so its owner can decide whether to fix pi-subagent too.

| WP2c defect | In pi-subagent 0.7.2? | Where |
|---|---|---|
| 1a. Guard/integrity failure before release → `cancelled/user_cancelled`, `result.json` stays `running`, attempt stays active | Yes, identical | `src/workers/durable-worker.mjs:524-525` calls `discardSubagentExecution` before the terminal write; `src/orchestrate/run.ts:437-462` upserts `cancelled/user_cancelled` with `activate: false` (line 459, keeps `activeAttemptId`); `src/workers/durable-worker.mjs:295-299` then skips the terminal write because the statuses differ, so no `result.json` update and no finalizer (`:546` spawns only for a returned result). The barrier wait is in the worker itself (`:468-485`), so a barrier timeout takes this path |
| 1b. Revoke before release keeps the attempt active; revoke recorded as `user_cancelled` | Yes, identical | Same discard (`run.ts:459`); `durable-worker.mjs:527-538` maps `isDurableLaunchBarrierRevokedError` to `cancelled/user_cancelled`; `durable-worker.mjs:333-337` backfills `result.json` but returns no result, so no finalizer drains ownership. `src/durable-launch-barrier.ts:180` tags the revoke error `user_cancelled` |
| 1c. In-process pre-release error leaves the cancelled attempt active | Yes | `src/orchestrate/run.ts:796` (`runSubagentTask` → `discardSubagentExecution`, `activate: false`) |
| 2. SIGKILLed run-lock holder blocks every later mutation/reconcile (`ELOCKED`) | Yes, identical | `src/artifacts/registry.ts:501-514`: `proper-lockfile` with `stale: Number.MAX_SAFE_INTEGER`; no owner identity is recorded, so nothing can prove the holder dead |
| 3. Env values persisted at rest | Not in `worker.json` (pi-subagent's run input has no `env`/`mcpServers`), but a related exposure exists | `src/runners/tmux.ts:420` (`tmux-pane.gate` in the task dir), `:425-429` (`childEnv` = the full parent `process.env`, passed as the pane env at `:718`; `sandboxEnv` at `:708`), `:543-553` writes `{ argv, cwd, env }` to that file (mode 0600, `flag: "wx"`), and `src/workers/process-gate.mjs:18-29` reads and unlinks it. The whole parent environment (API keys included) is on disk until the gate reads it, and stays there if the gate never starts |
| WP2a-2 note: `process-gate --file` non-atomic writer | Yes | `src/runners/tmux.ts:501` (`--file paneGatePath`) and `:543-553`: `writeFile(..., { flag: "wx" })` creates the file and then writes it, while `process-gate.mjs:18-29` polls `readFile` and treats any successful read as the payload, so the gate can read an empty or partial file (JSON parse failure → launch fails). Fix: write to a temp name and `rename` (agent-workflow's test does this, see "Test-only fix" above) |

## Open problems (WP2a-2 → later packages)

- **WP2b:** approval requests are answered by policy only (`ask` → deny); an interactive channel and a
  re-attachable observer for a still-running adopted ref (today reconcile observes for `adoptTimeoutMs` and
  otherwise leaves the attempt `running`) belong to the broker. Adoption restarts `exec-events.jsonl`
  (observe replays from the start for the fake; real adapters must define replay semantics).
- **WP4:** map `needs_decision` to "stop and ask", `not_started` to "safe to relaunch with a new attempt",
  `transient`/`rate_limit` to the retry policy; pass an engine-issued `attemptKey`; replace the Pi extension
  preflight with `mcpServers`; READY validation is unchanged but the plan digest schema changed.
- **WP6:** the Pi adapter must hand the binding to Pi children under both env names, map Pi JSON events
  (tool-call telemetry, usage with cache read/write) to normalized events, and own the Pi child process group
  (the dropped "stubborn interrupt" and "orphaned headless child" checks).
- `captureToolCalls` without `callId` cannot correlate start/end; such calls are recorded as instantaneous.
