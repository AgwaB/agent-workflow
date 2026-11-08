// The launch authority supplies the durable worker binding.
// Discarding an execution clears its active attempt. In worktree mode, write the terminal
// result once, after workspace finalization and control mailbox closure.
import { resolve } from "node:path";
import type { TaskActivity } from "../../core/task-activity.js";
import { ActivityHeartbeat } from "../telemetry/task-activity.js";
import type { WorkflowExecutor } from "../../sdk/contract.js";
import { type ExecutorRegistry, loadExecutor } from "../../sdk/descriptor.js";
import {
	appendRunEvent,
	beginRunRecord,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	createAttemptId,
	createRunId,
	readRunRecord,
	recordAttemptHeartbeat,
	upsertRunAttempt,
	type ResultEnvelope,
	type RunRef,
	type StoreResultEnvelopeInput,
} from "../artifacts/index.js";
import {
	isFailureKind,
	type FailureKind,
	type ResolveInput,
	type ExecutorId,
	userCancelledAbortReason,
} from "../core/constants.js";
import { createDurableLaunchAuthority } from "../durable-authority.js";
import type { ExecutionAuthority } from "../../sdk/authority.js";
import {
	discardPreparedWorkspace,
	finalizeWorktreeResult,
	retainOwnedWorkspace,
	resolveWorkspace,
	type ResolvedWorkspace,
} from "../workspace/worktree.js";
import {
	executeAttempt,
	type ExecutionNotStartedError,
	isExecutionNotStartedError,
} from "./execute.js";
import {
	AttemptControl,
	type ControlServer,
	startControlServer,
} from "./control.js";
import { writeAttemptExecutorRecord } from "./executor-record.js";
import { cleanupInactiveAttemptOwnership } from "./reconcile.js";
import {
	buildExecutionPlan,
	buildSubmitRequestFields,
	type ExecutionPlan,
	executionPlanDigest,
	type RuntimeRunInput,
	type RuntimeTaskInput,
	type SubmitRequestFields,
} from "./request.js";
import { writeRunLocator } from "./run-ref.js";
import { parallelConcurrency } from "./run-options.js";

export const MAX_PARALLEL_TASKS = 12;
// Public through the runtime index (unchanged); defined beside parallelConcurrency.
export {
	DEFAULT_PARALLEL_CONCURRENCY,
	MAX_PARALLEL_CONCURRENCY,
} from "./run-options.js";

export interface RunWorkerTaskOptions {
	input: RuntimeRunInput;
	cwd: string;
	/** Internal durable-worker continuation of the already-created active attempt. */
	resumeExistingAttempt?: boolean;
	signal?: AbortSignal;
	runId?: string;
	attemptId?: string;
	taskIndex?: number;
	/** Attempt start time (the durable payload's `startedAt`); anchors `deadlineMs`. */
	startedAt?: string;
	/** In-process executor modules checked before importing `executor.module`. */
	registry?: ExecutorRegistry;
}

export interface PreparedWorkerExecution {
	input: RuntimeRunInput & { task: string };
	ownership: {
		state: "prepared" | "execution-owned" | "finalized";
		cleanupStatus?: "not-needed" | "removed" | "kept" | "failed";
	};
	executorId: ExecutorId;
	runId: string;
	attemptId: string;
	baseCwd: string;
	workspace: ResolvedWorkspace;
	workspaceResult: ReturnType<typeof workspaceMeta>;
	startedAt: string;
	/** Absolute attempt artifact directory (SubmitRequest.artifactsDir). */
	attemptDir: string;
	/** SubmitRequest fields (without authority) the executor will receive. */
	request: SubmitRequestFields;
	executionPlan: ExecutionPlan;
	executionPlanSha256: string;
}

export interface MultiRunOptions {
	correlationId?: string;
	registry?: ExecutorRegistry;
}

