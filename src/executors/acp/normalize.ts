/**
 * ACP v1 `session/update` notifications and the `session/prompt` response → SDK events.
 * - `agent_message_chunk` text → `message_delta`; the answer is their concatenation for the prompt.
 * - `tool_call` / `tool_call_update` → `tool_call` (ACP kinds are our kinds; statuses mapped).
 *   Input/output are `rawInput`/`rawOutput` when the agent sends them; otherwise the display
 *   fields (title, locations, text content). Gemini sends display text only (design note D6).
 * - usage from the prompt response; the stop reason decides the terminal event.
 * The same class replays a recorded raw log (agent → client lines), so another process sees the
 * same events.
 */
import type { FailureClass } from "../../sdk/errors.js";
import type {
	ExecEvent,
	OwnedSession,
	ToolCallEvent,
	ToolKind,
	ToolStatus,
} from "../../sdk/events.js";
import { isJsonValue, type JsonValue } from "../../sdk/json.js";

const TOOL_KINDS: ReadonlySet<string> = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
]);

export function acpToolKind(kind: unknown): ToolKind {
	return typeof kind === "string" && TOOL_KINDS.has(kind)
		? (kind as ToolKind)
		: "other";
}

const STATUS: Readonly<Record<string, ToolStatus>> = {
	pending: "pending",
	in_progress: "running",
	completed: "completed",
	failed: "failed",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "content" && isRecord(item.content)) {
			if (item.content.type === "text" && typeof item.content.text === "string")
				parts.push(item.content.text);
		} else if (item.type === "diff" && typeof item.path === "string")
			parts.push(`diff ${item.path}`);
		else if (item.type === "terminal" && typeof item.terminalId === "string")
			parts.push(`terminal ${item.terminalId}`);
	}
	return parts.join("\n");
}

interface ToolState {
	name: string;
	kind: ToolKind;
	status: ToolStatus;
	input?: JsonValue;
	output?: JsonValue;
	denied: boolean;
}

export interface AcpPromptOutcome {
	readonly stopReason: string | null;
	readonly usage?: unknown;
	readonly error?: string;
}

export interface AcpExitInfo {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly cancelled: boolean;
	readonly stderr: string;
	readonly spawnError?: string;
}

export class AcpEventNormalizer {
	private readonly tools = new Map<string, ToolState>();
	private text = "";
	private outcome: AcpPromptOutcome | undefined;
	private readonly ownedSession: OwnedSession | undefined;
	/** Raw tool input/output were present on at least one tool report. */
	rawToolFields = false;
	toolReports = 0;

	constructor(options: { readonly ownedSession?: OwnedSession } = {}) {
		this.ownedSession = options.ownedSession;
	}

