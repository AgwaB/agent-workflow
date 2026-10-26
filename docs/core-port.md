# Core port (WP4a)

Source: `@agwab/pi-workflow` 0.16.4, commit `b83cc4f` (MIT, same author).
Destination: `src/core/` (flat, same file names), compiled to `dist/core/`.

WP4a was scoped to 39 modules that a value-import closure analysis listed as Pi-free. Every ported file
starts with `// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/<file>. MIT, same author. Changes: …`.
All files were reformatted with biome; that changes no behavior and the headers do not repeat it.

## Closure re-check (discovery)

The re-check parsed every `src/*.ts` at `b83cc4f` with the TypeScript parser. It counted an import as a
value import unless the whole clause, or every specifier in it, was `type`. The 39-file list holds **only for
30 files**. Nine files value-import a module outside the set:

- `store.ts` (which reaches `workflow-native-host-context` and `pi-agent-dir`): `workflow-state-root`,
  `workflow-stop`, `workflow-partial-output`, `workflow-source-context-runtime`. The last two also go through
  `dynamic-events`, which imports `store`.
- `workflow-raw-contract.ts` (which reaches `store`, `launch-bootstrap-provenance` and
  `artifact-graph-runtime`): `workflow-artifact-tool`, `workflow-output-artifacts`.
- `types.ts` (Pi-free, but WP4b owns it): `workflow-helpers` (`WorkflowValidationError`) and
  `workflow-runtime` (`THINKING_LEVELS`).
- A blocked sibling, transitively: `foreach-batch-capability` (through `workflow-state-root`).
  `workflow-artifact-tool` also depends on `workflow-runtime`, and `workflow-output-artifacts` also
  depends on `workflow-partial-output`.

The task rule was "stop porting that file", so these nine are `blocked` and move to WP4b. Effect on the
WP4b/WP4c split:

- WP4b inherits 9 more files. They need the `store` shim (host-context injection) and the
  `workflow-raw-contract` hub, so the `store` → native-host-context edge is in fact on the WP4a path.
- `types.ts` itself has no value imports. Porting it first in WP4b unblocks `workflow-runtime` and
  `workflow-helpers` and lets WP4b delete `types-bridge.ts`.
- `workflow-artifact-tool` (the WP5 MCP server body) cannot land before `workflow-raw-contract`. The
  closure of `workflow-raw-contract` also includes `launch-bootstrap-provenance` and
  `artifact-graph-runtime`, both of which §3.2 lists for decoupling. So WP5 depends on WP4b as well as WP4a.
- `workflow-state-root.ts:107` hard-codes `.pi/workflows`. The WP4b port has to apply the path rule there.

## Module table (39)

