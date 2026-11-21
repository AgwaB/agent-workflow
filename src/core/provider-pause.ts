// Provider pause (circuit breaker): when one provider key is overloaded, tasks of that key stop
// launching and wait, one probe task tests the provider, and overload failures during the pause
// do not spend a task's retry attempts. State is home-wide (provider-pause.json) so every run on
// the machine waits together; the per-run cap (AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES, default
// 120, 0 = off) bounds how long one run pauses, after which retries are counted as before.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentWorkflowHome } from "./home-dir.js";
import {
	DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES,
	resolveWorkflowRetryLimit,
	TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
	withSharedRateLimitBackoffLock,
} from "./retry-policy.js";
import type { WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

export const PROVIDER_PAUSE_MAX_MINUTES_ENV =
	"AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES";
const DEFAULT_PROVIDER_PAUSE_MAX_MINUTES = 120;
export const PROVIDER_PAUSE_OPEN_FAILURES = 3;
const DEFAULT_TIMING = {
	failureWindowMs: 5 * 60_000,
	baseWaitMs: 5 * 60_000,
	maxWaitMs: 60 * 60_000,
	minLeaseMs: 30_000,
	minuteMs: 60_000,
};
let timing = DEFAULT_TIMING;

/** Test hook: shorter windows/waits so engine tests need no minutes of wall clock. */
export function setProviderPauseTimingForTests(
	overrides?: Partial<typeof DEFAULT_TIMING>,
): void {
	timing = overrides ? { ...DEFAULT_TIMING, ...overrides } : DEFAULT_TIMING;
}
// A pause nobody probed for this long is forgotten (the machine was idle or the runs are gone).
const PROVIDER_PAUSE_STALE_MS = 6 * 3_600_000;
const PROBE_BUSY_RECHECK_MS = 5_000;

/** Persisted per provider key. `openUntilMs` set = open (before it) or half-open (after it). */
export interface ProviderPauseState {
	failuresAtMs: number[];
	/** Escalation level: 0 closed, n = the nth consecutive open since the last close. */
	opens: number;
	openUntilMs?: number;
	waitMs?: number;
	probe?: { holder: string; leaseUntilMs: number };
}

export type ProviderPauseLaunch =
	| { kind: "go" }
	| { kind: "probe"; state: ProviderPauseState }
	| { kind: "wait"; retryAfterMs: number; openUntilMs: number };

/** 5 min × 2^(opens−1), capped at 60 min. */
export function providerPauseWaitMs(opens: number): number {
	const exponent = Math.max(0, Math.min(10, Math.floor(opens) - 1));
	return Math.min(timing.maxWaitMs, timing.baseWaitMs * 2 ** exponent);
}

/** Per-run cap in ms; 0 = the whole feature is off. Invalid values fall back to the default. */
export function providerPauseMaxMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[PROVIDER_PAUSE_MAX_MINUTES_ENV]?.trim();
	if (raw === undefined || raw === "")
		return DEFAULT_PROVIDER_PAUSE_MAX_MINUTES * timing.minuteMs;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0
		? value * timing.minuteMs
		: DEFAULT_PROVIDER_PAUSE_MAX_MINUTES * timing.minuteMs;
}

function opened(
	state: ProviderPauseState,
	nowMs: number,
	hintMs: number | undefined,
): ProviderPauseState {
	const opens = state.opens + 1;
	const waitMs = Math.max(providerPauseWaitMs(opens), hintMs ?? 0);
	return { failuresAtMs: [], opens, openUntilMs: nowMs + waitMs, waitMs };
}

/**
 * An overload failure of this key. `refund` = the failing task must not spend a retry attempt
 * (it opened the pause, or failed during the pause or its probe).
 */
