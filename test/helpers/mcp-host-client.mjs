// New in agent-workflow (WP13): a fake MCP client for the `agent-workflow` host MCP server tests.
// It speaks raw newline-delimited JSON-RPC either to an in-process server (serveHostMcpStdio over
// PassThrough streams) or to the built server in a child process, answers server→client requests
// (elicitation/create) through `onRequest`, and keeps every server message so tests can assert that
// stdout carries protocol only.
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { killTrackedProcess } from "./process-cleanup.mjs";

export const HOST_SERVER = fileURLToPath(
	new URL("../../dist/mcp/host-server/server.js", import.meta.url),
);
export const HOST_SERVER_BIN = fileURLToPath(
	new URL("../../src/mcp/host-server/bin.mjs", import.meta.url),
);
export const HOOK_MODULE = fileURLToPath(
	new URL("./host-test-executor.mjs", import.meta.url),
);

function createClient({ write, onRequest }) {
	const messages = [];
	const waiters = [];
	let buffer = "";
	let nextId = 0;
	const handle = (message) => {
		messages.push(message);
		if (typeof message.method === "string" && "id" in message) {
			// A server→client request.
			Promise.resolve(
				onRequest
					? onRequest(message)
					: { error: { code: -32601, message: "Method not found" } },
			).then((answer) =>
				write(
					`${JSON.stringify(
						answer && "error" in answer
							? { jsonrpc: "2.0", id: message.id, error: answer.error }
							: { jsonrpc: "2.0", id: message.id, result: answer },
					)}\n`,
				),
			);
		}
		for (const waiter of [...waiters])
			if (waiter.match(message)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
	};
	const client = {
		messages,
		lines: [],
		feed(chunk) {
			buffer += chunk;
			for (;;) {
				const index = buffer.indexOf("\n");
				if (index === -1) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				client.lines.push(line);
				handle(JSON.parse(line));
			}
		},
		waitFor(match, timeoutMs = 60_000) {
			return new Promise((resolve, reject) => {
				const existing = messages.find(match);
				if (existing !== undefined) return resolve(existing);
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								`no matching MCP message${client.stderr ? `; stderr: ${client.stderr()}` : ""}`,
							),
						),
					timeoutMs,
				);
				waiters.push({
					match,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
				});
			});
		},
		sendJson(message) {
			write(`${JSON.stringify(message)}\n`);
		},
		send(raw) {
			write(raw);
		},
		nextId() {
			nextId += 1;
			return nextId;
		},
		async request(method, params, timeoutMs) {
			const id = client.nextId();
			client.sendJson({ jsonrpc: "2.0", id, method, params });
			return await client.waitFor(
				(message) => message.id === id && !("method" in message),
				timeoutMs,
			);
		},
		notify(method, params) {
			client.sendJson({ jsonrpc: "2.0", method, params });
		},
		async initialize(protocolVersion = "2025-06-18", capabilities = {}) {
			const response = await client.request("initialize", {
				protocolVersion,
				capabilities,
				clientInfo: { name: "aw-mcp-host-test", version: "0.0.0" },
			});
			client.notify("notifications/initialized");
			return response;
		},
		/** tools/call → the tool result (throws on a JSON-RPC error). */
		async call(name, args = {}, options = {}) {
			const response = await client.request(
				"tools/call",
				{
					name,
					arguments: args,
					...(options.progressToken === undefined
						? {}
						: { _meta: { progressToken: options.progressToken } }),
				},
				options.timeoutMs,
			);
			if (response.error) throw new Error(JSON.stringify(response.error));
			return response.result;
		},
	};
	return client;
}

/** In-process server (dist/mcp/host-server) over PassThrough streams. */
export async function inProcessHostServer(options) {
	const { serveHostMcpStdio } = await import(
		"../../dist/mcp/host-server/index.js"
	);
	const input = new PassThrough();
	const output = new PassThrough();
	const logs = [];
	let drained;
	const done = new Promise((resolve) => {
		drained = resolve;
	});
	const client = createClient({
		write: (line) => input.write(line),
		onRequest: options.onRequest,
	});
	output.setEncoding("utf8");
	output.on("data", (chunk) => client.feed(chunk));
	const server = serveHostMcpStdio({
		input,
		output,
		log: (message) => logs.push(message),
		root: options.root,
		host: options.host ?? "generic",
		env: options.env ?? process.env,
		...(options.api ? { api: options.api } : {}),
		serverVersion: "0.0.0-test",
		onDrained: () => drained(),
	});
	return Object.assign(client, {
		logs,
		server,
		async close() {
			input.end();
			await done;
		},
	});
}

/** The built server in a child process (`node dist/mcp/host-server/server.js …`). */
export function spawnHostServer({ cwd, env = {}, args, onRequest, command }) {
	const child = spawn(
		process.execPath,
		[command ?? HOST_SERVER, ...(args ?? ["--host", "generic"])],
		{ cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	const client = createClient({
		write: (line) => {
			if (!child.stdin.destroyed) child.stdin.write(line);
		},
		onRequest,
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => client.feed(chunk));
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	return Object.assign(client, {
		child,
		exited,
		stderr: () => stderr,
		async close() {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
			try {
				return await exited;
			} finally {
				clearTimeout(timer);
			}
		},
		kill() {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
		},
	});
}

/** Environment of the guarded test-executor hook (registers `test-fixture`). */
export function hookEnv(effectLog, config) {
	return {
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
		AW_HOST_TEST_EFFECT_LOG: effectLog,
		...(config ? { AW_HOST_TEST_EXECUTOR_CONFIG: JSON.stringify(config) } : {}),
	};
}

/**
 * Kill a detached supervisor or server if it is still the same process (best effort). Call
 * `trackProcess(pid)` when the pid is learned: a pid kept until cleanup may be another process by
 * then (process-cleanup.mjs).
 */
export async function killPid(pid) {
	await killTrackedProcess(pid);
}

/** Call workflow_wait until the run is no longer stillRunning. */
export async function waitLoop(client, runId, args = {}, maxCalls = 60) {
	const results = [];
	for (let index = 0; index < maxCalls; index += 1) {
		const result = await client.call("workflow_wait", { runId, ...args });
		results.push(result);
		if (!result.structuredContent?.data?.stillRunning) return results;
	}
	throw new Error(`run ${runId} still running after ${maxCalls} waits`);
}
