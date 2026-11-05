// Runs name their executor and carry SDK request fields; Pi-specific launch options are refused.
// Cancellation falls back to SIGTERM when the durable control mailbox is not acknowledged in time.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApprovalDecision } from "../sdk/approval.js";
import type {
	ApprovalResponseResult,
	CancelResult,
	CancelScope,
} from "../sdk/contract.js";
import type { ExecutorRegistry } from "../sdk/descriptor.js";
import {
	appendRunEvent,
	readRunRecord,
	type ResultEnvelope,
	type RunEvent,
	runPaths,
} from "./artifacts/index.js";
import type { FailureKind, ResolvedBackend, Status } from "./core/constants.js";
import {
	startAsyncParallelSubagentRuns,
	startAsyncSubagentRun,
} from "./orchestrate/async.js";
import { executionMode } from "./orchestrate/run-options.js";
import {
	type ApprovalAuditRequested,
	type ControlAck,
	awaitControlAck,
	readApprovalAudit,
	writeControlRequest,
} from "./orchestrate/control.js";
import {
	interruptRun,
	type InterruptRunOptions,
	type InterruptRunResult,
} from "./orchestrate/interrupt.js";
import {
	type RuntimeRunInput,
	validateRuntimeRunInput,
} from "./orchestrate/request.js";
import { resolveRunRef } from "./orchestrate/run-ref.js";
import {
	runParallelSubagentTasks,
	runSubagentTask,
	type ParallelRunResult,
} from "./orchestrate/run.js";
import {
	getRunLogs,
	getRunStatus,
	isTerminalStatus,
	waitForRun,
	type RunLogsSnapshot,
	type RunStatusRef,
	type RunStatusSnapshot,
	type WaitForRunOptions,
	type WaitForRunResult,
} from "./orchestrate/status.js";

export {
	reconcileSubagentRun,
	type ReconcileSubagentRunOptions as ReconcileSubagentOptions,
} from "./orchestrate/reconcile.js";

export {
	formatPruneSubagentRunsSummary,
	pruneSubagentRuns,
	type PruneSubagentRunCandidate,
	type PruneSubagentRunsOptions,
	type PruneSubagentRunsSummary,
} from "./orchestrate/prune.js";

export {
	assertDurableLaunchBarrierV2ExecutionAuthorized,
	createDurableLaunchBarrierV2,
	durableLaunchBarrierDigest,
	isDurableLaunchBarrierError,
	isDurableLaunchBarrierRevokedError,
	readDurableLaunchBarrierV2State,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
	DurableLaunchBarrierError,
	DurableLaunchBarrierRevokedError,
	type DurableLaunchBarrierV2Ack,
	type DurableLaunchBarrierV2Decision,
	type DurableLaunchBarrierV2Descriptor,
	type DurableLaunchBarrierV2Ready,
	type DurableLaunchBarrierV2ReleaseDecision,
	type DurableLaunchBarrierV2Resolution,
	type DurableLaunchBarrierV2RevocationDecision,
	type DurableLaunchBarrierV2State,
} from "./durable-launch-barrier.js";

export interface RunSubagentOptions extends RuntimeRunInput {
	signal?: AbortSignal;
	/** In-process executor modules (sync runs only; a durable worker imports `executor.module`). */
	registry?: ExecutorRegistry;
}

export type RunSubagentResult = ResultEnvelope | ParallelRunResult;

export type GetSubagentStatusOptions = RunStatusRef;
export type GetSubagentLogsOptions = RunStatusRef;
export type WaitForSubagentOptions = WaitForRunOptions;
export type InterruptSubagentOptions = InterruptRunOptions;

export interface RecordSubagentChildEventOptions extends RunStatusRef {
	event: "started" | "updated" | "completed" | "failed" | "cancelled";
	childRunId: string;
	workflowRunId?: string;
	childTaskId?: string;
	status?: Status;
	failureKind?: FailureKind | string | null;
	message?: string;
	/** Child usage totals (tokens/cost), usually sent with terminal events. */
	usage?: Record<string, unknown>;
}

