// New in agent-workflow (WP33): per-run sidecars the host API shows in `status <run>`/`inspect`.
// Item 3 (parity row 33): parent-session usage (`parent-usage.json`, written by the Pi host while
// its session drives a run; pi-workflow showed it in the board's run detail). Only totals are
// returned: never the session's message hashes.
import {
	readParentUsage,
	type WorkflowParentUsageRecord,
} from "../core/workflow-parent-usage.js";

export interface ParentUsageSummary {
	source: "parent-session";
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
	assistantMessages: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	lastWriteFailure?: WorkflowParentUsageRecord["lastWriteFailure"];
}

const USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
] as const;

/** The parent-usage totals of a run, or undefined when no host session recorded any. */
export async function parentUsageSummary(
	cwd: string,
	runId: string,
): Promise<ParentUsageSummary | undefined> {
	const record = await readParentUsage(cwd, runId).catch(() => undefined);
	if (!record) return undefined;
	const summary: ParentUsageSummary = {
		source: "parent-session",
		assistantMessages: record.assistantMessages,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		...(record.completedAt ? { completedAt: record.completedAt } : {}),
		...(record.lastWriteFailure
			? { lastWriteFailure: record.lastWriteFailure }
			: {}),
	};
	for (const key of USAGE_KEYS) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value))
			summary[key] = value;
	}
	return summary;
}

const count = (value: number | undefined) =>
	value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US");

/** One line: `Parent session usage: 1,234 tokens (in 1,000, out 234, cache r/w 0/0), $0.0123, 2 messages`. */
export function formatParentUsage(summary: ParentUsageSummary): string {
	const total =
		summary.totalTokens ??
		(summary.inputTokens ?? 0) + (summary.outputTokens ?? 0);
	const cost =
		summary.costUsd === undefined ? "" : `, $${summary.costUsd.toFixed(4)}`;
	const messages = `${summary.assistantMessages} assistant message${summary.assistantMessages === 1 ? "" : "s"}`;
	const state = summary.completedAt ? "" : " (counting)";
	return `Parent session usage: ${count(total)} tokens (in ${count(summary.inputTokens)}, out ${count(summary.outputTokens)}, cache read/write ${count(summary.cacheReadInputTokens)}/${count(summary.cacheCreationInputTokens)})${cost}, ${messages}${state}`;
}