	/** One `session/update` notification's params. */
	update(params: unknown): ExecEvent[] {
		if (!isRecord(params) || !isRecord(params.update)) return [];
		const update = params.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const content = update.content;
				if (
					isRecord(content) &&
					content.type === "text" &&
					typeof content.text === "string" &&
					content.text !== ""
				) {
					this.text += content.text;
					return [{ type: "message_delta", text: content.text }];
				}
				return [];
			}
			case "tool_call":
			case "tool_call_update":
				return this.tool(update);
			default:
				return [];
		}
	}

	/** A permission request rejected by the engine: the tool's later reports say `denied`. */
	markDenied(toolCallId: string | undefined): void {
		if (toolCallId === undefined) return;
		const state = this.tools.get(toolCallId);
		if (state !== undefined) state.denied = true;
		else
			this.tools.set(toolCallId, {
				name: "unknown",
				kind: "other",
				status: "denied",
				denied: true,
			});
	}

	private tool(update: Record<string, unknown>): ExecEvent[] {
		const callId =
			typeof update.toolCallId === "string" ? update.toolCallId : undefined;
		if (callId === undefined) return [];
		this.toolReports += 1;
		const known = this.tools.get(callId);
		const state: ToolState = known ?? {
			name: "unknown",
			kind: "other",
			status: "pending",
			denied: false,
		};
		if (typeof update.title === "string" && update.title !== "")
			state.name = update.title;
		if (update.kind !== undefined) state.kind = acpToolKind(update.kind);
		if (
			typeof update.status === "string" &&
			STATUS[update.status] !== undefined
		)
			state.status = STATUS[update.status] as ToolStatus;
		if (update.rawInput !== undefined && isJsonValue(update.rawInput)) {
			state.input = update.rawInput as JsonValue;
			this.rawToolFields = true;
		} else if (state.input === undefined) {
			const locations = Array.isArray(update.locations)
				? update.locations.filter(isRecord).map((l) => ({
						path: typeof l.path === "string" ? l.path : null,
						...(typeof l.line === "number" ? { line: l.line } : {}),
					}))
				: [];
			state.input = {
				title: state.name,
				...(locations.length > 0 ? { locations } : {}),
			};
		}
		if (update.rawOutput !== undefined && isJsonValue(update.rawOutput)) {
			state.output = update.rawOutput as JsonValue;
			this.rawToolFields = true;
		} else if (update.content !== undefined) {
			const text = contentText(update.content);
			if (text !== "") state.output = text;
		}
		this.tools.set(callId, state);
		const status: ToolStatus =
			state.denied && state.status !== "completed" ? "denied" : state.status;
		const event: ToolCallEvent = {
			type: "tool_call",
			name: state.name,
			kind: state.kind,
			status,
			callId,
			...(state.input === undefined ? {} : { input: state.input }),
			...(status === "completed" || status === "failed" || status === "denied"
				? state.output === undefined
					? {}
					: { output: state.output }
				: {}),
		};
		return [event];
	}

	/** The `session/prompt` result (or its failure). Returns the usage event, if any. */
	prompt(outcome: AcpPromptOutcome): ExecEvent[] {
		this.outcome = outcome;
		const usage = isRecord(outcome.usage) ? outcome.usage : undefined;
		if (usage === undefined) return [];
		const num = (key: string): number | null =>
			typeof usage[key] === "number" && Number.isFinite(usage[key] as number)
				? (usage[key] as number)
				: null;
		const input = num("inputTokens");
		const cached = num("cachedReadTokens");
		const output = num("outputTokens");
		const thought = num("thoughtTokens");
		if (input === null && output === null) return [];
		return [
			{
				type: "usage",
				// Gemini's inputTokens is promptTokenCount, which includes cached tokens; ours excludes them.
				input: input === null ? null : Math.max(0, input - (cached ?? 0)),
				cached,
				...(num("cachedWriteTokens") === null
					? {}
					: { cacheWrite: num("cachedWriteTokens") }),
				// Ours includes reasoning; Gemini reports thoughts separately.
				output: output === null ? null : output + (thought ?? 0),
				cost: null,
				source: "unknown",
			},
		];
	}

	/** Exactly one terminal event, once the prompt settled and the agent process ended. */
	finish(exit: AcpExitInfo): ExecEvent {
		const owned =
			this.ownedSession === undefined
				? {}
				: { ownedSession: this.ownedSession };
		const stderrTail = exit.stderr.slice(-4_000);
		const raw = (message: string): JsonValue => ({
			exitCode: exit.exitCode,
			signal: exit.signal,
			stopReason: this.outcome?.stopReason ?? null,
			stderrTail,
			message,
		});
		const failed = (
			failureClass: FailureClass,
			message: string,
		): ExecEvent => ({
			type: "failed",
			class: failureClass,
			message,
			raw: raw(message),
			...owned,
		});
		const stop = this.outcome?.stopReason ?? null;
		if (exit.cancelled || stop === "cancelled")
			return failed("cancelled", "cancelled by request");
		if (exit.spawnError !== undefined)
			return failed("config", `agent could not start: ${exit.spawnError}`);
		if (stop === "end_turn")
			return { type: "completed", finalText: this.text, ...owned };
		if (
			stop === "max_tokens" ||
			stop === "max_turn_requests" ||
			stop === "refusal"
		)
			return failed("permanent", `agent stopped: ${stop}`);
		const message =
			this.outcome?.error ??
			(stderrTail.trim() ||
				`agent exited ${exit.signal ?? exit.exitCode} without a prompt result`);
		return failed(classifyAcpFailure(message), message);
	}
}

/** First match wins; else `unknown`. */
export function classifyAcpFailure(message: string): FailureClass {
	const text = message.toLowerCase();
	if (
		/auth|login|credential|api key|unauthori[sz]ed|\b401\b|\b403\b/.test(text)
	)
		return "auth";
	if (/rate.?limit|quota|resource_exhausted|\b429\b/.test(text))
		return "rate_limit";
	if (
		/model .*not found|unknown (option|argument)|invalid (model|option)|enoent/.test(
			text,
		)
	)
		return "config";
	if (/timed? ?out|econnreset|socket hang up|temporar/.test(text))
		return "transient";
	return "unknown";
}

/**
 * Events of a recorded raw log (agent → client JSON lines). The prompt result is the response that
 * carries a `stopReason`; without one the attempt's end is unknown to this process.
 */
export function replayAcpLog(
	lines: readonly string[],
	options: {
		readonly ownedSession?: OwnedSession;
		readonly sessionId?: string | null;
	} = {},
): { events: ExecEvent[]; settled: boolean } {
	const normalizer = new AcpEventNormalizer(options);
	const events: ExecEvent[] = [
		{ type: "started", sessionId: options.sessionId ?? null },
	];
	let settled = false;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (message.method === "session/update")
			events.push(...normalizer.update(message.params));
		else if (
			isRecord(message.result) &&
			typeof message.result.stopReason === "string"
		) {
			events.push(
				...normalizer.prompt({
					stopReason: message.result.stopReason,
					usage: message.result.usage,
				}),
			);
			settled = true;
		}
	}
	if (settled)
		events.push(
			normalizer.finish({
				exitCode: 0,
				signal: null,
				cancelled: false,
				stderr: "",
			}),
		);
	return { events, settled };
}
