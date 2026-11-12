import {
	projectBlockedActions,
	runBlockedActions,
	type BlockedActions,
} from "../../core/blocked-actions.js";
import {
	projectTaskActivity,
	type TaskActivity,
} from "../../core/task-activity.js";
// WP43: pure, allowlisted browser projections of host API data. Never expose a raw run record.
import type { RunSummary, StatusData, showRunAction } from "../api.js";
import type { WorkflowTaskUsageValues } from "../../core/types.js";
import { EXECUTOR_NEEDS_DECISION_STATUS_DETAIL } from "../../core/terminal-result.js";
import type { TaskOutcome } from "./task-text.js";

export type DashboardStatusRun = NonNullable<StatusData["run"]>;
export type DashboardShownRun = Awaited<
	ReturnType<typeof showRunAction>
>["data"];
export interface DashboardNeed {
	kind: "failed" | "decision";
	title: string;
	requestId?: string;
	taskId?: string;
	since: string;
}
export interface DashboardRunSummary {
	blockedActions?: BlockedActions;
	runId: string;
	name: string;
	status: RunSummary["status"];
	statusDetail?: string;
	createdAt: string;
	updatedAt: string;
	/** The user's task on one line, cut to TASK_PREVIEW_CHARS characters: tells runs of one workflow apart. */
	taskPreview?: string;
	executor?: string;
	executors?: string[];
	host?: string;
	taskSummary: RunSummary["taskSummary"];
	/** Agent tasks only (no foreach placeholders or support helpers): what the header counts. */
	agentSummary?: { completed: number; total: number };
	verdict?: string;
	/** The run's only failure is the final verdict gate (the report is the outcome). */
	verdictGate?: true;
	reportAvailable: boolean;
	needsYou: DashboardNeed[];
	live: boolean;
}
export interface DashboardUsage {
	input?: number;
	output?: number;
	total?: number;
	costUsd: number | null;
}
export interface DashboardTask {
	blockedActions?: BlockedActions;
	taskId: string;
	specId: string;
	stageId: string;
	kind: string;
	agent: string | null;
	status: string;
	statusDetail: string;
	dependsOn: string[];
	generated: boolean;
	placeholder: boolean;
	executor?: string;
	model?: string;
	effort?: string;
	startedAt?: string;
	completedAt?: string;
	elapsedMs?: number;
	retry?: {
		attempt: number;
		maxAttempts?: number;
		reason?: string;
		nextRetryAt?: string;
	};
	lastMessage?: string;
	/** A foreach item's human title, from its source item (task-text.ts). */
	title?: string;
	/** A completed task's status word and one-line result, from its control.json (task-text.ts). */
	outcome?: TaskOutcome;
	/** A running task's latest sanitized tool activity (task-activity.ts). */
	activity?: TaskActivity;
	usage: DashboardUsage | null;
	worktree?: { path: string | null; branch: string | null };
	hasLogs: boolean;
}
export interface DashboardRun extends DashboardRunSummary {
	task?: string;
	permissionMode?: string;
	usage:
		| (DashboardUsage & {
				tasksReporting: number;
				taskCount: number;
				cacheRead?: number;
				note?: string;
		  })
		| null;
	launch?: { host: string; entry: unknown; command: string };
	tasks: DashboardTask[];
}

export function projectNeedsYou(
	run: DashboardStatusRun,
	shown?: DashboardShownRun,
): DashboardNeed[] {
	const needs: DashboardNeed[] = [];
	for (const task of run.tasks) {
		if (task.statusDetail !== EXECUTOR_NEEDS_DECISION_STATUS_DETAIL) continue;
		const record = shown?.run.tasks.find((item) => item.taskId === task.taskId);
		needs.push({
			kind: "decision",
			title: `${record?.stageId ?? task.specId} needs a decision`,
			taskId: task.taskId,
			since: record?.completedAt ?? run.updatedAt,
		});
	}
	// An executor decision already explains a blocked run; don't show a duplicate generic alert.
	// A run whose only failure is the final verdict gate finished its work and wrote its report —
	// the verdict is the outcome, not something to inspect and resume.
	if (
		(run.status === "failed" && !run.verdictGate) ||
		(run.status === "blocked" && needs.length === 0)
	) {
		const task = run.tasks.find((item) => item.status === run.status);
		const record = shown?.run.tasks.find(
			(item) => item.taskId === task?.taskId,
		);
		needs.push({
			kind: "failed",
			title: `${record?.stageId ?? task?.specId ?? run.name ?? "Run"} ${run.status}`,
			...(task ? { taskId: task.taskId } : {}),
			since: record?.completedAt ?? run.updatedAt,
		});
	}
	return needs;
}

