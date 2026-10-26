/**
 * `codex app-server` notifications → normalized ExecEvents (plan §2.3, codex-cli 0.159.2 v2
 * protocol). Pure: the executor feeds notifications in order and appends whatever comes out.
 * Tool kinds follow ACP, statuses follow vibe-kanban; usage carries tokens with `cost: null`
 * (Codex reports no price), so `source` is `unknown` (SDK rule: null cost ⇔ unknown source).
 */
import type { FailureClass } from "../../sdk/errors.js";
import type {
	ExecEvent,
	ToolCallEvent,
	ToolKind,
	ToolStatus,
	UsageEvent,
} from "../../sdk/events.js";
import type { JsonValue } from "../../sdk/json.js";
import { mcpPrefixedToolName } from "../../mcp/visible-names.js";
import { classifyCodexFailure } from "./errors.js";

/** Tool output kept in a normalized event; the raw transcript keeps everything (D3). */
export const TOOL_OUTPUT_EVENT_LIMIT = 16_384;

interface TokenBreakdown {
	readonly totalTokens?: number;
	readonly inputTokens?: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens?: number;
}

type Item = Record<string, unknown> & {
	readonly type?: string;
	readonly id?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

function clip(text: string): string {
	return text.length <= TOOL_OUTPUT_EVENT_LIMIT
		? text
		: `${text.slice(0, TOOL_OUTPUT_EVENT_LIMIT)}\n…[${text.length - TOOL_OUTPUT_EVENT_LIMIT} chars clipped in the normalized event; see the raw transcript]`;
}

function toJson(value: unknown): JsonValue {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue;
	} catch {
		return String(value);
	}
}

const ITEM_STATUS: Readonly<Record<string, ToolStatus>> = {
	inProgress: "running",
	completed: "completed",
	failed: "failed",
	declined: "denied",
};

/** ACP kind of a shell command from Codex's best-effort `commandActions`. */
export function commandKind(actions: unknown): ToolKind {
	if (!Array.isArray(actions) || actions.length === 0) return "execute";
	const kinds = new Set(
		actions.map((action) => (isRecord(action) ? action.type : undefined)),
	);
	if ([...kinds].every((kind) => kind === "read" || kind === "listFiles"))
		return "read";
	if ([...kinds].every((kind) => kind === "search")) return "search";
	if (
		[...kinds].every(
			(kind) => kind === "read" || kind === "listFiles" || kind === "search",
		)
	)
		return "search";
	return "execute";
}

function patchKind(changes: unknown): ToolKind {
	if (!Array.isArray(changes) || changes.length === 0) return "edit";
	const kinds = changes.map((change) =>
		isRecord(change) && isRecord(change.kind) ? change.kind.type : undefined,
	);
	if (kinds.every((kind) => kind === "delete")) return "delete";
	return "edit";
}

function mcpResultText(result: unknown): string | undefined {
	if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
	return result.content
		.map((entry) =>
			isRecord(entry) && typeof entry.text === "string"
				? entry.text
				: JSON.stringify(entry),
		)
		.join("\n");
}

