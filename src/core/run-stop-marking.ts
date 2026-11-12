// Marking a run's unfinished tasks `interrupted`: shared by a user `stop` (engine.ts) and the
// automatic interruption of a run whose driver process is gone (driver-lost.ts).
import {
	isActiveForeachBatchPhase,
	markForeachBatchStopped,
} from "./foreach-batch-runtime.js";
import { setTaskTerminal } from "./store.js";
import type { WorkflowRunRecord } from "./types.js";

/**
 * Task `statusDetail` of a run interrupted because the process driving it ended (its host was
 * closed or killed). A user stop uses `workflow_stopped`; the two read differently to people.
 */
export const DRIVER_LOST_STATUS_DETAIL = "driver_lost";
export const DRIVER_LOST_TASK_MESSAGE =
	"Workflow stopped: the process running it ended";
/** The run-level sentence (CLI card; the dashboard says the same). */
export const DRIVER_LOST_RUN_SENTENCE =
	"Stopped: the process running it ended (its host was closed). Completed work is kept. Resume to continue.";

/** An interrupted run that the engine interrupted itself after losing its driver (not a user stop). */
export function isDriverLostRun(
	run: Pick<WorkflowRunRecord, "status" | "tasks">,
): boolean {
	return (
		run.status === "interrupted" &&
		run.tasks.some((task) => task.statusDetail === DRIVER_LOST_STATUS_DETAIL) &&
		!run.tasks.some((task) => task.statusDetail === "workflow_stopped")
	);
}

export type RunStopReason = "user" | "driver_lost";

/** Interrupt every unfinished task of `run`; returns their ids. Completed work is untouched. */
export function markRunStopped(
	run: WorkflowRunRecord,
	reason: RunStopReason = "user",
): string[] {
	const statusDetail =
		reason === "driver_lost" ? DRIVER_LOST_STATUS_DETAIL : "workflow_stopped";
	const lastMessage =
		reason === "driver_lost"
			? DRIVER_LOST_TASK_MESSAGE
			: "Workflow stopped by user request";
	const interruptedTaskIds: string[] = [];
	for (const task of run.tasks) {
		const durableBarrierRecord = task.durableLaunchBarrier?.records.at(-1);
		if (
			task.status === "running" &&
			(task.statusDetail === "cancellation_failed" ||
				(durableBarrierRecord !== undefined &&
					durableBarrierRecord.phase !== "cancellation_acknowledged"))
		)
			continue;
		if (
			setTaskTerminal(task, "interrupted", statusDetail, {
				exitCode: 130,
				lastMessage,
			})
		) {
			interruptedTaskIds.push(task.taskId);
		} else if (task.status === "blocked") {
			// Stopping the run abandons blocked tasks, including decisions.
			// They become interrupted and resume like any stopped task.
			delete task.activity;
			task.status = "interrupted";
			task.statusDetail = statusDetail;
			task.completedAt = new Date().toISOString();
			task.exitCode = 130;
			task.lastMessage = lastMessage;
			interruptedTaskIds.push(task.taskId);
		}
	}
	for (const record of run.foreachBatches ?? []) {
		if (!isActiveForeachBatchPhase(record.phase)) continue;
		markForeachBatchStopped(run, record);
	}
	return interruptedTaskIds;
}