export async function commitOwnedTerminalResult(
	ref: RunRef,
	result: ResultEnvelope,
): Promise<Awaited<ReturnType<typeof commitAttemptResultIfActive>>> {
	if (!(await cleanupInactiveAttemptOwnership(ref, result.attemptId)))
		throw Object.assign(
			new Error("inactive attempt ownership could not be drained"),
			{ failureKind: "internal" as const, terminalBlocked: true as const },
		);
	return await commitAttemptResultIfActive(ref, result);
}

export interface ParallelRunResult {
	mode: "parallel";
	runIds: string[];
	results: ResultEnvelope[];
	concurrency: number;
	totalTasks: number;
	startedCount: number;
	skippedCount: number;
	failFastTriggered: boolean;
}

export class WorkerToolAuthorityError extends Error {
	readonly failureKind = "validation" as const;
}

export function mergeTaskInput(
	parent: RuntimeRunInput,
	task: RuntimeTaskInput,
): RuntimeRunInput {
	return {
		...parent,
		...task,
		executor: task.executor ?? parent.executor,
		tasks: undefined,
		mode: "single",
		workspace: parent.workspace,
		worktree: parent.worktree,
		worktreePolicy: parent.worktreePolicy,
		concurrency: undefined,
		failFast: undefined,
		cancelSiblingsOnFailure: undefined,
		asyncDependency: undefined,
		runsDir: parent.runsDir,
		correlationId: parent.correlationId,
		parentSessionId: parent.parentSessionId,
		// A parent attemptKey cannot be shared by siblings (B3: one key, one effect).
		attemptKey: task.attemptKey,
	};
}

function workspaceMeta(workspace: ResolvedWorkspace) {
	return {
		mode: workspace.mode,
		cwd: workspace.baseCwd,
		worktreePath: workspace.worktreePath,
	};
}

function failureKindFromError(error: unknown): FailureKind {
	const candidate =
		typeof error === "object" && error !== null && "failureKind" in error
			? (error as { failureKind?: unknown }).failureKind
			: undefined;
	return isFailureKind(candidate) ? candidate : "internal";
}

function terminalCommitBlocked(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"terminalBlocked" in error &&
		(error as { terminalBlocked?: unknown }).terminalBlocked === true
	);
}

async function writeParallelErrorResult(options: {
	taskInput: RuntimeRunInput;
	cwd: string;
	runId: string;
	attemptId: string;
	error: unknown;
	cancelled: boolean;
	cancelFailureKind?: "abort" | "cancelled";
}): Promise<ResultEnvelope> {
	const message =
		options.error instanceof Error
			? options.error.message
			: String(options.error);
	const executorId: ExecutorId = options.taskInput.executor.id;
	const startedAt = new Date();
	const completedAt = new Date();
	const runRef = {
		cwd: options.cwd,
		runId: options.runId,
		runsDir: options.taskInput.runsDir,
	};
	await beginRunRecord({
		...runRef,
		mode: "single",
		executorId,
		startedAt,
		dependency: options.taskInput.asyncDependency ?? null,
		correlationId: options.taskInput.correlationId,
		parentSessionId: options.taskInput.parentSessionId,
		activeAttemptId: options.attemptId,
		attempts: [
			{
				attemptId: options.attemptId,
				status: "running",
				executorId,
				startedAt: startedAt.toISOString(),
			},
		],
	});
	await writeRunLocator({
		...runRef,
		parentSessionId: options.taskInput.parentSessionId,
		correlationId: options.taskInput.correlationId,
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: "run.started",
		status: "running",
		message: "parallel task error run started",
		data: { attemptId: options.attemptId },
	}).catch(() => undefined);
	const store = await createAttemptArtifactStore({
		cwd: options.cwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.taskInput.runsDir,
	});
	const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
	const output = await store.writeTextArtifact("output", "");
	const result = await store.writeResult({
		executorId,
		status: options.cancelled ? "cancelled" : "failed",
		failureKind: options.cancelled
			? (options.cancelFailureKind ?? "cancelled")
			: failureKindFromError(options.error),
		cwd: options.cwd,
		startedAt,
		completedAt,
		workspace: { mode: "shared", cwd: options.cwd },
		sandbox: { enabled: Boolean(options.taskInput.sandbox) },
		exitCode: null,
		signal: options.cancelled ? "SIGABRT" : null,
		artifacts: [stderr, output],
		correlationId: options.taskInput.correlationId,
		metadata: { contextLengthExceeded: false },
	});
	const committed = await commitOwnedTerminalResult(runRef, result).catch(
		() => ({ committed: false as const, record: null }),
	);
	if (!committed.committed) return result;
	await appendRunEvent(runRef, {
		type: options.cancelled ? "attempt.cancelled" : "attempt.failed",
		attemptId: options.attemptId,
		status: result.status,
		message,
		data: { failureKind: result.failureKind },
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: options.cancelled ? "run.cancelled" : "run.failed",
		status: result.status,
		message: `run ${result.status}`,
	}).catch(() => undefined);
	return result;
}