export class SubagentValidationError extends Error {
	readonly failureKind = "validation" as const;
	readonly backend?: ResolvedBackend;

	constructor(message: string, backend?: ResolvedBackend) {
		super(message);
		this.name = "SubagentValidationError";
		this.backend = backend;
	}
}

function validateRunnableInput(
	input: RuntimeRunInput,
	backend: ResolvedBackend,
): void {
	const mode = executionMode(input);
	if (mode === "parallel") {
		if (input.tasks === undefined || input.tasks.length === 0) {
			throw new SubagentValidationError(
				"parallel mode requires a non-empty tasks array.",
				backend,
			);
		}
		return;
	}
	if (input.task === undefined) {
		throw new SubagentValidationError(
			`${backend} execution requires a non-empty task.`,
			backend,
		);
	}
}

function validateRunOptions(options: RunSubagentOptions): {
	input: RuntimeRunInput;
	cwd: string;
	signal?: AbortSignal;
	registry?: ExecutorRegistry;
} {
	const { signal, registry, ...rawInput } = options;
	const validation = validateRuntimeRunInput(rawInput);
	if (!validation.ok) {
		throw new SubagentValidationError(
			validation.failure.error,
			validation.failure.backend,
		);
	}
	validateRunnableInput(validation.input, validation.input.executor.id);
	const cwd = resolve(validation.input.cwd ?? process.cwd());
	return { input: validation.input, cwd, signal, registry };
}

export async function runSubagent(
	options: RunSubagentOptions,
): Promise<RunSubagentResult> {
	const { input, cwd, signal, registry } = validateRunOptions(options);
	try {
		const mode = executionMode(input);
		const asyncRequested =
			input.async === true ||
			input.onComplete === "detach" ||
			input.onComplete === "notify";
		if (mode === "parallel") {
			return asyncRequested
				? await startAsyncParallelSubagentRuns(input, cwd, signal)
				: await runParallelSubagentTasks(input, cwd, signal, { registry });
		}

		if (asyncRequested) {
			return await startAsyncSubagentRun({ input, cwd, signal });
		}

		return await runSubagentTask({ input, cwd, signal, registry });
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { failureKind?: unknown }).failureKind === "validation"
		) {
			throw new SubagentValidationError(
				error instanceof Error ? error.message : String(error),
			);
		}
		throw error;
	}
}

export async function getSubagentStatus(
	options: GetSubagentStatusOptions,
): Promise<RunStatusSnapshot | null> {
	return await getRunStatus(options);
}

export async function getSubagentLogs(
	options: GetSubagentLogsOptions,
): Promise<RunLogsSnapshot | null> {
	return await getRunLogs(options);
}

export async function waitForSubagent(
	options: WaitForSubagentOptions,
): Promise<WaitForRunResult> {
	return await waitForRun(options);
}

export async function interruptSubagent(
	options: InterruptSubagentOptions,
): Promise<InterruptRunResult> {
	return await interruptRun(options);
}

function defaultChildStatus(
	event: RecordSubagentChildEventOptions["event"],
): Status {
	if (event === "started" || event === "updated") return "running";
	if (event === "completed") return "completed";
	if (event === "cancelled") return "cancelled";
	return "failed";
}

export async function recordSubagentChildEvent(
	options: RecordSubagentChildEventOptions,
): Promise<RunEvent> {
	const {
		event,
		childRunId,
		workflowRunId,
		childTaskId,
		failureKind,
		message,
		usage,
	} = options;
	const ref = await resolveRunRef(options);
	return await appendRunEvent(ref, {
		type: `child.${event}`,
		status: options.status ?? defaultChildStatus(event),
		...(message === undefined ? {} : { message }),
		data: {
			childRunId,
			...(workflowRunId === undefined ? {} : { workflowRunId }),
			...(childTaskId === undefined ? {} : { taskId: childTaskId }),
			...(failureKind === undefined ? {} : { failureKind }),
			...(usage === undefined ? {} : { usage }),
		},
	});
}

