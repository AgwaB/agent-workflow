// WP43: a dashboard is a host, not a second run store or scheduler.
import {
	approveAction,
	logsAction,
	resumeAction,
	showAction,
	statusAction,
	stopAction,
	type HostApiContext,
	type LogsRequest,
	type LogsTask,
} from "../api.js";
import { hostTextRedactor } from "../redaction.js";
import type { RunReport } from "../run-artifacts.js";
import {
	projectRun,
	projectRunSummary,
	type DashboardRun,
	type DashboardRunSummary,
} from "./projection.js";

export interface DashboardActionResult {
	outcome: string;
	status: string;
	text: string;
	pending?: boolean;
	interruptedTaskIds?: string[];
	resetTaskIds?: string[];
}
export interface DashboardSource {
	listRuns(): Promise<DashboardRunSummary[]>;
	run(runId: string): Promise<DashboardRun | undefined>;
	taskLogs(
		runId: string,
		taskId: string,
		options: Pick<LogsRequest, "stream" | "lines">,
	): Promise<LogsTask | undefined>;
	report(runId: string): Promise<RunReport | undefined>;
	stop(runId: string): Promise<DashboardActionResult>;
	resume(runId: string): Promise<DashboardActionResult>;
	approve(
		runId: string,
		requestId: string,
		decision: "approve" | "reject",
	): Promise<DashboardActionResult>;
}

/** Apply host redaction to string values, not JSON syntax (messages can contain quotes/newlines). */
export function redactDashboardData<T>(
	value: T,
	redact: (text: string) => string,
): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value))
		return value.map((item) => redactDashboardData(item, redact)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				redactDashboardData(item, redact),
			]),
		) as T;
	return value;
}

export function hostApiDashboardSource(ctx: HostApiContext): DashboardSource {
	const redact = hostTextRedactor(ctx.env ?? process.env);
	const safe = <T>(data: T) => redactDashboardData(data, redact);
	const detail = async (runId: string) => {
		const [status, shown] = await Promise.all([
			statusAction(ctx, { runId }),
			showAction(ctx, { ref: runId, includeTaskLogs: true }),
		]);
		if (!status.data.run || shown.data.kind !== "run") return undefined;
		return { run: status.data.run, shown: shown.data };
	};
	return {
		async listRuns() {
			const summaries = (await statusAction(ctx, {})).data.runs ?? [];
			const runs: DashboardRunSummary[] = [];
			// Sequential reads avoid a project-sized burst of file descriptors on every poll.
			for (const summary of summaries
				.filter((run) => !run.parentRunId)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
				const data = await detail(summary.runId);
				if (data) runs.push(safe(projectRunSummary(data.run, data.shown)));
			}
			return runs;
		},
		async run(runId) {
			const data = await detail(runId);
			return data ? safe(projectRun(data.run, data.shown)) : undefined;
		},
		async taskLogs(runId, taskId, options) {
			return safe(
				(await logsAction(ctx, { runId, task: taskId, ...options })).data
					.tasks[0],
			);
		},
		async report(runId) {
			const shown = await showAction(ctx, { ref: runId, includeReport: true });
			return shown.data.kind === "run" ? safe(shown.data.report) : undefined;
		},
		async stop(runId) {
			const result = await stopAction(ctx, { runId });
			return safe({
				outcome: result.outcome,
				status: result.data.status,
				pending: result.data.pending,
				interruptedTaskIds: result.data.interruptedTaskIds,
				text: result.text,
			});
		},
		async resume(runId) {
			const result = await resumeAction(ctx, { runId, detach: true });
			return safe({
				outcome: result.outcome,
				status: result.data.status,
				resetTaskIds: result.data.resetTaskIds,
				text: result.text,
			});
		},
		async approve(runId, requestId, decision) {
			const result = await approveAction(ctx, {
				runId,
				requestId,
				decision,
				detach: true,
			});
			return safe({
				outcome: result.outcome,
				status: result.data.status,
				text: result.text,
			});
		},
	};
}