export async function prepareWorkerExecution(
	options: RunWorkerTaskOptions,
): Promise<PreparedWorkerExecution> {
	const input = Object.freeze({ ...options.input });
	const executorId = input.executor.id;
	const runId = options.runId ?? createRunId();
	const attemptId = options.attemptId ?? createAttemptId();
	const baseCwd = resolve(input.cwd ?? options.cwd);
	if (input.task === undefined)
		throw new Error(`${executorId} execution requires a task (prompt).`);
	const preparedInput: RuntimeRunInput & { task: string } = Object.freeze({
		...input,
		task: input.task,
	});
	const workspace = await resolveWorkspace({
		cwd: baseCwd,
		input: input as ResolveInput,
		taskIndex: options.taskIndex,
		runId,
	});
	const workspaceResult = workspaceMeta(workspace);
	let attemptDir: string;
	try {
		const existingRecord = await readRunRecord({
			cwd: baseCwd,
			runId,
			runsDir: input.runsDir,
		});
		const existingAttempt = existingRecord?.attempts.find(
			(attempt) => attempt.attemptId === attemptId,
		);
		if (
			options.resumeExistingAttempt === true &&
			(existingAttempt === undefined ||
				existingRecord?.activeAttemptId !== attemptId ||
				existingAttempt.process?.workerPid !== process.pid ||
				(existingAttempt.status !== "pending" &&
					existingAttempt.status !== "running"))
		)
			throw new Error(
				`attempt id ${attemptId} cannot be resumed by this worker`,
			);
		if (options.resumeExistingAttempt !== true && existingAttempt !== undefined)
			throw new Error(
				`attempt id ${attemptId} is already present in run ${runId}`,
			);
		const reservation = await upsertRunAttempt({
			cwd: baseCwd,
			runId,
			runsDir: input.runsDir,
			attemptId,
			status: "pending",
			executorId,
			failureKind: null,
			workspace: {
				...workspaceResult,
				worktreeCleanupStatus:
					workspace.mode === "worktree" ? "prepared" : "not-needed",
			},
			activate: true,
			createOnly: options.resumeExistingAttempt !== true,
			mustExist: options.resumeExistingAttempt === true,
			requireNoActive: options.resumeExistingAttempt !== true,
			onlyIfActive: options.resumeExistingAttempt === true,
		});
		const reservedAttempt = reservation.attempts.find(
			(attempt) => attempt.attemptId === attemptId,
		);
		if (
			reservation.activeAttemptId !== attemptId ||
			reservedAttempt === undefined ||
			(reservedAttempt.status !== "pending" &&
				reservedAttempt.status !== "running")
		)
			throw new Error(
				`attempt id ${attemptId} lost active ownership before preparation completed`,
			);
		attemptDir = (
			await createAttemptArtifactStore({
				cwd: baseCwd,
				runId,
				attemptId,
				runsDir: input.runsDir,
			})
		).attemptDir;
	} catch (error) {
		await discardPreparedWorkspace(workspace).catch(() => undefined);
		throw error;
	}
	const startedAt = options.startedAt ?? new Date().toISOString();
	const request = buildSubmitRequestFields({
		input: preparedInput,
		runId,
		attemptId,
		cwd: workspace.cwd,
		startedAt,
		artifactsDir: attemptDir,
	});
	const executionPlan = buildExecutionPlan({
		executor: input.executor,
		runId,
		attemptId,
		workspace: workspaceResult,
		request,
	});
	const executionPlanSha256 = executionPlanDigest(executionPlan);
	await writeAttemptExecutorRecord(attemptDir, {
		descriptor: input.executor,
		attemptKey: request.attemptKey,
		readOnly: request.readOnly,
		approvalPolicy: request.approvalPolicy,
		...(request.permissionMode === undefined
			? {}
			: { permissionMode: request.permissionMode }),
		executionPlanSha256,
	});
	return {
		input: preparedInput,
		ownership: { state: "prepared" as const },
		executorId,
		runId,
		attemptId,
		baseCwd,
		workspace,
		workspaceResult,
		startedAt,
		attemptDir,
		request,
		executionPlan,
		executionPlanSha256,
	};
}