| Source | Destination | Status |
|---|---|---|
| `src/dynamic-audit.ts` | `src/core/dynamic-audit.ts` | ported — type bridge |
| `src/dynamic-controller-errors.ts` | `src/core/dynamic-controller-errors.ts` | ported |
| `src/dynamic-loop-prompts.ts` | `src/core/dynamic-loop-prompts.ts` | ported — type bridge |
| `src/dynamic-loop-types.ts` | `src/core/dynamic-loop-types.ts` | ported — type bridge |
| `src/dynamic-profiles.ts` | `src/core/dynamic-profiles.ts` | ported |
| `src/dynamic-runtime-bundle.ts` | `src/core/dynamic-runtime-bundle.ts` | ported-adapted — type bridge; project bundle dir .pi/workflow-runtime/ → .agent-workflow/workflow-runtime/ |
| `src/dynamic-state-projection.ts` | `src/core/dynamic-state-projection.ts` | ported |
| `src/dynamic-tool-result-budget-metrics.ts` | `src/core/dynamic-tool-result-budget-metrics.ts` | ported — type bridge |
| `src/experimental-speed-flags.ts` | `src/core/experimental-speed-flags.ts` | ported-adapted — env PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP→AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP, PI_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH→AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH, PI_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP→AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP, PI_WORKFLOW_CACHE_SHAPE_METRICS→AGENT_WORKFLOW_CACHE_SHAPE_METRICS, PI_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER→AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER, PI_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR→AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR, PI_WORKFLOW_PER_ITEM_DISPATCH→AGENT_WORKFLOW_PER_ITEM_DISPATCH |
| `src/foreach-batch-capability.ts` | — | blocked (value-imports `workflow-state-root.js` (`assertWorkflowStateRootCapability`, ...), which is blocked (below)) |
| `src/foreach-batch-runtime.ts` | `src/core/foreach-batch-runtime.ts` | ported — type bridge |
| `src/json-schema.ts` | `src/core/json-schema.ts` | ported |
| `src/launch-session.ts` | `src/core/launch-session.ts` | ported — type bridge |
| `src/model-task-runtime.ts` | `src/core/model-task-runtime.ts` | ported |
| `src/process-role.ts` | `src/core/process-role.ts` | ported-adapted — env PI_WORKFLOW_ROLE→AGENT_WORKFLOW_ROLE; exported const PI_WORKFLOW_ROLE_ENV renamed AGENT_WORKFLOW_ROLE_ENV |
| `src/prompt-json.ts` | `src/core/prompt-json.ts` | ported |
| `src/prompt-schema-diagnostics.ts` | `src/core/prompt-schema-diagnostics.ts` | ported-adapted — type bridge; env PI_WORKFLOW_STRICT_PROMPT_SCHEMA→AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA |
| `src/resource-inheritance.ts` | `src/core/resource-inheritance.ts` | ported — type bridge |
| `src/roles.ts` | `src/core/roles.ts` | ported — type bridge |
| `src/secure-atomic-write.ts` | `src/core/secure-atomic-write.ts` | ported |
| `src/strings.ts` | `src/core/strings.ts` | ported |
| `src/tool-metadata.ts` | `src/core/tool-metadata.ts` | ported — type bridge |
| `src/verification-ontology.ts` | `src/core/verification-ontology.ts` | ported |
| `src/workflow-artifact-tool.ts` | — | blocked (value-imports `workflow-raw-contract.js` (`checkRawLinks`, `establishRawOwner`, `rawDigest`, ...; raw-contract reaches `store`/`launch-bootstrap-provenance`/`artifact-graph-runtime`) and `workflow-runtime.js` (blocked)) |
| `src/workflow-artifacts.ts` | `src/core/workflow-artifacts.ts` | ported — type bridge |
| `src/workflow-cancellation.ts` | `src/core/workflow-cancellation.ts` | ported |
| `src/workflow-helpers.ts` | — | blocked (value-imports `types.js` (`WorkflowValidationError` class)) |
| `src/workflow-metrics.ts` | `src/core/workflow-metrics.ts` | ported — type bridge |
| `src/workflow-network-policy.ts` | `src/core/workflow-network-policy.ts` | ported |
| `src/workflow-output-artifacts.ts` | — | blocked (value-imports `workflow-raw-contract.js` (`assertSafeRawTaskDirectory`, `checkRawLinks`, `rawDigest`, ...) and `workflow-partial-output.js` (blocked)) |
| `src/workflow-partial-output.ts` | — | blocked (value-imports `store.js` (`readJson`, `writeJsonAtomic`) and `dynamic-events.js` (`hashDynamicRequest`; dynamic-events itself value-imports store)) |
| `src/workflow-progress-health.ts` | `src/core/workflow-progress-health.ts` | ported — type bridge |
| `src/workflow-provider-callback.ts` | `src/core/workflow-provider-callback.ts` | ported |
| `src/workflow-runtime.ts` | — | blocked (value-imports `types.js` (`THINKING_LEVELS` const)) |
| `src/workflow-sensitive-query.ts` | `src/core/workflow-sensitive-query.ts` | ported |
| `src/workflow-source-alias.ts` | `src/core/workflow-source-alias.ts` | ported — type bridge |
| `src/workflow-source-context-runtime.ts` | — | blocked (value-imports `store.js` (`fromProjectPath`, `readJson`, `workflowRunDir`) and `dynamic-events.js` (`hashDynamicRequest`)) |
| `src/workflow-state-root.ts` | — | blocked (value-imports `store.js` (`syncFileAndDirectory`, `workflowsRoot`)) |
| `src/workflow-stop.ts` | — | blocked (value-imports `store.js` (`readWorkflowStopIntent`, `workflowRunPath`)) |

Totals: 30 ported (26 `ported`, 4 `ported-adapted`) and 9 `blocked`. `src/core/index.ts` is still the stub
entry point (`MODULE = "src/core"`). WP4a adds no public `exports` entry.

## Type bridge (`src/core/types-bridge.ts`)

Ported modules type-import 27 names from modules outside the set. None of them is a value import. Those
imports now point at `./types-bridge.js`:

