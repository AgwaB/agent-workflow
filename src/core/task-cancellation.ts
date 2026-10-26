// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 1468-1505, 2737-2867 (cancellation: exact-attempt interrupt acknowledgement, run cleanup). MIT, same author. Changes: interrupts go through the runtime API (runtime → executor.cancel(ref, "owned")).
import { loadSubagentApi } from "./runtime-port.js";
import { activeForeachBatchRecordForTask } from "./foreach-batch-runtime.js";
import { decideDurableBarrierCancellation } from "./launch-barrier-engine.js";
import {
	SUBAGENT_INTERRUPT_TIMEOUT_MS,
	SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
	awaitSubagentOperation,
	sleep,
} from "./launch-operations.js";
import { releaseLiveModelWorkerSlotForTask } from "./launch-slots.js";
import { nowIso, writeRunRecordDurable } from "./store.js";
import { getSubagentHandle } from "./task-artifacts.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";

export async function acknowledgeSubagentTaskInterrupted(
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
	const acknowledgement = await interruptSubagentTask(task, reason);
	if (barrierRecord) {
		if (!acknowledgement)
			throw new Error(
				"durable launch barrier cancellation is pending backend handle recovery",
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
		task.lastMessage = `exact backend attempt ${acknowledgement.attemptId} reached ${acknowledgement.status}`;
		await writeRunRecordDurable(cwd, run);
	}
	releaseLiveModelWorkerSlotForTask(run, task);
}

export async function cleanupSubagentRun(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	const errors: unknown[] = [];
	for (const task of run.tasks) {
		if (task.status !== "running") continue;
		const batch = activeForeachBatchRecordForTask(run, task);
		if (batch && task.foreachBatch?.role === "member") continue;
		try {
			await acknowledgeSubagentTaskInterrupted(
				cwd,
				run,
				task,
				"workflow cleanup",
			);
			task.statusDetail = "cancellation_acknowledged";
			task.lastMessage = "backend cancellation acknowledged";
		} catch (error) {
			task.statusDetail = "cancellation_failed";
			task.lastMessage = `backend cancellation failed: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			"one or more backend cancellations failed",
		);
	}
}

interface SubagentCancellationAcknowledgement {
	attemptId: string;
	status: "cancelled" | "completed" | "failed";
	observedAt: string;
	interruptStatus: "interrupt-requested" | "already-terminal";
}

const TERMINAL_SUBAGENT_ATTEMPT_STATUSES = new Set([
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
	return TERMINAL_SUBAGENT_ATTEMPT_STATUSES.has(status ?? "")
		? (status as "cancelled" | "completed" | "failed")
		: undefined;
}

export async function interruptSubagentTask(
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<SubagentCancellationAcknowledgement | undefined> {
	const handle = getSubagentHandle(task);
	if (!handle) return undefined;
	const api = await loadSubagentApi();
	const context = `task ${task.taskId} (${task.specId}) subagent run ${handle.runId}/${handle.attemptId}`;
	const result = await awaitSubagentOperation(
		() =>
			api.interruptSubagent({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
				attemptId: handle.attemptId,
				reason,
			}),
		{
			operation: "interrupt",
			context,
			timeoutMs: SUBAGENT_INTERRUPT_TIMEOUT_MS,
		},
	);
	if (result?.runId !== handle.runId)
		throw new Error(
			`subagent interruption result run ${result?.runId ?? "missing"} does not match ${handle.runId}`,
		);
	if (
		result.status !== "interrupt-requested" &&
		result.status !== "already-terminal"
	)
		throw new Error(
			`subagent interruption was not acknowledged for exact attempt ${handle.attemptId}: ${result?.status ?? "invalid-result"}`,
		);
	if (
		result.status === "interrupt-requested" &&
		!result.interruptedAttempts?.includes(handle.attemptId)
	)
		throw new Error(
			`subagent interruption acknowledged a different attempt instead of ${handle.attemptId}`,
		);

	const deadline = Date.now() + SUBAGENT_INTERRUPT_TIMEOUT_MS;
	let terminalStatus = exactTerminalAttempt(
		result.record?.attempts,
		handle.attemptId,
	);
	while (terminalStatus === undefined && Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		const snapshot = await awaitSubagentOperation(
			() =>
				api.getSubagentStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
				}),
			{
				operation: "cancellation acknowledgement status",
				context,
				timeoutMs: Math.min(SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS, remainingMs),
			},
		);
		if (snapshot !== null && snapshot.runId !== handle.runId)
			throw new Error(
				`subagent cancellation status run ${snapshot.runId} does not match ${handle.runId}`,
			);
		terminalStatus = exactTerminalAttempt(snapshot?.attempts, handle.attemptId);
		if (terminalStatus === undefined)
			await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
	}
	if (terminalStatus === undefined)
		throw new Error(
			`subagent exact attempt ${handle.attemptId} did not reach a terminal state after interruption`,
		);
	return {
		attemptId: handle.attemptId,
		status: terminalStatus,
		observedAt: nowIso(),
		interruptStatus: result.status,
	};
}
