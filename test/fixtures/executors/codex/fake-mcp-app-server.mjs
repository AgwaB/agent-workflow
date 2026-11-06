// Fake `codex app-server` for the offline `mcp_tool` scenario. It reads the injected MCP servers
// from the thread/start `config` exactly as codex-cli 0.159.2 does (dotted keys
// `mcp_servers.<name>.command|args|env|enabled`, verified live), launches each enabled one with
// its `env`, calls `echo` with the prompt's conformance nonce and reports an `mcpToolCall` item.
// No model, no network.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const THREAD = "019a0000-0000-7000-8000-0000000000f1";
const TURN = "019a0000-0000-7000-8000-0000000000f2";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const servers = new Map();

function readServers(config) {
	for (const [key, value] of Object.entries(config ?? {})) {
		const match = /^mcp_servers\.([^.]+)\.(command|args|env|enabled)$/.exec(
			key,
		);
		if (match === null) continue;
		const server = servers.get(match[1]) ?? {};
		server[match[2]] = value;
		servers.set(match[1], server);
	}
}

function callEcho(server, text) {
	return new Promise((resolve, reject) => {
		const child = spawn(server.command, server.args ?? [], {
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				...(server.env ?? {}),
			},
			stdio: ["pipe", "pipe", "inherit"],
		});
		const lines = createInterface({ input: child.stdout });
		const pending = new Map();
		lines.on("line", (line) => {
			const message = JSON.parse(line);
			pending.get(message.id)?.(message);
		});
		let id = 0;
		const request = (method, params) =>
			new Promise((done) => {
				id += 1;
				pending.set(id, done);
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});
		(async () => {
			await request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "codex-fake", version: "0" },
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			);
			await request("tools/list", {});
			const result = await request("tools/call", {
				name: "echo",
				arguments: { text },
			});
			child.stdin.end();
			resolve(result.result);
		})().catch(reject);
	});
}

let prompt = "";
createInterface({ input: process.stdin }).on("line", async (line) => {
	const message = JSON.parse(line);
	const reply = (result) => send({ id: message.id, result });
	switch (message.method) {
		case "initialize":
			return reply({
				userAgent: "agent_workflow/0.159.2 (fake)",
				codexHome: "<HOME>/.codex",
				platformFamily: "unix",
				platformOs: "macos",
			});
		case "config/read":
			return reply({ config: { mcp_servers: {} }, origins: {} });
		case "thread/start":
			readServers(message.params.config);
			reply({
				thread: { id: THREAD, ephemeral: true, turns: [] },
				instructionSources: [],
				sandbox: {
					type: {
						"read-only": "readOnly",
						"workspace-write": "workspaceWrite",
						"danger-full-access": "dangerFullAccess",
					}[message.params.sandbox],
				},
				approvalPolicy: message.params.approvalPolicy,
			});
			return send({
				method: "thread/started",
				params: { thread: { id: THREAD } },
			});
		case "mcpServerStatus/list":
			return reply({
				data: [...servers.keys()].map((name) => ({
					name,
					tools: { echo: {} },
				})),
				nextCursor: null,
			});
		case "turn/start": {
			prompt = message.params.input.map((part) => part.text).join("\n");
			reply({
				turn: { id: TURN, items: [], status: "inProgress", error: null },
			});
			send({
				method: "turn/started",
				params: { threadId: THREAD, turn: { id: TURN, status: "inProgress" } },
			});
			const nonce =
				/conformance-nonce:([A-Za-z0-9-]+)/.exec(prompt)?.[1] ?? "missing";
			for (const [name, server] of servers) {
				if (server.enabled === false) continue;
				const item = {
					type: "mcpToolCall",
					id: `mcp_${name}`,
					server: name,
					tool: "echo",
					status: "inProgress",
					arguments: { text: nonce },
					result: null,
					error: null,
					readOnlyHint: true,
				};
				send({
					method: "item/started",
					params: { threadId: THREAD, turnId: TURN, item },
				});
				const result = await callEcho(server, nonce);
				send({
					method: "item/completed",
					params: {
						threadId: THREAD,
						turnId: TURN,
						item: {
							...item,
							status: "completed",
							result: {
								content: result.content,
								structuredContent: null,
								_meta: null,
							},
						},
					},
				});
			}
			send({
				method: "item/completed",
				params: {
					threadId: THREAD,
					turnId: TURN,
					item: {
						type: "agentMessage",
						id: "msg_1",
						text: `echoed ${nonce}`,
						phase: "final_answer",
					},
				},
			});
			return send({
				method: "turn/completed",
				params: {
					threadId: THREAD,
					turn: { id: TURN, items: [], status: "completed", error: null },
				},
			});
		}
		default:
			if (message.id !== undefined && message.method !== undefined)
				send({
					id: message.id,
					error: { code: -32601, message: `fake: ${message.method}` },
				});
	}
});
process.stdin.on("end", () => process.exit(0));