- From `types.ts`: `AgentDefinition`, `ArtifactGraphWorkflowSpec`, `CompiledDynamicDecisionLoop`,
  `CompiledRole`, `CompiledTask`, `CompiledToolProvider`, `CompiledWorkflow`, `RoleSpec`, `TaskCapability`,
  `TaskRunStatus`, `WorkflowDynamicRunAudit`, `WorkflowForeachBatchRecord`, `WorkflowResourcePolicy`
  (also re-exported by `resource-inheritance`), `WorkflowRunRecord`, `WorkflowRunStatus`,
  `WorkflowRunType`, `WorkflowTaskRunRecord`, `WorkflowTaskToolResultBudgetAggregateRecord`,
  `WorkflowTaskToolResultBudgetAttemptRecord`, `WorkflowTaskUsageValues`, `WorkflowToolObjectSpec`,
  `WorkflowToolSpec`.
- From `dynamic-decision.ts`: `DynamicDecisionAddWorkItemAction`, `DynamicDecisionArtifactRef`,
  `DynamicDecisionSynthesizeAction`, `DynamicDecisionVerifyAction`, `NormalizedDynamicDecision`.

How the bridge was built:

- It is a generated, verbatim copy of those declarations plus their full transitive type closure: 137
  declarations, about 1.7k lines.
  - Sources: `types.ts`, `dynamic-decision.ts`, `workflow-runtime.ts` (`WorkflowModelInfo`,
    `WorkflowRuntimeDefaults`, `WorkflowRuntimeThinkingResolution`, `WorkflowModelThinkingLevelMap`),
    `workflow-raw-contract.ts` (`RawIntegrity`, `RawFileVersion`) and `workflow-native-host-context.ts`
    (`WorkflowNativeHostContext`).
- Verbatim keeps the ported code type-checked against the real shapes. A hand-narrowed bridge would
  silently weaken `strict`.
- The bridge emits no JS:
  - Value constants used only through `typeof` became non-exported `declare const` with the same literal
    tuple type. These are `THINKING_LEVELS`, `FAST_MODES`, `WORKFLOW_PROFILE_ROLES`, `APPROVAL_MODES`,
    `WORKTREE_POLICIES`, `TOOL_CLASSIFICATIONS`, `WORKFLOW_RUN_TYPE`, `DYNAMIC_DECISION_SCHEMA` and
    `DYNAMIC_DECISION_ARTIFACT_NAMES`.
  - Inline `import("./x.js").T` references point at the local copy.
- The Pi-flavoured literal types inside it are verbatim and untouched. Examples are `source: "pi-subagent"`
  and `schema: "pi-workflow-launch-…"`. Renaming them is a WP4b `types.ts` decision.
- **WP4b deletes this file** once `types.ts` and `dynamic-decision.ts` are ported. Each importer then
  switches back to `./types.js` / `./dynamic-decision.js`, a one-line change per file.

## Env / path renames

| Before | After | File |
|---|---|---|
| `PI_WORKFLOW_ROLE` | `AGENT_WORKFLOW_ROLE` | process-role.ts |
| export `PI_WORKFLOW_ROLE_ENV` | export `AGENT_WORKFLOW_ROLE_ENV` | process-role.ts |
| `PI_WORKFLOW_STRICT_PROMPT_SCHEMA` | `AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA` | prompt-schema-diagnostics.ts |
| `PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP` | `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP` | experimental-speed-flags.ts |
| `PI_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH` | `AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH` | experimental-speed-flags.ts |
| `PI_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP` | `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP` | experimental-speed-flags.ts |
| `PI_WORKFLOW_CACHE_SHAPE_METRICS` | `AGENT_WORKFLOW_CACHE_SHAPE_METRICS` | experimental-speed-flags.ts |
| `PI_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER` | `AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER` | experimental-speed-flags.ts |
| `PI_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR` | `AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR` | experimental-speed-flags.ts |
| `PI_WORKFLOW_PER_ITEM_DISPATCH` | `AGENT_WORKFLOW_PER_ITEM_DISPATCH` | experimental-speed-flags.ts |
| `<cwd>/.pi/workflow-runtime/<version>/` | `<cwd>/.agent-workflow/workflow-runtime/<version>/` | dynamic-runtime-bundle.ts |

No old names are read as fallbacks. None of the 30 files reads a Pi-CLI-only env var, `~/.pi/agent`, or
`.pi/workflows`, so none needed a `// Pi executor only (WP6)` comment and `AGENT_WORKFLOW_HOME` does not
apply yet.

