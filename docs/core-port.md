# Core port (WP4a, WP4b, WP4c-1)

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

Left unchanged on purpose (not paths or env vars; flagged for later WPs):

- `launch-session.ts` session ids keep the `pi-workflow.<runId>.<taskId>` / `piwf.<digest>` prefix
  (WP4c/WP6).
- The bundled direct-dynamic spec in `dynamic-runtime-bundle.ts` still lists the `workflow_web_*` tools
  that WP10 removes. Changing it would need a new `DIRECT_DYNAMIC_RUNTIME_VERSION`, because the module
  refuses to rewrite an existing versioned bundle.
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
wrapper for such a task.

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
  - Re-home the fast-mode provider guard on `fast-tier.ts` config.
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

### For later WPs

- **WP4c-2:** port `unit-test-support.mjs` (its fake SubagentApi plugs into `setTaskRuntimeApiForTests`;
  the injected API may omit the barrier functions, as before) and the 15 tests marked `deferred-WP4c-2`.
  Runs created with `createRunRecord` get the default executor at first launch, so register a descriptor
  as `pi` (see `register-default-executor.mjs`).
- **WP1b:** replay compares the renamed literals above (session ids, worktree branch, handle, backend id,
  record sources); add them to the allowed-difference list.
- **WP5:** write `deliveryUnverified: true` ledger rows when delivery cannot be verified.
- **WP6:** the Pi rows above; register the `pi` descriptor; report the auth kind through
  `setExecutorAuthKindProbe`; implement `deleteOwnedSession` for kept sessions; honor
  `runtime.inheritHostTools` with the native-host wrapper (provenance requires it).
- **WP11a/WP11b:** expose `--executor`; move `WORKFLOW_HELP` into the Pi host.

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
3. A test is `deferred-WP5+` when it needs bundled workflows (WP10), `cli.mjs` (WP11a), Pi host or extension
   modules, or Pi packages.
4. A test is `deferred-WP4c` when it needs `engine` / `subagent-backend` / `workflow-router` /
   `workflow-parent-usage` / `index` / `engine-wait`, or the `unit-test-support.mjs` harness (fake
   SubagentApi + engine).
5. Everything else is `deferred-WP4b`.

Counts after WP4a: ported 1, deferred-WP4b 20, deferred-WP4c 32, deferred-WP5+ 54, dropped 33.
Counts after WP4b: ported 1, ported-WP4b 23 (the 20 deferred-WP4b files plus prompt-schema-reliability,
wb-016-scheduler-performance and review-runtime-retention-depth, each minus the one test that needs
engine.ts or cli.mjs), deferred-WP4c 30, deferred-WP5+ 53, dropped 33.

