// New in agent-workflow (WP5): hand-written MCP stdio transport + method dispatch. Messages are
// newline-delimited UTF-8 JSON-RPC 2.0. Only protocol goes to `output`; diagnostics go to `log`.
import type { Readable, Writable } from "node:stream";

import {
	WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
	WORKFLOW_ARTIFACT_TOOL_GUIDELINES,
	WORKFLOW_ARTIFACT_TOOL_NAME,
	WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
} from "../../core/artifact-access.js";
import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	JsonRpcError,
	mcpVersionAllowsBatch,
	mcpVersionHasToolAnnotations,
	mcpVersionHasToolTitle,
	negotiateMcpProtocolVersion,
} from "./protocol.js";
import type { ArtifactToolCallResult } from "./service.js";

export const ARTIFACT_MCP_SERVER_INFO_NAME = "agent-workflow-artifact";

/** Lines longer than this are rejected with a parse error and discarded. */
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface McpStdioOptions {
	input: Readable;
	output: Writable;
	log: (message: string) => void;
	callTool: (args: Record<string, unknown>) => Promise<ArtifactToolCallResult>;
	serverVersion: string;
	/** Called once after input EOF (or `shutdown()`) and all in-flight requests have answered. */
	onDrained: () => void;
}

type JsonRpcId = string | number;
type Message = Record<string, unknown>;

/** Text the server sends as `instructions` (the core tool guidelines, one per line). */
export function artifactServerInstructions(): string {
	return WORKFLOW_ARTIFACT_TOOL_GUIDELINES.map((line) => `- ${line}`).join(
		"\n",
	);
}

export function artifactToolDefinition(
	version: string,
): Record<string, unknown> {
	return {
		name: WORKFLOW_ARTIFACT_TOOL_NAME,
		...(mcpVersionHasToolTitle(version) ? { title: "Workflow Artifact" } : {}),
		description: WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
		inputSchema: WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
		...(mcpVersionHasToolAnnotations(version)
			? {
					annotations: {
						title: "Workflow Artifact",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: false,
						openWorldHint: false,
					},
				}
			: {}),
	};
}

export function serveMcpStdio(options: McpStdioOptions): { shutdown(): void } {
	let protocolVersion: string | undefined;
	let closing = false;
	let drained = false;
	let inFlight = 0;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let discarding = false;

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

	const dispatch = async (
		method: string,
		params: unknown,
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
				return {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: {
						name: ARTIFACT_MCP_SERVER_INFO_NAME,
						version: options.serverVersion,
					},
					instructions: artifactServerInstructions(),
				};
			}
			case "ping":
				return {};
			case "tools/list":
				requireInitialized();
				return { tools: [artifactToolDefinition(protocolVersion as string)] };
			case "tools/call": {
				requireInitialized();
				const record = asRecord(params);
				if (record === undefined || typeof record.name !== "string")
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						"tools/call requires params.name",
					);
				if (record.name !== WORKFLOW_ARTIFACT_TOOL_NAME)
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						`Unknown tool: ${record.name}`,
					);
				const args =
					record.arguments === undefined ? {} : asRecord(record.arguments);
				if (args === undefined)
					throw new JsonRpcError(
						JSONRPC_INVALID_PARAMS,
						"tools/call params.arguments must be an object",
					);
				return await options.callTool(args);
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
			// A response to a server request (this server sends none) is ignored.
			if ("result" in message || "error" in message) return undefined;
			return errorResponse(
				validId(message.id) ?? null,
				JSONRPC_INVALID_REQUEST,
				"Invalid Request",
			);
		}
		if (!("id" in message)) {
			// Notifications: initialized/cancelled/others need no answer.
			return undefined;
		}
		const id = validId(message.id);
		if (id === undefined)
			return errorResponse(
				null,
				JSONRPC_INVALID_REQUEST,
				"Invalid Request: id must be a string or integer",
			);
		try {
			return {
				jsonrpc: "2.0",
				id,
				result: await dispatch(message.method, message.params),
			};
		} catch (error) {
			if (error instanceof JsonRpcError)
				return errorResponse(id, error.code, error.message);
			options.log(
				`internal error in ${message.method}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return errorResponse(id, JSONRPC_INTERNAL_ERROR, "Internal error");
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

function asRecord(value: unknown): Message | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Message)
		: undefined;
}

function validId(value: unknown): JsonRpcId | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isInteger(value)) return value;
	return undefined;
}
