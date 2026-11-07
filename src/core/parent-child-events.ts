import { type WorkerRunStatusSnapshot, loadWorkerApi } from "./runtime-port.js";
import { USAGE_METRIC_KEYS } from "./task-observability.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";

const PARENT_WORKER_CWD_ENV = "AGENT_WORKFLOW_PARENT_WORKER_CWD";
const PARENT_WORKER_RUNS_DIR_ENV = "AGENT_WORKFLOW_PARENT_WORKER_RUNS_DIR";
const PARENT_WORKER_RUN_ID_ENV = "AGENT_WORKFLOW_PARENT_WORKER_RUN_ID";
const PARENT_WORKER_ATTEMPT_ID_ENV = "AGENT_WORKFLOW_PARENT_WORKER_ATTEMPT_ID";
type ParentWorkerChildEvent = "started" | "completed" | "failed" | "cancelled";

interface ParentWorkerRef {
	cwd: string;
	runsDir: string;
	runId: string;
	attemptId?: string;
}

const GENERIC_TASK_STATUS_DETAILS = new Set([
	"completed",
	"failed",
	"interrupted",
	"running",
]);

function nonEmptyEnv(
	env: Record<string, string | undefined>,
	key: string,
): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

function parentWorkerRefFromEnv(
	env: Record<string, string | undefined> = process.env,
): ParentWorkerRef | undefined {
	const cwd = nonEmptyEnv(env, PARENT_WORKER_CWD_ENV);
	const runsDir = nonEmptyEnv(env, PARENT_WORKER_RUNS_DIR_ENV);
	const runId = nonEmptyEnv(env, PARENT_WORKER_RUN_ID_ENV);
	if (!cwd || !runsDir || !runId) return undefined;
	const attemptId = nonEmptyEnv(env, PARENT_WORKER_ATTEMPT_ID_ENV);
	return { cwd, runsDir, runId, ...(attemptId ? { attemptId } : {}) };
}

function terminalChildEventForTaskStatus(
	status: WorkflowTaskRunRecord["status"],
): ParentWorkerChildEvent | undefined {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "interrupted") return "cancelled";
	return undefined;
}

function childEventUsageSummary(
	task: WorkflowTaskRunRecord,
): Record<string, number> | undefined {
	const source = task.usage?.aggregate ?? task.usage;
	if (!source) return undefined;
	const summary: Record<string, number> = {};
	for (const key of USAGE_METRIC_KEYS) {
		const value = source[key];
		if (typeof value === "number") summary[key] = value;
	}
	return Object.keys(summary).length > 0 ? summary : undefined;
}

export async function recordParentWorkerChildEvent(options: {
	event: ParentWorkerChildEvent;
	childRunId: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	failureKind?: string | null;
	message?: string;
}): Promise<void> {
	const parent = parentWorkerRefFromEnv();
	if (!parent) return;
	const api = await loadWorkerApi().catch(() => undefined);
	if (!api?.recordWorkerChildEvent) return;
	// Usage rides along on terminal events so a parent worker can aggregate
	// nested workflow spend. Engines older than 0.4.8 ignore the extra field.
	const usage =
		options.event === "started"
			? undefined
			: childEventUsageSummary(options.task);
	await api
		.recordWorkerChildEvent({
			...parent,
			event: options.event,
			childRunId: options.childRunId,
			workflowRunId: options.run.runId,
			childTaskId: options.task.taskId,
			...(options.failureKind === undefined
				? {}
				: { failureKind: options.failureKind }),
			...(options.message === undefined ? {} : { message: options.message }),
			...(usage === undefined ? {} : { usage }),
		})
		.catch(() => undefined);
}

export async function recordTerminalParentWorkerChildEvent(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	snapshot: WorkerRunStatusSnapshot,
): Promise<void> {
	const event = terminalChildEventForTaskStatus(task.status);
	if (!event) return;
	const taskFailureKind =
		task.statusDetail && !GENERIC_TASK_STATUS_DETAILS.has(task.statusDetail)
			? task.statusDetail
			: undefined;
	await recordParentWorkerChildEvent({
		event,
		childRunId: snapshot.runId,
		run,
		task,
		failureKind:
			event === "completed"
				? undefined
				: (snapshot.failureKind ?? taskFailureKind ?? task.statusDetail),
		message: task.lastMessage,
	});
}