## Change log (behavior-relevant)

1. The env vars in the table above are renamed. Setting the old `PI_WORKFLOW_*` name now has no effect.
2. `ensureDirectDynamicRuntimeBundle(cwd)` writes to `.agent-workflow/workflow-runtime/` instead of
   `.pi/workflow-runtime/`. This is the same rule as `.pi/workflows/` → `.agent-workflow/workflows/`, applied
   to the sibling directory.
3. `process-role.ts` exports `AGENT_WORKFLOW_ROLE_ENV` instead of `PI_WORKFLOW_ROLE_ENV`. The error texts
   follow it (`… when AGENT_WORKFLOW_ROLE=<role>`).
4. Type-only: type imports go through `types-bridge.ts`. There is no runtime effect.

Left unchanged on purpose (not paths or env vars; flagged for later WPs):

- `launch-session.ts` session ids keep the `pi-workflow.<runId>.<taskId>` / `piwf.<digest>` prefix
  (WP4c/WP6).
- The bundled direct-dynamic spec in `dynamic-runtime-bundle.ts` still lists the `workflow_web_*` tools
  that WP10 removes. Changing it would need a new `DIRECT_DYNAMIC_RUNTIME_VERSION`, because the module
  refuses to rewrite an existing versioned bundle.
- typebox: none of the 30 modules uses it, so no replacement was needed.

## Tests

`npm run validate` runs these new or ported files:

- `test/unit/core-dynamic-coordination-bundle-parity.test.mjs`: ported, 7 tests, every assertion kept,
  imports moved from `.tmp/unit/` to `dist/core/`.
- `test/unit/core-import-isolation.test.mjs`: new, 3 tests. It copies `dist/` to a temp dir with no
  `node_modules` on any ancestor and imports every `dist/core/*.js` in a child `node`. It also asserts that
  each core file imports only `node:` builtins or `./` siblings.
- `test/unit/core-port-adaptations.test.mjs`: new, 4 tests. It pins every env/path rename above.

No assertion of a ported test had to change.

### Decision per pi-workflow test file (140)

This is a first pass. It is based on each test's imported modules and helpers, on whether it references
bundled workflows or Pi packages, and on the WP1a `test/replay/INVENTORY.md` drop tags. Precedence:

1. An INVENTORY `drop` tag means `dropped`.
2. A test is `ported` when all its imports are in the WP4a set.
3. A test is `deferred-WP5+` when it needs bundled workflows (WP10), `cli.mjs` (WP11a), Pi host or extension
   modules, or Pi packages.
4. A test is `deferred-WP4c` when it needs `engine` / `subagent-backend` / `workflow-router` /
   `workflow-parent-usage` / `index` / `engine-wait`, or the `unit-test-support.mjs` harness (fake
   SubagentApi + engine).
5. Everything else is `deferred-WP4b`.

Counts: ported 1, deferred-WP4b 20, deferred-WP4c 32, deferred-WP5+ 54, dropped 33.

