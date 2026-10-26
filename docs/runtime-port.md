# Runtime port (WP2a-1)

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
| `src/durable-worker-payload.ts` | `src/runtime/durable-worker-payload.ts` | ported-adapted | Payload `backend` must be a resolved executor id |
| `src/process-identity.ts` | `src/runtime/process-identity.ts` | ported | Helper resolved next to the compiled file |
| `src/native/darwin-process-identity` (+ `.c`, `.manifest.json`) | `src/runtime/native/…` (+ copied to `dist/runtime/native/`) | ported | Byte-identical; see above |
| `scripts/build-darwin-process-identity.mjs` | `tools/release/build-darwin-process-identity.mjs` | ported-adapted | Paths moved to `src/runtime/native` |
| `src/shell-environment.ts` | `src/runtime/shell-environment.ts` | ported | |
| `src/core/constants.ts` | `src/runtime/core/constants.ts` | ported-adapted | Generic backends, `DEFAULT_RUNS_DIR`, srt helper removed |
| `src/core/validation.ts` | `src/runtime/core/validation.ts` | ported-adapted | Backend rules generalized; tmux and inline rules removed |
| `src/core/text-width.ts` | — | dropped | Used only by `panel.ts` and `index.ts`, which are not ported |
| `src/core/resolver.ts` | — | deferred-WP2a-2 | Pi backend selection; becomes executor selection |
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
| `src/orchestrate/index.ts` | `src/runtime/orchestrate/index.ts` | ported-adapted | `run.ts` / `reconcile.ts` re-exports cut |
| `src/orchestrate/run.ts` | — | deferred-WP2a-2 | Imports the headless, inline and tmux runners; rewired onto SDK executors |
| `src/orchestrate/async.ts` | — | deferred-WP2a-2 | Imports the inline runner |
| `src/orchestrate/reconcile.ts` | — | deferred-WP2a-2 | Imports `tmux-control` |
| `src/workers/process-gate.mjs` | `src/runtime/workers/process-gate.ts` → `dist/runtime/workers/process-gate.js` | ported-adapted | TypeScript conversion only |
| `src/workers/durable-worker-binding.mjs` | `src/runtime/workers/durable-worker-binding.ts` → `dist/…/durable-worker-binding.js` | ported-adapted | TypeScript; env name; default runs dir |
| `src/workers/durable-worker.mjs` | — | deferred-WP2a-2 | Reaches the Pi runners through `run.ts` |
| `src/workers/terminal-finalizer.mjs` | — | deferred-WP2a-2 | Out of WP2a-1 scope (paired with `durable-worker.mjs`) |
| `src/runners/headless-model.ts` | — | deferred-WP6 | `buildPiArgv` and the JSON parser go to `executors/pi/` (plan §3.4) |
| `src/runners/tool-call-telemetry.ts` | — | deferred-WP2a-2 | Plan §3.4: event parsing to be generalized into `runtime/` |
| `src/runners/tool-result-budget.ts`, `tool-result-budget-extension.ts` | — | deferred-WP6 | Plan §3.4: goes to `executors/pi/` |
| `src/runners/inline.ts` | — | dropped | Plan §3.4 "not taken" (Pi SDK in-process) |
| `src/runners/tmux.ts`, `tmux-control.ts` | — | dropped | Plan §3.4 "not taken" |
| `src/sandbox/srt.ts` | — | deferred-WP6 | Pi path allow-list; generalize if needed (plan §3.4) |
| `src/agents.ts` | — | dropped | Pi agent discovery; duplicates core `agents.ts` (plan §3.4) |
| `src/api.ts`, `api.mjs` | — | deferred-WP2a-2 | Façade over run/async/status |
| `src/index.ts` | — | dropped | Pi extension entry point (Pi host = `hosts/pi`) |
| `src/panel.ts` | — | dropped | TUI |

`src/runtime/index.ts` exports a curated surface:

- all modules above;
- `artifacts/result.ts` without its duplicate `WORKSPACE_MODES`/`WorkspaceMode`, which are identical to the
  `core/constants` ones;
- `run-ref.ts` without its `…ForTests` seams;
- `MODULE`, `RUNTIME_WORKERS` and `runtimeWorkerPath`.

