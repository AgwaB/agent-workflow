/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages` → normalized
 * `ExecEvent`s (plan §2.3). Written for the line shapes recorded from claude-code 2.1.310
 * (test/fixtures/executors/claude/transcripts); patterns follow vibe-kanban `claude.rs` and
 * ai-sdk-provider-claude-code (read for structure only, no code copied).
 *
 * | stream-json line | normalized |
 * |---|---|
 * | `system/init` | `started{sessionId}` (an injected MCP server reported `failed` ⇒ `failed{config}`) |
 * | `stream_event` `content_block_delta/text_delta` | `message_delta{text}` |
 * | `assistant` text (only when that message was not streamed) | `message_delta{text}` |
 * | `assistant` `tool_use` / `server_tool_use` | `tool_call{status: running, input}` |
 * | `user` `tool_result` / `*_tool_result` | `tool_call{status: completed|failed|denied, output}` |
 * | `control_request can_use_tool` | `approval_request{requestId, kind, detail}` |
 * | `system/permission_denied` | marks the call denied |
 * | `result` (success, not `is_error`) | `usage{…, cost: total_cost_usd, source: reported}` + `completed{finalText}` |
 * | `result` (`is_error` / error subtype) | `usage` unknown + `failed{class}` (`cancelled` after our interrupt) |
 * | exit without `result` | `failed{class from stderr/exit code}` |
 *
 * `assistant` messages with model `<synthetic>` (CLI-generated error text) are not model output and
 * are skipped. Interrupted and errored results report zero usage although tokens were spent, so their
 * usage is `unknown` (never 0).
 */
import type { FailureClass } from "../../sdk/errors.js";
import type {
	ExecEvent,
	OwnedSession,
	ToolCallEvent,
	ToolStatus,
} from "../../sdk/events.js";
import { isJsonValue, type JsonValue } from "../../sdk/json.js";
import { classifyClaudeFailure, claudeFailureText } from "./errors.js";
import { claudeToolKind } from "./tools.js";

/** Cap for tool inputs/outputs carried on events (the raw stream keeps everything). */
export const EVENT_PAYLOAD_CAP_CHARS = 65_536;

export interface CanUseToolRequest {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolUseId: string | null;
	/** Tool input exactly as the CLI sent it (echoed back as `updatedInput` on allow). */
	readonly input: unknown;
}

export type ParserAction =
	| { readonly type: "approval"; readonly request: CanUseToolRequest }
	/** A control request the adapter does not serve: answer it with an error so the CLI never waits. */
	| {
			readonly type: "unsupported_control";
			readonly requestId: string;
			readonly subtype: string;
	  }
	/** The turn ended; end stdin so the CLI exits. */
	| { readonly type: "result" };

export interface ParserOptions {
	/** True once the adapter asked the CLI to stop (interrupt or kill). */
	readonly cancelRequested?: () => boolean;
	/** Session the adapter keeps for this attempt (reported on the terminal event, D3/R#10). */
	readonly ownedSession?: OwnedSession;
	/** Injected MCP server names (a `failed` status at init fails the attempt). */
	readonly mcpServers?: readonly string[];
}

export interface ExitInfo {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stderr: string;
	readonly spawnError?: string;
}

type Json = { [key: string]: unknown };

const isObject = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: 0;

function capText(text: string): string {
	return text.length <= EVENT_PAYLOAD_CAP_CHARS
		? text
		: `${text.slice(0, EVENT_PAYLOAD_CAP_CHARS)}…[truncated ${text.length - EVENT_PAYLOAD_CAP_CHARS} chars; full text in the raw stream]`;
}

function capJson(value: unknown): JsonValue {
	if (!isJsonValue(value)) return null;
	const text = JSON.stringify(value);
	return text.length <= EVENT_PAYLOAD_CAP_CHARS
		? value
		: { truncated: true, preview: capText(text) };
}

/** Text of a `tool_result` content (string or content blocks). */
export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content))
		return content === undefined ? "" : JSON.stringify(content);
	return content
		.map((block) =>
			isObject(block) && typeof block.text === "string"
				? block.text
				: isObject(block)
					? `[${String(block.type ?? "block")}]`
					: String(block),
		)
		.join("");
}

function approvalDetail(toolName: string, input: unknown): string {
	if (isObject(input)) {
		for (const key of [
			"command",
			"file_path",
			"path",
			"url",
			"query",
			"pattern",
		])
			if (typeof input[key] === "string")
				return `${toolName}: ${(input[key] as string).slice(0, 500)}`;
	}
	const text = JSON.stringify(input ?? null);
	return `${toolName}: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`;
}

/** Stateful line parser for one attempt. Emits through `emit`; returns actions for the adapter. */
export class ClaudeStreamParser {
	private readonly emit: (event: ExecEvent) => void;
	private readonly options: ParserOptions;
	private emittedStarted = false;
	private terminal = false;
	private readonly streamedMessages = new Set<string>();
	private readonly toolNames = new Map<string, string>();
	private readonly denied = new Set<string>();
	private readonly texts: string[] = [];
	/** Model reported by `system/init` (alias resolution, e.g. `haiku` → `claude-haiku-5-5`). */
	model: string | null = null;
	sessionId: string | null = null;

	constructor(emit: (event: ExecEvent) => void, options: ParserOptions = {}) {
		this.emit = emit;
		this.options = options;
	}

	get done(): boolean {
		return this.terminal;
	}

	/** Mark a tool call as denied (the adapter answered its approval `deny`). */
	markDenied(toolUseId: string | null): void {
		if (toolUseId !== null) this.denied.add(toolUseId);
	}

	private out(event: ExecEvent): void {
		if (this.terminal) return;
		if (event.type === "started") {
			if (this.emittedStarted) return;
			this.emittedStarted = true;
			this.emit(event);
			return;
		}
		if (!this.emittedStarted) {
			this.emittedStarted = true;
			this.emit({ type: "started", sessionId: this.sessionId });
		}
		if (event.type === "completed" || event.type === "failed")
			this.terminal = true;
		this.emit(event);
	}

	private fail(cls: FailureClass, message: string, raw: JsonValue): void {
		const owned = this.options.ownedSession;
		this.out({
			type: "failed",
			class: cls,
			message,
			raw,
			...(owned === undefined ? {} : { ownedSession: owned }),
		});
	}

	line(line: string): ParserAction[] {
		if (this.terminal || line.trim() === "") return [];
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return [];
		}
		if (!isObject(message)) return [];
		switch (message.type) {
			case "system":
				return this.system(message);
			case "stream_event":
				this.streamEvent(message);
				return [];
			case "assistant":
				this.assistant(message);
				return [];
			case "user":
				this.user(message);
				return [];
			case "control_request":
				return this.controlRequest(message);
			case "result":
				this.result(message);
				return [{ type: "result" }];
			default:
				return [];
		}
	}

	private system(message: Json): ParserAction[] {
		if (message.subtype === "init") {
			this.sessionId = str(message.session_id);
			this.model = str(message.model);
			this.out({ type: "started", sessionId: this.sessionId });
			const wanted = new Set(this.options.mcpServers ?? []);
			const servers = Array.isArray(message.mcp_servers)
				? message.mcp_servers
				: [];
			for (const server of servers)
				if (
					isObject(server) &&
					typeof server.name === "string" &&
					wanted.has(server.name) &&
					(server.status === "failed" || server.status === "needs-auth")
				)
					this.fail(
						"config",
						`mcp server ${server.name} failed to start (status ${String(server.status)})`,
						{ mcpServer: server.name, status: String(server.status) },
					);
		} else if (message.subtype === "permission_denied") {
			const id = str(message.tool_use_id);
			if (id !== null) this.denied.add(id);
		}
		return [];
	}

	private streamEvent(message: Json): void {
		const event = message.event;
		if (!isObject(event)) return;
		if (event.type === "message_start" && isObject(event.message)) {
			const id = str(event.message.id);
			if (id !== null) this.streamedMessages.add(id);
			return;
		}
		if (message.parent_tool_use_id) return; // subagent stream
		if (
			event.type === "content_block_delta" &&
			isObject(event.delta) &&
			event.delta.type === "text_delta" &&
			typeof event.delta.text === "string" &&
			event.delta.text !== ""
		) {
			const id = str(message.api_message_id);
			if (id !== null) this.streamedMessages.add(id);
			this.texts.push(event.delta.text);
			this.out({ type: "message_delta", text: event.delta.text });
		}
	}

	private assistant(message: Json): void {
		const body = message.message;
		if (!isObject(body) || !Array.isArray(body.content)) return;
		if (body.model === "<synthetic>") return;
		const streamed =
			typeof body.id === "string" && this.streamedMessages.has(body.id);
		for (const block of body.content) {
			if (!isObject(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				if (!streamed && !message.parent_tool_use_id && block.text !== "") {
					this.texts.push(block.text);
					this.out({ type: "message_delta", text: block.text });
				}
			} else if (
				(block.type === "tool_use" || block.type === "server_tool_use") &&
				typeof block.name === "string" &&
				typeof block.id === "string"
			) {
				this.toolNames.set(block.id, block.name);
				this.out({
					type: "tool_call",
					name: block.name,
					kind: claudeToolKind(block.name),
					status: "running",
					callId: block.id,
					input: capJson(block.input ?? null),
				});
			} else if (
				typeof block.type === "string" &&
				block.type.endsWith("_tool_result") &&
				typeof block.tool_use_id === "string"
			) {
				// Server-side tool results (web search) arrive inside the assistant message.
				this.toolResult(
					block.tool_use_id,
					block.content,
					block.is_error === true,
				);
			}
		}
	}

	private user(message: Json): void {
		const body = message.message;
		if (!isObject(body) || !Array.isArray(body.content)) return;
		for (const block of body.content)
			if (
				isObject(block) &&
				block.type === "tool_result" &&
				typeof block.tool_use_id === "string"
			)
				this.toolResult(
					block.tool_use_id,
					block.content,
					block.is_error === true,
				);
	}

	private toolResult(callId: string, content: unknown, isError: boolean): void {
		const name = this.toolNames.get(callId) ?? "unknown";
		const status: ToolStatus = isError
			? this.denied.has(callId)
				? "denied"
				: "failed"
			: "completed";
		const event: ToolCallEvent = {
			type: "tool_call",
			name,
			kind: claudeToolKind(name),
			status,
			callId,
			output: capText(toolResultText(content)),
		};
		this.out(event);
	}

	private controlRequest(message: Json): ParserAction[] {
		const requestId = str(message.request_id);
		const request = message.request;
		if (requestId === null || !isObject(request)) return [];
		if (
			request.subtype === "can_use_tool" &&
			typeof request.tool_name === "string"
		) {
			const toolUseId = str(request.tool_use_id);
			this.out({
				type: "approval_request",
				requestId,
				kind: claudeToolKind(request.tool_name),
				detail: approvalDetail(request.tool_name, request.input),
			});
			return [
				{
					type: "approval",
					request: {
						requestId,
						toolName: request.tool_name,
						toolUseId,
						input: request.input ?? null,
					},
				},
			];
		}
		return [
			{
				type: "unsupported_control",
				requestId,
				subtype: String(request.subtype ?? "unknown"),
			},
		];
	}

	private result(message: Json): void {
		const isError = message.is_error === true || message.subtype !== "success";
		const usage = isObject(message.usage) ? message.usage : {};
		const cost =
			typeof message.total_cost_usd === "number" &&
			Number.isFinite(message.total_cost_usd) &&
			message.total_cost_usd >= 0
				? message.total_cost_usd
				: null;
		if (!isError) {
			const input =
				count(usage.input_tokens) +
				count(usage.cache_creation_input_tokens) +
				count(usage.cache_read_input_tokens);
			this.out({
				type: "usage",
				input,
				output: count(usage.output_tokens),
				cached: count(usage.cache_read_input_tokens),
				cost,
				source: cost === null ? "unknown" : "reported",
			});
		} else
			this.out({
				type: "usage",
				input: null,
				output: null,
				cached: null,
				cost: null,
				source: "unknown",
			});
		const resultText = str(message.result);
		if (!isError) {
			const owned = this.options.ownedSession;
			this.out({
				type: "completed",
				finalText: resultText ?? this.texts.join(""),
				...(owned === undefined ? {} : { ownedSession: owned }),
			});
			return;
		}
		const errors = Array.isArray(message.errors)
			? message.errors.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [];
		const input = {
			result: resultText,
			subtype: str(message.subtype),
			apiErrorStatus:
				typeof message.api_error_status === "number"
					? message.api_error_status
					: null,
			terminalReason: str(message.terminal_reason),
			errors,
		};
		const raw: JsonValue = {
			subtype: input.subtype,
			is_error: message.is_error === true,
			terminal_reason: input.terminalReason,
			api_error_status: input.apiErrorStatus,
			result: resultText === null ? null : resultText.slice(0, 2000),
			errors: errors.map((entry) => entry.slice(0, 500)),
		};
		if (this.options.cancelRequested?.() === true) {
			this.fail("cancelled", "cancelled by request (interrupt)", raw);
			return;
		}
		this.fail(
			classifyClaudeFailure(input),
			resultText ??
				(errors.join("; ") || `claude result ${input.subtype ?? "error"}`),
			raw,
		);
	}

	/** Process ended. Emits a terminal event when the stream had none. */
	finish(exit: ExitInfo): void {
		if (this.terminal) return;
		const stderr = exit.stderr.slice(-4000);
		const raw: JsonValue = {
			exitCode: exit.exitCode,
			signal: exit.signal,
			stderr,
			...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
		};
		if (exit.spawnError !== undefined) {
			this.fail(
				"config",
				`claude CLI not found or not executable: ${exit.spawnError}`,
				raw,
			);
			return;
		}
		if (this.options.cancelRequested?.() === true) {
			this.fail("cancelled", "cancelled by request (process stopped)", raw);
			return;
		}
		const message =
			stderr.trim() ||
			`claude exited (code ${String(exit.exitCode)}, signal ${String(exit.signal)}) before a result`;
		this.fail(
			classifyClaudeFailure({ stderr, exitCode: exit.exitCode }),
			message,
			raw,
		);
	}
}

/** Replay a recorded raw stream (fresh-process observe, tests). */
export function parseClaudeStream(
	lines: readonly string[],
	options: ParserOptions & { readonly exit?: ExitInfo } = {},
): ExecEvent[] {
	const events: ExecEvent[] = [];
	const parser = new ClaudeStreamParser((event) => events.push(event), options);
	for (const line of lines) parser.line(line);
	if (options.exit !== undefined) parser.finish(options.exit);
	return events;
}

export { claudeFailureText };