| pi-workflow test | Decision | Reason |
|---|---|---|
| artifact-sidecar-settlement.test.mjs | ported-WP4b (`test/unit/core-artifact-sidecar-settlement.test.mjs`) | WP4b |
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
| dynamic-fanout-requestid.test.mjs | ported-WP4b (`test/unit/core-dynamic-fanout-requestid.test.mjs`) | WP4b |
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
| metrics-estimate-contracts.test.mjs | ported-WP4b (`test/unit/core-metrics-estimate-contracts.test.mjs`) | WP4b; run root path |
| nested-workflow-depth-behavior.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| no-send-controls.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| normalized-provider-corrective.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| optional-output-sections.test.mjs | ported-WP4b (`test/unit/core-optional-output-sections.test.mjs`) | WP4b; run root path |
| parent-usage-retention.test.mjs | deferred-WP4c | needs workflow-parent-usage |
| partial-output-literal-preservation.test.mjs | ported-WP4b (`test/unit/core-partial-output-literal-preservation.test.mjs`) | WP4b |
| pi-agent-dir.test.mjs | dropped | INVENTORY: drop(Pi config dir; hosts/pi only) |
| product-corrective-11.test.mjs | dropped | INVENTORY: drop(web fetch cache removed in WP10) |
| product-corrective-12.test.mjs | dropped | INVENTORY: drop(web provider removed in WP10) |
| prompt-schema-reliability.test.mjs | ported-WP4b (`test/unit/core-prompt-schema-reliability.test.mjs`) | WP4b; 1 of 6 dropped (reads src/engine.ts → WP4c) |
| raw-artifact-read-roundtrip.test.mjs | deferred-WP4c | needs subagent-backend |
| release-gates.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| release-provenance.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling; agent-workflow has its own) |
| required-artifact-read-completeness.test.mjs | deferred-WP4c | needs subagent-backend |
| review-core-fixes.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: extension |
| review-helper-byte-gates.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| review-helper-materialized.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| review-runtime-refs-dns.test.mjs | dropped | INVENTORY: drop(refs URL probing is web-tool coupled) / unknown |
| review-runtime-retention-depth.test.mjs | ported-WP4b (`test/unit/core-review-runtime-retention-depth.test.mjs`) | WP4b; 1 of 15 dropped (spawns cli.mjs → WP11a) |
| run-estimates.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| run-usage-rollup.test.mjs | ported-WP4b (`test/unit/core-run-usage-rollup.test.mjs`) | WP4b |
| runtime-bundled-api-boundary.test.mjs | dropped | INVENTORY: drop(pi-subagent bundling) |
| runtime-refs-transport-boundary.test.mjs | dropped | INVENTORY: drop(web-coupled) / unknown |
| runtime-storage-boundaries.test.mjs | deferred-WP4c | needs subagent-backend |
| runtime-transport-boundaries.test.mjs | dropped | INVENTORY: drop(web transport removed in WP10) |
| spec-requirement-coverage.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| spec-review-live-spec-correction.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| store-final-review-regression.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| store-lease-contention.test.mjs | deferred-WP4c | needs workflow-parent-usage |
| store-lease-handoff.test.mjs | ported-WP4b (`test/unit/core-store-lease-handoff.test.mjs`) | WP4b |
| store-lock-corrective.test.mjs | ported-WP4b (`test/unit/core-store-lock-corrective.test.mjs`) | WP4b |
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
| unit-resource-inheritance-compiler.test.mjs | ported-WP4b (`test/unit/core-unit-resource-inheritance-compiler.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| unit-resource-inheritance-recovery.test.mjs | deferred-WP4c | needs engine |
| unit-resource-inheritance-runtime.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-resource-inheritance-sdk.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-split-contract.test.mjs | dropped | INVENTORY: drop(pi-workflow test bookkeeping) |
| unit-test-cleanup.test.mjs | deferred-WP5+ | no core module; port-adapted (test harness) |
| unit-unlimited-loop.test.mjs | deferred-WP4c | needs  (+unit-test-support harness: fake SubagentApi/engine) |
| unlimited-supervisor.test.mjs | deferred-WP5+ | cli.mjs (WP11a) |
| verification-ontology-parity.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| wb-001-web-provider-compat.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-002-json-path-hardening.test.mjs | ported-WP4b (`test/unit/core-wb-002-json-path-hardening.test.mjs`) | WP4b |
| wb-002-normalized-web-contract.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-003-package-closure.test.mjs | deferred-WP5+ | no core module; port-adapted (release tooling exists in agent-workflow) |
| wb-003-web-security.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-004-backend-lifecycle.test.mjs | deferred-WP4c | needs subagent-backend |
| wb-005-index-durability.test.mjs | deferred-WP4c | needs engine |
| wb-006-rate-limit-lock.test.mjs | deferred-WP4c | needs subagent-backend |
| wb-007-dynamic-recovery.test.mjs | ported-WP4b (`test/unit/core-wb-007-dynamic-recovery.test.mjs`) | WP4b |
| wb-008-filesystem-security.test.mjs | ported-WP4b (`test/unit/core-wb-008-filesystem-security.test.mjs`) | WP4b |
| wb-009-workflow-policy.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| wb-012-public-contracts.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| wb-014-platform-package.test.mjs | dropped | INVENTORY: drop(pi-workflow package CI) |
| wb-016-scheduler-performance.test.mjs | ported-WP4b (`test/unit/core-wb-016-scheduler-performance.test.mjs`) | WP4b; 1 of 3 dropped (reads engine/subagent-backend source → WP4c) |
| wb-017-artifact-index-performance.test.mjs | ported-WP4b (`test/unit/core-wb-017-artifact-index-performance.test.mjs`) | WP4b; run root path |
| wb-018-dynamic-tail-performance.test.mjs | deferred-WP5+ | Pi host/extension modules: workflow-view |
| worker-role.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| workflow-active-ui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-artifact-footprint.test.mjs | ported-WP4b (`test/unit/core-workflow-artifact-footprint.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-authoring-corrective.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-corrective.test.mjs`) | WP4b; agent path |
| workflow-authoring-gates.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-gates.test.mjs`) | WP4b; 2 of 7 dropped (cli.mjs inspect → WP11a) |
| workflow-auto-binding.test.mjs | ported-WP4b (`test/unit/core-workflow-auto-binding.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-auto-negative-boundaries.test.mjs | deferred-WP4c | needs workflow-router,subagent-backend |
| workflow-command-actions.test.mjs | dropped | INVENTORY: drop(Pi slash command; hosts/pi) |
| workflow-contract-findings-006-008.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| workflow-extension-isolation.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| workflow-fixture-lifecycle.test.mjs | deferred-WP4c | needs engine (+unit-test-support harness: fake SubagentApi/engine) |
| workflow-guide-fixed-inventory.test.mjs | ported-WP4b (`test/unit/core-workflow-guide-fixed-inventory.test.mjs`) | WP4b; scaffold copied to test/fixtures/core/ |
| workflow-launch-cancellation.test.mjs | deferred-WP5+ | Pi host/extension modules: extension; Pi/pi-subagent package |
| workflow-launch-metadata.test.mjs | deferred-WP4c | needs engine |
| workflow-mtbyqwu0-security.test.mjs | ported-WP4b (`test/unit/core-workflow-mtbyqwu0-security.test.mjs`) | WP4b |
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
| workflow-profile-routing-compat.test.mjs | ported-WP4b (`test/unit/core-workflow-profile-routing-compat.test.mjs`) | WP4b; AGENT_WORKFLOW_HOME |
| workflow-profile-tui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-report-contracts.test.mjs | deferred-WP5+ | bundled workflows (WP10) |
| workflow-router.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi host/extension modules: extension; Pi/pi-subagent package |
| workflow-user-profiles.test.mjs | deferred-WP5+ | bundled workflows (WP10); Pi host/extension modules: extension,workflow-profile-ui,workflow-profile-tui |
| workflow-view.test.mjs | dropped | INVENTORY: drop(Pi TUI) / port-adapted if board moves to CLI |
| workflow-wait-tool.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
