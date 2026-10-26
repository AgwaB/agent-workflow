/**
 * Stub stdio MCP server (newline-delimited JSON-RPC 2.0) for conformance checks: verifies that an
 * adapter injects `SubmitRequest.mcpServers` (R#9), passes secrets via env (never argv), and lets the
 * kit serve oversized tool results to probe the CLI's delivery bound.
 *
 * Tools: `echo {text}` → text (padded to `padChars`), `fail {}` → `isError: true`.
 * Every start/request/stdin-close is appended to a JSONL log the kit reads back.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerSpec } from "../contract.js";
import type { JsonValue } from "../json.js";

export const STUB_MCP_SERVER_NAME = "conformance";
export const STUB_MCP_PROTOCOL_VERSION = "2025-06-18";

const SERVER_SOURCE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [logPath, configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const log = (entry) => appendFileSync(logPath, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
log({ type: "start", argv: process.argv.slice(1), envKeys: Object.keys(process.env).sort() });

const TOOLS = [
	{ name: "echo", description: "Echo text back (conformance stub).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "fail", description: "Always returns a tool error (conformance stub).", inputSchema: { type: "object", properties: {} } },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

function handle(method, params) {
	switch (method) {
		case "initialize":
			return { protocolVersion: (params && params.protocolVersion) || config.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agent-workflow-conformance-stub", version: "0.1.0" } };
		case "ping":
			return {};
		case "tools/list":
			return { tools: TOOLS };
		case "tools/call": {
			const name = params && params.name;
			const args = (params && params.arguments) || {};
			if (name === "echo") {
				let text = String(args.text ?? "");
				if (config.padChars > text.length) text = text + " " + "x".repeat(config.padChars - text.length - 1);
				return { content: [{ type: "text", text }], isError: false };
			}
			if (name === "fail") return { content: [{ type: "text", text: "conformance stub failure" }], isError: true };
			throw { code: -32602, message: "unknown tool: " + String(name) };
		}
		default:
			throw { code: -32601, message: "method not found: " + String(method) };
	}
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (line.trim() === "") return;
	let message;
	try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "parse error" } }); return; }
	log({ type: "request", method: message.method, id: message.id ?? null, params: message.params ?? null });
	if (message.id === undefined || message.id === null) return; // notification
	try { send({ id: message.id, result: handle(message.method, message.params) }); }
	catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } }); }
});
lines.on("close", () => { log({ type: "close" }); process.exit(0); });
`;

export interface StubMcpServerOptions {
	/** Directory for the server script, config and log (e.g. a check's temp dir). */
	readonly dir: string;
	/** MCP server name in `McpServerSpec.name`. Default `conformance`. */
	readonly name?: string;
	/** Pad `echo` results to at least this many characters (delivery-bound probe). */
	readonly padChars?: number;
	/** Env for the server process; the conformance kit puts a secret here to check argv hygiene. */
	readonly env?: Readonly<Record<string, string>>;
}

export type StubMcpLogEntry =
	| {
			readonly type: "start";
			readonly pid: number;
			readonly at: number;
			readonly argv: string[];
			readonly envKeys: string[];
	  }
	| {
			readonly type: "request";
			readonly pid: number;
			readonly at: number;
			readonly method: string;
			readonly id: JsonValue;
			readonly params: JsonValue;
	  }
	| { readonly type: "close"; readonly pid: number; readonly at: number };

export interface StubMcpServer {
	/** Spec to place in `SubmitRequest.mcpServers`. Runs with the current Node binary. */
	readonly spec: McpServerSpec;
	readonly scriptPath: string;
	readonly logPath: string;
	log(): Promise<StubMcpLogEntry[]>;
	/** `tools/call` requests received (across all server processes). */
	toolCalls(): Promise<
		{ readonly name: string; readonly arguments: JsonValue }[]
	>;
}

async function readJsonl<T>(path: string): Promise<T[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}

/** Write a stub MCP server into `dir` and return its spec and log readers. */
export async function createStubMcpServer(
	options: StubMcpServerOptions,
): Promise<StubMcpServer> {
	const name = options.name ?? STUB_MCP_SERVER_NAME;
	const scriptPath = join(options.dir, `${name}-mcp-stub.mjs`);
	const configPath = join(options.dir, `${name}-mcp-stub.config.json`);
	const logPath = join(options.dir, `${name}-mcp-stub.log.jsonl`);
	await writeFile(scriptPath, SERVER_SOURCE);
	await chmod(scriptPath, 0o755);
	await writeFile(
		configPath,
		JSON.stringify({
			padChars: options.padChars ?? 0,
			protocolVersion: STUB_MCP_PROTOCOL_VERSION,
		}),
	);
	await writeFile(logPath, "");
	const spec: McpServerSpec = {
		name,
		command: process.execPath,
		args: [scriptPath, logPath, configPath],
		...(options.env === undefined ? {} : { env: { ...options.env } }),
	};
	const log = () => readJsonl<StubMcpLogEntry>(logPath);
	return {
		spec,
		scriptPath,
		logPath,
		log,
		async toolCalls() {
			return (await log()).flatMap((entry) => {
				if (entry.type !== "request" || entry.method !== "tools/call")
					return [];
				const params = entry.params as {
					name?: unknown;
					arguments?: JsonValue;
				} | null;
				return [
					{
						name: typeof params?.name === "string" ? params.name : "",
						arguments: params?.arguments ?? null,
					},
				];
			});
		},
	};
}