/** Bound of a run summary's one-line task preview (the full task is on the run's own page). */
export const TASK_PREVIEW_CHARS = 140;
function taskPreview(task: string | undefined): string | undefined {
	const line = task?.replace(/\s+/gu, " ").trim();
	if (!line) return undefined;
	return line.length > TASK_PREVIEW_CHARS
		? `${line.slice(0, TASK_PREVIEW_CHARS - 1).trimEnd()}…`
		: line;
}
export function projectRunSummary(
	run: RunSummary | DashboardStatusRun,
	shown?: DashboardShownRun,
	live = "live" in run && run.live === true,
): DashboardRunSummary {
	const detail = "tasks" in run ? run : undefined;
	const executors = [
		...new Set(
			[
				run.executor,
				...(run.executors ?? []),
				...(shown?.run.tasks.map((task) => task.runtime?.executor) ?? []),
			].filter((value): value is string => Boolean(value)),
		),
	];
	const statusDetail = shown?.run.tasks.find(
		(task) => task.status === "blocked",
	)?.statusDetail;
	const agents = (shown?.run.tasks ?? []).filter(
		(task) =>
			task.kind !== "support" &&
			task.kind !== "dynamic" &&
			task.kind !== "loop" &&
			!(
				task.kind === "foreach" &&
				!task.foreachGenerated &&
				!task.dynamicGenerated
			),
	);
	const preview = taskPreview(shown?.runtimeTask);
	const blockedActions = shown
		? runBlockedActions(shown.run)
		: projectBlockedActions(run.blockedActions);
	return {
		runId: run.runId,
		...(blockedActions ? { blockedActions } : {}),
		name: run.name ?? "workflow",
		status: run.status,
		...(run.status === "blocked" && statusDetail ? { statusDetail } : {}),
		// An interrupted run the engine stopped itself (its driver ended): not "stopped by you".
		...(run.status === "interrupted" && run.statusDetail === "driver_lost"
			? { statusDetail: "driver_lost" }
			: {}),
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(preview ? { taskPreview: preview } : {}),
		...(run.executor ? { executor: run.executor } : {}),
		...(executors.length > 1 ? { executors } : {}),
		...(shown?.launch ? { host: shown.launch.source } : {}),
		taskSummary: { ...run.taskSummary },
		...(shown
			? {
					agentSummary: {
						completed: agents.filter((task) => task.status === "completed")
							.length,
						total: agents.length,
					},
				}
			: {}),
		...(detail?.verdict ? { verdict: detail.verdict } : {}),
		...(detail?.verdictGate ? { verdictGate: true as const } : {}),
		reportAvailable: Boolean(detail?.reportArtifacts.length),
		needsYou: projectNeedsYou(
			detail ?? { ...run, tasks: [], reportArtifacts: [] },
			shown,
		),
		live,
	};
}

function usage(
	value: WorkflowTaskUsageValues | undefined,
): DashboardUsage | null {
	if (!value) return null;
	return {
		...(typeof value.inputTokens === "number"
			? { input: value.inputTokens }
			: {}),
		...(typeof value.outputTokens === "number"
			? { output: value.outputTokens }
			: {}),
		...(typeof value.totalTokens === "number"
			? { total: value.totalTokens }
			: {}),
		costUsd: typeof value.costUsd === "number" ? value.costUsd : null,
	};
}