export function applyProviderOverload(
	state: ProviderPauseState | undefined,
	nowMs: number,
	options: { holder: string; hintMs?: number },
): { state: ProviderPauseState; refund: boolean } {
	const current: ProviderPauseState = state ?? { failuresAtMs: [], opens: 0 };
	const failures = [
		...current.failuresAtMs.filter((at) => at > nowMs - timing.failureWindowMs),
		nowMs,
	];
	if (current.openUntilMs !== undefined) {
		if (nowMs < current.openUntilMs) {
			// An attempt launched before the pause fails during it; a longer reset hint extends it.
			const openUntilMs = Math.max(
				current.openUntilMs,
				nowMs + (options.hintMs ?? 0),
			);
			return {
				state: { ...current, failuresAtMs: failures, openUntilMs },
				refund: true,
			};
		}
		if (current.probe?.holder === options.holder)
			return { state: opened(current, nowMs, options.hintMs), refund: true };
		return { state: { ...current, failuresAtMs: failures }, refund: true };
	}
	if (failures.length >= PROVIDER_PAUSE_OPEN_FAILURES)
		return { state: opened(current, nowMs, options.hintMs), refund: true };
	return { state: { ...current, failuresAtMs: failures }, refund: false };
}

/**
 * May a task of this key launch now? After `openUntil` exactly one holder gets the probe lease
 * (`acquire: false` only checks that a launch would be allowed).
 */
export function evaluateProviderPauseLaunch(
	state: ProviderPauseState | undefined,
	nowMs: number,
	holder: string,
	options: { acquire: boolean } = { acquire: true },
): ProviderPauseLaunch {
	if (!state || state.openUntilMs === undefined) return { kind: "go" };
	if (nowMs < state.openUntilMs)
		return {
			kind: "wait",
			retryAfterMs: state.openUntilMs - nowMs,
			openUntilMs: state.openUntilMs,
		};
	const probe = state.probe;
	if (probe && probe.holder !== holder && probe.leaseUntilMs > nowMs)
		return {
			kind: "wait",
			retryAfterMs: Math.min(probe.leaseUntilMs - nowMs, PROBE_BUSY_RECHECK_MS),
			openUntilMs: state.openUntilMs,
		};
	if (!options.acquire) return { kind: "go" };
	return {
		kind: "probe",
		state: {
			...state,
			probe: {
				holder,
				leaseUntilMs: nowMs + Math.max(state.waitMs ?? 0, timing.minLeaseMs),
			},
		},
	};
}

/**
 * The probe holder finished without overload: `success` closes the pause and resets the
 * escalation (undefined = no state), `release` only gives the lease back.
 */
export function applyProviderPauseOutcome(
	state: ProviderPauseState | undefined,
	holder: string,
	outcome: "success" | "release",
): ProviderPauseState | undefined {
	if (!state || state.openUntilMs === undefined) return state;
	if (state.probe?.holder !== holder) return state;
	if (outcome === "success") return undefined;
	const { probe: _probe, ...rest } = state;
	return rest;
}

function providerPauseFile(): string {
	return join(agentWorkflowHome(), "provider-pause.json");
}

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function validState(
	value: unknown,
	nowMs: number,
): ProviderPauseState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (!finite(record.opens) || !Array.isArray(record.failuresAtMs))
		return undefined;
	const failuresAtMs = record.failuresAtMs.filter(
		(at): at is number => finite(at) && at > nowMs - timing.failureWindowMs,
	);
	const openUntilMs = finite(record.openUntilMs)
		? record.openUntilMs
		: undefined;
	if (
		openUntilMs !== undefined &&
		nowMs - openUntilMs > PROVIDER_PAUSE_STALE_MS
	)
		return undefined;
	if (openUntilMs === undefined && failuresAtMs.length === 0) return undefined;
	const probe = record.probe as Record<string, unknown> | undefined;
	return {
		failuresAtMs,
		opens: record.opens,
		...(openUntilMs === undefined ? {} : { openUntilMs }),
		...(finite(record.waitMs) ? { waitMs: record.waitMs } : {}),
		...(probe && typeof probe.holder === "string" && finite(probe.leaseUntilMs)
			? { probe: { holder: probe.holder, leaseUntilMs: probe.leaseUntilMs } }
			: {}),
	};
}

