import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { stopRun } from "../../dist/core/engine.js";
import { getWorkerHandle } from "../../dist/core/task-artifacts.js";
import { readRunEvents, runPaths } from "../../dist/runtime/artifacts/index.js";
import { acquireDirectoryLock } from "../../dist/runtime/artifacts/dir-lock.js";
import {
	flushPendingIndexUpdatesForTests,
	isTerminalWorkflowStatus,
	listRunRecords,
	readRunRecord,
	withRunLease,
} from "../../dist/core/store.js";

export async function withWorkflowFixtureLease(cwd, runId, action) {
	const deadline = performance.now() + 5000;
	for (;;) {
		const result = await withRunLease(cwd, runId, async (signal) => ({
			value: await action(signal),
		}));
		if (result) return result.value;
		assert.ok(
			performance.now() < deadline,
			`fixture scheduler lease did not drain: ${runId}`,
		);
		await sleep(10);
	}
}

// Call before resetting fake workers or deleting a fixture, including failure paths.
export async function drainWorkflowFixture(cwd, runId) {
	const run = await readRunRecord(cwd, runId);
	if (!isTerminalWorkflowStatus(run.status))
		await stopRun(cwd, runId).catch(async (error) => {
			// 2026-11-12 (CI 43174022375, ubuntu Node 22): the run can settle between the read and the
			// stop; a run that is terminal now needs no stop. Anything else still fails the drain.
			if (!isTerminalWorkflowStatus((await readRunRecord(cwd, runId)).status))
				throw error;
		});
	// Terminal task status can be persisted before the scheduling lease unwinds.
	await withWorkflowFixtureLease(cwd, runId, async () => {});
	await flushPendingIndexUpdatesForTests(cwd);
}

// For real fixture executors: terminal status precedes the finalizer's event append and lock
// release. Drain every run (including launches whose test threw) before removing its code/root.
export async function drainWorkflowProject(cwd) {
	for (const run of await listRunRecords(cwd)) {
		await drainWorkflowFixture(cwd, run.runId);
		const settled = await readRunRecord(cwd, run.runId);
		// stopRun can clear a task's handle after acknowledging cancellation; retain its owner.
		const refs = new Map();
		for (const task of [...run.tasks, ...settled.tasks]) {
			const ref = getWorkerHandle(task);
			if (ref) refs.set(`${ref.cwd}/${ref.runId}/${ref.attemptId}`, ref);
		}
		for (const ref of refs.values()) {
			const deadline = performance.now() + 30_000;
			for (;;) {
				const events = await readRunEvents(ref, Infinity);
				if (
					events.some(
						(event) =>
							event.attemptId === ref.attemptId &&
							/^attempt\.(completed|cancelled|failed)$/u.test(event.type),
					)
				)
					break;
				assert.ok(
					performance.now() < deadline,
					`fixture finalizer did not publish: ${ref.runId}/${ref.attemptId}`,
				);
				await sleep(25);
			}
			const release = await acquireDirectoryLock(runPaths(ref).lockPath, {
				retries: 1200,
				retryMs: 25,
			});
			await release();
		}
	}
}
