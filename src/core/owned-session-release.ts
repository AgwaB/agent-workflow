// New in agent-workflow (WP12a, owner decision D3 + plan R#10): worker CLI sessions are not kept by
// default. The engine asks an executor to keep a session only when a task may still need it
// (experimental same-session output repair), and releases every session an executor reported as
// owned (`task.ownedSessions`) as soon as no attempt can use it again:
//   - a task that completed or was skipped releases its sessions immediately;
//   - a run that ends completed or failed releases every remaining session;
//   - blocked and interrupted runs (and their failed/blocked/interrupted tasks) keep theirs until
//     the run is resolved or pruned.
// Only locators recorded in `task.ownedSessions` are ever passed to `executor.deleteOwnedSession`.
// WP31 (Q4): in a mixed run each session is released through the executor that reported it
// (`session.executorId`, descriptor from run.executor or run.roleExecution.executors).
import { loadExecutor } from "../sdk/descriptor.js";
import {
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	runExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import { deriveWorkflowStatus, nowIso, summarizeTasks } from "./store.js";
import type {
	WorkflowRunExecutorSelection,
	WorkflowRunRecord,
	WorkflowTaskOwnedSessionRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

/**
 * D3: whether this attempt asks the executor to keep its CLI session. Only same-session output
 * repair (experimental, `AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`) ever continues a kept
 * session, so only then do artifact-graph attempts keep theirs (as pi-workflow did; the engine
 * releases them when the task or run ends). Without the flag no attempt keeps a session: output
 * repairs, launch retries and resumes always start a fresh one.
 */
export function workflowTaskKeepsSession(
	task: Pick<WorkflowTaskRunRecord, "artifactGraph">,
	env: Record<string, string | undefined> = process.env,
	run?: { readonly experimentalFlags?: readonly string[] },
): boolean {
	return (
		task.artifactGraph?.enabled === true &&
		runExperimentalFlagEnabled(run, EXPERIMENTAL_SAME_SESSION_REPAIR_ENV, env)
	);
}

/** Sessions of this task no later attempt can use, given the run's derived status. */
function releasableSessions(
	task: WorkflowTaskRunRecord,
	runTerminal: boolean,
): WorkflowTaskOwnedSessionRecord[] {
	const pending = (task.ownedSessions ?? []).filter(
		(session) => session.release === undefined,
	);
	if (pending.length === 0) return [];
	if (runTerminal) return pending;
	return task.status === "completed" || task.status === "skipped"
		? pending
		: [];
}

/**
 * Delete the engine-owned worker sessions that no attempt can use again (see the file header).
 * Mutates `run` (each handled entry gets `release`); returns whether anything changed. Never
 * throws: a failed deletion is recorded and left to `prune`.
 */
export async function releaseUnneededOwnedSessions(
	run: WorkflowRunRecord,
): Promise<boolean> {
	const status = deriveWorkflowStatus(summarizeTasks(run.tasks));
	const runTerminal = status === "completed" || status === "failed";
	const work = run.tasks.flatMap((task) =>
		releasableSessions(task, runTerminal),
	);
	if (work.length === 0) return false;
	const loaded = new Map<string, Promise<LoadedReleaser>>();
	const releaserFor = (executorId: string): Promise<LoadedReleaser> => {
		let entry = loaded.get(executorId);
		if (entry === undefined) {
			entry = loadReleaser(run, executorId);
			loaded.set(executorId, entry);
		}
		return entry;
	};
	for (const session of work) {
		const at = nowIso();
		// WP31 (Q4): a mixed run releases each session through the executor that owns it.
		const releaser = await releaserFor(session.executorId);
		if (releaser.kind === "load-error") {
			session.release = { at, outcome: "failed", error: releaser.error };
			continue;
		}
		if (releaser.kind === "foreign") {
			session.release = { at, outcome: "refused", error: releaser.error };
			continue;
		}
		if (releaser.deleteOwnedSession === undefined) {
			session.release = { at, outcome: "unsupported" };
			continue;
		}
		try {
			const outcome = await releaser.deleteOwnedSession(session);
			session.release =
				outcome === "deleted" ||
				outcome === "not_found" ||
				outcome === "refused" ||
				outcome === "failed"
					? { at, outcome }
					: { at, outcome: "failed", error: `unexpected result ${outcome}` };
		} catch (error) {
			session.release = {
				at,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return true;
}

type LoadedReleaser =
	| { kind: "load-error"; error: string }
	| { kind: "foreign"; error: string }
	| {
			kind: "ready";
			deleteOwnedSession?: (
				session: Pick<WorkflowTaskOwnedSessionRecord, "kind" | "locator">,
			) => Promise<string>;
	  };

/** The run's descriptor for `executorId` (the run's executor or, WP31, another of a mixed run). */
export function runExecutorSelectionFor(
	run: Pick<WorkflowRunRecord, "executor" | "roleExecution">,
	executorId: string,
): WorkflowRunExecutorSelection | undefined {
	if (run.executor?.id === executorId) return run.executor;
	const executors = run.roleExecution?.executors ?? {};
	return Object.hasOwn(executors, executorId)
		? executors[executorId]
		: undefined;
}

async function loadReleaser(
	run: WorkflowRunRecord,
	executorId: string,
): Promise<LoadedReleaser> {
	const primary = run.executor?.descriptor;
	if (primary === undefined)
		return { kind: "load-error", error: "run records no executor" };
	const selection = runExecutorSelectionFor(run, executorId);
	if (selection === undefined)
		return {
			kind: "foreign",
			error: `session belongs to executor ${executorId}, not ${primary.id}`,
		};
	try {
		const executor = await loadExecutor(selection.descriptor);
		if (typeof executor.deleteOwnedSession !== "function")
			return { kind: "ready" };
		const remove = executor.deleteOwnedSession.bind(executor);
		return {
			kind: "ready",
			deleteOwnedSession: (session) =>
				remove({ kind: session.kind, locator: session.locator }),
		};
	} catch (error) {
		return {
			kind: "load-error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** True when the session is gone (deleted by the engine or already absent). */
export function ownedSessionReleased(
	session: WorkflowTaskOwnedSessionRecord,
): boolean {
	return (
		session.release?.outcome === "deleted" ||
		session.release?.outcome === "not_found"
	);
}
