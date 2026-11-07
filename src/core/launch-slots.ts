import { availableParallelism } from "node:os";
import {
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import { abortSignalError, throwIfAborted } from "./launch-operations.js";
import {
	modelRateLimitBackoffKey,
	sharedModelRateLimitBackoffs,
} from "./retry-policy.js";
import { isTerminalTaskStatus } from "./store.js";
import { getWorkerHandle } from "./task-artifacts.js";
import {
	type CompiledTask,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";

const MAX_CONCURRENT_LAUNCHES_ENV = "AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES";
const MAX_LIVE_MODEL_WORKERS_ENV = "AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS";
const ADAPTIVE_LIVE_MODEL_WORKERS_ENV = "AGENT_WORKFLOW_ADAPTIVE_LIVE_WORKERS";
const ADAPTIVE_LIVE_MODEL_WORKER_FLOOR = 4;
const ADAPTIVE_LIVE_MODEL_WORKER_DEFAULT_CEILING = 16;
const ADAPTIVE_LIVE_MODEL_WORKER_GROW_STEP = 2;
const ADAPTIVE_LIVE_MODEL_WORKER_WINDOW_SIZE = 20;
const ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES = 5;
const ADAPTIVE_LIVE_MODEL_WORKER_GROW_RATIO = 1.5;
const ADAPTIVE_LIVE_MODEL_WORKER_SHRINK_RATIO = 2.5;
const LAUNCH_SLOT_RELEASE_DELAY_MS_ENV =
	"AGENT_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS";
const DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS = 3_000;
const EXPERIMENTAL_LAUNCH_RAMP_RELEASE_DELAY_MS = 250;
const MIN_TRANSIENT_RETRY_JITTER_MS = 1_000;
const MAX_TRANSIENT_RETRY_JITTER_MS = 5_000;
let launchSlotReleaseDelayMsForTests: number | undefined;
let transientRetryJitterForTests: (() => number) | undefined;
let launchSlotQueuedHookForTests: (() => void) | undefined;
let launchSlotAcquiredHookForTests: (() => void) | undefined;
export let beforeRunWorkerHookForTests:
	| (() => void | Promise<void>)
	| undefined;
export let afterLaunchAuthorityRegisteredHookForTests:
	| (() => void | Promise<void>)
	| undefined;
export let beforeDurableBarrierReleaseHookForTests:
	| (() => void | Promise<void>)
	| undefined;
export let beforeDurableBarrierAckWaitHookForTests:
	| (() => void | Promise<void>)
	| undefined;
let launchSlotReleaseGeneration = 0;

interface WaitQueueEntry {
	resolveWait: () => void;
	rejectWait: (error: Error) => void;
}

export const launchWaitQueue: WaitQueueEntry[] = [];
export let activeLaunchSlots = 0;
const activeLiveModelWorkerKeys = new Set<string>();

export function resolveMaxConcurrentLaunches(): number {
	const override = Number.parseInt(
		process.env[MAX_CONCURRENT_LAUNCHES_ENV] ?? "",
		10,
	);
	if (Number.isFinite(override)) return Math.max(1, Math.floor(override));
	return Math.max(2, Math.floor(availableParallelism() / 2));
}

export function isLaunchGateSaturated(): boolean {
	return activeLaunchSlots >= resolveMaxConcurrentLaunches();
}

function removeWaiter(queue: WaitQueueEntry[], waiter: WaitQueueEntry): void {
	const index = queue.indexOf(waiter);
	if (index >= 0) queue.splice(index, 1);
}

function waitForQueueTurn(
	queue: WaitQueueEntry[],
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	return new Promise<void>((resolveWait, rejectWait) => {
		const waiter: WaitQueueEntry = {
			resolveWait: () => {
				cleanup();
				resolveWait();
			},
			rejectWait: (error) => {
				cleanup();
				rejectWait(error);
			},
		};
		const cleanup = (): void => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			removeWaiter(queue, waiter);
			waiter.rejectWait(abortSignalError(signal!));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		queue.push(waiter);
	});
}

async function acquireLaunchSlot(signal?: AbortSignal): Promise<() => void> {
	throwIfAborted(signal);
	if (!isLaunchGateSaturated()) {
		activeLaunchSlots += 1;
		return releaseLaunchSlot;
	}
	let turn: Promise<void>;
	if (launchSlotQueuedHookForTests) {
		const cancelWait = new AbortController();
		const waitSignal = signal
			? AbortSignal.any([signal, cancelWait.signal])
			: cancelWait.signal;
		turn = waitForQueueTurn(launchWaitQueue, waitSignal);
		try {
			launchSlotQueuedHookForTests();
		} catch (error) {
			// The observer must not abandon its registered waiter or hide an
			// assertion behind cancellation. A resolved turn already owns a slot.
			cancelWait.abort();
			await turn.then(releaseLaunchSlot, () => undefined);
			throw error;
		}
	} else {
		turn = waitForQueueTurn(launchWaitQueue, signal);
	}
	await turn;
	if (signal?.aborted) {
		releaseLaunchSlot();
		throw abortSignalError(signal);
	}
	return releaseLaunchSlot;
}

function releaseLaunchSlot(): void {
	const next = launchWaitQueue.shift();
	if (next) {
		// Transfer the occupied slot directly to the queued launcher.
		next.resolveWait();
		return;
	}
	activeLaunchSlots = Math.max(0, activeLaunchSlots - 1);
}

function resolveMaxLiveModelWorkers(): number | undefined {
	const override = Number.parseInt(
		process.env[MAX_LIVE_MODEL_WORKERS_ENV] ?? "",
		10,
	);
	if (!Number.isFinite(override) || override <= 0) return undefined;
	return Math.floor(override);
}

type AdaptiveLiveModelWorkerDecision =
	| "start"
	| "grow"
	| "hold"
	| "shrink"
	| "backoff_shrink";

interface AdaptiveLiveModelWorkerState {
	limit: number;
	recentExecutionMs: number[];
	baselineMs?: number;
	lastDecision: AdaptiveLiveModelWorkerDecision;
}

const adaptiveLiveModelWorkerStates = new Map<
	string,
	AdaptiveLiveModelWorkerState
>();

export function adaptiveLiveModelWorkersEnabled(): boolean {
	return workflowExperimentalFlagEnabled(ADAPTIVE_LIVE_MODEL_WORKERS_ENV);
}

function adaptiveLiveModelWorkerCeiling(): number {
	return (
		resolveMaxLiveModelWorkers() ?? ADAPTIVE_LIVE_MODEL_WORKER_DEFAULT_CEILING
	);
}

function adaptiveLiveModelWorkerState(
	providerKey: string,
): AdaptiveLiveModelWorkerState {
	let state = adaptiveLiveModelWorkerStates.get(providerKey);
	if (!state) {
		state = {
			limit: ADAPTIVE_LIVE_MODEL_WORKER_FLOOR,
			recentExecutionMs: [],
			lastDecision: "start",
		};
		adaptiveLiveModelWorkerStates.set(providerKey, state);
	}
	return state;
}

function medianOfDurations(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function halveAdaptiveLiveModelWorkerLimit(
	state: AdaptiveLiveModelWorkerState,
	decision: AdaptiveLiveModelWorkerDecision,
): void {
	state.limit = Math.max(
		ADAPTIVE_LIVE_MODEL_WORKER_FLOOR,
		Math.floor(state.limit / 2),
	);
	state.lastDecision = decision;
}

export function observeLiveModelWorkerCompletion(
	providerKey: string,
	executionMs: number | null | undefined,
): void {
	if (!adaptiveLiveModelWorkersEnabled()) return;
	if (
		typeof executionMs !== "number" ||
		!Number.isFinite(executionMs) ||
		executionMs <= 0
	) {
		return;
	}
	const state = adaptiveLiveModelWorkerState(providerKey);
	state.recentExecutionMs.push(executionMs);
	if (state.recentExecutionMs.length > ADAPTIVE_LIVE_MODEL_WORKER_WINDOW_SIZE) {
		state.recentExecutionMs.shift();
	}
	if (state.baselineMs === undefined) {
		if (
			state.recentExecutionMs.length <
			ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES
		) {
			return;
		}
		state.baselineMs = medianOfDurations(
			state.recentExecutionMs.slice(
				0,
				ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES,
			),
		);
	}
	const recentMedianMs = medianOfDurations(state.recentExecutionMs);
	if (
		recentMedianMs >
		state.baselineMs * ADAPTIVE_LIVE_MODEL_WORKER_SHRINK_RATIO
	) {
		halveAdaptiveLiveModelWorkerLimit(state, "shrink");
		return;
	}
	if (
		recentMedianMs <
		state.baselineMs * ADAPTIVE_LIVE_MODEL_WORKER_GROW_RATIO
	) {
		state.limit = Math.min(
			adaptiveLiveModelWorkerCeiling(),
			state.limit + ADAPTIVE_LIVE_MODEL_WORKER_GROW_STEP,
		);
		state.lastDecision = "grow";
		return;
	}
	state.lastDecision = "hold";
}

export function shrinkAdaptiveLiveModelWorkersForBackoff(
	providerKey: string,
): void {
	if (!adaptiveLiveModelWorkersEnabled()) return;
	halveAdaptiveLiveModelWorkerLimit(
		adaptiveLiveModelWorkerState(providerKey),
		"backoff_shrink",
	);
}

function resolveEffectiveMaxLiveModelWorkers(
	providerKey: string,
): number | undefined {
	const configured = resolveMaxLiveModelWorkers();
	if (!adaptiveLiveModelWorkersEnabled()) return configured;
	const adaptive = adaptiveLiveModelWorkerState(providerKey).limit;
	return configured === undefined ? adaptive : Math.min(configured, adaptive);
}

function liveModelWorkerKey(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string {
	return `${run.cwd}\0${run.runId}\0${task.taskId}`;
}

function liveModelWorkerKeysForRun(run: WorkflowRunRecord): Set<string> {
	const keys = new Set<string>();
	for (const task of run.tasks) {
		if (isTerminalTaskStatus(task.status)) continue;
		if (!getWorkerHandle(task)) continue;
		keys.add(liveModelWorkerKey(run, task));
	}
	return keys;
}

function releaseLiveModelWorkerSlotForKey(key: string): void {
	activeLiveModelWorkerKeys.delete(key);
}

export function releaseLiveModelWorkerSlotForTask(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): void {
	releaseLiveModelWorkerSlotForKey(liveModelWorkerKey(run, task));
}

export function reconcileLiveModelWorkerSlots(run: WorkflowRunRecord): void {
	for (const task of run.tasks) {
		if (!isTerminalTaskStatus(task.status)) continue;
		releaseLiveModelWorkerSlotForTask(run, task);
	}
}

function isLiveModelWorkerGateSaturated(
	run: WorkflowRunRecord,
	maxLiveModelWorkers: number,
): boolean {
	const liveKeys = liveModelWorkerKeysForRun(run);
	for (const key of activeLiveModelWorkerKeys) liveKeys.add(key);
	return liveKeys.size >= maxLiveModelWorkers;
}

type LiveModelWorkerSlotAdmission =
	| { kind: "acquired"; release: () => void }
	| { kind: "deferred"; message: string; retryAfterMs: number };

function liveModelWorkerWaitingMessage(maxLiveModelWorkers: number): string {
	return `waiting for global executor worker slot (${maxLiveModelWorkers} max)`;
}

function makeLiveModelWorkerSlotRelease(key: string): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseLiveModelWorkerSlotForKey(key);
	};
}

export function tryAcquireLiveModelWorkerSlot(options: {
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	compiledTask?: CompiledTask;
}): LiveModelWorkerSlotAdmission {
	const maxLiveModelWorkers = resolveEffectiveMaxLiveModelWorkers(
		modelRateLimitBackoffKey(options.task, options.compiledTask),
	);
	if (maxLiveModelWorkers === undefined) {
		return { kind: "acquired", release: () => undefined };
	}
	reconcileLiveModelWorkerSlots(options.run);
	if (isLiveModelWorkerGateSaturated(options.run, maxLiveModelWorkers)) {
		return {
			kind: "deferred",
			message: liveModelWorkerWaitingMessage(maxLiveModelWorkers),
			retryAfterMs: 0,
		};
	}
	const key = liveModelWorkerKey(options.run, options.task);
	activeLiveModelWorkerKeys.add(key);
	return { kind: "acquired", release: makeLiveModelWorkerSlotRelease(key) };
}

function launchRampEnabled(): boolean {
	return workflowExperimentalFlagEnabled(EXPERIMENTAL_LAUNCH_RAMP_ENV);
}

function resolveLaunchSlotReleaseDelayMs(): number {
	if (launchSlotReleaseDelayMsForTests !== undefined) {
		return launchSlotReleaseDelayMsForTests;
	}
	const override = Number.parseInt(
		process.env[LAUNCH_SLOT_RELEASE_DELAY_MS_ENV] ?? "",
		10,
	);
	if (Number.isFinite(override)) return Math.max(0, Math.floor(override));
	return launchRampEnabled()
		? EXPERIMENTAL_LAUNCH_RAMP_RELEASE_DELAY_MS
		: DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS;
}

interface AdaptiveLiveModelWorkerTelemetry {
	limit: number;
	lastDecision: AdaptiveLiveModelWorkerDecision;
	baselineMs?: number;
	samples: number;
}

interface LaunchControlTelemetry {
	maxConcurrentLaunches: number;
	maxLiveModelWorkers?: number;
	launchSlotReleaseDelayMs: number;
	experimentalLaunchRampEnabled?: boolean;
	adaptiveLiveModelWorkersEnabled?: boolean;
	adaptiveLiveModelWorkers?: Record<string, AdaptiveLiveModelWorkerTelemetry>;
}

function adaptiveLiveModelWorkerTelemetry(): Record<
	string,
	AdaptiveLiveModelWorkerTelemetry
> {
	const providers: Record<string, AdaptiveLiveModelWorkerTelemetry> = {};
	for (const [key, state] of adaptiveLiveModelWorkerStates) {
		providers[key] = {
			limit: state.limit,
			lastDecision: state.lastDecision,
			...(state.baselineMs === undefined
				? {}
				: { baselineMs: state.baselineMs }),
			samples: state.recentExecutionMs.length,
		};
	}
	return providers;
}

export function launchControlTelemetry(): LaunchControlTelemetry {
	const maxLiveModelWorkers = resolveMaxLiveModelWorkers();
	return {
		maxConcurrentLaunches: resolveMaxConcurrentLaunches(),
		...(maxLiveModelWorkers === undefined ? {} : { maxLiveModelWorkers }),
		launchSlotReleaseDelayMs: resolveLaunchSlotReleaseDelayMs(),
		...(launchRampEnabled() ? { experimentalLaunchRampEnabled: true } : {}),
		...(adaptiveLiveModelWorkersEnabled()
			? {
					adaptiveLiveModelWorkersEnabled: true,
					adaptiveLiveModelWorkers: adaptiveLiveModelWorkerTelemetry(),
				}
			: {}),
	};
}

export function resolveLaunchControlTelemetryForTests(): LaunchControlTelemetry {
	return launchControlTelemetry();
}

function releaseLaunchSlotAfterDelay(
	delayMs: number,
	release: () => void,
): void {
	if (delayMs <= 0) {
		release();
		return;
	}
	const releaseGeneration = launchSlotReleaseGeneration;
	setTimeout(() => {
		if (releaseGeneration !== launchSlotReleaseGeneration) return;
		release();
	}, delayMs);
}

export async function runWithLaunchSlot<T>(
	action: () => Promise<T>,
	onAcquired?: () => void,
	signal?: AbortSignal,
): Promise<T> {
	const release = await acquireLaunchSlot(signal);
	if (signal?.aborted) {
		release();
		throw abortSignalError(signal);
	}
	onAcquired?.();
	let holdAfterReturn = false;
	try {
		launchSlotAcquiredHookForTests?.();
		throwIfAborted(signal);
		const result = await action();
		holdAfterReturn = true;
		return result;
	} finally {
		releaseLaunchSlotAfterDelay(
			holdAfterReturn ? resolveLaunchSlotReleaseDelayMs() : 0,
			release,
		);
	}
}

export function transientRetryJitterMs(): number {
	if (transientRetryJitterForTests) return transientRetryJitterForTests();
	return (
		MIN_TRANSIENT_RETRY_JITTER_MS +
		Math.floor(
			Math.random() *
				(MAX_TRANSIENT_RETRY_JITTER_MS - MIN_TRANSIENT_RETRY_JITTER_MS + 1),
		)
	);
}

/** Read-only snapshot of held live-worker reservations; does not reconcile/reset. */
export function workerLiveModelWorkerSlotCountForTests(): number {
	return activeLiveModelWorkerKeys.size;
}

export function setWorkerLaunchControlsForTests(options?: {
	releaseDelayMs?: number;
	retryJitterMs?: number | (() => number);
	onLaunchSlotQueued?: () => void;
	onLaunchSlotAcquired?: () => void;
	beforeRunWorker?: () => void | Promise<void>;
	afterLaunchAuthorityRegistered?: () => void | Promise<void>;
	beforeDurableBarrierRelease?: () => void | Promise<void>;
	beforeDurableBarrierAckWait?: () => void | Promise<void>;
}): void {
	launchSlotReleaseDelayMsForTests =
		options?.releaseDelayMs === undefined
			? undefined
			: Math.max(0, Math.floor(options.releaseDelayMs));
	transientRetryJitterForTests =
		options?.retryJitterMs === undefined
			? undefined
			: typeof options.retryJitterMs === "function"
				? options.retryJitterMs
				: () => Math.max(0, Math.floor(options.retryJitterMs as number));
	launchSlotQueuedHookForTests = options?.onLaunchSlotQueued;
	launchSlotAcquiredHookForTests = options?.onLaunchSlotAcquired;
	beforeRunWorkerHookForTests = options?.beforeRunWorker;
	afterLaunchAuthorityRegisteredHookForTests =
		options?.afterLaunchAuthorityRegistered;
	beforeDurableBarrierReleaseHookForTests =
		options?.beforeDurableBarrierRelease;
	beforeDurableBarrierAckWaitHookForTests =
		options?.beforeDurableBarrierAckWait;
	launchSlotReleaseGeneration += 1;
	activeLaunchSlots = 0;
	activeLiveModelWorkerKeys.clear();
	sharedModelRateLimitBackoffs.clear();
	adaptiveLiveModelWorkerStates.clear();
	while (launchWaitQueue.length > 0) launchWaitQueue.shift()?.resolveWait();
}
