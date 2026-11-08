// Usage summaries report the attempt's model.
import { type WorkerRunStatusSnapshot } from "./runtime-port.js";
import {
	normalizedToolResultBudgetValues,
	summarizeToolResultBudgetAttempts,
} from "./dynamic-tool-result-budget-metrics.js";
import {
	activeLaunchSlots,
	launchControlTelemetry,
	launchWaitQueue,
} from "./launch-slots.js";
import { nowIso } from "./store.js";
import {
	type WorkflowTaskRunRecord,
	type WorkflowTaskTimingAttemptRecord,
	type WorkflowTaskTimingRecord,
	type WorkflowTaskToolResultBudgetAttemptRecord,
	type WorkflowTaskToolResultBudgetConfigurationRecord,
	type WorkflowTaskToolResultBudgetRecord,
	type WorkflowTaskUsageAttemptRecord,
	type WorkflowTaskUsageAggregateRecord,
	type WorkflowTaskUsageRecord,
	type WorkflowTaskUsageValues,
	type WorkflowToolResultBudgetConfigurationSource,
} from "./types.js";

// Transcript hygiene for dynamically generated children (June-22 evidence:
// children died on context overflow from accumulated tool results). Applied
// only to dynamic generated tasks; static stages keep their spec-authored
// budgets. Set the env to 0 (or any non-positive value) to disable.
const DYNAMIC_TOOL_RESULT_BUDGET_ENV =
	"AGENT_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS";
const DEFAULT_DYNAMIC_TOOL_RESULT_BUDGET_CHARS = 320_000;
type UsageMetricKey = keyof WorkflowTaskUsageValues;
export const USAGE_METRIC_KEYS: UsageMetricKey[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
];
const USAGE_FIELD_ALIASES: Record<
	UsageMetricKey,
	readonly (readonly string[])[]
> = {
	inputTokens: [
		["inputTokens"],
		["input_tokens"],
		["input"],
		["promptTokens"],
		["prompt_tokens"],
	],
	outputTokens: [
		["outputTokens"],
		["output_tokens"],
		["output"],
		["completionTokens"],
		["completion_tokens"],
	],
	totalTokens: [["totalTokens"], ["total_tokens"], ["tokens"], ["total"]],
	cachedInputTokens: [
		["cachedInputTokens"],
		["cached_input_tokens"],
		["prompt_tokens_details", "cached_tokens"],
		["input_tokens_details", "cached_tokens"],
	],
	cacheCreationInputTokens: [
		["cacheCreationInputTokens"],
		["cacheCreationTokens"],
		["cacheWriteTokens"],
		["cache_creation_input_tokens"],
		["cache_write_input_tokens"],
		["cacheWrite"],
		["cache_write"],
	],
	cacheReadInputTokens: [
		["cacheReadInputTokens"],
		["cacheReadTokens"],
		["cache_read_input_tokens"],
		["cacheRead"],
		["cache_read"],
		// Runtime UsageSummary (`metadata.usage` of an executor attempt): `cached` is the summed
		// SDK UsageEvent.cached, the cache-read input tokens (WP1b fix).
		["cached"],
	],
	reasoningTokens: [
		["reasoningTokens"],
		["reasoning_tokens"],
		["reasoning"],
		["completion_tokens_details", "reasoning_tokens"],
		["output_tokens_details", "reasoning_tokens"],
	],
	costUsd: [
		["costUsd"],
		["cost_usd"],
		["totalCostUsd"],
		["total_cost_usd"],
		["estimatedCostUsd"],
		["estimated_cost_usd"],
		["cost", "total"],
		["cost", "totalUsd"],
		["cost", "total_usd"],
		// Runtime UsageSummary: `cost` is the summed SDK UsageEvent.cost in USD (WP1b fix).
		["cost"],
	],
};

type TimingAggregateKey =
	| "launchWaitMs"
	| "launchDurationMs"
	| "executionMs"
	| "totalMs";
const TIMING_AGGREGATE_KEYS: TimingAggregateKey[] = [
	"launchWaitMs",
	"launchDurationMs",
	"executionMs",
	"totalMs",
];

type TimingTelemetryKey =
	| "refreshReconcileMs"
	| "refreshStatusPollMs"
	| "terminalOutputCopyMs"
	| "terminalStderrCopyMs"
	| "terminalOutputBytes"
	| "terminalStderrBytes"
	| "terminalArtifactMaterializeMs"
	| "terminalArtifactBundleWriteMs";

