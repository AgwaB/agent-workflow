import { resolve } from "node:path";

/**
 * A scope for in-process engine work that must finish before the process environment is restored
 * (a rehearsal swaps `AGENT_WORKFLOW_HOME` and the run-index directory; the engine resolves the state
 * root from `process.env` at every step). While a scope is open, every run the engine watches or
 * writes and every index update it queues is tagged with it, descendants (`ctx.workflow` children)
 * included. Closing it refuses new watches; the owner then drains the tagged work before restoring.
 *
 * Scopes nest like the save/restore they protect (rehearsals are serialized in-process). A host that
 * opens one swaps process-wide state, so it must not run unrelated engine work in the same process.
 */
export interface EngineScope {
	/** True once no new work may be started under the scope. */
	closed: boolean;
	/** Tagged runs, by resolved project path and run id. */
	readonly runs: Map<string, { cwd: string; runId: string }>;
}

let activeScope: EngineScope | undefined;

export function scopedRunKey(cwd: string, runId: string): string {
	return `${resolve(cwd)}\0${runId}`;
}

/** Open a scope; returns it with the function that makes the previous scope (if any) active again. */
export function openEngineScope(): {
	scope: EngineScope;
	release: () => void;
} {
	const previous = activeScope;
	const scope: EngineScope = { closed: false, runs: new Map() };
	activeScope = scope;
	return {
		scope,
		release: () => {
			if (activeScope === scope) activeScope = previous;
		},
	};
}

/** The scope new work is tagged with, if any. */
export function activeEngineScope(): EngineScope | undefined {
	return activeScope;
}

/** Tag a run with the active scope (a no-op without one). */
export function tagRunInEngineScope(cwd: string, runId: string): void {
	const scope = activeScope;
	if (scope === undefined) return;
	const key = scopedRunKey(cwd, runId);
	if (!scope.runs.has(key)) scope.runs.set(key, { cwd, runId });
}

/** True when the active scope no longer accepts new watched work. */
export function engineScopeClosed(): boolean {
	return activeScope?.closed === true;
}
