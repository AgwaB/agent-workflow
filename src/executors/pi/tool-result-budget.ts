// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/runners/tool-result-budget.ts.
// MIT, same author. Changes: no ToolResultBudgetInput import (the budget comes from the Pi executor
// config); env-variable plumbing removed (the per-run extension receives its config directly);
// `normalizeToolResultBudget` dropped (the config parser validates); otherwise unchanged (enforcer,
// placeholders, state shape).
export const TOOL_RESULT_BUDGET_SCHEMA_VERSION = 1 as const;
export const TOOL_RESULT_BUDGET_STATE_FILENAME = "tool-result-budget.json";
export const CONTEXT_RECOVERY_EVICT_FRACTION = 0.25;

export interface ToolResultBudgetConfig {
	maxTotalChars: number;
	forceEvictFraction?: number;
	statePath?: string;
}

export interface ToolResultBudgetState {
	schemaVersion: typeof TOOL_RESULT_BUDGET_SCHEMA_VERSION;
	maxTotalChars: number;
	toolResults: number;
	retainedChars: number;
	evictedCount: number;
	evictedChars: number;
	/** Retained tool results that could still be evicted (excludes the newest). */
	evictableCount: number;
	forcedEvictionApplied: boolean;
}

export function evictionPlaceholder(toolName: string, chars: number): string {
	return `[evicted tool result: ${toolName}, ${chars} chars]`;
}

interface ToolResultEntry {
	key: string;
	toolName: string;
	chars: number;
	message: Record<string, unknown>;
}

function isToolResultMessage(
	message: unknown,
): message is Record<string, unknown> {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>).role === "toolResult"
	);
}

function toolResultChars(message: Record<string, unknown>): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as Record<string, unknown>).type === "text" &&
			typeof (part as Record<string, unknown>).text === "string"
		) {
			chars += ((part as Record<string, unknown>).text as string).length;
		}
	}
	return chars;
}

function messageKey(message: Record<string, unknown>, index: number): string {
	const toolCallId = message.toolCallId;
	return typeof toolCallId === "string" && toolCallId.length > 0
		? toolCallId
		: `#${index}`;
}

function messageToolName(message: Record<string, unknown>): string {
	const toolName = message.toolName;
	return typeof toolName === "string" && toolName.length > 0
		? toolName
		: "unknown";
}

/**
 * Enforces a cumulative character budget over tool-result messages before
 * each model call. Eviction replaces only the message content with a short
 * placeholder; message role, toolCallId, and toolName stay intact so the
 * provider payload structure remains valid. The newest tool result is never
 * evicted. Eviction decisions are sticky for the lifetime of the enforcer.
 */
export class ToolResultBudgetEnforcer {
	private readonly maxTotalChars: number;
	private pendingForceEvictFraction: number;
	private forcedEvictionApplied = false;
	private readonly evicted = new Map<
		string,
		{ toolName: string; chars: number }
	>();

	constructor(options: {
		maxTotalChars: number;
		forceEvictFraction?: number;
	}) {
		this.maxTotalChars = options.maxTotalChars;
		this.pendingForceEvictFraction = options.forceEvictFraction ?? 0;
	}

	enforce(messages: unknown[]): ToolResultBudgetState {
		const entries: ToolResultEntry[] = [];
		for (const [index, message] of messages.entries()) {
			if (!isToolResultMessage(message)) continue;
			entries.push({
				key: messageKey(message, index),
				toolName: messageToolName(message),
				chars: toolResultChars(message),
				message,
			});
		}

		// Re-apply placeholders: the transcript owner hands us a fresh clone of
		// the full message history before every model call.
		for (const entry of entries) {
			const evicted = this.evicted.get(entry.key);
			if (evicted !== undefined) this.replaceWithPlaceholder(entry, evicted);
		}

		const newestKey = entries.at(-1)?.key;
		const retained = entries.filter((entry) => !this.evicted.has(entry.key));
		const retainedChars = () =>
			retained.reduce((total, entry) => total + entry.chars, 0);
		const evictOldest = () => {
			const entry = retained.shift();
			if (entry === undefined) return;
			const record = { toolName: entry.toolName, chars: entry.chars };
			this.evicted.set(entry.key, record);
			this.replaceWithPlaceholder(entry, record);
		};

		if (this.pendingForceEvictFraction > 0) {
			const fraction = this.pendingForceEvictFraction;
			const target = retainedChars() * (1 - fraction);
			let evictedForForce = false;
			while (
				retained.length > 1 &&
				retained[0]!.key !== newestKey &&
				retainedChars() > target
			) {
				evictOldest();
				evictedForForce = true;
				this.forcedEvictionApplied = true;
			}
			// A context may contain no tool results (or only the protected newest
			// result) on the first recovery attempt. Keep the request pending until
			// it can actually evict something.
			if (evictedForForce) this.pendingForceEvictFraction = 0;
		}

		while (
			retained.length > 1 &&
			retained[0]!.key !== newestKey &&
			retainedChars() > this.maxTotalChars
		) {
			evictOldest();
		}

		return this.stateFor(entries.length, retainedChars(), retained.length);
	}

	get state(): ToolResultBudgetState {
		return this.stateFor(0, 0, 0);
	}

	private stateFor(
		toolResults: number,
		retainedChars: number,
		retainedCount: number,
	): ToolResultBudgetState {
		let evictedChars = 0;
		for (const record of this.evicted.values()) evictedChars += record.chars;
		return {
			schemaVersion: TOOL_RESULT_BUDGET_SCHEMA_VERSION,
			maxTotalChars: this.maxTotalChars,
			toolResults,
			retainedChars,
			evictedCount: this.evicted.size,
			evictedChars,
			evictableCount: Math.max(0, retainedCount - 1),
			forcedEvictionApplied: this.forcedEvictionApplied,
		};
	}

	private replaceWithPlaceholder(
		entry: ToolResultEntry,
		record: { toolName: string; chars: number },
	): void {
		entry.message.content = [
			{
				type: "text",
				text: evictionPlaceholder(record.toolName, record.chars),
			},
		];
		entry.chars = 0;
	}
}
