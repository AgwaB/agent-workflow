// New in agent-workflow (WP12a, owner decision D3 + plan R#10): worker CLI sessions are not kept by
// default. The engine asks an executor to keep a session only when a task may still need it
// (experimental same-session output repair), and releases every session an executor reported as
// owned (`task.ownedSessions`) as soon as no attempt can use it again:
//   - a task that completed or was skipped releases its sessions immediately;
//   - a run that ends completed or failed releases every remaining session;
//   - blocked and interrupted runs (and their failed/blocked/interrupted tasks) keep theirs until
//     the run is resolved or pruned.
// Only locators recorded in `task.ownedSessions` are ever passed to `executor.deleteOwnedSession`.
import { loadExecutor } from "../sdk/descriptor.js";
import {
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import { deriveWorkflowStatus, nowIso, summarizeTasks } from "./store.js";
import type {
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
): boolean {
	return (
		task.artifactGraph?.enabled === true &&
		workflowExperimentalFlagEnabled(EXPERIMENTAL_SAME_SESSION_REPAIR_ENV, env)
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
	const descriptor = run.executor?.descriptor;
	let deleteOwnedSession:
		| ((
				session: Pick<WorkflowTaskOwnedSessionRecord, "kind" | "locator">,
		  ) => Promise<string>)
		| undefined;
	let loadError: string | undefined;
	if (descriptor === undefined) loadError = "run records no executor";
	else {
		try {
			const executor = await loadExecutor(descriptor);
			if (typeof executor.deleteOwnedSession === "function")
				deleteOwnedSession = (session) =>
					(
						executor.deleteOwnedSession as NonNullable<
							typeof executor.deleteOwnedSession
						>
					)({ kind: session.kind, locator: session.locator });
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
		}
	}
	for (const session of work) {
		const at = nowIso();
		if (loadError !== undefined) {
			session.release = { at, outcome: "failed", error: loadError };
			continue;
		}
		if (descriptor !== undefined && session.executorId !== descriptor.id) {
			session.release = {
				at,
				outcome: "refused",
				error: `session belongs to executor ${session.executorId}, not ${descriptor.id}`,
			};
			continue;
		}
		if (deleteOwnedSession === undefined) {
			session.release = { at, outcome: "unsupported" };
			continue;
		}
		try {
			const outcome = await deleteOwnedSession(session);
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

/** True when the session is gone (deleted by the engine or already absent). */
export function ownedSessionReleased(
	session: WorkflowTaskOwnedSessionRecord,
): boolean {
	return (
		session.release?.outcome === "deleted" ||
		session.release?.outcome === "not_found"
	);
}
