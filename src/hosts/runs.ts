// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/extension.ts (`/workflow status|show|wait|
// resume|stop|prune|notices` handlers, the workflow_wait tool result) and src/cli.mjs (`inspect`,
// `supervise`, `prune`, `notices`). MIT, same author. Changes (WP11a): host-neutral handlers with
// structured data + text and no Pi imports (R#14: the prune parser no longer comes from the Pi
// extension); `wait` is bounded to 45 s per call and returns `terminal=false` instead of throwing
// when the run is still running; the Pi completion-delivery receipt/lease of workflow_wait (session
// feedback) is not part of the host API; `inspect` reads runs through the store (prefixes,
// `.agent-workflow/workflows`); supervise is a handler with an optional log sink.
// WP31: status data/inspect lines name each task's executor/model/effort in role-profile runs.
// WP36: `wait` marks the settled state it returns as seen for `notify-check`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	formatHumanRunOutcome,
	formatHumanRunResume,
	formatHumanRunStop,
	formatRawRunDetails,
	formatScheduledRetryWait,
	formatRunDetails,
	formatRunStatus,
	formatStatus,
	refreshRun,
	resumeRun,
	scheduledRetryWait,
	scheduleRun,
	stopRun,
	confirmRunStop,
	waitForRun,
	watchRun,
} from "../core/engine.js";
import {
	hasActiveSchedulerWork,
	recordSupervisorError,
} from "../core/engine-wait.js";
import {
	formatWorkflowPruneSummary,
	pruneWorkflowRuns,
	type WorkflowPruneSummary,
} from "../core/run-retention.js";
import {
	compiledWorkflowPath,
	isWorkflowRunLeaseLive,
	listRunRecords,
	readRunRecord,
	workflowRunDir,
} from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import { isWorkflowStopPendingError } from "../core/workflow-stop.js";
import {
	type PendingDynamicApproval,
	pendingDynamicApprovals,
} from "../core/dynamic-approval.js";
import {
	executeWorkflowNoticesCommand,
	parseWorkflowNoticesArgs,
} from "../core/workflow-notices.js";
import { summarizeWorkflowTerminal } from "../core/workflow-terminal.js";
import {
	HostUsageError,
	parseWorkflowPruneArgs,
	SUPERVISE_DEFAULT_MAX_RUNTIME_MS,
	SUPERVISE_DEFAULT_POLL_MS,
} from "./args.js";
import {
	type ExecutorStatePruneResult,
	formatExecutorStatePrune,
	pruneExecutorAdapterState,
} from "./adapter-state.js";
import {
	hostCommandHints,
	pendingApprovalLines,
	type WorkflowCommandHints,
} from "./hints.js";
import { spawnDetachedSupervisor } from "./launch.js";
import { markRunNotifySeen } from "./notify-check.js";
import {
	type HostLaunchClaimPrune,
	pruneHostLaunchClaims,
} from "./launch-guard.js";
import { hostTextRedactor } from "./redaction.js";
import { resolveContainedRunFile } from "./run-files.js";
import {
	formatVerdictGateHeadline,
	formatWorkflowResultPresentation,
	isResultOnlyWorkflowSuccess,
	readWorkflowResultPresentation,
	type WorkflowResultArtifact,
	type WorkflowResultPresentation,
} from "./result-presentation.js";
import {
	assertActionAllowed,
	HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS,
	HOST_LONG_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MIN_TIMEOUT_MS,
	type HostApiContext,
	type HostResult,
	hostEnv,
	outcomeForRunStatus,
	result,
	toDisplayPath,
} from "./types.js";

function requireRunRef(value: unknown, action: string): string {
	if (typeof value !== "string" || !value.trim() || value.startsWith("-"))
		throw new HostUsageError(
			`${action} needs a run id (or unambiguous prefix)`,
		);
	return value.trim();
}

export interface RunSummary {
	runId: string;
	name?: string;
	status: WorkflowRunRecord["status"];
	type: WorkflowRunRecord["type"];
	createdAt: string;
	updatedAt: string;
	parentRunId?: string;
	executor?: string;
	/** WP31: every executor of a mixed run (role profile), the run's executor first. */
	executors?: string[];
	permissionMode?: string;
	taskSummary: WorkflowRunRecord["taskSummary"];
}

export function summarizeRun(run: WorkflowRunRecord): RunSummary {
	return {
		runId: run.runId,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		type: run.type,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
		...(run.executor ? { executor: run.executor.id } : {}),
		...(run.roleExecution?.mixed
			? { executors: Object.keys(run.roleExecution.executors) }
			: {}),
		...(run.permissionMode ? { permissionMode: run.permissionMode.mode } : {}),
		taskSummary: run.taskSummary,
	};
}

export interface StatusData {
	run?: RunSummary & {
		/** WP18b: domain verdict of a terminal run (output task control). */
		verdict?: string;
		/** WP18b: the run's only failure is the final verdict gate. */
		verdictGate?: true;
		/** WP18b: report artifacts of a terminal run. */
		reportArtifacts: WorkflowResultArtifact[];
		tasks: Array<{
			taskId: string;
			specId: string;
			status: string;
			statusDetail: string;
			/** WP31: the task's executor, model and effort (role-profile runs). */
			executor?: string;
			model?: string;
			effort?: string;
		}>;
		/**
		 * WP29: dynamic controllers the run is blocked on until the user approves or rejects them
		 * (the question, its request id; answer with `approve`).
		 */
		pendingApprovals?: PendingDynamicApproval[];
	};
	runs?: RunSummary[];
}

