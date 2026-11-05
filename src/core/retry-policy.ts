// Never read host auth secrets. Unknown auth kinds use conservative OAuth backoff;
// auth-kind probes report only non-secret metadata. Rate-limit failures back off without text evidence.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sleep } from "./launch-operations.js";
import { shrinkAdaptiveLiveModelWorkersForBackoff } from "./launch-slots.js";
import { agentWorkflowHome } from "./home-dir.js";
import { nowIso } from "./store.js";
import { type CompiledTask, type WorkflowTaskRunRecord } from "./types.js";

const DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES = 5;
const DEFAULT_ARTIFACT_OUTPUT_RETRIES = 2;
export const TRANSIENT_MODEL_FAILURE_RETRIES_ENV =
	"AGENT_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES";
export const ARTIFACT_OUTPUT_RETRIES_ENV =
	"AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES";
const RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS = 60_000;
const RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS = 5 * 60_000;
const OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS = 15 * 60_000;
const OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS = 60 * 60_000;
const MAX_PERSISTED_RATE_LIMIT_BACKOFF_MS =
	OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS;
interface SharedModelRateLimitBackoffState {
	nextEligibleAtMs: number;
	retryAfterMs: number;
	updatedAt: string;
}

export const sharedModelRateLimitBackoffs = new Map<
	string,
	SharedModelRateLimitBackoffState
>();

// Cross-process persistence for shared rate-limit backoffs. Provider rate
// limits are account-level, so concurrent engine processes (e.g. parallel eval
// batches) should honor each other's cooldowns. The file is an advisory hint;
// writes serialize through a dedicated lock and merge maxima under that lock.
const SHARED_RATE_LIMIT_BACKOFF_MAX_PERSISTED_KEYS = 32;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_WAIT_MS = 5_000;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_RETRY_MS = 25;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_STALE_MS = 30_000;

interface SharedRateLimitPersistenceTelemetry {
	failures: number;
	lastFailureAt?: string;
	lastError?: string;
	lastFile?: string;
	lastKey?: string;
}

let sharedRateLimitPersistenceTelemetry: SharedRateLimitPersistenceTelemetry = {
	failures: 0,
};

export function sharedRateLimitPersistenceTelemetryForTests(): SharedRateLimitPersistenceTelemetry {
	return { ...sharedRateLimitPersistenceTelemetry };
}

function sharedModelRateLimitBackoffFile(): string {
	return join(agentWorkflowHome(), "model-rate-limit-backoff.json");
}

function validPersistedSharedBackoff(
	value: unknown,
	nowMs: number,
): SharedModelRateLimitBackoffState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const nextEligibleAtMs = record.nextEligibleAtMs;
	if (
		typeof nextEligibleAtMs !== "number" ||
		!Number.isFinite(nextEligibleAtMs)
	)
		return undefined;
	if (nextEligibleAtMs <= nowMs) return undefined;
	if (nextEligibleAtMs - nowMs > MAX_PERSISTED_RATE_LIMIT_BACKOFF_MS)
		return undefined;
	return {
		nextEligibleAtMs,
		retryAfterMs: Math.max(0, nextEligibleAtMs - nowMs),
		updatedAt:
			typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
	};
}

async function loadPersistedSharedModelRateLimitBackoffs(): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			await readFile(sharedModelRateLimitBackoffFile(), "utf8"),
		);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const nowMs = Date.now();
	for (const [key, value] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		const state = validPersistedSharedBackoff(value, nowMs);
		if (!state) continue;
		const existing = sharedModelRateLimitBackoffs.get(key);
		if (existing && existing.nextEligibleAtMs >= state.nextEligibleAtMs)
			continue;
		sharedModelRateLimitBackoffs.set(key, state);
	}
}