type TimingTelemetryValues = Partial<Record<TimingTelemetryKey, number>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnValue(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

function valueAtPath(
	record: Record<string, unknown>,
	path: readonly string[],
): { found: boolean; value: unknown } {
	let current: unknown = record;
	for (const part of path) {
		if (!isPlainRecord(current) || !hasOwnValue(current, part)) {
			return { found: false, value: undefined };
		}
		current = current[part];
	}
	return { found: true, value: current };
}

function usageNumberOrNull(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return undefined;
}

export function normalizedUsageValues(raw: unknown): WorkflowTaskUsageValues {
	const record = isPlainRecord(raw) ? raw : undefined;
	const values: WorkflowTaskUsageValues = {};
	if (!record) return values;
	for (const key of USAGE_METRIC_KEYS) {
		for (const path of USAGE_FIELD_ALIASES[key]) {
			const candidate = valueAtPath(record, path);
			if (!candidate.found) continue;
			const value = usageNumberOrNull(candidate.value);
			if (value === undefined) continue;
			values[key] = value;
			break;
		}
	}
	return values;
}

function firstStringValue(
	records: Array<Record<string, unknown> | undefined>,
	keys: string[],
): string | undefined {
	for (const record of records) {
		if (!record) continue;
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
		}
	}
	return undefined;
}

export function metadataRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isPlainRecord(value)) return undefined;
	return isPlainRecord(value.metadata) ? value.metadata : undefined;
}

function usageObservation(
	workerResult: Record<string, unknown> | undefined,
	snapshot: WorkerRunStatusSnapshot,
): { source: string; raw: unknown; present: true } | undefined {
	const resultMetadata = metadataRecord(workerResult);
	if (resultMetadata && hasOwnValue(resultMetadata, "usage")) {
		return {
			source: "worker-result-metadata",
			raw: resultMetadata.usage,
			present: true,
		};
	}
	const snapshotMetadata = isPlainRecord(snapshot.metadata)
		? snapshot.metadata
		: undefined;
	if (snapshotMetadata && hasOwnValue(snapshotMetadata, "usage")) {
		return {
			source: "worker-snapshot-metadata",
			raw: snapshotMetadata.usage,
			present: true,
		};
	}
	if (workerResult && hasOwnValue(workerResult, "usage")) {
		return {
			source: "worker-result",
			raw: workerResult.usage,
			present: true,
		};
	}
	const snapshotRecord = snapshot;
	if (hasOwnValue(snapshotRecord, "usage")) {
		return {
			source: "worker-snapshot",
			raw: snapshotRecord.usage,
			present: true,
		};
	}
	return undefined;
}

function buildTaskUsageAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	capturedAt: string;
}): WorkflowTaskUsageAttemptRecord {
	const resultMetadata = metadataRecord(options.workerResult);
	const snapshotMetadata = isPlainRecord(options.snapshot.metadata)
		? options.snapshot.metadata
		: undefined;
	const resultRecord = options.workerResult;
	const snapshotRecord = options.snapshot;
	const records = [
		resultMetadata,
		snapshotMetadata,
		resultRecord,
		snapshotRecord,
	];
	const observed = usageObservation(options.workerResult, options.snapshot);
	const raw = observed?.raw;
	const unavailable = !observed || raw === null || raw === undefined;
	const provider = firstStringValue(records, ["provider"]);
	// WP12a: the model the executor's usage events named (resolved, e.g. Pi's model or Claude's
	// `claude-haiku-…` for the alias `haiku`) wins over request metadata and the task runtime.
	const model =
		firstStringValue(
			[isPlainRecord(raw) ? raw : undefined, ...records],
			["model"],
		) ?? options.task.runtime.model;
	const effort =
		options.task.runtime.effortResolution?.resolved ??
		options.task.runtime.effort;
	return {
		source: observed?.source ?? "worker-usage-unavailable",
		capturedAt: options.capturedAt,
		workerRunId: options.snapshot.runId,
		workerAttemptId: options.snapshot.attemptId,
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
		...(unavailable ? { unavailable: true as const } : {}),
		...(observed?.present && raw !== undefined ? { raw } : {}),
		...normalizedUsageValues(raw),
		...peakContextValues(raw),
	};
}

