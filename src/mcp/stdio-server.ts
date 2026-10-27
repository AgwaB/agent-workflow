// New in agent-workflow (WP13; extracted from the WP5 artifact server's stdio.ts): the shared,
// hand-written MCP stdio protocol layer of agent-workflow's MCP servers (the `workflow_artifact`
// server and the `agent-workflow` host server). Messages are newline-delimited UTF-8 JSON-RPC 2.0;
// only protocol goes to `output`, diagnostics go to `log`. Methods: initialize, ping, tools/list,
// tools/call. WP13 additions: server→client requests (`sendRequest`, used for
// `elicitation/create`) with their responses routed back, the client's declared capabilities,
// `notifications/cancelled` (aborts the call's signal; no response is sent for it) and
// `notifications/progress` for calls that carry a progress token.
import type { Readable, Writable } from "node:stream";

import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	JsonRpcError,
	mcpVersionAllowsBatch,
	negotiateMcpProtocolVersion,
} from "./artifact-server/protocol.js";

/** Lines longer than this are rejected with a parse error and discarded. */
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;

export type JsonRpcId = string | number;
type Message = Record<string, unknown>;

/** Per-call context handed to `callTool`. */
export interface McpToolCallContext {
	/** Negotiated protocol revision. */
	protocolVersion: string;
	/** `capabilities` the client declared in `initialize` (empty object when none). */
	clientCapabilities: Record<string, unknown>;
	/** Aborted when the client cancels this call (`notifications/cancelled`) or disconnects. */
	signal: AbortSignal;
	/** `params._meta.progressToken` of the call, when the client asked for progress. */
	progressToken?: JsonRpcId;
	/** Send a server→client request; resolves with its result, rejects with a JsonRpcError. */
	sendRequest(
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<unknown>;
	/** Send a notification (no-op once the server drained). */
	sendNotification(method: string, params: unknown): void;
}

export interface McpStdioServerOptions {
	input: Readable;
	output: Writable;
	log: (message: string) => void;
	serverInfoName: string;
	serverVersion: string;
	instructions: string;
	/** Tool definitions for the negotiated protocol revision. */
	tools: (protocolVersion: string) => Record<string, unknown>[];
	/** Called for a known tool name with object arguments. */
	callTool: (
		name: string,
		args: Record<string, unknown>,
		context: McpToolCallContext,
	) => Promise<unknown>;
	/** Called once after input EOF (or `shutdown()`) and all in-flight requests have answered. */
	onDrained: () => void;
}

interface PendingOutbound {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export function serveMcpStdioServer(options: McpStdioServerOptions): {
	shutdown(): void;
} {
	let protocolVersion: string | undefined;
	let clientCapabilities: Record<string, unknown> = {};
	let closing = false;
	let drained = false;
	let inFlight = 0;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let discarding = false;
	let outboundCounter = 0;
	const outbound = new Map<string, PendingOutbound>();
	/** In-flight client requests by `typeof id:id`, for cancellation. */
	const running = new Map<
		string,
		{ controller: AbortController; cancelled: boolean }
	>();
	const idKey = (id: JsonRpcId) => `${typeof id}:${id}`;

	const write = (message: unknown) => {
		if (drained) return;
		options.output.write(`${JSON.stringify(message)}\n`);
	};
	const errorResponse = (
		id: JsonRpcId | null,
		code: number,
		message: string,
	) => ({
		jsonrpc: "2.0",
		id,
		error: { code, message },
	});
	const maybeDrain = () => {
		if (closing && inFlight === 0 && !drained) {
			drained = true;
			options.onDrained();
		}
	};

	const sendRequest = (
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<unknown> => {
		if (closing || drained)
			return Promise.reject(
				new JsonRpcError(JSONRPC_INTERNAL_ERROR, "client disconnected"),
			);
		outboundCounter += 1;
		const id = `aw-server-${outboundCounter}`;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				outbound.delete(id);
				write({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason: "the tool call was cancelled" },
				});
				reject(new JsonRpcError(JSONRPC_INTERNAL_ERROR, "request cancelled"));
			};
			if (signal?.aborted) {
				reject(new JsonRpcError(JSONRPC_INTERNAL_ERROR, "request cancelled"));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			outbound.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			write({ jsonrpc: "2.0", id, method, params });
		});
	};
	const sendNotification = (method: string, params: unknown) =>
		write({ jsonrpc: "2.0", method, params });