async function withSharedRateLimitBackoffLock<T>(
	file: string,
	action: () => Promise<T>,
): Promise<T> {
	const lockDir = `${file}.lock`;
	await mkdir(dirname(file), { recursive: true });
	const deadline = Date.now() + SHARED_RATE_LIMIT_BACKOFF_LOCK_WAIT_MS;
	while (true) {
		try {
			await mkdir(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStat = await stat(lockDir).catch(() => undefined);
			if (
				lockStat &&
				Date.now() - lockStat.mtimeMs > SHARED_RATE_LIMIT_BACKOFF_LOCK_STALE_MS
			) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`timed out acquiring shared rate-limit lock: ${lockDir}`,
				);
			}
			await sleep(SHARED_RATE_LIMIT_BACKOFF_LOCK_RETRY_MS);
		}
	}
	try {
		return await action();
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
}

async function persistSharedModelRateLimitBackoffs(
	changedKey: string,
): Promise<void> {
	const file = sharedModelRateLimitBackoffFile();
	try {
		await withSharedRateLimitBackoffLock(file, async () => {
			const nowMs = Date.now();
			const merged = new Map<string, SharedModelRateLimitBackoffState>();
			let onDisk: unknown;
			try {
				onDisk = JSON.parse(await readFile(file, "utf8"));
			} catch {
				onDisk = undefined;
			}
			if (onDisk && typeof onDisk === "object" && !Array.isArray(onDisk)) {
				for (const [key, value] of Object.entries(
					onDisk as Record<string, unknown>,
				)) {
					const state = validPersistedSharedBackoff(value, nowMs);
					if (state) merged.set(key, state);
				}
			}
			for (const [key, state] of sharedModelRateLimitBackoffs) {
				if (state.nextEligibleAtMs <= nowMs) continue;
				const existing = merged.get(key);
				if (!existing || state.nextEligibleAtMs > existing.nextEligibleAtMs)
					merged.set(key, state);
			}
			const entries = [...merged.entries()]
				.sort((a, b) => b[1].nextEligibleAtMs - a[1].nextEligibleAtMs)
				.slice(0, SHARED_RATE_LIMIT_BACKOFF_MAX_PERSISTED_KEYS);
			const tmpFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
			try {
				await writeFile(
					tmpFile,
					`${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`,
					"utf8",
				);
				await rename(tmpFile, file);
			} finally {
				await rm(tmpFile, { force: true });
			}
		});
	} catch (error) {
		sharedRateLimitPersistenceTelemetry = {
			failures: sharedRateLimitPersistenceTelemetry.failures + 1,
			lastFailureAt: nowIso(),
			lastError: error instanceof Error ? error.message : String(error),
			lastFile: file,
			lastKey: changedKey,
		};
		// Advisory cross-process hint only: retain the local cooldown and let the
		// caller continue, while exposing structured failure telemetry.
	}
}

export function removePersistedSharedModelRateLimitBackoffsForTests(): void {
	try {
		const file = sharedModelRateLimitBackoffFile();
		rmSync(file, { force: true });
		rmSync(`${file}.lock`, { recursive: true, force: true });
		sharedRateLimitPersistenceTelemetry = { failures: 0 };
	} catch {
		// best-effort test hygiene
	}
}

export async function recordSharedModelRateLimitBackoffForTests(
	model: string | undefined,
	backoffMs: number | undefined,
): Promise<void> {
	await recordSharedModelRateLimitBackoff(
		{ runtime: { model } } as WorkflowTaskRunRecord,
		backoffMs,
	);
}

export function classifyDeterministicBootFailure(options: {
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	stderrText: string;
	outputBytes: number;
	contextLengthExceeded: boolean;
}): string | undefined {
	if (
		options.statusInfo.status !== "failed" ||
		options.statusInfo.failureKind !== "model" ||
		options.outputBytes !== 0 ||
		options.contextLengthExceeded
	) {
		return undefined;
	}
	const text = options.stderrText;
	const deterministicPattern =
		/(Failed to load extension|Cannot find module|(?:failed to load|invalid|missing) (?:workflow )?config(?:uration)?|config(?:uration)? (?:error|failed|invalid))/i;
	if (!deterministicPattern.test(text)) return undefined;
	const excerpt =
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => deterministicPattern.test(line)) ?? text.trim();
	return `deterministic-boot failure: ${excerpt.slice(0, 500)}`;
}