/** Presentation (verdict, report, preview) of a terminal run; undefined while it runs. */
async function terminalPresentation(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<WorkflowResultPresentation | undefined> {
	const terminal = await summarizeWorkflowTerminal(cwd, run);
	if (!terminal.terminal) return undefined;
	return await readWorkflowResultPresentation(
		cwd,
		run,
		terminal.outputTaskIds,
	).catch(() => undefined);
}

/** `status [run]`: one run (refreshed) or every top-level run. */
export async function statusAction(
	ctx: HostApiContext,
	request: { runId?: string } = {},
): Promise<HostResult<StatusData>> {
	assertActionAllowed(ctx, "status");
	if (request.runId === undefined) {
		const text = await formatStatus(ctx.cwd, hostCommandHints(ctx.host));
		const runs = (await listRunRecords(ctx.cwd))
			.filter((run) => !run.parentRunId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map(summarizeRun);
		return result("status", "success", { runs }, text);
	}
	const ref = requireRunRef(request.runId, "status");
	const card = await formatRunStatus(ctx.cwd, ref, hostCommandHints(ctx.host));
	const run = await readRunRecord(ctx.cwd, ref);
	// WP18b: a terminal run shows its domain verdict and report; a verdict-gate run leads with
	// "finished — verdict: X (report ready)".
	const presentation = await terminalPresentation(ctx.cwd, run);
	const pendingApprovals = await pendingDynamicApprovals(ctx.cwd, run);
	const approvalText = pendingApprovalLines(
		ctx.host,
		run.runId,
		pendingApprovals,
	).join("\n");
	const statusText = presentation
		? [
				...(presentation.verdictGate
					? [
							`Workflow ${formatVerdictGateHeadline(presentation)} (run status: ${run.status})`,
							"",
						]
					: []),
				card,
				...(presentation.verdict || presentation.artifacts.length
					? [
							"",
							...(presentation.verdict
								? [`Verdict: ${presentation.verdict}`]
								: []),
							...presentation.artifacts.map(
								(artifact) => `${artifact.label}: ${artifact.path}`,
							),
						]
					: []),
			].join("\n")
		: card;
	const text = approvalText ? `${statusText}\n${approvalText}` : statusText;
	return result(
		"status",
		"success",
		{
			run: {
				...summarizeRun(run),
				...(presentation?.verdict ? { verdict: presentation.verdict } : {}),
				...(presentation?.verdictGate ? { verdictGate: true as const } : {}),
				reportArtifacts: presentation?.artifacts ?? [],
				tasks: run.tasks.map((task) => ({
					taskId: task.taskId,
					specId: task.specId,
					status: task.status,
					statusDetail: String(task.statusDetail),
					...(task.runtime?.executor
						? {
								executor: task.runtime.executor,
								...(task.runtime.model ? { model: task.runtime.model } : {}),
								...(task.runtime.thinking
									? { effort: task.runtime.thinking }
									: {}),
							}
						: {}),
				})),
				...(pendingApprovals.length ? { pendingApprovals } : {}),
			},
		},
		// WP19 (review #7): the card carries worker messages.
		hostTextRedactor(hostEnv(ctx))(text),
	);
}

/** `show <run> [--raw]`: run details (the workflow-spec form lives in catalog.ts). */
export async function showRunAction(
	ctx: HostApiContext,
	request: { runId: string; raw?: boolean },
): Promise<HostResult<{ kind: "run"; run: WorkflowRunRecord }>> {
	assertActionAllowed(ctx, "show");
	const ref = requireRunRef(request.runId, "show");
	const text = request.raw
		? await formatRawRunDetails(ctx.cwd, ref, hostCommandHints(ctx.host))
		: await formatRunDetails(ctx.cwd, ref, hostCommandHints(ctx.host));
	const run = await readRunRecord(ctx.cwd, ref);
	return result(
		"show",
		"success",
		{ kind: "run", run },
		hostTextRedactor(hostEnv(ctx))(text),
	);
}

function positiveCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0;
}

function isContextLimitText(value: unknown): boolean {
	const text = String(value ?? "").toLowerCase();
	return (
		text.includes("context_or_request_too_large") ||
		/context (window|length)|maximum context|request too large|token limit/.test(
			text,
		)
	);
}

function hasContextLimitFailure(value: Record<string, unknown>): boolean {
	const nested = (key: string, field: string) =>
		(value[key] as Record<string, unknown> | undefined)?.[field];
	return [
		value.statusDetail,
		value.fromStatusDetail,
		value.lastMessage,
		nested("outputRetry", "reason"),
		nested("outputRetry", "message"),
		nested("launchRetry", "reason"),
		nested("launchRetry", "message"),
		value.outputRetryReason,
		value.launchRetryReason,
	].some(isContextLimitText);
}

export interface InspectData {
	run: WorkflowRunRecord;
	reliability: {
		health: "clean" | "repaired" | "incomplete";
		outputRetries: number;
		launchRetries: number;
		resumeEvents: number;
		contextLimitFailures: number;
	};
	listed: string[];
}

function summarizeReliability(
	tasks: WorkflowRunRecord["tasks"],
): InspectData["reliability"] {
	let outputRetries = 0;
	let launchRetries = 0;
	let resumeEvents = 0;
	let contextLimitFailures = 0;
	for (const raw of tasks) {
		// SAFETY: read-only field probing of a persisted record; every field is type-checked below.
		const task = raw as unknown as Record<string, unknown>;
		outputRetries += positiveCount(
			(task.outputRetry as { attempts?: unknown } | undefined)?.attempts,
		);
		launchRetries += positiveCount(
			(task.launchRetry as { attempts?: unknown } | undefined)?.attempts,
		);
		if (hasContextLimitFailure(task)) contextLimitFailures += 1;
		const events = Array.isArray(task.resumeEvents) ? task.resumeEvents : [];
		for (const event of events as Array<Record<string, unknown>>) {
			resumeEvents += 1;
			outputRetries += positiveCount(event.outputRetryAttempts);
			launchRetries += positiveCount(event.launchRetryAttempts);
			if (hasContextLimitFailure(event)) contextLimitFailures += 1;
		}
	}
	const allCompleted =
		tasks.length > 0 && tasks.every((task) => task.status === "completed");
	const repairEvents = outputRetries + launchRetries + resumeEvents;
	const health = !allCompleted
		? "incomplete"
		: repairEvents === 0 && contextLimitFailures === 0
			? "clean"
			: "repaired";
	return {
		health,
		outputRetries,
		launchRetries,
		resumeEvents,
		contextLimitFailures,
	};
}

/**
 * `inspect <run> [--failures] [--results]`: reliability summary and task listing. `failures`
 * narrows to failed/blocked/interrupted tasks; with `results` on a run without failures it falls
 * back to every task result and says so.
 */
export async function inspectAction(
	ctx: HostApiContext,
	request: { runId: string; failures?: boolean; results?: boolean },
): Promise<HostResult<InspectData>> {
	assertActionAllowed(ctx, "inspect");
	const run = await readRunRecord(
		ctx.cwd,
		requireRunRef(request.runId, "inspect"),
	);
	const tasks = Array.isArray(run.tasks) ? run.tasks : [];
	const failures = tasks.filter((task) =>
		["failed", "blocked", "interrupted"].includes(task.status),
	);
	const failuresOnly = request.failures === true;
	const showAllResults =
		failuresOnly && request.results === true && failures.length === 0;
	const selected = failuresOnly && !showAllResults ? failures : tasks;
	const reliability = summarizeReliability(tasks);
	const lines = [
		`runId: ${run.runId}`,
		`name: ${run.name ?? "(unnamed)"}`,
		`type: ${run.type}`,
		`status: ${run.status}`,
		`tasks: ${tasks.length}`,
		`completion: ${reliability.health}`,
		`retries: output=${reliability.outputRetries}, launch=${reliability.launchRetries}, resumes=${reliability.resumeEvents}, contextLimitFailures=${reliability.contextLimitFailures}`,
	];
	if (showAllResults) lines.push("failures: none (showing every task result)");
	for (const task of selected) {
		// WP31: a role-profile run shows each task's executor/model/effort.
		const runtime = task.runtime?.executor
			? ` [${task.runtime.executor}${task.runtime.model ? ` ${task.runtime.model}` : ""}${task.runtime.thinking ? ` ${task.runtime.thinking}` : ""}]`
			: "";
		lines.push(
			`- ${task.taskId}${runtime}: ${task.status}/${task.statusDetail}${task.lastMessage ? ` — ${task.lastMessage}` : ""}`,
		);
		const resultFile = (task.files as { result?: string } | undefined)?.result;
		if (request.results && resultFile) {
			// WP19 (review #4): a metadata path is read only inside the artifact root.
			const contained = await resolveContainedRunFile(ctx.cwd, resultFile);
			if (contained.kind === "refused") {
				lines.push(`    (result not read: ${contained.reason})`);
				continue;
			}
			const text =
				contained.kind === "ok"
					? await readFile(contained.path, "utf8").catch(() => "")
					: "";
			if (text)
				lines.push(
					text
						.trim()
						.split(/\r?\n/)
						.map((line) => `    ${line}`)
						.join("\n"),
				);
		}
	}
	return result(
		"inspect",
		"success",
		{ run, reliability, listed: selected.map((task) => task.taskId) },
		// WP19 (review #7): task messages and results are worker output.
		hostTextRedactor(hostEnv(ctx))(lines.join("\n")),
	);
}

export interface WaitRequest {
	runId: string;
	/**
	 * Bound of this call; default and cap 45 000 ms (HOST_WAIT_MAX_TIMEOUT_MS), with `longWait`
	 * default 30 min and cap 4 h.
	 */
	timeoutMs?: number;
	/** WP28: a host without per-call time limits (Pi) waits up to 4 h instead of 45 s. */
	longWait?: boolean;
	signal?: AbortSignal;
	onProgress?: (run: RunSummary) => void;
}

export interface WaitData {
	runId: string;
	status: WorkflowRunRecord["status"];
	semanticStatus: string;
	/** Terminal engine status (completed, failed, interrupted). */
	terminal: boolean;
	/** Not terminal and not running: blocked, needs inspect/resume. */
	actionRequired: boolean;
	/** The bounded wait ended while the run was still running; call wait again. */
	stillRunning: boolean;
	/** Effective bound of this call after the 45 s cap (4 h for a long wait). */
	timeoutMs: number;
	blockedTaskIds: string[];
	taskSummary: WorkflowRunRecord["taskSummary"];
	outputTaskIds: string[];
	outputRetryAttempts: number;
	launchRetryAttempts: number;
	artifactRoot: string;
	/**
	 * WP18b: set while the run only waits for a scheduled task retry (for example a 15-minute
	 * rate-limit backoff): the earliest retry time, its remaining ms, reason/message and the waiting
	 * task ids. No task progress is expected before `at`.
	 */
	nextRetry?: {
		at: string;
		retryAfterMs: number;
		reason?: string;
		message?: string;
		taskIds: string[];
	};
	/**
	 * WP18b: the workflow's domain verdict from the output task (for example NEEDS_WORK), distinct
	 * from the run `status`/`semanticStatus`.
	 */
	verdict?: string;
	/**
	 * WP18b: the run's only failure is its final verdict gate (every model task completed; the final
	 * step declared a non-passing verdict as `failed`). `status` and the outcome stay `failed`.
	 */
	verdictGate?: true;
	/** Bounded authoritative-result preview of a terminal run. */
	preview?: string;
	reportArtifacts: WorkflowResultArtifact[];
	usage?: WorkflowRunRecord["usage"];
	degradation?: WorkflowRunRecord["degradation"];
	/**
	 * WP29: dynamic controllers the blocked run waits on (the question and its request id). The
	 * user answers with `approve` (CLI `agent-workflow approve`, Pi `/aw approve`, MCP
	 * `workflow_approve`); a host with an approval UI asks while it drives the run instead.
	 */
	pendingApprovals?: PendingDynamicApproval[];
}

export function boundedWaitTimeout(
	timeoutMs: number | undefined,
	longWait = false,
): number {
	const max = longWait
		? HOST_LONG_WAIT_MAX_TIMEOUT_MS
		: HOST_WAIT_MAX_TIMEOUT_MS;
	if (timeoutMs === undefined)
		return longWait ? HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS : max;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
		throw new HostUsageError("wait timeoutMs must be a number");
	return Math.max(
		HOST_WAIT_MIN_TIMEOUT_MS,
		Math.min(max, Math.floor(timeoutMs)),
	);
}

/**
 * `wait <run>`: drive and wait for a run for at most 45 s (WP28: 4 h with `longWait`), then return
 * its state. Hosts call it again while `stillRunning`. Cancelling only cancels the wait, never the
 * run.
 */
export async function waitAction(
	ctx: HostApiContext,
	request: WaitRequest,
): Promise<HostResult<WaitData>> {
	assertActionAllowed(ctx, "wait");
	const timeoutMs = boundedWaitTimeout(
		request.timeoutMs,
		request.longWait === true,
	);
	const resolved = await readRunRecord(
		ctx.cwd,
		requireRunRef(request.runId, "wait"),
	);
	let run: WorkflowRunRecord;
	try {
		run = await waitForRun(ctx.cwd, resolved.runId, timeoutMs, {
			...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
			...(ctx.dynamicUi ? { dynamicUi: ctx.dynamicUi } : {}),
			...(request.signal ? { waitSignal: request.signal } : {}),
			...(request.onProgress
				? {
						onWaitProgress: (current: WorkflowRunRecord) =>
							request.onProgress?.(summarizeRun(current)),
					}
				: {}),
		});
	} catch (error) {
		// Only the wait bound ("Flow run … still running … after …ms wait") becomes a result;
		// the run may also have settled right at the boundary.
		const timedOut =
			!request.signal?.aborted &&
			error instanceof Error &&
			/still running .*after \d+ms wait/.test(error.message);
		if (!timedOut) throw error;
		run = await refreshRun(ctx.cwd, resolved.runId).catch(() =>
			readRunRecord(ctx.cwd, resolved.runId),
		);
	}
	const stillRunning = hasActiveSchedulerWork(run);
	const terminal = await summarizeWorkflowTerminal(ctx.cwd, run);
	const presentation = terminal.terminal
		? await readWorkflowResultPresentation(
				ctx.cwd,
				run,
				terminal.outputTaskIds,
			).catch(() => undefined)
		: undefined;
	// WP19 (review #7): the result preview is worker output; redact it like logs.
	const redact = hostTextRedactor(hostEnv(ctx));
	const preview =
		presentation?.preview === undefined
			? undefined
			: redact(presentation.preview);
	if (presentation && preview !== undefined) presentation.preview = preview;
	const artifacts = presentation?.artifacts ?? [];
	const blockedTaskIds = run.tasks
		.filter((task) => task.status === "blocked")
		.map((task) => task.specId);
	const actionRequired = !terminal.terminal && !stillRunning;
	const pendingApprovals = actionRequired
		? await pendingDynamicApprovals(ctx.cwd, run)
		: [];
	const nextRetry = stillRunning ? scheduledRetryWait(run) : undefined;
	const data: WaitData = {
		runId: run.runId,
		status: run.status,
		semanticStatus: terminal.semanticStatus,
		terminal: terminal.terminal,
		actionRequired,
		stillRunning,
		timeoutMs,
		blockedTaskIds,
		taskSummary: run.taskSummary,
		outputTaskIds: terminal.outputTaskIds,
		outputRetryAttempts: terminal.outputRetryAttempts,
		launchRetryAttempts: terminal.launchRetryAttempts,
		artifactRoot: toDisplayPath(terminal.artifactRoot, ctx.cwd),
		...(nextRetry ? { nextRetry } : {}),
		...(presentation?.verdict ? { verdict: presentation.verdict } : {}),
		...(presentation?.verdictGate ? { verdictGate: true as const } : {}),
		...(preview ? { preview } : {}),
		reportArtifacts: artifacts,
		...(run.usage ? { usage: run.usage } : {}),
		...(run.degradation ? { degradation: run.degradation } : {}),
		...(pendingApprovals.length ? { pendingApprovals } : {}),
	};
	// WP36: a settled state this wait returns is not repeated by `notify-check`.
	if (!stillRunning) await markRunNotifySeen(ctx.cwd, run).catch(() => {});
	const hints = hostCommandHints(ctx.host);
	let text: string;
	if (stillRunning) {
		text = `Workflow still running: ${run.name ?? "workflow"}\nRun: ${run.runId}\nProgress: ${run.taskSummary.completed}/${run.taskSummary.total} completed, ${run.taskSummary.running} running (waited ${timeoutMs}ms; wait again to keep driving it)`;
		if (nextRetry)
			text += `\nNow ${formatScheduledRetryWait(nextRetry)}${nextRetry.message ? `: ${nextRetry.message}` : ""}; no progress before then.`;
	} else if (
		terminal.terminal &&
		preview &&
		isResultOnlyWorkflowSuccess(terminal.semanticStatus, preview)
	) {
		text = formatWorkflowResultPresentation(preview, artifacts);
	} else if (presentation?.verdictGate) {
		text = formatVerdictGateText(run, presentation, hints);
	} else {
		text = [
			terminal.terminal
				? `Workflow terminal: ${run.name ?? "workflow"}`
				: `Workflow blocked; action required: ${run.name ?? "workflow"}`,
			`Run: ${run.runId}`,
			`Engine status: ${terminal.engineStatus}`,
			`Semantic status: ${terminal.semanticStatus}`,
			...(presentation?.verdict ? [`Verdict: ${presentation.verdict}`] : []),
			formatHumanRunOutcome(run, { hints }),
			`Output retries: ${terminal.outputRetryAttempts}; launch retries: ${terminal.launchRetryAttempts}`,
			`Artifacts: ${data.artifactRoot}`,
			terminal.terminal
				? preview
					? `Final result preview:\n${formatWorkflowResultPresentation(preview, artifacts)}`
					: "Final result preview: unavailable"
				: `Blocked tasks: ${blockedTaskIds.join(", ") || "unknown"}; inspect with: ${hints.inspectFailures(run.runId)}; resume with: ${hints.resume(run.runId)}`,
			...pendingApprovalLines(ctx.host, run.runId, pendingApprovals),
		].join("\n");
	}
	return result(
		"wait",
		stillRunning ? "running" : outcomeForRunStatus(run.status),
		data,
		redact(text),
	);
}

/**
 * WP18b: text of a run whose only failure is the final verdict gate: a finished run with a domain
 * verdict and a report, not a failure; the run status stays visible on its own line.
 */
function formatVerdictGateText(
	run: WorkflowRunRecord,
	presentation: WorkflowResultPresentation,
	hints: WorkflowCommandHints,
): string {
	return [
		`Workflow ${formatVerdictGateHeadline(presentation)}: ${run.name ?? "workflow"}`,
		`Run: ${run.runId}`,
		`Run status: ${run.status} (only the final verdict gate did not pass; every other task completed)`,
		"",
		presentation.preview
			? formatWorkflowResultPresentation(
					presentation.preview,
					presentation.artifacts,
				)
			: presentation.artifacts
					.map((artifact) => `- ${artifact.label}: \`${artifact.path}\``)
					.join("\n"),
		"",
		`Open: ${hints.status(run.runId)}`,
	].join("\n");
}

export interface ResumeData {
	runId: string;
	status: WorkflowRunRecord["status"];
	resetTaskIds: string[];
	taskSummary: WorkflowRunRecord["taskSummary"];
	detached?: { pid?: number; logPath: string };
}

/** `resume <run> [detach]`: reset failed/interrupted/resumable-blocked tasks and schedule. */
export async function resumeAction(
	ctx: HostApiContext,
	request: { runId: string; detach?: boolean },
): Promise<HostResult<ResumeData>> {
	assertActionAllowed(ctx, "resume");
	const { run, resetTaskIds } = await resumeRun(
		ctx.cwd,
		requireRunRef(request.runId, "resume"),
		{
			...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
			// WP29: an attached resume re-asks an open dynamic-controller approval.
			...(ctx.dynamicUi && !request.detach ? { dynamicUi: ctx.dynamicUi } : {}),
		},
	);
	const data: ResumeData = {
		runId: run.runId,
		status: run.status,
		resetTaskIds,
		taskSummary: run.taskSummary,
	};
	let note = "";
	if (request.detach && run.status === "running") {
		data.detached = spawnDetachedSupervisor(ctx.cwd, run.runId, hostEnv(ctx));
		note = `\nDetached supervisor: pid ${data.detached.pid ?? "unknown"}`;
	}
	return result(
		"resume",
		outcomeForRunStatus(run.status),
		data,
		formatHumanRunResume(run, resetTaskIds.length, {
			hints: hostCommandHints(ctx.host),
		}) + note,
	);
}

export interface StopData {
	runId: string;
	status: WorkflowRunRecord["status"];
	interruptedTaskIds: string[];
	/** The durable stop intent is recorded but another supervisor has not applied it yet. */
	pending: boolean;
}

/** Bound for confirming a stop while another supervisor (e.g. a detached one) holds the run. */
export const HOST_STOP_CONFIRM_TIMEOUT_MS = 15_000;

/**
 * `stop <run>`: interrupt a non-terminal run (durable stop intent; workers are cancelled). When
 * another supervisor holds the run lease the engine reports the stop as pending; the handler
 * retries until the stop is confirmed or `timeoutMs` (default 15 s) passes, then returns
 * `pending: true` (outcome `running`; the intent stays durable).
 */
export async function stopAction(
	ctx: HostApiContext,
	request: { runId: string; timeoutMs?: number },
): Promise<HostResult<StopData>> {
	assertActionAllowed(ctx, "stop");
	const ref = requireRunRef(request.runId, "stop");
	const deadline =
		Date.now() + (request.timeoutMs ?? HOST_STOP_CONFIRM_TIMEOUT_MS);
	// WP12a: after the first attempt recorded the durable stop intent, retries only confirm it.
	// Re-running stopRun refused a run whose supervisor had meanwhile applied the stop and cleared
	// the intent ("stop requires a non-terminal run; … is interrupted"), so a successful stop
	// exited 1 under load (host-cli "stop" flake).
	let requested = false;
	while (true) {
		try {
			const { run, interruptedTaskIds } = requested
				? await confirmRunStop(ctx.cwd, ref)
				: await stopRun(ctx.cwd, ref);
			return result(
				"stop",
				"success",
				{
					runId: run.runId,
					status: run.status,
					interruptedTaskIds,
					pending: false,
				},
				formatHumanRunStop(
					run,
					interruptedTaskIds.length,
					hostCommandHints(ctx.host),
				),
			);
		} catch (error) {
			if (!isWorkflowStopPendingError(error)) throw error;
			requested = true;
			if (Date.now() >= deadline) {
				const run = await readRunRecord(ctx.cwd, ref);
				return result(
					"stop",
					"running",
					{
						runId: run.runId,
						status: run.status,
						interruptedTaskIds: [],
						pending: true,
					},
					`Stop requested for ${run.runId}; the active supervisor has not confirmed it yet. The stop intent is durable. Check: ${hostCommandHints(ctx.host).status(run.runId)}`,
				);
			}
			await new Promise((done) => setTimeout(done, 250));
		}
	}
}

/** `prune`: retention of terminal runs. Dry run unless `yes`. Accepts parsed options or argv. */
export async function pruneAction(
	ctx: HostApiContext,
	request:
		| { keep?: number; olderThanDays?: number; yes?: boolean }
		| { argv: string[] },
): Promise<
	HostResult<
		WorkflowPruneSummary & {
			adapterState: ExecutorStatePruneResult[];
			hostLaunchClaims: HostLaunchClaimPrune;
		}
	>
> {
	assertActionAllowed(ctx, "prune");
	const options =
		"argv" in request
			? parseWorkflowPruneArgs(request.argv)
			: parseWorkflowPruneArgs([
					...(request.keep === undefined
						? []
						: ["--keep", String(request.keep)]),
					...(request.olderThanDays === undefined
						? []
						: ["--older-than", String(request.olderThanDays)]),
					...(request.yes ? ["--yes"] : []),
				]);
	const { json: _json, ...retention } = options;
	const summary = await pruneWorkflowRuns(ctx.cwd, retention);
	// WP18b: the executor adapters' attempt state is pruned with the same dry-run rule; the window
	// is `--older-than` when given, else 7 days.
	const adapterState = await pruneExecutorAdapterState({
		env: hostEnv(ctx),
		dryRun: !retention.yes,
		...(retention.olderThanDays === undefined
			? {}
			: { retentionMs: retention.olderThanDays * 86_400_000 }),
	});
	// WP18b: stale host launch claims (`.agent-workflow/host-launches/`) go with the runs.
	const hostLaunchClaims = await pruneHostLaunchClaims(ctx.cwd, {
		dryRun: !retention.yes,
	});
	const claimsText = `Host launch claims: ${hostLaunchClaims.removed.length} stale file(s) ${hostLaunchClaims.dryRun ? "would be removed" : "removed"}${hostLaunchClaims.errors.length ? `; errors: ${hostLaunchClaims.errors.join("; ")}` : ""}`;
	return result(
		"prune",
		summary.error ? "failed" : "success",
		{ ...summary, adapterState, hostLaunchClaims },
		`${formatWorkflowPruneSummary(summary)}\n${formatExecutorStatePrune(adapterState)}\n${claimsText}`,
	);
}

/** `notices list|acknowledge|clear`: notification-only acknowledgements of unfinished runs. */
export async function noticesAction(
	ctx: HostApiContext,
	request: { argv: string[] },
): Promise<HostResult<JsonObject>> {
	assertActionAllowed(ctx, "notices");
	let command: ReturnType<typeof parseWorkflowNoticesArgs>;
	try {
		command = parseWorkflowNoticesArgs(request.argv);
	} catch (error) {
		throw new HostUsageError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const text = await executeWorkflowNoticesCommand(ctx.cwd, request.argv);
	if (command.action !== "list")
		return result(
			"notices",
			"success",
			{
				action: command.action,
				runId: command.runId,
				notificationOnly: true,
			},
			text,
		);
	// The list is read-only, so the structured form is a second read (`--json`).
	const data = command.json
		? parseJsonText(text)
		: parseJsonText(
				await executeWorkflowNoticesCommand(ctx.cwd, ["list", "--json"]),
			);
	return result("notices", "success", data, text);
}

type JsonObject = Record<string, unknown>;

function parseJsonText(text: string): JsonObject {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`unexpected non-JSON output (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("unexpected JSON output: not an object");
	return value as JsonObject;
}

export interface SuperviseDetachedData {
	runId: string;
	status: WorkflowRunRecord["status"];
	/** A standalone supervisor was spawned by this call. */
	started: boolean;
	/** Why nothing was spawned: the run is not running, or a live supervisor already drives it. */
	reason?: "not-running" | "live-supervisor";
	detached?: { pid?: number; logPath: string };
}

/**
 * WP28: `supervise <run>` for hosts whose calls are time-limited (the host MCP server): spawn the
 * standalone `agent-workflow supervise <run>` (as a detached launch does) and return at once.
 * Nothing is spawned for a run that is not running or that a live supervisor already drives (a
 * fresh run lease or `supervisor.json` heartbeat of a live process); the run lease would arbitrate
 * a second supervisor anyway, this only avoids an idle one.
 */
export async function superviseDetachedAction(
	ctx: HostApiContext,
	request: { runId: string },
): Promise<HostResult<SuperviseDetachedData>> {
	assertActionAllowed(ctx, "supervise");
	const run = await readRunRecord(
		ctx.cwd,
		requireRunRef(request.runId, "supervise"),
	);
	const hints = hostCommandHints(ctx.host);
	if (!hasActiveSchedulerWork(run))
		return result(
			"supervise",
			outcomeForRunStatus(run.status),
			{
				runId: run.runId,
				status: run.status,
				started: false,
				reason: "not-running",
			},
			`Nothing to supervise: ${run.runId} is ${run.status}. Open: ${hints.status(run.runId)}`,
		);
	if (await isWorkflowRunLeaseLive(ctx.cwd, run.runId))
		return result(
			"supervise",
			"running",
			{
				runId: run.runId,
				status: run.status,
				started: false,
				reason: "live-supervisor",
			},
			`A live supervisor already drives ${run.runId}; no second one was started. Wait for the result: ${hints.wait(run.runId)}`,
		);
	const detached = spawnDetachedSupervisor(ctx.cwd, run.runId, hostEnv(ctx));
	return result(
		"supervise",
		"running",
		{ runId: run.runId, status: run.status, started: true, detached },
		`Detached supervisor started for ${run.runId}: pid ${detached.pid ?? "unknown"}, log ${toDisplayPath(detached.logPath, ctx.cwd)}\nWait for the result: ${hints.wait(run.runId)}`,
	);
}

/**
 * A live process other than this one drives the run. Live lease evidence that only names this
 * process (its own watcher, or a status refresh it made) does not count: `watchRun` is idempotent
 * per process, so re-driving such a run is safe.
 */
async function drivenByAnotherProcess(
	cwd: string,
	runId: string,
): Promise<boolean> {
	if (!(await isWorkflowRunLeaseLive(cwd, runId))) return false;
	const dir = workflowRunDir(cwd, runId);
	const pids: number[] = [];
	const lock = await readFile(join(dir, "supervisor.lock"), "utf8").catch(
		() => undefined,
	);
	if (lock !== undefined)
		pids.push(Number.parseInt(lock.split(/\r?\n/)[1] ?? "", 10));
	for (const file of ["supervisor.json", "supervisor-lease.json"]) {
		const record = await readFile(join(dir, file), "utf8")
			.then((text) => JSON.parse(text) as { pid?: unknown })
			.catch(() => undefined);
		if (record) pids.push(typeof record.pid === "number" ? record.pid : NaN);
	}
	return !(pids.length > 0 && pids.every((pid) => pid === process.pid));
}

export interface RedriveData {
	/** Runs this process scheduled and now watches (engine `watchRun`). */
	redriven: string[];
	/** Runs with active work that a live process already drives. */
	skipped: Array<{ runId: string; reason: "live-supervisor" }>;
	/** Runs whose first scheduling pass failed (recorded in `supervisor.json`; still watched). */
	errors: Array<{ runId: string; message: string }>;
}

/**
 * WP28: port of pi-workflow 0.16.4 (b83cc4f) `resumeSupervisors` (src/engine.ts:2628) for a host
 * process that outlives a run's launcher (the Pi host at session start). Every run of the project
 * with active scheduler work that no live process drives (`isWorkflowRunLeaseLive`: a held run
 * lease, or a `supervisor.json`/`supervisor-lease.json` heartbeat < 30 s from a live pid; for
 * example an attached run whose Pi session or CLI process ended) is scheduled once and then watched
 * by this process. Change from pi-workflow: runs a live supervisor drives are skipped instead of
 * being scheduled concurrently (the run lease arbitrated that), and no run index is rewritten.
 * Re-driving only schedules, never resumes: a blocked run (B3: an attempt whose launch the executor
 * cannot prove either way is `executor_needs_decision`) stays blocked, and a running attempt with an
 * `unknown` reconcile becomes that decision through the engine's normal refresh, never a relaunch.
 * Completion delivery stays with each run's own audience (the host decides; nothing is bound here).
 */
export async function redriveRunsAction(
	ctx: HostApiContext,
): Promise<HostResult<RedriveData>> {
	assertActionAllowed(ctx, "supervise");
	const options = {
		...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
		...(ctx.dynamicUi ? { dynamicUi: ctx.dynamicUi } : {}),
	};
	const data: RedriveData = { redriven: [], skipped: [], errors: [] };
	for (const run of await listRunRecords(ctx.cwd)) {
		if (!hasActiveSchedulerWork(run)) continue;
		if (await drivenByAnotherProcess(ctx.cwd, run.runId)) {
			data.skipped.push({ runId: run.runId, reason: "live-supervisor" });
			continue;
		}
		try {
			await scheduleRun(ctx.cwd, run.runId, undefined, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			data.errors.push({ runId: run.runId, message });
			await recordSupervisorError(ctx.cwd, run.runId, error);
		}
		watchRun(ctx.cwd, run.runId, options);
		data.redriven.push(run.runId);
	}
	const text =
		data.redriven.length === 0
			? "No unsupervised running runs to pick up."
			: `Picked up ${data.redriven.length} running run(s) without a live supervisor: ${data.redriven.join(", ")}`;
	return result("supervise", "success", data, text);
}

export interface SuperviseRequest {
	runId?: string;
	all?: boolean;
	pollMs?: number;
	/** 0 = unlimited. Default 4 h, or unlimited for a single run with an unlimited loop. */
	maxRuntimeMs?: number;
	onLog?: (line: string) => void;
	signal?: AbortSignal;
	/** Test seams (clock, scheduler). */
	testHooks?: {
		now?: () => number;
		schedule?: (cwd: string, runId: string) => Promise<unknown>;
		sleep?: (ms: number) => Promise<void>;
	};
}

export interface SuperviseData {
	runIds: string[];
	maxRuntimeMs: number;
	runs: RunSummary[];
	/** completed: every supervised run completed (or none ran). */
	result: "completed" | "failed" | "blocked" | "timeout";
}

/**
 * `supervise`: drive scheduling from this process until the run(s) are terminal, so runs keep
 * progressing after the process that started them exits. The run lease arbitrates with any other
 * supervisor. `all`: only runs observed running; failure takes precedence over blocked.
 */
export async function superviseAction(
	ctx: HostApiContext,
	request: SuperviseRequest,
): Promise<HostResult<SuperviseData>> {
	assertActionAllowed(ctx, "supervise");
	if (request.runId !== undefined && request.all)
		throw new HostUsageError("Run id and --all are mutually exclusive.");
	if (request.runId === undefined && !request.all)
		throw new HostUsageError("Missing run id (or --all).");
	const now = request.testHooks?.now ?? Date.now;
	const schedule =
		request.testHooks?.schedule ??
		((cwd: string, runId: string) => scheduleRun(cwd, runId));
	const sleep =
		request.testHooks?.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const log = request.onLog ?? (() => undefined);
	const pollMs = request.pollMs ?? SUPERVISE_DEFAULT_POLL_MS;
	let maxRuntimeMs = request.maxRuntimeMs ?? SUPERVISE_DEFAULT_MAX_RUNTIME_MS;
	const cwd = ctx.cwd;
	const initial = request.runId
		? await readRunRecord(cwd, requireRunRef(request.runId, "supervise"))
		: undefined;
	const runId = initial?.runId;
	if (
		runId &&
		initial?.status === "running" &&
		request.maxRuntimeMs === undefined
	) {
		const compiled = parseJsonText(
			await readFile(compiledWorkflowPath(cwd, runId), "utf8"),
		) as { stages?: Array<{ type?: unknown; maxRounds?: unknown }> };
		if (
			compiled.stages?.some(
				(stage) => stage.type === "loop" && stage.maxRounds === null,
			)
		)
			maxRuntimeMs = 0;
	}
	const lastPrinted = new Map<string, string>();
	const supervised = new Set<string>();
	const deadline = maxRuntimeMs === 0 ? undefined : now() + maxRuntimeMs;
	log(
		`supervising ${runId ?? "all running runs"} in ${cwd} (poll ${pollMs}ms; runtime ${maxRuntimeMs === 0 ? "unlimited" : `${maxRuntimeMs}ms`})`,
	);
	const finish = (
		outcome: SuperviseData["result"],
		runs: WorkflowRunRecord[],
		text: string,
	): HostResult<SuperviseData> => {
		log(text);
		return result(
			"supervise",
			outcome === "completed"
				? "completed"
				: outcome === "timeout"
					? "timeout"
					: outcome,
			{
				runIds: [...supervised],
				maxRuntimeMs,
				runs: runs.map(summarizeRun),
				result: outcome,
			},
			text,
		);
	};

	while (true) {
		request.signal?.throwIfAborted();
		const runs = runId
			? [await readRunRecord(cwd, runId)]
			: (await listRunRecords(cwd)).filter(
					(run) => run.status === "running" && !run.parentRunId,
				);
		for (const run of runs) {
			if (run.status !== "running") continue;
			supervised.add(run.runId);
			await schedule(cwd, run.runId).catch((error) =>
				log(`schedule error ${run.runId}: ${error?.message ?? error}`),
			);
		}
		const refreshed = runId
			? [await readRunRecord(cwd, runId)]
			: (await listRunRecords(cwd)).filter((run) => !run.parentRunId);
		for (const run of refreshed) {
			const summary = run.taskSummary;
			const line = `${run.runId} ${run.status} (${summary.completed}/${summary.total} completed, ${summary.running} running, ${summary.failed} failed, ${summary.interrupted} interrupted)`;
			if (lastPrinted.get(run.runId) !== line) {
				lastPrinted.set(run.runId, line);
				log(line);
			}
		}
		if (runId) {
			const run = refreshed[0]!;
			if (run.status !== "running")
				return finish(
					run.status === "completed"
						? "completed"
						: run.status === "blocked"
							? "blocked"
							: "failed",
					[run],
					`done: ${run.runId} ${run.status}`,
				);
		} else if (!refreshed.some((run) => run.status === "running")) {
			const outcomes = refreshed.filter((run) => supervised.has(run.runId));
			// Failure/interruption takes precedence over blocked, then completed.
			const outcome =
				outcomes.length !== supervised.size ||
				outcomes.some((run) => !["completed", "blocked"].includes(run.status))
					? "failed"
					: outcomes.some((run) => run.status === "blocked")
						? "blocked"
						: "completed";
			return finish(outcome, outcomes, "done: no running runs remain");
		}
		if (deadline !== undefined && now() >= deadline)
			return finish(
				"timeout",
				refreshed,
				`giving up after --max-runtime-ms ${maxRuntimeMs}; run(s) still in progress`,
			);
		await sleep(pollMs);
	}
}