	const dispatch = async (
		method: string,
		params: unknown,
		signal: AbortSignal,
	): Promise<unknown> => {
		switch (method) {
			case "initialize": {
				if (protocolVersion !== undefined)
					throw new JsonRpcError(
						JSONRPC_INVALID_REQUEST,
						"already initialized",
					);
				const record = asRecord(params);
				if (record === undefined || typeof record.protocolVersion !== "string")
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						"initialize requires params.protocolVersion",
					);
				protocolVersion = negotiateMcpProtocolVersion(record.protocolVersion);
				clientCapabilities = asRecord(record.capabilities) ?? {};
				return {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: {
						name: options.serverInfoName,
						version: options.serverVersion,
					},
					instructions: options.instructions,
				};
			}
			case "ping":
				return {};
			case "tools/list":
				requireInitialized();
				return { tools: options.tools(protocolVersion as string) };
			case "tools/call": {
				requireInitialized();
				const record = asRecord(params);
				if (record === undefined || typeof record.name !== "string")
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						"tools/call requires params.name",
					);
				const name = record.name;
				if (
					!options
						.tools(protocolVersion as string)
						.some((tool) => tool.name === name)
				)
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						`Unknown tool: ${name}`,
					);
				const args =
					record.arguments === undefined ? {} : asRecord(record.arguments);
				if (args === undefined)
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						"tools/call params.arguments must be an object",
					);
				const token = validId(asRecord(record._meta)?.progressToken);
				return await options.callTool(name, args, {
					protocolVersion: protocolVersion as string,
					clientCapabilities,
					signal,
					...(token === undefined ? {} : { progressToken: token }),
					sendRequest,
					sendNotification,
				});
			}
			default:
				throw new JsonRpcError(
					JSONRPC_METHOD_NOT_FOUND,
					`Method not found: ${method}`,
				);
		}
	};
	const requireInitialized = () => {
		if (protocolVersion === undefined)
			throw new JsonRpcError(JSONRPC_INVALID_REQUEST, "server not initialized");
	};

	const handleResponse = (message: Message) => {
		const id = message.id;
		if (typeof id !== "string") return;
		const waiter = outbound.get(id);
		if (!waiter) return;
		outbound.delete(id);
		if ("error" in message) {
			const error = asRecord(message.error);
			waiter.reject(
				new JsonRpcError(
					typeof error?.code === "number" ? error.code : JSONRPC_INTERNAL_ERROR,
					typeof error?.message === "string" ? error.message : "client error",
				),
			);
		} else waiter.resolve(message.result);
	};

	const handleNotification = (message: Message) => {
		if (message.method !== "notifications/cancelled") return;
		const requestId = validId(asRecord(message.params)?.requestId);
		if (requestId === undefined) return;
		const entry = running.get(idKey(requestId));
		if (!entry) return;
		entry.cancelled = true;
		entry.controller.abort(new Error("cancelled by the client"));
	};

	/** Returns the response for a request, or undefined for notifications/responses. */
	const handleOne = async (value: unknown): Promise<unknown> => {
		const message = asRecord(value);
		if (message === undefined || message.jsonrpc !== "2.0")
			return errorResponse(
				validId(message?.id) ?? null,
				JSONRPC_INVALID_REQUEST,
				"Invalid Request",
			);
		if (typeof message.method !== "string") {
			// A response to a server request; stray responses are ignored.
			if ("result" in message || "error" in message) {
				handleResponse(message);
				return undefined;
			}
			return errorResponse(
				validId(message.id) ?? null,
				JSONRPC_INVALID_REQUEST,
				"Invalid Request",
			);
		}
		if (!("id" in message)) {
			// Notifications need no answer; cancellation aborts the matching call.
			handleNotification(message);
			return undefined;
		}
		const id = validId(message.id);
		if (id === undefined)
			return errorResponse(
				null,
				JSONRPC_INVALID_REQUEST,
				"Invalid Request: id must be a string or integer",
			);
		const entry = { controller: new AbortController(), cancelled: false };
		const key = idKey(id);
		running.set(key, entry);
		try {
			const response = {
				jsonrpc: "2.0",
				id,
				result: await dispatch(
					message.method,
					message.params,
					entry.controller.signal,
				),
			};
			return entry.cancelled ? undefined : response;
		} catch (error) {
			if (entry.cancelled) return undefined;
			if (error instanceof JsonRpcError)
				return errorResponse(id, error.code, error.message);
			options.log(
				`internal error in ${message.method}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return errorResponse(id, JSONRPC_INTERNAL_ERROR, "Internal error");
		} finally {
			if (running.get(key) === entry) running.delete(key);
		}
	};

	const handleLine = (line: string) => {
		if (line.trim() === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			write(errorResponse(null, JSONRPC_PARSE_ERROR, "Parse error"));
			return;
		}
		inFlight += 1;
		const work = Array.isArray(parsed)
			? handleBatch(parsed)
			: handleOne(parsed).then((response) => {
					if (response !== undefined) write(response);
				});
		void work
			.catch((error) =>
				options.log(
					`request failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			)
			.finally(() => {
				inFlight -= 1;
				maybeDrain();
			});
	};

	const handleBatch = async (batch: unknown[]) => {
		if (!mcpVersionAllowsBatch(protocolVersion) || batch.length === 0) {
			write(
				errorResponse(
					null,
					JSONRPC_INVALID_REQUEST,
					batch.length === 0
						? "Invalid Request: empty batch"
						: "Invalid Request: JSON-RPC batches are not supported in this protocol version",
				),
			);
			return;
		}
		const responses = (
			await Promise.all(batch.map((entry) => handleOne(entry)))
		).filter((response) => response !== undefined);
		if (responses.length > 0) write(responses);
	};

	const onData = (chunk: Buffer | string) => {
		let buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		for (;;) {
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) break;
			const part = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (discarding) {
				discarding = false;
				pending = [];
				pendingBytes = 0;
				continue;
			}
			const lineBuffer =
				pending.length === 0 ? part : Buffer.concat([...pending, part]);
			pending = [];
			pendingBytes = 0;
			let line = lineBuffer.toString("utf8");
			if (line.endsWith("\r")) line = line.slice(0, -1);
			handleLine(line);
		}
		if (buffer.length === 0 || discarding) return;
		pending.push(buffer);
		pendingBytes += buffer.length;
		if (pendingBytes > MAX_MCP_MESSAGE_BYTES) {
			discarding = true;
			pending = [];
			pendingBytes = 0;
			write(
				errorResponse(
					null,
					JSONRPC_PARSE_ERROR,
					"Parse error: message too large",
				),
			);
		}
	};

	const shutdown = () => {
		if (closing) return;
		closing = true;
		options.input.off("data", onData);
		options.input.pause();
		// Nobody can answer server→client requests any more (for example an elicitation).
		for (const [id, waiter] of outbound) {
			outbound.delete(id);
			waiter.reject(
				new JsonRpcError(JSONRPC_INTERNAL_ERROR, "client disconnected"),
			);
		}
		// Long calls (a bounded wait) stop early; calls that ignore the signal finish normally.
		for (const entry of running.values())
			entry.controller.abort(new Error("client disconnected"));
		maybeDrain();
	};

	options.input.on("data", onData);
	options.input.once("end", () => {
		// A final line without a trailing newline is still a message.
		if (!discarding && pending.length > 0) {
			const line = Buffer.concat(pending).toString("utf8");
			pending = [];
			handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
		shutdown();
	});
	options.input.once("close", shutdown);
	return { shutdown };
}

export function asRecord(value: unknown): Message | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Message)
		: undefined;
}

function validId(value: unknown): JsonRpcId | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isInteger(value)) return value;
	return undefined;
}