function metadataTextValues(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return [];
	}
	const record = metadata as Record<string, unknown>;
	const values: string[] = [];
	for (const key of ["error", "errorMessage", "message", "stopReason"]) {
		const value = record[key];
		if (typeof value === "string") values.push(value);
	}
	const streamErrors = record.streamErrors;
	if (Array.isArray(streamErrors)) {
		for (const value of streamErrors) {
			if (typeof value === "string") values.push(value);
		}
	}
	return values;
}

function providerInputValidationFailure(text: string): boolean {
	const lower = text.toLowerCase();
	if (
		/(?:\b429\b|rate_limit|rate limit|temporar(?:y|ily)|overloaded|timeout|timed out|\b5xx\b|\bhttp(?:\/\d(?:\.\d)?)?[ /]?5\d\d\b|\bstatus(?: code)?[:= ]+5\d\d\b|\b5\d\d\s+(?:internal|bad gateway|service unavailable|gateway timeout|server error)\b)/.test(
			lower,
		)
	) {
		return false;
	}
	return (
		/string_above_max_length|string_below_min_length|string_too_long|string_too_short/.test(
			lower,
		) ||
		/\b(?:invalid|expected)\b.{0,120}(?:prompt_cache_key|max(?:imum)?[ _-]?length)/.test(
			lower,
		) ||
		/(?:invalid_request_error|bad_request|http 400|\b400 bad request\b)/.test(
			lower,
		)
	);
}