async function readAllStates(
	nowMs: number,
): Promise<Map<string, ProviderPauseState>> {
	const states = new Map<string, ProviderPauseState>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(providerPauseFile(), "utf8"));
	} catch {
		return states;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return states;
	for (const [key, value] of Object.entries(parsed)) {
		const state = validState(value, nowMs);
		if (state) states.set(key, state);
	}
	return states;
}

/** Read without the lock (advisory fast path); undefined when the key has no recorded state. */
export async function readProviderPauseState(
	key: string,
	nowMs = Date.now(),
): Promise<ProviderPauseState | undefined> {
	return (await readAllStates(nowMs)).get(key);
}

async function updateProviderPauseState<T>(
	key: string,
	nowMs: number,
	update: (state: ProviderPauseState | undefined) => {
		state: ProviderPauseState | undefined;
		result: T;
	},
): Promise<T> {
	const file = providerPauseFile();
	return withSharedRateLimitBackoffLock(file, async () => {
		const states = await readAllStates(nowMs);
		const { state, result } = update(states.get(key));
		if (state) states.set(key, state);
		else states.delete(key);
		const tmpFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
		await mkdir(dirname(file), { recursive: true });
		try {
			await writeFile(
				tmpFile,
				`${JSON.stringify(Object.fromEntries(states), null, 2)}\n`,
				"utf8",
			);
			await rename(tmpFile, file);
		} finally {
			await rm(tmpFile, { force: true });
		}
		return result;
	});
}

export async function removeProviderPauseStateForTests(): Promise<void> {
	await rm(providerPauseFile(), { force: true });
	await rm(`${providerPauseFile()}.lock`, { recursive: true, force: true });
}

// ---- run record summary -------------------------------------------------------------------

export type ProviderPauseRunSummary = NonNullable<
	WorkflowRunRecord["providerPause"]
>[string];

function runEntry(
	run: WorkflowRunRecord,
	key: string,
): ProviderPauseRunSummary {
	run.providerPause ??= {};
	return (run.providerPause[key] ??= { opens: 0, pausedMs: 0 });
}

function runPausedMs(
	run: Pick<WorkflowRunRecord, "providerPause">,
	nowMs: number,
): number {
	let total = 0;
	for (const entry of Object.values(run.providerPause ?? {})) {
		total += entry.pausedMs;
		const since = Date.parse(entry.pausedSince ?? "");
		if (Number.isFinite(since)) total += Math.max(0, nowMs - since);
	}
	return total;
}

/** The run has used up its pause allowance: no more waiting and no more refunds. */
export function providerPauseCapReached(
	run: Pick<WorkflowRunRecord, "providerPause">,
	nowMs: number,
	maxMs = providerPauseMaxMs(),
): boolean {
	return maxMs > 0 && runPausedMs(run, nowMs) >= maxMs;
}

function markRunPaused(
	run: WorkflowRunRecord,
	key: string,
	nowMs: number,
	openUntilMs: number,
	pause: number,
): void {
	const entry = runEntry(run, key);
	if (entry.pausedSince === undefined || entry.pause !== pause)
		entry.opens += 1;
	entry.pausedSince ??= new Date(nowMs).toISOString();
	entry.openUntil = new Date(openUntilMs).toISOString();
	entry.pause = pause;
}

function markRunResumed(
	run: WorkflowRunRecord,
	key: string,
	nowMs: number,
): void {
	const entry = run.providerPause?.[key];
	if (entry?.pausedSince === undefined) return;
	const since = Date.parse(entry.pausedSince);
	if (Number.isFinite(since)) entry.pausedMs += Math.max(0, nowMs - since);
	delete entry.pausedSince;
	delete entry.openUntil;
}