`dir-lock.ts` is internal: it is not exported from the entry point.

## Test table

All 44 pi-subagent check and integration files. "→" names the destination under `test/unit/`. Ported fixtures
live in `test/fixtures/runtime/`. Each ported test calls one `node:test` `test()` around the original body and
imports from `dist/`.

| Source | Status | Destination / reason |
|---|---|---|
| `checks/agents.mjs` | deferred-WP6 | `agents.ts` and `buildPiArgv` (Pi agent discovery and argv) |
| `checks/answer-preview.mjs` | partial | → `runtime-answer-preview.test.mjs`. The store and preview unit half is kept (16 of 39 assertions). The extension-tool half (fake `pi`; sync, wait, status, parallel, async/notify responses) is deferred to WP2a-2 |
| `checks/api.mjs` | deferred-WP2a-2 | `api.ts` and `orchestrate/async.ts` |
| `checks/artifacts.mjs` | ported | → `runtime-artifacts.test.mjs` (26/26; path `.agent-workflow/runs`) |
| `checks/contracts.mjs` | partial | → `runtime-contracts.test.mjs` (74 of 81). Dropped: 5 `parsePiJsonLines`/`detectContextLengthExceeded` assertions (deferred-WP6, headless-model) and 2 "inline backend cannot provide" assertions (rule removed with the inline backend) |
| `checks/darwin-process-identity-helper.mjs` | ported | → `runtime-darwin-process-identity-helper.test.mjs` (31/31, plus 2 for the dist copy) |
| `checks/durable-launch-barrier.mjs` | ported | → `runtime-durable-launch-barrier.test.mjs` (53/53, plus 1). The jiti `lstat` instrumentation is replaced by a temp copy of the compiled `.js` with the `node:fs/promises` import rewritten. Fixtures: `durable-launch-barrier-worker.mjs`, `barrier-temp-alias-race.mjs` (10/10) |
| `checks/durable-worker-binding.mjs` | ported | → `runtime-durable-worker-binding.test.mjs` (11/11; runs-dir digest now over `.agent-workflow/runs`) |
| `checks/durable-worker-payload.mjs` | partial | → `runtime-durable-worker-payload.test.mjs`. Sections 1–5 (writer, resolver, legacy, task-only, tamper; 32 assertions) are kept verbatim, plus new `assertDurableWorkerPayloadShape` cases. Sections 5b–6 (45 assertions) are deferred to WP2a-2: they spawn `durable-worker.mjs` and `terminal-finalizer.mjs` through `async.ts`/`api.mjs` |
| `checks/durable-worker-preflight.mjs` | ported | → `runtime-durable-worker-preflight.test.mjs` (6/6; fixture `durable-worker-preflight-invalid.mjs`) |
| `checks/extension-isolation.mjs` | deferred-WP6 | `api.ts` and `runners/inline.ts` (also not wired into pi-subagent's `check:static`) |
| `checks/fail-fast.mjs` | deferred-WP2a-2 | `orchestrate/run.ts` and `async.ts` |
| `checks/headless-streaming.mjs` | deferred-WP6 | `runners/headless-model.ts` |
| `checks/host-peer-dependencies.mjs` | partial | → `runtime-packed-install.test.mjs` ("not a runtime dependency / not bundled", now "zero dependencies"). Dropped: the wildcard-peer, devDependency and lockfile-drift assertions; agent-workflow's Pi peers are optional and its lock drift is checked by `check:scripts` |
| `checks/inline-extension-providers.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-host-sdk.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-metadata.mjs` | deferred-WP6 | Inline runner |
| `checks/inline-sdk-compat.mjs` | deferred-WP6 | Inline runner |
| `checks/lifecycle.mjs` | deferred-WP2a-2 | `run.ts`, `async.ts`, `terminal-finalizer.mjs` |
| `checks/no-chain.mjs` | ported | → `runtime-validation.test.mjs` "no-chain" (4/4) |
| `checks/output-recovery.mjs` | partial | → `runtime-validation.test.mjs`. Kept: the envelope `outputPartial` assertion. The headless and tmux runner assertions are deferred to WP6 |
| `checks/panel-session-scope.mjs` | ported | → `runtime-panel-session-scope.test.mjs` (4/4) |
| `checks/panel.mjs` | dropped | `panel.ts` (TUI) is not ported |
| `checks/parent-session.mjs` | ported | → `runtime-parent-session.test.mjs` (4/4) |
| `checks/prune.mjs` | partial | → `runtime-prune.test.mjs` (53 of 68). See the prune note below |
| `checks/reconcile.mjs` | deferred-WP2a-2 | `orchestrate/reconcile.ts` |
| `checks/release-version.mjs` | dropped | pi-subagent release tooling (agent-workflow has `tools/release/`) |
| `checks/release-workflow.mjs` | dropped | Same |
| `checks/resolver.mjs` | deferred-WP2a-2 | `core/resolver.ts` |
| `checks/run-locator-sweep.mjs` | ported | → `runtime-run-locator-sweep.test.mjs` (8/8; `AGENT_WORKFLOW_RUN_*` env names) |
| `checks/run-lock.mjs` | ported | → `runtime-run-lock.test.mjs` (13/13). The live holder is now taken with `acquireDirectoryLock` instead of `proper-lockfile` |
| `checks/sandbox-agent-locks.mjs` | deferred-WP6 | `sandbox/srt.ts` |
| `checks/schema-sync.mjs` | partial | → `runtime-validation.test.mjs`. The probe-value table is checked against `validateResolveInput`. Dropped: the assertions that read the Pi tool schema from `src/index.ts` |
| `checks/thinking-levels.mjs` | partial | → `runtime-validation.test.mjs`. Kept: the `THINKING_LEVELS` assertion and the validation assertions. Deferred to WP6: tool schema, agent frontmatter, `buildPiArgv`, inline runner |
| `checks/tmux-ownership.mjs` | deferred-WP6 | tmux runner and srt |
| `checks/tool-result-budget.mjs` | partial | → `runtime-validation.test.mjs`. Kept: the validation passthrough assertions. The enforcer and extension assertions are deferred to WP6 |
| `checks/usage-accumulation.mjs` | deferred-WP6 | Headless and inline runners |
| `checks/workspace-policy.mjs` | ported | → `runtime-workspace-policy.test.mjs` (7/7) |
| `checks/worktree-cleanup.mjs` | ported | → `runtime-worktree-cleanup.test.mjs`. Paths moved to `.agent-workflow`, plus an `.agent-workflow/runs` exclusion assertion |
| `integration/confirmed-fixes.mjs` | deferred-WP6 | Live model run through `api.mjs` |
| `integration/headless-model.mjs` | deferred-WP6 | Live headless Pi |
| `integration/inline-model.mjs` | deferred-WP6 | Live inline Pi (inline is dropped; re-evaluate with the Pi executor) |
| `integration/parent-session-e2e.mjs` | deferred-WP2a-2 | `orchestrate/run.ts` |
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
| `runtime-status-interrupt.test.mjs` | Status snapshots and wait; interrupt of an identity-verified process; a forged identity is refused |
| `runtime-workers.test.mjs` | process-gate exit 125/127, exit code and signal passthrough, `--file` mode |
| `runtime-packed-install.test.mjs` | `npm pack` → install in a Pi-free temp project → import `./runtime`, spawn both workers; helper mode bits. Skips with a message when npm or the network is unavailable |
| `runtime-validation.test.mjs` "generic backends" | The generic backend behavior |

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
9. **Barrier, binding and helper schema ids are unchanged** (`pi-subagent-durable-launch-barrier-v1/v2`, `…-worker-binding-…`,
   `pi-subagent-darwin-process-identity-helper-v1`). They are wire and data identifiers, and keeping them keeps
   barrier compatibility with existing pi-workflow callers. Renaming them would be a protocol change, which is
   outside this port.
10. **Kept for WP2a-2/WP6 to decide.**
    - The `tmux` metadata fields on result and attempt records (`ResultTmuxMetadata`): optional data with no
      tmux code behind it.
    - The ResolveInput fields `agentScope`, `confirmProjectAgents`, `extensions`, `noExtensions`, `skills`,
      `toolResultBudget` and `sessionId`: still validated as before.