/** One item (started or completed) → tool_call, or undefined for non-tool items. */
export function toolCallFromItem(
	item: Item,
	phase: "started" | "completed",
	mcpKinds: Readonly<Record<string, ToolKind>> = {},
): ToolCallEvent | undefined {
	const callId = str(item.id);
	const base = callId === undefined ? {} : { callId };
	const status = (fallback: ToolStatus): ToolStatus =>
		ITEM_STATUS[str(item.status) ?? ""] ?? fallback;
	switch (item.type) {
		case "commandExecution": {
			const output = str(item.aggregatedOutput);
			let s = status(phase === "started" ? "running" : "completed");
			if (
				phase === "completed" &&
				s === "completed" &&
				typeof item.exitCode === "number" &&
				item.exitCode !== 0
			)
				s = "failed";
			return {
				type: "tool_call",
				name: "shell",
				kind: commandKind(item.commandActions),
				status: s,
				...base,
				input: toJson({
					command: item.command,
					...(item.commandActions === undefined
						? {}
						: { actions: item.commandActions }),
				}),
				...(phase === "completed"
					? {
							output: toJson({
								exitCode: item.exitCode ?? null,
								output: output === undefined ? null : clip(output),
							}),
						}
					: {}),
			};
		}
		case "fileChange":
			return {
				type: "tool_call",
				name: "apply_patch",
				kind: patchKind(item.changes),
				status: status(phase === "started" ? "running" : "completed"),
				...base,
				input: toJson(
					Array.isArray(item.changes)
						? item.changes.map((change) =>
								isRecord(change)
									? { path: change.path, kind: change.kind }
									: change,
							)
						: null,
				),
			};
		case "mcpToolCall": {
			const server = str(item.server) ?? "unknown";
			const tool = str(item.tool) ?? "unknown";
			const name = mcpPrefixedToolName(server, tool);
			const text = mcpResultText(item.result);
			const error = isRecord(item.error) ? str(item.error.message) : undefined;
			return {
				type: "tool_call",
				name,
				kind:
					mcpKinds[name] ??
					mcpKinds[tool] ??
					(item.readOnlyHint === true ? "read" : "other"),
				status: status(phase === "started" ? "running" : "completed"),
				...base,
				input: toJson(item.arguments ?? null),
				...(phase === "completed"
					? text !== undefined
						? { output: clip(text) }
						: error !== undefined
							? { output: toJson({ error }) }
							: {}
					: {}),
			};
		}
		case "dynamicToolCall":
			return {
				type: "tool_call",
				name: str(item.tool) ?? "dynamic_tool",
				kind: "other",
				status: status(phase === "started" ? "running" : "completed"),
				...base,
				input: toJson(item.arguments ?? null),
			};
		case "webSearch":
			return {
				type: "tool_call",
				name: "web_search",
				kind: "fetch",
				status: phase === "started" ? "running" : "completed",
				...base,
				input: toJson({
					query: item.query ?? null,
					action: item.action ?? null,
				}),
			};
		case "imageView":
			return {
				type: "tool_call",
				name: "view_image",
				kind: "read",
				status: phase === "started" ? "running" : "completed",
				...base,
				input: toJson({ path: item.path ?? null }),
			};
		case "collabAgentToolCall":
			return {
				type: "tool_call",
				name: `collab_${str(item.tool) ?? "agent"}`,
				kind: "other",
				status: status(phase === "started" ? "running" : "completed"),
				...base,
			};
		default:
			return undefined;
	}
}

export interface TurnOutcome {
	readonly id?: string;
	readonly status: "completed" | "failed" | "interrupted" | string;
	readonly error?: {
		readonly message?: string;
		readonly codexErrorInfo?: unknown;
		readonly additionalDetails?: string | null;
	} | null;
}

/**
 * Stateful per-turn normalizer. `push` returns the events one notification produces;
 * `finish` produces the terminal pair (usage + completed/failed) for a finished turn.
 */
export class CodexTurnNormalizer {
	private finalText: string | undefined;
	private finalPhase = false;
	private readonly agentText = new Map<string, string>();
	/**
	 * Per-turn usage: `thread/resume` replays the previous turn's token notification, so the
	 * thread total is attributed to the turn that reported it (keyed by `turnId`).
	 */
	private readonly usageByTurn = new Map<
		string,
		{ baseline: TokenBreakdown; latest: TokenBreakdown }
	>();
	private lastUsageTurn: string | undefined;
	private lastError:
		| { message: string; codexErrorInfo: unknown; raw: JsonValue }
		| undefined;

	constructor(
		private readonly mcpKinds: Readonly<Record<string, ToolKind>> = {},
	) {}