/**
 * Discard the still-pristine workspace of an attempt that never released (nothing executed),
 * without touching the registry: the caller writes the terminal result itself (the durable
 * worker writes result.json and hands the commit to the terminal finalizer).
 */
export async function discardPreparedExecutionWorkspace(
	prepared: PreparedWorkerExecution,
): Promise<boolean> {
	if (prepared.ownership.state !== "prepared") return false;
	await discardPreparedWorkspace(prepared.workspace);
	prepared.ownership.state = "finalized";
	prepared.ownership.cleanupStatus =
		prepared.workspace.mode === "worktree" ? "removed" : "not-needed";
	return true;
}

export async function discardWorkerExecution(
	prepared: PreparedWorkerExecution,
): Promise<void> {
	if (!(await discardPreparedExecutionWorkspace(prepared))) return;
	await upsertRunAttempt({
		cwd: prepared.baseCwd,
		runId: prepared.runId,
		runsDir: prepared.input.runsDir,
		attemptId: prepared.attemptId,
		status: "cancelled",
		executorId: prepared.executorId,
		failureKind: "user_cancelled",
		completedAt: new Date(),
		workspace: {
			...prepared.workspaceResult,
			worktreeCleanupStatus:
				prepared.workspace.mode === "worktree" ? "removed" : "not-needed",
		},
		// A terminal upsert clears activeAttemptId only for the active attempt;
		// onlyIfActive protects a successor.
		mustExist: true,
		onlyIfActive: true,
	}).catch(() => undefined);
}

