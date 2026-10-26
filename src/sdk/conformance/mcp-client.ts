/**
 * Minimal stdio MCP client (newline-delimited JSON-RPC 2.0): initialize → tools/list → tools/call.
 * Used by the fake harness to stand in for a CLI that calls injected MCP tools, and by tests of the
 * stub server. Not a general MCP client.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServerSpec } from "../contract.js";
import type { JsonValue } from "../json.js";
import { STUB_MCP_PROTOCOL_VERSION } from "./stub-mcp.js";

export interface McpToolCallResult {
	readonly serverInfo: JsonValue;
	readonly tools: readonly string[];
	readonly isError: boolean;
	/** Concatenated text content. */
	readonly text: string;
	readonly raw: JsonValue;
}

export class McpClientError extends Error {
	readonly code: number | null;
	constructor(message: string, code: number | null = null) {
		super(message);
		this.name = "McpClientError";
		this.code = code;
	}
}

/** Spawn `spec`, call one tool, and shut the server down. */
export async function callMcpTool(
	spec: McpServerSpec,
	tool: string,
	args: Readonly<Record<string, JsonValue>>,
	options: { readonly timeoutMs?: number; readonly cwd?: string } = {},
): Promise<McpToolCallResult> {
	const child = spawn(spec.command, [...spec.args], {
		cwd: options.cwd,
		env: { ...process.env, ...spec.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	let nextId = 0;
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const failAll = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	child.on("error", (error) => failAll(error));
	child.on("exit", (code) =>
		failAll(
			new McpClientError(
				`MCP server exited (${code}) before answering${stderr === "" ? "" : `: ${stderr.trim()}`}`,
			),
		),
	);
	createInterface({ input: child.stdout }).on("line", (line) => {
		let message: {
			id?: number;
			result?: unknown;
			error?: { code?: number; message?: string };
		};
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const waiter = pending.get(message.id);
		if (waiter === undefined) return;
		pending.delete(message.id);
		if (message.error !== undefined)
			waiter.reject(
				new McpClientError(
					message.error.message ?? "MCP error",
					message.error.code ?? null,
				),
			);
		else waiter.resolve(message.result);
	});
	const write = (message: Record<string, unknown>) =>
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const request = (method: string, params: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			nextId += 1;
			pending.set(nextId, { resolve, reject });
			write({ id: nextId, method, params });
		});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new McpClientError("MCP call timed out")),
			options.timeoutMs ?? 10_000,
		);
	});
	try {
		return await Promise.race([
			(async () => {
				const init = (await request("initialize", {
					protocolVersion: STUB_MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "agent-workflow-conformance", version: "0.1.0" },
				})) as { serverInfo?: JsonValue } | null;
				write({ method: "notifications/initialized" });
				const listed = (await request("tools/list", {})) as {
					tools?: { name?: string }[];
				} | null;
				const result = (await request("tools/call", {
					name: tool,
					arguments: args,
				})) as {
					content?: { type?: string; text?: string }[];
					isError?: boolean;
				} | null;
				return {
					serverInfo: init?.serverInfo ?? null,
					tools: (listed?.tools ?? []).map((entry) => String(entry.name)),
					isError: result?.isError === true,
					text: (result?.content ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join(""),
					raw: (result ?? null) as JsonValue,
				};
			})(),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		child.removeAllListeners("exit");
		child.stdin.end();
		if (child.exitCode === null) child.kill("SIGTERM");
	}
}
