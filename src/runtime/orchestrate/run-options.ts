// Run-shape helpers shared by the synchronous and asynchronous runners (refactor 2026-11-04). Not
// re-exported from the runtime index: internal, unlike the constants run.ts re-exports from here.
import type { ExecutionMode } from "../core/constants.js";
import type { RuntimeRunInput } from "./request.js";

export const DEFAULT_PARALLEL_CONCURRENCY = 4;
export const MAX_PARALLEL_CONCURRENCY = 10;

export function parallelConcurrency(input: RuntimeRunInput): number {
	const requested = input.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
	return Math.max(1, Math.min(MAX_PARALLEL_CONCURRENCY, requested));
}

export function executionMode(input: RuntimeRunInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
}