async function writeOwnedExecutionFailure(
	prepared: PreparedWorkerExecution,
	error: unknown,
): Promise<ResultEnvelope> {
	const { input, executorId, runId, attemptId, baseCwd, workspace } = prepared;
	const runRef = { cwd: baseCwd, runId, runsDir: input.runsDir };
	const existing = await readRunRecord(runRef);
	const existingAttempt = existing?.attempts.find(
		(attempt) => attempt.attemptId === attemptId,
	);
	const startedAt = existingAttempt?.startedAt ?? new Date().toISOString();
	const completedAt = new Date();
	const message = error instanceof Error ? error.message : String(error);
	const notStarted = isExecutionNotStartedError(error)
		? (error as ExecutionNotStartedError)
		: undefined;
	const failureKind = notStarted?.failureKind ?? failureKindFromError(error);
	const status =
		notStarted?.status ??
		(failureKind === "abort" ||
		failureKind === "cancelled" ||
		failureKind === "revoked" ||
		failureKind === "user_cancelled"
			? "cancelled"
			: "failed");

	// A pre-effect stop discards the pristine prepared worktree.
	// Anything that may have run keeps its workspace.
	let cleanupStatus: "not-needed" | "removed" | "kept";
	if (notStarted !== undefined && prepared.ownership.state === "prepared") {
		await discardPreparedWorkspace(workspace).catch(() => undefined);
		cleanupStatus = workspace.mode === "worktree" ? "removed" : "not-needed";
	} else {
		await retainOwnedWorkspace(workspace);
		cleanupStatus = workspace.mode === "worktree" ? "kept" : "not-needed";
	}
	const store = await createAttemptArtifactStore({
		...runRef,
		attemptId,
	});
	const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
	const output = await store.writeTextArtifact("output", "");
	const result = await store.writeResult({
		executorId,
		status,
		failureKind,
		cwd: baseCwd,
		startedAt,
		completedAt,
		workspace: {
			...prepared.workspaceResult,
			worktreeCleanupStatus: cleanupStatus,
		},
		sandbox: { enabled: Boolean(input.sandbox) },
		exitCode: null,
		signal: status === "cancelled" ? "SIGTERM" : null,
		artifacts: [stderr, output],
		correlationId: input.correlationId,
		metadata: {
			contextLengthExceeded: false,
			...(notStarted === undefined
				? {}
				: {
						executor: {
							id: executorId,
							attemptKey: prepared.request.attemptKey,
							authority: notStarted.authority,
						},
					}),
		},
	});
	prepared.ownership.state = "finalized";
	prepared.ownership.cleanupStatus = cleanupStatus;
	const committed = await commitOwnedTerminalResult(runRef, result);
	if (!committed.committed) return result;
	await appendRunEvent(runRef, {
		type: status === "cancelled" ? "attempt.cancelled" : "attempt.failed",
		attemptId,
		status,
		message,
		data: { failureKind },
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: status === "cancelled" ? "run.cancelled" : "run.failed",
		status,
		message: `run ${status}`,
	}).catch(() => undefined);
	return result;
}

export interface RunPreparedOptions {
	/** Durable workers share activity writes with their liveness heartbeat. */
	onActivity?(activity: TaskActivity): void;
	signal?: AbortSignal;
	deferTerminalCommit?: boolean;
	/** Already-loaded executor (the durable worker loads it before preparing). */
	executor?: WorkflowExecutor;
	registry?: ExecutorRegistry;
	/**
	 * Builds the authority handed to the executor. Receives the stop signal (user cancel, abort,
	 * or timeout). Default: a local durable authority (abort check + single-use record).
	 */
	createAuthority?: (stopSignal: AbortSignal) => ExecutionAuthority;
}

function linkedStop(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal; abort(reason: unknown): void; dispose(): void } {
	const controller = new AbortController();
	const forward = () => controller.abort(signal?.reason);
	if (signal?.aborted) forward();
	else signal?.addEventListener("abort", forward, { once: true });
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(
					() =>
						controller.abort(
							Object.assign(
								new Error(`attempt timed out after ${timeoutMs} ms`),
								{
									failureKind: "timeout" as const,
								},
							),
						),
					timeoutMs,
				);
	timer?.unref?.();
	return {
		signal: controller.signal,
		abort(reason) {
			if (!controller.signal.aborted) controller.abort(reason);
		},
		dispose() {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", forward);
		},
	};
}