export function projectRun(
	run: DashboardStatusRun,
	shown: DashboardShownRun,
	live = run.live === true,
): DashboardRun {
	const record = shown.run;
	const tasks: DashboardTask[] = record.tasks.map((task) => {
		const runtime = run.tasks.find((item) => item.taskId === task.taskId);
		const retry = task.launchRetry ?? task.outputRetry;
		const generated = Boolean(task.foreachGenerated || task.dynamicGenerated);
		const executor =
			runtime?.executor ?? task.runtime?.executor ?? run.executor;
		// 2026-11-03: a task launched with the executor's default model shows the model it reported.
		const model = runtime?.model ?? task.runtime?.model ?? task.usage?.model;
		const effort = runtime?.effort ?? task.runtime?.effort;
		const blockedActions = projectBlockedActions(task.blockedActions);
		const activity =
			task.status === "running"
				? projectTaskActivity(task.activity)
				: undefined;
		return {
			taskId: task.taskId,
			...(blockedActions ? { blockedActions } : {}),
			specId: task.specId,
			stageId: task.stageId ?? task.specId.split(".")[0]!,
			kind: task.kind ?? "single",
			agent: task.agent ?? null,
			status: task.status,
			statusDetail: String(task.statusDetail),
			dependsOn: task.dependsOn ?? [],
			generated,
			placeholder: task.kind === "foreach" && !generated,
			...(executor ? { executor } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			...(task.startedAt ? { startedAt: task.startedAt } : {}),
			...(task.completedAt ? { completedAt: task.completedAt } : {}),
			...(task.elapsedMs !== undefined ? { elapsedMs: task.elapsedMs } : {}),
			...(retry
				? {
						retry: {
							attempt: retry.attempts,
							...(retry.maxAttempts !== undefined
								? { maxAttempts: retry.maxAttempts }
								: {}),
							...(retry.message || retry.reason
								? { reason: retry.message ?? retry.reason }
								: {}),
							...(task.launchRetry?.nextEligibleAt
								? { nextRetryAt: task.launchRetry.nextEligibleAt }
								: {}),
						},
					}
				: {}),
			...(task.lastMessage ? { lastMessage: task.lastMessage } : {}),
			...(activity ? { activity } : {}),
			usage: usage(task.usage?.aggregate ?? task.usage),
			...(task.worktree?.enabled
				? {
						worktree: {
							path: task.worktree.path,
							branch: task.worktree.branch,
						},
					}
				: {}),
			hasLogs: Boolean(
				task.startedAt &&
					(shown.taskLogIds
						? shown.taskLogIds.includes(task.taskId)
						: task.files?.output || task.files?.stderr),
			),
		};
	});
	const reported = tasks.filter((task) => task.usage !== null);
	let rollup: DashboardRun["usage"] = null;
	if (record.usage?.tasksReporting) {
		rollup = {
			...usage(record.usage)!,
			tasksReporting: record.usage.tasksReporting,
			taskCount: record.usage.taskCount,
			...(typeof record.usage.cacheReadInputTokens === "number"
				? { cacheRead: record.usage.cacheReadInputTokens }
				: {}),
		};
	} else if (reported.length) {
		const sum = (key: "input" | "output" | "total" | "costUsd") => {
			const values = reported
				.map((task) => task.usage?.[key])
				.filter((value): value is number => typeof value === "number");
			return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
		};
		rollup = {
			tasksReporting: reported.length,
			taskCount: tasks.length,
			...Object.fromEntries(
				(["input", "output", "total"] as const).flatMap((key) =>
					sum(key) === undefined ? [] : [[key, sum(key)]],
				),
			),
			costUsd: sum("costUsd") ?? null,
		};
		const cache = record.tasks
			.map(
				(task) => (task.usage?.aggregate ?? task.usage)?.cacheReadInputTokens,
			)
			.filter((value): value is number => typeof value === "number");
		if (cache.length) rollup.cacheRead = cache.reduce((a, b) => a + b, 0);
	}
	return {
		...projectRunSummary(run, shown, live),
		// The user's task for this run (host API `includeTask`), never the workflow's description.
		...(shown.runtimeTask ? { task: shown.runtimeTask } : {}),
		...(run.permissionMode ? { permissionMode: run.permissionMode } : {}),
		usage: rollup,
		...(shown.launch
			? {
					launch: {
						host: shown.launch.source,
						entry: {
							source: shown.launch.source,
							entry:
								record.launch && "entry" in record.launch
									? record.launch.entry
									: shown.launch.entry,
							profile: record.launch?.profile ?? null,
							taskChars: shown.launch.task.characters,
						},
						command:
							shown.launch.command.state === "captured"
								? (shown.launch.command.text ?? "")
								: "",
					},
				}
			: {}),
		tasks,
	};
}