// ---------------------------------------------------------------------------------------------
// WP2b: durable control channel (engine side). Works from any process that can read the run
// directory: the launching host may be gone; the attempt's executing process serves the mailbox.

/** Default bound for waiting on a mailbox ack. */
export const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 10_000;

export type ControlTargetRef = RunStatusRef;

interface AttemptLocation {
	attemptId: string;
	attemptDir: string;
}

async function locateAttempt(ref: ControlTargetRef): Promise<AttemptLocation> {
	const resolved = await resolveRunRef(ref);
	const record = await readRunRecord(resolved);
	if (record === null)
		throw new SubagentValidationError(`run ${ref.runId} was not found`);
	const attemptId =
		ref.attemptId ??
		ref.taskId ??
		record.activeAttemptId ??
		record.latestAttemptId ??
		undefined;
	const attempt = record.attempts.find(
		(candidate) => candidate.attemptId === attemptId,
	);
	if (attemptId === undefined || attempt === undefined)
		throw new SubagentValidationError(
			`run ${ref.runId} has no attempt ${attemptId ?? "(none)"}`,
		);
	const cwd = attempt.artifactCwd ?? record.cwd ?? resolved.cwd;
	const { runDir } = runPaths({
		cwd,
		runId: ref.runId,
		runsDir: record.runsDir ?? resolved.runsDir,
	});
	return { attemptId, attemptDir: join(runDir, "attempts", attemptId) };
}

async function attemptTerminal(attemptDir: string): Promise<boolean> {
	try {
		const result = JSON.parse(
			await readFile(join(attemptDir, "result.json"), "utf8"),
		) as { status?: unknown };
		return (
			typeof result.status === "string" &&
			isTerminalStatus(result.status as Status)
		);
	} catch {
		return false;
	}
}

export interface PendingApproval {
	runId: string;
	attemptId: string;
	requestId: string;
	kind: string;
	detail?: string;
	requestedAt: string;
	/** When the runtime denies by default if nobody answers. */
	deadlineAt: string | null;
}

/**
 * Approval requests of the attempt that wait for a host answer (requested, not decided, attempt
 * not terminal). Read from the attempt's approval audit (`approvals.jsonl`).
 */
export async function listPendingApprovals(
	ref: ControlTargetRef,
): Promise<PendingApproval[]> {
	const { attemptId, attemptDir } = await locateAttempt(ref);
	if (await attemptTerminal(attemptDir)) return [];
	const audit = await readApprovalAudit(attemptDir);
	const decided = new Set(
		audit
			.filter((record) => record.phase === "decided")
			.map((record) => record.requestId),
	);
	return audit
		.filter(
			(record): record is ApprovalAuditRequested =>
				record.phase === "requested" &&
				record.deadlineAt !== null &&
				!decided.has(record.requestId),
		)
		.map((record) => ({
			runId: ref.runId,
			attemptId,
			requestId: record.requestId,
			kind: record.kind,
			...(record.detail === undefined ? {} : { detail: record.detail }),
			requestedAt: record.at,
			deadlineAt: record.deadlineAt,
		}));
}

export interface ControlRequestOptions {
	/** How long to wait for the ack. Default 10 s. */
	ackTimeoutMs?: number;
}

export type RespondApprovalResult =
	| {
			status: "acked";
			seq: number;
			/** accepted | unknown_request | too_late (from the executing process or the closed mailbox). */
			result: ApprovalResponseResult;
			ack: ControlAck;
	  }
	| { status: "rejected"; seq: number; error: string; ack: ControlAck }
	| { status: "timeout"; seq: number };

/**
 * Answer an approval request through the attempt's control mailbox and wait for the ack. The
 * executing process applies it (exactly once, in seq order) and acks with the executor's
 * `respond` result; a terminal attempt or a closed mailbox answers `too_late`.
 */