export async function runPreparedWorkerExecution(
	prepared: PreparedWorkerExecution,
	options: RunPreparedOptions = {},
): Promise<ResultEnvelope> {
	const {
		input,
		executorId,
		runId,
		attemptId,
		baseCwd,
		workspace,
		workspaceResult,
	} = prepared;
	const startedAt = new Date();
	const runRef = { cwd: baseCwd, runId, runsDir: input.runsDir };

	await beginRunRecord({
		...runRef,
		mode: "single",
		executorId,
		startedAt,
		dependency: input.asyncDependency ?? null,
		correlationId: input.correlationId,
		parentSessionId: input.parentSessionId,
		attempts: [],
	});
	const runningRecord = await upsertRunAttempt({
		...runRef,
		attemptId,
		status: "running",
		executorId,
		failureKind: null,
		startedAt,
		completedAt: null,
		workspace: {
			...workspaceResult,
			worktreeCleanupStatus:
				workspace.mode === "worktree" ? "execution-owned" : "not-needed",
		},
		activate: false,
		onlyIfActive: true,
	});
	const runningAttempt = runningRecord.attempts.find(
		(attempt) => attempt.attemptId === attemptId,
	);
	if (
		runningRecord.activeAttemptId !== attemptId ||
		runningAttempt?.status !== "running"
	)
		throw new Error(
			`attempt id ${attemptId} lost active ownership before execution`,
		);
	await writeRunLocator({
		...runRef,
		parentSessionId: input.parentSessionId,
		correlationId: input.correlationId,
	}).catch(() => undefined);

	const stop = linkedStop(options.signal, input.timeoutMs);
	// WP2b: the durable control channel. Served while the attempt executes; closed (every request
	// acked) before the terminal result is written.
	const control = new AttemptControl({
		attemptDir: prepared.attemptDir,
		requestStop: (reason) => stop.abort(userCancelledAbortReason(reason)),
	});
	let controlServer: ControlServer | undefined;
	const closeControl = async () => {
		control.finish();
		await controlServer?.close().catch(() => undefined);
	};
	try {
		await appendRunEvent(
			{ ...runRef },
			{
				type: "attempt.started",
				attemptId,
				status: "running",
				message: `attempt ${attemptId} started`,
			},
		);
		const executor =
			options.executor ??
			(await loadExecutor(input.executor, { registry: options.registry }));
		const store = await createAttemptArtifactStore({ ...runRef, attemptId });
		const authority =
			options.createAuthority?.(stop.signal) ??
			createDurableLaunchAuthority({
				attemptKey: prepared.request.attemptKey,
				runId,
				attemptId,
				attemptDir: prepared.attemptDir,
				signal: stop.signal,
			});
		controlServer = await startControlServer({
			attemptDir: prepared.attemptDir,
			handlers: control.handlers,
		});
		// Foreground attempts have no worker pulse. Only write when the latest intent changed.
		const activityHeartbeat = new ActivityHeartbeat((activity) =>
			recordAttemptHeartbeat({ ...runRef, attemptId, activity }),
		);
		const activityTimer = options.onActivity
			? undefined
			: setInterval(() => {
					void activityHeartbeat.tick(Date.now());
				}, 1000);
		activityTimer?.unref();
		const report = await executeAttempt({
			onActivity:
				options.onActivity ??
				((activity) => activityHeartbeat.update(activity)),
			executor,
			request: prepared.request,
			authority,
			store,
			stopSignal: stop.signal,
			control,
			...(input.captureToolCalls === true ? { captureToolCalls: true } : {}),
			onReleased() {
				// Before release the worktree is still pristine and discardable.
				prepared.ownership.state = "execution-owned";
			},
			async onSubmitted(ref) {
				await appendRunEvent(runRef, {
					type: "attempt.executor_submitted",
					attemptId,
					status: "running",
					message: `executor ${executor.id} accepted attempt ${attemptId}`,
					data: { ref: { ...ref } },
				}).catch(() => undefined);
			},
		}).finally(async () => {
			if (activityTimer) clearInterval(activityTimer);
			await activityHeartbeat.drain();
			await closeControl();
		});
		const stderr = await store.writeTextArtifact(
			"stderr",
			report.message.length === 0 ? "" : `${report.message}\n`,
		);
		const output = await store.writeTextArtifact("output", report.outputText);
		const resultInput: StoreResultEnvelopeInput = {
			executorId,
			status: report.status,
			failureKind: report.failureKind,
			cwd: baseCwd,
			startedAt,
			completedAt: new Date(),
			workspace: {
				...workspaceResult,
				worktreeCleanupStatus:
					workspace.mode === "worktree" ? "execution-owned" : "not-needed",
			},
			sandbox: { enabled: Boolean(input.sandbox) },
			exitCode: null,
			signal: null,
			artifacts: [stderr, output, ...report.artifacts],
			correlationId: input.correlationId,
			metadata: {
				contextLengthExceeded: false,
				...(report.outputPartial ? { outputPartial: true } : {}),
				...(prepared.request.model === undefined
					? {}
					: { model: prepared.request.model }),
				...(report.usage === undefined ? {} : { usage: report.usage }),
				...(report.toolResultBudget === undefined
					? {}
					: { toolResultBudget: report.toolResultBudget }),
				...(report.sessionId === undefined
					? {}
					: { sessionId: report.sessionId }),
				...(input.parentSessionId === undefined
					? {}
					: { parentSessionId: input.parentSessionId }),
				executor: report.executor,
			},
		};
		// WP2b terminal-last-write: in worktree mode the terminal result.json is written once, by
		// the worktree finalization, after its status/diff artifacts (it used to be written
		// terminal first with cleanup "execution-owned", then rewritten).
		const result =
			workspace.mode === "worktree" && workspace.worktreePath !== null
				? await finalizeWorktreeResult(
						workspace,
						store.buildResult(resultInput),
						input.runsDir,
					)
				: await store.writeResult(resultInput);
		prepared.ownership.state = "finalized";
		const terminalCleanupStatus = result.workspace.worktreeCleanupStatus;
		prepared.ownership.cleanupStatus =
			terminalCleanupStatus === "removed" ||
			terminalCleanupStatus === "kept" ||
			terminalCleanupStatus === "failed" ||
			terminalCleanupStatus === "not-needed"
				? terminalCleanupStatus
				: workspace.mode === "worktree"
					? "kept"
					: "not-needed";

		if (options.deferTerminalCommit === true) return result;
		const committed = await commitOwnedTerminalResult(runRef, result);
		if (!committed.committed) return result;
		await appendRunEvent(
			{ ...runRef },
			{
				type:
					result.status === "completed"
						? "attempt.completed"
						: result.status === "cancelled"
							? "attempt.cancelled"
							: "attempt.failed",
				attemptId,
				status: result.status,
				message: `attempt ${attemptId} ${result.status}`,
				data: {
					failureKind: result.failureKind,
					exitCode: result.exitCode,
					signal: result.signal,
				},
			},
		);
		await appendRunEvent(
			{ ...runRef },
			{
				type:
					result.status === "completed"
						? "run.completed"
						: result.status === "cancelled"
							? "run.cancelled"
							: "run.failed",
				status: result.status,
				message: `run ${result.status}`,
			},
		);
		return result;
	} catch (error) {
		await closeControl();
		if (prepared.ownership.state !== "prepared")
			await retainOwnedWorkspace(workspace).catch(() => undefined);
		// The owning entry point commits the fallback result after this method
		// releases executor/workspace control.
		throw error;
	} finally {
		stop.dispose();
	}
}

