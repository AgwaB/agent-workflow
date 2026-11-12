// Automatic interruption of a run whose driver is gone (owner decision 2026-11-12).
//
// A host that is force-quit leaves its run `running` forever: nothing drives it and nothing may
// write its status. Any reader that finds such a run turns it into `interrupted` (reason
// `driver_lost`, distinct from a user stop), after which `resume` works in one step and the
// unfinished-run reminder lists it. "Clearly dead" is decided by `assessRunDriverLost`
// (store.ts): no live driver pid, a heartbeat of at least two minutes, no live lock owner.
//
// The conversion runs under the run lease taken as an *observer* (it must not stamp a fresh
// heartbeat over the evidence) and re-checks after acquiring it, so a driver that came back
// between the cheap pre-check and the lease is never overwritten: its heartbeat shows a live pid,
// or it holds the lock and the lease is not acquired at all.
import { markRunStopped } from "./run-stop-marking.js";
import {
	assessRunDriverLost,
	LEASE_STALE_MS,
	listRunRecords,
	readRunRecord,
	readWorkflowStopIntent,
	withRunLease,
	writeRunRecord,
} from "./store.js";
import { workflowTaskRunner } from "./task-launch.js";
import type { WorkflowRunRecord } from "./types.js";

export interface DriverLostOptions {
	/** Test seam: the clock the evidence is judged by. */
	nowMs?: number;
}

function hasUnfinishedDriverWork(run: WorkflowRunRecord): boolean {
	return (
		run.status === "running" &&
		(run.taskSummary.running > 0 || run.taskSummary.pending > 0)
	);
}

/** A run that could be driver-lost at all: running, work left, past the launch grace. */
function isCandidate(run: WorkflowRunRecord, nowMs: number): boolean {
	if (!hasUnfinishedDriverWork(run)) return false;
	const createdMs = Date.parse(run.createdAt);
	return !Number.isFinite(createdMs) || nowMs - createdMs > LEASE_STALE_MS;
}

/** Descendant runs of `runId` that are still `running`, deepest first (blocked ones need no driver). */
async function runningDescendants(
	cwd: string,
	runId: string,
): Promise<WorkflowRunRecord[]> {
	const records = await listRunRecords(cwd);
	const out: Array<{ run: WorkflowRunRecord; depth: number }> = [];
	const seen = new Set<string>([runId]);
	let frontier = [runId];
	for (let depth = 1; frontier.length > 0; depth += 1) {
		const next: string[] = [];
		for (const run of records) {
			if (!run.parentRunId || !frontier.includes(run.parentRunId)) continue;
			if (seen.has(run.runId)) continue;
			seen.add(run.runId);
			next.push(run.runId);
			if (run.status === "running") out.push({ run, depth });
		}
		frontier = next;
	}
	return out.sort((a, b) => b.depth - a.depth).map((entry) => entry.run);
}

/** Interrupt `run` (lease held by the caller): stop its workers, keep completed work. */
async function interruptHeldRun(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	for (const task of run.tasks) {
		if (task.status !== "running") continue;
		task.statusDetail = "cancellation_pending";
		task.lastMessage = "awaiting worker stop cancellation acknowledgement";
	}
	await writeRunRecord(cwd, run);
	let cleanupError: unknown;
	try {
		await workflowTaskRunner().cleanupRun(cwd, run);
	} catch (error) {
		cleanupError = error;
	}
	markRunStopped(run, "driver_lost");
	await writeRunRecord(cwd, run);
	if (cleanupError)
		throw new Error(
			`Could not confirm worker cancellation for ${run.runId}; worker state remains observable`,
			{ cause: cleanupError },
		);
}

async function interruptUnderLease(
	cwd: string,
	runId: string,
	nowMs: number,
	withDescendants: boolean,
): Promise<WorkflowRunRecord | undefined> {
	return withRunLease(
		cwd,
		runId,
		async () => {
			let run = await readRunRecord(cwd, runId);
			if (!isCandidate(run, nowMs)) return undefined;
			// Re-check under the lease: a driver may have come back since the pre-check.
			if (
				!(await assessRunDriverLost(cwd, runId, { nowMs, ownLock: true })).lost
			)
				return undefined;
			// A pending user stop is finished by `stop`, not relabelled here.
			if (await readWorkflowStopIntent(cwd, runId)) return undefined;
			// Keep what the workers finished while nobody was looking.
			run = await workflowTaskRunner().refreshRun(cwd, run);
			if (!isCandidate(run, nowMs)) return undefined;
			if (withDescendants) {
				const children = await runningDescendants(cwd, runId);
				// Every running child must be driverless too, or the parent is left alone.
				for (const child of children)
					if (!(await assessRunDriverLost(cwd, child.runId, { nowMs })).lost)
						return undefined;
				for (const child of children)
					if (!(await interruptUnderLease(cwd, child.runId, nowMs, false)))
						return undefined;
			}
			await interruptHeldRun(cwd, run);
			return run;
		},
		{ observer: true },
	);
}

/**
 * Interrupt `run` (a record or an id) when its driver is clearly dead. Returns the interrupted
 * record, or `undefined` when nothing was changed (not running, a driver alive, heartbeat under
 * two minutes, lock held, no driver recorded). Never throws: a read must not fail because the
 * cleanup could not finish; the next read retries.
 */
export async function interruptRunIfDriverLost(
	cwd: string,
	run: WorkflowRunRecord | string,
	options: DriverLostOptions = {},
): Promise<WorkflowRunRecord | undefined> {
	const nowMs = options.nowMs ?? Date.now();
	try {
		const current =
			typeof run === "string" ? await readRunRecord(cwd, run) : run;
		if (!isCandidate(current, nowMs)) return undefined;
		if (!(await assessRunDriverLost(cwd, current.runId, { nowMs })).lost)
			return undefined;
		return await interruptUnderLease(cwd, current.runId, nowMs, true);
	} catch {
		return undefined;
	}
}

/** Reader helper: the record as it is after a possible interruption. */
export async function readRunInterruptingDriverLost(
	cwd: string,
	run: WorkflowRunRecord,
	options: DriverLostOptions = {},
): Promise<WorkflowRunRecord> {
	return (await interruptRunIfDriverLost(cwd, run, options)) ?? run;
}

/** Project-wide pass for list-style readers: every top-level running run with a dead driver. */
export async function interruptDriverLostRuns(
	cwd: string,
	options: DriverLostOptions = {},
): Promise<string[]> {
	const nowMs = options.nowMs ?? Date.now();
	const interrupted: string[] = [];
	let runs: WorkflowRunRecord[];
	try {
		runs = await listRunRecords(cwd);
	} catch {
		return interrupted;
	}
	for (const run of runs) {
		if (run.parentRunId || !isCandidate(run, nowMs)) continue;
		if (await interruptRunIfDriverLost(cwd, run, { nowMs }))
			interrupted.push(run.runId);
	}
	return interrupted;
}
