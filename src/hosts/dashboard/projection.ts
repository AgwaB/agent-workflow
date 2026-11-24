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
import { outputRetriesUsed } from "../../core/output-retry-count.js";
import { isUserStoppedRun } from "../../core/run-stop-marking.js";
import type { TaskOutcome } from "./task-text.js";
import type {
	WorkflowConfiguration,
	WorkflowConfigurationSlot,
} from "../../core/project-settings-runtime.js";

export type DashboardStatusRun = NonNullable<StatusData["run"]>;
export type DashboardShownRun = Awaited<
	ReturnType<typeof showRunAction>
>["data"];
export interface DashboardNeed {
	/** `stopped`: interrupted, but not by the user (its host closed, for example). */
	kind: "failed" | "decision" | "stopped";
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
	/**
	 * 2026-11-12 (owner): what the run cost and how many of its agents reported it. Code steps never
	 * report cost, so only agent tasks count in the ratio; `costUsd` is null when nothing reported
	 * (unknown, never zero).
	 */
	cost?: DashboardRunCost;
	/**
	 * 2026-11-12 (owner): active time, the union of the run's task intervals (started → completed,
	 * or until now for a running task), not wall clock: a run that sat waiting does not count it.
	 */
	activeMs?: number;
	verdict?: string;
	/** The run's only failure is the final verdict gate (the report is the outcome). */
	verdictGate?: true;
	reportAvailable: boolean;
	needsYou: DashboardNeed[];
	live: boolean;
}
export interface DashboardRunCost {
	costUsd: number | null;
	agentsReporting: number;
	agentTotal: number;
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
	/** Recorded executor usage metadata, not independently provider-verified. */
	reportedModel?: string;
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
	/** Recorded requested/resolved compiler plan; not today's settings or observed execution. */
	configuration?: Pick<WorkflowConfiguration, "schema" | "slots" | "shadowed">;
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
	// 2026-11-13 (owner): "Needs you" lists what the host reminders list. A run interrupted without a
	// user stop (its host closed) is one of them; a run the user stopped is not.
	if (
		run.status === "interrupted" &&
		!run.parentRunId &&
		!isUserStoppedRun(run)
	) {
		const task = run.tasks.find((item) => item.status === "interrupted");
		const record = shown?.run.tasks.find(
			(item) => item.taskId === task?.taskId,
		);
		needs.push({
			kind: "stopped",
			title:
				run.statusDetail === "driver_lost"
					? "Stopped, host closed"
					: "Stopped unexpectedly",
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
/** The union of task intervals in milliseconds: overlapping tasks count once, gaps not at all. */
export function activeTimeMs(
	tasks: ReadonlyArray<{
		status: string;
		startedAt?: string;
		completedAt?: string;
		elapsedMs?: number;
	}>,
	now: number,
): number {
	const spans: Array<[number, number]> = [];
	for (const task of tasks) {
		// A launch claim can stamp a start on a task still waiting: it has not run yet.
		if (task.status === "pending") continue;
		const start = Date.parse(task.startedAt ?? "");
		if (!Number.isFinite(start)) continue;
		const done = Date.parse(task.completedAt ?? "");
		const end = Number.isFinite(done)
			? done
			: task.status === "running"
				? now
				: typeof task.elapsedMs === "number"
					? start + task.elapsedMs
					: Number.NaN;
		if (Number.isFinite(end) && end > start) spans.push([start, end]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let reach = Number.NEGATIVE_INFINITY;
	for (const [start, end] of spans) {
		if (end <= reach) continue;
		total += end - Math.max(start, reach);
		reach = end;
	}
	return total;
}
function taskCost(task: {
	usage?: WorkflowTaskUsageValues & { aggregate?: WorkflowTaskUsageValues };
}): number | undefined {
	const value = task.usage?.aggregate ?? task.usage;
	return typeof value?.costUsd === "number" ? value.costUsd : undefined;
}
export function projectRunSummary(
	run: RunSummary | DashboardStatusRun,
	shown?: DashboardShownRun,
	live = "live" in run && run.live === true,
	now = Date.now(),
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
	const taskCosts = (shown?.run.tasks ?? []).flatMap((task) => {
		const value = taskCost(task);
		return value === undefined ? [] : [value];
	});
	const rolledUp = shown?.run.usage?.costUsd;
	const cost: DashboardRunCost | undefined = shown
		? {
				costUsd:
					typeof rolledUp === "number"
						? rolledUp
						: taskCosts.length
							? taskCosts.reduce((a, b) => a + b, 0)
							: null,
				agentsReporting: agents.filter((task) => taskCost(task) !== undefined)
					.length,
				agentTotal: agents.length,
			}
		: undefined;
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
		...(cost ? { cost, activeMs: activeTimeMs(shown!.run.tasks, now) } : {}),
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
		// "Attempt N of M" counts retries made: a task that exhausted its repairs shows M of M, none shows nothing.
		const outputRetriesMade = outputRetriesUsed(
			task.outputRetry?.attempts,
			task.outputRetry?.reason,
		);
		const retry =
			task.launchRetry ??
			(task.outputRetry && outputRetriesMade > 0
				? { ...task.outputRetry, attempts: outputRetriesMade }
				: undefined);
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
			...(typeof task.usage?.model === "string" && task.usage.model
				? { reportedModel: task.usage.model }
				: {}),
			...(effort ? { effort } : {}),
			...(task.startedAt ? { startedAt: task.startedAt } : {}),
			...(task.completedAt ? { completedAt: task.completedAt } : {}),
			...(task.elapsedMs !== undefined ? { elapsedMs: task.elapsedMs } : {}),
			...(retry
				? {
						retry: {
							// Provider-pause refunds moved both counters; show what the task spent.
							attempt:
								retry.attempts -
								(task.launchRetry ? (task.providerPauseRefunds ?? 0) : 0),
							...(retry.maxAttempts !== undefined
								? {
										maxAttempts:
											retry.maxAttempts -
											(task.launchRetry ? (task.providerPauseRefunds ?? 0) : 0),
									}
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
		...(record.configuration
			? { configuration: projectCapturedConfiguration(record.configuration) }
			: {}),
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

/** Allowlist recorded fields; never forward capture paths, prompts or future unknown metadata. */
export function projectCapturedConfiguration(
	configuration: WorkflowConfiguration,
): NonNullable<DashboardRun["configuration"]> {
	const lineage = (field: WorkflowConfigurationSlot["model"]) => ({
		source: field.source,
		...(field.originSlot !== undefined ? { originSlot: field.originSlot } : {}),
		...(field.inheritedFrom !== undefined
			? { inheritedFrom: field.inheritedFrom }
			: {}),
		...(field.originScope !== undefined
			? { originScope: field.originScope }
			: {}),
		...(field.inheritedVia !== undefined
			? { inheritedVia: [...field.inheritedVia] }
			: {}),
	});
	return {
		schema: configuration.schema,
		slots: Object.fromEntries(
			Object.entries(configuration.slots).map(([id, slot]) => [
				id,
				{
					executor: {
						source: slot.executor.source,
						...(slot.executor.value !== undefined
							? { value: slot.executor.value }
							: {}),
					},
					model: {
						...lineage(slot.model),
						...(slot.model.value !== undefined
							? { value: slot.model.value }
							: {}),
					},
					effort: {
						...lineage(slot.effort),
						...(slot.effort.requested !== undefined
							? { requested: slot.effort.requested }
							: {}),
						...(slot.effort.resolved !== undefined
							? { resolved: slot.effort.resolved }
							: {}),
						...(slot.effort.reason !== undefined
							? { reason: slot.effort.reason }
							: {}),
					},
				},
			]),
		),
		shadowed: configuration.shadowed.map(({ scope, slot, field, reason }) => ({
			scope,
			slot,
			field,
			reason,
		})),
	};
}
