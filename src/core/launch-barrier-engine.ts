// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/subagent-backend.ts lines 531-533, 1328-1467, 3087-3144, 3322-3573, 3610-3820 (engine side of the durable launch barrier V2: create/resume, READY validation, consume, release vs revoke on stop/lease loss, ACK, cancellation decision, restart reconcile). MIT, same author. Changes: the create and settle blocks of launchSubagentTask became createOrResumeDurableLaunchBarrier / settleDurableLaunchBarrier (same order and checks); barrier functions come from the runtime API. WP1b fix: the READY wait stops (DurableLaunchWorkerEndedError, with the worker stderr) when the provisional worker attempt is terminal without READY — an executor refusal before consume — instead of waiting for the barrier timeout.
import {
	type CompiledTask,
	type WorkflowForeachBatchRecord,
	type WorkflowLaunchAuthorityGrant,
} from "./types.js";
import {
	type SubagentApi,
	type SubagentRunStatusSnapshot,
} from "./runtime-port.js";
import { type SubagentBackendHandle } from "./task-artifacts.js";
import {
	abortSignalError,
	awaitSubagentOperation,
	combineAbortSignals,
	throwIfLaunchStopped,
} from "./launch-operations.js";
import {
	assertForeachBatchCapability,
	issueForeachBatchCapability,
} from "./foreach-batch-capability.js";
import {
	beforeDurableBarrierAckWaitHookForTests,
	beforeDurableBarrierReleaseHookForTests,
} from "./launch-slots.js";
import { consumeWorkflowLaunchAuthority } from "./launch-authority.js";
import { isWorkflowStopRequestedError } from "./workflow-stop.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { workflowRunDir } from "./store.js";
import {
	type DurableLaunchBarrierApi,
	type DurableLaunchBarrierDescriptor,
	type DurableLaunchBarrierReady,
	type DurableLaunchBarrierResolution,
	hasDurableLaunchBarrierApi,
	loadSubagentApi,
} from "./runtime-port.js";
import { consumeRegisteredWorkflowLaunchAuthority } from "./launch-authority.js";
import { workflowTaskSessionId } from "./launch-session.js";
import { nowIso, writeRunRecordDurable } from "./store.js";
import {
	findLog,
	getSubagentHandle,
	safeArtifactPath,
	makeSubagentHandle,
	subagentRunsDir,
	workflowTaskStateCwd,
	timestampMs,
} from "./task-artifacts.js";
import { WORKFLOW_TASK_BACKEND_ID } from "./task-artifacts.js";
import { acknowledgeSubagentTaskInterrupted } from "./task-cancellation.js";
import {
	type WorkflowDurableLaunchBarrierRecord,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";

export function isSha256Digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function durableBarrierRecordForTask(
	task: WorkflowTaskRunRecord,
): WorkflowDurableLaunchBarrierRecord | undefined {
	const records = task.durableLaunchBarrier?.records ?? [];
	const handle = getSubagentHandle(task);
	return (
		(handle
			? records.find((record) => record.backendAttemptId === handle.attemptId)
			: undefined) ?? records.at(-1)
	);
}

export function durableBarrierCancellationIdentity(
	api: DurableLaunchBarrierApi,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	record: WorkflowDurableLaunchBarrierRecord,
): { cancellationId: string; reasonSha256: string } {
	return {
		cancellationId:
			record.cancellation?.cancellationId ??
			`workflow:${run.runId}:${task.taskId}:${record.attemptKey}`,
		reasonSha256:
			record.cancellation?.reasonSha256 ??
			api.durableLaunchBarrierDigest({
				schema: "agent-workflow-durable-launch-cancellation-v1",
				runId: run.runId,
				taskId: task.taskId,
				attemptKey: record.attemptKey,
				launchAuthoritySha256: record.launchAuthoritySha256,
			}),
	};
}

export async function resolveDurableBarrierReleaseWithCancellation(
	api: DurableLaunchBarrierApi,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	record: WorkflowDurableLaunchBarrierRecord,
	ready: DurableLaunchBarrierReady,
	releasePayloadSha256: string,
	signal?: AbortSignal,
): Promise<DurableLaunchBarrierResolution> {
	if (!signal)
		return api.resolveDurableLaunchBarrierV2Release(
			record.descriptor,
			ready,
			releasePayloadSha256,
		);
	const cancellation = durableBarrierCancellationIdentity(
		api,
		run,
		task,
		record,
	);
	if (signal.aborted)
		return api.revokeDurableLaunchBarrierV2(record.descriptor, cancellation);
	let removeAbortListener = (): void => undefined;
	const revokeOnAbort = new Promise<DurableLaunchBarrierResolution>(
		(resolveCancellation, rejectCancellation) => {
			const onAbort = (): void => {
				void api
					.revokeDurableLaunchBarrierV2(record.descriptor, cancellation)
					.then(resolveCancellation, rejectCancellation);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			if (signal.aborted) onAbort();
		},
	);
	const release = api.resolveDurableLaunchBarrierV2Release(
		record.descriptor,
		ready,
		releasePayloadSha256,
	);
	try {
		const resolution = await Promise.race([release, revokeOnAbort]);
		void release.catch(() => undefined);
		return resolution;
	} finally {
		removeAbortListener();
	}
}

export async function decideDurableBarrierCancellation(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<WorkflowDurableLaunchBarrierRecord | undefined> {
	const record = durableBarrierRecordForTask(task);
	if (!record || record.phase === "cancellation_acknowledged") return record;
	const api = await loadSubagentApi();
	if (!hasDurableLaunchBarrierApi(api))
		throw new Error(
			"the runtime API does not support durable launch barrier v2 cancellation",
		);
	const { cancellationId, reasonSha256 } = durableBarrierCancellationIdentity(
		api,
		run,
		task,
		record,
	);
	record.cancellation ??= {
		cancellationId,
		requestedAt: nowIso(),
		reasonSha256,
		decision: "revoked",
	};
	await writeRunRecordDurable(cwd, run);
	const resolution = await api.revokeDurableLaunchBarrierV2(record.descriptor, {
		cancellationId,
		reasonSha256,
	});
	record.decisionSha256 = resolution.decision.decisionSha256;
	if (resolution.outcome === "revoked") {
		record.phase = "revoked";
		record.releaseWinner = false;
		record.cancellation.decision = "revoked";
	} else {
		if (
			resolution.decision.kind !== "released" ||
			(record.backendRunId !== undefined &&
				resolution.decision.runId !== record.backendRunId) ||
			(record.backendAttemptId !== undefined &&
				resolution.decision.attemptId !== record.backendAttemptId)
		)
			throw new Error(
				"durable launch barrier release winner does not match the persisted backend attempt",
			);
		record.phase = "release_won_cancellation_pending";
		record.releaseWinner = true;
		record.cancellation.decision = "released";
	}
	task.statusDetail = "cancellation_pending";
	task.lastMessage = `${reason}; durable barrier decision is ${resolution.outcome}`;
	await writeRunRecordDurable(cwd, run);
	return record;
}

function assertRecoveredBarrierField(
	label: string,
	persisted: string | undefined,
	observed: string,
): void {
	if (persisted !== undefined && persisted !== observed)
		throw new Error(`durable launch barrier recovered ${label} drift`);
}

function barrierRecoveryIsStale(
	task: WorkflowTaskRunRecord,
	descriptor: DurableLaunchBarrierDescriptor,
): boolean {
	const startedAtMs = timestampMs(task.startedAt);
	return (
		startedAtMs !== undefined &&
		Date.now() - startedAtMs > descriptor.timeoutMs + 5_000
	);
}

export async function reconcileDurableLaunchBarrierTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<boolean> {
	const record = durableBarrierRecordForTask(task);
	if (!record) return false;
	const api = await loadSubagentApi();
	if (!hasDurableLaunchBarrierApi(api))
		throw new Error(
			"the runtime API cannot reconcile durable launch barrier v2",
		);
	const state = await api.readDurableLaunchBarrierV2State(record.descriptor);
	let changed = false;
	let handle = getSubagentHandle(task);
	if (state.ready) {
		const ready = state.ready;
		if (
			ready.barrierIdentitySha256 !== record.descriptor.identitySha256 ||
			ready.challenge !== record.descriptor.challenge ||
			ready.decisionNonce !== record.descriptor.decisionNonce ||
			ready.subjectSha256 !== record.descriptor.subjectSha256 ||
			ready.authorityBindingSha256 !== record.authorityBindingSha256
		)
			throw new Error(
				"durable launch barrier recovered READY does not match persisted authority",
			);
		assertRecoveredBarrierField(
			"ready digest",
			record.readySha256,
			ready.readySha256,
		);
		assertRecoveredBarrierField(
			"launch payload digest",
			record.launchPayloadSha256,
			ready.launchPayloadSha256,
		);
		assertRecoveredBarrierField(
			"execution plan digest",
			record.executionPlanSha256,
			ready.executionPlanSha256,
		);
		assertRecoveredBarrierField(
			"backend run id",
			record.backendRunId,
			ready.runId,
		);
		assertRecoveredBarrierField(
			"backend attempt id",
			record.backendAttemptId,
			ready.attemptId,
		);
		if (
			handle &&
			(handle.runId !== ready.runId || handle.attemptId !== ready.attemptId)
		)
			throw new Error(
				"durable launch barrier recovered handle does not match READY",
			);
		if (!handle) {
			handle = makeSubagentHandle(
				task,
				ready.runId,
				ready.attemptId,
				subagentRunsDir(run, task),
				workflowTaskSessionId(run, task),
				workflowTaskStateCwd(cwd, task),
			);
			task.backendHandle = handle;
			task.backendTaskId = ready.runId;
			changed = true;
		}
		record.readySha256 = ready.readySha256;
		record.launchPayloadSha256 = ready.launchPayloadSha256;
		record.executionPlanSha256 = ready.executionPlanSha256;
		record.backendRunId = ready.runId;
		record.backendAttemptId = ready.attemptId;
		if (record.phase === "created") record.phase = "ready";
		if (
			consumeRegisteredWorkflowLaunchAuthority(
				run,
				task,
				WORKFLOW_TASK_BACKEND_ID,
				ready.runId,
				ready.attemptId,
			)
		)
			changed = true;
		changed = true;
	} else if (
		record.readySha256 !== undefined ||
		(record.phase !== "created" && state.decision?.kind !== "revoked")
	) {
		throw new Error(
			"durable launch barrier persisted phase has no recoverable READY receipt",
		);
	}

	if (state.decision) {
		assertRecoveredBarrierField(
			"decision digest",
			record.decisionSha256,
			state.decision.decisionSha256,
		);
		record.decisionSha256 = state.decision.decisionSha256;
		if (state.decision.kind === "released") {
			assertRecoveredBarrierField(
				"release payload digest",
				record.releasePayloadSha256,
				state.decision.releasePayloadSha256,
			);
			record.releasePayloadSha256 = state.decision.releasePayloadSha256;
			record.releaseWinner = true;
			if (
				record.phase !== "acknowledged" &&
				record.phase !== "cancellation_acknowledged" &&
				record.phase !== "release_won_cancellation_pending"
			)
				record.phase = "released";
		} else {
			record.releaseWinner = false;
			if (record.phase !== "cancellation_acknowledged")
				record.phase = "revoked";
		}
		changed = true;
	} else if (
		record.decisionSha256 !== undefined ||
		[
			"released",
			"acknowledged",
			"revoked",
			"release_won_cancellation_pending",
			"cancellation_acknowledged",
		].includes(record.phase)
	) {
		throw new Error(
			"durable launch barrier persisted decision has no recoverable decision receipt",
		);
	}

	if (state.ack) {
		assertRecoveredBarrierField(
			"acknowledgement digest",
			record.ackSha256,
			state.ack.ackSha256,
		);
		if (
			state.decision?.kind !== "released" ||
			state.ack.decisionSha256 !== state.decision.decisionSha256
		)
			throw new Error(
				"durable launch barrier recovered ACK does not match release decision",
			);
		record.ackSha256 = state.ack.ackSha256;
		if (
			record.phase !== "release_won_cancellation_pending" &&
			record.phase !== "cancellation_acknowledged"
		)
			record.phase = "acknowledged";
		changed = true;
	} else if (
		record.ackSha256 !== undefined ||
		record.phase === "acknowledged"
	) {
		throw new Error(
			"durable launch barrier persisted acknowledgement has no recoverable ACK receipt",
		);
	}

	if (changed) await writeRunRecordDurable(cwd, run);
	const cancellationPending =
		record.phase === "revoked" ||
		record.phase === "release_won_cancellation_pending";
	if (
		cancellationPending ||
		(state.ack === undefined && barrierRecoveryIsStale(task, record.descriptor))
	) {
		await acknowledgeSubagentTaskInterrupted(
			cwd,
			run,
			task,
			"reconciling incomplete durable launch barrier after supervisor interruption",
		);
		changed = true;
	}
	return changed;
}

export async function reconcileDurableLaunchBarrierTaskForTests(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<boolean> {
	return reconcileDurableLaunchBarrierTask(cwd, run, task);
}

/**
 * Engine side of the durable launch barrier V2, step 1 (subagent-backend.ts 3087-3144): create
 * the barrier for this launch authority, or resume the persisted one after a restart, and record
 * it durably before the worker is spawned.
 */
export async function createOrResumeDurableLaunchBarrier(options: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	compiledTask: CompiledTask;
	api: DurableLaunchBarrierApi;
	launchAuthority: WorkflowLaunchAuthorityGrant;
	authorityBindingSha256: string | undefined;
}): Promise<{
	descriptor: DurableLaunchBarrierDescriptor;
	record: WorkflowDurableLaunchBarrierRecord;
}> {
	const {
		cwd,
		run,
		task,
		compiledTask,
		api,
		launchAuthority,
		authorityBindingSha256,
	} = options;
	let durableBarrierDescriptor: DurableLaunchBarrierDescriptor;
	let durableBarrierRecord: WorkflowDurableLaunchBarrierRecord | undefined;
	const history = task.durableLaunchBarrier ?? { version: 2, records: [] };
	durableBarrierRecord = history.records.find(
		(record) => record.attemptKey === launchAuthority.attemptKey,
	);
	if (durableBarrierRecord === undefined) {
		durableBarrierDescriptor = await api.createDurableLaunchBarrierV2({
			directory: join(
				workflowRunDir(cwd, run.runId),
				"tasks",
				task.taskId,
				`.launch-barrier-${launchAuthority.identitySha256.slice(0, 16)}-${randomBytes(8).toString("hex")}`,
			),
			subjectSha256: launchAuthority.identitySha256,
			...(authorityBindingSha256 === undefined
				? {}
				: { authorityBindingSha256 }),
			// Launch coordination stays bounded even when model task wall time is unlimited.
			timeoutMs: Math.min(
				120_000,
				Math.max(30_000, compiledTask.runtime.maxRuntimeMs ?? 30_000),
			),
		});
		if (
			durableBarrierDescriptor.authorityBindingSha256 !== authorityBindingSha256
		)
			throw new Error(
				"durable launch barrier authority binding does not match external launch grant",
			);
		durableBarrierRecord = {
			attemptKey: launchAuthority.attemptKey,
			launchAuthoritySha256: launchAuthority.identitySha256,
			...(authorityBindingSha256 === undefined
				? {}
				: { authorityBindingSha256 }),
			descriptor: durableBarrierDescriptor,
			phase: "created",
		};
		history.records.push(durableBarrierRecord);
		task.durableLaunchBarrier = history;
		await writeRunRecordDurable(cwd, run);
	} else {
		durableBarrierDescriptor = durableBarrierRecord.descriptor;
		if (
			durableBarrierRecord.launchAuthoritySha256 !==
				launchAuthority.identitySha256 ||
			durableBarrierDescriptor.subjectSha256 !==
				launchAuthority.identitySha256 ||
			durableBarrierDescriptor.authorityBindingSha256 !==
				authorityBindingSha256 ||
			durableBarrierRecord.authorityBindingSha256 !== authorityBindingSha256
		) {
			throw new Error(
				"durable launch barrier binding does not match launch authority",
			);
		}
	}
	return { descriptor: durableBarrierDescriptor, record: durableBarrierRecord };
}

/** Poll interval of the provisional worker's attempt status while waiting for READY. */
export const PRE_READY_WORKER_POLL_MS = 200;

/** The provisional worker recorded a terminal attempt result before it wrote READY. */
export class DurableLaunchWorkerEndedError extends Error {
	constructor(
		message: string,
		readonly attemptStatus: string,
		readonly failureKind: string | null,
	) {
		super(message);
		this.name = "DurableLaunchWorkerEndedError";
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveSleep) => {
		if (signal.aborted) return resolveSleep();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolveSleep();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

async function attemptStderrExcerpt(
	snapshot: SubagentRunStatusSnapshot,
	handle: SubagentBackendHandle,
): Promise<string> {
	const log = findLog(snapshot, "stderr");
	if (log === undefined) return "";
	try {
		const path = safeArtifactPath(
			snapshot,
			log,
			resolve(handle.cwd, handle.runsDir),
		);
		const text = await readFile(path, "utf8");
		return text.trim().slice(0, 2_000);
	} catch {
		return "";
	}
}

/**
 * WP1b fix: wait for READY, but stop as soon as the provisional worker's attempt is terminal
 * without READY. In the runtime the worker writes READY inside `authority.consume()`, which the
 * executor calls from `submit`; an executor that refuses the request before consuming
 * (INVALID_REQUEST, CAPABILITY_MISSING: no effect) ends the worker with a terminal not-started
 * result and no READY. pi-subagent wrote READY before it started Pi, so pi-workflow never had this
 * case; the plain wait then ran into the barrier timeout (up to 120 s per attempt) and reported
 * "durable launch barrier timed out" instead of the executor's refusal.
 */
async function waitForReadyUnlessWorkerEnded(
	launchApi: SubagentApi & DurableLaunchBarrierApi,
	descriptor: DurableLaunchBarrierDescriptor,
	handle: SubagentBackendHandle,
	launched: { runId: string; attemptId: string },
): Promise<DurableLaunchBarrierReady> {
	const stop = new AbortController();
	const ready = launchApi.waitForDurableLaunchBarrierV2Ready(descriptor, {
		signal: stop.signal,
	});
	// The READY wait is abandoned (and rejects) once the worker is known to have ended.
	ready.catch(() => undefined);
	const ended = (async (): Promise<void> => {
		while (!stop.signal.aborted) {
			await abortableSleep(PRE_READY_WORKER_POLL_MS, stop.signal);
			if (stop.signal.aborted) return;
			const snapshot = await launchApi
				.getSubagentStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: launched.runId,
					attemptId: launched.attemptId,
				})
				.catch(() => null);
			if (
				snapshot === null ||
				snapshot.attemptId !== launched.attemptId ||
				!["completed", "failed", "cancelled"].includes(snapshot.status)
			)
				continue;
			// A worker that wrote READY and then ended is settled by the READY path.
			const state = await launchApi
				.readDurableLaunchBarrierV2State(descriptor)
				.catch(() => undefined);
			if (state?.ready !== undefined) return;
			const reason = await attemptStderrExcerpt(snapshot, handle);
			throw new DurableLaunchWorkerEndedError(
				`provisional worker ${launched.runId}/${launched.attemptId} ended (${snapshot.status}${snapshot.failureKind ? `/${snapshot.failureKind}` : ""}) before the durable launch barrier READY${reason ? `: ${reason}` : ""}`,
				snapshot.status,
				snapshot.failureKind ?? null,
			);
		}
	})();
	try {
		return await Promise.race([ready, ended.then(() => ready)]);
	} finally {
		stop.abort();
	}
}

/**
 * Engine side of the durable launch barrier V2, step 2 (subagent-backend.ts 3322-3573): after the
 * runtime returned the provisional worker handle, wait for READY, validate it against the
 * authorized launch, consume the launch authority, then release (or revoke on stop / lease loss)
 * with one decision, and wait for the worker ACK. Any failure revokes/interrupts the provisional
 * worker before rethrowing.
 */
export async function settleDurableLaunchBarrier(options: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	handle: SubagentBackendHandle;
	launched: { runId: string; attemptId: string };
	launchApi: SubagentApi | undefined;
	descriptor: DurableLaunchBarrierDescriptor;
	record: WorkflowDurableLaunchBarrierRecord | undefined;
	launchAuthority: WorkflowLaunchAuthorityGrant;
	authorityBindingSha256: string | undefined;
	hardenedBatchRecord: WorkflowForeachBatchRecord | undefined;
	leaseSignal?: AbortSignal;
	workflowStopSignal?: AbortSignal;
}): Promise<void> {
	const {
		cwd,
		run,
		task,
		handle,
		launched,
		launchApi,
		launchAuthority,
		authorityBindingSha256,
		hardenedBatchRecord,
		leaseSignal,
		workflowStopSignal,
	} = options;
	const durableBarrierDescriptor = options.descriptor;
	const durableBarrierRecord = options.record;
	task.backendHandle = handle;
	task.backendTaskId = launched.runId;
	task.statusDetail = "launch_barrier_pending";
	task.lastMessage = "backend handle recorded; awaiting durable launch barrier";
	const launchAbortSignal = combineAbortSignals(
		leaseSignal,
		workflowStopSignal,
	);
	try {
		await writeRunRecordDurable(cwd, run);
		if (launchApi === undefined || !hasDurableLaunchBarrierApi(launchApi)) {
			throw new Error("durable launch barrier API became unavailable");
		}
		const ready = await awaitSubagentOperation(
			() =>
				waitForReadyUnlessWorkerEnded(
					launchApi,
					durableBarrierDescriptor,
					handle,
					launched,
				),
			{
				operation: "durable launch barrier READY",
				context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
				timeoutMs: durableBarrierDescriptor.timeoutMs + 5_000,
				signal: launchAbortSignal,
			},
		);
		if (
			ready.schema !== "agent-workflow-durable-launch-barrier-ready-v2" ||
			ready.barrierIdentitySha256 !== durableBarrierDescriptor.identitySha256 ||
			ready.challenge !== durableBarrierDescriptor.challenge ||
			ready.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
			ready.subjectSha256 !== durableBarrierDescriptor.subjectSha256 ||
			ready.authorityBindingSha256 !== authorityBindingSha256 ||
			ready.runId !== launched.runId ||
			ready.attemptId !== launched.attemptId ||
			!isSha256Digest(ready.readySha256) ||
			!isSha256Digest(ready.launchPayloadSha256) ||
			!isSha256Digest(ready.executionPlanSha256)
		) {
			throw new Error(
				"durable launch barrier READY does not match the authorized launch",
			);
		}
		if (durableBarrierRecord === undefined)
			throw new Error("durable launch barrier record is unavailable");
		durableBarrierRecord.phase = "ready";
		durableBarrierRecord.readySha256 = ready.readySha256;
		durableBarrierRecord.launchPayloadSha256 = ready.launchPayloadSha256;
		durableBarrierRecord.executionPlanSha256 = ready.executionPlanSha256;
		durableBarrierRecord.backendRunId = launched.runId;
		durableBarrierRecord.backendAttemptId = launched.attemptId;
		consumeWorkflowLaunchAuthority(
			task,
			launchAuthority,
			launched.runId,
			launched.attemptId,
		);
		const releasePayloadSha256 = launchApi.durableLaunchBarrierDigest({
			schema: "agent-workflow-consumed-launch-release-v1",
			runId: run.runId,
			taskId: task.taskId,
			attemptKey: launchAuthority.attemptKey,
			launchAuthoritySha256: launchAuthority.identitySha256,
			launchBootstrapSha256: launchAuthority.launchBootstrapSha256,
			backendRunId: launched.runId,
			backendAttemptId: launched.attemptId,
			readySha256: ready.readySha256,
			launchPayloadSha256: ready.launchPayloadSha256,
			executionPlanSha256: ready.executionPlanSha256,
			authorityPhase: "consumed",
			...(authorityBindingSha256 === undefined
				? {}
				: {
						authorityBindingSha256,
						externalLaunchGrantSha256: authorityBindingSha256,
					}),
		});
		durableBarrierRecord.phase = "consumed";
		durableBarrierRecord.releasePayloadSha256 = releasePayloadSha256;
		if (
			hardenedBatchRecord &&
			task.foreachBatch?.role === "leader" &&
			(hardenedBatchRecord.stateRootSha256 ||
				hardenedBatchRecord.capabilitySubjectSha256)
		) {
			const capability = await issueForeachBatchCapability(
				cwd,
				hardenedBatchRecord,
			);
			await assertForeachBatchCapability(cwd, hardenedBatchRecord, capability);
			const reservationSha256 = launchApi.durableLaunchBarrierDigest({
				schema: "workflow-foreach-batch-dispatch-reservation-v1",
				batchId: hardenedBatchRecord.batchId,
				attemptKey: launchAuthority.attemptKey,
				capabilitySubjectSha256: hardenedBatchRecord.capabilitySubjectSha256,
				stateRootSha256: hardenedBatchRecord.stateRootSha256,
				releasePayloadSha256,
			});
			if (
				hardenedBatchRecord.dispatch &&
				(hardenedBatchRecord.dispatch.attemptKey !==
					launchAuthority.attemptKey ||
					hardenedBatchRecord.dispatch.reservationSha256 !== reservationSha256)
			)
				throw new Error(
					`foreach batch ${hardenedBatchRecord.batchId} dispatch reservation drift`,
				);
			hardenedBatchRecord.dispatch ??= {
				schema: "workflow-foreach-batch-dispatch-v1",
				state: "reserved",
				attemptKey: launchAuthority.attemptKey,
				reservationSha256,
				reservedAt: nowIso(),
			};
		}
		await writeRunRecordDurable(cwd, run);
		await beforeDurableBarrierReleaseHookForTests?.();
		let preReleaseStopError: unknown;
		let resolution: DurableLaunchBarrierResolution | undefined;
		try {
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		} catch (error) {
			preReleaseStopError = error;
			const cancellation = durableBarrierCancellationIdentity(
				launchApi,
				run,
				task,
				durableBarrierRecord,
			);
			resolution = await launchApi.revokeDurableLaunchBarrierV2(
				durableBarrierDescriptor,
				cancellation,
			);
		}
		resolution ??= await resolveDurableBarrierReleaseWithCancellation(
			launchApi,
			run,
			task,
			durableBarrierRecord,
			ready,
			releasePayloadSha256,
			launchAbortSignal,
		);
		durableBarrierRecord.decisionSha256 = resolution.decision.decisionSha256;
		if (resolution.outcome === "revoked") {
			const cancellation = durableBarrierCancellationIdentity(
				launchApi,
				run,
				task,
				durableBarrierRecord,
			);
			durableBarrierRecord.phase = "revoked";
			durableBarrierRecord.releaseWinner = false;
			durableBarrierRecord.cancellation ??= {
				...cancellation,
				requestedAt: nowIso(),
				decision: "revoked",
			};
			await writeRunRecordDurable(cwd, run);
			if (preReleaseStopError !== undefined) throw preReleaseStopError;
			if (launchAbortSignal?.aborted) throw abortSignalError(launchAbortSignal);
			throw new Error("durable launch barrier was revoked before release");
		}
		const release = resolution.decision;
		if (
			release.kind !== "released" ||
			release.schema !== "agent-workflow-durable-launch-barrier-decision-v2" ||
			release.barrierIdentitySha256 !==
				durableBarrierDescriptor.identitySha256 ||
			release.challenge !== durableBarrierDescriptor.challenge ||
			release.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
			release.subjectSha256 !== durableBarrierDescriptor.subjectSha256 ||
			release.authorityBindingSha256 !== authorityBindingSha256 ||
			release.runId !== ready.runId ||
			release.attemptId !== ready.attemptId ||
			release.readySha256 !== ready.readySha256 ||
			release.releasePayloadSha256 !== releasePayloadSha256 ||
			!isSha256Digest(release.decisionSha256)
		)
			throw new Error(
				"durable launch barrier release decision does not match the authorized READY receipt",
			);
		durableBarrierRecord.phase = "released";
		durableBarrierRecord.releaseWinner = true;
		durableBarrierRecord.decisionSha256 = release.decisionSha256;
		await writeRunRecordDurable(cwd, run);
		if (preReleaseStopError !== undefined) throw preReleaseStopError;
		if (launchAbortSignal?.aborted) throw abortSignalError(launchAbortSignal);
		await beforeDurableBarrierAckWaitHookForTests?.();
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const ack = await awaitSubagentOperation(
			() =>
				launchApi.waitForDurableLaunchBarrierV2Ack(
					durableBarrierDescriptor,
					release,
				),
			{
				operation: "durable launch barrier ACK",
				context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
				timeoutMs: durableBarrierDescriptor.timeoutMs + 5_000,
				signal: launchAbortSignal,
			},
		);
		if (
			ack.schema !== "agent-workflow-durable-launch-barrier-ack-v2" ||
			ack.barrierIdentitySha256 !== durableBarrierDescriptor.identitySha256 ||
			ack.challenge !== durableBarrierDescriptor.challenge ||
			ack.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
			ack.runId !== release.runId ||
			ack.attemptId !== release.attemptId ||
			ack.readySha256 !== release.readySha256 ||
			ack.decisionSha256 !== release.decisionSha256 ||
			!isSha256Digest(ack.ackSha256)
		)
			throw new Error(
				"durable launch barrier ACK does not match the authorized release",
			);
		durableBarrierRecord.phase = "acknowledged";
		durableBarrierRecord.ackSha256 = ack.ackSha256;
		await writeRunRecordDurable(cwd, run);
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
	} catch (error) {
		const cancelled =
			leaseSignal?.aborted === true ||
			workflowStopSignal?.aborted === true ||
			isWorkflowStopRequestedError(error);
		task.statusDetail = cancelled
			? "launch_barrier_cancelled"
			: "launch_barrier_failed";
		task.lastMessage = cancelled
			? "durable launch barrier cancelled; interrupting provisional worker"
			: `durable launch barrier failed; interrupting provisional worker: ${error instanceof Error ? error.message : String(error)}`;
		await writeRunRecordDurable(cwd, run).catch(() => undefined);
		let interruptionError: unknown;
		try {
			await acknowledgeSubagentTaskInterrupted(
				cwd,
				run,
				task,
				cancelled
					? "workflow launch cancelled before durable barrier completion"
					: "durable launch barrier failed closed",
			);
		} catch (interruptError) {
			interruptionError = interruptError;
			task.statusDetail = "cancellation_failed";
			task.lastMessage = `provisional worker interruption failed: ${interruptError instanceof Error ? interruptError.message : String(interruptError)}`;
			await writeRunRecordDurable(cwd, run).catch(() => undefined);
		}
		if (interruptionError !== undefined)
			throw new AggregateError(
				[error, interruptionError],
				"durable launch barrier failed and provisional worker interruption was not acknowledged",
			);
		throw error;
	}
}