export function classifyPermanentModelFailure(options: {
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	errorMessage?: string;
	stderrText: string;
	outputBytes: number;
	contextLengthExceeded: boolean;
	subagentResult?: Record<string, unknown>;
	snapshotMetadata?: Record<string, unknown> | null;
}): string | undefined {
	if (
		options.statusInfo.status !== "failed" ||
		options.statusInfo.failureKind !== "model" ||
		options.outputBytes !== 0 ||
		options.contextLengthExceeded
	) {
		return undefined;
	}
	const candidates = [
		options.statusInfo.errorMessage,
		options.errorMessage,
		options.stderrText,
		...metadataTextValues(options.subagentResult?.metadata),
		...metadataTextValues(options.snapshotMetadata),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const matched = candidates.find(providerInputValidationFailure);
	if (!matched) return undefined;
	return `permanent-model failure: ${matched.trim().slice(0, 500)}`;
}

function modelRateLimitBackoffKeyForModel(model: string | undefined): string {
	const trimmed = model?.trim();
	if (!trimmed) return "default";
	const provider = trimmed.includes("/") ? trimmed.split("/", 1)[0] : trimmed;
	return (provider ?? trimmed).toLowerCase();
}

export function modelRateLimitBackoffKey(
	task: WorkflowTaskRunRecord,
	compiledTask?: CompiledTask,
): string {
	return modelRateLimitBackoffKeyForModel(
		compiledTask?.runtime.model ?? task.runtime.model,
	);
}

function sharedModelRateLimitBackoffScope(key: string): string {
	return key === "default" ? "model provider" : `${key} provider`;
}

export function sharedModelRateLimitBackoffWaitingMessage(
	key: string,
	nextEligibleAt: string,
): string {
	return `waiting until ${nextEligibleAt} before launching the executor after shared ${sharedModelRateLimitBackoffScope(key)} rate-limit backoff`;
}

export async function recordSharedModelRateLimitBackoff(
	task: WorkflowTaskRunRecord,
	backoffMs: number | undefined,
): Promise<void> {
	if (backoffMs === undefined || backoffMs <= 0) return;
	const key = modelRateLimitBackoffKey(task);
	shrinkAdaptiveLiveModelWorkersForBackoff(key);
	const nowMs = Date.now();
	const nextEligibleAtMs = nowMs + Math.max(0, Math.floor(backoffMs));
	const existing = sharedModelRateLimitBackoffs.get(key);
	const boundedNextEligibleAtMs = Math.max(
		existing?.nextEligibleAtMs ?? 0,
		nextEligibleAtMs,
	);
	sharedModelRateLimitBackoffs.set(key, {
		nextEligibleAtMs: boundedNextEligibleAtMs,
		retryAfterMs: Math.max(0, boundedNextEligibleAtMs - nowMs),
		updatedAt: nowIso(),
	});
	await persistSharedModelRateLimitBackoffs(key);
}

export async function sharedModelRateLimitBackoffRemaining(
	key: string,
): Promise<
	| {
			key: string;
			nextEligibleAt: string;
			remainingMs: number;
			retryAfterMs: number;
	  }
	| undefined
> {
	await loadPersistedSharedModelRateLimitBackoffs();
	const backoff = sharedModelRateLimitBackoffs.get(key);
	if (!backoff) return undefined;
	const remainingMs = Math.max(0, backoff.nextEligibleAtMs - Date.now());
	if (remainingMs <= 0) {
		sharedModelRateLimitBackoffs.delete(key);
		return undefined;
	}
	return {
		key,
		nextEligibleAt: new Date(backoff.nextEligibleAtMs).toISOString(),
		remainingMs,
		retryAfterMs: backoff.retryAfterMs,
	};
}

function isRateLimitModelFailureText(text: string): boolean {
	return /(?:\bhttp(?:\/\d(?:\.\d)?)?[ /]?429\b|\bstatus(?: code)?[:= ]+429\b|\b429\s+(?:too many requests|rate[_ -]?limit)|rate[_ -]?limit|too many requests|quota exceeded)/i.test(
		text,
	);
}

type RateLimitRetryAfterUnit = "millisecond" | "second" | "minute";

function rateLimitRetryAfterUnit(
	unit: string | undefined,
): RateLimitRetryAfterUnit {
	const lower = (unit ?? "").toLowerCase();
	if (lower === "ms" || lower.startsWith("millisecond")) return "millisecond";
	if (lower === "m" || lower.startsWith("min") || lower.startsWith("minute")) {
		return "minute";
	}
	return "second";
}

function boundedRateLimitRetryAfterMs(
	value: number,
	unit: RateLimitRetryAfterUnit,
	modelBackoffKey?: string,
): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const multiplier =
		unit === "millisecond" ? 1 : unit === "minute" ? 60_000 : 1000;
	return Math.min(
		rateLimitBackoffProfile(modelBackoffKey).maxMs,
		Math.ceil(value * multiplier),
	);
}

function retryAfterMsFromRateLimitText(
	text: string,
	modelBackoffKey?: string,
): number | undefined {
	const retryAfterHeaderMatch = text.match(
		/\bretry[-_ ]?after\b\s*[:=]\s*(\d{1,6})(?:\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?))?\b/i,
	);
	if (retryAfterHeaderMatch) {
		return boundedRateLimitRetryAfterMs(
			Number.parseInt(retryAfterHeaderMatch[1] ?? "", 10),
			rateLimitRetryAfterUnit(retryAfterHeaderMatch[2]),
			modelBackoffKey,
		);
	}
	const tryAgainMatch = text.match(
		/\btry again in\s+(\d{1,6})\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/i,
	);
	if (!tryAgainMatch) return undefined;
	return boundedRateLimitRetryAfterMs(
		Number.parseInt(tryAgainMatch[1] ?? "", 10),
		rateLimitRetryAfterUnit(tryAgainMatch[2]),
		modelBackoffKey,
	);
}

