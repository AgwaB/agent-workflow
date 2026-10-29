// WP43: pure, allowlisted browser projections of host API data. Never expose a raw run record.
import type {
	PendingDynamicApproval,
	RunSummary,
	StatusData,
	showRunAction,
} from "../api.js";
import type { WorkflowTaskUsageValues } from "../../core/types.js";
import { EXECUTOR_NEEDS_DECISION_STATUS_DETAIL } from "../../core/terminal-result.js";

export type DashboardStatusRun = NonNullable<StatusData["run"]>;
export type DashboardShownRun = Awaited<
	ReturnType<typeof showRunAction>
>["data"];
export interface DashboardNeed {
	kind: "approval" | "failed" | "decision";
	title: string;
	requestId?: string;
	taskId?: string;
	since: string;
}
export interface DashboardRunSummary {
	runId: string;
	name: string;
	status: RunSummary["status"];
	statusDetail?: string;
	createdAt: string;
	updatedAt: string;
	executor?: string;
	executors?: string[];
	host?: string;
	taskSummary: RunSummary["taskSummary"];
	verdict?: string;
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
	pendingApprovals: PendingDynamicApproval[];
	tasks: DashboardTask[];
}

export function projectNeedsYou(
	run: DashboardStatusRun,
	shown?: DashboardShownRun,
): DashboardNeed[] {
	const needs: DashboardNeed[] = (run.pendingApprovals ?? []).map(
		(approval) => ({
			kind: "approval",
			title: approval.title,
			requestId: approval.requestId,
			taskId: approval.taskId,
			since: approval.requestedAt,
		}),
	);
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
	// An approval/decision already explains a blocked run; don't show a duplicate generic alert.
	if (
		run.status === "failed" ||
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

export function projectRunSummary(
	run: RunSummary | DashboardStatusRun,
	shown?: DashboardShownRun,
	live = "live" in run && run.live === true,
): DashboardRunSummary {
	const detail = "tasks" in run ? run : undefined;
	const statusDetail = shown?.run.tasks.find(
		(task) => task.status === "blocked",
	)?.statusDetail;
	return {
		runId: run.runId,
		name: run.name ?? "workflow",
		status: run.status,
		...(run.status === "blocked" && statusDetail ? { statusDetail } : {}),
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.executor ? { executor: run.executor } : {}),
		...(run.executors ? { executors: run.executors } : {}),
		...(shown?.launch ? { host: shown.launch.source } : {}),
		taskSummary: { ...run.taskSummary },
		...(detail?.verdict ? { verdict: detail.verdict } : {}),
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
		const model = runtime?.model ?? task.runtime?.model;
		const effort = runtime?.effort ?? task.runtime?.thinking;
		return {
			taskId: task.taskId,
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
		...(record.description ? { task: record.description } : {}),
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
		pendingApprovals: run.pendingApprovals ?? [],
		tasks,
	};
}
