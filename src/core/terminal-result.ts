// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 4246-4510, 6320-6393 (terminal result mapping). MIT, same author. Changes: runtime failure kind needs_decision blocks the task (statusDetail executor_needs_decision, B3: no retry/relaunch, batches stop instead of falling back); executor wording instead of "child Pi"/"pi-subagent".
import { markForeachBatchStopped } from "./foreach-batch-runtime.js";
import { setTaskTerminal } from "./store.js";
import { type SubagentRunStatusSnapshot } from "./runtime-port.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recordedTaskStateCwd } from "./task-artifacts.js";
import { activeForeachBatchRecordForTask } from "./foreach-batch-runtime.js";
import {
	materializeTerminalForeachBatchResult,
	terminalForeachBatchStatus,
} from "./foreach-recovery.js";
import { observeLiveModelWorkerCompletion } from "./launch-slots.js";
import {
	hasPartialSubagentOutput,
	materializeTerminalArtifactGraphResult,
	shouldAttemptArtifactGraphSalvage,
} from "./output-validation.js";
import { recordTerminalParentSubagentChildEvent } from "./parent-child-events.js";
import {
	applyTaskResultArtifact,
	resultCompletedAfterTimeout,
} from "./result.js";
import {
	classifyDeterministicBootFailure,
	classifyPermanentModelFailure,
	modelRateLimitBackoffKey,
	recordSharedModelRateLimitBackoff,
	retryOrFailTransientSubagentFailure,
	shouldRetryTransientModelFailure,
	transientFailureAttemptPath,
	transientModelRateLimitBackoffMs,
} from "./retry-policy.js";
import { fromProjectPath, isTerminalTaskStatus, nowIso } from "./store.js";
import {
	copyLogOrEmptyMeasured,
	findLog,
	readFailedToolCalls,
	readJsonLoose,
	readToolCallsSummary,
	safeArtifactPath,
	writeJson,
} from "./task-artifacts.js";
import {
	recordTaskTimingTelemetry,
	recordTerminalTaskObservability,
} from "./task-observability.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";