function markCapReached(run: WorkflowRunRecord, nowMs: number): void {
	for (const key of Object.keys(run.providerPause ?? {}))
		markRunResumed(run, key, nowMs);
	for (const entry of Object.values(run.providerPause ?? {}))
		entry.capReached = true;
}

function hhmm(ms: number): string {
	return Number.isFinite(ms)
		? `${new Date(ms).toISOString().slice(11, 16)}Z`
		: "later";
}

function pauseStateText(openUntilMs: number, nowMs: number): string {
	return Number.isFinite(openUntilMs) && openUntilMs > nowMs
		? `paused until ${hhmm(openUntilMs)}`
		: "paused, waiting for the probe";
}

/** The first run-level key that is paused now (its tasks wait), for status lines and health. */
export function activeProviderPause(
	run: Pick<WorkflowRunRecord, "providerPause">,
): { key: string; entry: ProviderPauseRunSummary } | undefined {
	for (const [key, entry] of Object.entries(run.providerPause ?? {}))
		if (entry.pausedSince !== undefined && entry.capReached !== true)
			return { key, entry };
	return undefined;
}

/** `provider <key> overloaded: paused until HH:MMZ (pause n, m of 120 min)`; only while paused. */
export function formatProviderPauseLine(
	run: Pick<WorkflowRunRecord, "providerPause" | "status">,
	nowMs = Date.now(),
	maxMs = providerPauseMaxMs(),
): string | undefined {
	if (run.status !== "running" || maxMs <= 0) return undefined;
	const active = activeProviderPause(run);
	if (!active) return undefined;
	const { key, entry } = active;
	const state = pauseStateText(Date.parse(entry.openUntil ?? ""), nowMs);
	return `provider ${key} overloaded: ${state} (pause ${entry.pause ?? entry.opens}, ${Math.floor(runPausedMs({ providerPause: { [key]: entry } }, nowMs) / timing.minuteMs)} of ${Math.round(maxMs / timing.minuteMs)} min)`;
}

// ---- engine entry points ----------------------------------------------------------------

function providerPauseHolder(
	run: Pick<WorkflowRunRecord, "runId">,
	task: Pick<WorkflowTaskRunRecord, "taskId">,
): string {
	return `${run.runId}/${task.taskId}`;
}

export type ProviderPauseGate =
	| { kind: "go" }
	| { kind: "wait"; message: string; retryAfterMs: number };

/**
 * Launch gate. `acquire: false` is the read-only early check; `acquire: true` (right before the
 * launch) takes the single probe lease. The run summary is updated in place; the caller persists it.
 */
export async function providerPauseLaunchGate(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	key: string,
	options: { acquire: boolean },
	nowMs = Date.now(),
): Promise<ProviderPauseGate> {
	const maxMs = providerPauseMaxMs();
	if (maxMs <= 0) return { kind: "go" };
	try {
		const holder = providerPauseHolder(run, task);
		const state = await readProviderPauseState(key, nowMs);
		let decision = evaluateProviderPauseLaunch(state, nowMs, holder, {
			acquire: false,
		});
		if (
			decision.kind === "go" &&
			options.acquire &&
			state?.openUntilMs !== undefined
		)
			decision = await updateProviderPauseState(key, nowMs, (current) => {
				const next = evaluateProviderPauseLaunch(current, nowMs, holder);
				return {
					state: next.kind === "probe" ? next.state : current,
					result: next,
				};
			});
		if (decision.kind !== "wait") {
			markRunResumed(run, key, nowMs);
			return { kind: "go" };
		}
		if (providerPauseCapReached(run, nowMs, maxMs)) {
			markCapReached(run, nowMs);
			return { kind: "go" };
		}
		markRunPaused(run, key, nowMs, decision.openUntilMs, state?.opens ?? 1);
		// No paused-minutes count here: the task message must stay stable between polls.
		return {
			kind: "wait",
			message: `provider ${key} overloaded: ${pauseStateText(decision.openUntilMs, nowMs)}; waiting before launching`,
			retryAfterMs: decision.retryAfterMs,
		};
	} catch {
		// Advisory state: a read/lock failure never blocks a launch.
		return { kind: "go" };
	}
}