/** Runtime UsageSummary `peakContext` / `events` → attempt fields (not summed anywhere). */
function peakContextValues(
	raw: unknown,
): Pick<WorkflowTaskUsageAttemptRecord, "peakContextTokens" | "usageEvents"> {
	if (!isPlainRecord(raw) || !hasOwnValue(raw, "peakContext")) return {};
	const peak = usageNumberOrNull(raw.peakContext);
	const events = raw.events;
	return {
		...(peak === undefined ? {} : { peakContextTokens: peak }),
		...(typeof events === "number" && Number.isInteger(events) && events >= 0
			? { usageEvents: events }
			: {}),
	};
}

function peakContextAggregate(
	attempts: WorkflowTaskUsageAttemptRecord[],
): Partial<Pick<WorkflowTaskUsageAggregateRecord, "peakContextTokens">> {
	const reported = attempts.filter((attempt) =>
		hasOwnValue(attempt, "peakContextTokens"),
	);
	if (reported.length === 0) return {};
	const values = reported.map((attempt) => attempt.peakContextTokens);
	return {
		peakContextTokens: values.some((value) => value === null)
			? null
			: Math.max(...values.map((value) => value as number)),
	};
}

function usageAttemptKey(attempt: WorkflowTaskUsageAttemptRecord): string {
	return `${attempt.workerRunId ?? ""}\0${attempt.workerAttemptId ?? ""}`;
}

function upsertUsageAttempt(
	attempts: WorkflowTaskUsageAttemptRecord[],
	attempt: WorkflowTaskUsageAttemptRecord,
): WorkflowTaskUsageAttemptRecord[] {
	const key = usageAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => usageAttemptKey(candidate) === key,
	);
	if (index < 0) return [...attempts, attempt];
	return attempts.map((candidate, candidateIndex) =>
		candidateIndex === index ? attempt : candidate,
	);
}

function aggregateUsageAttempts(attempts: WorkflowTaskUsageAttemptRecord[]): {
	values: WorkflowTaskUsageValues;
	incomplete: boolean;
} {
	const values: WorkflowTaskUsageValues = {};
	let incomplete = attempts.some((attempt) => attempt.unavailable === true);
	for (const key of USAGE_METRIC_KEYS) {
		const anyPresent = attempts.some((attempt) => hasOwnValue(attempt, key));
		if (!anyPresent) continue;
		let total = 0;
		let complete = true;
		for (const attempt of attempts) {
			if (!hasOwnValue(attempt, key)) {
				complete = false;
				break;
			}
			const value = attempt[key];
			if (typeof value !== "number") {
				complete = false;
				break;
			}
			total += value;
		}
		values[key] = complete ? total : null;
		if (!complete) incomplete = true;
	}
	return { values, incomplete };
}

