# Core port (WP4a, WP4b, WP4c-1, WP4c-2, WP4d, WP4e)

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
| `src/foreach-batch-capability.ts` | `src/core/foreach-batch-capability.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `workflow-state-root.js` (`assertWorkflowStateRootCapability`, ...), which is blocked (below)) |
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
| `src/workflow-artifact-tool.ts` | `src/core/workflow-artifact-tool.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `workflow-raw-contract.js` (`checkRawLinks`, `establishRawOwner`, `rawDigest`, ...; raw-contract reaches `store`/`launch-bootstrap-provenance`/`artifact-graph-runtime`) and `workflow-runtime.js` (blocked)) |
| `src/workflow-artifacts.ts` | `src/core/workflow-artifacts.ts` | ported — type bridge |
| `src/workflow-cancellation.ts` | `src/core/workflow-cancellation.ts` | ported |
| `src/workflow-helpers.ts` | `src/core/workflow-helpers.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `types.js` (`WorkflowValidationError` class)) |
| `src/workflow-metrics.ts` | `src/core/workflow-metrics.ts` | ported — type bridge |
| `src/workflow-network-policy.ts` | `src/core/workflow-network-policy.ts` | ported |
| `src/workflow-output-artifacts.ts` | `src/core/workflow-output-artifacts.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `workflow-raw-contract.js` (`assertSafeRawTaskDirectory`, `checkRawLinks`, `rawDigest`, ...) and `workflow-partial-output.js` (blocked)) |
| `src/workflow-partial-output.ts` | `src/core/workflow-partial-output.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `store.js` (`readJson`, `writeJsonAtomic`) and `dynamic-events.js` (`hashDynamicRequest`; dynamic-events itself value-imports store)) |
| `src/workflow-progress-health.ts` | `src/core/workflow-progress-health.ts` | ported — type bridge |
| `src/workflow-provider-callback.ts` | `src/core/workflow-provider-callback.ts` | ported |
| `src/workflow-runtime.ts` | `src/core/workflow-runtime.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `types.js` (`THINKING_LEVELS` const)) |
| `src/workflow-sensitive-query.ts` | `src/core/workflow-sensitive-query.ts` | ported |
| `src/workflow-source-alias.ts` | `src/core/workflow-source-alias.ts` | ported — type bridge |
| `src/workflow-source-context-runtime.ts` | `src/core/workflow-source-context-runtime.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `store.js` (`fromProjectPath`, `readJson`, `workflowRunDir`) and `dynamic-events.js` (`hashDynamicRequest`)) |
| `src/workflow-state-root.ts` | `src/core/workflow-state-root.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `store.js` (`syncFileAndDirectory`, `workflowsRoot`)) |
| `src/workflow-stop.ts` | `src/core/workflow-stop.ts` (WP4b) | blocked in WP4a, ported in WP4b (value-imports `store.js` (`readWorkflowStopIntent`, `workflowRunPath`)) |

Totals: 30 ported (26 `ported`, 4 `ported-adapted`) and 9 `blocked`. `src/core/index.ts` is still the stub
entry point (`MODULE = "src/core"`). WP4a adds no public `exports` entry.

## Type bridge (`src/core/types-bridge.ts`) — deleted in WP4b

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
5. Live bundle 5 (WP39), a fix of the ported engine (pi-workflow 0.16.4 has the same code): when
   `resume` applies a dependency invalidation (a resumed task feeds a stage with
   `inputPolicy.invalidateOnDependencyResume`, for example deep-review's reviewers →
   `dedup-findings`), each affected task whose generation changes now also drops its
   launch-bootstrap provenance history (`task.launchBootstrap`) and its launch authority history
   (`task.launchAuthority`). Both histories accept records of one task identity only (taskId,
   specId, generation). Before, a task that had launched before `stop` kept its generation-0
   records, and its generation-1 relaunch failed at once with `launch-bootstrap provenance is
   malformed` (`failed/launch_failed`); with only the provenance history dropped, with `workflow
   launch authority history is malformed`. The run then finished without that task's output. The
   superseded generation's artifacts are quarantined as before. Regression tests:
   `test/unit/core-wp39-resume-generation-provenance.test.mjs` (record level, and stop/resume end to
   end on the workflow executor fixture; both fail on the old code).
6. WP39b (live bundle 5, O3): the auto classifier output parser (`parseWorkflowAutoComparisonOutput`)
   normalizes evidence fields before validating them. `gpt-5.6-luna` named flattened sub-fields of
   a card's nested objects (`facts.tools`, `facts.usesNetwork`, `facts.effective`,
   `readiness.status`, `readiness.startAllowed`) and once an unprefixed `declaredVerification`, and
   every such output failed host validation (no recommendation). Now a known sub-field of `facts`,
   `readiness` or `comparison.overhead` maps to that field, an unprefixed name that is the last
   segment of exactly one offered field maps to it, duplicates collapse, and anything else is still
   invalid (`facts.invented`, `routing.useWhen.0`, `comparison`). The prompt is unchanged. Test:
   `core-workflow-router.test.mjs` "recorded luna classifier outputs …" on the three recorded live-5
   outputs (`test/fixtures/live5/auto-router/`; all three fail on the old code).
7. WP39b (live bundle 5, O7), managed worktrees (pi-workflow 0.16.4 has the same code):
   - The attempt state of a task in a managed worktree (`workflow-subagents/<run>/<task>/`) is
     written in the project's own `.agent-workflow/`, not inside the worktree: the runtime runs the
     task with `cwd` = the project and the worktree as its shared-mode execution directory
     (`workflowTaskStateCwd`; runtime change log 19). Readers use the recorded handle's cwd
     (`recordedTaskStateCwd`), handle recovery looks in the project first, then in the task cwd
     (attempts launched before WP39b), and the raw-artifact contract (`backendMirrorRoot`) takes the
     project's mirror when the attempt is there, after the same worktree checks (the worktree must
     still be the real managed directory). Prune and logs now see those attempt dirs.
   - The dirty-checkout snapshot excludes the whole project state directory `.agent-workflow/`
     (was only `.agent-workflow/workflows/`), so other tasks' attempt state, notify receipts and
     runtime bundles are never copied into a worktree when `.agent-workflow/` is not git-ignored.
   - `status`/`show`/`inspect` name each worktree task's path and branch; `prune` lists a run's
     worktrees in the dry run and removes them with `--yes` (docs/usage.md "Worktrees").
   Tests: `core-wp39b-worktree-state.test.mjs` (all fail on the old code),
   `core-unit-dynamic-runtime.test.mjs` "mutation-capable agents publish from managed and shared
   loop worktrees" (expects the project's mirror now).
8. WP39b (live bundle 5, O8): the worker system prompt's "Effective Tool Policy" of a task that
   inherits the Pi host's tools (the sealed launch carries the run's host context, exactly when the
   Pi executor gets `inheritHostTools`) lists them as available: "Host tools inherited from the Pi
   session are also available: codemode, tool_search, mcp__* (matching MCP tools),
   list_mcp_resources, list_mcp_resource_templates, read_mcp_resource; use them when the task needs
   them", and the stage's own list reads "Only these workflow tools …". Before, it said only the
   stage's tools were enabled and "unavailable tools cannot be called", and the live worker answered
   "tool_search is not available". readOnly stages (never inheriting) keep the old text. Test:
   `executor-wp35-host-tools.test.mjs` "the Effective Tool Policy …" (fails on the old code).
9. WP39b (live bundle 5, O13): the capability preview of a launch with no stage to negotiate up
   front (direct dynamic) reads `Capability check (<executor>, stages are generated at run time;
   each is negotiated when generated, permission mode: …)` instead of `0 stages`
   (`buildCapabilityPreview` option `stagesLabel`). Test: `core-wp39b-dynamic-preview.test.mjs`
   (fails on the old code).
