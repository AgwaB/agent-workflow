// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/runners/headless-model.ts
// (`PiJsonStreamParser`, `parsePiJsonLine`, `textFromContent`, `errorText`). MIT, same author.
// Changes: the parser yields normalized SDK `ExecEvent`s (plan §2.3) instead of a result envelope:
// `text_delta` → `message_delta`, `tool_execution_*` → `tool_call` with ACP kind and status, each
// assistant `message_end` → one `usage` (per request, so the runtime's sum is the run total, as the
// original `message_end` accumulation), and the process exit → exactly one terminal event. Pi's
// usage cost is computed by Pi from its model catalog, so it is reported as `estimated`; a zero
// cost is reported as unknown (`cost: null`, never 0), because Pi cannot tell a free model from an
// unpriced one. WP12a: usage carries `cacheWrite` and the assistant message's `model`.
import { StringDecoder } from "node:string_decoder";
import type { FailureClass } from "../../sdk/errors.js";
import type {
	ExecEvent,
	OwnedSession,
	ToolCallEvent,
	UsageEvent,
} from "../../sdk/events.js";
import type { JsonValue } from "../../sdk/json.js";
import { isJsonValue } from "../../sdk/json.js";
import { piToolKind } from "./argv.js";
import { classifyPiFailure } from "./errors.js";

/** Pi JSON lines larger than this are skipped (pi-subagent MAX_JSON_LINE_CHARS). */
export const MAX_JSON_LINE_CHARS = 64 * 1024 * 1024;
/** Tool output kept in a normalized `tool_call` event (the raw stream keeps everything). */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const STDERR_TAIL_CHARS = 4000;

/**
 * Strict JSONL framing (Pi 1.1 `docs/json.md`): split on LF only, strip one preceding CR. Unicode
 * line separators stay inside records (Node `readline` would split on them).
 */
export class PiJsonlSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private buffered = "";
	private discarding = false;
	oversized = 0;

	push(chunk: Buffer | string): string[] {
		let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		while (text.length > 0) {
			const newline = text.indexOf("\n");
			if (this.discarding) {
				if (newline < 0) return lines;
				this.discarding = false;
				this.buffered = "";
				text = text.slice(newline + 1);
				continue;
			}
			this.buffered += newline < 0 ? text : text.slice(0, newline);
			text = newline < 0 ? "" : text.slice(newline + 1);
			if (this.buffered.length > MAX_JSON_LINE_CHARS) {
				this.oversized += 1;
				this.buffered = "";
				this.discarding = newline < 0;
				continue;
			}
			if (newline >= 0) {
				lines.push(this.buffered.replace(/\r$/u, ""));
				this.buffered = "";
			}
		}
		return lines;
	}

	finish(): string[] {
		const rest = this.decoder.end();
		const lines = rest.length > 0 ? this.push(rest) : [];
		if (!this.discarding && this.buffered.length > 0)
			lines.push(this.buffered.replace(/\r$/u, ""));
		this.buffered = "";
		return lines;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			isRecord(part) && part.type === "text" && typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

function errorText(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value)) {
		if (typeof value.message === "string" && value.message.length > 0)
			return value.message;
		if (typeof value.error === "string" && value.error.length > 0)
			return value.error;
	}
	return undefined;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

/**
 * One `usage` event for one assistant request. Exported for tests. Pi's `input` already excludes
 * cache reads and writes (pi-ai normalizes every provider), so it is the SDK `input` as is;
 * `cacheRead` → `cached`, `cacheWrite` → `cacheWrite`; `model` is the assistant message's model.
 */
export function usageFromPi(
	usage: unknown,
	model?: unknown,
): UsageEvent | undefined {
	if (!isRecord(usage)) return undefined;
	const input = count(usage.input);
	const output = count(usage.output);
	const cached = count(usage.cacheRead);
	const cacheWrite =
		usage.cacheWrite === undefined ? undefined : count(usage.cacheWrite);
	const total =
		count(usage.totalTokens) ??
		(input ?? 0) + (output ?? 0) + (cached ?? 0) + (cacheWrite ?? 0);
	const costTotal = isRecord(usage.cost) ? usage.cost.total : undefined;
	if (total === 0) return undefined;
	const cost =
		typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal > 0
			? costTotal
			: null;
	return {
		type: "usage",
		input,
		output,
		cached,
		...(cacheWrite === undefined ? {} : { cacheWrite }),
		...(typeof model === "string" && model.trim() !== "" ? { model } : {}),
		cost,
		source: cost === null ? "unknown" : "estimated",
	};
}

