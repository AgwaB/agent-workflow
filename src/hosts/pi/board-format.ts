// New in agent-workflow (WP34): status glyphs, colours, progress bars, stage grouping and time
// texts of the `/aw` board. Ported from pi-workflow 0.16.4 (b83cc4f) src/workflow-view.ts
// (`statusGlyph`, `statusColor`, `progressBar`, `stageSummaries`, `summarizeTasks`,
// `statusForSummary`, `taskProblemPriority`, `timestampText`, `elapsedText`, `formatTokenCount`).
import type { BoardRun, BoardRunRecord } from "./board-source.js";
import {
	accent,
	errorText,
	fg,
	formatDuration,
	muted,
	strong,
	success,
	type Theme,
	warning,
} from "./tui-kit.js";

export type AnyStatus =
	| "pending"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped"
	| "interrupted";

export interface Summary {
	pending: number;
	running: number;
	blocked: number;
	completed: number;
	failed: number;
	skipped: number;
	interrupted: number;
	total: number;
}

export type BoardTask = BoardRunRecord["tasks"][number];

export function statusGlyph(theme: Theme, status: string): string {
	if (status === "completed") return success(theme, "✓");
	if (status === "running") return accent(theme, "↻");
	if (status === "blocked") return warning(theme, "◆");
	if (status === "failed" || status === "interrupted")
		return errorText(theme, "✕");
	if (status === "skipped") return muted(theme, "↷");
	return muted(theme, "•");
}

export function statusColor(status: string): string {
	if (status === "completed") return "success";
	if (status === "running") return "accent";
	if (status === "blocked") return "warning";
	if (status === "failed" || status === "interrupted") return "error";
	return "dim";
}

export function statusLabel(theme: Theme, status: string): string {
	return fg(
		theme,
		statusColor(status),
		strong(theme, status.toUpperCase().replace(/_/g, " ")),
	);
}

export function summarizeTasks(tasks: Array<{ status: string }>): Summary {
	const summary: Summary = {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
	};
	for (const task of tasks) {
		const key = task.status as keyof Summary;
		if (key in summary && key !== "total") summary[key] += 1;
		summary.total += 1;
	}
	return summary;
}

export function statusForSummary(summary: Summary): AnyStatus {
	if (summary.running > 0) return "running";
	if (summary.blocked > 0) return "blocked";
	if (summary.failed > 0) return "failed";
	if (summary.pending > 0) return "pending";
	if (summary.total > 0 && summary.completed === summary.total)
		return "completed";
	if (summary.interrupted > 0) return "interrupted";
	if (summary.skipped > 0) return "skipped";
	return "interrupted";
}

export function progressBar(
	theme: Theme,
	summary: Pick<Summary, "completed" | "running" | "total"> & Partial<Summary>,
	cells: number,
): string {
	const safeCells = Math.max(1, cells);
	const visible =
		summary.running > 0
			? summary.completed + summary.running
			: summary.completed;
	const filled =
		summary.total <= 0
			? 0
			: Math.max(
					0,
					Math.min(
						safeCells,
						Math.round((visible / summary.total) * safeCells),
					),
				);
	const bar = `${"▰".repeat(filled)}${"▱".repeat(safeCells - filled)}`;
	const width = Math.max(2, String(summary.total).length);
	const text = `${String(visible).padStart(width, " ")}/${String(summary.total).padStart(width, " ")}`;
	return fg(
		theme,
		statusColor(
			statusForSummary({
				pending: 0,
				blocked: 0,
				failed: 0,
				skipped: 0,
				interrupted: 0,
				...summary,
			} as Summary),
		),
		`${bar} ${text}`,
	);
}

/** Stages in first-seen order (artifact-graph runs); other runs are one group. */
export function stageGroups(
	run: BoardRun,
	record: BoardRunRecord | undefined,
): Array<{ id: string; tasks: BoardTask[] }> {
	const tasks = record?.tasks ?? [];
	if (record && record.type !== "artifact-graph")
		return [{ id: String(record.type), tasks }];
	if (!record) return [{ id: run.name ?? run.type, tasks: [] }];
	const order: string[] = [];
	const byStage = new Map<string, BoardTask[]>();
	for (const task of tasks) {
		const stageId = task.stageId ?? "unknown";
		if (!byStage.has(stageId)) {
			byStage.set(stageId, []);
			order.push(stageId);
		}
		byStage.get(stageId)!.push(task);
	}
	return order.map((id) => ({ id, tasks: byStage.get(id) ?? [] }));
}

export function taskProblemPriority(status: string): number {
	if (status === "failed" || status === "interrupted") return 0;
	if (status === "blocked") return 1;
	if (status === "running") return 2;
	return 3;
}

/** Problem tasks first, then the run's order. */
export function sortTasks(tasks: BoardTask[]): BoardTask[] {
	return tasks
		.map((task, index) => ({ task, index }))
		.sort(
			(left, right) =>
				taskProblemPriority(left.task.status) -
					taskProblemPriority(right.task.status) || left.index - right.index,
		)
		.map((entry) => entry.task);
}

export function timestampText(value: string | undefined): string {
	if (!value) return "-";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function elapsedText(
	createdAt: string,
	updatedAt: string,
	running: boolean,
	now = Date.now(),
): string {
	const start = Date.parse(createdAt);
	const end = running ? now : Date.parse(updatedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "unknown";
	return formatDuration(Math.max(0, end - start));
}

export function taskElapsed(task: BoardTask, now = Date.now()): string {
	if (task.elapsedMs !== undefined) return formatDuration(task.elapsedMs);
	if (task.startedAt && task.status === "running")
		return formatDuration(now - Date.parse(task.startedAt));
	return task.status;
}

export function formatTokenCount(
	value: number | null | undefined,
): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value >= 1_000_000)
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
	if (value >= 1_000)
		return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(value));
}

/** WP31: `executor · model · effort` of one task (status data first, then the record). */
export function taskRuntime(
	run: BoardRun,
	task: BoardTask,
): { executor: string; model: string; effort: string } {
	const status = run.tasks.find((entry) => entry.taskId === task.taskId);
	return {
		executor:
			status?.executor ?? task.runtime?.executor ?? run.executor ?? "(default)",
		model: status?.model ?? task.runtime?.model ?? "(executor default)",
		effort: status?.effort ?? task.runtime?.thinking ?? "(default)",
	};
}

export function shortModel(model: string): string {
	return model.split("/").pop() || model;
}
