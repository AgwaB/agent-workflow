# Core port (WP4a, WP4b, WP4c-1, WP4c-2)

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
  the injected API may omit the barrier functions, as before) and the 15 tests marked `deferred-WP4c-2`.
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

All 15 `deferred-WP4c-2` files are ported as `test/unit/core-<name>.test.mjs` (363 node:test tests,
subtests included; plus 8 in `core-workflow-artifact-ledger-nofollow.test.mjs`). Each header lists its
changes. Beyond the mechanical renames above, only these assertions changed:

| File | Change | Reason |
|---|---|---|
| graph-schema-contracts | schema walk over `test/fixtures/core/workflow-guide-scaffolds` with `count >= 7` (was `workflows/` + `skills/workflow-guide/scaffolds`, `count > 20`) | bundled workflows arrive in WP10 (that half deferred-WP10); the scaffolds are the WP4b fixture copy |
| unit-dynamic-runtime | `launched[0].effort === "low"` (was `.thinking`) | runtime API maps `thinking` → `effort` (docs/runtime-port.md) |
| unit-dynamic-runtime | `captured[1].toolResultBudget === undefined`, plus the task's launch attempt records `configuredMaxTotalChars: 320000` (was the launch option `{maxTotalChars: 320000}`) | policy row 20: the Pi launch option is not part of the runtime API; enforcement deferred-WP6 |
| unit-dynamic-runtime | message `incompatible or stale agent-workflow engine: …` (was `pi-workflow engine`) | engine message renamed in WP4c-1 |
| unit-dynamic-runtime | built-dist child imports `dist/core/*` and registers the default fixture executor | dist layout; executor resolution at first launch |

Tests not ported (marked in place with a comment), all from unit-dynamic-runtime:

- dropped (C2/WP10, `workflow_web_*` and the fetch cache are removed): "subagent launch uses generated
  fetch cache extension by default", "subagent launch wires normalized workflow web-source tools through
  generated extension".
