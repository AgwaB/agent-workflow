import {
	type WorkerResultArtifactRef,
	type WorkerRunLogRef,
} from "./task-artifacts.js";
import * as runtimeApi from "../runtime/api.js";
import {
	removePersistedSharedModelRateLimitBackoffsForTests,
	sharedModelRateLimitBackoffs,
} from "./retry-policy.js";

export interface WorkerAttemptSnapshot {
	attemptId: string;
	status: string;
	heartbeatAt?: string;
	/** Runtime/persisted boundary: validate before copying onto the task. */
	activity?: unknown;
	pid?: number;
	workerPid?: number;
}

export interface WorkerRunStatusSnapshot {
	runId: string;
	attemptId: string;
	executorId: string;
	status: string;
	failureKind: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs?: number | null;
	logs: WorkerRunLogRef[];
	metadata?: { contextLengthExceeded?: boolean; [key: string]: unknown };
	completion?: unknown;
	attempts?: WorkerAttemptSnapshot[];
	// Older and newer worker APIs may expose observability fields at the
	// snapshot root; preserve access to those own extension fields as unknown.
	[key: string]: unknown;
}

export interface WorkerResultEnvelope {
	runId: string;
	attemptId: string;
	status: string;
	artifacts?: WorkerResultArtifactRef[];
	cwd?: string;
}

export interface DurableLaunchBarrierDescriptor {
	schema: "agent-workflow-durable-launch-barrier-v2";
	identitySha256: string;
	directory: string;
	readyPath: string;
	decisionPath: string;
	ackPath: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	directoryIdentity: { device: number; inode: number; uid?: number };
	timeoutMs: number;
	pollIntervalMs: number;
}

export interface DurableLaunchBarrierReady {
	schema: "agent-workflow-durable-launch-barrier-ready-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	workerPid: number;
	workerProcessGroupId?: number;
	readySha256: string;
	launchPayloadSha256: string;
	executionPlanSha256: string;
}

export interface DurableLaunchBarrierReleaseDecision {
	schema: "agent-workflow-durable-launch-barrier-decision-v2";
	kind: "released";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	releasePayloadSha256: string;
	decisionSha256: string;
}

export interface DurableLaunchBarrierRevocationDecision {
	schema: "agent-workflow-durable-launch-barrier-decision-v2";
	kind: "revoked";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	cancellationId: string;
	reasonSha256: string;
	decisionSha256: string;
}

export type DurableLaunchBarrierDecision =
	| DurableLaunchBarrierReleaseDecision
	| DurableLaunchBarrierRevocationDecision;

export interface DurableLaunchBarrierResolution {
	outcome: DurableLaunchBarrierDecision["kind"];
	decision: DurableLaunchBarrierDecision;
}

export interface DurableLaunchBarrierAck {
	schema: "agent-workflow-durable-launch-barrier-ack-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	decisionSha256: string;
	ackSha256: string;
}

export interface DurableLaunchBarrierState {
	ready?: DurableLaunchBarrierReady;
	decision?: DurableLaunchBarrierDecision;
	ack?: DurableLaunchBarrierAck;
}

export interface WorkerInterruptResult {
	status:
		| "interrupt-requested"
		| "not-found"
		| "already-terminal"
		| "unsupported";
	runId: string;
	interruptedAttempts: string[];
	unsupportedAttempts: string[];
	record?: {
		status?: string;
		attempts?: Array<{ attemptId?: string; status?: string }>;
	} | null;
}

export interface WorkerApi {
	runWorker(options: Record<string, unknown>): Promise<WorkerResultEnvelope>;
	createDurableLaunchBarrierV2?(options: {
		directory: string;
		subjectSha256: string;
		authorityBindingSha256?: string;
		timeoutMs?: number;
		pollIntervalMs?: number;
	}): Promise<DurableLaunchBarrierDescriptor>;
	durableLaunchBarrierDigest?(value: unknown): string;
	waitForDurableLaunchBarrierV2Ready?(
		descriptor: DurableLaunchBarrierDescriptor,
		options?: { signal?: AbortSignal },
	): Promise<DurableLaunchBarrierReady>;
	resolveDurableLaunchBarrierV2Release?(
		descriptor: DurableLaunchBarrierDescriptor,
		ready: DurableLaunchBarrierReady,
		releasePayloadSha256: string,
	): Promise<DurableLaunchBarrierResolution>;
	revokeDurableLaunchBarrierV2?(
		descriptor: DurableLaunchBarrierDescriptor,
		options: { cancellationId: string; reasonSha256: string },
	): Promise<DurableLaunchBarrierResolution>;
	readDurableLaunchBarrierV2State?(
		descriptor: DurableLaunchBarrierDescriptor,
	): Promise<DurableLaunchBarrierState>;
	waitForDurableLaunchBarrierV2Ack?(
		descriptor: DurableLaunchBarrierDescriptor,
		decision: DurableLaunchBarrierReleaseDecision,
	): Promise<DurableLaunchBarrierAck>;
	getWorkerStatus(
		options: Record<string, unknown>,
	): Promise<WorkerRunStatusSnapshot | null>;
	interruptWorker(
		options: Record<string, unknown>,
	): Promise<WorkerInterruptResult>;
	reconcileWorkerRun(options: Record<string, unknown>): Promise<unknown>;
	recordWorkerChildEvent?(options: Record<string, unknown>): Promise<unknown>;
}

let injectedWorkerApi: WorkerApi | undefined;

/** True while a test has replaced the runtime API (barrier may be absent then). */
export function isTaskRuntimeApiInjected(): boolean {
	return injectedWorkerApi !== undefined;
}

/**
 * Test seam for the runtime API called by the task runner.
 * Undefined restores the real runtime and clears shared rate-limit backoff state.
 */
export function setTaskRuntimeApiForTests(api: unknown | undefined): void {
	injectedWorkerApi = api === undefined ? undefined : (api as WorkerApi);
	if (api === undefined) {
		sharedModelRateLimitBackoffs.clear();
		removePersistedSharedModelRateLimitBackoffsForTests();
	}
}

export async function loadWorkerApi(): Promise<WorkerApi> {
	if (injectedWorkerApi) return injectedWorkerApi;
	return runtimeApi as unknown as WorkerApi;
}

export type DurableLaunchBarrierApi = Required<
	Pick<
		WorkerApi,
		| "createDurableLaunchBarrierV2"
		| "durableLaunchBarrierDigest"
		| "waitForDurableLaunchBarrierV2Ready"
		| "resolveDurableLaunchBarrierV2Release"
		| "revokeDurableLaunchBarrierV2"
		| "readDurableLaunchBarrierV2State"
		| "waitForDurableLaunchBarrierV2Ack"
	>
>;

export function hasDurableLaunchBarrierApi(
	api: WorkerApi,
): api is WorkerApi & DurableLaunchBarrierApi {
	return (
		typeof api.createDurableLaunchBarrierV2 === "function" &&
		typeof api.durableLaunchBarrierDigest === "function" &&
		typeof api.waitForDurableLaunchBarrierV2Ready === "function" &&
		typeof api.resolveDurableLaunchBarrierV2Release === "function" &&
		typeof api.revokeDurableLaunchBarrierV2 === "function" &&
		typeof api.readDurableLaunchBarrierV2State === "function" &&
		typeof api.waitForDurableLaunchBarrierV2Ack === "function"
	);
}