/**
 * Non-secret auth kind reported by an executor probe for provider backoff.
 * Subscription limits are account-level; API-key limits are per key.
 * The engine never reads credential stores.
 */
export type ExecutorAuthKind = "subscription" | "api-key" | "unknown";

export type ExecutorAuthKindProbe = (
	modelBackoffKey: string,
) => ExecutorAuthKind | undefined;

let executorAuthKindProbe: ExecutorAuthKindProbe | undefined;

/** Hook for executor adapters (WP6+): report the auth kind their `probe()` established. */
export function setExecutorAuthKindProbe(
	probe: ExecutorAuthKindProbe | undefined,
): void {
	executorAuthKindProbe = probe;
}

function executorAuthKind(
	modelBackoffKey: string | undefined,
): ExecutorAuthKind {
	const key = modelBackoffKey?.trim().toLowerCase();
	if (!key || key === "default") return "unknown";
	try {
		return executorAuthKindProbe?.(key) ?? "unknown";
	} catch {
		return "unknown";
	}
}

function rateLimitBackoffProfile(modelBackoffKey: string | undefined): {
	baseMs: number;
	maxMs: number;
} {
	// R#12: an unknown auth kind takes the conservative (subscription/OAuth)
	// branch; only a probe-reported API key uses the shorter backoff.
	return executorAuthKind(modelBackoffKey) !== "api-key"
		? {
				baseMs: OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS,
				maxMs: OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS,
			}
		: {
				baseMs: RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS,
				maxMs: RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS,
			};
}

function defaultRateLimitBackoffMs(
	attempt: number,
	modelBackoffKey?: string,
): number {
	const exponent = Math.max(0, Math.min(4, Math.floor(attempt) - 1));
	const profile = rateLimitBackoffProfile(modelBackoffKey);
	return Math.min(profile.maxMs, profile.baseMs * 2 ** exponent);
}

export function transientModelRateLimitBackoffMs(options: {
	attempt: number;
	/** Runtime failure kind; `rate_limit` (executor-classified) backs off without text evidence. */
	failureKind?: string;
	modelBackoffKey?: string;
	errorMessage?: string;
	stderrText: string;
	subagentResult?: Record<string, unknown>;
	snapshotMetadata?: Record<string, unknown> | null;
}): number | undefined {
	const candidates = [
		options.errorMessage,
		options.stderrText,
		...metadataTextValues(options.subagentResult?.metadata),
		...metadataTextValues(options.snapshotMetadata),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const matched = candidates.find(isRateLimitModelFailureText);
	if (!matched)
		return options.failureKind === "rate_limit"
			? defaultRateLimitBackoffMs(options.attempt, options.modelBackoffKey)
			: undefined;
	return (
		retryAfterMsFromRateLimitText(matched, options.modelBackoffKey) ??
		defaultRateLimitBackoffMs(options.attempt, options.modelBackoffKey)
	);
}

export function launchRetryBackoffRemainingMs(
	task: WorkflowTaskRunRecord,
): number | undefined {
	const nextEligibleAt = task.launchRetry?.nextEligibleAt;
	if (typeof nextEligibleAt !== "string" || nextEligibleAt.length === 0) {
		return undefined;
	}
	const nextEligibleAtMs = Date.parse(nextEligibleAt);
	if (!Number.isFinite(nextEligibleAtMs)) return undefined;
	return Math.max(0, nextEligibleAtMs - Date.now());
}

export function shouldRetryTransientModelFailure(
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	},
	workflowResult: { contextLengthExceeded?: boolean; noFinalOutput?: boolean },
	outputBytes: number,
): boolean {
	return (
		statusInfo.status === "failed" &&
		RETRYABLE_EXECUTOR_FAILURE_KINDS.has(statusInfo.failureKind ?? "") &&
		outputBytes === 0 &&
		workflowResult.noFinalOutput === true &&
		workflowResult.contextLengthExceeded !== true
	);
}