function toolOutput(result: unknown): JsonValue | undefined {
	if (result === undefined) return undefined;
	const text = isRecord(result)
		? textFromContent(result.content)
		: typeof result === "string"
			? result
			: "";
	if (text.length === 0)
		return isJsonValue(result) ? (result as JsonValue) : undefined;
	return text.length > MAX_TOOL_OUTPUT_CHARS
		? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[agent-workflow: ${text.length - MAX_TOOL_OUTPUT_CHARS} more chars in the raw Pi stream]`
		: text;
}

export interface PiExitInfo {
	readonly exitCode: number | null;
	readonly signal: string | null;
	/** The engine asked to cancel this attempt. */
	readonly cancelled: boolean;
	readonly stderr: string;
}

export interface PiNormalizerOptions {
	readonly sessionId: string | null;
	/** Session the adapter kept (D3, R#10); reported on the terminal event. */
	readonly ownedSession?: OwnedSession;
}

/** Stateful Pi JSON event → SDK event mapper for one attempt. */
export class PiEventNormalizer {
	private readonly options: PiNormalizerOptions;
	private lastAssistant: Record<string, unknown> | undefined;
	private finalText = "";
	private settledAborted = false;
	private readonly streamErrors: string[] = [];
	parseErrors = 0;
	piSessionId: string | null = null;
	provider: string | null = null;
	model: string | null = null;

	constructor(options: PiNormalizerOptions) {
		this.options = options;
	}

	started(): ExecEvent {
		return { type: "started", sessionId: this.options.sessionId };
	}

	/** Map one raw JSONL record. Non-JSON lines are counted, never fatal. */
	line(raw: string): ExecEvent[] {
		if (raw.trim().length === 0) return [];
		let event: unknown;
		try {
			event = JSON.parse(raw);
		} catch {
			this.parseErrors += 1;
			return [];
		}
		if (!isRecord(event)) return [];
		switch (event.type) {
			case "session":
				if (typeof event.id === "string") this.piSessionId = event.id;
				return [];
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (
					isRecord(update) &&
					update.type === "text_delta" &&
					typeof update.delta === "string" &&
					update.delta.length > 0
				)
					return [{ type: "message_delta", text: update.delta }];
				return [];
			}
			case "tool_execution_start":
				return [this.toolEvent(event, "running")];
			case "tool_execution_end":
				return [
					this.toolEvent(
						event,
						event.isError === true ? "failed" : "completed",
					),
				];
			case "message_end": {
				const message = event.message;
				if (!isRecord(message) || message.role !== "assistant") return [];
				this.lastAssistant = message;
				this.finalText = textFromContent(message.content);
				if (typeof message.provider === "string")
					this.provider = message.provider;
				if (typeof message.model === "string") this.model = message.model;
				if (message.stopReason === "error")
					this.streamErrors.push(
						errorText(message.errorMessage) ??
							errorText(message.error) ??
							"assistant stopped with an error",
					);
				const usage = usageFromPi(message.usage, message.model);
				return usage === undefined ? [] : [usage];
			}
			case "agent_end": {
				// Fallback (ported): the last assistant text of the run when no message_end carried one.
				if (this.finalText.length === 0 && Array.isArray(event.messages))
					for (const message of event.messages)
						if (isRecord(message) && message.role === "assistant") {
							const text = textFromContent(message.content);
							if (text.length > 0) this.finalText = text;
						}
				return [];
			}
			case "agent_settled":
				this.settledAborted = event.aborted === true;
				return [];
			case "auto_retry_end":
				if (event.success === false && typeof event.finalError === "string")
					this.streamErrors.push(event.finalError);
				return [];
			case "error": {
				const text = errorText(event.error) ?? errorText(event.message);
				if (text !== undefined) this.streamErrors.push(text);
				return [];
			}
			default:
				return [];
		}
	}

	private toolEvent(
		event: Record<string, unknown>,
		status: ToolCallEvent["status"],
	): ToolCallEvent {
		const name =
			typeof event.toolName === "string" && event.toolName !== ""
				? event.toolName
				: "unknown";
		const input =
			event.args !== undefined && isJsonValue(event.args)
				? (event.args as JsonValue)
				: undefined;
		const output =
			status === "running" ? undefined : toolOutput(event.result ?? undefined);
		return {
			type: "tool_call",
			name,
			kind: piToolKind(name),
			status,
			...(typeof event.toolCallId === "string"
				? { callId: event.toolCallId }
				: {}),
			...(input === undefined ? {} : { input }),
			...(output === undefined ? {} : { output }),
		};
	}

	/** Exactly one terminal event for the process exit. */
	finish(exit: PiExitInfo): ExecEvent {
		const owned =
			this.options.ownedSession === undefined
				? {}
				: { ownedSession: this.options.ownedSession };
		const stderrTail = exit.stderr.slice(-STDERR_TAIL_CHARS);
		const stopReason =
			typeof this.lastAssistant?.stopReason === "string"
				? this.lastAssistant.stopReason
				: null;
		const raw = (message: string): JsonValue => ({
			exitCode: exit.exitCode,
			signal: exit.signal,
			stopReason,
			streamErrors: this.streamErrors.slice(-5),
			stderrTail,
			parseErrors: this.parseErrors,
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
		if (exit.cancelled) return failed("cancelled", "cancelled by request");
		if (stopReason === "error") {
			const message =
				this.streamErrors.at(-1) ?? "assistant stopped with an error";
			return failed(classifyPiFailure(message, exit.exitCode), message);
		}
		if (stopReason === "aborted" || this.settledAborted)
			return failed(
				"unknown",
				`pi aborted the run${this.streamErrors.length > 0 ? `: ${this.streamErrors.at(-1)}` : ""}`,
			);
		if (exit.exitCode !== 0 || exit.signal !== null) {
			const message =
				stderrTail.trim() ||
				this.streamErrors.at(-1) ||
				`pi exited ${exit.signal ?? exit.exitCode}`;
			return failed(classifyPiFailure(message, exit.exitCode), message);
		}
		if (this.lastAssistant === undefined)
			return failed(
				"unknown",
				this.parseErrors > 0
					? `pi produced no assistant message (${this.parseErrors} unparsable lines)`
					: "pi produced no assistant message",
			);
		return { type: "completed", finalText: this.finalText, ...owned };
	}
}