function latestUsageString(
	attempts: WorkflowTaskUsageAttemptRecord[],
	key: "provider" | "model" | "effort",
): string | undefined {
	for (let index = attempts.length - 1; index >= 0; index -= 1) {
		const value = attempts[index]?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function recordTaskUsageObservation(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	capturedAt: string;
}): void {
	const attempt = buildTaskUsageAttempt(options);
	const attempts = upsertUsageAttempt(
		options.task.usage?.attempts ?? [],
		attempt,
	);
	const aggregate = aggregateUsageAttempts(attempts);
	const usage: WorkflowTaskUsageRecord = {
		source: "executor",
		capturedAt: options.capturedAt,
		...(latestUsageString(attempts, "provider") === undefined
			? {}
			: { provider: latestUsageString(attempts, "provider") }),
		...(latestUsageString(attempts, "model") === undefined
			? {}
			: { model: latestUsageString(attempts, "model") }),
		...(latestUsageString(attempts, "effort") === undefined
			? {}
			: { effort: latestUsageString(attempts, "effort") }),
		...(aggregate.incomplete ? { incomplete: true } : {}),
		...aggregate.values,
		aggregate: {
			attempts: attempts.length,
			...(aggregate.incomplete ? { incomplete: true } : {}),
			...aggregate.values,
			...peakContextAggregate(attempts),
		},
		attempts,
	};
	options.task.usage = usage;
}

interface DynamicTaskToolResultBudgetConfiguration {
	configured: boolean;
	source: WorkflowToolResultBudgetConfigurationSource;
	maxTotalChars?: number;
}

function toolResultBudgetObservation(
	workerResult: Record<string, unknown> | undefined,
	snapshot: WorkerRunStatusSnapshot,
): { source: string; raw: unknown } | undefined {
	const resultMetadata = metadataRecord(workerResult);
	if (resultMetadata && hasOwnValue(resultMetadata, "toolResultBudget")) {
		return {
			source: "worker-result-metadata",
			raw: resultMetadata.toolResultBudget,
		};
	}
	const snapshotMetadata = isPlainRecord(snapshot.metadata)
		? snapshot.metadata
		: undefined;
	if (snapshotMetadata && hasOwnValue(snapshotMetadata, "toolResultBudget")) {
		return {
			source: "worker-snapshot-metadata",
			raw: snapshotMetadata.toolResultBudget,
		};
	}
	if (workerResult && hasOwnValue(workerResult, "toolResultBudget")) {
		return {
			source: "worker-result",
			raw: workerResult.toolResultBudget,
		};
	}
	const snapshotRecord = snapshot;
	if (hasOwnValue(snapshotRecord, "toolResultBudget")) {
		return {
			source: "worker-snapshot",
			raw: snapshotRecord.toolResultBudget,
		};
	}
	return undefined;
}

function firstBooleanValue(
	records: Array<Record<string, unknown> | undefined>,
	key: string,
): boolean | undefined {
	for (const record of records) {
		if (!record || !hasOwnValue(record, key)) continue;
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function buildTaskToolResultBudgetAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	capturedAt: string;
}): WorkflowTaskToolResultBudgetAttemptRecord {
	const resultMetadata = metadataRecord(options.workerResult);
	const snapshotMetadata = isPlainRecord(options.snapshot.metadata)
		? options.snapshot.metadata
		: undefined;
	const resultRecord = options.workerResult;
	const snapshotRecord = options.snapshot;
	const metadataRecords = [
		resultMetadata,
		snapshotMetadata,
		resultRecord,
		snapshotRecord,
	];
	const observed = toolResultBudgetObservation(
		options.workerResult,
		options.snapshot,
	);
	const reported = observed !== undefined && isPlainRecord(observed.raw);
	const contextLengthExceeded = firstBooleanValue(
		metadataRecords,
		"contextLengthExceeded",
	);
	const contextOverflowRecovered = firstBooleanValue(
		metadataRecords,
		"contextOverflowRecovered",
	);
	const contextRecovered = firstBooleanValue(
		metadataRecords,
		"contextRecovered",
	);
	return {
		source: observed?.source ?? "worker-tool-result-budget-unavailable",
		capturedAt: options.capturedAt,
		workerRunId: options.snapshot.runId,
		workerAttemptId: options.snapshot.attemptId,
		terminal: true,
		...(reported
			? { reported: true as const }
			: { unavailable: true as const }),
		...normalizedToolResultBudgetValues(observed?.raw),
		...(contextLengthExceeded === undefined ? {} : { contextLengthExceeded }),
		...(contextOverflowRecovered === undefined
			? {}
			: { contextOverflowRecovered }),
		...(contextRecovered === undefined ? {} : { contextRecovered }),
	};
}

function toolResultBudgetAttemptKey(
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): string {
	return `${attempt.workerRunId ?? ""}\0${attempt.workerAttemptId ?? ""}`;
}

function configuredAttemptFields(
	configuration: WorkflowTaskToolResultBudgetConfigurationRecord,
): Pick<
	WorkflowTaskToolResultBudgetAttemptRecord,
	"configuredAt" | "configured" | "configurationSource"
> &
	Partial<
		Pick<WorkflowTaskToolResultBudgetAttemptRecord, "configuredMaxTotalChars">
	> {
	return {
		configuredAt: configuration.configuredAt,
		configured: configuration.configured,
		configurationSource: configuration.configurationSource,
		...(configuration.configuredMaxTotalChars === undefined
			? {}
			: {
					configuredMaxTotalChars: configuration.configuredMaxTotalChars,
				}),
	};
}

function normalizedToolResultBudgetAttempt(
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): WorkflowTaskToolResultBudgetAttemptRecord {
	const normalized = { ...attempt };
	if (normalized.reported === true) delete normalized.unavailable;
	if (normalized.configured === false && normalized.reported !== true) {
		delete normalized.unavailable;
		normalized.source = "agent-workflow-budget-disabled";
	}
	return normalized;
}

function upsertToolResultBudgetAttempt(
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[],
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): WorkflowTaskToolResultBudgetAttemptRecord[] {
	const key = toolResultBudgetAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => toolResultBudgetAttemptKey(candidate) === key,
	);
	if (index < 0) {
		return [...attempts, normalizedToolResultBudgetAttempt(attempt)];
	}
	return attempts.map((candidate, candidateIndex) => {
		if (candidateIndex !== index) return candidate;
		if (attempt.terminal !== true) {
			return normalizedToolResultBudgetAttempt({ ...candidate, ...attempt });
		}
		const configuration: Partial<WorkflowTaskToolResultBudgetAttemptRecord> = {
			...(candidate.configuredAt === undefined
				? {}
				: { configuredAt: candidate.configuredAt }),
			...(candidate.configured === undefined
				? {}
				: { configured: candidate.configured }),
			...(candidate.configurationSource === undefined
				? {}
				: { configurationSource: candidate.configurationSource }),
			...(candidate.configuredMaxTotalChars === undefined
				? {}
				: {
						configuredMaxTotalChars: candidate.configuredMaxTotalChars,
					}),
		};
		return normalizedToolResultBudgetAttempt({
			...configuration,
			...attempt,
		});
	});
}