10. WP39b (live bundle 5, O16): `prune` also handles the auto classifier's one-shot runs under
    `workflows/auto-router-runs/` (`run_*` with a terminal runtime `run.json`, the run filters,
    summary field `autoRouterRuns`). Before, that directory, which has no `run.json` of its own,
    made the retention plan "uncertain", so every selected run was protected ("uncertain run
    references") once a project had used `auto`. Test: `core-wp39b-auto-router-retention.test.mjs`
    (fails on the old code).
11. WP39b (flaky `host-wp33-pi-parent-usage`): the parent-usage tracker took "the run has settled"
    from the run index, which the engine updates debounced, so a parent message right after the run
    completed was counted as a during-run message and the next one as the wrap-up (the test's
    "expected 3 messages, got 4" under load). It now reads the run record first (the index only when
    the record cannot be read). Each message was still counted once; only the boundary moved. The
    test's completion wait is 120 s (the "timeout" variant under load). Test:
    `core-wp39b-parent-usage-wrapup.test.mjs` (deterministic: the index lags on purpose; fails on
    the old code with 3 !== 2).

Left unchanged on purpose (not paths or env vars; flagged for later WPs):

- `launch-session.ts` session ids keep the `pi-workflow.<runId>.<taskId>` / `piwf.<digest>` prefix
  (WP4c/WP6).
- The bundled direct-dynamic spec in `dynamic-runtime-bundle.ts` still lists the `workflow_web_*` tools
  that WP10 removes. Changing it would need a new `DIRECT_DYNAMIC_RUNTIME_VERSION`, because the module
  refuses to rewrite an existing versioned bundle. (Done in WP10: v5 with `web_search`/`fetch_content`, see "WP10" below.)
- typebox: none of the 30 modules uses it, so no replacement was needed.

## WP4b — seed replacements and hub-coupled modules

WP4b ports 45 more modules (the 9 WP4a `blocked` files included) and replaces the six Pi "seed" modules
they reached Pi through. `src/core/` now has 82 files: 30 WP4a + 45 WP4b + 6 seed replacements + the
`index.ts` stub. `types-bridge.ts` is deleted; every WP4a importer points at `./types.js` or
`./dynamic-decision.js` again. No module uses typebox or jiti, and none imports `@earendil-works`.

### Seed replacements

| Pi seed (b83cc4f) | Core module | Kept | Dropped → where |
|---|---|---|---|
| `pi-agent-dir.ts` | `home-dir.ts` | `agentWorkflowHome(env)` = `AGENT_WORKFLOW_HOME` or `~/.agent-workflow`; `legacyPiAgentDir(env)` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`) for read-only discovery only; `PROJECT_STATE_DIRECTORY` = `.agent-workflow`, `LEGACY_PROJECT_PI_DIRECTORY` = `.pi` | `piAgentDir` as a write location |
| `workflow-native-host-context.ts` | `host-context.ts` | `HostContext {version: 1, cwd, homeDir, projectTrusted}`, `assertHostContext`, `createHostContext`, `withHostContext(ctx \| null, op)` (AsyncLocalStorage), `resolveHostContext()` with env fallback `AGENT_WORKFLOW_HOST_CONTEXT` | Pi `ExtensionContext` session tracking (`captureWorkflowNativeHostContext`, `withWorkflowNativeHostContext`), `buildWorkflowNativeHostExtensionWrapper`, `workflowNativeLaunchTools` → WP6 Pi adapter |
| `workflow-native-tool-policy.ts` | `tool-policy.ts` | `applyWorkflowToolPolicy(tools, providers, {inheritHostTools})`, `prepareWorkflowTaskToolPolicy`, `inheritedHostToolSafety`, `DEFAULT_WORKER_TOOLS` (Pi tool names; the SDK maps them) | The `codemode`/`tool_search`/`mcp__*`/MCP-resource names and their classifications → WP6 |
| `workflow-artifact-extension.ts` | `artifact-access.ts` | `ArtifactAccessConfig`, canonical bytes, `artifactMcpServerSpec(config)`, tool name, JSON input schema, description, failure payload | `registerWorkflowArtifactTool`, tool activation hooks, wrapper writers → WP5 MCP server |
| `workflow-fast-mode-extension.ts` | `fast-tier.ts` | `WORKFLOW_FAST_SERVICE_TIER`, eligible models, `resolveWorkflowFastModeConfig` (capability `fastTier`) | Provider-stream guard, `before_provider_request` hook, payload helpers, wrapper writers → WP6 |
| `backend.ts` | `task-launch.ts` | `PreparedWorkflowTaskLaunch`, `WorkflowBackend`, `BackendLaunchResult`; `registerWorkflowBackend` / `resolveWorkflowBackend` | The hard-wired `pi-subagent/headless` backend and its error→`fatal` wrapper → WP4c registers a runtime-API backend |

**home-dir.** Every user-scoped location (user workflows, user agents, profile settings) is under
`agentWorkflowHome()`. The Pi directory is read only by spec and agent discovery. That reader follows
`PI_CODING_AGENT_DIR` because that is where Pi itself keeps those files.

**host-context.** The host that launches a run (CLI, MCP, Pi) records a `HostContext` in
`run.hostContext`. It can bind it around the launch with `withHostContext`, or headless children can
inherit it through `AGENT_WORKFLOW_HOST_CONTEXT`. Child runs copy the parent's value. Like
`nativeHost` before it, the field is immutable after publication. The record holds references only.
It no longer decides tool expansion: under pi-workflow the presence of `nativeHost` meant "add
codemode/MCP tools". Under agent-workflow every host records a context, so that decision became a
separate flag (next item).

**tool-policy and `inheritHostTools` (A2-4: Pi executor only).** Host-tool inheritance is an explicit
host-level option: the compile option `inheritHostTools`, recorded as `compiled.inheritHostTools` and
`run.inheritHostTools` and inherited by child runs. Workflow specs cannot set it, and the default is off
(B5). When it is on, a task gets `runtime.inheritHostTools: true`; an unspecified tool list becomes
`read, bash, edit, write`, and `[]` stays tool-free with `inheritHostTools: false`. Core then classifies
the task as mutation-capable: `sharedCwdSafe: false`, a worktree is required, and on-request approval is
blocked as pending. That is the safety the Pi tool names used to imply. **WP6 hook:** the Pi adapter adds
`codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`, `list_mcp_resource_templates` and
`read_mcp_resource` only when `runtime.inheritHostTools === true`. Other executors ignore the flag.
Launch provenance (below) then fails closed, because it still expects exactly one Pi `native-host`
wrapper for such a task. **WP35:** the Pi host sets the option (`docs/pi-host.md`); the engine honors it
only when the run's executor is `pi`; readOnly stages compile with `inheritHostTools: false`; provenance
requires the run's `pi` executor instead of the wrapper, and the task backend passes the flag to the Pi
executor as per-task descriptor config. **WP31 × WP35:** in a mixed role-profile run the decision is per
task: the compile option `runExecutor` keeps host tools to stages whose executor is `pi`
(`runInheritsHostToolsForTask` does the same for foreach/loop/dynamic tasks prepared at runtime),
provenance checks the task's own executor, and each stage's negotiation record/preview block carries
`hostTools` (`inherited`, `readOnly`, `no-tools`, `executor`).

**artifact-access.** `prepareDagTask` writes `<task dir>/artifact-access.json` with mode 0600. The file
is canonical JSON (sorted keys) of `{version: 1, runId, taskId, manifestPath, ledgerPath,
accessMode: "workflow-task", runDir}`; `maxBytes`/`maxLines` are optional. The task's
`toolProviders.workflow_artifact` becomes `{classification: "read-only", mcpServer: {name:
"workflow_artifact", command: process.execPath, args: [<package>/dist/mcp/artifact-server/server.js,
"--config", <config path>]}}`. The `mcpServer` field is new on `CompiledToolProvider`. WP4c copies it into
`SubmitRequest.mcpServers`. The server entry is WP5; this WP only references its path.
`workflow-artifact-extension.ts` is no longer generated.

**fast-tier / task-launch.** These are pure resolution and types. `PreparedWorkflowTaskLaunch` marks
`extensions`, `noExtensions` and `generatedExtensions` as Pi executor only (WP6). `nativeHost` became
`hostContext`, set only when the task inherits host tools. `artifactBinding` is now
`{manifestPath, expectedManifestBytes, configPath, expectedConfigBytes, serverSpec}`.

### What launch provenance digests now

`launch-bootstrap-provenance.ts` used to check `workflow-artifact-extension.ts` against the expected
wrapper bytes and record `wrapperSha256`. It now does the following:

- `artifacts` = `{manifestSha256, configSha256, serverSpecSha256}`:
  - `configSha256` is SHA-256 of the canonical JSON of the `ArtifactAccessConfig` derived from the run.
  - `serverSpecSha256` is SHA-256 of the canonical JSON of `artifactMcpServerSpec(config)`. That covers the
    node binary path, the server entry path and the config path.
  - Before recording, it reads `artifact-access.json` and requires it to be byte-identical to
    `artifactAccessConfigBytes(config)`. A tampered or missing file throws (`… artifact access binding is
    invalid` / `… is unavailable`).
- `effectiveLaunch.artifactBinding` = SHA-256 of `manifestPath`, manifest bytes, `configPath`, config
  bytes, and the canonical server spec. The wrapper path and bytes are gone.
- `effectivePolicy.tools` = `runtime.tools ?? []`. pi-workflow recorded the Pi-expanded list here.
  `effectivePolicy.inheritHostTools: true` is added when the task inherits host tools, so that decision is
  covered by `identitySha256`.
- The native-host check compares `preparedLaunch.hostContext` with `run.hostContext` when the task inherits
  host tools; otherwise both must be absent.

The schema ids (`pi-workflow-launch-bootstrap-provenance-v1/v2`) are unchanged. The record shape under
them changed (`wrapperSha256` → `serverSpecSha256`), so pi-workflow records fail validation (closed).
Renaming the Pi-flavoured literals in `types.ts` stays open (WP4c/WP6).

### Legacy read (F5)

Discovery order (lower wins; ties are ambiguous as before):

- **Workflow specs:** `<project>/workflows` (0), `<project>/.agent-workflow/workflows` (1),
  `~/.agent-workflow/workflows` (2), legacy `<project>/.pi/workflows` (3), legacy `~/.pi/agent/workflows`
  (4), package `workflows/` (5).
- **Agents:** `<project>/.agent-workflow/agents`, `~/.agent-workflow/agents`, legacy `<project>/.pi/agents`,
  legacy `~/.pi/agent/agents`, then bundled agents.

The legacy paths were confirmed from b83cc4f (`workflow-specs.ts:625-629`, `agents.ts:237-238`). Hits from
legacy roots carry `legacySource: "pi"` on `ResolvedWorkflowSpecRef`, `WorkflowSpecRecord` /
routing records and `AgentDefinition`. They keep their normal `scope` (`project-private`/`user`,
`project`/`user`), so the project symlink protections still apply. Nothing writes to legacy locations: runs,
bundles, notices, worktrees and profile settings all use `.agent-workflow`. The package workflow root is
now resolved two levels up from `dist/core/` (pi-workflow's dist was flat).

### R#5 (D2): write stages require a worktree

In `compiler.ts` `classifySafety`, `requiresWorktree` = `worktreePolicy === "on"` or (not
`sharedCwdSafe` and not waived). The waiver exists only when the spec says `off` **and** the compile
option `allowSharedCheckoutWrites: true` is set. That option belongs to the executing user; a spec cannot
set it. A spec-level `off` on a write-capable task now compiles with `requiresWorktree: true` and the
warning `stage "<id>" sets worktreePolicy: "off" but can write (<capability>); a worktree is still
required (D2). Only the executing user's allowSharedCheckoutWrites run option can disable it.`

When the waiver applies:

- The task records `safety.allowSharedCheckoutWrites: true`.
- `compiled.allowSharedCheckoutWrites` and `run.allowSharedCheckoutWrites` record the option, and
  `createRunRecord` copies it.
- Read-only tasks with `off` are unchanged (no worktree, no warning).
- Dynamic generated tasks already required a worktree whenever they were not read-only.

Not changed: support helpers and dynamic controllers keep their hard-coded `off`/no worktree, because they
are engine-side code and not executor workers. Loop placeholders are read-only.

Tests (`core-wp4b-seeds.test.mjs`): readOnly + off → no worktree, no warning; write + off → worktree
required + warning; write + off + option → no worktree, recorded in compiled, task safety and run.json, and
the option does not weaken `auto`.

### WP4b modules

All 45 are `ported`. Those with changes beyond the header and the bridge repoint are listed in each file's
header line:

- `agents`, `workflow-specs`: new/legacy roots.
- `store`, `workflow-state-root`, `workflow-notices`, `workflow-auto-binding`, `workflow-raw-contract`,
  `dynamic-controller-policy`, `run-retention`, `worktree`: paths/env.
- `workflow-profile-settings`: settings root.
- `compiler`: R#5, fast-tier, `inheritHostTools`.
- `dynamic-generated-task-runtime`, `artifact-graph-runtime`, `launch-bootstrap-provenance`: seeds.
- `engine-wait`: backend registry.
- `types`: fields.

The other 31 have `Changes: none.`

### WP4b env / path renames

| Before | After | File |
|---|---|---|
| `<project>/.pi/workflows/` (run state, bundles, notices, worktrees, raw contract) | `<project>/.agent-workflow/workflows/` | store, workflow-state-root, workflow-notices, workflow-auto-binding, workflow-raw-contract, dynamic-controller-policy, worktree |
| `<project>/.pi/workflow-subagents/` (worker mirrors) | `<project>/.agent-workflow/workflow-subagents/` | run-retention, workflow-raw-contract (WP4c must write the same path) |
| `<project>/.pi/workflows` / `.pi/agents` discovery | `.agent-workflow/…` first, `.pi/…` read-only after | workflow-specs, agents |
| `~/.pi/agent/workflows`, `~/.pi/agent/agents` | `~/.agent-workflow/…` first, Pi dir read-only after | workflow-specs, agents |
| `~/.pi/agent/workflow-profiles/v1` | `~/.agent-workflow/workflow-profiles/v1` | workflow-profile-settings |
| `PI_CODING_AGENT_DIR` (user dir) | `AGENT_WORKFLOW_HOME` (`PI_CODING_AGENT_DIR` only locates the legacy Pi dir) | home-dir |
| `PI_WORKFLOW_NATIVE_HOST_CONTEXT` | `AGENT_WORKFLOW_HOST_CONTEXT` | host-context |
| `PI_WORKFLOW_ROLE` (store lease checks) | `AGENT_WORKFLOW_ROLE` | store |
| `PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256`, `PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT` | `AGENT_WORKFLOW_…` | launch-bootstrap-provenance |
| `PI_WORKFLOW_PRIVATE_RUNTIME_ARTIFACT_NAMES`, `PI_WORKFLOW_CLONE_RUNTIME_ARTIFACT_DIRS`, `PI_WORKFLOW_ALLOW_FULL_RUNTIME_ARTIFACT_COPY` | `AGENT_WORKFLOW_…` | worktree |

No old `PI_WORKFLOW_*` name is read as a fallback. The worktree artifact scan skips both `.agent-workflow`
and the legacy `.pi` directory.

### WP4b change log (behavior-relevant)

1. The paths and env vars in the table above are renamed. Legacy Pi spec/agent locations are read-only
   fallbacks tagged `legacySource: "pi"`.
2. `run.nativeHost` → `run.hostContext` (`agentDir` → `homeDir`). `runtime.nativeToolsEnabled` →
   `runtime.inheritHostTools`. Host-tool inheritance is an explicit `inheritHostTools` option and is no
   longer implied by a host context. The compile option `nativeHost` was removed.
3. R#5: spec `worktreePolicy: "off"` no longer exempts write-capable tasks; `allowSharedCheckoutWrites`
   (run option) does.
4. Artifact access: `artifact-access.json` + MCP server spec replace the generated Pi extension wrapper.
   The provenance fields changed as described above.
5. `resolveWorkflowBackend` throws for every backend until one is registered (WP4c).
6. The package workflow root resolves from `dist/core/` to `<package>/workflows`.

### WP4b tests

`npm run validate` runs 27 `core-*` files (168 node:test tests, subtests included):

- The 23 ported pi-workflow files in the table below. Assertions are unchanged except for the
  path/env renames named in each header. Five tests were dropped and deferred: 2 `cli.mjs inspect` in
  workflow-authoring-gates (WP11a), 1 `cli.mjs prune` in review-runtime-retention-depth (WP11a),
  1 `engine.ts` source scan in prompt-schema-reliability (WP4c), and 1 `engine.ts` +
  `subagent-backend.ts` source scan in wb-016 (WP4c).
- `core-wp4b-seeds.test.mjs`: new, 13 tests.
- `core-import-isolation.test.mjs`: now derives the expected module list from `src/core/*.ts`. It still
  imports every `dist/core/*.js` (82) with no `node_modules` on the path.
- `test/fixtures/core/workflow-guide-scaffolds/`: a verbatim copy (biome-formatted) of pi-workflow's
  `skills/workflow-guide/scaffolds/{fixed-inventory,support-partition}`. The fixed-inventory and
  authoring-gates tests exercise these with the core runtime. The skill itself is not ported here.

### Discoveries for later WPs

- **WP4c:**
  - Register the backend (`registerWorkflowBackend({type: "local-pi", mode: "headless"}, …)`) and
    re-create the source wrapper that turned non-abort launch errors into `{kind: "fatal"}`.
  - Copy `toolProviders[*].mcpServer` into `SubmitRequest.mcpServers`, and fill
    `PreparedWorkflowTaskLaunch.artifactBinding` with the config path/bytes and server spec.
  - `subagent-backend` must use `.agent-workflow/workflow-subagents`.
  - `engine.ts:2860` / `:5418` read `requiresWorktree` and `explicitWorktreePolicy`; check them against R#5.
  - Pass `allowSharedCheckoutWrites` and `inheritHostTools` from the host into `compileWorkflow`.
  - Decide the `pi-workflow-*` schema literals and `backend: {type: "local-pi"}` (F5 warning).
- **WP5:**
  - The server entry must be `dist/mcp/artifact-server/server.js` taking `--config <artifact-access.json>`.
  - The config is `ArtifactAccessConfig`; validate it with `assertArtifactAccessConfig`.
  - Serve `WORKFLOW_ARTIFACT_TOOL_PARAMETERS` and return `workflowArtifactFailureResult` on errors.
  - `handleWorkflowArtifactToolCall` (workflow-artifact-tool) takes the config minus `version`.
- **WP6:**
  - Honor `runtime.inheritHostTools` (native tool list above) and emit exactly one `native-host` wrapper
    bound to `run.hostContext`.
  - Re-home the fast-mode provider guard on `fast-tier.ts` config. (WP35: done in the Pi executor's
    per-run extension; the task backend passes `fast`/`fastApi` as per-task descriptor config.)
  - Map `HostContext` from the Pi `ExtensionContext` (`isProjectTrusted`) at launch.
- `serverSpecSha256` includes `process.execPath`. A node upgrade between recording and re-checking the same
  attempt's provenance fails closed. The old wrapper digest already pinned the package path.

## WP4c-1 — engine on the runtime API, subagent-backend decomposed

Source: `src/engine.ts`, `src/subagent-backend.ts`, `src/workflow-router.ts`, `src/workflow-parent-usage.ts`,
`src/index.ts` and `src/backend.ts` at `b83cc4f`. `subagent-backend.ts` (7,450 lines) has no single
destination. Its policies moved to focused core modules, its pi-subagent calls go to the in-repo runtime
API (`src/runtime/api.ts`), and its Pi launch code is listed below as Pi executor (WP6) or dropped.

### Policy inventory and policy-move table (WP4 acceptance)

The inventory was written from `subagent-backend.ts` before any code moved. Line ranges refer to that
file at `b83cc4f`. Every row has a destination; nothing was removed silently.

| # | Policy (what it enforces) | Source lines | Destination |
|---|---|---|---|
| 1 | Process launch gate: `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES` (default max(2, cores/2)), FIFO wait queue, slot hand-off, abort while queued, release delay (3 s; 250 ms with the launch ramp) | 176, 186-187, 192-193, 962-983, 1079-1158, 1563-1580, 1633-1673 | `launch-slots.ts` (env → `AGENT_WORKFLOW_*`) |
| 2 | Live model worker slots per run (`MAX_LIVE_MODEL_WORKERS`) and adaptive live workers (floor 4, grow/shrink on median execution time, shrink on rate-limit backoff) | 177-185, 1159-1327, 1506-1562 | `launch-slots.ts` |
| 3 | Launch control telemetry and test controls (`setSubagentLaunchControlsForTests`, slot snapshots) | 765-779, 1581-1632, 2680-2726 | `launch-slots.ts` |
| 4 | Bounded runtime operations: launch ack 30 s, refresh 10 s, interrupt 10 s; abort and workflow-stop checks between every launch step | 196-198, 984-1078, 1685-1687 | `launch-operations.ts` |
| 5 | Retry limits: transient launch failures 5, artifact-output repairs 2, env overrides validated as non-negative safe integers | 169-174, 6146-6159 | `retry-policy.ts` (env → `AGENT_WORKFLOW_*`) |
| 6 | Transient failure retry: no-output model failures retried with a new launch attempt, 1-5 s jitter, `nextEligibleAt` honored, exhaustion → failed | 199-200, 1674-1684, 6083-6121, 6160-6211 | `retry-policy.ts` (jitter: `launch-slots.ts`, which owns the test hook); retryable kinds now include runtime `transient`, `rate_limit`, `not_started` |
| 7 | Rate-limit backoff: Retry-After/"try again in" parsing, exponential default, per-provider shared backoff persisted across processes (lock dir, merge maxima, 32 keys, telemetry on write failure) | 208-213, 781-961, 2727-2736, 5882-6013, 6035-6082 | `retry-policy.ts` (file under `AGENT_WORKFLOW_HOME`); runtime `failureKind: rate_limit` backs off without text evidence |
| 8 | Auth-type probe: read `~/.pi/agent/auth.json` (or `PI_WORKFLOW_AUTH_FILE`) to choose the OAuth backoff profile | 214, 6014-6034 (used at 6035-6049) | **dropped (R#12, D1)**: unknown auth kind takes the conservative OAuth profile (15 min base, 60 min cap); `setExecutorAuthKindProbe` lets an executor probe report a non-secret `subscription`/`api-key` kind |
| 9 | Failure classification: deterministic boot failures, permanent provider input-validation failures (never retried) | 5776-5881 | `retry-policy.ts` |
| 10 | Required artifact reads: ledger after attempt start, truncated rows excluded, path aliases, exact counts, projection policies, failure messages | 5443-5725 | `required-reads.ts`; R#9: rows with `deliveryUnverified: true` never count |
| 11 | Output-contract validation and repair: artifact bundle validation, retry instructions, new-session and same-session repair (`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`), salvage of failed-but-complete output, claim-support/refs checks, missing-read attempt records | 4922-5442, 5726-5775, 6212-6319 | `output-validation.ts` (`retryOrFailArtifactGraphTask` in `retry-policy.ts`) |
| 12 | Foreach batch: terminal demux of the leader, evidence persistence, fallback to per-item launches, capability checks, restart recovery | 4511-4921 | `foreach-recovery.ts` |
| 13 | Durable launch barrier, engine side: create/resume per authority (3087-3144); READY validation against the authorized launch, authority consume, release vs **revoke on workflow stop or lease loss**, ACK validation, revoke+interrupt on any failure (3322-3573); cancellation decision (1328-1467); restart reconcile from barrier receipts (3610-3820) | 531-533, 1328-1467, 3087-3144, 3322-3573, 3610-3820 | `launch-barrier-engine.ts` (`createOrResumeDurableLaunchBarrier`, `settleDurableLaunchBarrier`, `decideDurableBarrierCancellation`, `reconcileDurableLaunchBarrierTask`); same order and checks |
| 14 | Cancellation: exact-attempt interrupt with terminal acknowledgement, barrier-aware `acknowledgeSubagentTaskInterrupted`, run cleanup, timeout interruption | 1468-1505, 2737-2867, 4194-4217 | `task-cancellation.ts`, `task-backend.ts`; the runtime turns the interrupt into `executor.cancel(ref, "owned")` |
| 15 | Launch authority and launch-bootstrap provenance: create/issue, assert current, register before launch, consume on READY or handle | 2950-2980, 3187-3227, 3371-3376, 3575-3580 | `task-backend.ts` (`launchSubagentTask`), `launch-barrier-engine.ts`; backend id `agent-workflow/runtime` |
| 16 | Stale launch claims and handle recovery (correlation id, pre-claim records ignored, non-spawnable authority → fail, never duplicate spawn) | 194, 4218-4245, 7241-7340 | `task-backend.ts`, `task-artifacts.ts` |
| 17 | Refresh polling: bounded concurrency 8, reconcile + status per handle, partial-output refresh, timeout handling, coalesced single write | 195, 3821-4193 | `task-backend.ts` (`refreshRunFromSubagentArtifacts`) |
| 18 | Terminal result mapping: log copies, result/tool-call summaries, status from the run snapshot, transient retry hand-off | 4246-4510, 6320-6400 | `terminal-result.ts`; runtime `needs_decision` → blocked (below) |
| 19 | Usage, timing and tool-result-budget telemetry on task records | 1689-2679 | `task-observability.ts` (record `source: "executor"`) |
| 20 | Tool-result budgets for dynamic tasks (default 320k chars, env override) | 205-207, 2027-2032, 6123-6145, 3238-3242 | configuration and telemetry: `task-observability.ts`; **enforcement: Pi executor (WP6)** (C1, Pi only) |
| 21 | Parent usage: child started/terminal events with usage totals to a parent runtime run | 188-191, 463-482, 666-764 | `parent-child-events.ts` (env → `AGENT_WORKFLOW_PARENT_SUBAGENT_*`); parent-session usage stays in `workflow-parent-usage.ts` |
| 22 | Worker role: `PI_WORKFLOW_ROLE=worker` scoped around the launch (process env) | 619-662 | `task-backend.ts`: `SubmitRequest.env.AGENT_WORKFLOW_ROLE = "worker"` (change log 3) |
| 23 | Worktree/safety at launch: runtime workspace `shared` + `worktreePolicy: never` (the engine manages worktrees) | 3157-3160 | `task-backend.ts`, plus the new R#5 gate `assertWorktreeEnforced` |
| 24 | Prepared launch: resource policy seal, tool providers, artifact binding seal + drift check before launch | 6406-6416, 6623-6701, 6756-6774 | `task-backend.ts` (`prepareSubagentTaskLaunch`; binding = manifest + `artifact-access.json` + MCP server spec) |
| 25 | Worker system prompt (effective tool policy, output contract) | 7371-7450 | `task-backend.ts` ("You are workflow subagent …") |
| 26 | Artifact copies and safety: hard-link/copy of runtime logs, safe relative paths inside the runs dir, failed tool-call summaries (20 max) | 175, 6394-6400, 7038-7240 | `task-artifacts.ts` |
| 27 | Runtime runs directory per task | 162, 7364-7370 | `task-artifacts.ts`: `.agent-workflow/workflow-subagents/<run>/<task>` |
| 28 | One-shot call for the auto router | 535-558 | `task-backend.ts` (`runOneShotSubagentCall`) |
| 29 | pi-subagent API seam (`@agwab/pi-subagent/api` import, `setSubagentApiForTests`) | 263-533 | `runtime-port.ts` (static `../runtime/api.js`, `setTaskRuntimeApiForTests`) |

**Pi executor (WP6)** — Pi launch code that is not ported:

| Pi-specific code | Source lines |
|---|---|
| Extension isolation probe (`supportsExplicitExtensionIsolation`, `noExtensions`) | 552-563, 3214-3215, 6627 |
| Extension preflight (`assertSubagentExtensionsLoadable`, imports `@earendil-works/pi-coding-agent`) | 564-618, 3217-3218 |
| Pi agent option `skills: []` when skill discovery is disabled (core maps the sealed policy to `SubmitRequest.isolation`) | 3206-3209 |
| `toolResultBudget` launch option to the Pi child | 3219-3223 |
| Native-host extension wrapper (host-tool inheritance; core keeps `hostContext` and provenance fails closed for other executors) | 237-240, 6583-6599 |
| Fast-mode extension wrapper (core keeps `fast-tier.ts` config) | 241-244, 6603-6621 |
| Provider extension resolution for tool providers with `extensions` (`TOOL_PROVIDER_EXTENSIONS`, `bundledNodeModulePath`, `resolvePreparedToolProviders`, `resolveProviderExtensionRef`, `providerExtensionsForTools`) | 215-216, 245-262, 6833-6892, 6996-7024 |
| Extra extensions env `PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS` | 163, 7025-7033 |

**Dropped** (with reason):

| Code | Source lines | Reason |
|---|---|---|
| `auth.json` read (`workflowAuthFile`, `providerAuthType`, `PI_WORKFLOW_AUTH_FILE`) | 214, 6014-6034 | R#12/D1: the engine never reads credential stores; conservative backoff + probe hook instead |
| Fetch-content cache wrapper and its env (`PI_WORKFLOW_FETCH_CONTENT_CACHE`, `…_INLINE_CHARS`, legacy `PI_WORKFLOW_FETCH_CACHE`) | 165-168, 229-232, 6448-6500, 6775-6781, 6975-6995 | C2: built-in CLI web tools; `workflow_web_*` removed in WP10 |
| Web-source wrapper, pi-web-access/code-search provider resolution and passthrough tools | 217-228, 233-236, 6418-6426, 6502-6578, 6702-6755, 6782-6832, 6893-6974 | C2 (same) |
| `uniqueStrings` helper | 7034-7037 | only used by dropped extension code |

Counts: 29 policies moved (one, #20, with enforcement left to the Pi executor), 8 Pi executor (WP6)
items, 4 dropped items.

### Executor selection

- `executor-registry.ts` maps executor ids to `ExecutorDescriptor`s. The built-ins `pi`, `codex`, `claude`
  are known but unavailable until WP6/WP7/WP8 register their adapters. Tests register descriptors with
  `registerWorkflowExecutor(descriptor)`.
- Precedence (B2): run flag `WorkflowRunOptions.executor` > workflow-declared profile (new spec field
  `executionProfileExecutors: { <declared profile>: <executor id> }`, used when `executionProfile` names
  that profile) > saved user profile (`WorkflowCapturedExecutionProfile.executor`) > default
  (`WorkflowRunOptions.defaultExecutor`, else `"pi"`).
- `runLoadedWorkflowSpec` resolves the selection before the run record exists. An unknown or unavailable
  executor throws `WorkflowExecutorUnavailableError` naming the executor and its source (for example
  `executor "codex" from workflow execution profile "fast" is unavailable: …`). The run is not created and
  nothing launches. A lower tier is never tried as a fallback.
- The selection `{id, source, profile?, descriptor}` is frozen as `run.executor`. Nested runs copy the
  parent's. The backend launches with that recorded descriptor; the durable worker reloads the adapter
  from `descriptor.module`. A run without a selection (created directly through the store, or an imported
  record) gets the default tier at its first launch, which must itself be available.

### attemptKey

`awf1:<workflowRunId>:<taskId>:<16 hex>`. The hex is the first 16 characters of SHA-256 over the launch
authority's attempt identity, `launch-retry:N;output-retry:N;resume:N[;physical:N];session:<id|none>`
(`launch-session.ts`). The key is stable for one task attempt: re-entering the launch for the same attempt
(stale claim, ack timeout) reuses it, so an idempotent executor returns the existing ExecRef. Every launch
retry, output repair, resume or foreach physical attempt changes the identity and therefore the key. The key
is passed as `RunSubagentOptions.attemptKey` and reaches `SubmitRequest.attemptKey`.

### SubmitRequest mapping

| SubmitRequest field | From |
|---|---|
| `prompt`, `systemPrompt` | compiled prompt; `buildSystemPrompt` |
| `model`, `effort` | `runtime.model`; `runtime.thinking` (passed verbatim) |
| `tools` | effective launch tools (Pi vocabulary); an unspecified list is `read, bash, edit, write` (`DEFAULT_WORKER_TOOLS`, what Pi used by default) |
| `readOnly` | `safety.capability === "read-only"` |
| `isolation` | `{inherit: true}` only when the stage/agent sets `inheritProjectContext` or `inheritSkills` (B5) |
| `env` | `{AGENT_WORKFLOW_ROLE: "worker"}` |
| `approvalPolicy` | `allowKinds` = ACP kinds of the stage's tools (`PI_TOOL_KINDS`), minus mutating kinds for read-only tasks; `interactive: false` |
| `mcpServers` | `toolProviders[*].mcpServer` (WP4b), checked against the sealed artifact binding's server spec |
| `artifactsDir`, `cwd`, `deadlineMs` | runtime (attempt dir, `task.cwd`, `maxRuntimeMs`) |

`inheritHostTools` and `allowSharedCheckoutWrites` are new `WorkflowRunOptions` passed to `compileWorkflow`;
nested runs take them from the parent run record.

### Reconcile mapping (B3)

- Runtime `failed/needs_decision` (executor reconcile `unknown` or unprovable) → the task becomes
  `blocked` with statusDetail `executor_needs_decision`, `result.json` records `failureKind: needs_decision`,
  and the run status becomes `blocked`. The run is an eligible notice (`notices list`). Nothing retries,
  relaunches or falls back; a foreach batch leader stops the batch with both members blocked instead of
  falling back to per-item launches. The owner decides: an explicit `resume` relaunches with a new attempt
  key (`executor_needs_decision` is a resumable blocked detail), `stop` abandons it.
- Runtime `failed/not_started` (reconcile `absent`) → eligible for the normal transient retry policy
  (new launch attempt, new key, retry limit and backoff apply).
- `transient`, `rate_limit` → retry policy (rate limit with backoff). `executor_auth`, `executor_config`,
  `executor_permanent`, `executor_unknown`, `guard_failure` → failed, no retry. `revoked` → interrupted.

### R#9, R#10, R#12, R#5

- **R#9 groundwork:** `WorkflowArtifactReadLedgerRecord.deliveryUnverified?: true` is preserved by the
  ledger reader (a non-boolean value fails the ledger closed). `checkRequiredArtifactReads` ignores such
  rows for required reads and projection policies. WP5 writes them.
- **R#10 / D3:** the runtime records the adapter's `ownedSession` in `result.json`
  `metadata.executor.ownedSession` (additive runtime change). The terminal mapping copies it to
  `task.ownedSessions[]` (`executorId, kind, locator, backendRunId, backendAttemptId`). `pruneWorkflowRuns`
  (`deleteOwnedSessions` default true) loads the run's executor and calls the new optional
  `WorkflowExecutor.deleteOwnedSession(locator)` for exactly those locators, before the run is removed. A
  refusal or error keeps the run (protected, with the error). An executor without the method is counted as
  `unsupported`. A session recorded for another executor id is refused.
- **R#12:** see policy row 8.
- **R#5:** `engine.ts` 2860 (foreach batch eligibility) now applies the same tool policy as
  `prepareDagTask` (`inheritHostTools`, `allowSharedCheckoutWrites` from the run), so a mutation-capable
  task can never join a shared-cwd batch. 5418 only labels a failure (`worktree_failed`); no bypass.
  `applyExistingLoopWorktree` clears `requiresWorktree` only after moving the task into the loop's managed
  worktree. As a last gate, `launchSubagentTask` refuses (fatal, before any effect) a task whose safety
  requires a worktree unless `task.cwd` is its recorded managed worktree path.

### Paths, env and literals

| Before | After | Where |
|---|---|---|
| `.pi/workflow-subagents/<run>/<task>` | `.agent-workflow/workflow-subagents/<run>/<task>` | task-artifacts |
| `.pi/workflows/auto-router-runs` | `.agent-workflow/workflows/auto-router-runs` | workflow-router |
| `~/.pi/agent/model-rate-limit-backoff.json` | `$AGENT_WORKFLOW_HOME/model-rate-limit-backoff.json` | retry-policy |
| `PI_WORKFLOW_ROLE_ENV` (process env scoping) | `AGENT_WORKFLOW_ROLE_ENV` in `SubmitRequest.env` | task-backend |
| `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES`, `…_MAX_LIVE_MODEL_WORKERS`, `…_ADAPTIVE_LIVE_WORKERS`, `…_LAUNCH_SLOT_RELEASE_DELAY_MS` | `AGENT_WORKFLOW_…` | launch-slots |
| `PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES`, `…_ARTIFACT_OUTPUT_RETRIES` | `AGENT_WORKFLOW_…` | retry-policy |
| `PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS` | `AGENT_WORKFLOW_…` | task-observability |
| `PI_WORKFLOW_PARENT_SUBAGENT_{CWD,RUNS_DIR,RUN_ID,ATTEMPT_ID}` | `AGENT_WORKFLOW_PARENT_SUBAGENT_…` | parent-child-events |
| `PI_WORKFLOW_CAPTURE_TOOL_CALLS` | `AGENT_WORKFLOW_CAPTURE_TOOL_CALLS` | task-backend |
| backend id `pi-subagent/headless` | `agent-workflow/runtime` | launch authority / provenance |
| task handle `{engine: "pi-subagent", backend: "headless"}` | `{engine: "agent-workflow", backend: "runtime"}` | task-artifacts |
| worktree branch `pi-workflow/<run>-<task>` | `agent-workflow/<run>-<task>` | worktree |
| worker session ids `pi-workflow.<run>.<task>`, `piwf.<digest>` | `agent-workflow.<run>.<task>`, `awf.<digest>` | launch-session |
| usage/budget record `source: "pi-subagent"` | `"executor"` (type accepts both) | task-observability, types |
| messages "pi-subagent …", "child Pi …", "You are Pi workflow subagent" | "executor …", "You are workflow subagent" | task-backend, terminal-result |

Kept on purpose (stored-format or wire identifiers; renaming them is a format change, not a port):
`pi-workflow-*-v1/v2` schema ids (launch, launch authority, provenance, auto binding, dynamic state/events,
state root, capabilities, release/cancellation digests, auto comparison), `issuer: "pi-workflow-engine"`,
timing/budget sources `pi-workflow`, `pi-workflow-launch`, `pi-workflow-budget-disabled`, the
`pi-subagent-durable-launch-barrier-*` wire schemas (runtime), and `backend: {type: "local-pi", mode:
"headless"}` in run/compiled records (F5; it now names the runtime-API task backend). No old `PI_WORKFLOW_*`
name is read as a fallback.

### Module table (WP4c-1)

| Source | Destination | Status |
|---|---|---|
| `src/engine.ts` | `src/core/engine.ts` | ported-adapted: backend registration, executor selection, `inheritHostTools`/`allowSharedCheckoutWrites` options, host context via `withHostContext`, R#5 batch eligibility |
| `src/subagent-backend.ts` | 13 modules (table above) + `runtime-port.ts` | decomposed |
| `src/backend.ts` (remaining part) | `src/core/task-backend.ts` (`workflowTaskBackend`, fatal wrapper, registration) | ported |
| `src/workflow-router.ts` | `src/core/workflow-router.ts` | ported-adapted (one-shot via task backend, runs dir) |
| `src/workflow-parent-usage.ts` | `src/core/workflow-parent-usage.ts` | ported (import moved) |
| `src/index.ts` | `src/core/index.ts`, `src/index.ts` re-exports core | ported-adapted (`WORKFLOW_COMMAND`/`WORKFLOW_HELP` → Pi host, WP11b) |
| — | `src/core/executor-registry.ts` | new |

Other core files touched: `types.ts` (run.executor, executionProfileExecutors, ownedSessions, source
literal), `artifact-graph-schema.ts`, `store.ts` (resumable `executor_needs_decision`),
`workflow-notices.ts`, `workflow-artifact-tool.ts`, `run-retention.ts`, `launch-session.ts`,
`worktree.ts`. Each header names the change.

### SDK and runtime changes (additive, own commit)

- `src/sdk/contract.ts`: optional `WorkflowExecutor.deleteOwnedSession?(session)` returning
  `"deleted" | "not_found" | "refused"`, plus `OwnedSessionLocator` / `DeleteOwnedSessionResult`.
  `assertWorkflowExecutor` does not require it.
- `src/runtime/artifacts/result.ts` + `orchestrate/execute.ts`: `ResultExecutorMetadata.ownedSession`
  records the terminal event's `ownedSession`.
- `test/unit/core-import-isolation.test.mjs` now also allows `../sdk/*.js` and `../runtime/*.js` imports
  from core (both Pi-free, same `dist/` tree); the temp-copy import of every `dist/core/*.js` without
  `node_modules` still runs.

### WP4c-1 change log (behavior-relevant)

1. Tasks launch through the runtime API with the run's recorded executor descriptor; pi-subagent and Pi
   launch options are gone (Pi pieces → WP6).
2. A run without an available executor is refused before it is created (`WorkflowExecutorUnavailableError`);
   the default executor `pi` is unavailable until WP6.
3. The worker role is passed as `SubmitRequest.env.AGENT_WORKFLOW_ROLE` instead of mutating the engine's
   process env around the launch.
4. Runtime `needs_decision` blocks the task and run (statusDetail `executor_needs_decision`, notice,
   resumable by a person); `not_started`, `transient` and `rate_limit` join the transient retry policy.
5. Rate-limit backoff no longer reads `auth.json`; an unknown auth kind uses the long (OAuth) profile.
6. Unspecified task tools launch as `read, bash, edit, write` (explicit list required by the SDK).
7. Required reads ignore `deliveryUnverified` ledger rows.
8. Pruning deletes engine-owned worker sessions first and keeps the run if that fails.
9. Backend gate: a worktree-requiring task never launches outside its managed worktree.
10. Renames in the table above (paths, env, ids, session ids, worktree branch, messages).
11. Spec field `executionProfileExecutors` and run option `executor` / `defaultExecutor` are new.

### WP4c-1 tests

- `core-wp4c1-engine-runtime.test.mjs` (9 tests): end-to-end two-stage run (stage `b` requires
  `a.control`; the fixture executor performs the read through the task's `artifact-access.json`, standing
  in for the WP5 server) through engine → task backend → runtime durable worker → fixture executor, ending
  with a completed `run.json` under `.agent-workflow/workflows/`, then pruning deletes exactly the owned
  sessions; stop during stage 1 revokes the barrier (worker consume → `revoked`, no effect);
  `needs_decision` blocks run and task with a notice and no retry; `not_started` retries with a new key;
  unknown/unavailable executor fails before launch; precedence; `deliveryUnverified`; attemptKey; request
  mapping and the R#5 gate.
- Helpers: `test/helpers/workflow-executor-fixture.mjs` (descriptor module over the SDK fake executor,
  JSONL effect log), `register-default-executor.mjs` (registers that fixture as `pi` for ported tests that
  start runs without naming an executor), `workflow-artifact-fixture.mjs`, `raw-host-fixture.mjs` (ported).
- Ported pi-workflow tests: see the decision table (`ported-WP4c1`). Header changes are listed in each file.
- `core-prompt-schema-reliability` and `core-wb-016-scheduler-performance` got back the source-scan test
  WP4b dropped; it now reads `src/core/engine.ts` / `src/core/task-backend.ts`.

### For later WPs

- **WP4c-2:** port `unit-test-support.mjs` (its fake SubagentApi plugs into `setTaskRuntimeApiForTests`;
  the injected API may omit the barrier functions, as before) and the 15 tests marked `deferred (WP4c-2)`.
  Runs created with `createRunRecord` get the default executor at first launch, so register a descriptor
  as `pi` (see `register-default-executor.mjs`). Done in WP4c-2 (below).
- **WP1b:** replay compares the renamed literals above (session ids, worktree branch, handle, backend id,
  record sources); add them to the allowed-difference list.
- **WP5:** write `deliveryUnverified: true` ledger rows when delivery cannot be verified.
- **WP6:** the Pi rows above; register the `pi` descriptor; report the auth kind through
  `setExecutorAuthKindProbe`; implement `deleteOwnedSession` for kept sessions; honor
  `runtime.inheritHostTools` with the native-host wrapper (provenance requires it).
- **WP11a/WP11b:** expose `--executor`; move `WORKFLOW_HELP` into the Pi host.

## WP4c-2 — test harness, deferred engine tests, ledger no-follow

### Read-ledger no-follow (security fix, own commit)

WP5 found that `appendWorkflowArtifactReadLedger` (`src/core/workflow-artifact-tool.ts`) used
`mkdir -p` + `appendFile` on the ledger path, so a planted symlink at `<task dir>/read-ledger.jsonl`
redirected every evidence row to a file outside the run directory (and a dangling link created it).

- Red (before the fix, `dist/` of `2bfb744`): a symlink `read-ledger.jsonl → <tmp>/victim.txt` and one
  `handleWorkflowArtifactToolCall` read returned normally and `victim.txt` became
  `"original\n{"schema":"workflow-artifact-read-v1",…}\n"`. All 8 tests of
  `core-workflow-artifact-ledger-nofollow.test.mjs` failed (missing rejections, mode `0644`, no hook).
- Green: the same call rejects with `read ledger must not be a symlink` and `victim.txt` stays
  `"original\n"`; 8/8 pass.

The fix (`openReadLedger`):

- `lstat` the parent directory (refused when it is a symlink or not a directory) and the ledger
  (refused when it is a symlink, not a regular file, or hard-linked `nlink > 1`).
- `open` with `O_NOFOLLOW | O_NONBLOCK` where the platform has them (`ELOOP`/`EMLINK` → symlink error,
  `ENXIO` from a FIFO → not a regular file), mode `0600` on create.
- After the open, `fstat` the handle and `lstat` the path and parent again: same `dev`/`ino` for the file
  and the parent, else `read ledger changed while it was opened`.
- One `O_APPEND` write per row (the loop only continues a short write), so concurrent appends keep rows
  whole.
- `readWorkflowArtifactReadLedger` uses the same open (read-only): a symlinked ledger is never read as
  required-read evidence; a missing ledger or task directory is still `[]`.

Other write paths in the file: none. The manifest and artifacts are only read (artifacts already open
with `O_NOFOLLOW` and a raw-owner check), and the dedup/completed-read caches are in-memory `Map`s with no
projection or cache file. Residual: the parent check cannot use `openat` from Node, so a parent swapped
to a symlink and back between the two `lstat`s is only caught when the inode differs; the ancestors above
the task directory are not checked (the MCP server's `assertLedgerTarget` checks run-dir containment).

**Hook for the MCP server.** `handleWorkflowArtifactToolCall(params, config, options?)` takes
`{onLedgerRecord?(row), appendLedger?: boolean}`. `onLedgerRecord` receives each read row (after the
append by default); `appendLedger: false` skips the append so the host persists the row itself. The
result shape is unchanged. **Follow-up (WP5, not done here; `src/mcp/**` untouched):** replace the
server's scratch ledger (`service.ts` `scratchLedger` + re-read) with
`{appendLedger: false, onLedgerRecord}` and append the (possibly `deliveryUnverified`) row with
`appendWorkflowArtifactReadLedger`.

### Harness (`test/helpers/unit-test-support.mjs`)

Ported from pi-workflow `test/unit/unit-test-support.mjs`; same fixtures and helpers, same semantics:

- Imports `dist/core/*`. The former `subagent-backend.js` names come from their WP4c-1 modules
  (`retry-policy`, `required-reads`, `task-cancellation`, `task-backend`, `launch-slots`, `runtime-port`).
- The fake SubagentApi is injected with `setTaskRuntimeApiForTests` (was `setSubagentApiForTests`); the
  fakes keep the pi-subagent shapes the runtime kept (`runSubagent`/`getSubagentStatus`/
  `reconcileSubagentRun`/`interruptSubagent`) and still omit the barrier functions.
- Imports `register-default-executor.mjs`, so runs created with `createWorkflowRunRecord` resolve the
  default executor `pi` (fixture until WP6).
- The per-file temp `HOME` now also sets `AGENT_WORKFLOW_HOME` and `PI_CODING_AGENT_DIR` under it.
- Renames: `.pi/{workflows,agents,workflow-subagents}` → `.agent-workflow/…`, `PI_WORKFLOW_*` env →
  `AGENT_WORKFLOW_*`, backend handle `{engine: "agent-workflow", backend: "runtime"}`, display
  `agent-workflow/runtime …`.
- Dropped with their re-exports (Pi-only modules): `extension.js` (natural-language tools, arg parsing,
  feedback/notice delivery), `workflow-view.js` and the `workflowViewFixture`/`workflowViewText`
  fixtures, `workflow-artifact-extension.js`, `workflow-fetch-cache-extension.js`, `workflow-web-source*.js`.
  None of the 15 ported files needs them except the 4 unit-dynamic-runtime tests below.
- New helper `test/helpers/workflow-fixture-lifecycle.mjs` (ported, imports only).

### WP4c-2 tests

All 15 `deferred (WP4c-2)` files are ported as `test/unit/core-<name>.test.mjs` (363 node:test tests,
subtests included; plus 8 in `core-workflow-artifact-ledger-nofollow.test.mjs`). Each header lists its
changes. Beyond the mechanical renames above, only these assertions changed:

| File | Change | Reason |
|---|---|---|
| graph-schema-contracts | schema walk over `test/fixtures/core/workflow-guide-scaffolds` with `count >= 7` (was `workflows/` + `skills/workflow-guide/scaffolds`, `count > 20`) | bundled workflows arrive in WP10 (that half deferred (WP10)); the scaffolds are the WP4b fixture copy |
| unit-dynamic-runtime | `launched[0].effort === "low"` (was `.thinking`) | runtime API maps `thinking` → `effort` (docs/runtime-port.md) |
| unit-dynamic-runtime | `captured[1].toolResultBudget === undefined`, plus the task's launch attempt records `configuredMaxTotalChars: 320000` (was the launch option `{maxTotalChars: 320000}`) | policy row 20: the Pi launch option is not part of the runtime API; enforcement deferred (WP6) |
| unit-dynamic-runtime | message `incompatible or stale agent-workflow engine: …` (was `pi-workflow engine`) | engine message renamed in WP4c-1 |
| unit-dynamic-runtime | built-dist child imports `dist/core/*` and registers the default fixture executor | dist layout; executor resolution at first launch |

Tests not ported (marked in place with a comment), all from unit-dynamic-runtime:

- dropped (C2/WP10, `workflow_web_*` and the fetch cache are removed): "subagent launch uses generated
  fetch cache extension by default", "subagent launch wires normalized workflow web-source tools through
  generated extension".
- deferred (WP6) (Pi extension host; resolved in WP38: superseded / not applicable, see "WP38"): "workflow_dynamic tool starts spec-less direct dynamic runs" (Pi
  `ExtensionAPI` tool registration), "workflow_artifact generated extension wrapper embeds config without
  prompt-visible paths" (Pi wrapper; core uses `artifact-access.json` + the WP5 MCP server).

Observed: "spec-less direct dynamic run …" still asserts the `workflow_web_*` tools of the bundled
direct-dynamic spec (WP4a note: changing that spec needs a new `DIRECT_DYNAMIC_RUNTIME_VERSION`, WP10). WP10 did that (v5); the assertion now expects `web_search`/`fetch_content`.

### WP4c-2 change log (behavior-relevant)

1. The core read ledger refuses a symlinked/hard-linked/non-regular ledger or a symlinked ledger
   directory, for appends and for reads (required reads then fail closed), and creates it `0600`.
2. `handleWorkflowArtifactToolCall` has an optional third `options` argument (ledger hook).

## WP4d — capability negotiation before launch

B4 negotiation (`src/sdk/requirements.ts`) was implemented in WP3 but nothing in `src/core` called it:
any executor ran any stage with no refusal, degradation record or preview. WP4d wires it into the engine
(`src/core/capability-negotiation.ts`, called from `runLoadedWorkflowSpecInNativeHostScope` in
`engine.ts` and from `launchSubagentTask` in `task-backend.ts`).

### Where it runs

1. **Probe once per run (no model turn).** After executor selection (B2) and compile, before the run
   record exists: `loadExecutor(descriptor)` → `capabilities()` + `probe()`, bounded by
   `executorProbeTimeoutMs` (default 30 s), then `mergeProbedCapabilities`. Not installed →
   `EXECUTOR_NOT_INSTALLED`; auth `missing`/`expired` → `EXECUTOR_AUTH_NOT_READY` naming the CLI login
   command (`codex login`, `claude auth login`, `pi` + `/login`); timeout or load error →
   `EXECUTOR_PROBE_FAILED`. `auth: "unknown"` proceeds and is recorded (Pi cannot report auth without
   `config.authCheckModel`). Injectable with run option `executorProber`.
2. **Per-stage negotiation.** Every compiled executor task (not support helpers, loop placeholders or
   dynamic controllers) plus loop child/exhaustion templates. `workflowTaskRequirementContext` mirrors the
   SubmitRequest: `readOnly` = `safety.capability === "read-only"`; `tools` = `runtime.tools`;
   `hasRequiredReads` = `artifactGraph.requiredReads`; `mcpInjection` also required for artifact access
   or an MCP tool provider; B5 `inherit` = `inheritProjectContext || inheritSkills`; web tools inferred
   from the tool list; `partialStream` for partial-output stages; `sameSessionRepair` for artifact-graph
   tasks; `fastTier` when `fast: on`; `wantsCost` always; `allowReadOnlyDowngrade`, `allowUnverified`,
   `strict`, `interactive` from the run policy below. No tool mapping is passed (the contract has no
   mapping accessor; adapters refuse unmapped tools at submit).
3. **Refusal** (any stage) → `WorkflowCapabilityError` `CAPABILITY_REFUSED` before any run record or
   launch. The message lists stage (compiled task id), capability, code, what the executor has, and how
   to opt in: `allowUnverifiedCapabilities` for `CAPABILITY_UNVERIFIED`, spec `allowReadOnlyDowngrade`
   for `toolAllowlist.fine`/unmapped tools, the profile's `strictCapabilities` for `CAPABILITY_STRICT`,
   B5 `inherit` for `contextIsolation`; otherwise "no opt-in exists".
4. **Degradations** → preview + record. Run option `interactive: true` makes the report
   `needsConfirmation`; the engine then calls `confirmDegradations(preview)` once. Anything but `true`
   → `CAPABILITY_DEGRADATION_DECLINED`; an interactive run without the hook →
   `CAPABILITY_CONFIRMATION_REQUIRED` (fail closed). Non-interactive (default) never calls the hook,
   records `confirmation: "non-interactive"` and proceeds.
5. **Record.** `run.capabilityNegotiation` (schema `agent-workflow-capability-negotiation-v1`):
   executor id/version, contract version, probe summary (`installed`, `cliVersion`, `auth` enum, notes,
   `probedAt`; no secrets), effective capabilities, policy, confirmation, per-stage `NegotiationReport`s,
   degradations, `forcedReadOnly` stages and the `buildCapabilityPreview` text. The run-start API
   (`runWorkflowSpec`/`runDynamicTask`) returns the record, so hosts read
   `run.capabilityNegotiation.preview`.
6. **Launch.** `launchSubagentTask` calls `workflowTaskCapabilityLaunch(run, compiledTask)` before any
   effect: it re-derives the report from the recorded capabilities and policy (non-interactive), so a
   refusal is a fatal task result before launch and `forcedReadOnly` sets `SubmitRequest.readOnly` and
   removes mutating kinds from the approval policy. Runtime-generated tasks (foreach items, dynamic
   workers) not negotiated before launch are appended with `negotiatedAt: "launch"`. Records without
   `capabilityNegotiation` (created before WP4d, or directly through the store) are not checked.
7. **Nested runs** reuse the parent's probe (`reusedFromRunId`), `allowUnverified` and `strict`, and are
   never interactive.
8. **Mixed runs (WP31, Q4).** A role profile can assign stages to several executors
   (`role-execution.ts`). Each other executor is probed once (`negotiateWorkflowRun` input
   `executors`), each task template is negotiated against `task.runtime.executor`, the preview's
   summary names every executor, refusals name the stage and its executor, and role models are
   checked against the probe's model list (`MODEL_UNKNOWN` only when the probe declares the list
   exhaustive, `ExecutorProbe.modelListComplete` — none of the built-in adapters; a partial list (Pi
   registry with pattern resolution, Claude aliases, Codex visible catalog) or no list adds a "not
   verified" notice).
   The record keeps the run executor's probe/capabilities at the top level and the others in
   `executors.<id>`; `workflowTaskCapabilityLaunch` uses the task's executor. Single-executor runs
   take none of these paths (record unchanged).

### Run options and spec fields (new)

| Name | Kind | Meaning |
|---|---|---|
| `interactive` | run option | host can ask the user (default false) |
| `confirmDegradations(preview)` | run option | B4 confirmation hook; only when interactive and degraded |
| `allowUnverifiedCapabilities: string[]` | run option | user opt-in for `unverified` rows (never a spec field) |
| `executorProber`, `executorProbeTimeoutMs` | run options | probe seam and bound |
| `allowReadOnlyDowngrade: boolean` | spec, top level | B4: no precise allowlist / unmapped tool → run readOnly instead of refusing |
| `executionProfileStrictCapabilities: { <declared profile>: [<capability>] }` | spec, top level | profile strictness for declared profiles |
| `strictCapabilities: string[]` | saved user profile (`WorkflowCapturedExecutionProfile`) | profile strictness for user profiles |

**Profile strictness.** A profile's `strictCapabilities` (capability names, optionally `name.detail`)
is passed as `ctx.strict`: a listed capability that the stage requires but would only get `emulated` or
`degraded` is refused with `CAPABILITY_STRICT:<key>`. A name covers its qualified keys
(`toolAllowlist` covers `toolAllowlist.fine`). Unknown names fail spec validation (declared) or the run
start (saved profile). Example: `"executionProfileStrictCapabilities": { "audit": ["readOnly",
"contextIsolation"] }` refuses Codex for `audit` when `~/.codex/rules` has allow rules or a global
`AGENTS.md` exists.

### SDK additions (additive, own commit)

- `Level.warning?: string` (validated as a string). An outcome satisfied only at `emulated` whose
  observed level carries a non-empty warning is a degradation `CAPABILITY_WARNING:<key>` with the warning
  as note (`needsConfirmation` when interactive). Emulated without a warning stays silent (Pi's
  allowlist-based readOnly). `observed.warning` is copied into the entry.
- `StageRequirementContext.strict` (above).
- `buildCapabilityPreview(stages, {executor, header})` → `{accepted, needsConfirmation, refusals,
  degradations, forcedReadOnly, text}` with stage-labelled codes.

### WP4d change log (behavior-relevant)

1. Every new run probes its executor once before it is created (version/auth/status commands only) and
   fails before launch when the CLI is missing, logged out, or the probe hangs.
2. A stage the executor cannot honor (B4/B5 defaults, unverified without opt-in, strict) refuses the
   whole run before any run record or launch.
3. Degraded runs record `run.capabilityNegotiation` and a preview; interactive hosts must confirm.
4. `forcedReadOnly` stages launch with `readOnly: true` and no mutating approval kinds.
5. Spec fields `allowReadOnlyDowngrade`, `executionProfileStrictCapabilities`; profile field
   `strictCapabilities`; run options in the table above.
6. A runtime-generated task the executor cannot honor fails before its launch (fatal task result).

### WP4d tests

- `sdk-negotiation-warnings.test.mjs` (8): warning validation/merge, warning → degradation and
  `needsConfirmation`, silent emulated, native/empty warning, strict (emulated, warning, engine-emulated,
  readOnly downgrade, unknown key, non-required key), `buildCapabilityPreview`.
- `core-wp4d-capability-negotiation.test.mjs` (11): engine-level with the fixture executor (capability
  table and probe now configurable through descriptor config `capabilities`/`probe`): refusal before
  launch (missing, unverified without/with opt-in, strict via declared and saved profile), spec
  validation, warning degradation + preview with a hook that is never called non-interactively, silent
  emulated on an interactive host, interactive accept/decline/missing hook, forcedReadOnly reaching the
  SubmitRequest (and the refusal without the spec flag), probe failures (not installed, expired, codex
  `missing` naming `codex login` via `executorProber`, timeout), probed rows recorded, launch-time check.
- `executor-codex-environment.test.mjs` (6): see `docs/executors/codex.md`.
- Existing suites unchanged: no existing fake needed a new capability (the `pi` fixture is the SDK fake,
  native for every row the ported tests require; no ported engine test runs web tools).

## WP4e — permission modes (`free` default, `safe` opt-in)

Owner decision "D2 개정 — 권한 모드" (2026-10-26). Full description: [`permissions.md`](permissions.md).

### Resolution (`src/core/permission-mode.ts`)

`resolveRunPermissionMode` uses the B2 precedence: run option `permissionMode` > the selected
workflow-declared profile's `executionProfilePermissionModes[<profile>]` > the saved user profile's
`permissionMode` > default `free`. An invalid value from any source throws before the compile, probe or
run record (naming the source); spec values are also checked by `validateArtifactGraphWorkflowSpec`
(`must be "free" or "safe"`, unknown profile). Nested runs take the parent's recorded mode
(`source: "parent-run"`). `workflowRunPermissionMode(run)` treats a record without a mode (created
before WP4e, or directly through the store) as `safe`.

### Where it applies

| Place | `free` | `safe` |
|---|---|---|
| `compileWorkflow` option `permissionMode` (absent = `safe`; the engine always passes it) → `classifySafety` | `requiresWorktree = on \|\| (auto && !sharedCwdSafe)` (pi-workflow); no R#5 warning; `allowSharedCheckoutWrites` ignored | R#5 as in WP4b |
| `inheritedHostToolSafety` / `prepareWorkflowTaskToolPolicy` (engine foreach eligibility, artifact-graph preparation pass `workflowRunPermissionMode(run)`) | `requiresWorktree = worktreePolicy !== "off"` (pi-workflow) | R#5 |
| `assertWorktreeEnforced` (backend gate) | unchanged: follows the compiled safety | unchanged |
| B4 negotiation (`policy.permissionMode` → `StageRequirementContext.permissionMode`) | `toolAllowlist.fine` gap and `CAPABILITY_WARNING:*` → degradation with `acceptedByFreeMode`, never refused (also not by `strictCapabilities`), no confirmation | WP4d |
| Launch (`launchSubagentTask`) | `SubmitRequest.permissionMode = workflowRunPermissionMode(run)`; readOnly still from the compiled capability / forcedReadOnly | same |
| Runtime approvals | `allow` except mutating kinds on readOnly; audited `engine-policy:free` | WP2b |

`readOnly` stages, B5 isolation and every other B4 rule are the same in both modes. A one-shot router
comparison call (`runOneShotSubagentCall`) is readOnly and sets `permissionMode: "free"` unless the
caller passes one.

### Record and preview

- `run.permissionMode = { mode, source, profile? }` (`WorkflowRunPermissionMode`), set with
  `run.executor` before the record is written.
- `run.capabilityNegotiation.policy.permissionMode`; preview first line `Capability check (<id>@<v>, <n>
  stages, permission mode: <mode>): …`; free-accepted entries show `(accepted: free mode)`.
- `confirmation` is `not-needed` (instead of `confirmed`) when an interactive run has only
  free-accepted degradations (no hook call).
- `compiled.permissionMode` when the compile option is set.

### WP4e change log (behavior-relevant)

1. **New runs default to `free`.** Write-capable stages with spec `worktreePolicy: "off"` run in the
   shared checkout; Claude workers get `--permission-mode bypassPermissions`, Codex workers
   `danger-full-access` + approvals `never` (non-readOnly stages only); approval requests that still
   arrive are allowed (`engine-policy:free`).
2. Codex (`toolAllowlist: coarse`) runs stages with tool lists without `allowReadOnlyDowngrade`; the gap
   is recorded. Codex environment warnings no longer need interactive confirmation or trip
   `strictCapabilities` in free mode.
3. Choose `safe` (run option, declared profile map `executionProfilePermissionModes`, saved profile
   `permissionMode`) for exactly the previous behavior. Records created before WP4e resume as `safe`.
4. Spec top-level field `executionProfilePermissionModes`; saved-profile field `permissionMode`; run
   option `permissionMode`.
5. SDK (additive): `SubmitRequest.permissionMode?` (absent = `safe`), `permission.ts`
   (`effectivePermissionMode`, `isUnrestricted`, defaults), `decideApproval` stage `permissionMode`,
   `StageRequirementContext.permissionMode`, `NegotiationEntry.acceptedByFreeMode`,
   `NegotiationReport.permissionMode`, `buildCapabilityPreview` option `permissionMode`. Conformance kit
   0.3.0: `permission.mode_mapping`, `harness.permissionModes`, `LaunchRecord.stdin`; the SDK fake
   records synthetic launch settings (`FAKE_PERMISSION_MODE_SETTINGS`).
6. Runtime: run input `permissionMode` (validated, plan/`executor.json`), `ApprovalDecider`
   `engine-policy:free`.

### WP4e tests

- New: `core-wp4e-permission-mode.test.mjs` (7: default free on record/preview/SubmitRequest, precedence
  over all four sources, invalid values before any run, free coarse-allowlist + warning degradation with
  no hook call and shared-checkout `off`, compile R#5 only in safe, free approvals audited
  `engine-policy:free` vs safe, runtime input validation), `sdk-permission-mode.test.mjs` (6), conformance
  negative (adapter ignoring the mode; free unlocking readOnly).
- Existing tests now set `permissionMode: "safe"` explicitly where they pin safe behavior (no assertion
  weakened): `core-wp4b-seeds` (R#5 compile tests, inherited host tools), `core-wp4d-capability-negotiation`
  (warning degradation preview — first line now ends `, permission mode: safe)` —, interactive
  confirmation, forcedReadOnly/coarse refusal), `runtime-execute` (readOnly policy deny),
  `runtime-control-channel` (host/default-timeout/engine-policy approvals), `executor-claude-argv`,
  `executor-codex-config` (safe and absent). `conformance-stubs`: launches include stdin.

## Tests (WP4a)

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
3. A test is `deferred (WP5+)` when it needs bundled workflows (WP10), `cli.mjs` (WP11a), Pi host or extension
   modules, or Pi packages.
4. A test is `deferred (WP4c)` when it needs `engine` / `subagent-backend` / `workflow-router` /
   `workflow-parent-usage` / `index` / `engine-wait`, or the `unit-test-support.mjs` harness (fake
   SubagentApi + engine).
5. Everything else is `deferred (WP4b)`.

Counts after WP4a: ported 1, deferred (WP4b) 20, deferred (WP4c) 32, deferred (WP5+) 54, dropped 33.
Counts after WP4b: ported 1, ported-WP4b 23 (the 20 deferred (WP4b) files plus prompt-schema-reliability,
wb-016-scheduler-performance and review-runtime-retention-depth, each minus the one test that needs
engine.ts or cli.mjs), deferred (WP4c) 30, deferred (WP5+) 53, dropped 33.
Counts after WP4c-1: ported 1, ported-WP4b 23 (prompt-schema-reliability and wb-016 complete again),
ported-WP4c1 14, deferred (WP4c-2) 15 (the `unit-test-support.mjs` harness), deferred (WP6) 1, deferred (WP5+) 53,
dropped 33 (140).
Counts after WP4c-2: ported 1, ported-WP4b 23, ported-WP4c1 14, ported-WP4c2 15, deferred (WP6) 1,
deferred (WP5+) 53, dropped 33 (140). No file is left at a `deferred (WP4c*)` status.
Counts after WP38 (final; no file or test is left deferred): dropped 33, ported 1, ported-WP4b 23,
ported-WP4c1 14, ported-WP4c2 15, ported-WP10 30, ported-WP10 + WP38 1, ported-WP11a 1,
ported-WP11a + WP38 3, ported-WP38 16, superseded-WP38 1, not-applicable-WP38 2 (140). Per-test
dispositions of the WP38 work: section "WP38" at the end.

| pi-workflow test | Decision | Reason |
|---|---|---|
| artifact-sidecar-settlement.test.mjs | ported-WP4b (`test/unit/core-artifact-sidecar-settlement.test.mjs`) | WP4b |
| bounded-raw-link-contract.test.mjs | ported-WP4c1 (`test/unit/core-bounded-raw-link-contract.test.mjs`) | WP4c-1; paths, default executor fixture |
| built-engine-frozen-bundle-regression.test.mjs | ported-WP38 (`test/unit/core-built-engine-frozen-bundle-regression.test.mjs`) | fixture in test/fixtures/core/built-engine-frozen-bundle; the runtime request has no `extensions` option (tool-provider extensions stay in the sealed launch); 2 of 2 tests |
| code-search-compat.test.mjs | dropped | INVENTORY: drop(Pi extension tool compat shim) |
| dag-hardening.test.mjs | ported-WP4c2 (`test/unit/core-dag-hardening.test.mjs`) | WP4c-2 harness |
| deep-research-completion-output.test.mjs | ported-WP10 (`test/unit/core-deep-research-completion-output.test.mjs`) | WP10 bundled workflows; fixture copied to test/fixtures/deep-research; 5 of 5 tests |
| deep-research-integrity-regressions.test.mjs | ported-WP10 (`test/unit/core-deep-research-integrity-regressions.test.mjs`) | WP10 bundled workflows; 14 of 14 tests |
| deep-research-live-correction.test.mjs | ported-WP10 (`test/unit/core-deep-research-live-correction.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| deep-research-optional-string-guidance.test.mjs | ported-WP10 (`test/unit/core-deep-research-optional-string-guidance.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| deep-research-reader-output.test.mjs | ported-WP10 (`test/unit/core-deep-research-reader-output.test.mjs`) | WP10 bundled workflows; 8 of 8 tests |
| deep-research-runtime-constraints.test.mjs | ported-WP10 (`test/unit/core-deep-research-runtime-constraints.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| deep-research-sanitizer-followup.test.mjs | ported-WP10 (`test/unit/core-deep-research-sanitizer-followup.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| deep-research-static-floor.test.mjs | ported-WP10 (`test/unit/core-deep-research-static-floor.test.mjs`) | WP10 bundled workflows; 3 of 3 tests |
| deep-research-synthesis-pages.test.mjs | ported-WP10 (`test/unit/core-deep-research-synthesis-pages.test.mjs`) | WP10 bundled workflows; 6 of 6 tests |
| deep-research-verifier-identity.test.mjs | ported-WP10 (`test/unit/core-deep-research-verifier-identity.test.mjs`) | WP10 bundled workflows; 3 of 3 tests |
| deep-review-d01-d10.test.mjs | ported-WP10 (`test/unit/core-deep-review-d01-d10.test.mjs`) | WP10 bundled workflows; 1 assertion changed (D09 blocks the `.agent-workflow` sidecar root); 12 of 12 tests |
| deep-review-ledger-corrective.test.mjs | ported-WP10 (`test/unit/core-deep-review-ledger-corrective.test.mjs`) | WP10 bundled workflows; OCR root `.agent-workflow/ocr-artifacts`; 7 of 7 tests |
| deep-review-source-scope.test.mjs | ported-WP10 (`test/unit/core-deep-review-source-scope.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| dependency-lock-consistency.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling; agent-workflow has its own tools/release) |
| dynamic-audit.test.mjs | ported-WP4c1 (`test/unit/core-dynamic-audit.test.mjs`) | WP4c-1; setTaskRuntimeApiForTests, default executor fixture |
| dynamic-controller-regressions.test.mjs | ported-WP4c2 (`test/unit/core-dynamic-controller-regressions.test.mjs`) | WP4c-2 harness |
| dynamic-coordination-bundle-parity.test.mjs | ported (`test/unit/core-dynamic-coordination-bundle-parity.test.mjs`) | all imports in the WP4a set |
| dynamic-coordination-projection.test.mjs | ported-WP4c2 (`test/unit/core-dynamic-coordination-projection.test.mjs`) | WP4c-2 harness |
| dynamic-coordination-replay.test.mjs | ported-WP4c2 (`test/unit/core-dynamic-coordination-replay.test.mjs`) | WP4c-2 harness |
| dynamic-fanout-requestid.test.mjs | ported-WP4b (`test/unit/core-dynamic-fanout-requestid.test.mjs`) | WP4b |
| dynamic-tool-result-budget.test.mjs | ported-WP4c2 (`test/unit/core-dynamic-tool-result-budget.test.mjs`) | WP4c-2 harness |
| engine-output-retry-dispatch.test.mjs | ported-WP4c1 (`test/unit/core-engine-output-retry-dispatch.test.mjs`) | WP4c-1; setTaskRuntimeApiForTests, default executor fixture |
| engine-refresh.test.mjs | ported-WP4c2 (`test/unit/core-engine-refresh.test.mjs`) | WP4c-2 harness |
| execution-profiles.test.mjs | ported-WP10 (`test/unit/core-execution-profiles.test.mjs`) | WP10 bundled workflows; the 2 Pi host arg parsing/profile selection tests ported in WP11a (`host-ported-cli-args`); launch capture reads `effort`; default fixture executor registered; 6 of 8 tests here |
| fast-mode.test.mjs | ported-WP38 (`test/unit/core-fast-mode.test.mjs`) | 3 of 5 tests (config, compiler/profiles/foreach, dynamic generated tasks); 2 superseded by `executor-wp35-fast-guard` (the WP35 provider-stream guard in the Pi executor's per-run extension) |
| foreach-batch-runtime.test.mjs | ported-WP38 (`test/unit/core-foreach-batch-runtime.test.mjs`) | mechanical (WP4c module names, paths, backend id); 20 of 20 tests (33 cases) |
| graph-schema-contracts.test.mjs | ported-WP4c2 (`test/unit/core-graph-schema-contracts.test.mjs`) | WP4c-2 harness; WP10 restored the bundled `workflows/` + scaffolds schema walk (`count > 20`, as the original) |
| helper-grounding-integrity.test.mjs | ported-WP10 (`test/unit/core-helper-grounding-integrity.test.mjs`) | WP10 bundled workflows; 7 of 7 tests |
| host-package-policy.test.mjs | ported-WP38 (`test/unit/core-host-package-policy.test.mjs`) | Pi packages are optional wildcard peers (not devDependencies); 2 of 2 tests |
| host-sdk-compat.test.mjs | dropped | INVENTORY: drop(Pi host package policy) |
| impact-review-enum-control-guidance.test.mjs | ported-WP10 (`test/unit/core-impact-review-enum-control-guidance.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| impact-review-impact-fixes.test.mjs | ported-WP10 (`test/unit/core-impact-review-impact-fixes.test.mjs`) | WP10 bundled workflows; 18 of 18 tests |
| launch-slot-observer.test.mjs | ported-WP4c2 (`test/unit/core-launch-slot-observer.test.mjs`) | WP4c-2 harness |
| metrics-estimate-contracts.test.mjs | ported-WP4b (`test/unit/core-metrics-estimate-contracts.test.mjs`) | WP4b; run root path |
| nested-workflow-depth-behavior.test.mjs | ported-WP4c2 (`test/unit/core-nested-workflow-depth-behavior.test.mjs`) | WP4c-2 harness |
| no-send-controls.test.mjs | ported-WP38 (`test/unit/core-no-send-controls.test.mjs`) | the "locked to pi-subagent 0.7.2" test checks the bundled runtime API (`dist/runtime/api.js`) and that pi-subagent is no dependency; 11 of 11 tests |
| normalized-provider-corrective.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| optional-output-sections.test.mjs | ported-WP4b (`test/unit/core-optional-output-sections.test.mjs`) | WP4b; run root path |
| parent-usage-retention.test.mjs | ported-WP4c1 (`test/unit/core-parent-usage-retention.test.mjs`) | WP4c-1; run root path |
| partial-output-literal-preservation.test.mjs | ported-WP4b (`test/unit/core-partial-output-literal-preservation.test.mjs`) | WP4b |
| pi-agent-dir.test.mjs | dropped | INVENTORY: drop(Pi config dir; hosts/pi only) |
| product-corrective-11.test.mjs | dropped | INVENTORY: drop(web fetch cache removed in WP10) |
| product-corrective-12.test.mjs | dropped | INVENTORY: drop(web provider removed in WP10) |
| prompt-schema-reliability.test.mjs | ported-WP4b (`test/unit/core-prompt-schema-reliability.test.mjs`) | WP4b; source-scan test restored in WP4c-1 |
| raw-artifact-read-roundtrip.test.mjs | ported-WP4c1 (`test/unit/core-raw-artifact-read-roundtrip.test.mjs`) | WP4c-1 |
| release-gates.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| release-provenance.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling; agent-workflow has its own) |
| required-artifact-read-completeness.test.mjs | ported-WP4c1 (`test/unit/core-required-artifact-read-completeness.test.mjs`) | WP4c-1 |
| review-core-fixes.test.mjs | ported-WP11a + WP38 (`host-ported-cli-args`, `test/unit/core-review-core-fixes.test.mjs`) | IR1-08/IR1-09 in WP11a; IR1-03 parent usage (4, the message_end one through the agent-workflow Pi host), IR1-04, IR1-05 in WP38; 10 of 10 tests |
| review-helper-byte-gates.test.mjs | ported-WP10 (`test/unit/core-review-helper-byte-gates.test.mjs`) | WP10 bundled workflows; 16 of 16 tests |
| review-helper-materialized.test.mjs | ported-WP10 (`test/unit/core-review-helper-materialized.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| review-runtime-refs-dns.test.mjs | dropped | INVENTORY: drop(refs URL probing is web-tool coupled) / unknown |
| review-runtime-retention-depth.test.mjs | ported-WP4b (`test/unit/core-review-runtime-retention-depth.test.mjs`) | WP4b; 1 of 15 dropped (spawns cli.mjs → WP11a) |
| run-estimates.test.mjs | ported-WP38 (`test/unit/core-run-estimates.test.mjs`) | 6 of 8 tests; the `/workflow run` duplicate guard and `duplicateRunGuardNotice` tests are superseded by the WP16 launch guard (`host-wp16-guard`) |
| run-usage-rollup.test.mjs | ported-WP4b (`test/unit/core-run-usage-rollup.test.mjs`) | WP4b |
| runtime-bundled-api-boundary.test.mjs | dropped | INVENTORY: drop(pi-subagent bundling) |
| runtime-refs-transport-boundary.test.mjs | dropped | INVENTORY: drop(web-coupled) / unknown |
| runtime-storage-boundaries.test.mjs | ported-WP4c1 (`test/unit/core-runtime-storage-boundaries.test.mjs`) | WP4c-1; state paths |
| runtime-transport-boundaries.test.mjs | dropped | INVENTORY: drop(web transport removed in WP10) |
| spec-requirement-coverage.test.mjs | ported-WP10 (`test/unit/core-spec-requirement-coverage.test.mjs`) | WP10 bundled workflows; 1 setup changed (sidecar-failure blocks `.agent-workflow`); 2 of 2 tests |
| spec-review-live-spec-correction.test.mjs | ported-WP10 (`test/unit/core-spec-review-live-spec-correction.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| store-final-review-regression.test.mjs | ported-WP4c2 (`test/unit/core-store-final-review-regression.test.mjs`) | WP4c-2 harness |
| store-lease-contention.test.mjs | ported-WP4c1 (`test/unit/core-store-lease-contention.test.mjs`) | WP4c-1; fixture in test/fixtures/core/lease-handoff |
| store-lease-handoff.test.mjs | ported-WP4b (`test/unit/core-store-lease-handoff.test.mjs`) | WP4b |
| store-lock-corrective.test.mjs | ported-WP4b (`test/unit/core-store-lock-corrective.test.mjs`) | WP4b |
| subagent-extension-preflight.test.mjs | not-applicable-WP38 | pi-subagent's extension preflight over Pi's `DefaultResourceLoader`; core passes no Pi extensions and the Pi executor launches isolated (`--no-extensions`, B5) with its own per-run extension ("Pi executor (WP6)" table: preflight not ported) |
| subagent-partial-output.test.mjs | ported-WP38 (`test/unit/core-subagent-partial-output.test.mjs`) | backend handle agent-workflow/runtime; 8 of 8 cases |
| surface-regressions.test.mjs | ported-WP11a + WP38 (`host-ported-cli-args`, `test/unit/core-surface-regressions.test.mjs`, `test/unit/host-wp38-surface-regressions.test.mjs`, `test/unit/host-wp38-board.test.mjs`) | 19 tests: 6 WP11a; 10 WP38 (parent usage 4, 8 MiB preview, formatLogs, catch-up caps 2, skipped dependent stage, board run identity); RPC board fallback superseded by `host-wp34-pi-board` "RPC and print/JSON modes keep the text behavior …"; preview disposal and hidden artifact views not applicable (the WP34 board reads `logsAction` tails, no file previews) |
| surface-rpc-readiness.test.mjs | dropped | INVENTORY: drop(Pi RPC host) |
| surface-rpc.test.mjs | dropped | INVENTORY: drop(Pi RPC host; hosts/pi e2e) |
| thinking-max.test.mjs | ported-WP38 (`test/unit/core-thinking-max.test.mjs`) | parsers from hosts/args; 3 of 3 tests |
| unit-artifact-web.test.mjs | ported-WP10 (`test/unit/core-unit-artifact-web.test.mjs`) | WP10 bundled workflows; 15 Pi-only (web-source/fetch-cache extensions, artifact extension, TUI) + 4 C2/WP10 drops; session-id and backend-handle renames; 104 of 123 tests |
| unit-authoring-interface.test.mjs | ported-WP10 (`test/unit/core-unit-authoring-interface.test.mjs`) | WP10 bundled workflows; 3 assertions changed (C2 prompt, researcher tools, agent path); 57 of 73 tests here; the 16 Pi host/TUI tests: 5 ported in WP38 (`host-wp38-authoring-interface`, `host-wp38-unfinished-notices`), 6 superseded, 5 not applicable (WP38 section) |
| unit-core-runtime.test.mjs | ported-WP10 (`test/unit/core-unit-core-runtime.test.mjs`) | WP10 bundled workflows; 3 C2 assertions changed (sanitizer, claim gate ×2), R#12 backoff, backend handle; 109 of 111 tests here, the 2 Pi TUI task-list tests ported in WP38 over the WP34 board (`host-wp38-board`) |
| unit-dynamic-runtime.test.mjs | ported-WP4c2 (`test/unit/core-unit-dynamic-runtime.test.mjs`) | WP4c-2 harness; 139 of 143 (2 dropped C2/WP10; WP38: `workflow_dynamic` tool superseded by `host-wp28-pi-waits` (`aw_dynamic`), the generated artifact-extension wrapper not applicable), 3 assertions changed; WP10 changed the web budget, direct-dynamic v5 and launched system-prompt assertions |
| unit-engine-store.test.mjs | ported-WP10 (`test/unit/core-unit-engine-store.test.mjs`) | WP10 bundled workflows; WP4c-1 literal/backoff renames; 75 of 84 tests here (WP38 added "subagent launch detaches validated options …" with runtime fields); 3 Pi host/TUI (WP38: the 2 `notifyUnfinishedRuns` tests ported as `host-wp38-unfinished-notices`, the heartbeat-lost board badge not applicable), 3 Pi extension options not applicable, 3 WP4b wrapper tamper tests not applicable |
| unit-model-task-runtime.test.mjs | ported-WP4c2 (`test/unit/core-unit-model-task-runtime.test.mjs`) | WP4c-2 harness |
| unit-nested-backend-refresh.test.mjs | ported-WP4c2 (`test/unit/core-unit-nested-backend-refresh.test.mjs`) | WP4c-2 harness |
| unit-resource-inheritance-compiler.test.mjs | ported-WP4b (`test/unit/core-unit-resource-inheritance-compiler.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| unit-resource-inheritance-recovery.test.mjs | ported-WP4c1 (`test/unit/core-unit-resource-inheritance-recovery.test.mjs`) | WP4c-1; agents path |
| unit-resource-inheritance-runtime.test.mjs | ported-WP38 (`test/unit/core-unit-resource-inheritance-runtime.test.mjs`) | launch assertions on the runtime request (`isolation.inherit`, `effort`, no kept session, no extensions); 5 of 5 tests |
| unit-resource-inheritance-sdk.test.mjs | superseded-WP38 | `executor-pi-adapter` "buildPiArgv: isolation flags, sessions, system prompt, model/thinking, tools" and `core-unit-resource-inheritance-runtime` (policy → `isolation`); its pi-subagent argv builder and Pi SDK resource loader are not part of agent-workflow |
| unit-split-contract.test.mjs | dropped | INVENTORY: drop(pi-workflow test bookkeeping) |
| unit-test-cleanup.test.mjs | ported-WP38 (`test/unit/core-unit-test-cleanup.test.mjs`) | fixture test/fixtures/core/unit-cleanup-lifecycle.mjs over the ported harness; 2 of 2 cases |
| unit-unlimited-loop.test.mjs | ported-WP4c2 (`test/unit/core-unit-unlimited-loop.test.mjs`) | WP4c-2 harness |
| unlimited-supervisor.test.mjs | ported-WP11a (`host-ported-cli-args`) | 4 of 4 tests through `superviseAction` (docs/host-api.md) |
| verification-ontology-parity.test.mjs | ported-WP10 (`test/unit/core-verification-ontology-parity.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| wb-001-web-provider-compat.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-002-json-path-hardening.test.mjs | ported-WP4b (`test/unit/core-wb-002-json-path-hardening.test.mjs`) | WP4b |
| wb-002-normalized-web-contract.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-003-package-closure.test.mjs | ported-WP38 (`test/unit/core-wb-003-package-closure.test.mjs`) | fixtures in test/fixtures/core/package-closure; 7 of 8 tests; the pi-web-access pack closure is not applicable (nothing bundled, C2) |
| wb-003-web-security.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-004-backend-lifecycle.test.mjs | ported-WP4c1 (`test/unit/core-wb-004-backend-lifecycle.test.mjs`) | WP4c-1; handle literal, setTaskRuntimeApiForTests |
| wb-005-index-durability.test.mjs | ported-WP4c1 (`test/unit/core-wb-005-index-durability.test.mjs`) | WP4c-1; run root path |
| wb-006-rate-limit-lock.test.mjs | ported-WP4c1 (`test/unit/core-wb-006-rate-limit-lock.test.mjs`) | WP4c-1; backoff file under AGENT_WORKFLOW_HOME |
| wb-007-dynamic-recovery.test.mjs | ported-WP4b (`test/unit/core-wb-007-dynamic-recovery.test.mjs`) | WP4b |
| wb-008-filesystem-security.test.mjs | ported-WP4b (`test/unit/core-wb-008-filesystem-security.test.mjs`) | WP4b |
| wb-009-workflow-policy.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| wb-012-public-contracts.test.mjs | ported-WP10 + WP38 (`test/unit/core-wb-012-public-contracts.test.mjs`) | WP10 bundled workflows; root and router assertions changed; WP38 ported the 2 docs tests and the docs/usage.md half of the root order against docs/cli.md, docs/usage.md and the CLI help; 4 of 4 tests |
| wb-014-platform-package.test.mjs | dropped | INVENTORY: drop(pi-workflow package CI) |
| wb-016-scheduler-performance.test.mjs | ported-WP4b (`test/unit/core-wb-016-scheduler-performance.test.mjs`) | WP4b; source-scan test restored in WP4c-1 |
| wb-017-artifact-index-performance.test.mjs | ported-WP4b (`test/unit/core-wb-017-artifact-index-performance.test.mjs`) | WP4b; run root path |
| wb-018-dynamic-tail-performance.test.mjs | ported-WP38 (`test/unit/core-wb-018-dynamic-tail-performance.test.mjs`) | `readFileLinesBounded` from core workflow-preview; 5 of 5 tests |
| worker-role.test.mjs | ported-WP38 (`test/unit/core-worker-role.test.mjs`) | the role reaches the executor as the request `env`; 1 of 2 tests, the extension-startup test superseded by `host-pi-extension` "worker role: no agent tools and no notices …" and `host-wp28-pi-redrive` |
| workflow-active-ui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-artifact-footprint.test.mjs | ported-WP4b (`test/unit/core-workflow-artifact-footprint.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-authoring-corrective.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-corrective.test.mjs`) | WP4b; agent path |
| workflow-authoring-gates.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-gates.test.mjs`) | WP4b; 2 of 7 dropped (cli.mjs inspect → WP11a) |
| workflow-auto-binding.test.mjs | ported-WP4b (`test/unit/core-workflow-auto-binding.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-auto-negative-boundaries.test.mjs | ported-WP4c1 (`test/unit/core-workflow-auto-negative-boundaries.test.mjs`) | WP4c-1; setTaskRuntimeApiForTests, default executor fixture |
| workflow-command-actions.test.mjs | dropped | INVENTORY: drop(Pi slash command; hosts/pi) |
| workflow-contract-findings-006-008.test.mjs | ported-WP10 (`test/unit/core-workflow-contract-findings-006-008.test.mjs`) | WP10 bundled workflows; fixture helper moved to test/helpers/impact-review-fixtures.mjs; 17 of 17 tests |
| workflow-extension-isolation.test.mjs | not-applicable-WP38 | `noExtensions` / `supportsExplicitExtensionIsolation` are pi-subagent launch options; core prepares no extensions and the Pi executor is always isolated (B5); 2 cases |
| workflow-fixture-lifecycle.test.mjs | ported-WP4c2 (`test/unit/core-workflow-fixture-lifecycle.test.mjs`) | WP4c-2 harness |
| workflow-guide-fixed-inventory.test.mjs | ported-WP4b (`test/unit/core-workflow-guide-fixed-inventory.test.mjs`) | WP4b; scaffold copied to test/fixtures/core/ |
| workflow-launch-cancellation.test.mjs | ported-WP38 + WP38b (`test/unit/core-workflow-launch-cancellation.test.mjs`, `test/unit/host-wp38b-auto-launch-cancellation.test.mjs`) | 15 of 15 cases: the run-scoped launch fence (WP38) and the 4 "fences first dispatch while durable stop publication is delayed" cases at the core level (`launchSignal`, WP38b); the other 10 `auto …` cases against `/aw auto` (WP32): Escape or session end at the final confirmation, `/aw stop` after the launch, Escape on the comparison loader (WP38b section) |
| workflow-launch-metadata.test.mjs | ported-WP4c1 (`test/unit/core-workflow-launch-metadata.test.mjs`) | WP4c-1; paths, default executor fixture |
| workflow-mtbyqwu0-security.test.mjs | ported-WP4b (`test/unit/core-workflow-mtbyqwu0-security.test.mjs`) | WP4b |
| workflow-native-boundary.test.mjs | dropped | INVENTORY: drop(Pi native host context) |
| workflow-native-cli.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-host.test.mjs | dropped | INVENTORY: drop(Pi native host) / unknown (MCP part may map to WP9) |
| workflow-native-launch.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-prompt-policy.test.mjs | ported-WP38 (`test/unit/core-workflow-native-prompt-policy.test.mjs`) | `native` = WP35 `inheritHostTools` (the executor adds the host tools); 16 of 16 cases |
| workflow-native-session.test.mjs | dropped | INVENTORY: drop(Pi native host) |
| workflow-native-tool-policy.test.mjs | dropped | INVENTORY: drop(Pi native host) / unknown |
| workflow-notice-acknowledgements.test.mjs | ported-WP11a + WP38 (`host-ported-notices`, `test/unit/host-wp38-notice-acknowledgements.test.mjs`) | 9 cases WP11a; the 5 `notifyUnfinishedRuns` cases WP38 over the Pi session-start notice (found WP38 fix 1) |
| workflow-parent-usage-topology-retry.test.mjs | dropped | INVENTORY: drop(Pi parent session usage) / unknown |
| workflow-parent-usage.test.mjs | dropped | INVENTORY: drop(Pi parent session usage) |
| workflow-profile-routing-compat.test.mjs | ported-WP4b (`test/unit/core-workflow-profile-routing-compat.test.mjs`) | WP4b; AGENT_WORKFLOW_HOME |
| workflow-profile-tui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-report-contracts.test.mjs | ported-WP10 (`test/unit/core-workflow-report-contracts.test.mjs`) | WP10 bundled workflows; 7 of 7 tests |
| workflow-router.test.mjs | ported-WP10 + WP38b (`test/unit/core-workflow-router.test.mjs`, `test/unit/host-wp38b-auto-router.test.mjs`) | WP10 bundled workflows; no Pi theme init; 30 of 31 tests: 23 here, the 7 `/workflow auto` slash-capture/TUI tests against `/aw auto` (WP32) in host-wp38b-auto-router (WP38b); "cancelling a dynamic foreground launch reclaims the created run" is not applicable (`/aw dynamic` returns at start, no foreground launch loader) |
| workflow-user-profiles.test.mjs | ported-WP10 (`test/unit/core-workflow-user-profiles.test.mjs`) | WP10 bundled workflows; settings home AGENT_WORKFLOW_HOME; 10 of 27 tests here; 2 ported in WP11a (`host-ported-cli-args`); the 15 profile UI/TUI tests: 11 superseded by `host-wp34-pi-profile-picker`, 4 not applicable (WP38 section) |
| workflow-view.test.mjs | dropped | INVENTORY: drop(Pi TUI) / port-adapted if board moves to CLI |
| workflow-wait-tool.test.mjs | ported-WP38 (`test/unit/host-wp38-workflow-wait-tool.test.mjs`) | 19 of 37 tests ported, 11 superseded, 7 not applicable (WP38 section) |

## Post-merge fixes (parent, 2026-10-26)

- `task-cancellation.ts` `interruptSubagentTask`: an interrupt result `unsupported` (runtime found no live process to signal) is no longer an immediate error when the exact attempt then reaches a terminal state within the interrupt deadline (race: a worker that saw a barrier revoke exits by itself; since WP2b the runtime skips dead cached targets). WB-004 is preserved: `unsupported` is never an acknowledgement by itself, fails exactly as before when no status API exists or the attempt does not terminate, and `unsupported` for another attempt is rejected. `interruptStatus` gains `"unsupported"`. Regression test `core-task-cancellation-unsupported.test.mjs`.
- `core-wp4c1-engine-runtime.test.mjs`: the prune step waits for the in-process supervisor to release before ageing the lease (test-only race, ~1 in 3).

## WP1b — replay acceptance against the pi-workflow recordings

WP1b replays the five WP1a recordings (`test/replay/fixtures/`) through the agent-workflow engine with the
original pi-workflow specs and compares the run records (docs/replay.md). The comparison found two product
bugs (fixed below, each with a regression test) and the intentional changes listed here; the explained
differences in `test/replay/explained-differences.json` cite these entries.

### WP1b change log (behavior-relevant)

1. **Executor exit code.** An executor attempt has no process exit code (the executor contract ends with a
   terminal event), so the runtime `result.json` records `exitCode: null` and the raw-artifact integrity
   stamp (`rawIntegrity.terminal`, `tasks[].rawArtifactIntegrity.terminal`) copies it. pi-workflow copied
   the Pi CLI exit code (`0`). The task's own `exitCode` is still derived from the task status.
2. **Executor usage contract.** Usage arrives as SDK `UsageEvent`s (`input`, `output`, `cached`, `cost`,
   `source`), summed by the runtime into `result.json` `metadata.usage` (docs/runtime-port.md "Attempt
   artifacts"). Reasoning, cache-write and total token counts and the provider/model of the attempt are
   not part of the executor event contract v0, so task usage records no longer carry `reasoningTokens`,
   `totalTokens`, `cacheCreationInputTokens`, `provider` or `model`, and `usage.attempts[].raw` is the
   runtime summary instead of Pi's usage object. The run rollup then reports those three token fields as
   absent (no task reports them) or `0` (support tasks contribute zero usage, as before). Input, output,
   cache-read tokens and cost are unchanged (with fix 4).
3. **Cost rounding.** The runtime rounds summed usage cost to 12 decimals (`summarizeUsage` in
   `src/runtime/orchestrate/execute.ts`), so a recorded `0.013680000000000001` is stored as `0.01368`.
4. **Fix: runtime usage aliases** (`src/core/task-observability.ts` `USAGE_FIELD_ALIASES`). The task usage
   reader only knew Pi's usage object (`cacheRead`, `cost.total`); the runtime summary's `cached`
   (cache-read input tokens) and `cost` (USD) were dropped, so cache-read tokens and cost vanished from task
   and run usage for every executor. `cached` → `cacheReadInputTokens` and a numeric `cost` → `costUsd` are
   now read after the existing aliases (a Pi `cost` object still resolves through `cost.total`). Test:
   `core-usage-runtime-summary.test.mjs`.
5. **Fix: READY wait stops when the provisional worker ended** (`src/core/launch-barrier-engine.ts`
   `waitForReadyUnlessWorkerEnded`; additive runtime option `waitForDurableLaunchBarrierV2Ready(descriptor,
   {signal})`). In the runtime the durable worker writes READY inside `authority.consume()`, which the
   executor calls from `submit`. An executor that refuses the request before consuming (INVALID_REQUEST,
   CAPABILITY_MISSING — no effect) ends the worker with a terminal not-started result and never writes
   READY. pi-subagent wrote READY before it started Pi, so pi-workflow never had this case; the engine kept
   waiting for READY until the barrier timeout (30–120 s per attempt) and then reported "durable launch
   barrier timed out", losing the refusal. The engine now polls the provisional attempt's status every
   200 ms while it waits; a terminal attempt without READY fails the launch at once with
   `provisional worker <run>/<attempt> ended (<status>/<failureKind>) before the durable launch barrier
   READY: <worker stderr>` (the barrier is revoked and the worker interruption acknowledged, as for any
   barrier failure). A worker that wrote READY and then ended is still settled by the READY path. Test:
   `core-launch-barrier-worker-ended.test.mjs`.
6. **Original bundled helpers and the renamed state path.** The run state moved from `.pi/workflows/` to
   `.agent-workflow/workflows/` (WP4b change log 1) with no fallback. The original pi-workflow helpers
   hard-code the old path: deep-review, impact-review, spec-review and deep-research write their report
   sidecars (`final-report.md`, `review.md`, `source-ledger.json`, `executive.md`, `audit.md`) to
   `<cwd>/.pi/workflows/<run>/tasks/<task>/`, and
   spec-review's `spec-requirement-source.mjs` reads upstream `source-manifest.json` / `control.json`
   from there. Under agent-workflow the sidecars land in that legacy directory (byte-identical to the
   recording, outside the run directory) and spec-review's evidence gate cannot read its requirement source
   (`missing_requirement_source_proof`), so the original spec-review diverges from task 6 on. Bundled
   workflows must replace the literal when they are ported (WP10). The replay shows the rest of
   spec-review matches with the one literal migrated (variant `state-path-migrated`).
7. **Original deep-research and the removed web tools (C2).** The original deep-research spec gives its
   research tasks `workflow_web_search`, `workflow_web_fetch_source` and `workflow_web_source_read`, which
   C2/WP10 removed. The spec still compiles and its plan stage runs; the Pi executor refuses tasks 11, 12,
   13 (research-questions items), 4 (normalize-claims) and 9 (final-audit) before any effect
   (`CAPABILITY_MISSING: Pi executor has no mapping for tools: workflow_web_search,
   workflow_web_fetch_source, workflow_web_source_read`), each failing at once with `launch_failed` (fix 5).
   The support stages continue with what they have, the verify-claims foreach materializes no items and
   the final render blocks, so the run ends `blocked` (recorded: `completed`). That refusal is the expected
   result; the web tools are not added back. With the adapter check off (replay variant `engine-only`)
   every task output of the recording is reproduced.

## WP10 — bundled workflows, worker prompt rendering, C2 web tools

WP10 ports the bundled workflows, skills and scaffolds and migrates them (docs/bundled-workflows.md).
The core changes it needed:

### WP10 change log (behavior-relevant)

1. **Worker prompts are rendered per executor.** `launchSubagentTask` sends
   `renderWorkerPromptToolNames(prompt, executor.id)` (`src/core/artifact-tool-names.ts`) as the
   SubmitRequest task and system prompt: the placeholder `{{workflow_artifact}}` and every bare
   `workflow_artifact` tool mention become `artifactToolVisibleName(executor.id)`
   (`mcp__workflow_artifact__workflow_artifact` for pi, codex, claude). `workflow_artifact:<id>`
   evidence locators and longer identifiers are unchanged. `task.md`, `system-prompt.md` and the launch
   provenance (`prompt.sha256`) keep the canonical text. The mapping moved from
   `src/mcp/visible-names.ts` into core (re-exported there unchanged) and all three rows are
   `verified: true` (live WP6 #4, WP7 #2, WP8 #10).
2. **Artifact tool guidelines in the system prompt.** A task with the artifact server (sealed binding,
   MCP provider or `workflow_artifact` tool) gets `# Workflow Artifact Tool` with
   `WORKFLOW_ARTIFACT_TOOL_GUIDELINES`, because Pi 1.1 does not show MCP server instructions.
3. **C2 in the engine's own text.** The system-prompt hint for the `workflow_web_*` source-card tools is
   removed; the `refsUrlValidation` hint says "Use the available web tools to open the URL" (was
   "workflow web tools to fetch/cache"). The dynamic generated-task web budget applies to
   `web_search`/`fetch_content` (was `workflow_web_*`) and says "at most 3 web_search calls".
4. **Direct-dynamic runtime bundle v5.** `DIRECT_DYNAMIC_RUNTIME_VERSION` is `direct-dynamic-runtime-v5`;
   its spec tools are `read, grep, find, ls, web_search, fetch_content` (was the three
   `workflow_web_*` tools). The module refuses to rewrite an existing versioned bundle, so the changed
   payload needed the new version; existing v4 directories are left in place and no longer used. The
   router's direct-dynamic catalog facts list the same tools. 2026-11-02: v6, the spec description
   names agent-workflow's commands (`agent-workflow dynamic`, `/aw dynamic`, `workflow_dynamic`)
   instead of pi-workflow's `/workflow dynamic`.
5. **B4 now sees web tools.** `workflow_web_*` were never inferred as web tools; `web_search` /
   `fetch_content` are, so web stages negotiate `webTools` (degraded `safetyPolicy: unknown`, or
   refused where the executor has none / only unverified rows). The unit harness' default `pi`
   fixture executor declares `webTools` native/search+fetch (`test/helpers/register-default-executor.mjs`).

Left as is at WP10: `tool-metadata.ts` kept the read-only/network classification of the three legacy
`workflow_web_*` names. Removed 2026-11-02 with the authority aliases added on 2026-10-30
(agent-workflow does not know pi-workflow's names): they are unknown tools now, a readOnly stage
keeps an unknown tool instead of dropping it, and the run is refused or blocked before launch; the
replay's `engine-only` variants classify them through a test seam.

### WP10 tests

All 31 `deferred (WP5+) | bundled workflows (WP10)` files are ported as `test/unit/core-<name>.test.mjs`
(table above: ported-WP10). Mechanical changes as in WP4c-2 (dist/core imports, the harness in
`test/helpers/`, `setSubagentApiForTests`→`setTaskRuntimeApiForTests`, `.pi/…`→`.agent-workflow/…`,
`PI_WORKFLOW_*`→`AGENT_WORKFLOW_*`); fixtures `test/fixtures/deep-research/*` and
`test/helpers/impact-review-fixtures.mjs` are copied unchanged. Assertions changed (each marked in
place; M* = docs/bundled-workflows.md change log):

- deep-review-d01-d10 D09: blocks `.agent-workflow` (was `.pi`) to force the sidecar write failure (M2)
- deep-review-ledger-corrective: OCR artifacts under `.agent-workflow/ocr-artifacts` (was `.pi/ocr-artifacts`) (M3)
- spec-requirement-coverage IRCF-01 sidecar-failure: blocks `.agent-workflow` (was `.pi`) (M1/M2)
- wb-012-public-contracts name resolution: user/global spec under `$AGENT_WORKFLOW_HOME/workflows` (was `~/.pi/agent/workflows`; agent-workflow root rule, WP4b)
- wb-012-public-contracts router: "…, `/workflow auto`, or the matching `agent-workflow` CLI commands" (was "…, or `/workflow auto`") (M13)
- wb-012-public-contracts root order: bundled README global root `~/.agent-workflow/workflows/` (was `~/.pi/agent/workflows/`); docs/usage.md half dropped (deferred (WP11))
- wb-012-public-contracts: "public command and troubleshooting docs mirror runtime help" and "packaged docs have self-contained speed guardrails" not ported (deferred (WP11): docs/usage.md)
- unit-core-runtime "deep-research sanitizer demotes url-only candidates…" → "…keeps url-only web candidates and promotes nothing (C2)": no demotion/promotion, claim-001 kept, slot-001 → ["claim-001"] (M8)
- unit-core-runtime "claim-evidence-gate does not backfill near-miss source URLs": sourceRefJoinFailures 0 / [] (was 1 / ["claim-001"]) (M7)
- unit-core-runtime "claim-evidence-gate canonicalizes candidate ids…": no `source_ref_join_failures` blocker (M7)
- unit-core-runtime / unit-engine-store rate-limit backoff: 900_000 / 3_600_000 (was 60_000 / 240_000; WP4c-1 R#12 unknown auth kind → OAuth backoff)
- unit-core-runtime, unit-engine-store, unit-artifact-web: backend handle `{engine: "agent-workflow", backend: "runtime"}`, backend id `agent-workflow/runtime` (WP4c-1 literal rename)
- unit-engine-store: messages "launched via the pi executor", "executor run failed: …", "stale executor launch claim reset", "global executor worker slot" (WP4c-1 literal renames); shared backoff file under `$AGENT_WORKFLOW_HOME` (WP4c-1); launch option `effort` (was `thinking`, runtime-port)
- unit-artifact-web: worker session ids `agent-workflow.<run>.<task>` (was `pi-workflow.`; WP4c-1)
- unit-authoring-interface "bundled deep-research compacts audit packets…": verify prompt matches "cannot find an exact supporting quote in fetched content, do not mark the claim verified" and "Source verification is model-reported" (was /candidateOnly=true cannot verify/) (M6)
- unit-authoring-interface "bundled workflows compile warning-free…": researcher agent tools `read, grep, find, ls, web_search, fetch_content` (was the three workflow_web_* tools) (M12)
- unit-authoring-interface "bundled common agents are fallback…": project agent path `.agent-workflow/agents/scout.md` (was `.pi/agents`; WP4b)
- execution-profiles: launch capture reads `effort` (was `thinking`; runtime-port mapping); registers the default fixture executor
- graph-schema-contracts: the bundled schema walk is `workflows/` + `skills/workflow-guide/scaffolds`
  with `count > 20` again (as the original); the WP4b fixture copy is walked as well.
- Existing suites: `core-unit-dynamic-runtime` (web budget names `web_search`; direct-dynamic bundle
  v5 and its `web_search`/`fetch_content` tools; launched system prompt shows the rendered artifact
  name and the CLI web-tool hint), `core-dynamic-coordination-bundle-parity` (v5), `mcp-visible-names`
  (`verified: true`), `test/helpers/register-default-executor.mjs` (fixture declares `webTools`).

Not ported (marked in place with the reason): Pi host extension / TUI / profile UI tests
(deferred (WP11) or dropped with the Pi TUI: 16 authoring-interface, 2 unit-core-runtime, 3 + 4
unit-engine-store, 8 workflow-router, 17 workflow-user-profiles, 2 execution-profiles, 15
unit-artifact-web); WP4b generated-wrapper tamper tests (3, unit-engine-store); C2/WP10 drops (4,
unit-artifact-web: web-source cache sourceRef backfill ×2, fetch cache / normalized fetch ×2);
docs/usage.md (2 + half of one, wb-012, deferred (WP11)). All of these are resolved in WP38 (section "WP38").

New tests: `bundled-workflows.test.mjs` (bundled specs and scaffolds compile warning-free with the
bundled agents; no `workflow_web_`, `.pi/workflows`, `.pi/ocr-artifacts`, `PI_WORKFLOW_`,
`web-source-cache` or `mcp__workflow_artifact__` in `workflows/`, `skills/`, `agents/`; no Pi-only
capability and `allowReadOnlyDowngrade` in every bundled spec; the deep-research completion summary,
report and audit carry `SOURCE_VERIFICATION_STATEMENT`; the committed support table matches
`test/helpers/bundled-support-table.mjs`), `core-worker-prompt-render.test.mjs` (renderer per
executor, locators untouched, idempotent; the task backend sends rendered prompts with the
guidelines section and keeps canonical prompt files).

Counts after WP10: ported 1, ported-WP4b 23, ported-WP4c1 14, ported-WP4c2 15, ported-WP10 31,
deferred (WP6) 1, deferred (WP5+) 22, dropped 33 (140).

## WP5b — paged artifact reads, coverage-based required reads, measured limits

Required reads accepted only whole, uncut, delivery-verified reads (R#9), and the artifact tool had no
paging, so an artifact larger than the worker CLI's MCP output limit could never satisfy one. The core
also launched the artifact server without a limit (server default 8192 for every executor). Contract
details: docs/mcp.md "Paged reads" and "Measured limits".

### WP5b change log (behavior-relevant)

1. **`workflow-artifact-tool.ts`: paged whole-artifact reads.** Tool input `offset` (integer ≥ 0, not
   with `path`/`maxItems`/`maxChars`); option `pageLimitChars` on `handleWorkflowArtifactToolCall`. A
   read with `offset` is served as one page `[offset, end)` with a footer naming the next offset (or
   `end of artifact`); the response fits the limit in UTF-16 chars and UTF-8 bytes and never splits a
   surrogate pair. With `pageLimitChars` set (the MCP server sets its output limit), a whole read whose
   response does not fit is served as its first page. Paged reads load the whole file
   (`readWorkflowArtifact(..., {whole: true})`, ≤ 64 MiB, `contentSha256`), ignore `maxBytes`/`maxLines`
   and bypass both read caches. Direct core callers without `pageLimitChars` see no change unless they
   pass `offset` (pages of 8192 then).
2. **Read-ledger page rows.** `rangeStart`, `rangeEnd`, `totalChars`, `contentSha256` (all or none,
   never with `path`, validated by `readWorkflowArtifactReadLedger`), `deliveryUnverified: false`,
   `truncated: true` unless the page is the whole artifact. `deliveryUnverified` is now
   `boolean` in `WorkflowArtifactReadLedgerRecord` (`false` is kept by the reader). Old rows stay valid.
3. **`required-reads.ts`: coverage rule.** A whole-artifact required read is also satisfied by verified
   page rows of one `contentSha256`/`totalChars` covering `[0, totalChars)` (any order, overlaps
   allowed; one complete set counts as one read for `count`). Unverified/cut rows and mixed versions
   never count; projected requirements and `requiredReadPolicy` are unchanged. New
   `RequiredArtifactReadCheckResult.incompleteCoverage` (absent when empty) names the missing ranges,
   and `formatRequiredReadFailureMessage` appends them, so the retry instruction tells the worker which
   offsets to read.
4. **Measured limits.** `WorkflowExecutorProbeSummary` gains optional `mcpOutputLimitChars` /
   `mcpOutputNoticeChars` (copied from the probe when it reports them; nested runs reuse the parent's).
   `artifactServerOutputLimitForRun(run)` (artifact-access.ts) = sdk `artifactServerOutputLimit`:
   `limit − notice − max(256, ⌈5 %⌉)` → Pi 18,432, Claude 21,375, Codex 30,400, unknown → none (8192).
   `preparedMcpServers(launch, {artifactOutputLimitChars})` appends `--max-output-chars` to the
   `workflow_artifact` server (task-backend change limited to that function and its call site).
5. **Provenance.** `artifacts.serverSpecSha256` digests the spec with the same flag
   (`withArtifactMcpOutputLimit(artifactMcpServerSpec(config), artifactServerOutputLimitForRun(run))`),
   so the recorded digest binds the limit actually launched. Without a recorded limit the digest is
   unchanged.
6. **Tool text** (`artifact-access.ts`): `offset` in `WORKFLOW_ARTIFACT_TOOL_PARAMETERS`, one sentence in
   the description, one guideline line about paging. Prompt rendering of the guidelines is WP10's.
7. **SDK.** `src/sdk/mcp-delivery.ts` (exported from `./sdk`): `artifactServerOutputLimit`, the
   8192/512/16 MiB constants, `fitsDeliveryLimit`, `cutToDeliveryBudget`; the conformance kit adds
   `mcp.paged_read` and the optional harness field `toolOutputEventLimitChars`.

### WP5b tests

- `mcp-artifact-paging.test.mjs`: ASCII, multibyte and surrogate-pair paging through the real server,
  exact-boundary sizes, offset past the end / negative / with a projection, empty artifact, no dedup,
  artifact changed between pages, page arithmetic with a raw-assurance line.
- `core-wp5b-required-read-coverage.test.mjs`: page row shapes (round-trip, old shapes, inconsistent
  fields refused); coverage in order / out of order / overlapping / one whole page; gap, unverified
  page, cut page, mixed versions; scope (other artifacts, projected requirements, policies, `count`).
- `core-wp5b-artifact-output-limit.test.mjs`: the three executors' declared limits → server limits;
  probe summary → run → `preparedMcpServers`; provenance digest equals the launched spec's digest.
- Updated: `mcp-artifact-delivery.test.mjs` and `mcp-artifact-conformance.test.mjs` (whole reads page,
  projections still cut), conformance kit tests (fake, Pi, Codex justified skip).

## WP12a — stage-1 closure fixes

Fixes for owner-decision violations and live bundle 3 findings (docs/live-acceptance-stage1.md, open
problems 1–6, 10).

### WP12a change log (behavior-relevant)

1. **Worker sessions are not kept by default (D3, R#10).** `task-backend.ts` still derives the engine
   session id (`agent-workflow.<run>.<task>…`, launch provenance and `backendFiles`), but passes it to
   the executor as `SubmitRequest.sessionId` only when `workflowTaskKeepsSession(task)`
   (`owned-session-release.ts`): artifact-graph task with experimental same-session repair on
   (`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`, the only path that continues a kept session;
   with it on, attempts keep sessions as in pi-workflow). Without it no attempt keeps one: output
   repairs, launch retries and resumes always start fresh sessions (`.retry-N`, `.launch-retry-N`,
   `.resume-N` stay the attempt identities). Without a session id the adapters run without session
   persistence (Claude `--no-session-persistence`, Codex `ephemeral: true`, Pi `--no-session`), so they
   report no `ownedSession`. `releaseUnneededOwnedSessions(run)` runs at the end of every refresh and
   schedule pass (under the run lease) and deletes, through the run executor's `deleteOwnedSession`,
   exactly the `task.ownedSessions` entries of completed/skipped tasks, and every remaining entry once
   the run is completed or failed. Blocked and interrupted runs keep the sessions of their
   failed/blocked/interrupted tasks until resolved or pruned. Each handled entry gets
   `release: {at, outcome: deleted | not_found | unsupported | refused | failed, error?}`; a session
   recorded for another executor id is `refused` and never passed on. `prune` skips entries already
   `deleted`/`not_found` and retries the rest. Replay: `owned-sessions` differences disappear (no
   session is requested); the explained entry stays for runs with same-session repair on.
   Tests: `core-wp12a-worker-sessions.test.mjs`; pi-workflow-ported tests that asserted a session id
   on every runtime launch (`core-unit-artifact-web`, `core-unit-engine-store`) now assert none
   without the flag and the rotated identity on `backendFiles`/`backendHandle`.
2. **Unknown cost is `null`, never 0 (live open problem 4).** `workflow-metrics.ts`: a support task
   (no model call) observes nothing — its `observed` values are `null` instead of `0`, and the observed
   run sums read `task.usage.observed`; before, a run whose model tasks all reported `costUsd: null`
   (every Codex attempt) summed the support tasks' zeros into `costUsd: 0` (likewise
   `totalTokens`/`cachedInputTokens`). `store.ts` run rollup (`run.usage`) always carries `costUsd`
   (`null` when no task reported a cost). Host text: the usage line of `formatHumanRunOutcome` /
   details says `cost unknown` or `cost $<usd>`; `formatRun` adds `cost=unknown|<usd>`. SDK
   `negotiateCapabilities`: `usage.cost` is no longer `emulated by engine` ("cost = tokens × model price
   table" — no price table exists); a preferred `usage.cost` the executor cannot report is `degraded`
   (`CAPABILITY_MISSING:usage.cost`, note "cost recorded as unknown…") with the new
   `NegotiationEntry.recordOnly: true`, which never needs an interactive confirmation (`strict`
   still refuses it). A required `usage.cost` is still refused. Tests:
   `core-wp12a-usage-cost.test.mjs` (Codex/Pi/Claude recorded transcripts → runtime summary → task →
   rollup → text; negotiation), `sdk-capabilities.test.mjs` updated. Replay: new explained rule
   `run-usage-unknown-not-zero` (run rollup token classes no task reported are absent, not 0).
   The generated offline support table (`docs/bundled-workflows.md`) now lists
   `CAPABILITY_MISSING:usage.cost` for Codex (regenerated with `bundled-support-table.mjs --write`).
3. **One normalized usage shape (live open problem 5).** SDK `UsageEvent` (src/sdk/events.ts, the
   usage event docs): `input` = input tokens EXCLUDING cache reads and writes, `cached` = cache-read
   input tokens, new optional `cacheWrite` (cache-creation input tokens; absent = none) and `model`
   (the model that served the request, resolved name), `output` (reasoning included), `cost` or
   `null` + `source`; total = input + cached + cacheWrite + output. `validateExecEvent` checks the two
   new fields when present (contract stays 0.1.0: additive). Adapters: Pi `usageFromPi(usage, model)`
   (Pi's `input` already excludes cache; `cacheWrite`; the assistant message's `model`); Codex
   `CodexTurnNormalizer` subtracts `cachedInputTokens` (and `cacheWriteInputTokens`) from
   `inputTokens`, reports `cacheWrite`, and names the model from the `thread/start`/`thread/resume`
   response (else the request model); Claude reports `input_tokens` as is (it excluded cache already;
   the adapter used to add cache reads and writes), `cache_creation_input_tokens` as `cacheWrite`, and
   the resolved model (`result.modelUsage`, else the last assistant message). Runtime
   `summarizeUsage` adds `cacheWrite`, `total` and `model`; the core maps them to
   `totalTokens` / `cacheCreationInputTokens` and takes the attempt `model` from the usage summary
   before request metadata (Claude no longer records the alias `haiku`; Pi tasks record their
   model). Run rollups are also written for `blocked` runs (`store.ts`), so wait results of blocked
   runs carry the usage of the attempts that ran. Live bundle 3's `totalTokens: 0` came from the
   missing total plus the support-task zeros (change log 2). Tests:
   `core-wp12a-usage-normalized.test.mjs` (recorded Pi/Codex/Claude transcripts → events → summary →
   task → rollup, blocked run); adapter parser and runtime summary tests updated to the normalized
   input and the new `cacheWrite`/`total` summary fields (a `null` part makes `total` `null`). Replay: task
   `totalTokens`/`cacheCreationInputTokens` now reproduce the recording (fewer `executor-usage-contract`
   rows); the `original-spec-review-legacy-state-read` divergence also covers run
   `usage.totalTokens`/`usage.cacheCreationInputTokens`.
4. **Control-schema path in worker prompts (live open problem 3).** The compiled output protocol
   says "Validate the control object against the workflow-local control schema file: ./schemas/…",
   relative to the workflow bundle; the worker's cwd is the project, so Pi and Codex spec-review
   workers got ENOENT and reported it as a needsHuman row (which sets the renderer gate
   `actionableEvidenceComplete: false`). The engine does enforce the schema after the attempt, but
   the instruction is kept so workers can self-check: `task-backend.ts` `renderControlSchemaPath`
   replaces the bundle-relative path in the prompt sent to the executor with the run's own copy
   (`task.artifactGraph.output.controlSchemaPath`, absolute, `<run>/bundle/schemas/<file>`, readable
   from any cwd including a worktree). `task.md` (digested by launch provenance) keeps the compiled
   text, so prompt files and provenance are unchanged. Replay: the launch prompt (match key) is
   renamed back by the new literal rename `wp12a-control-schema-path` in
   `test/replay/allowed-differences.json` (`control schema file: <ROOT>/.agent-workflow/workflows/
   <WF_RUN_n>/bundle/schemas/` → `control schema file: ./schemas/`, the WP10 tool-name precedent);
   no other difference; 0 unexplained. Test: `core-wp12a-control-schema-path.test.mjs` (the prompt
   path is absolute and exists; task.md unchanged).
5. **Workflow inputs from the CLI and `/aw` (live open problem 1).** `agent-workflow run|dynamic`
   and Pi `/aw run|dynamic` accept `--input key=value`, repeatable (CLI `parseCommandArgs` gains
   `repeatable` options; `hosts/args.ts` `addWorkflowInputAssignment`, also used by
   `parseWorkflowRunArgs`/`parseWorkflowDynamicArgs`, leading or trailing). The raw strings go to the
   host API's `inputOverrides`, which `typedWorkflowInputOverrides` (hosts/launch.ts) types against
   the spec's declared `input` defaults before anything starts: string stays string, number must be
   finite, boolean is `true`/`false`, arrays/objects/`null` defaults take JSON; a non-string value
   must already have the declared type. An undeclared key is now a usage error listing the declared
   keys (the engine used to drop it silently); a key given twice is a usage error. Help texts list
   the option. Test: `host-wp12a-input.test.mjs` (CLI typed inputs reach the compiled
   "# Workflow Input", usage errors exit 2 with no run, host API typing, `/aw` parsing).
6. **Flakes under load: stop and blocked runs (live open problem 10).** Two product races, both
   reproduced with a stress script (6 parallel loops of the host-cli stop scenario, 24 busy-loop
   processes on 12 cores): 4 of 30 stops failed before, 0 of 30 after.
   - *Stop.* `hosts/runs.ts` `stopAction` retried `stopRun` after a stop-pending error. Under load
     the first call could not confirm within `STOP_RUN_LEASE_WAIT_MS` (the detached supervisor held
     the lease); meanwhile the supervisor applied the stop and cleared the stop intent, so the retry
     refused the now-interrupted run ("stop requires a non-terminal run") and `agent-workflow stop`
     exited 1 although the stop had succeeded. Retries now call the new `confirmRunStop` (engine):
     a run that is terminal with no stop intent left is the confirmation; otherwise it confirms the
     durable intent without requesting it again.
   - *Blocked.* `runtime/orchestrate/reconcile.ts` `ownerProcessAlive` read an `unknown` identity
     check (the Darwin helper times out after 2 s under load) as "owner gone". Reconcile then ran
     `terminateAttemptOwnership`, whose next inspection succeeded, SIGTERMed the healthy durable
     worker and asked the executor, which could only answer `unknown` → `needs_decision`: the task
     and run turned `blocked` (host-cli "foreground run" flake; also one replay-acceptance failure
     in this WP: impact-review task-8 `executor_needs_decision`). An `unknown` is now re-inspected
     twice and, if it stays unknown, the attempt is kept running (unknown is not dead); `dead` and
     `mismatch` are handled as before. Test seam: `setProcessIdentityInspectorForTests`
     (`runtime/process-identity.ts`).
   Tests: `runtime-wp12a-reconcile-unknown-owner.test.mjs`, `host-wp12a-stop-confirm.test.mjs`;
   `replay-acceptance.test.mjs` now prints the unexplained rows when it fails.
   Test-only load margins (same machine load, load average 26–41 on 12 cores during this WP):
   `core-wp4c1-engine-runtime` waits up to 20 s (was 5 s) for the in-process supervisor before
   pruning; `core-dag-hardening` "stop during dynamic helper" waits up to 10 s (was 1.5 s) for the
   helper to start.
7. **Legacy agents shadowing bundled agents are announced (live open problem 2).** The search order
   stays (F5: agent-workflow locations, then legacy Pi `.pi/agents` / `~/.pi/agent/agents`, then
   bundled). `agents.ts`: a legacy user agent (`~/.pi/agent/agents`) whose name also exists among
   the bundled agents records `shadowsBundledAgent` (bundled path); a project's legacy `.pi/agents`
   override is left alone (the project's explicit choice; the WP1a recordings ship one). `compiler.ts` turns it into one line, also a compile warning:
   `agent "<name>": legacy <path> shadows the bundled agent of the same name (legacy agents take
   precedence); rename or remove it to use the bundled agent`, collected in
   `CompiledWorkflow.agentNotices`. `capability-negotiation.ts` records them as
   `run.capabilityNegotiation.notices` and appends `Notice: …` lines to the preview text that hosts
   print at launch (host API `data.capability.notices`). Test:
   `core-wp12a-legacy-agent-shadow.test.mjs` (no legacy file → no notice; legacy `scout.md` → still
   resolves first, one-line notice in record and preview).
   *Superseded 2026-10-30 (owner decision):* the bundled agents now come before `~/.pi/agent/agents`, so a Pi user agent never replaces `scout`/`researcher` on any host and the notice is gone; the test asserts the bundled agent resolves and a Pi-only name still does.

### WP12a validation

`npm run validate` passes (twice in a row at the final commit; unit 1,872 pass, 22 skipped, 0 fail;
main had 1,844). Replay acceptance: 0 unexplained in every fixture/variant; new classifications are
`run-usage-unknown-not-zero` (change log 2), the extended `original-spec-review-legacy-state-read`
divergence (change log 3) and the literal rename `wp12a-control-schema-path` (change log 4); reports
regenerated with `node test/replay/acceptance.mjs --write`. The new WP12a test files remove their
temp roots with retries (a durable worker or finalizer can still close files right after a run
ends). `test/unit/host-cli.test.mjs` ran 10 times
in a row with 24 busy-loop processes on 12 cores (load average up to ~95): 10/10 passed.

## WP12d-1 — stage-1 review fixes (core, runtime, MCP, replay)

Fixes for findings of the stage-1 cross-model review of main `2b745d3` (findings numbered in review
order). Each fix has a regression test that failed before it.

### WP12d-1 change log (behavior-relevant)

1. **Review #1: a declared readOnly stage stays read-only in both permission modes.** Before, a
   stage with `readOnly: true` and a mutation-capable tool (e.g. `tools: [read, bash]`) compiled as
   `mutation-capable`, negotiated `readOnly: false` and launched with `SubmitRequest.readOnly:
   false`, so `free` mode selected Claude `bypassPermissions` and Codex `danger-full-access` +
   `never`. Now `compiler.ts` removes every tool whose effective classification is not
   `read-only` (write-capable, mutation-capable, unclassified; the non-downgradable floors still
   apply) from a declared-readOnly stage, with the warning `stage "<id>" declares readOnly: true;
   removed tools that are not read-only (<tools>) so the stage stays read-only in every permission
   mode` (diagnostic code unchanged, `tools.read_only_capability_advisory`). When an authored
   non-empty list keeps no read-only tool the stage is refused (`WorkflowValidationError`, `…no
   read-only tool remains after removing …`). An unspecified list stays unspecified. The authored
   contract also wins over the classification at launch: `tool-policy.ts` `workflowTaskReadOnly`
   (`capability === "read-only" || safety.readOnlyDeclared`) feeds negotiation
   (`StageRequirementContext.readOnly`), the engine approval policy and `SubmitRequest.readOnly`,
   so inherited host tools (Pi) and records compiled before this fix still launch read-only.
   Test: `core-wp12d1-readonly-contract.test.mjs` (free and safe: compiled tools, negotiation,
   submit, Claude/Codex/Pi settings; refusal; inherited-host and legacy records). Changed
   assertions: `core-unit-authoring-interface` (readOnly + bash now filtered; three metadata tests
   declare `readOnly: false` to keep testing metadata), `core-workflow-router` (readOnly stages with
   only bash/unknown tools are refused at compile, so their auto cards have no effective facts and
   stay blocked).
2. **Review #7 (`src/sdk/requirements.ts`): a forced readOnly downgrade negotiates `readOnly`.**
   Before, `allowReadOnlyDowngrade` only checked that `readOnly` was available, so a writable stage
   downgraded on a coarse allowlist or an unmapped tool was accepted with an emulated readOnly even
   under `strict: [readOnly]`, and an environment warning on readOnly (e.g. Claude allow rules) was
   never recorded. Now, when the downgrade is taken and the stage has no `readOnly` entry yet,
   `negotiateCapabilities` adds one negotiated with the default `readOnly` requirement through the
   same per-key rules: `CAPABILITY_STRICT:readOnly` for an emulated/warned level under strict,
   `CAPABILITY_WARNING:readOnly` degradation (confirmation when interactive, `acceptedByFreeMode`
   in free mode) for a warned one. Test: `sdk-wp12d1-forced-readonly.test.mjs` (coarse and unmapped
   paths, strict, warning, native, no duplicate entry). Changed assertion:
   `sdk-negotiation-warnings` preview (the forced "write" stage now also lists its readOnly warning:
   3 degradations instead of 2).
3. **Review #8 (core part): `appendWorkflowArtifactReadLedger(path, record, { insideDir })`.** New
   optional argument (additive). When set, after the existing no-follow open and descriptor checks,
   the opened ledger's resolved path must be inside `insideDir` (a real directory) and be the opened
   file (dev/inode), so an ancestor directory swapped for a symlink cannot redirect the row. The MCP
   artifact server now writes its rows through this writer with the run directory (docs/mcp.md
   WP12d-1 change log 1). Workers that append through the tool itself are unchanged.

Other WP12d-1 fixes, logged in their own docs: review #4 (handled signals keep directory locks
held) in docs/runtime-port.md change log 18, review #8 (MCP ledger race) in docs/mcp.md WP12d-1
change log, review #11 (replay exact-match paths) in docs/replay.md WP12d-1 change log.
Findings #2, #3, #5, #6, #9 and #10 (executors) are WP12d-2.

### WP12d-1 validation

`npm run validate` (twice) and `npm run e2e` exit 0 on the final commit; replay acceptance has 0
unexplained differences in every variant. Every new test that spawns a process kills it in
`finally` (`runtime-dir-lock.test.mjs`).

## WP12c — stage-1 doc sync, `aw_run` inputs, release secret scan

1. **Docs synced with WP12a.** `docs/usage.md` (`--input` typing and errors, legacy-agent notice,
   normalized usage and `cost unknown`, worker sessions D3, stop confirmation), `docs/cli.md`
   (`--input`, stop confirmation), `docs/support.md` (WP12a-fixed limits marked; remaining open
   problems 7–9), `docs/sdk.md` / `docs/architecture.md` (usage `cacheWrite`/`model`, `usage.cost`
   record-only, session retention), `docs/environment.md` (same-session repair is the only kept-session
   setting; no `AGENT_WORKFLOW_*` variable was added since WP12b), `docs/pi-host.md` (`inputs`),
   `docs/executors/{pi,codex}.md` known limits, `docs/live-acceptance-stage1.md` "Fixed after
   acceptance (WP12a)". Shipped skills and `workflows/README.md` use `agent-workflow …` / `/aw …` /
   `aw_*` instead of pi-workflow's `/workflow …` / `workflow_*` (docs/bundled-workflows.md M18);
   `core-wb-012-public-contracts.test.mjs` asserts the router's new wording.
2. **`aw_run` / `aw_dynamic` `inputs`.** An optional object, the tool form of `--input`, passed as
   `inputOverrides` and typed by `typedWorkflowInputOverrides` (strings converted for number/boolean/
   JSON defaults, other values must have the declared type, undeclared keys refused before anything
   starts); not an object → usage error; `{}` → spec defaults. Test:
   `host-wp12c-tool-inputs.test.mjs`.
3. **Release secret scan by value.** `tools/release/release-check.mjs` rejected the package on the
   words `API_KEY`, `SECRET`, `PASSWORD`, `PRIVATE KEY` (env var names and constants in `src/`,
   `dist/`, `docs/`). `tools/release/secret-scan.mjs` `findSecretValues` flags token shapes (`sk-…`,
   `gh?_…`, `github_pat_…`, `glpat-…`, `xox?-…`, `xapp-…`, `npm_…`, AWS key ids, Google API keys and
   OAuth client secrets, Stripe live keys), private-key blocks followed by key material, JWTs whose
   header decodes to JSON, and long high-entropy values (mixed classes, entropy ≥ 3.5 bits/char, hex
   ≥ 3.0, UUIDs) assigned to key-like names (quoted, or unquoted on env/ini/`.npmrc` lines); findings
   report file, line and rule, never the value. The local-path pattern (the maintainer's home
   directory, macOS temporary folders, desktop and screenshot file names) is unchanged; it moved to
   `secret-scan.mjs` (`LOCAL_PATH_PATTERN`) so the unit test checks the shipped text with it too. `secretScanSelfTest()` (22 planted
   secrets assembled at run time, 20 benign mentions) runs first in release-check, which exits 1 if
   the scanner misses or over-flags. Test: `release-secret-scan.test.mjs` (self-test, rule names,
   unquoted code expressions, the shipped `src`/`dist`/`docs`/`skills`/`workflows`/`agents` text has
   no finding).

## WP37 — engine open items (per-executor task prompts, resume after stop, Claude reconcile, profile precedence)

### WP37 change log

1. **Task prompts are rendered per executor** (stage-1 open problem 8, live bundle 3). Until now only
   the system prompt got the M17 tool mapping; task prompts named Pi's tools (`read/grep/find/ls`,
   `web_search`, `fetch_content`). `launchSubagentTask` now sends
   `renderWorkerTaskPromptToolNames(compiledPrompt, executor.id)` (`src/core/artifact-tool-names.ts`):
   - **Pi** (and unknown executors): unchanged, only the artifact tool's visible name (WP10).
   - **Claude:** the logical names become Claude's tool names inline (`WORKER_TASK_TOOL_RENAMES`, the
     adapter's mapping): `web_search` → `WebSearch` and `fetch_content` → `WebFetch` anywhere;
     `read`/`grep`/`find`/`ls`/`bash`/`edit`/`write` inside a tool list (`read/grep/find/ls` →
     `Read/Grep/Glob`, `filesystem read, grep, find, or ls` → `filesystem Read, Grep, or Glob`;
     duplicates collapse). `read`, `find`, `edit`, `write` outside a list are prose and stay.
   - **Codex:** its tools have no names a sentence could use instead (shell commands, the hosted
     `web_search`), so the logical names stay and the M17 note (`workerToolMappingNote`, the same
     text as in the system prompt) for the mentioned tools is appended, plus the code-mode form of
     the artifact tool when the prompt names it: "call mcp__workflow_artifact__workflow_artifact as
     tools.mcp__workflow_artifact__workflow_artifact(…)" (live 4b: Codex 0.159.2 runs the model in
     code mode).
   - A tool named outside a list (`grep`, `ls`, `bash`) is not renamed; the note maps it (Claude too).
   `task.md` and the launch provenance keep the canonical text. Replay: the replay executor re-keys
   the recorded prompts with the same renderer when it is registered under another id, and the new
   variants `minimal:codex` and `deep-research:engine-only-claude` show every launch matched; each
   rendered launch is one `explained` row of rule `wp37-per-executor-task-prompt` (docs/replay.md
   "WP37"). Tests: `core-wp37-task-prompt-tools.test.mjs` (renderer per executor, task backend with
   fixture executors registered as `pi`, `claude`, `codex`), `replay-acceptance.test.mjs`.
2. **Resume right after stop** (parity §3.2). `stop` interrupts the run, but the stopped supervisor
   (attached, often in the same process) may hold the run's supervisor lease for a moment while it
   shuts down; `resume` refused at once with "another supervisor may be active". Now `resumeRun`, when
   the lease is held and the stop is recorded (run `interrupted` with `workflow_stopped` tasks or a
   durable stop intent), retries the normal lease acquisition every 100 ms for up to 10 s. Not
   released in time → `Cannot resume <run> yet: the previous supervisor is still shutting down; try
   again in a few seconds`, run unchanged. A live lease is never taken (the acquisition only reclaims
   stale leases, as before), and a held lease on a run that was not stopped is refused at once with
   the old message. Tests: `core-wp37-resume-after-stop.test.mjs` (lease held 0.8 s after stop →
   resume waits and completes; held past the bound → the message, live holder unaffected, then a
   resume succeeds; blocked run not stopped → immediate refusal); `host-api-handlers.test.mjs` "wait
   is bounded … stop then resume" no longer retries.
3. **Claude `sessionBound` reconcile** (parity §3.2, B3). When a Claude worker dies its CLI loses
   stdio; reconcile from another process could not observe it but answered `found`. It now answers
   `unknown` with a reason unless the raw stream recorded a result, so the runtime records
   `failed/needs_decision` with that reason and the engine blocks the task (`executor_needs_decision`),
   never relaunching it automatically. Details and tests: docs/executors/claude.md change log
   "WP37".
4. **Saved vs declared profiles, field by field** (parity §3.2, B2 interpretation). A selected
   workflow-declared profile used to replace the saved user profile as a whole, so the default saved
   profile's executor (or permission mode) never applied under a declared profile that omitted it.
   Now the precedence run flag > workflow profile > saved user profile > default holds per field.
   New run option `savedUserProfile` (`WorkflowSavedUserProfileLayer`: name, executor, permissionMode,
   strictCapabilities, model, effort), used only with a declared `executionProfile`: the executor and
   permission-mode resolvers get it as their saved-user-profile tier, `workflowProfileStrictCapabilities`
   falls back to it when the declared profile has no `executionProfileStrictCapabilities` entry (an
   empty list is an entry), and its model/effort join the run defaults when it names no executor or
   the run's executor (`runtimeDefaultsWithSavedProfile`; host defaults still apply only to their own
   executor). The host launch (`src/hosts/launch.ts`) passes the default saved user profile with an
   explicit declared profile and with the declared default/chooser choice; an unreadable profiles
   file is ignored there, as before. A saved profile named with `--profile` and the Pi per-workflow
   preference are unchanged. The launch fingerprint includes the inherited profile. Docs:
   `docs/usage.md` "Profiles", `docs/cli.md` "Precedence". Test:
   `host-wp37-profile-precedence.test.mjs` (explicit and default declared profile inherit executor,
   mode and effort; declared executor/mode win per field; run flags win; saved effort not applied to
   another executor; inherited and declared strictCapabilities).

### WP37 validation

`npm run validate` (twice) and `npm run e2e` exit 0 on the final commit; replay acceptance has 0
unexplained differences in every fixture and variant, including the new executor variants
`minimal:codex` and `deep-research:engine-only-claude` (docs/replay.md "WP37 change log");
`node tools/release/plugins.mjs check` passes. Engine status semantics are unchanged (owner
decision Q8: a domain verdict still fails the run; not part of WP37). No model or agent CLI was
called.

## WP38 — pi-workflow test parity (no deferred tests remain)

Every pi-workflow test file and every individual test that was still deferred (WP5+, WP6, WP11) now has
a final disposition: **ported** (adapted to the agent-workflow host API, `aw_*` tools, `/aw`, the Pi
executor, the CLI and the package layout, passing), **superseded** (an existing agent-workflow test
covers the behavior; named below) or **not applicable** (a named design decision). The status table
above has no `deferred` status left. No model or agent CLI is called by any new test.

### Counts (test cases, as node:test runs them)

| Scope | Ported | Superseded | Not applicable |
|---|---|---|---|
| The 17 deferred files (fast-mode … built-engine-frozen-bundle-regression) | 123 | 17 | 9 |
| The 6 files whose rows were still deferred after WP11a (review-core-fixes, surface-regressions, unlimited-supervisor, workflow-extension-isolation, workflow-launch-cancellation, workflow-notice-acknowledgements; WP11a parts unchanged) | 36 | 1 | 4 |
| Individual tests in ported files (authoring-interface, user-profiles, router, core-runtime, dynamic-runtime, engine-store, wb-012) | 19 | 18 | 15 |
| **Total** | **178** | **36** | **28** |

WP38b moved the 21 cases WP38 had as not applicable for want of `/aw auto` (14 workflow-launch-cancellation,
7 workflow-router) to ported once WP32 landed; WP38 itself counted 157 / 36 / 49.

Files: 16 more files are `ported-WP38`, 1 `superseded-WP38`, 2 `not-applicable-WP38`; 4 rows record
their WP11a ports plus WP38 (`ported-WP11a + WP38`, `ported-WP10 + WP38`, `ported-WP11a`).

### Ported files (new tests)

| New test file | From | Cases |
|---|---|---|
| `core-foreach-batch-runtime` | foreach-batch-runtime (mechanical) | 33 |
| `host-wp38-workflow-wait-tool` | workflow-wait-tool (core wait boundary and lease hooks; `deliverCompletion`, `PiRunFeedback`, `aw_wait`, `summarizeWorkflowTerminal`) | 19 |
| `core-workflow-native-prompt-policy` | workflow-native-prompt-policy (`native` = WP35 `inheritHostTools`) | 16 |
| `core-no-send-controls` | no-send-controls (bundled runtime API instead of pi-subagent 0.7.2) | 11 |
| `core-subagent-partial-output` | subagent-partial-output | 8 |
| `core-wb-003-package-closure` | wb-003-package-closure (fixtures in test/fixtures/core/package-closure) | 7 |
| `core-run-estimates` | run-estimates | 6 |
| `core-review-core-fixes` | review-core-fixes IR1-03 ×4, IR1-04, IR1-05 | 6 |
| `core-surface-regressions` | surface-regressions (parent usage ×4, 8 MiB preview, formatLogs) | 6 |
| `host-wp38-unfinished-notices` | unit-engine-store ×2 + unit-authoring-interface ×4 `notifyUnfinishedRuns` | 6 |
| `core-unit-resource-inheritance-runtime` | unit-resource-inheritance-runtime | 5 |
| `core-wb-018-dynamic-tail-performance` | wb-018-dynamic-tail-performance | 5 |
| `host-wp38-notice-acknowledgements` | workflow-notice-acknowledgements (`notifyUnfinishedRuns` cases) | 5 |
| `core-fast-mode` | fast-mode (config, compiler, profiles, foreach, dynamic generated tasks) | 3 |
| `core-thinking-max` | thinking-max | 3 |
| `host-wp38-board` | unit-core-runtime task list ×2, surface-regressions board identity | 3 |
| `host-wp38-surface-regressions` | surface-regressions (catch-up caps ×2, skipped dependent stage) | 3 |
| `core-built-engine-frozen-bundle-regression` | built-engine-frozen-bundle-regression (fixture copied) | 2 |
| `core-host-package-policy` | host-package-policy (Pi packages are optional peers) | 2 |
| `core-unit-test-cleanup` | unit-test-cleanup (fixture test/fixtures/core/unit-cleanup-lifecycle.mjs) | 2 |
| `core-worker-role` | worker-role (the role is the request `env`) | 1 |
| `host-wp38b-auto-launch-cancellation` | workflow-launch-cancellation `auto …` over `/aw auto` (WP38b) | 10 |
| `host-wp38b-auto-router` | workflow-router `/workflow auto` slash capture and TUI (WP38b) | 7 |
| `core-workflow-launch-cancellation` | workflow-launch-cancellation (run-scoped launch fences; WP38b: the 4 delayed-stop fence cases) | 5 |
| `host-wp38-authoring-interface` | unit-authoring-interface completions and run/dynamic arg parsing | 1 |
| `core-wb-012-public-contracts` (extended) | wb-012 docs tests ×2 and the docs/usage.md root-order half | +2 |
| `core-unit-engine-store` (extended) | "subagent launch detaches validated options from post-registration mutation" | +1 |

Each file's header lists its changes (mechanical: dist imports, WP4c module names,
`setTaskRuntimeApiForTests`, `.agent-workflow/…`, `AGENT_WORKFLOW_*`, backend id
`agent-workflow/runtime`, `/aw` hints; behavioral: listed in place).

### Superseded (36)

- fast-mode: "task launch prepares a sealed generated Fast extension only for fast:on", "generated Fast hook
  preserves payload fields, forces priority, and checks the task model" → `executor-wp35-fast-guard`
  ("provider stream: forces serviceTier priority …", "registerPiRun + wrapper …", "executor: fast config
  puts the guard state path …", "per-task descriptor: fast/fastApi only when …").
- run-estimates: "duplicate /workflow run start is blocked …", "duplicateRunGuardNotice skips …" →
  `host-wp16-guard` ("host API: identical detached launches → one run (existing) …", "Pi aw_run tool: a
  detached retry returns the existing run …"); WP16 replaced the name/task-text guard with the
  fingerprint launch guard.
- worker-role: "worker role extension startup does not resume workflow supervisors" →
  `host-pi-extension` "worker role: no agent tools and no notices …" and `host-wp28-pi-redrive`.
- unit-resource-inheritance-sdk (15 subtests) → `executor-pi-adapter` "buildPiArgv: isolation flags …"
  and `core-unit-resource-inheritance-runtime` (the policy reaches `SubmitRequest.isolation`).
- workflow-wait-tool (11): "durable wait ownership suppresses completion feedback …" →
  `host-wp33-pi-owned-wait` "aw_wait in the owning session presents the result …"; "terminal
  presentation rejects a foreign session …" → "another session cannot wait on (take) the presentation
  …"; "workflow wait does not re-present a completion won by the watcher" → "aw_wait after the message
  was delivered says so …"; "workflow wait timeout … hands delivery back …" → "a wait that times out
  leaves delivery to the tracker …"; "delivery claims enforce audience identity …" →
  `host-wp16-pi-feedback` "audience: another session never gets the message …"; "feedback watcher
  single-flights delivery and retries a failed send" → `host-wp16-pi-feedback` "aw_run tool launches
  deliver with a follow-up turn; a failed send is retried without a duplicate"; "exclusive epoch
  receipts preserve prior epochs …" → `host-wp19r2-pi-delivery` "N3: a concurrent delivery while the
  first publishes its receipt sends nothing"; "workflow wait tool registers with bounded wait guidance"
  → `host-pi-extension` "registration: …"; "cancelling workflow wait does not mutate the workflow" →
  `host-wp28-pi-waits` "cancelling aw_wait or an awaited launch cancels only the wait"; "workflow tools
  defer only when PI_WORKFLOW_TOOL_EXPOSURE=deferred" → `host-wp28-pi-exposure`; "workflow launch tools
  expose and enforce terminal wait options" → `host-wp28-pi-waits` "aw_dynamic awaitTerminal … parameter
  rules follow pi-workflow".
- surface-regressions: "RPC hasUI without custom rendering emits the board fallback" →
  `host-wp34-pi-board` "RPC and print/JSON modes keep the text behavior of /aw and /aw <run>".
- unit-authoring-interface (6): "natural-language workflow tools list and start workflows" (×2) →
  `host-pi-extension` "tools: aw_list, aw_run, aw_wait …"; "deliverMissedWorkflowFeedback does not
  auto-trigger an agent turn on startup" → `host-wp16-pi-feedback` "restart: … caught up once"
  (`triggerTurn: false`); "completion feedback is delivered only to the workflow owner session" →
  `host-wp16-pi-feedback` "audience: …"; "workflow extension skips missed completion feedback during
  session reload" → `host-wp19r3-pi-delivery` "R3: an extension reload … sends nothing extra"; "workflow
  board render clamps ANSI and wide glyphs to viewport width" → `host-wp34-pi-board` "board lists runs
  …" (every line fits 60/100/140 columns; `tui-kit` `truncateToWidth`).
- workflow-user-profiles (11) → `host-wp34-pi-profile-picker`: structured preview paging and stage
  previews → "preview rows: effective values per role …"; native preview renderer → "renderProfilePreview:
  responsive table and executor colours"; five choices/cancel, stage-edit cancellation, Esc from
  previews, Custom Esc unwinding → "Back and cancel write nothing"; Custom model/thinking focus and the
  combined editor → "Custom: per-role executor, model from the probe list and effort …"; Custom from
  the browsed profile → "workflow scope: a preset plus an edited role becomes the workflow's
  preference"; the actual profile command's Back → "/aw profile opens the picker in the TUI …".
- unit-dynamic-runtime: "workflow_dynamic tool starts spec-less direct dynamic runs" →
  `host-wp28-pi-waits` "aw_dynamic awaitTerminal waits for the launched run …".

### Not applicable (28)

- (WP38 listed 21 more here for want of `/aw auto`; WP38b ported them against WP32, see below.)
- **`/aw run|dynamic` return at start** (WP16 tracking and completion delivery, no foreground loader):
  workflow-router "cancelling a dynamic foreground launch reclaims the created run".
- **Pi extension loading belongs to the Pi executor** (docs/core-port.md "Pi executor (WP6)"; B5
  isolation, one generated per-run extension): subagent-extension-preflight, workflow-extension-isolation
  (2), wb-003 "real dry-run pack contains … pi-web-access closure" (nothing bundled, C2), unit-engine-store
  "subagent launch loads provider extensions …", "… appends extra extensions from env", "launch-bootstrap
  seals ambient extensions …", unit-dynamic-runtime "workflow_artifact generated extension wrapper …"
  (the artifact tool is the WP5 MCP server).
- **No durable presentation lease** (src/hosts/pi/feedback.ts header: the receipt is the exclusive
  per-epoch reservation; WP33's presentation lease is in process): workflow-wait-tool "workflow terminal
  wait spends one deadline across presentation and run waiting", "successful workflow wait survives
  persistent final release failure", "awaitTerminal retries feedback binding …", "awaitTerminal bind
  failure reports run id …" (the audience bind is one exclusive create).
- **No pi-workflow delivery markers; WP19 at-least-once** (agent-workflow never wrote
  `feedback-delivery.json`; WP19 review #5: a malformed or empty receipt is not proof of delivery,
  `host-wp19-pi-delivery`): workflow-wait-tool "legacy, v1, and malformed v2 delivery markers are
  permanent", "malformed receipt shape, audience, status, and timestamp are permanent", "feedback
  watcher classifies invalid delivery markers as permanent".
- **WP34 board scope** (docs/pi-host.md "Board": reads `statusAction`/`showAction`/`logsAction`, no file
  previews, no health/stall badges): unit-authoring-interface TUI thinking clamp, health inline, compact
  summaries without Health/Navigation, likely-stuck inline status, stall badge; unit-engine-store
  heartbeat-lost badge; surface-regressions preview reverse completion/disposal and hidden artifact
  views.
- **WP31 role profiles replace pi-workflow's per-stage profile settings** (docs/pi-host.md "Profile
  picker"): workflow-user-profiles "workflow picker hides paths …", "workflow picker text fallback …",
  "profile order is stable for every saved profile and unavailable built-ins", "saving a built-in keeps
  the latest persisted Custom draft".

### Product fixes found by the ports (own commits)

1. `fix(pi-host)`: a malformed or invalid notice-acknowledgement sidecar made the strict `notices list`
   throw, and the Pi session start swallowed it, so one bad sidecar silenced every unfinished-run notice.
   pi-workflow's notifier treats it as "no acknowledgements". `unfinishedRunNotice` now falls back to
   `listUnfinishedNoticesIgnoringInvalidAcknowledgements` (core `workflow-notices.ts`); the `notices`
   command still refuses the sidecar and preserves its bytes. Test: `host-wp38-notice-acknowledgements`.
2. `fix(pi-host)`: the session-start notice line now names the workflow and marks a failed run whose
   final output was rendered as `failed (final rendered — degraded)` (pi-workflow parity; read from the
   run record). Test: `host-wp38-unfinished-notices`.

Changed behavior kept (asserted as agent-workflow does it, noted in the test headers): the notices state
prunes entries of runs that are no longer unfinished notices; a catch-up in a new Pi session runtime
without readable history may resend once (WP19), so the catch-up cap test shares one session history;
`/aw` completions list only action names; a stage with inherited host tools needs free mode or a
worktree (D2).

### WP38 validation

`npm run validate` (twice) and `npm run e2e` exit 0 on the final commit; replay acceptance has 0
unexplained differences; `node tools/release/plugins.mjs check` passes. No model or agent CLI was
called. Test-only load margin: `host-wp33-pi-active-ui` "widget lists this session's active runs …"
uses 3 s fixture steps (was 800 ms), because under load averages of 20–80 (other processes on the
machine) the first run could finish before the second launch returned. Other existing timing tests
failed once each under that load and passed on rerun (`core-wp4c1-engine-runtime` prune lease,
`host-wp33-pi-parent-usage` wrap-up, `executor-codex-conformance`, `host-wp29-approve-later`,
`host-wp31-mixed-executors`). One ported case got the same kind of margin: `core-foreach-batch-runtime`
"prepared batch execution-surface drift …" schedules until both singleton fallbacks launched (a pass
can skip while the in-process supervisor holds the run lease).

## WP38b — the `auto` tests (WP32)

WP38 branched before WP32 landed `auto` (host API `autoAction`, CLI `agent-workflow auto`, Pi
`/aw auto`, MCP `workflow_auto`) and classified 21 pi-workflow cases as not applicable for want of
`/aw auto`. All 21 are now ported; no row is left on that reason. No model or agent CLI is called:
the built-in executor ids are shadowed by the workflow executor fixture, whose `autoRecommend` (and
new `autoStatus: "no-fit"`) answers the classifier call (shared harness
`test/helpers/pi-auto-harness.mjs`).

**Loader decision: added.** `/aw auto` now runs the one classifier call behind the WP33
`withForegroundLoader` in the TUI ("Comparing workflow candidates… (Esc cancels; nothing starts)");
Escape aborts the in-flight request (the signal reaches the executor's `cancel`) and starts nothing
(`phase: "cancelled"`). RPC and other modes keep the notification. Host API: `AutoRequest.compare`
(the host's wrapper of the comparison) and `signal` (now also checked right after the comparison).

workflow-launch-cancellation (14 `auto …` cases). agent-workflow launches return once the run
started, so pi-workflow's "Starting …" loader has no counterpart; the cases map to:

| pi-workflow case | Port |
|---|---|
| `auto {named,dynamic} {Escape, session invalidation} before publication …` (4) | `host-wp38b-auto-launch-cancellation`: Escape on the final confirmation, or the session ending (`session_shutdown`) while it is open; no run, no workflow submit, one classifier call |
| `uncancelled auto named launch still executes its first support action` | same file: the auto-launched named run dispatches its stage and completes |
| `auto {named,dynamic} Escape after run publication uses exact-run stop semantics` (2) | same file: `/aw stop <run>` after the launch interrupts that run; another run completes |
| `uncancelled auto dynamic launch reaches its first controller provider action` | same file: the controller task is submitted |
| `auto {named,dynamic} cancellation during directory preparation …` (2) | same file: Escape on the comparison loader cancels the in-flight classifier request (fixture `cancel` of that attempt); no choice, no run |
| `auto {named ×3 contention, dynamic} cancellation fences first dispatch while durable stop publication is delayed` (4) | `core-workflow-launch-cancellation`: the engine's `launchSignal` fence driven through `runWorkflowSpec`/`runDynamicTask` (the signal pi-workflow's start loader aborted); the deadline case asserts the durable stop intent past the 1500 ms budget instead of pi-workflow's Pi warning |

workflow-router (7 `/workflow auto` tests) → `host-wp38b-auto-router`: the v2 capture (`hostLaunchCapture`
and the recorded `launch-command.txt` of a real `/aw auto "review"`), headless fail-closed (an RPC UI
without a confirmation dialog sends nothing; `--detach` before the task is still refused), the Korean
no-transmit decline, the no-fit safe choices (Pi `select` plus the final confirmation instead of
pi-workflow's native picker; the WP32 list tags candidates `[named-workflow, …]`, so that word is not
excluded), the two transmission restrictions (nothing sent after consent; agent-workflow shows no
picker when nothing can start instead of a Cancel-only picker) and the unranked named manual
fallback (`selection.recommendation: null`).

Product changes (own commits): `feat(pi-host)` the comparison loader above (docs/pi-host.md);
`fix(pi-host)`: a session that ended (`session_shutdown`) while `/aw auto` was asking for the final
confirmation still started the chosen workflow (pi-workflow aborted its foreground auto launch on
session invalidation). The extension now aborts a per-session signal at shutdown and `/aw auto`
passes it to `autoAction`; found by the "session invalidation before publication" ports.

### WP38b validation

`npm run validate` (twice, default concurrency) and `npm run e2e` exit 0 on the final commit; replay
acceptance has 0 unexplained differences in every fixture and variant;
`node tools/release/plugins.mjs check` passes. The "session invalidation" ports fail without the
`fix(pi-host)` commit (the run starts) and pass with it. No model or agent CLI was called.

## 2026-11-01 — run-scoped experimental flags

Live finding (deep-research on Claude): the waiting CLI took over supervision of a detached run and
drove a stage without the environment the run was launched with, so an environment-variable feature
switched off mid-run. Flags that change what a run does are now decided at launch and recorded:

- `run.experimentalFlags` (experimental-speed-flags.ts `RUN_SCOPED_EXPERIMENTAL_FLAGS`):
  `AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP`, `…_CACHE_STABLE_FOREACH`, `…_SAME_SESSION_REPAIR`,
  `AGENT_WORKFLOW_PER_ITEM_DISPATCH`; an empty list when none is set; nested runs copy the parent's.
  Read sites use `runExperimentalFlagEnabled(run, name)`; runs created before keep reading the
  environment. Tool dedup reaches the artifact MCP server as `readDedup` in `artifact-access.json`
  (launch provenance derives the same bytes).
- `run.evidenceRefetch` (deep-research web quote check, `docs/bundled-workflows.md` M22).
- `AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP` and `AGENT_WORKFLOW_ADAPTIVE_LIVE_WORKERS` stay
  process-level: they pace one process's launches across runs.

Replay: `run-scoped-experimental-flags` in `test/replay/explained-differences.json` (added field only).
Tests: `core-run-scoped-flags.test.mjs`, `core-evidence-run-flag.test.mjs`.

## 2026-11-02 — fixes from the quality A/B against pi-workflow

Found by the same-model A/B (pi-workflow 0.16.4 vs agent-workflow on Pi, gpt-6.1-sol; deep-review
3 + 3 runs): agent-workflow lost no review quality (0 false positives on both sides, ~30 % cheaper),
but three executor/engine bugs showed.

- **Pi redaction of `AGENT_WORKFLOW_ROLE=worker`.** Pi redacts request env values of 6+ chars from
  persisted output; the engine's role marker made every "worker" in transcripts and answers
  `[redacted]`, so verifier quotes failed the byte check. The engine's public role env is no longer
  treated as a secret (`src/executors/redact.ts`; `executor-wp12d2-secret-echo.test.mjs`).
- **Pi answer replaced by an extension follow-up turn.** pi-web-access `web_search` with
  `includeContent` sends `web-search-content-ready` with `triggerTurn` after the answer; the reply to
  that notice became the task answer. The answer is now the message that first ended the turn
  (`docs/executors/pi.md` "Errors"; `executor-pi-parse.test.mjs`).
- **Worktree output retry (inherited from pi-workflow).** The retry task kept the worktree as its
  cwd, so `ensureManagedWorktree` used the worktree as the git root, removed it and ran
  `git worktree add` inside it (`spawnSync git ENOENT`). The retry now starts from the worktree's
  base checkout and reuses the worktree (`artifact-graph-runtime.ts` `prepareArtifactGraphRetryTask`;
  `core-worktree-output-retry.test.mjs`).
- **Tools an executor cannot provide here (B6).** Rerunning AW deep-research on Pi after the fixes
  left 7–9 claims per run `verification_blocked`: pi-web-access had `fetch_content` turned off in its
  own config, Pi dropped the name from `--tools` silently and nothing noticed. `ExecutorProbe` gains
  `unavailableTools` (tool → reason and fix); the engine refuses a run whose stages need one before
  anything starts (`core-unavailable-tools.test.mjs`), and generated stages are not offered it. The Pi
  probe lists what a worker-like session registers (exits in `session_start`, no model request).
  `agent-workflow doctor --fix [--yes]` turns such a Pi web tool back on after the user agreed
  (`docs/cli.md`).
- **Invalid JSON escapes in output sections (Antigravity A/B, 2026-11-02).** A reviewer lost its lens
  after three attempts. Its `<control>` JSON quoted regexes with backslash-u{1d400} and a backslash
  before a backtick, and a fresh-session retry saw only the first 4,000 chars of the old output, so it
  repeated the mistake. Now:
  - a section that fails `JSON.parse` is parsed again with invalid escapes and raw control characters
    made literal (`repairInvalidJsonEscapes`; repair code `json_invalid_escape` in
    `outputValidation`). No quote, comma or bracket is ever added. MetaGPT `repair_escape_error`
    does the same; qwen-code and cline fall back to jsonrepair;
  - the retry prompt shows the previous output around the error position and how to escape
    (`jsonErrorExcerpt`).
  
  On the saved attempts, the first two parse and pass the reviewer schema (7 findings); the third, an
  extra quote, still fails (`core-output-json-escape.test.mjs`).