	push(method: string, params: unknown): ExecEvent[] {
		if (!isRecord(params)) return [];
		switch (method) {
			case "item/agentMessage/delta": {
				const delta = str(params.delta);
				const itemId = str(params.itemId);
				if (delta === undefined || delta === "") return [];
				if (itemId !== undefined)
					this.agentText.set(
						itemId,
						(this.agentText.get(itemId) ?? "") + delta,
					);
				return [{ type: "message_delta", text: delta }];
			}
			case "item/started":
			case "item/completed": {
				const item = params.item;
				if (!isRecord(item)) return [];
				const phase = method === "item/started" ? "started" : "completed";
				if (item.type === "agentMessage" && phase === "completed") {
					const text = str(item.text) ?? "";
					const isFinal = item.phase === "final_answer";
					// Prefer the final_answer message; otherwise the last message wins.
					if (isFinal || !this.finalPhase) {
						this.finalText = text;
						if (isFinal) this.finalPhase = true;
					}
					return [];
				}
				const event = toolCallFromItem(item as Item, phase, this.mcpKinds);
				return event === undefined ? [] : [event];
			}
			case "thread/tokenUsage/updated": {
				const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
				const total = isRecord(usage.total)
					? (usage.total as TokenBreakdown)
					: undefined;
				const last = isRecord(usage.last)
					? (usage.last as TokenBreakdown)
					: undefined;
				if (total === undefined) return [];
				const turnId = str(params.turnId) ?? "";
				const entry = this.usageByTurn.get(turnId);
				if (entry === undefined)
					this.usageByTurn.set(turnId, {
						baseline: subtract(total, last),
						latest: total,
					});
				else entry.latest = total;
				this.lastUsageTurn = turnId;
				return [];
			}
			case "error": {
				if (params.willRetry === true) return [];
				const error = isRecord(params.error) ? params.error : {};
				this.lastError = {
					message: str(error.message) ?? "codex error",
					codexErrorInfo: error.codexErrorInfo ?? null,
					raw: toJson(params),
				};
				return [];
			}
			default:
				return [];
		}
	}

	/** Usage for a turn (delta over the thread total), or undefined when none was reported. */
	usage(turnId?: string): UsageEvent | undefined {
		const entry = this.usageByTurn.get(turnId ?? this.lastUsageTurn ?? "");
		if (entry === undefined) return undefined;
		const turn = subtract(entry.latest, entry.baseline);
		return {
			type: "usage",
			input: count(turn.inputTokens),
			output: count(turn.outputTokens),
			cached: count(turn.cachedInputTokens),
			cost: null,
			source: "unknown",
		};
	}

	/** Terminal events for a `turn/completed` notification. */
	finish(
		turn: TurnOutcome,
		options: {
			readonly cancelled?: boolean;
			readonly ownedSession?: { kind: string; locator: string };
		} = {},
	): ExecEvent[] {
		const events: ExecEvent[] = [];
		const usage = this.usage(turn.id);
		if (usage !== undefined) events.push(usage);
		const owned =
			options.ownedSession === undefined
				? {}
				: { ownedSession: options.ownedSession };
		if (turn.status === "completed") {
			const fallback = [...this.agentText.values()].at(-1) ?? "";
			events.push({
				type: "completed",
				finalText: this.finalText ?? fallback,
				...owned,
			});
			return events;
		}
		if (turn.status === "interrupted" || options.cancelled === true) {
			events.push({
				type: "failed",
				class: "cancelled",
				message:
					turn.status === "interrupted"
						? "turn interrupted (cancel requested)"
						: `turn ${turn.status} after a cancel request`,
				raw: toJson(turn),
				...owned,
			});
			return events;
		}
		const message =
			str(turn.error?.message) ??
			this.lastError?.message ??
			`turn ${turn.status}`;
		const info = turn.error?.codexErrorInfo ?? this.lastError?.codexErrorInfo;
		events.push({
			type: "failed",
			class: classifyCodexFailure({ message, codexErrorInfo: info }),
			message,
			raw: toJson({ turn, lastError: this.lastError?.raw ?? null }),
			...owned,
		});
		return events;
	}

	/** Last non-retried `error` notification (for failures that end the process instead). */
	get pendingError(): { message: string; codexErrorInfo: unknown } | undefined {
		return this.lastError;
	}
}

function subtract(
	a: TokenBreakdown,
	b: TokenBreakdown | undefined,
): TokenBreakdown {
	if (b === undefined) return a;
	const diff = (x: number | undefined, y: number | undefined) =>
		typeof x === "number"
			? Math.max(0, x - (typeof y === "number" ? y : 0))
			: undefined;
	return {
		totalTokens: diff(a.totalTokens, b.totalTokens),
		inputTokens: diff(a.inputTokens, b.inputTokens),
		cachedInputTokens: diff(a.cachedInputTokens, b.cachedInputTokens),
		outputTokens: diff(a.outputTokens, b.outputTokens),
	};
}

function count(value: number | undefined): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

/** Convenience for failures outside a turn (process exit, JSON-RPC error). */
export function failureEvent(
	message: string,
	failureClass: FailureClass,
	raw: unknown,
	ownedSession?: { kind: string; locator: string },
): ExecEvent {
	return {
		type: "failed",
		class: failureClass,
		message,
		raw: toJson(raw),
		...(ownedSession === undefined ? {} : { ownedSession }),
	};
}