export async function respondApproval(
	ref: ControlTargetRef,
	requestId: string,
	decision: ApprovalDecision,
	options: ControlRequestOptions = {},
): Promise<RespondApprovalResult> {
	if (typeof requestId !== "string" || requestId === "")
		throw new SubagentValidationError("requestId must be a non-empty string");
	if (decision !== "allow" && decision !== "deny")
		throw new SubagentValidationError('decision must be "allow" or "deny"');
	const { attemptDir } = await locateAttempt(ref);
	const { seq, file } = await writeControlRequest(attemptDir, {
		type: "approval_response",
		requestId,
		decision,
	});
	const waited = await awaitControlAck({
		attemptDir,
		seq,
		file,
		timeoutMs: options.ackTimeoutMs ?? DEFAULT_CONTROL_ACK_TIMEOUT_MS,
		isTerminal: () => attemptTerminal(attemptDir),
	});
	if (waited.status === "timeout") return { status: "timeout", seq };
	const { ack } = waited;
	if (!ack.ok || ack.request !== file)
		return {
			status: "rejected",
			seq,
			error: ack.request !== file ? "duplicate_seq" : (ack.error ?? "rejected"),
			ack,
		};
	return {
		status: "acked",
		seq,
		result: ack.result as ApprovalResponseResult,
		ack,
	};
}

export interface RequestCancelOptions extends ControlRequestOptions {
	/**
	 * scope "owned" only: when the executing process does not ack within `ackTimeoutMs`, fall back
	 * to the SIGTERM interrupt of the identity-verified worker (`interruptSubagent`). Default true.
	 */
	signalFallback?: boolean;
	reason?: string;
	escalateAfterMs?: number;
	killAfterMs?: number;
}

export type RequestCancelResult =
	| {
			via: "mailbox";
			seq: number;
			/** The CancelResult (an ACK is never termination evidence; observe the result). */
			result: CancelResult;
			ack: ControlAck;
	  }
	| { via: "rejected"; seq: number; error: string; ack: ControlAck }
	| { via: "signal"; seq: number; interrupt: InterruptRunResult }
	| { via: "timeout"; seq: number };

/**
 * Ask the executing process to cancel: `turn` is forwarded to `executor.cancel(ref, "turn")`;
 * `owned` takes the runtime stop path (cancel(owned) → grace → terminal cancelled/user_cancelled).
 * Without an ack in time, an owned cancel falls back to the SIGTERM interrupt.
 */
export async function requestCancel(
	ref: ControlTargetRef,
	scope: CancelScope,
	options: RequestCancelOptions = {},
): Promise<RequestCancelResult> {
	if (scope !== "turn" && scope !== "owned")
		throw new SubagentValidationError('scope must be "turn" or "owned"');
	const { attemptId, attemptDir } = await locateAttempt(ref);
	const { seq, file } = await writeControlRequest(attemptDir, {
		type: "cancel",
		scope,
	});
	const waited = await awaitControlAck({
		attemptDir,
		seq,
		file,
		timeoutMs: options.ackTimeoutMs ?? DEFAULT_CONTROL_ACK_TIMEOUT_MS,
		isTerminal: () => attemptTerminal(attemptDir),
	});
	if (waited.status === "acked") {
		const { ack } = waited;
		if (!ack.ok || ack.request !== file)
			return {
				via: "rejected",
				seq,
				error:
					ack.request !== file ? "duplicate_seq" : (ack.error ?? "rejected"),
				ack,
			};
		return { via: "mailbox", seq, result: ack.result as CancelResult, ack };
	}
	if (scope !== "owned" || options.signalFallback === false)
		return { via: "timeout", seq };
	const interrupt = await interruptRun({
		...ref,
		attemptId,
		reason:
			options.reason ??
			`control mailbox cancel (seq ${seq}) was not acknowledged; SIGTERM fallback`,
		...(options.escalateAfterMs === undefined
			? {}
			: { escalateAfterMs: options.escalateAfterMs }),
		...(options.killAfterMs === undefined
			? {}
			: { killAfterMs: options.killAfterMs }),
	});
	return { via: "signal", seq, interrupt };
}
