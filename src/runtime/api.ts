// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/api.ts. MIT, same author. Changes: the surface the core calls in WP4 instead of pi-subagent's SubagentApi. Pi-specific options (agent, backend, extensions, noExtensions, thinking, agentScope, confirmProjectAgents, roleContext, skills, toolResultBudget, visible) are refused; the run names its executor with `executor: ExecutorDescriptor` and carries SubmitRequest fields (effort, readOnly, mcpServers, env, isolation, approvalPolicy, resumeSessionId, attemptKey). Project-agent approval and supportsExplicitExtensionIsolation removed (no Pi agents/extensions in the runtime). reconcileSubagentRun is re-exported directly (same signature, plus registry/adoptTimeoutMs). parentSessionId is accepted from code callers. See docs/runtime-port.md "SubagentApi → runtime API".
import { resolve } from "node:path";
import type { ExecutorRegistry } from "../sdk/descriptor.js";
import {
	appendRunEvent,
	type ResultEnvelope,
	type RunEvent,
} from "./artifacts/index.js";
import type {
	ExecutionMode,
	FailureKind,
	ResolvedBackend,
	Status,
} from "./core/constants.js";
import {
	startAsyncParallelSubagentRuns,
	startAsyncSubagentRun,
} from "./orchestrate/async.js";
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
	createDurableLaunchBarrier,
	createDurableLaunchBarrierV2,
	durableLaunchBarrierDigest,
	isDurableLaunchBarrierError,
	isDurableLaunchBarrierRevokedError,
	readDurableLaunchBarrierV2State,
	releaseDurableLaunchBarrier,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	waitForDurableLaunchBarrierAck,
	waitForDurableLaunchBarrierReady,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
	DurableLaunchBarrierError,
	DurableLaunchBarrierRevokedError,
	type DurableLaunchBarrierAck,
	type DurableLaunchBarrierDescriptor,
	type DurableLaunchBarrierReady,
	type DurableLaunchBarrierRelease,
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

function executionMode(input: RuntimeRunInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
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