- deferred-WP6 (Pi extension host): "workflow_dynamic tool starts spec-less direct dynamic runs" (Pi
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
Counts after WP4c-1: ported 1, ported-WP4b 23 (prompt-schema-reliability and wb-016 complete again),
ported-WP4c1 14, deferred-WP4c-2 15 (the `unit-test-support.mjs` harness), deferred-WP6 1, deferred-WP5+ 53,
dropped 33 (140).
Counts after WP4c-2: ported 1, ported-WP4b 23, ported-WP4c1 14, ported-WP4c2 15, deferred-WP6 1,
deferred-WP5+ 53, dropped 33 (140). No file is left at a `deferred-WP4c*` status.

| pi-workflow test | Decision | Reason |
|---|---|---|
| artifact-sidecar-settlement.test.mjs | ported-WP4b (`test/unit/core-artifact-sidecar-settlement.test.mjs`) | WP4b |
| bounded-raw-link-contract.test.mjs | ported-WP4c1 (`test/unit/core-bounded-raw-link-contract.test.mjs`) | WP4c-1; paths, default executor fixture |
| built-engine-frozen-bundle-regression.test.mjs | deferred-WP6 | Pi extension tool providers in the launch options |
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
| execution-profiles.test.mjs | ported-WP10 (`test/unit/core-execution-profiles.test.mjs`) | WP10 bundled workflows; 2 deferred-WP11 (Pi host arg parsing/profile selection); launch capture reads `effort`; default fixture executor registered; 6 of 8 tests |
| fast-mode.test.mjs | deferred-WP5+ | Pi host/extension modules: workflow-fast-mode-extension; Pi/pi-subagent package |
| foreach-batch-runtime.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| graph-schema-contracts.test.mjs | ported-WP4c2 (`test/unit/core-graph-schema-contracts.test.mjs`) | WP4c-2 harness; WP10 restored the bundled `workflows/` + scaffolds schema walk (`count > 20`, as the original) |
| helper-grounding-integrity.test.mjs | ported-WP10 (`test/unit/core-helper-grounding-integrity.test.mjs`) | WP10 bundled workflows; 7 of 7 tests |
| host-package-policy.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| host-sdk-compat.test.mjs | dropped | INVENTORY: drop(Pi host package policy) |
| impact-review-enum-control-guidance.test.mjs | ported-WP10 (`test/unit/core-impact-review-enum-control-guidance.test.mjs`) | WP10 bundled workflows; 1 of 1 tests |
| impact-review-impact-fixes.test.mjs | ported-WP10 (`test/unit/core-impact-review-impact-fixes.test.mjs`) | WP10 bundled workflows; 18 of 18 tests |
| launch-slot-observer.test.mjs | ported-WP4c2 (`test/unit/core-launch-slot-observer.test.mjs`) | WP4c-2 harness |
| metrics-estimate-contracts.test.mjs | ported-WP4b (`test/unit/core-metrics-estimate-contracts.test.mjs`) | WP4b; run root path |
| nested-workflow-depth-behavior.test.mjs | ported-WP4c2 (`test/unit/core-nested-workflow-depth-behavior.test.mjs`) | WP4c-2 harness |
| no-send-controls.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
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
| review-core-fixes.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: extension |
| review-helper-byte-gates.test.mjs | ported-WP10 (`test/unit/core-review-helper-byte-gates.test.mjs`) | WP10 bundled workflows; 16 of 16 tests |
| review-helper-materialized.test.mjs | ported-WP10 (`test/unit/core-review-helper-materialized.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| review-runtime-refs-dns.test.mjs | dropped | INVENTORY: drop(refs URL probing is web-tool coupled) / unknown |
| review-runtime-retention-depth.test.mjs | ported-WP4b (`test/unit/core-review-runtime-retention-depth.test.mjs`) | WP4b; 1 of 15 dropped (spawns cli.mjs → WP11a) |
| run-estimates.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
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
| subagent-extension-preflight.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| subagent-partial-output.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| surface-regressions.test.mjs | deferred-WP5+ | cli.mjs (WP11a); Pi host/extension modules: workflow-view,extension |
| surface-rpc-readiness.test.mjs | dropped | INVENTORY: drop(Pi RPC host) |
| surface-rpc.test.mjs | dropped | INVENTORY: drop(Pi RPC host; hosts/pi e2e) |
| thinking-max.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| unit-artifact-web.test.mjs | ported-WP10 (`test/unit/core-unit-artifact-web.test.mjs`) | WP10 bundled workflows; 15 Pi-only (web-source/fetch-cache extensions, artifact extension, TUI) + 4 C2/WP10 drops; session-id and backend-handle renames; 104 of 123 tests |
| unit-authoring-interface.test.mjs | ported-WP10 (`test/unit/core-unit-authoring-interface.test.mjs`) | WP10 bundled workflows; 16 Pi host/TUI (deferred-WP11/dropped); 3 assertions changed (C2 prompt, researcher tools, agent path); 57 of 73 tests |
| unit-core-runtime.test.mjs | ported-WP10 (`test/unit/core-unit-core-runtime.test.mjs`) | WP10 bundled workflows; 2 Pi TUI; 3 C2 assertions changed (sanitizer, claim gate ×2), R#12 backoff, backend handle; 109 of 111 tests |
| unit-dynamic-runtime.test.mjs | ported-WP4c2 (`test/unit/core-unit-dynamic-runtime.test.mjs`) | WP4c-2 harness; 139 of 143 (2 dropped C2/WP10, 2 deferred-WP6), 3 assertions changed; WP10 changed the web budget, direct-dynamic v5 and launched system-prompt assertions |
| unit-engine-store.test.mjs | ported-WP10 (`test/unit/core-unit-engine-store.test.mjs`) | WP10 bundled workflows; 3 Pi host/TUI, 4 deferred-WP6/WP11 Pi extension options, 3 WP4b wrapper tamper tests; WP4c-1 literal/backoff renames; 74 of 84 tests |
| unit-model-task-runtime.test.mjs | ported-WP4c2 (`test/unit/core-unit-model-task-runtime.test.mjs`) | WP4c-2 harness |
| unit-nested-backend-refresh.test.mjs | ported-WP4c2 (`test/unit/core-unit-nested-backend-refresh.test.mjs`) | WP4c-2 harness |
| unit-resource-inheritance-compiler.test.mjs | ported-WP4b (`test/unit/core-unit-resource-inheritance-compiler.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| unit-resource-inheritance-recovery.test.mjs | ported-WP4c1 (`test/unit/core-unit-resource-inheritance-recovery.test.mjs`) | WP4c-1; agents path |
| unit-resource-inheritance-runtime.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-resource-inheritance-sdk.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| unit-split-contract.test.mjs | dropped | INVENTORY: drop(pi-workflow test bookkeeping) |
| unit-test-cleanup.test.mjs | deferred-WP5+ | no core module; port-adapted (test harness) |
| unit-unlimited-loop.test.mjs | ported-WP4c2 (`test/unit/core-unit-unlimited-loop.test.mjs`) | WP4c-2 harness |
| unlimited-supervisor.test.mjs | deferred-WP5+ | cli.mjs (WP11a) |
| verification-ontology-parity.test.mjs | ported-WP10 (`test/unit/core-verification-ontology-parity.test.mjs`) | WP10 bundled workflows; 2 of 2 tests |
| wb-001-web-provider-compat.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-002-json-path-hardening.test.mjs | ported-WP4b (`test/unit/core-wb-002-json-path-hardening.test.mjs`) | WP4b |
| wb-002-normalized-web-contract.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-003-package-closure.test.mjs | deferred-WP5+ | no core module; port-adapted (release tooling exists in agent-workflow) |
| wb-003-web-security.test.mjs | dropped | INVENTORY: drop(workflow_web_* removed in WP10) |
| wb-004-backend-lifecycle.test.mjs | ported-WP4c1 (`test/unit/core-wb-004-backend-lifecycle.test.mjs`) | WP4c-1; handle literal, setTaskRuntimeApiForTests |
| wb-005-index-durability.test.mjs | ported-WP4c1 (`test/unit/core-wb-005-index-durability.test.mjs`) | WP4c-1; run root path |
| wb-006-rate-limit-lock.test.mjs | ported-WP4c1 (`test/unit/core-wb-006-rate-limit-lock.test.mjs`) | WP4c-1; backoff file under AGENT_WORKFLOW_HOME |
| wb-007-dynamic-recovery.test.mjs | ported-WP4b (`test/unit/core-wb-007-dynamic-recovery.test.mjs`) | WP4b |
| wb-008-filesystem-security.test.mjs | ported-WP4b (`test/unit/core-wb-008-filesystem-security.test.mjs`) | WP4b |
| wb-009-workflow-policy.test.mjs | dropped | INVENTORY: drop(pi-workflow release tooling) |
| wb-012-public-contracts.test.mjs | ported-WP10 (`test/unit/core-wb-012-public-contracts.test.mjs`) | WP10 bundled workflows; 2 + half of a third deferred-WP11 (docs/usage.md); root and router assertions changed; 2 of 4 tests |
| wb-014-platform-package.test.mjs | dropped | INVENTORY: drop(pi-workflow package CI) |
| wb-016-scheduler-performance.test.mjs | ported-WP4b (`test/unit/core-wb-016-scheduler-performance.test.mjs`) | WP4b; source-scan test restored in WP4c-1 |
| wb-017-artifact-index-performance.test.mjs | ported-WP4b (`test/unit/core-wb-017-artifact-index-performance.test.mjs`) | WP4b; run root path |
| wb-018-dynamic-tail-performance.test.mjs | deferred-WP5+ | Pi host/extension modules: workflow-view |
| worker-role.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |
| workflow-active-ui.test.mjs | dropped | INVENTORY: drop(Pi TUI) |
| workflow-artifact-footprint.test.mjs | ported-WP4b (`test/unit/core-workflow-artifact-footprint.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-authoring-corrective.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-corrective.test.mjs`) | WP4b; agent path |
| workflow-authoring-gates.test.mjs | ported-WP4b (`test/unit/core-workflow-authoring-gates.test.mjs`) | WP4b; 2 of 7 dropped (cli.mjs inspect → WP11a) |
| workflow-auto-binding.test.mjs | ported-WP4b (`test/unit/core-workflow-auto-binding.test.mjs`) | WP4b; .pi→.agent-workflow paths |
| workflow-auto-negative-boundaries.test.mjs | ported-WP4c1 (`test/unit/core-workflow-auto-negative-boundaries.test.mjs`) | WP4c-1; setTaskRuntimeApiForTests, default executor fixture |
| workflow-command-actions.test.mjs | dropped | INVENTORY: drop(Pi slash command; hosts/pi) |
| workflow-contract-findings-006-008.test.mjs | ported-WP10 (`test/unit/core-workflow-contract-findings-006-008.test.mjs`) | WP10 bundled workflows; fixture helper moved to test/helpers/impact-review-fixtures.mjs; 17 of 17 tests |
| workflow-extension-isolation.test.mjs | deferred-WP5+ | Pi/pi-subagent package |
| workflow-fixture-lifecycle.test.mjs | ported-WP4c2 (`test/unit/core-workflow-fixture-lifecycle.test.mjs`) | WP4c-2 harness |
| workflow-guide-fixed-inventory.test.mjs | ported-WP4b (`test/unit/core-workflow-guide-fixed-inventory.test.mjs`) | WP4b; scaffold copied to test/fixtures/core/ |
| workflow-launch-cancellation.test.mjs | deferred-WP5+ | Pi host/extension modules: extension; Pi/pi-subagent package |
| workflow-launch-metadata.test.mjs | ported-WP4c1 (`test/unit/core-workflow-launch-metadata.test.mjs`) | WP4c-1; paths, default executor fixture |
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
| workflow-report-contracts.test.mjs | ported-WP10 (`test/unit/core-workflow-report-contracts.test.mjs`) | WP10 bundled workflows; 7 of 7 tests |
| workflow-router.test.mjs | ported-WP10 (`test/unit/core-workflow-router.test.mjs`) | WP10 bundled workflows; 8 deferred-WP11 (Pi extension: slash capture, arg parsing, TUI); no Pi theme init; 23 of 31 tests |
| workflow-user-profiles.test.mjs | ported-WP10 (`test/unit/core-workflow-user-profiles.test.mjs`) | WP10 bundled workflows; 17 Pi host profile UI/TUI (deferred-WP11 or dropped); settings home AGENT_WORKFLOW_HOME; 10 of 27 tests |
| workflow-view.test.mjs | dropped | INVENTORY: drop(Pi TUI) / port-adapted if board moves to CLI |
| workflow-wait-tool.test.mjs | deferred-WP5+ | Pi host/extension modules: extension |

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
   router's direct-dynamic catalog facts list the same tools.
5. **B4 now sees web tools.** `workflow_web_*` were never inferred as web tools; `web_search` /
   `fetch_content` are, so web stages negotiate `webTools` (degraded `safetyPolicy: unknown`, or
   refused where the executor has none / only unverified rows). The unit harness' default `pi`
   fixture executor declares `webTools` native/search+fetch (`test/helpers/register-default-executor.mjs`).

Left as is: `tool-metadata.ts` keeps the read-only/network classification of the three legacy
`workflow_web_*` names (a user spec that still lists them compiles and is refused by the adapters
before any effect, as the WP1b deep-research replay shows).

### WP10 tests

All 31 `deferred-WP5+ | bundled workflows (WP10)` files are ported as `test/unit/core-<name>.test.mjs`
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
- wb-012-public-contracts root order: bundled README global root `~/.agent-workflow/workflows/` (was `~/.pi/agent/workflows/`); docs/usage.md half dropped (deferred-WP11)
- wb-012-public-contracts: "public command and troubleshooting docs mirror runtime help" and "packaged docs have self-contained speed guardrails" not ported (deferred-WP11: docs/usage.md)
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
(deferred-WP11 or dropped with the Pi TUI: 16 authoring-interface, 2 unit-core-runtime, 3 + 4
unit-engine-store, 8 workflow-router, 17 workflow-user-profiles, 2 execution-profiles, 15
unit-artifact-web); WP4b generated-wrapper tamper tests (3, unit-engine-store); C2/WP10 drops (4,
unit-artifact-web: web-source cache sourceRef backfill ×2, fetch cache / normalized fetch ×2);
docs/usage.md (2 + half of one, wb-012, deferred-WP11).

New tests: `bundled-workflows.test.mjs` (bundled specs and scaffolds compile warning-free with the
bundled agents; no `workflow_web_`, `.pi/workflows`, `.pi/ocr-artifacts`, `PI_WORKFLOW_`,
`web-source-cache` or `mcp__workflow_artifact__` in `workflows/`, `skills/`, `agents/`; no Pi-only
capability and `allowReadOnlyDowngrade` in every bundled spec; the deep-research completion summary,
report and audit carry `SOURCE_VERIFICATION_STATEMENT`; the committed support table matches
`test/helpers/bundled-support-table.mjs`), `core-worker-prompt-render.test.mjs` (renderer per
executor, locators untouched, idempotent; the task backend sends rendered prompts with the
guidelines section and keeps canonical prompt files).

Counts after WP10: ported 1, ported-WP4b 23, ported-WP4c1 14, ported-WP4c2 15, ported-WP10 31,
deferred-WP6 1, deferred-WP5+ 22, dropped 33 (140).