function writeTaskToolResultBudgetRecord(options: {
	task: WorkflowTaskRunRecord;
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[];
	capturedAt: string;
	pendingConfiguration?: WorkflowTaskToolResultBudgetConfigurationRecord;
}): void {
	const aggregate = summarizeToolResultBudgetAttempts(options.attempts);
	const record: WorkflowTaskToolResultBudgetRecord = {
		source: "executor",
		capturedAt: options.capturedAt,
		...(aggregate.incomplete ? { incomplete: true } : {}),
		...(options.pendingConfiguration === undefined
			? {}
			: { pendingConfiguration: options.pendingConfiguration }),
		aggregate,
		attempts: options.attempts,
	};
	options.task.toolResultBudget = record;
}

function updateTaskToolResultBudget(options: {
	task: WorkflowTaskRunRecord;
	attempt: WorkflowTaskToolResultBudgetAttemptRecord;
	clearPendingConfiguration?: boolean;
}): void {
	const attempts = upsertToolResultBudgetAttempt(
		options.task.toolResultBudget?.attempts ?? [],
		options.attempt,
	);
	writeTaskToolResultBudgetRecord({
		task: options.task,
		attempts,
		capturedAt: options.attempt.capturedAt,
		...(options.clearPendingConfiguration
			? {}
			: {
					pendingConfiguration:
						options.task.toolResultBudget?.pendingConfiguration,
				}),
	});
}

export function recordTaskToolResultBudgetPendingConfiguration(options: {
	task: WorkflowTaskRunRecord;
	configuration: DynamicTaskToolResultBudgetConfiguration;
	capturedAt: string;
}): void {
	const pendingConfiguration: WorkflowTaskToolResultBudgetConfigurationRecord =
		{
			configuredAt: options.capturedAt,
			configured: options.configuration.configured,
			configurationSource: options.configuration.source,
			...(options.configuration.maxTotalChars === undefined
				? {}
				: { configuredMaxTotalChars: options.configuration.maxTotalChars }),
		};
	writeTaskToolResultBudgetRecord({
		task: options.task,
		attempts: options.task.toolResultBudget?.attempts ?? [],
		capturedAt: options.capturedAt,
		pendingConfiguration,
	});
}

export function bindTaskToolResultBudgetPendingConfiguration(options: {
	task: WorkflowTaskRunRecord;
	workerRunId: string;
	workerAttemptId: string;
	capturedAt: string;
}): void {
	const pendingConfiguration =
		options.task.toolResultBudget?.pendingConfiguration;
	if (!pendingConfiguration) return;
	updateTaskToolResultBudget({
		task: options.task,
		attempt: {
			source: "agent-workflow-launch",
			capturedAt: options.capturedAt,
			workerRunId: options.workerRunId,
			workerAttemptId: options.workerAttemptId,
			...configuredAttemptFields(pendingConfiguration),
		},
		clearPendingConfiguration: true,
	});
}

export function clearTaskToolResultBudgetPendingConfiguration(
	task: WorkflowTaskRunRecord,
): void {
	const record = task.toolResultBudget;
	if (!record?.pendingConfiguration) return;
	if (record.attempts.length === 0) {
		delete task.toolResultBudget;
		return;
	}
	writeTaskToolResultBudgetRecord({
		task,
		attempts: record.attempts,
		capturedAt: nowIso(),
	});
}