| pi-workflow test | Decision | Reason |
|---|---|---|
| artifact-sidecar-settlement.test.mjs | deferred-WP4b | needs workflow-output-artifacts |
| bounded-raw-link-contract.test.mjs | deferred-WP4c | needs subagent-backend,engine |
| built-engine-frozen-bundle-regression.test.mjs | deferred-WP4c | needs engine,subagent-backend |
| code-search-compat.test.mjs | dropped | INVENTORY: drop(Pi extension tool compat shim) |
| dag-hardening.test.mjs | deferred-WP4c | needs engine,subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| deep-research-completion-output.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-integrity-regressions.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-live-correction.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-optional-string-guidance.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-reader-output.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-runtime-constraints.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-sanitizer-followup.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-static-floor.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-synthesis-pages.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-research-verifier-identity.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-review-d01-d10.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-review-ledger-corrective.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| deep-review-source-scope.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| dependency-lock-consistency.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling; agent-workflow has its own tools/release) |
| dynamic-audit.test.mjs | deferred-WP4c | needs engine,subagent-backend |
| dynamic-controller-regressions.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| dynamic-coordination-bundle-parity.test.mjs | ported (`test/unit/core-dynamic-coordination-bundle-parity.test.mjs`) | all imports in the WP4a set |
| dynamic-coordination-projection.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| dynamic-coordination-replay.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| dynamic-fanout-requestid.test.mjs | deferred-WP4b | needs dynamic-loop-actions,dynamic-control-ops,engine-run-graph |
| dynamic-tool-result-budget.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| engine-output-retry-dispatch.test.mjs | deferred-WP4c | needs engine,subagent-backend |
| engine-refresh.test.mjs | deferred-WP4c | needs engine,subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| execution-profiles.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi host/extension modules: extension |
| fast-mode.test.mjs | deferred-WP5+ | Pi host/extension modules: workflow-fast-mode-extension; Pi/pi-subagent package |
| foreach-batch-runtime.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| graph-schema-contracts.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| helper-grounding-integrity.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| host-package-policy.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| host-sdk-compat.test.mjs | dropped | INVENTORY: drop(Pi host package policy) |
| impact-review-enum-control-guidance.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| impact-review-impact-fixes.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| launch-slot-observer.test.mjs | deferred-WP4c | needs subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| metrics-estimate-contracts.test.mjs | deferred-WP4b | needs run-estimates |
| nested-workflow-depth-behavior.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| no-send-controls.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| normalized-provider-corrective.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| optional-output-sections.test.mjs | deferred-WP4b | needs workflow-output-artifacts,artifact-graph-runtime,compiler,schema |
| parent-usage-retention.test.mjs | deferred-WP4c | needs workflow-parent-usage |
| partial-output-literal-preservation.test.mjs | deferred-WP4b | needs workflow-output-artifacts,workflow-partial-output |
| pi-agent-dir.test.mjs | dropped | INVENTORY: drop(Pi config dir; hosts/pi only) |
| product-corrective-11.test.mjs | dropped | INVENTORY: drop(web fetch cache removed in WP10) |
| product-corrective-12.test.mjs | dropped | INVENTORY: drop(web provider removed in WP10) |
| prompt-schema-reliability.test.mjs | deferred-WP4c | needs engine |
| raw-artifact-read-roundtrip.test.mjs | deferred-WP4c | needs subagent-backend |
| release-gates.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| release-provenance.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling; agent-workflow has its own) |
| required-artifact-read-completeness.test.mjs | deferred-WP4c | needs subagent-backend |
| review-core-fixes.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: extension |
| review-helper-byte-gates.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| review-helper-materialized.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| review-runtime-refs-dns.test.mjs | dropped | INVENTORY: drop(refs URL probing is web-tool coupled) / unknown |
| review-runtime-retention-depth.test.mjs | deferred-WP5+ | cli.mjs (WP11a) |
| run-estimates.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| run-usage-rollup.test.mjs | deferred-WP4b | needs store |
| runtime-bundled-api-boundary.test.mjs | dropped | INVENTORY: drop(pi-subagent bundling) |
| runtime-refs-transport-boundary.test.mjs | dropped | INVENTORY: drop(web-coupled) / unknown |
| runtime-storage-boundaries.test.mjs | deferred-WP4c | needs subagent-backend |
| runtime-transport-boundaries.test.mjs | dropped | INVENTORY: drop(web transport removed in WP10) |
| spec-requirement-coverage.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| spec-review-live-spec-correction.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| store-final-review-regression.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| store-lease-contention.test.mjs | deferred-WP4c | needs workflow-parent-usage |
| store-lease-handoff.test.mjs | deferred-WP4b | needs store |
| store-lock-corrective.test.mjs | deferred-WP4b | needs store |
| subagent-extension-preflight.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| subagent-partial-output.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| surface-regressions.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: workflow-view,extension |
| surface-rpc-readiness.test.mjs | dropped | INVENTORY: drop(Pi RPC host) |
| surface-rpc.test.mjs | dropped | INVENTORY: drop(Pi RPC host; hosts/pi e2e) |
| thinking-max.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| unit-artifact-web.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi/pi-subagent package |
| unit-authoring-interface.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| unit-core-runtime.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi/pi-subagent package |
| unit-dynamic-runtime.test.mjs | deferred-WP4c | needs engine,subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| unit-engine-store.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi/pi-subagent package |
| unit-model-task-runtime.test.mjs | deferred-WP4c | needs engine,subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| unit-nested-backend-refresh.test.mjs | deferred-WP4c | needs subagent-backend (+unit-test-support harness: fake SubagentApi/engine) |
| unit-resource-inheritance-compiler.test.mjs | deferred-WP4b | needs agents,compiler,dynamic-generated-task-runtime,engine-run-graph,loop-runtime,store |
| unit-resource-inheritance-recovery.test.mjs | deferred-WP4c | needs engine |
| unit-resource-inheritance-runtime.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-resource-inheritance-sdk.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-split-contract.test.mjs | dropped | INVENTORY: drop(pi-workflow test bookkeeping) |
| unit-test-cleanup.test.mjs | deferred-WP5+ | no core module; port-adapted (test harness) |
| unit-unlimited-loop.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| unlimited-supervisor.test.mjs | deferred-WP5+ | cli.mjs (WP11a) |
| verification-ontology-parity.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| wb-001-web-provider-compat.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-002-json-path-hardening.test.mjs | deferred-WP4b | needs artifact-graph-runtime,workflow-runtime |
| wb-002-normalized-web-contract.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-003-package-closure.test.mjs | deferred-WP5+ | no core module; port-adapted (release tooling exists in agent-workflow) |
| wb-003-web-security.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-004-backend-lifecycle.test.mjs | deferred-WP4c | needs subagent-backend |
| wb-005-index-durability.test.mjs | deferred-WP4c | needs engine |
| wb-006-rate-limit-lock.test.mjs | deferred-WP4c | needs subagent-backend |
| wb-007-dynamic-recovery.test.mjs | deferred-WP4b | needs engine-run-graph |
| wb-008-filesystem-security.test.mjs | deferred-WP4b | needs workflow-artifact-tool |
| wb-009-workflow-policy.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| wb-012-public-contracts.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| wb-014-platform-package.test.mjs | dropped | INVENTORY: drop(pi-workflow package CI) |
| wb-016-scheduler-performance.test.mjs | deferred-WP4c | needs engine-wait,engine,subagent-backend |
| wb-017-artifact-index-performance.test.mjs | deferred-WP4b | needs workflow-artifact-tool,store |
| wb-018-dynamic-tail-performance.test.mjs | deferred-WP5+ | Pi host/extension modules: workflow-view |
| worker-role.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| workflow-active-ui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-artifact-footprint.test.mjs | deferred-WP4b | needs workflow-output-artifacts,run-retention,store |
| workflow-authoring-corrective.test.mjs | deferred-WP4b | needs engine-run-graph,compiler,artifact-graph-schema,types,workflow-specs |
| workflow-authoring-gates.test.mjs | deferred-WP4b | needs compiler,engine-format,schema,workflow-specs |
| workflow-auto-binding.test.mjs | deferred-WP4b | needs workflow-auto-binding |
| workflow-auto-negative-boundaries.test.mjs | deferred-WP4c | needs workflow-router,subagent-backend |
| workflow-command-actions.test.mjs | dropped | INVENTORY: drop(Pi slash command; hosts/pi) |
| workflow-contract-findings-006-008.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| workflow-extension-isolation.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| workflow-fixture-lifecycle.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| workflow-guide-fixed-inventory.test.mjs | deferred-WP4b | needs artifact-graph-runtime,compiler,engine-run-graph,schema,store,workflow-output-artifacts |
| workflow-launch-cancellation.test.mjs | deferred-WP5+ | Pi host/extension modules: extension; Pi/pi-subagent package |
| workflow-launch-metadata.test.mjs | deferred-WP4c | needs engine |
| workflow-mtbyqwu0-security.test.mjs | deferred-WP4b | needs workflow-output-artifacts |
| workflow-native-boundary.test.mjs | dropped | INVENTORY: drop(Pi native host context) |
| workflow-native-cli.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-host.test.mjs | dropped | INVENTORY: drop(Pi native host) / unknown (MCP part may map to WP9) |
| workflow-native-launch.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-prompt-policy.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| workflow-native-session.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-tool-policy.test.mjs | dropped | INVENTORY: drop(Pi native host) / unknown |
| workflow-notice-acknowledgements.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: extension |
| workflow-parent-usage-topology-retry.test.mjs | dropped | INVENTORY: drop(Pi parent session usage) / unknown |
| workflow-parent-usage.test.mjs | dropped | INVENTORY: drop(Pi parent session usage) |
| workflow-profile-routing-compat.test.mjs | deferred-WP4b | needs execution-profile,workflow-profile-settings |
| workflow-profile-tui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-report-contracts.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| workflow-router.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi host/extension modules: extension; Pi/pi-subagent package |
| workflow-user-profiles.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi host/extension modules: extension,workflow-profile-ui,workflow-profile-tui |
| workflow-view.test.mjs | dropped | INVENTORY: drop(Pi TUI) / port-adapted if board moves to CLI |
| workflow-wait-tool.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
