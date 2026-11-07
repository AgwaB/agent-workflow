// Interrupts go through the runtime to the executor with owned scope.
import { loadWorkerApi } from "./runtime-port.js";
import { activeForeachBatchRecordForTask } from "./foreach-batch-runtime.js";
import { decideDurableBarrierCancellation } from "./launch-barrier-engine.js";
import {
	WORKER_INTERRUPT_TIMEOUT_MS,
	WORKER_REFRESH_OPERATION_TIMEOUT_MS,
	awaitWorkerOperation,
	sleep,
} from "./launch-operations.js";
import { releaseLiveModelWorkerSlotForTask } from "./launch-slots.js";
import { nowIso, writeRunRecordDurable } from "./store.js";
import { getWorkerHandle } from "./task-artifacts.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";

export async function acknowledgeWorkerTaskInterrupted(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<void> {
	const barrierRecord = await decideDurableBarrierCancellation(
		cwd,
		run,
		task,
		reason,
	);
	if (barrierRecord?.phase === "cancellation_acknowledged") {
		releaseLiveModelWorkerSlotForTask(run, task);
		return;
	}
	const acknowledgement = await interruptWorkerTask(task, reason);
	if (barrierRecord) {
		if (!acknowledgement)
			throw new Error(
				"durable launch barrier cancellation is pending worker handle recovery",
			);
		if (!barrierRecord.cancellation)
			throw new Error(
				"durable launch barrier cancellation evidence is unavailable",
			);
		barrierRecord.cancellation.interruptStatus =
			acknowledgement.interruptStatus;
		barrierRecord.cancellation.terminalAttemptId = acknowledgement.attemptId;
		barrierRecord.cancellation.terminalStatus = acknowledgement.status;
		barrierRecord.cancellation.terminalObservedAt = acknowledgement.observedAt;
		barrierRecord.phase = "cancellation_acknowledged";
		task.statusDetail = "cancellation_acknowledged";
		task.lastMessage = `exact worker attempt ${acknowledgement.attemptId} reached ${acknowledgement.status}`;
		await writeRunRecordDurable(cwd, run);
	}
	releaseLiveModelWorkerSlotForTask(run, task);
}

export async function cleanupWorkerRun(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	const errors: unknown[] = [];
	for (const task of run.tasks) {
		if (task.status !== "running") continue;
		const batch = activeForeachBatchRecordForTask(run, task);
		if (batch && task.foreachBatch?.role === "member") continue;
		try {
			await acknowledgeWorkerTaskInterrupted(
				cwd,
				run,
				task,
				"workflow cleanup",
			);
			task.statusDetail = "cancellation_acknowledged";
			task.lastMessage = "worker cancellation acknowledged";
		} catch (error) {
			task.statusDetail = "cancellation_failed";
			task.lastMessage = `worker cancellation failed: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "one or more worker cancellations failed");
	}
}

interface WorkerCancellationAcknowledgement {
	attemptId: string;
	status: "cancelled" | "completed" | "failed";
	observedAt: string;
	interruptStatus: "interrupt-requested" | "already-terminal" | "unsupported";
}

const TERMINAL_WORKER_ATTEMPT_STATUSES = new Set([
	"cancelled",
	"completed",
	"failed",
]);

function exactTerminalAttempt(
	attempts: Array<{ attemptId?: string; status?: string }> | undefined,
	attemptId: string,
): "cancelled" | "completed" | "failed" | undefined {
	const status = attempts?.find(
		(attempt) => attempt.attemptId === attemptId,
	)?.status;
	return TERMINAL_WORKER_ATTEMPT_STATUSES.has(status ?? "")
		? (status as "cancelled" | "completed" | "failed")
		: undefined;
}

export async function interruptWorkerTask(
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<WorkerCancellationAcknowledgement | undefined> {
	const handle = getWorkerHandle(task);
	if (!handle) return undefined;
	const api = await loadWorkerApi();
	const context = `task ${task.taskId} (${task.specId}) worker run ${handle.runId}/${handle.attemptId}`;
	const result = await awaitWorkerOperation(
		() =>
			api.interruptWorker({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
				attemptId: handle.attemptId,
				reason,
			}),
		{
			operation: "interrupt",
			context,
			timeoutMs: WORKER_INTERRUPT_TIMEOUT_MS,
		},
	);
	if (result?.runId !== handle.runId)
		throw new Error(
			`worker interruption result run ${result?.runId ?? "missing"} does not match ${handle.runId}`,
		);
	// `unsupported` means the runtime found no live process to signal for the attempt, e.g. a
	// worker that is already exiting by itself after a launch-barrier revoke. It is accepted only
	// if the exact attempt then reaches a terminal state within the deadline below; otherwise the
	// same "did not reach a terminal state" error is raised. A cancellation is never claimed for an
	// attempt that did not terminate.
	if (
		result.status !== "interrupt-requested" &&
		result.status !== "already-terminal" &&
		result.status !== "unsupported"
	)
		throw new Error(
			`worker interruption was not acknowledged for exact attempt ${handle.attemptId}: ${result?.status ?? "invalid-result"}`,
		);
	const notAcknowledged = () =>
		new Error(
			`worker interruption was not acknowledged for exact attempt ${handle.attemptId}: ${result.status}`,
		);
	if (result.status === "unsupported") {
		if (!result.unsupportedAttempts?.includes(handle.attemptId))
			throw new Error(
				`worker interruption reported unsupported for a different attempt instead of ${handle.attemptId}`,
			);
		// WB-004: unsupported is never an acknowledgement by itself; without a status API there
		// is no way to observe termination, so fail exactly as before.
		if (typeof api.getWorkerStatus !== "function") throw notAcknowledged();
	}
	if (
		result.status === "interrupt-requested" &&
		!result.interruptedAttempts?.includes(handle.attemptId)
	)
		throw new Error(
			`worker interruption acknowledged a different attempt instead of ${handle.attemptId}`,
		);

	const deadline = Date.now() + WORKER_INTERRUPT_TIMEOUT_MS;
	let terminalStatus = exactTerminalAttempt(
		result.record?.attempts,
		handle.attemptId,
	);
	while (terminalStatus === undefined && Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		const snapshot = await awaitWorkerOperation(
			async () => {
				// A signalled worker can exit before publishing its result/finalizer.
				// Like normal refresh, recover only after identity-checked ownership
				// drains; a passive status read alone would stay running forever.
				if (typeof api.reconcileWorkerRun === "function")
					await api.reconcileWorkerRun({
						cwd: handle.cwd,
						runsDir: handle.runsDir,
						runId: handle.runId,
						expectedAttemptId: handle.attemptId,
					});
				return api.getWorkerStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
					attemptId: handle.attemptId,
				});
			},
			{
				operation: "cancellation acknowledgement status",
				context,
				timeoutMs: Math.min(WORKER_REFRESH_OPERATION_TIMEOUT_MS, remainingMs),
			},
		);
		if (snapshot !== null && snapshot.runId !== handle.runId)
			throw new Error(
				`worker cancellation status run ${snapshot.runId} does not match ${handle.runId}`,
			);
		terminalStatus = exactTerminalAttempt(snapshot?.attempts, handle.attemptId);
		if (terminalStatus === undefined)
			await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
	}
	if (terminalStatus === undefined) {
		if (result.status === "unsupported") throw notAcknowledged();
		throw new Error(
			`worker exact attempt ${handle.attemptId} did not reach a terminal state after interruption`,
		);
	}
	return {
		attemptId: handle.attemptId,
		status: terminalStatus,
		observedAt: nowIso(),
		interruptStatus: result.status,
	};
}