export async function runWorkerTask(
	options: RunWorkerTaskOptions,
): Promise<ResultEnvelope> {
	const prepared = await prepareWorkerExecution(options);
	try {
		return await runPreparedWorkerExecution(prepared, {
			signal: options.signal,
			registry: options.registry,
		});
	} catch (error) {
		if (terminalCommitBlocked(error)) throw error;
		if (
			prepared.ownership.state === "execution-owned" ||
			isExecutionNotStartedError(error)
		)
			return await writeOwnedExecutionFailure(prepared, error);
		await discardWorkerExecution(prepared).catch(() => undefined);
		throw error;
	}
}

export async function runParallelWorkerTasks(
	input: RuntimeRunInput,
	cwd: string,
	signal?: AbortSignal,
	options: MultiRunOptions = {},
): Promise<ParallelRunResult> {
	if (!input.tasks || input.tasks.length === 0)
		throw new WorkerToolAuthorityError(
			"parallel mode requires a non-empty tasks array.",
		);
	if (input.tasks.length > MAX_PARALLEL_TASKS)
		throw new WorkerToolAuthorityError(
			`too many parallel tasks (${input.tasks.length}); max is ${MAX_PARALLEL_TASKS}.`,
		);
	for (const [index, task] of input.tasks.entries()) {
		if (task.task === undefined)
			throw new WorkerToolAuthorityError(
				`parallel tasks[${index}] requires a non-empty task.`,
			);
	}

	const tasks = input.tasks;
	const runCwd = resolve(input.cwd ?? cwd);
	const concurrency = Math.min(parallelConcurrency(input), tasks.length);
	const resultSlots: Array<ResultEnvelope | undefined> = new Array(
		tasks.length,
	);
	const failFast =
		input.failFast === true || input.cancelSiblingsOnFailure === true;
	const cancelSiblings = input.cancelSiblingsOnFailure === true;
	const controller = cancelSiblings ? new AbortController() : undefined;
	const childSignal = controller?.signal ?? signal;
	let nextIndex = 0;
	let startedCount = 0;
	let stopScheduling = false;
	let failFastTriggered = false;
	let parentAbortTriggered = false;
	let siblingCancelTriggered = false;

	function triggerFailFast(): void {
		if (!failFast) return;
		failFastTriggered = true;
		stopScheduling = true;
		if (cancelSiblings && !controller?.signal.aborted) {
			siblingCancelTriggered = true;
			controller?.abort();
		}
	}

	function onParentAbort(): void {
		parentAbortTriggered = true;
		controller?.abort();
	}
	function parentIsAborted(): boolean {
		return parentAbortTriggered || signal?.aborted === true;
	}
	if (signal !== undefined) {
		if (signal.aborted) onParentAbort();
		else signal.addEventListener("abort", onParentAbort, { once: true });
	}

	async function worker(): Promise<void> {
		while (true) {
			if (stopScheduling) return;
			const index = nextIndex;
			nextIndex += 1;
			if (index >= tasks.length) return;
			startedCount += 1;
			const taskInput = mergeTaskInput(input, tasks[index]!);
			const runId = createRunId();
			const attemptId = createAttemptId();
			if (parentIsAborted()) {
				stopScheduling = true;
				const abortError = Object.assign(
					new Error("parallel execution was aborted before task start"),
					{ failureKind: "abort" as const },
				);
				resultSlots[index] = await writeParallelErrorResult({
					taskInput,
					cwd: runCwd,
					runId,
					attemptId,
					error: abortError,
					cancelled: true,
					cancelFailureKind: "abort",
				});
				return;
			}
			try {
				const result = await runWorkerTask({
					input: taskInput,
					cwd: runCwd,
					signal: childSignal,
					runId,
					attemptId,
					taskIndex: index,
					registry: options.registry,
				});
				resultSlots[index] = result;
				const parentCancelled =
					parentIsAborted() &&
					(result.status === "cancelled" || result.failureKind === "abort");
				if (result.status !== "completed" && !parentCancelled)
					triggerFailFast();
			} catch (error) {
				if (parentIsAborted()) throw error;
				const siblingAbort =
					controller?.signal.aborted === true &&
					siblingCancelTriggered &&
					!parentAbortTriggered;
				const result = await writeParallelErrorResult({
					taskInput,
					cwd: runCwd,
					runId,
					attemptId,
					error,
					cancelled: siblingAbort,
				});
				resultSlots[index] = result;
				if (!siblingAbort) triggerFailFast();
			}
		}
	}

	try {
		const workers = await Promise.allSettled(
			Array.from({ length: concurrency }, () => worker()),
		);
		const rejected = workers.find(
			(workerResult): workerResult is PromiseRejectedResult =>
				workerResult.status === "rejected",
		);
		if (rejected !== undefined) throw rejected.reason;
	} finally {
		if (signal !== undefined)
			signal.removeEventListener("abort", onParentAbort);
	}

	const results = resultSlots.filter(
		(result): result is ResultEnvelope => result !== undefined,
	);
	return {
		mode: "parallel",
		runIds: results.map((result) => result.runId),
		results,
		concurrency,
		totalTasks: tasks.length,
		startedCount,
		skippedCount: Math.max(0, tasks.length - startedCount),
		failFastTriggered,
	};
}
