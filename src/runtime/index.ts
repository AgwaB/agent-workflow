// `@agwab/agent-workflow/runtime`: Pi-free runtime modules ported from
// @agwab/pi-subagent 0.7.2 (WP2a-1; see docs/runtime-port.md). The protocol
// broker (WP2b) and executor-backed run/async/reconcile (WP2a-2) come later.
import { fileURLToPath } from "node:url";

export const MODULE = "src/runtime";

export * from "./durable-launch-barrier.js";
export * from "./durable-worker-payload.js";
export * from "./process-identity.js";
export * from "./shell-environment.js";
export * from "./core/constants.js";
export * from "./core/validation.js";
export * from "./workspace/intent.js";
export * from "./workspace/worktree.js";
export {
	ARTIFACT_TYPES,
	RESULT_SCHEMA_VERSION,
	createResultEnvelope,
	mergeArtifactRefs,
	type ArtifactRef,
	type ArtifactType,
	type CompletionMetadata,
	type ResultEnvelope,
	type ResultEnvelopeInput,
	type ResultMetadata,
	type ResultSandbox,
	type ResultSessionDisposition,
	type ResultSessionMetadata,
	type ResultSessionReason,
	type ResultTmuxMetadata,
	type ResultWorkspace,
	type ToolResultBudgetMetadata,
	type WorktreeCleanupStatus,
} from "./artifacts/result.js";
export * from "./artifacts/store.js";
export * from "./artifacts/registry.js";
export * from "./artifacts/preview.js";
export * from "./orchestrate/status.js";
export * from "./orchestrate/interrupt.js";
export * from "./orchestrate/prune.js";
export {
	DEFAULT_RUN_INDEX_DIR_SEGMENTS,
	listRunLocators,
	locatorOlderThanPruneThreshold,
	pruneStaleRunLocators,
	readRunLocator,
	removeRunLocator,
	resolveRunRef,
	writeRunLocator,
	type LocatableRunRef,
	type RunLocatorListResult,
	type RunRefLocator,
	type WriteRunLocatorOptions,
} from "./orchestrate/run-ref.js";
export * from "./workers/durable-worker-binding.js";

/** Standalone runtime worker scripts shipped in `dist/runtime/workers/`. */
export const RUNTIME_WORKERS = [
	"process-gate",
	"durable-worker-binding",
] as const;
export type RuntimeWorker = (typeof RUNTIME_WORKERS)[number];

/**
 * Absolute path of a compiled runtime worker, for `spawn(process.execPath, [path, ...])`.
 * `process-gate` is a script (see its usage header); `durable-worker-binding` is a
 * library module that has no top-level effect when run directly.
 */
export function runtimeWorkerPath(worker: RuntimeWorker): string {
	if (!(RUNTIME_WORKERS as readonly string[]).includes(worker))
		throw new Error(`unknown runtime worker ${JSON.stringify(worker)}`);
	return fileURLToPath(new URL(`./workers/${worker}.js`, import.meta.url));
}