function recordTaskToolResultBudgetObservation(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	capturedAt: string;
}): void {
	const observed = toolResultBudgetObservation(
		options.workerResult,
		options.snapshot,
	);
	if (
		!options.task.dynamicGenerated &&
		options.task.toolResultBudget === undefined &&
		observed === undefined
	) {
		return;
	}
	const pendingConfiguration =
		options.task.toolResultBudget?.pendingConfiguration;
	const attempt = buildTaskToolResultBudgetAttempt(options);
	updateTaskToolResultBudget({
		task: options.task,
		attempt:
			pendingConfiguration === undefined
				? attempt
				: {
						...configuredAttemptFields(pendingConfiguration),
						...attempt,
					},
		clearPendingConfiguration: pendingConfiguration !== undefined,
	});
}

function isoTimestampMs(timestamp: string | undefined): number | undefined {
	if (!timestamp) return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function durationBetween(
	startedAt: string | undefined,
	completedAt: string | undefined,
): number | undefined {
	const startedAtMs = isoTimestampMs(startedAt);
	const completedAtMs = isoTimestampMs(completedAt);
	if (startedAtMs === undefined || completedAtMs === undefined)
		return undefined;
	return Math.max(0, completedAtMs - startedAtMs);
}

function durationNumber(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return undefined;
}

export function elapsedSince(startedAtMs: number): number {
	return Math.max(0, Date.now() - startedAtMs);
}

export function recordTaskTimingTelemetry(
	task: WorkflowTaskRunRecord,
	values: TimingTelemetryValues,
): void {
	const sanitized = Object.fromEntries(
		Object.entries(values).filter(
			(entry): entry is [TimingTelemetryKey, number] =>
				typeof entry[1] === "number" &&
				Number.isFinite(entry[1]) &&
				entry[1] >= 0,
		),
	) as TimingTelemetryValues;
	if (Object.keys(sanitized).length === 0) return;
	task.timing = {
		...(task.timing ?? {
			source: "agent-workflow" as const,
			capturedAt: nowIso(),
		}),
		source: "agent-workflow",
		capturedAt: nowIso(),
		...sanitized,
	};
}

function taskTimingTelemetry(
	timing: WorkflowTaskTimingRecord | undefined,
): TimingTelemetryValues {
	if (!timing) return {};
	return {
		...(timing.refreshReconcileMs === undefined
			? {}
			: { refreshReconcileMs: timing.refreshReconcileMs }),
		...(timing.refreshStatusPollMs === undefined
			? {}
			: { refreshStatusPollMs: timing.refreshStatusPollMs }),
		...(timing.terminalOutputCopyMs === undefined
			? {}
			: { terminalOutputCopyMs: timing.terminalOutputCopyMs }),
		...(timing.terminalStderrCopyMs === undefined
			? {}
			: { terminalStderrCopyMs: timing.terminalStderrCopyMs }),
		...(timing.terminalOutputBytes === undefined
			? {}
			: { terminalOutputBytes: timing.terminalOutputBytes }),
		...(timing.terminalStderrBytes === undefined
			? {}
			: { terminalStderrBytes: timing.terminalStderrBytes }),
		...(timing.terminalArtifactMaterializeMs === undefined
			? {}
			: {
					terminalArtifactMaterializeMs: timing.terminalArtifactMaterializeMs,
				}),
		...(timing.terminalArtifactBundleWriteMs === undefined
			? {}
			: {
					terminalArtifactBundleWriteMs: timing.terminalArtifactBundleWriteMs,
				}),
	};
}

export function recordTaskLaunchTiming(
	task: WorkflowTaskRunRecord,
	observation: {
		launchQueuedAt: string;
		launchStartedAt?: string;
		launchCompletedAt?: string;
		waitingForGlobalWorkerSlot?: boolean;
	},
): void {
	const capturedAt = observation.launchCompletedAt ?? nowIso();
	const launchWaitMs = durationBetween(
		observation.launchQueuedAt,
		observation.launchStartedAt,
	);
	const launchDurationMs = durationBetween(
		observation.launchStartedAt,
		observation.launchCompletedAt,
	);
	const launchControls = launchControlTelemetry();
	task.timing = {
		source: "agent-workflow",
		capturedAt,
		launchQueuedAt: observation.launchQueuedAt,
		...(observation.launchStartedAt === undefined
			? {}
			: { launchStartedAt: observation.launchStartedAt }),
		...(observation.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: observation.launchCompletedAt }),
		...(launchWaitMs === undefined ? {} : { launchWaitMs }),
		...(launchDurationMs === undefined ? {} : { launchDurationMs }),
		...(observation.waitingForGlobalWorkerSlot ||
		task.timing?.waiting_for_global_worker_slot
			? { waiting_for_global_worker_slot: true }
			: {}),
		launchSlotReleaseDelayMs: launchControls.launchSlotReleaseDelayMs,
		maxConcurrentLaunches: launchControls.maxConcurrentLaunches,
		...(launchControls.maxLiveModelWorkers === undefined
			? {}
			: { maxLiveModelWorkers: launchControls.maxLiveModelWorkers }),
		...(launchControls.experimentalLaunchRampEnabled
			? { experimentalLaunchRampEnabled: true }
			: {}),
		...(launchControls.adaptiveLiveModelWorkersEnabled
			? {
					adaptiveLiveModelWorkersEnabled: true,
					...(launchControls.adaptiveLiveModelWorkers === undefined
						? {}
						: {
								adaptiveLiveModelWorkers:
									launchControls.adaptiveLiveModelWorkers,
							}),
				}
			: {}),
		...(task.timing?.aggregate === undefined
			? {}
			: { aggregate: task.timing.aggregate }),
		...(task.timing?.attempts === undefined
			? {}
			: { attempts: task.timing.attempts }),
	};
}

function buildTaskTimingAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
	capturedAt: string;
}): WorkflowTaskTimingAttemptRecord {
	const resultDuration = options.workerResult?.durationMs;
	let executionMs = durationNumber(
		resultDuration === undefined ? options.snapshot.durationMs : resultDuration,
	);
	if (executionMs === undefined || executionMs === null) {
		executionMs =
			durationBetween(options.startedAt, options.completedAt) ?? executionMs;
	}
	const totalMs = durationBetween(
		options.task.startedAt ?? options.task.timing?.launchQueuedAt,
		options.completedAt,
	);
	return {
		source: "executor",
		capturedAt: options.capturedAt,
		workerRunId: options.snapshot.runId,
		workerAttemptId: options.snapshot.attemptId,
		...(options.task.timing?.launchQueuedAt === undefined
			? {}
			: { launchQueuedAt: options.task.timing.launchQueuedAt }),
		...(options.task.timing?.launchStartedAt === undefined
			? {}
			: { launchStartedAt: options.task.timing.launchStartedAt }),
		...(options.task.timing?.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: options.task.timing.launchCompletedAt }),
		...(options.task.timing?.launchWaitMs === undefined
			? {}
			: { launchWaitMs: options.task.timing.launchWaitMs }),
		...(options.task.timing?.launchDurationMs === undefined
			? {}
			: { launchDurationMs: options.task.timing.launchDurationMs }),
		...(options.task.timing?.waiting_for_global_worker_slot === undefined
			? {}
			: {
					waiting_for_global_worker_slot:
						options.task.timing.waiting_for_global_worker_slot,
				}),
		...(options.startedAt === undefined
			? {}
			: { executionStartedAt: options.startedAt }),
		...(options.completedAt === undefined
			? {}
			: { executionCompletedAt: options.completedAt }),
		...(executionMs === undefined ? {} : { executionMs }),
		...(totalMs === undefined ? {} : { totalMs }),
	};
}

function timingAttemptKey(attempt: WorkflowTaskTimingAttemptRecord): string {
	return `${attempt.workerRunId ?? ""}\0${attempt.workerAttemptId ?? ""}`;
}

function upsertTimingAttempt(
	attempts: WorkflowTaskTimingAttemptRecord[],
	attempt: WorkflowTaskTimingAttemptRecord,
): WorkflowTaskTimingAttemptRecord[] {
	const key = timingAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => timingAttemptKey(candidate) === key,
	);
	if (index < 0) return [...attempts, attempt];
	return attempts.map((candidate, candidateIndex) =>
		candidateIndex === index ? attempt : candidate,
	);
}

function aggregateTimingAttempts(
	attempts: WorkflowTaskTimingAttemptRecord[],
): NonNullable<WorkflowTaskTimingRecord["aggregate"]> {
	const aggregate: NonNullable<WorkflowTaskTimingRecord["aggregate"]> = {
		attempts: attempts.length,
	};
	let incomplete = false;
	for (const key of TIMING_AGGREGATE_KEYS) {
		const anyPresent = attempts.some((attempt) => hasOwnValue(attempt, key));
		if (!anyPresent) continue;
		let total = 0;
		let complete = true;
		for (const attempt of attempts) {
			if (!hasOwnValue(attempt, key)) {
				complete = false;
				break;
			}
			const value = attempt[key];
			if (typeof value !== "number") {
				complete = false;
				break;
			}
			total += value;
		}
		aggregate[key] = complete ? total : null;
		if (!complete) incomplete = true;
	}
	if (incomplete) aggregate.incomplete = true;
	return aggregate;
}

