// A task that hits its runtime limit fails closed. What the worker had written by then is kept as
// evidence next to the task (output.log + a result envelope naming it), never as a result: it is
// not validated, no control/output artifact is produced from it, and the task stays `failed`/`timeout`.
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { loadWorkerApi } from "./runtime-port.js";
import {
	WORKER_REFRESH_OPERATION_TIMEOUT_MS,
	awaitWorkerOperation,
} from "./launch-operations.js";
import { fromStatePath } from "./state-location.js";
import { nowIso } from "./store.js";
import {
	copyLogOrEmpty,
	findLog,
	safeArtifactPath,
	writeJson,
} from "./task-artifacts.js";
import type { WorkerRunStatusSnapshot } from "./runtime-port.js";
import type { WorkflowTaskRunRecord } from "./types.js";

export interface TimedOutPartialRecord {
	/** Bytes of worker output kept in the task's output file. */
	outputBytes: number;
	/** Always false: the kept text did not pass output/control validation. */
	validated: false;
}

/** Suffix naming the kept partial output in the task's failure message. */
export function timedOutPartialNote(task: WorkflowTaskRunRecord): string {
	const partial = task.timedOutPartial;
	if (!partial || partial.outputBytes <= 0) return "";
	return `; partial worker output (${partial.outputBytes} bytes, unvalidated) kept in ${task.files.output}`;
}

/**
 * Best effort and never throws: keep the worker's output of a timed-out task. Call after the
 * worker was interrupted; `snapshot` may be omitted (it is then read from the runtime).
 */
export async function preserveTimedOutPartialOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
	snapshot?: WorkerRunStatusSnapshot | null,
): Promise<void> {
	try {
		const handle = task.workerHandle;
		if (!handle) return;
		let current = snapshot ?? null;
		if (!current) {
			const api = await loadWorkerApi();
			current = await awaitWorkerOperation(
				() =>
					api.getWorkerStatus({
						cwd: handle.cwd,
						runsDir: handle.runsDir,
						runId: handle.runId,
						attemptId: handle.attemptId,
					}),
				{
					operation: "status",
					context: `timed-out task ${task.taskId} worker run ${handle.runId}/${handle.attemptId}`,
					timeoutMs: WORKER_REFRESH_OPERATION_TIMEOUT_MS,
				},
			);
		}
		if (!current) return;
		const outputRef = findLog(current, "output");
		if (!outputRef) return;
		const artifactRoot = task.workerFiles?.runsDir
			? fromStatePath(cwd, task.workerFiles.runsDir)
			: undefined;
		safeArtifactPath(current, outputRef, artifactRoot);
		const outputFile = fromStatePath(cwd, task.files.output);
		const resultFile = fromStatePath(cwd, task.files.result);
		const bytes = await copyLogOrEmpty(
			current,
			outputRef,
			outputFile,
			artifactRoot,
		);
		if (bytes <= 0) return;
		task.timedOutPartial = { outputBytes: bytes, validated: false };
		await mkdir(dirname(resultFile), { recursive: true });
		if (
			await stat(resultFile).then(
				() => true,
				() => false,
			)
		)
			return;
		await writeJson(resultFile, {
			status: "failed",
			failureKind: "timeout",
			exitCode: 124,
			startedAt: task.startedAt,
			completedAt: nowIso(),
			errorMessage: `task exceeded timeout=${task.runtime.maxRuntimeMs}`,
			noFinalOutput: false,
			timedOutPartial: {
				...task.timedOutPartial,
				outputFile: task.files.output,
			},
			worker: {
				runId: current.runId,
				attemptId: current.attemptId,
				executorId: current.executorId,
				failureKind: current.failureKind,
				metadata: { ...current.metadata, outputPartial: true },
			},
		});
	} catch {
		// Evidence only: a copy failure must never change the timeout outcome.
	}
}