export async function materializeTerminalSubagentResult(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
): Promise<boolean> {
	const outputRef = findLog(snapshot, "output");
	const stderrRef = findLog(snapshot, "stderr");
	const resultRef = findLog(snapshot, "result");
	const outputFile = fromProjectPath(cwd, task.files.output);
	const stderrFile = fromProjectPath(cwd, task.files.stderr);
	const resultFile = fromProjectPath(cwd, task.files.result);
	const artifactRoot = task.backendFiles?.runsDir
		? fromProjectPath(
				recordedTaskStateCwd(cwd, task),
				task.backendFiles.runsDir,
			)
		: undefined;

	await mkdir(dirname(outputFile), { recursive: true });
	const [outputCopy, stderrCopy] = await Promise.all([
		copyLogOrEmptyMeasured(snapshot, outputRef, outputFile, artifactRoot),
		copyLogOrEmptyMeasured(snapshot, stderrRef, stderrFile, artifactRoot),
	]);
	recordTaskTimingTelemetry(task, {
		terminalOutputCopyMs: outputCopy.durationMs,
		terminalStderrCopyMs: stderrCopy.durationMs,
		terminalOutputBytes: outputCopy.bytes,
		terminalStderrBytes: stderrCopy.bytes,
	});

	const subagentResult = resultRef
		? await readJsonLoose<Record<string, unknown>>(
				safeArtifactPath(snapshot, resultRef, artifactRoot),
			)
		: undefined;
	const toolCalls = await readToolCallsSummary(
		snapshot,
		subagentResult,
		artifactRoot,
	);
	const failedToolCalls = await readFailedToolCalls(
		snapshot,
		subagentResult,
		artifactRoot,
	);
	const [outputText, stderrText] = await Promise.all([
		readFile(outputFile, "utf8").catch(() => ""),
		readFile(stderrFile, "utf8").catch(() => ""),
	]);
	const outputBytes = Buffer.byteLength(outputText, "utf8");
	let statusInfo = workflowStatusFromSubagent(
		snapshot,
		subagentResult,
		outputBytes,
	);
	const deterministicBootFailure = classifyDeterministicBootFailure({
		statusInfo,
		stderrText,
		outputBytes,
		contextLengthExceeded: Boolean(
			(subagentResult?.metadata as any)?.contextLengthExceeded ??
				snapshot.metadata?.contextLengthExceeded,
		),
	});
	if (deterministicBootFailure) {
		statusInfo = {
			status: "failed",
			failureKind: "deterministic_boot",
			errorMessage: deterministicBootFailure,
		};
	}
	const completedAt =
		typeof subagentResult?.completedAt === "string"
			? subagentResult.completedAt
			: (snapshot.completedAt ?? nowIso());
	const startedAt =
		typeof subagentResult?.startedAt === "string"
			? subagentResult.startedAt
			: snapshot.startedAt;
	const exitCode =
		typeof subagentResult?.exitCode === "number"
			? subagentResult.exitCode
			: statusInfo.status === "completed"
				? 0
				: 1;
	let errorMessage =
		statusInfo.errorMessage ??
		(typeof subagentResult?.errorMessage === "string"
			? subagentResult.errorMessage
			: undefined);
	const contextLengthExceeded = Boolean(
		(subagentResult?.metadata as any)?.contextLengthExceeded ??
			snapshot.metadata?.contextLengthExceeded,
	);
	const permanentModelFailure = classifyPermanentModelFailure({
		statusInfo,
		errorMessage,
		stderrText,
		outputBytes,
		contextLengthExceeded,
		subagentResult,
		snapshotMetadata: snapshot.metadata,
	});
	if (permanentModelFailure) {
		statusInfo = {
			status: "failed",
			failureKind: "permanent_model_failure",
			errorMessage: permanentModelFailure,
		};
		errorMessage = permanentModelFailure;
	}
	recordTerminalTaskObservability({
		task,
		snapshot,
		subagentResult,
		startedAt,
		completedAt,
	});
	recordTaskOwnedSession(task, snapshot, subagentResult);
	const activeForeachBatch = activeForeachBatchRecordForTask(run, task);
	// B3: the runtime could not prove whether the attempt launched (reconcile `unknown`). Stop
	// in a state that needs an owner decision; never retry, relaunch or fall back (a batch is
	// stopped with both members blocked instead of falling back to per-item launches).
	if (statusInfo.failureKind === EXECUTOR_NEEDS_DECISION_FAILURE_KIND) {
		const blocked =
			activeForeachBatch && task.foreachBatch?.role === "leader"
				? markForeachBatchStopped(run, activeForeachBatch)
				: [task];
		const message = `${statusInfo.errorMessage ?? "executor attempt state is unknown"} (runtime run ${snapshot.runId}/${snapshot.attemptId})`;
		await writeJson(resultFile, {
			status: "blocked",
			failureKind: statusInfo.failureKind,
			completedAt,
			startedAt,
			errorMessage: message,
			subagent: {
				runId: snapshot.runId,
				attemptId: snapshot.attemptId,
				backend: snapshot.backend,
				failureKind: snapshot.failureKind,
				resultPath: resultRef?.path,
				artifactCwd: resultRef?.artifactCwd,
				metadata: snapshot.metadata,
			},
		});
		for (const blockedTask of blocked) {
			setTaskTerminal(
				blockedTask,
				"blocked",
				EXECUTOR_NEEDS_DECISION_STATUS_DETAIL,
				{ completedAt, exitCode: 1, lastMessage: message },
			);
			delete blockedTask.backendHandle;
			delete blockedTask.backendFiles;
		}
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return true;
	}
	if (activeForeachBatch && task.foreachBatch?.role === "leader") {
		activeForeachBatch.physicalExecution = {
			leaderTaskId: task.taskId,
			...(task.usage === undefined ? {} : { usage: task.usage }),
			...(task.timing === undefined ? {} : { timing: task.timing }),
		};
		const changed = await materializeTerminalForeachBatchResult({
			cwd,
			run,
			task,
			record: activeForeachBatch,
			rawOutput: outputText,
			stderr: stderrText,
			snapshot,
			status: terminalForeachBatchStatus(statusInfo.status),
			completedAt,
			startedAt,
			exitCode,
		});
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	if (statusInfo.status === "completed") {
		observeLiveModelWorkerCompletion(
			modelRateLimitBackoffKey(task),
			task.timing?.executionMs,
		);
	}
	if (task.artifactGraph?.enabled && statusInfo.status === "completed") {
		const changed = await materializeTerminalArtifactGraphResult(
			cwd,
			run,
			task,
			{
				outputFile,
				stderrFile,
				resultFile,
				completedAt,
				startedAt,
				exitCode,
				subagentResult,
				subagentToolCalls: failedToolCalls,
				subagentToolCallsSummary: toolCalls,
			},
		);
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	if (
		shouldAttemptArtifactGraphSalvage({
			task,
			statusInfo,
			outputBytes,
			outputText,
			exitCode,
			contextLengthExceeded,
			subagentResult,
			snapshot,
		})
	) {
		const changed = await materializeTerminalArtifactGraphResult(
			cwd,
			run,
			task,
			{
				outputFile,
				stderrFile,
				resultFile,
				completedAt,
				startedAt,
				exitCode,
				subagentResult,
				subagentToolCalls: failedToolCalls,
				subagentToolCallsSummary: toolCalls,
				salvage: {
					failureKind:
						statusInfo.failureKind ?? snapshot.failureKind ?? "model",
					subagentStatus: snapshot.status,
					subagentFailureKind: snapshot.failureKind,
				},
			},
		);
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	const workflowResult = {
		status: statusInfo.status,
		failureKind: statusInfo.failureKind,
		exitCode,
		completedAt,
		startedAt,
		errorMessage,
		noFinalOutput: outputBytes === 0,
		contextLengthExceeded,
		subagent: {
			runId: snapshot.runId,
			attemptId: snapshot.attemptId,
			backend: snapshot.backend,
			failureKind: snapshot.failureKind,
			resultPath: resultRef?.path,
			artifactCwd: resultRef?.artifactCwd,
			metadata: hasPartialSubagentOutput(snapshot, subagentResult)
				? { ...snapshot.metadata, outputPartial: true }
				: snapshot.metadata,
			completion: snapshot.completion,
			toolsConfigured: task.tools,
			toolCalls: toolCalls?.summary,
			toolCallsPath: failedToolCalls?.ref.path,
			toolCallsSummaryPath: toolCalls?.ref.path,
			toolCallsArtifactCwd:
				failedToolCalls?.ref.artifactCwd ?? toolCalls?.ref.artifactCwd,
			failedToolCalls: failedToolCalls?.records,
		},
	};
	if (
		shouldRetryTransientModelFailure(statusInfo, workflowResult, outputBytes)
	) {
		const retryAttempt = (task.launchRetry?.attempts ?? 0) + 1;
		const rateLimitBackoffMs = transientModelRateLimitBackoffMs({
			attempt: retryAttempt,
			failureKind: statusInfo.failureKind,
			modelBackoffKey: modelRateLimitBackoffKey(task),
			errorMessage,
			stderrText,
			subagentResult,
			snapshotMetadata: snapshot.metadata,
		});
		await recordSharedModelRateLimitBackoff(task, rateLimitBackoffMs);
		await writeJson(
			transientFailureAttemptPath(resultFile, retryAttempt),
			workflowResult,
		);
		const changed = retryOrFailTransientSubagentFailure(task, {
			reason:
				rateLimitBackoffMs === undefined
					? (statusInfo.failureKind ?? "model")
					: "model_rate_limit",
			message: errorMessage ?? "executor run failed before producing output",
			backoffMs: rateLimitBackoffMs,
		});
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	await writeJson(resultFile, workflowResult);

	const completedAfterTimeout = resultCompletedAfterTimeout(task, completedAt);
	const changed = await applyTaskResultArtifact(cwd, task, {
		resultFile,
		result: workflowResult,
		status: statusInfo.status,
		completedAfterTimeout,
	});
	if (isTerminalTaskStatus(task.status)) {
		delete task.backendHandle;
		delete task.backendFiles;
	}
	await recordTerminalParentSubagentChildEvent(run, task, snapshot);
	return changed;
}

function workflowStatusFromSubagent(
	snapshot: SubagentRunStatusSnapshot,
	result: Record<string, unknown> | undefined,
	outputBytes: number,
): {
	status: WorkflowTaskRunRecord["status"];
	failureKind?: string;
	errorMessage?: string;
} {
	const contextLengthExceeded = Boolean(
		(result?.metadata as any)?.contextLengthExceeded ??
			snapshot.metadata?.contextLengthExceeded,
	);
	const outputPartial = hasPartialSubagentOutput(snapshot, result);
	if (snapshot.failureKind === EXECUTOR_NEEDS_DECISION_FAILURE_KIND) {
		const workerExit = (
			snapshot.metadata?.executor as { workerExit?: unknown } | undefined
		)?.workerExit;
		return {
			status: "blocked",
			failureKind: EXECUTOR_NEEDS_DECISION_FAILURE_KIND,
			errorMessage: `executor reconcile could not prove whether the attempt launched; an owner decision is required (resume relaunches with a new attempt, stop abandons it)${typeof workerExit === "string" ? `; worker: ${workerExit}` : ""}`,
		};
	}
	if (snapshot.status === "completed" && outputPartial)
		return {
			status: "failed",
			failureKind: "partial_output",
			errorMessage: "executor reported unverified partial output",
		};
	if (snapshot.status === "completed" && outputBytes === 0)
		return {
			status: "failed",
			failureKind: "no_final_output",
			errorMessage: "executor produced no final assistant output",
		};
	if (snapshot.status === "completed") return { status: "completed" };
	if (
		snapshot.failureKind === "model" &&
		outputBytes > 0 &&
		snapshot.metadata?.stopReason === "stop" &&
		!outputPartial &&
		!contextLengthExceeded
	) {
		return { status: "completed" };
	}
	if (contextLengthExceeded)
		return {
			status: "failed",
			failureKind: "context_or_request_too_large",
			errorMessage: "executor exceeded the model context window",
		};
	if (snapshot.status === "cancelled")
		return {
			status: "interrupted",
			failureKind: snapshot.failureKind ?? "cancelled",
			errorMessage: "executor run was cancelled",
		};
	if (snapshot.failureKind === "timeout")
		return {
			status: "failed",
			failureKind: "timeout",
			errorMessage: "executor run timed out",
		};
	if (
		snapshot.failureKind === "abort" ||
		snapshot.failureKind === "cancelled" ||
		snapshot.failureKind === "stale"
	) {
		return {
			status: "interrupted",
			failureKind: snapshot.failureKind,
			errorMessage: `executor run ${snapshot.failureKind}`,
		};
	}
	return {
		status: "failed",
		failureKind: snapshot.failureKind ?? "model",
		errorMessage: snapshot.failureKind
			? `executor run failed: ${snapshot.failureKind}`
			: "executor run failed",
	};
}

/** Runtime failure kind for reconcile `unknown` (docs/runtime-port.md "Failure kinds"). */
export const EXECUTOR_NEEDS_DECISION_FAILURE_KIND = "needs_decision";
/** Task statusDetail of a task blocked on an owner decision (B3). Resumable by an explicit resume. */
export const EXECUTOR_NEEDS_DECISION_STATUS_DETAIL = "executor_needs_decision";

/**
 * R#10 (D3): remember a worker session the executor kept and reported as `ownedSession`
 * (runtime `metadata.executor.ownedSession`). Retention deletes exactly these locators.
 */
export function recordTaskOwnedSession(
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
	subagentResult: Record<string, unknown> | undefined,
): void {
	const metadata = (subagentResult?.metadata ?? snapshot.metadata) as
		| Record<string, unknown>
		| undefined;
	const executor = metadata?.executor as Record<string, unknown> | undefined;
	const owned = executor?.ownedSession as Record<string, unknown> | undefined;
	if (
		typeof executor?.id !== "string" ||
		typeof owned?.kind !== "string" ||
		typeof owned.locator !== "string" ||
		owned.kind.length === 0 ||
		owned.locator.length === 0
	)
		return;
	const entry = {
		executorId: executor.id,
		kind: owned.kind,
		locator: owned.locator,
		backendRunId: snapshot.runId,
		backendAttemptId: snapshot.attemptId,
		recordedAt: nowIso(),
	};
	task.ownedSessions ??= [];
	if (
		!task.ownedSessions.some(
			(existing) =>
				existing.executorId === entry.executorId &&
				existing.kind === entry.kind &&
				existing.locator === entry.locator,
		)
	)
		task.ownedSessions.push(entry);
}