export function transientFailureAttemptPath(
	resultFile: string,
	attempt: number,
): string {
	return join(
		dirname(resultFile),
		`result.transient-model-failure-${attempt}.json`,
	);
}

export function resolveWorkflowRetryLimit(
	envName: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[envName];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${envName} must be a non-negative safe integer`);
	}
	return value;
}

export function retryOrFailTransientSubagentFailure(
	task: WorkflowTaskRunRecord,
	options: { reason: string; message: string; backoffMs?: number },
): boolean {
	const attempt = (task.launchRetry?.attempts ?? 0) + 1;
	const maxAttempts =
		task.launchRetry?.maxAttempts ??
		resolveWorkflowRetryLimit(
			TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
			DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES,
		);
	const exhausted = attempt > maxAttempts;
	const backoffMs =
		options.backoffMs === undefined
			? undefined
			: Math.max(0, Math.floor(options.backoffMs));
	const nextEligibleAt =
		!exhausted && backoffMs !== undefined && backoffMs > 0
			? new Date(Date.now() + backoffMs).toISOString()
			: undefined;
	task.launchRetry = {
		attempts: attempt,
		maxAttempts,
		reason: exhausted ? `${options.reason}_exhausted` : options.reason,
		message: options.message,
		...(nextEligibleAt === undefined
			? {}
			: { nextEligibleAt, retryAfterMs: backoffMs }),
	};
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.exitCode = undefined;
	if (!exhausted) {
		task.status = "pending";
		task.statusDetail = "retry_model_failure";
		task.lastMessage =
			nextEligibleAt === undefined
				? `${options.message}; retrying transient-model failure (${attempt}/${maxAttempts})`
				: `${options.message}; rate-limit backoff until ${nextEligibleAt} before retrying transient-model failure (${attempt}/${maxAttempts})`;
		return true;
	}
	task.status = "failed";
	task.statusDetail = task.launchRetry.reason ?? "model_exhausted";
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = `${options.message}; transient-model failure retries exhausted (${maxAttempts})`;
	return true;
}

export function retryOrFailArtifactGraphTask(
	task: WorkflowTaskRunRecord,
	options: {
		reason: string;
		attempt: number;
		message: string;
		artifacts?: string[];
		repairMode?: "same_session" | "new_session";
		sessionId?: string;
	},
): boolean {
	const maxAttempts =
		task.outputRetry?.maxAttempts ??
		resolveWorkflowRetryLimit(
			ARTIFACT_OUTPUT_RETRIES_ENV,
			DEFAULT_ARTIFACT_OUTPUT_RETRIES,
		);
	const exhausted = options.attempt > maxAttempts;
	const outputRetry = {
		attempts: options.attempt,
		maxAttempts,
		reason: exhausted ? `${options.reason}_exhausted` : options.reason,
		message: options.message,
		artifacts: options.artifacts,
		...(options.repairMode === undefined
			? {}
			: { repairMode: options.repairMode }),
		...(options.sessionId === undefined
			? {}
			: { sessionId: options.sessionId }),
	};
	task.outputRetry = outputRetry;
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.exitCode = undefined;
	if (!exhausted) {
		task.status = "pending";
		task.statusDetail = "retry_output_invalid";
		task.lastMessage = options.message;
		return true;
	}
	task.status = "failed";
	task.statusDetail = outputRetry.reason ?? "artifact_graph_output_invalid";
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = options.message;
	return true;
}

/**
 * Transient retry accepts model, transient, rate_limit, and reconcile-proven not_started failures.
 * Decision, unknown, auth, config, and permanent executor failures are never retried automatically.
 */
export const RETRYABLE_EXECUTOR_FAILURE_KINDS: ReadonlySet<string> = new Set([
	"model",
	"transient",
	"rate_limit",
	"not_started",
]);
