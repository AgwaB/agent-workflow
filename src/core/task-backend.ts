// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 535-558, 2868-3609, 3821-4245, 6401-6701, 6756-6774, 7371-end, and src/backend.ts (the backend object and its fatal-error wrapper). MIT, same author. Changes: implements the WorkflowBackend on the runtime API (executor descriptor recorded on the run, engine-issued attemptKey, SubmitRequest fields readOnly/isolation/approvalPolicy/env/mcpServers); Pi argv/extension preflight/noExtensions/skills/toolResultBudget/worker-role process env not ported (Pi executor, WP6); R#5 worktree gate before launch; registered for local-pi/headless run records. WP4d: launch-time capability decision from the run's recorded B4 negotiation (refusal → fatal before any effect; forcedReadOnly → SubmitRequest.readOnly and approval policy). WP4e: SubmitRequest.permissionMode from the run record (absent = safe). WP10: the system and task prompts are rendered per executor (artifact tool visible name, artifact tool guidelines section); the workflow_web_* source-card hint is removed (C2) and the refs URL hint names the CLI web tools. WP35: Pi-only per-task options (inheritHostTools; fast/fastApi when negotiation accepted fastTier) reach the Pi executor as per-task descriptor config. WP31: each task launches on its own executor in mixed runs (compiled runtime.executor, descriptor from run.roleExecution).
import { PI_EXECUTOR_ID } from "../executors/pi/version.js";
import { INHERITED_HOST_TOOL_NAMES } from "./tool-policy.js";
import type { ExecutorDescriptor } from "../sdk/descriptor.js";
import type { NegotiationReport } from "../sdk/requirements.js";
import { isPlainObject, type JsonValue } from "../sdk/json.js";
import type { ToolKind } from "../sdk/events.js";
import { isMutatingKind, PI_TOOL_KINDS } from "../sdk/tools.js";
import { AGENT_WORKFLOW_ROLE_ENV } from "./process-role.js";
import {
	workflowTaskCapabilityLaunch,
	workflowTaskInheritsContext,
} from "./capability-negotiation.js";
import {
	ARTIFACT_ACCESS_CONFIG_FILE,
	ARTIFACT_MCP_SERVER_NAME,
	artifactAccessConfigPath,
	artifactMcpServerSpec,
	artifactServerOutputLimitForRun,
	readArtifactAccessConfig,
	WORKFLOW_ARTIFACT_TOOL_NAME,
	withArtifactMcpOutputLimit,
} from "./artifact-access.js";
import {
	renderWorkerPromptToolNames,
	renderWorkerTaskPromptToolNames,
	workflowArtifactToolGuidelinesSection,
} from "./artifact-tool-names.js";
import { DEFAULT_WORKER_TOOLS, workflowTaskReadOnly } from "./tool-policy.js";
import { WORKFLOW_TASK_BACKEND_ID } from "./task-artifacts.js";
import {
	type WorkflowBackend,
	registerWorkflowBackend,
} from "./task-launch.js";
import { type WorkflowLaunchAuthorityGrant } from "./types.js";
import { cleanupSubagentRun } from "./task-cancellation.js";
import { createHash } from "node:crypto";
import {
	createOrResumeDurableLaunchBarrier,
	settleDurableLaunchBarrier,
} from "./launch-barrier-engine.js";
import { isTaskRuntimeApiInjected } from "./runtime-port.js";
import { workflowRunPermissionMode } from "./permission-mode.js";
import {
	recordedRunExecutorDescriptor,
	LEGACY_RECORD_EXECUTOR_ID,
	resolveRunExecutorSelection,
} from "./executor-registry.js";
import {
	type DurableLaunchBarrierDescriptor,
	type SubagentApi,
	type SubagentResultEnvelope,
	type SubagentRunStatusSnapshot,
	hasDurableLaunchBarrierApi,
	loadSubagentApi,
} from "./runtime-port.js";

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	activeForeachBatchRecordForTask,
	foreachBatchTasks,
	setForeachBatchPhase,
} from "./foreach-batch-runtime.js";
import {
	fallbackForeachBatchAfterTerminal,
	recoverForeachBatchRuntime,
} from "./foreach-recovery.js";
import {
	WorkflowLaunchAuthorityConsumedError,
	WorkflowLaunchAuthorityRegisteredError,
	assertCurrentWorkflowLaunchAuthority,
	consumeRegisteredWorkflowLaunchAuthority,
	consumeWorkflowLaunchAuthority,
	createWorkflowLaunchAuthority,
	hasNonSpawnableWorkflowLaunchAuthority,
	issueWorkflowLaunchAuthority,
	registerWorkflowLaunchAuthority,
} from "./launch-authority.js";
import { reconcileDurableLaunchBarrierTask } from "./launch-barrier-engine.js";
import {
	assertPreparedLaunchMatchesRecordedProvenance,
	assertRecordedLaunchBootstrapProvenance,
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "./launch-bootstrap-provenance.js";
import {
	SUBAGENT_LAUNCH_ACK_TIMEOUT_MS,
	SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
	SubagentOperationTimeoutError,
	awaitSubagentOperation,
	combineAbortSignals,
	sleep,
	throwIfAborted,
	throwIfLaunchStopped,
} from "./launch-operations.js";
import { workflowTaskSessionId } from "./launch-session.js";
import {
	releaseUnneededOwnedSessions,
	workflowTaskKeepsSession,
} from "./owned-session-release.js";
import {
	afterLaunchAuthorityRegisteredHookForTests,
	beforeRunSubagentHookForTests,
	isLaunchGateSaturated,
	reconcileLiveModelWorkerSlots,
	releaseLiveModelWorkerSlotForTask,
	resolveMaxConcurrentLaunches,
	runWithLaunchSlot,
	transientRetryJitterMs,
	tryAcquireLiveModelWorkerSlot,
} from "./launch-slots.js";
import { modelTaskRuntimeDeadlineMs } from "./model-task-runtime.js";
import { recordParentSubagentChildEvent } from "./parent-child-events.js";
import {
	assertWorkflowResourcePolicyMatchesTask,
	resolveWorkflowResourcePolicy,
} from "./resource-inheritance.js";
import { isTaskTimedOut, markTaskTimedOut } from "./result.js";
import {
	launchRetryBackoffRemainingMs,
	modelRateLimitBackoffKey,
	sharedModelRateLimitBackoffRemaining,
	sharedModelRateLimitBackoffWaitingMessage,
} from "./retry-policy.js";
import {
	fromProjectPath,
	isTerminalTaskStatus,
	nowIso,
	setTaskTerminal,
	toProjectPath,
	writeRunRecord,
} from "./store.js";
import {
	type SubagentBackendHandle,
	copyLogOrEmpty,
	findLog,
	getSubagentHandle,
	makeSubagentHandle,
	recordedTaskStateCwd,
	recoverSubagentHandle,
	subagentRunsDir,
	workflowTaskStateCwd,
} from "./task-artifacts.js";
import { acknowledgeSubagentTaskInterrupted } from "./task-cancellation.js";
import {
	type BackendLaunchResult,
	type PreparedWorkflowTaskLaunch,
} from "./task-launch.js";
import {
	bindTaskToolResultBudgetPendingConfiguration,
	clearTaskToolResultBudgetPendingConfiguration,
	dynamicTaskToolResultBudgetConfiguration,
	elapsedSince,
	recordTaskLaunchTiming,
	recordTaskTimingTelemetry,
	recordTaskToolResultBudgetPendingConfiguration,
} from "./task-observability.js";
import { materializeTerminalSubagentResult } from "./terminal-result.js";
import {
	type CompiledTask,
	type CompiledToolProvider,
	type WorkflowDurableLaunchBarrierRecord,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";
import { writeWorkflowPartialOutputLedgerFromFile } from "./workflow-partial-output.js";
import {
	isWorkflowStopRequestedError,
	throwIfWorkflowStopRequested,
} from "./workflow-stop.js";

const STALE_LAUNCH_CLAIM_GRACE_MS = 30_000;
const REFRESH_STATUS_RECONCILE_CONCURRENCY = 8;
export async function launchSubagentTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
	leaseSignal?: AbortSignal,
	workflowStopSignal?: AbortSignal,
	preparedLaunch?: PreparedWorkflowTaskLaunch,
): Promise<BackendLaunchResult> {
	if (task.status !== "pending") return { kind: "launched" };
	if (task.backendHandle || task.pid) return { kind: "launched" };

	await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
	// B2: the executor recorded at run creation; a missing or invalid one is fatal before any
	// effect (no fallback executor).
	let executor: ExecutorDescriptor;
	// WP4d (B4): the recorded capability negotiation decides refusal and forced readOnly for this
	// task before any effect; runs recorded before WP4d carry none and are not checked.
	let capabilityLaunch: ReturnType<typeof workflowTaskCapabilityLaunch>;
	try {
		// Runs created directly through the store (or imported records) carry no selection yet:
		// they get the legacy record executor (pi-workflow records ran on Pi), which must itself be
		// available (never a substitute). New runs always record a selection (WP17 host default).
		if (run.executor === undefined) {
			run.executor = resolveRunExecutorSelection({
				defaultExecutor: LEGACY_RECORD_EXECUTOR_ID,
			});
			await writeRunRecord(cwd, run);
		}
		// WP31 (Q4): the task's own executor in a mixed run (role profile).
		executor = recordedRunExecutorDescriptor(
			run,
			compiledTask.runtime.executor,
		);
		capabilityLaunch = workflowTaskCapabilityLaunch(run, compiledTask);
	} catch (error) {
		return {
			kind: "fatal",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	// R#5 (D2): a task that requires a worktree must run inside its managed worktree. This is
	// the last gate before an executor effect, whatever engine path prepared the task.
	assertWorktreeEnforced(task, compiledTask);

	const taskHasRateLimitRetry =
		(task.launchRetry?.attempts ?? 0) > 0 &&
		(task.launchRetry?.reason ?? "").startsWith("model_rate_limit");
	if ((task.launchRetry?.attempts ?? 0) > 0) {
		const backoffRemainingMs = launchRetryBackoffRemainingMs(task);
		if (backoffRemainingMs !== undefined && backoffRemainingMs > 0) {
			const message = `waiting until ${task.launchRetry?.nextEligibleAt} before retrying transient-model launch after rate-limit backoff`;
			const shouldWriteBackoffState =
				task.statusDetail !== "retry_model_failure" ||
				task.lastMessage !== message;
			task.statusDetail = "retry_model_failure";
			task.lastMessage = message;
			if (shouldWriteBackoffState) await writeRunRecord(cwd, run);
			return {
				kind: "capacity",
				message,
				retryAfterMs: backoffRemainingMs,
			};
		}
		if (backoffRemainingMs !== undefined && task.launchRetry) {
			delete task.launchRetry.nextEligibleAt;
			delete task.launchRetry.retryAfterMs;
		}
		const jitterMs = transientRetryJitterMs();
		task.statusDetail = "retry_model_failure";
		task.lastMessage = `waiting ${jitterMs}ms before retrying transient-model launch`;
		await writeRunRecord(cwd, run);
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		if (jitterMs > 0) {
			await sleep(jitterMs);
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		}
	}

	const sharedRateLimitBackoff = taskHasRateLimitRetry
		? undefined
		: await sharedModelRateLimitBackoffRemaining(
				modelRateLimitBackoffKey(task, compiledTask),
			);
	await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
	if (sharedRateLimitBackoff) {
		const message = sharedModelRateLimitBackoffWaitingMessage(
			sharedRateLimitBackoff.key,
			sharedRateLimitBackoff.nextEligibleAt,
		);
		const shouldWriteBackoffState =
			task.status !== "pending" ||
			task.statusDetail !== "pending" ||
			task.startedAt !== undefined ||
			task.lastMessage !== message;
		task.status = "pending";
		task.statusDetail = "pending";
		task.startedAt = undefined;
		task.lastMessage = message;
		if (shouldWriteBackoffState) await writeRunRecord(cwd, run);
		return {
			kind: "capacity",
			message,
			retryAfterMs: sharedRateLimitBackoff.remainingMs,
		};
	}

	const systemPromptFile = fromProjectPath(cwd, task.files.systemPrompt);
	const taskPromptFile = fromProjectPath(cwd, task.files.taskPrompt);
	const outputFile = fromProjectPath(cwd, task.files.output);
	const stderrFile = fromProjectPath(cwd, task.files.stderr);
	const resultFile = fromProjectPath(cwd, task.files.result);
	const runsDir = subagentRunsDir(run, task);
	// WP39b (O7): a worktree task's attempt state stays in the project (the worker runs in the
	// worktree as the runtime's execution directory).
	const stateCwd = workflowTaskStateCwd(cwd, task);
	const correlationId = `${run.runId}:${task.taskId}`;
	const sessionId = workflowTaskSessionId(run, task);

	let launched: SubagentResultEnvelope;
	const basePreparedLaunch =
		preparedLaunch ??
		(await prepareSubagentTaskLaunch(cwd, run, task, compiledTask));
	assertWorkflowResourcePolicyMatchesTask(
		compiledTask,
		basePreparedLaunch.resourcePolicy,
	);
	let sealedLaunch = basePreparedLaunch;
	if (!basePreparedLaunch.authority) {
		const provenance = await createLaunchBootstrapProvenance(
			cwd,
			run,
			task,
			compiledTask,
			WORKFLOW_TASK_BACKEND_ID,
			basePreparedLaunch,
		);
		recordLaunchBootstrapProvenance(task, provenance);
		const authority = createWorkflowLaunchAuthority(
			run,
			task,
			WORKFLOW_TASK_BACKEND_ID,
			provenance,
		);
		issueWorkflowLaunchAuthority(task, authority);
		sealedLaunch = { ...basePreparedLaunch, authority };
		await writeRunRecord(cwd, run);
	}
	const launchAuthority = sealedLaunch.authority;
	if (!launchAuthority)
		throw new Error("workflow launch authority is unavailable");
	const launchBootstrap = assertRecordedLaunchBootstrapProvenance(
		task,
		launchAuthority.launchBootstrapSha256,
	);
	const authorityBindingSha256 =
		launchBootstrap.effectivePolicy.externalLaunchGrantSha256;
	const toolResultBudgetConfiguration = sealedLaunch.toolResultBudget;
	const effectiveLaunchTools =
		compiledTask.runtime.tools === undefined &&
		sealedLaunch.hostContext === undefined
			? undefined
			: [...launchBootstrap.effectivePolicy.tools];
	// WP10: tasks with the artifact server get its guidelines (not every MCP client shows server
	// instructions). The prompt files keep the engine's canonical text (logical tool names; the
	// launch provenance digests compiledPrompt = task.md); the SubmitRequest carries the text
	// rendered for the executor (artifact tool by its visible name; WP37: the task prompt also names
	// the executor's own tools, see renderWorkerTaskPromptToolNames).
	const systemPrompt = buildSystemPrompt(compiledTask, effectiveLaunchTools, {
		artifactTool: launchHasArtifactTool(sealedLaunch, effectiveLaunchTools),
		// WP39b (O8): the Pi worker gets the host tools exactly when the sealed launch carries the
		// run's host context (piWorkerDescriptorConfig); its prompt must name them as available.
		inheritHostTools: sealedLaunch.hostContext !== undefined,
	});
	const renderedSystemPrompt = renderWorkerPromptToolNames(
		systemPrompt,
		executor.id,
	);
	const renderedTaskPrompt = renderControlSchemaPath(
		renderWorkerTaskPromptToolNames(compiledTask.compiledPrompt, executor.id),
		task,
	);
	let releaseLiveModelWorkerSlot: (() => void) | undefined;
	let launchApi: SubagentApi | undefined;
	let durableBarrierDescriptor: DurableLaunchBarrierDescriptor | undefined;
	let durableBarrierRecord: WorkflowDurableLaunchBarrierRecord | undefined;
	const hardenedBatchRecord =
		task.foreachBatch && !task.foreachBatch.batchingDisabled
			? (run.foreachBatches ?? []).find(
					(record) => record.batchId === task.foreachBatch?.batchId,
				)
			: undefined;
	try {
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const launchAbortSignal = combineAbortSignals(
			leaseSignal,
			workflowStopSignal,
		);
		const liveModelWorkerAdmission = tryAcquireLiveModelWorkerSlot({
			run,
			task,
			compiledTask,
		});
		if (liveModelWorkerAdmission.kind === "deferred") {
			const launchQueuedAt = task.timing?.launchQueuedAt ?? nowIso();
			task.status = "pending";
			task.statusDetail = "pending";
			task.startedAt = undefined;
			task.lastMessage = liveModelWorkerAdmission.message;
			recordTaskLaunchTiming(task, {
				launchQueuedAt,
				waitingForGlobalWorkerSlot: true,
			});
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: liveModelWorkerAdmission.message,
				retryAfterMs: liveModelWorkerAdmission.retryAfterMs,
			};
		}
		releaseLiveModelWorkerSlot = liveModelWorkerAdmission.release;

		await mkdir(dirname(systemPromptFile), { recursive: true });
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await rm(resultFile, { force: true });
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(systemPromptFile, systemPrompt, "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(taskPromptFile, compiledTask.compiledPrompt, "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(outputFile, "", "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(stderrFile, "", "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);

		if (toolResultBudgetConfiguration) {
			recordTaskToolResultBudgetPendingConfiguration({
				task,
				configuration: toolResultBudgetConfiguration,
				capturedAt: nowIso(),
			});
		}
		task.status = "running";
		task.statusDetail = "launching";
		task.startedAt = nowIso();
		task.backendFiles = {
			runsDir: toProjectPath(stateCwd, resolve(stateCwd, runsDir)),
			correlationId,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		task.lastMessage = `${executor.id} executor launch claim recorded`;
		await writeRunRecord(cwd, run);
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);

		const api = await loadSubagentApi();
		launchApi = api;
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const durableBarrierAvailable = hasDurableLaunchBarrierApi(api);
		if (
			!durableBarrierAvailable &&
			!isTaskRuntimeApiInjected() &&
			hardenedBatchRecord &&
			(hardenedBatchRecord.stateRootSha256 ||
				hardenedBatchRecord.capabilitySubjectSha256)
		)
			throw new Error(
				`foreach batch ${hardenedBatchRecord.batchId} requires the durable launch barrier API`,
			);
		if (!durableBarrierAvailable && !isTaskRuntimeApiInjected()) {
			throw new Error(
				"the runtime API does not support the required durable launch barrier",
			);
		}
		if (durableBarrierAvailable) {
			({ descriptor: durableBarrierDescriptor, record: durableBarrierRecord } =
				await createOrResumeDurableLaunchBarrier({
					cwd,
					run,
					task,
					compiledTask,
					api,
					launchAuthority,
					authorityBindingSha256,
				}));
		}
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const taskTimeoutMs = modelTaskRuntimeDeadlineMs(
			compiledTask.runtime.maxRuntimeMs,
		);
		const subagentOptions: Record<string, unknown> = {
			cwd: stateCwd,
			executor: workflowTaskExecutorDescriptor(
				executor,
				compiledTask,
				sealedLaunch,
				capabilityLaunch,
			),
			attemptKey: workflowExecutorAttemptKey(run, task, launchAuthority),
			task: renderedTaskPrompt,
			systemPrompt: renderedSystemPrompt,
			...(compiledTask.runtime.model === undefined
				? {}
				: { model: compiledTask.runtime.model }),
			...(compiledTask.runtime.thinking === undefined
				? {}
				: { effort: compiledTask.runtime.thinking }),
			readOnly:
				workflowTaskReadOnly(compiledTask) || capabilityLaunch.forcedReadOnly,
			isolation: workflowTaskIsolation(compiledTask),
			approvalPolicy: workflowTaskApprovalPolicy(
				compiledTask,
				capabilityLaunch.forcedReadOnly,
			),
			// WP4e: always explicit (records created before WP4e run as safe).
			permissionMode: workflowRunPermissionMode(run),
			env: { [AGENT_WORKFLOW_ROLE_ENV]: "worker" },
			async: true,
			onComplete: "detach",
			asyncDependency: "needed-before-final",
			workspace:
				stateCwd === task.cwd ? "shared" : { mode: "shared", path: task.cwd },
			worktreePolicy: "never",
			...(taskTimeoutMs === undefined ? {} : { timeoutMs: taskTimeoutMs }),
			runsDir,
			correlationId,
			// D3 (WP12a): the engine session id stays the attempt identity (backendFiles, launch
			// provenance); the executor is asked to keep a CLI session only when a same-session
			// repair may continue it. Otherwise adapters run without session persistence.
			...(sessionId === undefined || !workflowTaskKeepsSession(task)
				? {}
				: { sessionId }),
			...(durableBarrierDescriptor === undefined
				? {}
				: { durableLaunchBarrier: durableBarrierDescriptor }),
		};
		const launchQueuedAt = nowIso();
		let launchStartedAt: string | undefined;
		recordTaskLaunchTiming(task, { launchQueuedAt });
		if (isLaunchGateSaturated()) {
			task.lastMessage = `waiting for executor launch slot (${resolveMaxConcurrentLaunches()} max)`;
			await writeRunRecord(cwd, run).catch(() => undefined);
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		}
		launched = await runWithLaunchSlot(
			async () => {
				await beforeRunSubagentHookForTests?.();
				await assertPreparedSubagentTaskLaunch(sealedLaunch);
				assertWorkflowResourcePolicyMatchesTask(
					compiledTask,
					sealedLaunch.resourcePolicy,
				);
				await throwIfWorkflowStopRequested(cwd, run.runId);
				throwIfAborted(leaseSignal);
				throwIfAborted(workflowStopSignal);
				assertCurrentWorkflowLaunchAuthority(
					run,
					task,
					launchAuthority,
					WORKFLOW_TASK_BACKEND_ID,
				);
				await assertPreparedLaunchMatchesRecordedProvenance(
					cwd,
					run,
					task,
					compiledTask,
					WORKFLOW_TASK_BACKEND_ID,
					sealedLaunch,
					launchAuthority.launchBootstrapSha256,
				);
				// The sealed resource policy (skill discovery) maps to SubmitRequest.isolation
				// above; Pi's `skills: []` / extension isolation are Pi executor options (WP6).
				assertWorkflowResourcePolicyMatchesTask(
					compiledTask,
					sealedLaunch.resourcePolicy,
				);
				// `undefined` tools meant "the host's default tool selection" for Pi; the
				// runtime requires an explicit list, so use the same default worker tools.
				subagentOptions.tools =
					effectiveLaunchTools === undefined
						? [...DEFAULT_WORKER_TOOLS]
						: [...effectiveLaunchTools];
				subagentOptions.mcpServers = preparedMcpServers(sealedLaunch, {
					artifactOutputLimitChars: artifactServerOutputLimitForRun(
						run,
						task.runtime.executor,
					),
				});
				if (sealedLaunch.captureToolCalls)
					subagentOptions.captureToolCalls = true;
				// Tool-result budgets are enforced by the Pi executor only (C1, WP6); the
				// configuration stays sealed in the prepared launch and provenance.
				registerWorkflowLaunchAuthority(
					run,
					task,
					launchAuthority,
					WORKFLOW_TASK_BACKEND_ID,
				);
				await writeRunRecord(cwd, run);
				await afterLaunchAuthorityRegisteredHookForTests?.();
				await throwIfWorkflowStopRequested(cwd, run.runId);
				throwIfAborted(leaseSignal);
				throwIfAborted(workflowStopSignal);
				return awaitSubagentOperation(
					async () => {
						await throwIfWorkflowStopRequested(cwd, run.runId);
						throwIfAborted(leaseSignal);
						throwIfAborted(workflowStopSignal);
						return api.runSubagent(subagentOptions);
					},
					{
						operation: "launch acknowledgement",
						context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
						timeoutMs: SUBAGENT_LAUNCH_ACK_TIMEOUT_MS,
						signal: leaseSignal,
					},
				);
			},
			() => {
				launchStartedAt = nowIso();
				recordTaskLaunchTiming(task, { launchQueuedAt, launchStartedAt });
			},
			launchAbortSignal,
		);
		recordTaskLaunchTiming(task, {
			launchQueuedAt,
			launchStartedAt,
			launchCompletedAt: nowIso(),
		});
	} catch (error) {
		if (
			error instanceof WorkflowLaunchAuthorityRegisteredError ||
			error instanceof WorkflowLaunchAuthorityConsumedError
		) {
			releaseLiveModelWorkerSlot?.();
			task.status = "running";
			task.statusDetail = "launch_ack_pending";
			task.lastMessage =
				error instanceof WorkflowLaunchAuthorityConsumedError
					? "launch authority is already consumed; awaiting handle recovery"
					: "launch authority is already registered; awaiting correlation recovery";
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: task.lastMessage,
				retryAfterMs: STALE_LAUNCH_CLAIM_GRACE_MS,
			};
		}
		if (workflowStopSignal?.aborted || isWorkflowStopRequestedError(error)) {
			releaseLiveModelWorkerSlot?.();
			clearTaskToolResultBudgetPendingConfiguration(task);
			throw error;
		}
		if (leaseSignal?.aborted) {
			task.status = "running";
			task.statusDetail = "launch_ack_aborted";
			task.lastMessage =
				"launch acknowledgement wait aborted; retaining claim for correlation-based recovery";
			await writeRunRecord(cwd, run).catch(() => undefined);
			throw error;
		}
		if (error instanceof SubagentOperationTimeoutError) {
			task.status = "running";
			task.statusDetail = "launch_ack_timeout";
			task.lastMessage = `${error.message}; retaining launch claim for correlation-based recovery`;
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: task.lastMessage,
				retryAfterMs: STALE_LAUNCH_CLAIM_GRACE_MS,
			};
		}
		releaseLiveModelWorkerSlot?.();
		clearTaskToolResultBudgetPendingConfiguration(task);
		task.status = "pending";
		task.statusDetail = "pending";
		task.startedAt = undefined;
		task.lastMessage =
			"executor launch failed before backend handle was recorded";
		await writeRunRecord(cwd, run).catch(() => undefined);
		throw error;
	}

	const handle = makeSubagentHandle(
		task,
		launched.runId,
		launched.attemptId,
		runsDir,
		sessionId,
		stateCwd,
	);
	if (durableBarrierDescriptor !== undefined) {
		await settleDurableLaunchBarrier({
			cwd,
			run,
			task,
			handle,
			launched,
			launchApi,
			descriptor: durableBarrierDescriptor,
			record: durableBarrierRecord,
			launchAuthority,
			authorityBindingSha256,
			hardenedBatchRecord,
			leaseSignal,
			workflowStopSignal,
		});
	} else {
		consumeWorkflowLaunchAuthority(
			task,
			launchAuthority,
			launched.runId,
			launched.attemptId,
		);
	}
	task.backendHandle = handle;
	task.backendTaskId = launched.runId;
	if (toolResultBudgetConfiguration) {
		bindTaskToolResultBudgetPendingConfiguration({
			task,
			backendRunId: launched.runId,
			backendAttemptId: launched.attemptId,
			capturedAt: nowIso(),
		});
	}
	task.backendFiles = {
		runsDir: toProjectPath(stateCwd, resolve(stateCwd, runsDir)),
		correlationId,
		...(sessionId === undefined ? {} : { sessionId }),
	};
	task.statusDetail = "running";
	task.lastMessage = `launched via the ${executor.id} executor`;
	await writeRunRecord(cwd, run).catch(() => undefined);
	await recordParentSubagentChildEvent({
		event: "started",
		childRunId: launched.runId,
		run,
		task,
		message: task.lastMessage,
	});
	return { kind: "launched" };
}

interface RefreshPollItem {
	order: number;
	workflowRunId: string;
	task: WorkflowTaskRunRecord;
	handle: SubagentBackendHandle;
}

interface RefreshPollResult extends RefreshPollItem {
	snapshot: SubagentRunStatusSnapshot | null;
	reconcileMs: number;
	statusPollMs: number;
}

type RefreshPollOperation = "reconcile" | "status";

export async function refreshRunFromSubagentArtifacts(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
	let changed = await recoverForeachBatchRuntime(cwd, run);
	let telemetryChanged = false;
	const pollItems: RefreshPollItem[] = [];
	reconcileLiveModelWorkerSlots(run);

	for (const [order, task] of run.tasks.entries()) {
		if (isTerminalTaskStatus(task.status) || task.status !== "running")
			continue;
		const activeBatch = activeForeachBatchRecordForTask(run, task);
		if (activeBatch && task.foreachBatch?.role === "member") continue;
		if (
			activeBatch &&
			activeBatch.phase !== "launching" &&
			activeBatch.phase !== "running"
		)
			continue;
		let handle = getSubagentHandle(task);
		if (!handle) {
			handle = await recoverSubagentHandle(run, task, cwd);
			if (handle) {
				task.backendHandle = handle;
				task.backendTaskId = handle.runId;
				task.backendFiles = {
					runsDir: toProjectPath(
						handle.cwd,
						resolve(handle.cwd, handle.runsDir),
					),
					correlationId: `${run.runId}:${task.taskId}`,
					...(handle.sessionId === undefined
						? {}
						: { sessionId: handle.sessionId }),
				};
				task.statusDetail = "running";
				task.lastMessage = `adopted runtime run ${handle.runId}/${handle.attemptId}`;
				changed = true;
			}
		}
		if (task.durableLaunchBarrier) {
			if (await reconcileDurableLaunchBarrierTask(cwd, run, task))
				changed = true;
			handle = getSubagentHandle(task);
		}
		if (
			handle &&
			!task.durableLaunchBarrier &&
			consumeRegisteredWorkflowLaunchAuthority(
				run,
				task,
				WORKFLOW_TASK_BACKEND_ID,
				handle.runId,
				handle.attemptId,
			)
		) {
			// Recovery has just established a consumed host owner. Make that
			// authority durable before a terminal snapshot can publish raw; the
			// writer must not fall back through the old registered-only record.
			await writeRunRecord(cwd, run);
			changed = true;
		}
		if (handle && task.toolResultBudget?.pendingConfiguration) {
			bindTaskToolResultBudgetPendingConfiguration({
				task,
				backendRunId: handle.runId,
				backendAttemptId: handle.attemptId,
				capturedAt: nowIso(),
			});
			changed = true;
		}
		if (!handle) {
			if (isStaleLaunchClaim(task)) {
				if (
					hasNonSpawnableWorkflowLaunchAuthority(
						run,
						task,
						WORKFLOW_TASK_BACKEND_ID,
					)
				) {
					if (activeBatch) {
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							activeBatch,
							"batch launch authority could not be correlated",
						);
					} else {
						setTaskTerminal(
							task,
							"failed",
							"launch_authority_recovery_failed",
							{
								exitCode: 1,
								lastMessage:
									"registered launch authority could not be correlated; refusing duplicate spawn",
							},
						);
					}
				} else {
					resetStaleLaunchClaim(task);
					if (activeBatch) {
						const [, member] = foreachBatchTasks(run, activeBatch);
						setForeachBatchPhase(run, activeBatch, "prepared");
						member.status = "pending";
						member.statusDetail = "pending";
						member.startedAt = undefined;
						member.lastMessage =
							"foreach batch leader launch claim expired; retrying exact prepared pair";
					}
				}
				releaseLiveModelWorkerSlotForTask(run, task);
				changed = true;
				continue;
			}
			if (isTaskTimedOut(task)) {
				markSubagentTaskTimedOut(task);
				releaseLiveModelWorkerSlotForTask(run, task);
				if (activeBatch)
					await fallbackForeachBatchAfterTerminal(
						cwd,
						run,
						activeBatch,
						"batch leader timed out before a backend handle was recovered",
					);
				changed = true;
			}
			continue;
		}
		pollItems.push({ order, workflowRunId: run.runId, task, handle });
	}

	const api = pollItems.length > 0 ? await loadSubagentApi() : undefined;
	const pollResults = api
		? await allSettledBounded(
				pollItems,
				REFRESH_STATUS_RECONCILE_CONCURRENCY,
				(item) => pollSubagentForRefresh(api, item),
			)
		: [];
	const refreshErrors: unknown[] = [];

	for (const [pollIndex, pollResult] of pollResults.entries()) {
		if (pollResult.status === "rejected") {
			refreshErrors.push(pollResult.reason);
			const item = pollItems[pollIndex];
			if (item && isTaskTimedOut(item.task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, item.task);
					markSubagentTaskTimedOut(item.task);
					releaseLiveModelWorkerSlotForTask(run, item.task);
					const batch = activeForeachBatchRecordForTask(run, item.task);
					if (batch) {
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out after backend refresh failure",
						);
					}
				} catch (error) {
					markCancellationFailed(item.task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}
		const { task, handle, snapshot, reconcileMs, statusPollMs } =
			pollResult.value;
		recordTaskTimingTelemetry(task, {
			refreshReconcileMs: reconcileMs,
			refreshStatusPollMs: statusPollMs,
		});
		telemetryChanged = true;

		if (snapshot === null) {
			if (isTaskTimedOut(task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, task);
					markSubagentTaskTimedOut(task);
					releaseLiveModelWorkerSlotForTask(run, task);
					const batch = activeForeachBatchRecordForTask(run, task);
					if (batch)
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out while backend status was unavailable",
						);
				} catch (error) {
					markCancellationFailed(task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}

		const activeAttempt =
			snapshot.attempts?.find(
				(attempt) => attempt.attemptId === handle.attemptId,
			) ?? snapshot.attempts?.at(-1);
		const nextPid = activeAttempt?.workerPid ?? activeAttempt?.pid ?? task.pid;
		if (task.pid !== nextPid) {
			task.pid = nextPid;
			changed = true;
		}
		if (snapshot.status === "running" || snapshot.status === "pending") {
			await refreshRunningArtifactGraphPartialOutput(cwd, task, snapshot).catch(
				() => undefined,
			);
			if (task.statusDetail !== "running") {
				task.statusDetail = "running";
				changed = true;
			}
			const nextLastMessage = activeAttempt?.heartbeatAt
				? `executor heartbeat ${activeAttempt.heartbeatAt}`
				: "executor running";
			if (task.lastMessage !== nextLastMessage) {
				task.lastMessage = nextLastMessage;
				changed = true;
			}
			if (isTaskTimedOut(task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, task);
					markSubagentTaskTimedOut(task);
					releaseLiveModelWorkerSlotForTask(run, task);
					const batch = activeForeachBatchRecordForTask(run, task);
					if (batch)
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out",
						);
				} catch (error) {
					markCancellationFailed(task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}

		if (await materializeTerminalSubagentResult(cwd, run, task, snapshot)) {
			releaseLiveModelWorkerSlotForTask(run, task);
			changed = true;
		}
	}

	// D3 (WP12a): delete worker sessions no attempt can use again.
	if (await releaseUnneededOwnedSessions(run)) changed = true;
	if (changed || telemetryChanged) await writeRunRecord(cwd, run);
	if (refreshErrors.length > 0) {
		throw new AggregateError(
			refreshErrors,
			"one or more subagent refresh polls failed",
		);
	}
	return run;
}

async function pollSubagentForRefresh(
	api: SubagentApi,
	item: RefreshPollItem,
): Promise<RefreshPollResult> {
	const { handle } = item;
	const reconcileStartedAtMs = Date.now();
	try {
		await awaitSubagentOperation(
			() =>
				api.reconcileSubagentRun({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
				}),
			{
				operation: "reconcile",
				context: `workflow run ${item.workflowRunId} task ${item.task.taskId} subagent run ${handle.runId}/${handle.attemptId}`,
				timeoutMs: SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		throw refreshPollError(item, "reconcile", error);
	}
	const reconcileMs = elapsedSince(reconcileStartedAtMs);
	const statusPollStartedAtMs = Date.now();
	let snapshot: SubagentRunStatusSnapshot | null;
	try {
		snapshot = await awaitSubagentOperation(
			() =>
				api.getSubagentStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
					attemptId: handle.attemptId,
				}),
			{
				operation: "status",
				context: `workflow run ${item.workflowRunId} task ${item.task.taskId} subagent run ${handle.runId}/${handle.attemptId}`,
				timeoutMs: SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		throw refreshPollError(item, "status", error);
	}
	const statusPollMs = elapsedSince(statusPollStartedAtMs);
	return { ...item, snapshot, reconcileMs, statusPollMs };
}

function refreshPollError(
	item: RefreshPollItem,
	operation: RefreshPollOperation,
	error: unknown,
): Error {
	const { task, handle } = item;
	return new Error(
		`subagent refresh ${operation} failed for workflow run ${item.workflowRunId} task ${task.taskId} (${task.specId}) subagent run ${handle.runId}/${handle.attemptId}`,
		{ cause: error },
	);
}

async function allSettledBounded<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results = new Array<PromiseSettledResult<R>>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				try {
					results[index] = {
						status: "fulfilled",
						value: await worker(items[index]!, index),
					};
				} catch (reason) {
					results[index] = { status: "rejected", reason };
				}
			}
		}),
	);
	return results;
}

async function refreshRunningArtifactGraphPartialOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
): Promise<void> {
	const partial = task.artifactGraph?.output.partial;
	if (!partial || partial.paths.length === 0) return;
	const outputRef = findLog(snapshot, "output");
	const outputFile = fromProjectPath(cwd, task.files.output);
	const artifactRoot = task.backendFiles?.runsDir
		? fromProjectPath(
				recordedTaskStateCwd(cwd, task),
				task.backendFiles.runsDir,
			)
		: undefined;
	await copyLogOrEmpty(snapshot, outputRef, outputFile, artifactRoot);
	await writeWorkflowPartialOutputLedgerFromFile({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		outputFile,
		allowedPaths: partial.paths,
	});
}

async function interruptTimedOutSubagent(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<void> {
	await acknowledgeSubagentTaskInterrupted(cwd, run, task, "workflow timeout");
}

function markCancellationFailed(
	task: WorkflowTaskRunRecord,
	reason: string,
	error: unknown,
): void {
	task.statusDetail = "cancellation_failed";
	task.lastMessage = `${reason} cancellation failed; backend handle preserved: ${error instanceof Error ? error.message : String(error)}`;
}

function markSubagentTaskTimedOut(task: WorkflowTaskRunRecord): void {
	markTaskTimedOut(task);
	task.backendHandle = undefined;
	task.backendTaskId = task.taskId;
	task.pid = undefined;
}

function isStaleLaunchClaim(task: WorkflowTaskRunRecord): boolean {
	if (
		(task.statusDetail !== "launching" &&
			task.statusDetail !== "launch_ack_pending" &&
			task.statusDetail !== "launch_ack_timeout" &&
			task.statusDetail !== "launch_ack_aborted") ||
		!task.startedAt
	)
		return false;
	const startedAtMs = Date.parse(task.startedAt);
	return (
		Number.isFinite(startedAtMs) &&
		Date.now() - startedAtMs > STALE_LAUNCH_CLAIM_GRACE_MS
	);
}

function resetStaleLaunchClaim(task: WorkflowTaskRunRecord): void {
	clearTaskToolResultBudgetPendingConfiguration(task);
	task.status = "pending";
	task.statusDetail = "pending";
	task.startedAt = undefined;
	task.backendHandle = undefined;
	task.backendFiles = undefined;
	task.backendTaskId = task.taskId;
	task.pid = undefined;
	task.lastMessage = "stale executor launch claim reset";
}

function captureToolCallsEnabled(): boolean {
	const value = process.env.AGENT_WORKFLOW_CAPTURE_TOOL_CALLS;
	return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * WP35: the executor descriptor for one task. Pi-only per-task options travel as descriptor config
 * (docs/executors/pi.md): `inheritHostTools` exactly when the sealed launch carries the run's host
 * context (the task inherits host tools); `fast: "on"` (+ `fastApi`, the API the compiler bound)
 * when the task asks for the fast tier and the recorded negotiation accepted `fastTier` (an
 * `unverified` fastTier needs the run's opt-in; without it the preview said "runs without fast
 * tier", so the worker runs without it). Runs recorded before negotiation get no fast tier. Other
 * executors get the recorded descriptor unchanged.
 */
export function workflowTaskExecutorDescriptor(
	descriptor: ExecutorDescriptor,
	compiledTask: Pick<CompiledTask, "runtime">,
	launch: Pick<PreparedWorkflowTaskLaunch, "hostContext">,
	capability: { report?: NegotiationReport } = {},
): ExecutorDescriptor {
	if (descriptor.id !== PI_EXECUTOR_ID) return descriptor;
	const extra: Record<string, JsonValue> = {};
	if (launch.hostContext !== undefined) extra.inheritHostTools = true;
	const fastAccepted = capability.report?.entries.some(
		(entry) =>
			entry.key === "fastTier" &&
			(entry.outcome === "native" || entry.outcome === "emulated"),
	);
	if (compiledTask.runtime.fast === "on" && fastAccepted === true) {
		extra.fast = "on";
		const api = (compiledTask.runtime as { api?: unknown }).api;
		if (typeof api === "string" && api !== "") extra.fastApi = api;
	}
	if (Object.keys(extra).length === 0) return descriptor;
	const base = isPlainObject(descriptor.config) ? descriptor.config : {};
	return { ...descriptor, config: { ...base, ...extra } };
}

/**
 * Prepare the sealed launch inputs for one task (subagent-backend.ts 6406-6639). Pi-only parts
 * (provider extension resolution, fetch-cache/web-source/native-host/fast-mode wrappers, the
 * extension isolation probe) are not ported: they belong to the Pi executor (WP6) or were dropped
 * with the workflow web tools (C2). `extensions`/`generatedExtensions` therefore stay empty here.
 */
export async function prepareSubagentTaskLaunch(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
	requireArtifactBinding = false,
): Promise<PreparedWorkflowTaskLaunch> {
	const resourcePolicy = resolveWorkflowResourcePolicy(compiledTask);
	const toolProviders = compiledTask.runtime.toolProviders;
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const artifactBinding = await sealArtifactBinding(
		task,
		taskDir,
		requireArtifactBinding,
	);
	// Host-tool inheritance (Pi executor only, WP6): the prepared launch carries the run's
	// HostContext exactly when the task inherits host tools. WP35: launch provenance then requires
	// the run's executor to be pi (it receives `inheritHostTools` as per-task descriptor config,
	// workflowTaskExecutorDescriptor), so other executors fail closed.
	const hostContext =
		compiledTask.runtime.inheritHostTools === true &&
		compiledTask.runtime.tools?.length !== 0
			? run.hostContext
			: undefined;
	const toolResultBudget = dynamicTaskToolResultBudgetConfiguration(task);
	return {
		extensions: [],
		...(resourcePolicy === undefined ? {} : { resourcePolicy }),
		...(hostContext === undefined ? {} : { hostContext: { ...hostContext } }),
		...(toolProviders
			? { toolProviders: clonePreparedToolProviders(toolProviders) }
			: {}),
		generatedExtensions: [],
		captureToolCalls: captureToolCallsEnabled(),
		...(toolResultBudget === undefined ? {} : { toolResultBudget }),
		...(artifactBinding === undefined ? {} : { artifactBinding }),
	};
}

async function sealArtifactBinding(
	task: WorkflowTaskRunRecord,
	taskDir: string,
	required: boolean,
): Promise<PreparedWorkflowTaskLaunch["artifactBinding"]> {
	if (
		!task.artifactGraph?.enabled ||
		task.artifactGraph.artifactAccess === "none"
	)
		return undefined;
	const manifestPath = join(taskDir, "source-manifest.json");
	const configPath = join(taskDir, ARTIFACT_ACCESS_CONFIG_FILE);
	if (!required && !existsSync(manifestPath) && !existsSync(configPath))
		return undefined;
	try {
		const [expectedManifestBytes, access] = await Promise.all([
			readFile(manifestPath, "utf8"),
			readArtifactAccessConfig(configPath),
		]);
		if (artifactAccessConfigPath(access.config) !== configPath)
			throw new Error("artifact access config path mismatch");
		return {
			manifestPath,
			expectedManifestBytes,
			configPath,
			expectedConfigBytes: access.bytes,
			serverSpec: artifactMcpServerSpec(access.config),
		};
	} catch {
		throw new Error("launch-bootstrap artifact binding is unavailable");
	}
}

async function assertPreparedSubagentTaskLaunch(
	preparedLaunch: PreparedWorkflowTaskLaunch,
): Promise<void> {
	if (preparedLaunch.artifactBinding) {
		let actualManifest: string;
		let actualConfig: string;
		try {
			[actualManifest, actualConfig] = await Promise.all([
				readFile(preparedLaunch.artifactBinding.manifestPath, "utf8"),
				readFile(preparedLaunch.artifactBinding.configPath, "utf8"),
			]);
		} catch {
			throw new Error("launch-bootstrap artifact binding is unavailable");
		}
		if (
			actualManifest !== preparedLaunch.artifactBinding.expectedManifestBytes ||
			actualConfig !== preparedLaunch.artifactBinding.expectedConfigBytes
		)
			throw new Error("launch-bootstrap artifact binding drift detected");
	}
	for (const extension of preparedLaunch.generatedExtensions) {
		let actual: string;
		try {
			actual = await readFile(extension.path, "utf8");
		} catch {
			throw new Error("launch-bootstrap generated extension is unavailable");
		}
		if (actual !== extension.expectedBytes)
			throw new Error("launch-bootstrap generated extension drift detected");
	}
}

function clonePreparedToolProviders(
	providers: Record<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> {
	return Object.fromEntries(
		Object.entries(providers).map(([tool, provider]) => [
			tool,
			{
				...provider,
				...(provider.extensions !== undefined
					? { extensions: [...provider.extensions] }
					: {}),
				...(provider.fallbackTools !== undefined
					? { fallbackTools: [...provider.fallbackTools] }
					: {}),
				...(provider.mcpServer !== undefined
					? {
							mcpServer: {
								...provider.mcpServer,
								args: [...provider.mcpServer.args],
							},
						}
					: {}),
			},
		]),
	);
}

/** The task launches with the workflow_artifact MCP server (sealed binding, provider, or tool). */
function launchHasArtifactTool(
	preparedLaunch: Pick<
		PreparedWorkflowTaskLaunch,
		"toolProviders" | "artifactBinding"
	>,
	effectiveLaunchTools: readonly string[] | undefined,
): boolean {
	return (
		preparedLaunch.artifactBinding !== undefined ||
		Object.values(preparedLaunch.toolProviders ?? {}).some(
			(provider) => provider.mcpServer?.name === ARTIFACT_MCP_SERVER_NAME,
		) ||
		(effectiveLaunchTools ?? []).includes(WORKFLOW_ARTIFACT_TOOL_NAME)
	);
}

function buildSystemPrompt(
	task: CompiledTask,
	effectiveLaunchTools: readonly string[] | undefined,
	options: { artifactTool?: boolean; inheritHostTools?: boolean } = {},
): string {
	const workflowMaxDigestChars = task.artifactGraph?.output.maxDigestChars;
	const workflowRefsMinItems = task.artifactGraph?.output.refsMinItems;
	const workflowRefsUrlValidation =
		task.artifactGraph?.output.refsUrlValidation;
	const workflowOutputContract =
		task.foreachBatchSynthetic?.schema === "workflow-foreach-batch-v1"
			? [
					"# Workflow Output Contract",
					"This is a runtime-managed foreach batch. The exact outer control envelope is defined in the task prompt and overrides singleton control requirements.",
					"Your final response must start exactly with <control> and end exactly with </refs>, with no prose outside the three required sections.",
					"Do not add a singleton control.digest field or any other outer-envelope key not required by the batch prompt.",
				]
			: task.artifactGraph?.enabled
				? [
						"# Workflow Output Contract",
						"For this workflow task, the output protocol in the task prompt overrides any direct-response format in the agent definition.",
						"Your final response must start exactly with <control> and end exactly with </refs>.",
						"Do not include preambles, status updates, Markdown headings, or prose outside the required workflow output sections.",
						"Never start with status text such as 'I have enough evidence' or 'Composing output'; put all explanatory prose inside <analysis> only.",
						...(workflowMaxDigestChars !== undefined
							? [
									`The control.digest string is required and must be at most ${workflowMaxDigestChars} characters; prefer one short sentence.`,
								]
							: []),
						...(workflowRefsMinItems !== undefined && workflowRefsMinItems > 0
							? [
									`The <refs> JSON array must include at least ${workflowRefsMinItems} item${workflowRefsMinItems === 1 ? "" : "s"}. Include URLs or local file paths used by the analysis.`,
								]
							: []),
						...(workflowRefsUrlValidation
							? [
									"External URLs in <refs> are validated before completion. Use the available web tools to open the URL and check the evidence before citing it; replace stale or unreachable URLs with working canonical URLs or omit them.",
								]
							: []),
					]
				: [
						"When complete, provide a concise final report with findings, changed files if any, and blockers.",
					];
	const enabledTools = effectiveLaunchTools ?? [];
	const hostTools = options.inheritHostTools === true;
	const toolPolicy = [
		"# Effective Tool Policy",
		effectiveLaunchTools === undefined
			? "Tool availability follows the host's default tool selection."
			: enabledTools.length > 0
				? `Only these ${hostTools ? "workflow tools" : "tools"} are enabled for this workflow task: ${enabledTools.join(", ")}.`
				: `No ${hostTools ? "workflow tools" : "tools"} are enabled for this workflow task.`,
		// WP39b (live bundle 5, O8): inherited host tools (Pi executor only, never readOnly stages).
		hostTools
			? `Host tools inherited from the Pi session are also available: ${INHERITED_HOST_TOOL_NAMES.map((name) => (name === "mcp__*" ? "mcp__* (matching MCP tools)" : name)).join(", ")}; use them when the task needs them. Discover MCP tools through tool_search or codemode; trust, exposure and permission checks still apply.`
			: undefined,
		effectiveLaunchTools === undefined
			? "Use only tools actually available from the host."
			: hostTools
				? "If the agent definition below mentions other tools, ignore those mentions; tools outside these two lists cannot be called in this workflow run."
				: "If the agent definition below mentions tools that are not in this enabled list, ignore those mentions; unavailable tools cannot be called in this workflow run.",
		enabledTools.includes("mcp__*") && !hostTools
			? "mcp__* includes matching active MCP tools, not a literal callable name. Discover them through tool_search or codemode; trust, exposure and permission checks still apply."
			: undefined,
		// C2/WP10: the workflow_web_* source-card tools are gone; web tools are the CLI's own.
		!enabledTools.includes("get_search_content") &&
		(enabledTools.includes("web_search") ||
			enabledTools.includes("fetch_content"))
			? "Full cached search-content hydration is unavailable here. Use web_search/fetch_content results and report evidence gaps instead of broad raw document retrieval."
			: undefined,
	].filter((line): line is string => typeof line === "string");
	return [
		`You are workflow subagent '${task.agent}'.`,
		"You were launched by /workflow from a deterministic workflow spec.",
		"Do not assume parent conversation history.",
		"Do not launch other agents or orchestration workflows unless explicitly instructed.",
		...toolPolicy,
		...(options.artifactTool ? workflowArtifactToolGuidelinesSection() : []),
		...workflowOutputContract,
		"",
		"# Agent Definition",
		task.agentSystemPrompt.trim(),
		...(task.artifactGraph?.enabled
			? [
					"",
					"# Workflow Output Contract Reminder",
					"Ignore any agent-definition final-answer format that conflicts with the workflow output protocol. The first byte of your final answer must be '<' in <control>; place all prose inside <analysis>; end with </refs>.",
				]
			: []),
	].join("\n");
}

/**
 * Engine-issued executor attempt key (B3), stable per task attempt:
 * `awf1:<workflowRunId>:<taskId>:<16 hex>` where the hex is the first 16 characters of
 * SHA-256 over the launch authority's attempt identity (`launch-retry:N;output-retry:N;
 * resume:N[;physical:N];session:<id|none>`). A relaunch of the same logical attempt (crash
 * recovery, ack timeout) reuses the key, so an idempotent executor returns the existing ExecRef
 * instead of producing a second effect; every retry/resume/physical attempt gets a new key.
 */
export function workflowExecutorAttemptKey(
	run: Pick<WorkflowRunRecord, "runId">,
	task: Pick<WorkflowTaskRunRecord, "taskId">,
	launchAuthority: Pick<WorkflowLaunchAuthorityGrant, "attemptKey">,
): string {
	const digest = createHash("sha256")
		.update(launchAuthority.attemptKey, "utf8")
		.digest("hex")
		.slice(0, 16);
	return `awf1:${run.runId}:${task.taskId}:${digest}`;
}

/** B5: inherit the user's context files/skills only when the stage or agent opts in. */
/**
 * WP12a (live bundle 3 open problem 3): the compiled output protocol names the control schema
 * relative to the workflow bundle (`./schemas/…`), which does not resolve from the worker's cwd.
 * The prompt sent to the executor names the run's own copy of the schema
 * (`artifactGraph.output.controlSchemaPath`, absolute, under the run's `bundle/`) instead, so a
 * worker can read it from any cwd (also a worktree). The canonical task.md keeps the compiled text.
 */
export function renderControlSchemaPath(
	prompt: string,
	task: Pick<WorkflowTaskRunRecord, "artifactGraph">,
): string {
	const output = task.artifactGraph?.output;
	const relative = output?.controlSchema;
	const absolute = output?.controlSchemaPath;
	if (!relative || !absolute || !isAbsolute(absolute) || relative === absolute)
		return prompt;
	const marker = "workflow-local control schema file: ";
	return prompt.split(`${marker}${relative}`).join(`${marker}${absolute}`);
}

export function workflowTaskIsolation(compiledTask: CompiledTask): {
	inherit: boolean;
} {
	return { inherit: workflowTaskInheritsContext(compiledTask) };
}

/**
 * Engine approval policy (D2, R#4): kinds the stage's own tools imply are answered `allow`;
 * mutating kinds are never allowed for a read-only task; everything else is denied (there is no
 * interactive channel for workflow workers yet, WP2b).
 */
export function workflowTaskApprovalPolicy(
	compiledTask: CompiledTask,
	forcedReadOnly = false,
): {
	allowKinds: ToolKind[];
	interactive: false;
} {
	const kinds = new Set<ToolKind>();
	const tools = compiledTask.runtime.tools ?? [...DEFAULT_WORKER_TOOLS];
	for (const tool of tools) {
		const kind = (PI_TOOL_KINDS as Record<string, ToolKind | undefined>)[tool];
		if (kind !== undefined) kinds.add(kind);
	}
	const readOnly = workflowTaskReadOnly(compiledTask) || forcedReadOnly;
	const allowKinds = [...kinds]
		.filter((kind) => !(readOnly && isMutatingKind(kind)))
		.sort();
	return { allowKinds, interactive: false };
}

/**
 * `toolProviders[*].mcpServer` (WP4b, e.g. workflow_artifact) → `SubmitRequest.mcpServers`.
 * WP5b: the workflow_artifact server gets `--max-output-chars <artifactOutputLimitChars>` when the
 * run recorded an executor MCP output limit (`artifactServerOutputLimitForRun`); launch provenance
 * digests the same limited spec (launch-bootstrap-provenance `artifactIdentity`).
 */
export function preparedMcpServers(
	preparedLaunch: Pick<
		PreparedWorkflowTaskLaunch,
		"toolProviders" | "artifactBinding"
	>,
	options: { artifactOutputLimitChars?: number | null } = {},
): Array<{ name: string; command: string; args: string[] }> {
	const servers = new Map<
		string,
		{ name: string; command: string; args: string[] }
	>();
	for (const provider of Object.values(preparedLaunch.toolProviders ?? {})) {
		const server = provider.mcpServer;
		if (server === undefined) continue;
		const existing = servers.get(server.name);
		const candidate = {
			name: server.name,
			command: server.command,
			args: [...server.args],
		};
		if (
			existing !== undefined &&
			JSON.stringify(existing) !== JSON.stringify(candidate)
		)
			throw new Error(
				`tool providers declare conflicting MCP servers named ${server.name}`,
			);
		servers.set(server.name, candidate);
	}
	const sealed = preparedLaunch.artifactBinding?.serverSpec;
	if (sealed !== undefined) {
		const existing = servers.get(sealed.name);
		if (
			existing !== undefined &&
			(existing.command !== sealed.command ||
				JSON.stringify(existing.args) !== JSON.stringify(sealed.args))
		)
			throw new Error(
				"workflow_artifact MCP server drifted from the sealed artifact binding",
			);
	}
	const artifactServer = servers.get(ARTIFACT_MCP_SERVER_NAME);
	if (artifactServer !== undefined)
		servers.set(ARTIFACT_MCP_SERVER_NAME, {
			name: artifactServer.name,
			command: artifactServer.command,
			args: [
				...withArtifactMcpOutputLimit(
					artifactServer,
					options.artifactOutputLimitChars,
				).args,
			],
		});
	return [...servers.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

/**
 * R#5 (D2) backend gate: a task whose compiled safety requires a worktree launches only inside
 * the managed worktree recorded on the task. Throws before any executor effect.
 */
export function assertWorktreeEnforced(
	task: Pick<WorkflowTaskRunRecord, "taskId" | "cwd" | "worktree">,
	compiledTask: Pick<CompiledTask, "safety">,
): void {
	if (!compiledTask.safety.requiresWorktree) return;
	const path = task.worktree?.enabled === true ? task.worktree.path : undefined;
	if (typeof path !== "string" || resolve(task.cwd) !== resolve(path))
		throw new Error(
			`task ${task.taskId} can write and requires a managed worktree, but it is not running in one; refusing to launch (D2)`,
		);
}

export interface OneShotSubagentEnvelope {
	runId: string;
	attemptId: string;
	status: string;
	cwd?: string;
	artifacts?: Array<{ type: string; path: string; artifactCwd?: string }>;
}

/**
 * Shared entry point for one-off synchronous executor calls (workflow router comparison).
 * Honors setTaskRuntimeApiForTests. Pi option names are translated (`thinking` → `effort`);
 * `backend` is replaced by the executor selected with `executor` (B2: the call's executor id,
 * else the default), and an unavailable executor throws before any launch.
 */
export async function runOneShotSubagentCall(
	options: Record<string, unknown> & { executor?: string },
): Promise<OneShotSubagentEnvelope> {
	const api = await loadSubagentApi();
	const {
		backend: _backend,
		thinking,
		executor: executorId,
		extensions: _extensions,
		noExtensions: _noExtensions,
		...rest
	} = options;
	const selection = resolveRunExecutorSelection({
		...(typeof executorId === "string" ? { runFlag: executorId } : {}),
		defaultExecutor: LEGACY_RECORD_EXECUTOR_ID,
	});
	return (await api.runSubagent({
		// WP4e: engine calls always set the mode (engine default free; readOnly either way).
		permissionMode: "free",
		...rest,
		executor: selection.descriptor,
		...(typeof thinking === "string" ? { effort: thinking } : {}),
		readOnly: true,
		isolation: { inherit: false },
		env: { [AGENT_WORKFLOW_ROLE_ENV]: "worker" },
	})) as OneShotSubagentEnvelope;
}

/** The core task backend (pi-workflow `backend.ts` `subagentHeadlessBackend`). */
export const workflowTaskBackend: WorkflowBackend = {
	id: WORKFLOW_TASK_BACKEND_ID,
	refreshRun: refreshRunFromSubagentArtifacts,
	cleanupRun: cleanupSubagentRun,
	async prepareTaskLaunch(cwd, run, task, compiledTask) {
		return prepareSubagentTaskLaunch(cwd, run, task, compiledTask, true);
	},
	async launchTask(
		cwd,
		run,
		task,
		compiledTask,
		leaseSignal,
		workflowStopSignal,
		preparedLaunch,
	) {
		try {
			return await launchSubagentTask(
				cwd,
				run,
				task,
				compiledTask,
				leaseSignal,
				workflowStopSignal,
				preparedLaunch,
			);
		} catch (error) {
			if (
				leaseSignal?.aborted ||
				workflowStopSignal?.aborted ||
				isWorkflowStopRequestedError(error)
			) {
				throw error;
			}
			return {
				kind: "fatal",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

/**
 * Run records keep `backend: {type: "local-pi", mode: "headless"}` (stored-format literal, F5);
 * it now names this runtime-API backend.
 */
export const WORKFLOW_TASK_BACKEND_KEY = {
	type: "local-pi",
	mode: "headless",
} as const;

let unregisterWorkflowTaskBackend: (() => void) | undefined;

/** Idempotently register the core task backend for `local-pi/headless` run records. */
export function ensureWorkflowTaskBackendRegistered(): void {
	unregisterWorkflowTaskBackend ??= registerWorkflowBackend(
		WORKFLOW_TASK_BACKEND_KEY,
		workflowTaskBackend,
	);
}

ensureWorkflowTaskBackendRegistered();