/** Give a probe lease back (the launch did not happen after all). */
export async function providerPauseReleaseLease(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	key: string,
): Promise<void> {
	await providerPauseObserveTerminal({ run, task, key, outcome: "release" });
}

/**
 * A task of `key` reached a terminal result (or gave its lease back). Overload counts toward
 * (re)opening the pause and returns whether the failure is refunded; any other outcome of the
 * probe holder closes the pause (`success`) or only releases the lease (`release`). Never throws.
 */
export async function providerPauseObserveTerminal(options: {
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	key: string;
	outcome: "overload" | "success" | "release";
	hintMs?: number;
	nowMs?: number;
}): Promise<{ refund: boolean; openUntilMs?: number }> {
	const maxMs = providerPauseMaxMs();
	if (maxMs <= 0) return { refund: false };
	const { run, task, key, outcome } = options;
	const nowMs = options.nowMs ?? Date.now();
	const holder = providerPauseHolder(run, task);
	try {
		if (outcome !== "overload") {
			const state = await readProviderPauseState(key, nowMs);
			if (state?.openUntilMs === undefined || state.probe?.holder !== holder)
				return { refund: false };
			await updateProviderPauseState(key, nowMs, (current) => ({
				state: applyProviderPauseOutcome(current, holder, outcome),
				result: undefined,
			}));
			return { refund: false };
		}
		const applied = await updateProviderPauseState(key, nowMs, (current) => {
			const next = applyProviderOverload(current, nowMs, {
				holder,
				...(options.hintMs === undefined ? {} : { hintMs: options.hintMs }),
			});
			return { state: next.state, result: next };
		});
		if (!applied.refund) return { refund: false };
		if (providerPauseCapReached(run, nowMs, maxMs)) {
			markCapReached(run, nowMs);
			return { refund: false };
		}
		const openUntilMs = applied.state.openUntilMs ?? nowMs;
		markRunPaused(run, key, nowMs, openUntilMs, applied.state.opens);
		return { refund: true, openUntilMs };
	} catch {
		return { refund: false };
	}
}

/**
 * Puts a task whose attempt hit the provider overload back to pending without spending retry
 * budget. The relaunch needs a new attempt identity (the executor would return the finished
 * attempt otherwise), so `attempts` still counts up and `maxAttempts` grows with it: the budget
 * left (`maxAttempts - attempts`) is what it was.
 */
export function deferTaskForProviderPause(
	task: WorkflowTaskRunRecord,
	options: { key: string; message: string; openUntilMs: number },
): void {
	const attempts = (task.launchRetry?.attempts ?? 0) + 1;
	const maxAttempts =
		(task.launchRetry?.maxAttempts ??
			resolveWorkflowRetryLimit(
				TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
				DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES,
			)) + 1;
	const message = `${options.message}; provider ${options.key} overloaded: paused until ${hhmm(options.openUntilMs)}, attempt not counted`;
	task.launchRetry = {
		attempts,
		maxAttempts,
		reason: "provider_pause",
		message,
	};
	delete task.workerHandle;
	delete task.workerFiles;
	task.pid = undefined;
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.exitCode = undefined;
	task.providerPauseRefunds = (task.providerPauseRefunds ?? 0) + 1;
	task.status = "pending";
	task.statusDetail = "provider_pause";
	task.lastMessage = message;
}

export function providerPauseAttemptPath(
	resultFile: string,
	refund: number,
): string {
	return join(dirname(resultFile), `result.provider-pause-${refund}.json`);
}