function recordTaskTerminalTiming(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
	capturedAt: string;
}): void {
	const attempt = buildTaskTimingAttempt(options);
	const attempts = upsertTimingAttempt(
		options.task.timing?.attempts ?? [],
		attempt,
	);
	options.task.timing = {
		source: "agent-workflow",
		capturedAt: options.capturedAt,
		...(attempt.launchQueuedAt === undefined
			? {}
			: { launchQueuedAt: attempt.launchQueuedAt }),
		...(attempt.launchStartedAt === undefined
			? {}
			: { launchStartedAt: attempt.launchStartedAt }),
		...(attempt.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: attempt.launchCompletedAt }),
		...(attempt.launchWaitMs === undefined
			? {}
			: { launchWaitMs: attempt.launchWaitMs }),
		...(attempt.launchDurationMs === undefined
			? {}
			: { launchDurationMs: attempt.launchDurationMs }),
		...(options.task.timing?.launchSlotReleaseDelayMs === undefined
			? {}
			: {
					launchSlotReleaseDelayMs:
						options.task.timing.launchSlotReleaseDelayMs,
				}),
		...(options.task.timing?.maxConcurrentLaunches === undefined
			? {}
			: { maxConcurrentLaunches: options.task.timing.maxConcurrentLaunches }),
		...(options.task.timing?.maxLiveModelWorkers === undefined
			? {}
			: { maxLiveModelWorkers: options.task.timing.maxLiveModelWorkers }),
		...(options.task.timing?.experimentalLaunchRampEnabled
			? { experimentalLaunchRampEnabled: true }
			: {}),
		...(options.task.timing?.adaptiveLiveModelWorkersEnabled
			? { adaptiveLiveModelWorkersEnabled: true }
			: {}),
		...(options.task.timing?.adaptiveLiveModelWorkers === undefined
			? {}
			: {
					adaptiveLiveModelWorkers:
						options.task.timing.adaptiveLiveModelWorkers,
				}),
		...taskTimingTelemetry(options.task.timing),
		...(attempt.executionStartedAt === undefined
			? {}
			: { executionStartedAt: attempt.executionStartedAt }),
		...(attempt.executionCompletedAt === undefined
			? {}
			: { executionCompletedAt: attempt.executionCompletedAt }),
		...(attempt.executionMs === undefined
			? {}
			: { executionMs: attempt.executionMs }),
		...(attempt.totalMs === undefined ? {} : { totalMs: attempt.totalMs }),
		aggregate: aggregateTimingAttempts(attempts),
		attempts,
	};
}

export function recordTerminalTaskObservability(options: {
	task: WorkflowTaskRunRecord;
	snapshot: WorkerRunStatusSnapshot;
	workerResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
}): void {
	const capturedAt = nowIso();
	recordTaskUsageObservation({ ...options, capturedAt });
	recordTaskToolResultBudgetObservation({ ...options, capturedAt });
	recordTaskTerminalTiming({ ...options, capturedAt });
}

/** Read-only snapshot: no slot reset, waiter wake-up, or mutable queue handles. */
export function workerLaunchSlotStateForTests(): {
	active: number;
	queued: number;
} {
	return { active: activeLaunchSlots, queued: launchWaitQueue.length };
}

export function dynamicTaskToolResultBudgetConfiguration(
	task: WorkflowTaskRunRecord,
): DynamicTaskToolResultBudgetConfiguration | undefined {
	if (!task.dynamicGenerated) return undefined;
	const raw = process.env[DYNAMIC_TOOL_RESULT_BUDGET_ENV];
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw.trim());
		if (!Number.isInteger(parsed) || parsed <= 0) {
			return { configured: false, source: "disabled" };
		}
		return {
			configured: true,
			source: "environment",
			maxTotalChars: Math.floor(parsed),
		};
	}
	return {
		configured: true,
		source: "default",
		maxTotalChars: DEFAULT_DYNAMIC_TOOL_RESULT_BUDGET_CHARS,
	};
}
