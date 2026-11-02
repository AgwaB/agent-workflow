// A scripted ACP v1 agent for the ACP executor tests (no model). NDJSON JSON-RPC on stdio.
// Scenario: env FAKE_ACP_SCENARIO (complete | raw | permission | hang | error | fs | secret | crash, and the
// conformance scenarios usage_unknown | slow | approval | mcp_tool | fail_*). FAKE_ACP_ATTEMPT (set by the
// conformance harness through the request env) tags the launch record.
// Every request it receives (method, params without env values) is appended to FAKE_ACP_LOG.
import { appendFileSync } from "node:fs";
import { callMcpTool } from "../../../../dist/sdk/conformance/index.js";

if (process.argv.includes("--version")) {
	process.stdout.write("0.99.0\n");
	process.exit(0);
}

const scenario = process.env.FAKE_ACP_SCENARIO ?? "complete";
const logFile = process.env.FAKE_ACP_LOG;
const log = (entry) => {
	if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
log({
	argv: process.argv.slice(2),
	attempt: process.env.FAKE_ACP_ATTEMPT ?? null,
	pid: process.pid,
	envKeys: Object.keys(process.env)
		.filter((k) => k.startsWith("AGENT_WORKFLOW"))
		.sort(),
});

const send = (message) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, update) =>
	send({ method: "session/update", params: { sessionId, update } });
const chunk = (sessionId, text) =>
	update(sessionId, {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	});

let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});
let cancelPrompt;
let sessionParams;
const failText = {
	fail_transient: "Request timed out (ECONNRESET)",
	fail_rate_limit: "429 RESOURCE_EXHAUSTED: quota exceeded",
	fail_auth: "Authentication required: please log in",
	fail_config: "Model gemini-x not found",
	fail_unknown: "something odd happened",
};

async function prompt(id, params) {
	const sessionId = params.sessionId;
	if (failText[scenario] !== undefined)
		return send({ id, error: { code: -32000, message: failText[scenario] } });
	switch (scenario) {
		case "fail_permanent":
			return send({ id, result: { stopReason: "refusal" } });
		case "usage_unknown":
			chunk(sessionId, "done");
			return send({ id, result: { stopReason: "end_turn" } });
		case "approval": {
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "x1",
				title: "Shell echo hi",
				kind: "execute",
				status: "pending",
			});
			const answer = await request("session/request_permission", {
				sessionId,
				toolCall: {
					toolCallId: "x1",
					title: "Shell echo hi",
					kind: "execute",
					status: "pending",
				},
				options: [
					{ optionId: "proceed_once", name: "Allow", kind: "allow_once" },
					{ optionId: "cancel", name: "Reject", kind: "reject_once" },
				],
			});
			const allowed =
				answer?.outcome?.outcome === "selected" &&
				answer.outcome.optionId === "proceed_once";
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "x1",
				status: allowed ? "completed" : "failed",
				...(allowed
					? {
							content: [
								{ type: "content", content: { type: "text", text: "hi" } },
							],
						}
					: {}),
			});
			chunk(sessionId, allowed ? "ran" : "not run");
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "mcp_tool": {
			const nonce =
				/conformance-nonce:([A-Za-z0-9-]+)/.exec(
					params.prompt?.[0]?.text ?? "",
				)?.[1] ?? "";
			const server = (sessionParams?.mcpServers ?? []).find(
				(s) => s.name === "conformance",
			);
			const spec = {
				name: server.name,
				command: server.command,
				args: server.args,
				env: Object.fromEntries(
					(server.env ?? []).map((e) => [e.name, e.value]),
				),
			};
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "m1",
				title: "mcp_conformance_echo",
				kind: "other",
				status: "in_progress",
				rawInput: { text: nonce },
			});
			const result = await callMcpTool(
				spec,
				"echo",
				{ text: nonce },
				{ timeoutMs: 10_000 },
			);
			const text = result.text;
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "m1",
				status: "completed",
				rawOutput: text,
			});
			chunk(sessionId, text);
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "slow":
			chunk(sessionId, "working");
			cancelPrompt = () => send({ id, result: { stopReason: "cancelled" } });
			return;
		case "complete":
			chunk(sessionId, "Hello ");
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "ReadFile a.ts",
				kind: "read",
				status: "in_progress",
				locations: [{ path: "/x/a.ts", line: 3 }],
			});
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "t1",
				status: "completed",
				content: [
					{ type: "content", content: { type: "text", text: "file text" } },
				],
			});
			chunk(sessionId, "world");
			return send({
				id,
				result: {
					stopReason: "end_turn",
					usage: {
						inputTokens: 100,
						outputTokens: 20,
						cachedReadTokens: 40,
						thoughtTokens: 5,
						totalTokens: 120,
					},
				},
			});
		case "raw":
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "read_file",
				kind: "read",
				status: "in_progress",
				rawInput: { path: "a.ts" },
			});
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "t1",
				status: "completed",
				rawOutput: { content: "1: line" },
			});
			chunk(sessionId, "done");
			return send({ id, result: { stopReason: "end_turn" } });
		case "permission": {
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "t2",
				title: "WriteFile b.ts",
				kind: "edit",
				status: "pending",
			});
			const answer = await request("session/request_permission", {
				sessionId,
				toolCall: {
					toolCallId: "t2",
					title: "WriteFile b.ts",
					kind: "edit",
					status: "pending",
				},
				options: [
					{
						optionId: "proceed_always",
						name: "Always allow",
						kind: "allow_always",
					},
					{ optionId: "proceed_once", name: "Allow", kind: "allow_once" },
					{ optionId: "cancel", name: "Reject", kind: "reject_once" },
				],
			});
			log({ permissionAnswer: answer });
			const outcome =
				answer?.outcome?.outcome === "selected"
					? answer.outcome.optionId
					: "cancelled";
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "t2",
				status: outcome === "proceed_once" ? "completed" : "failed",
			});
			chunk(sessionId, `permission: ${outcome}`);
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "hang":
			chunk(sessionId, "working");
			cancelPrompt = () => send({ id, result: { stopReason: "cancelled" } });
			return;
		case "error":
			return send({
				id,
				error: { code: -32000, message: "Authentication required" },
			});
		case "fs": {
			const result = await request("fs/read_text_file", {
				sessionId,
				path: "/x/a.ts",
			});
			chunk(sessionId, `fs: ${JSON.stringify(result)}`);
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "secret":
			process.stderr.write(`token ${process.env.ECHO_SECRET ?? ""}\n`);
			chunk(sessionId, `echo ${process.env.ECHO_SECRET ?? ""}`);
			return send({ id, result: { stopReason: "end_turn" } });
		case "crash":
			process.exit(3);
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
	buffer += text;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (line.trim() === "") continue;
		const message = JSON.parse(line);
		if (message.method === undefined) {
			const resolve = waiting.get(message.id);
			waiting.delete(message.id);
			if (message.error) log({ responseError: message.error });
			resolve?.(message.result ?? { error: message.error });
			continue;
		}
		const params = message.params ?? {};
		if (message.method === "session/new") sessionParams = params;
		if (message.method === "session/new")
			log({
				method: message.method,
				cwd: params.cwd,
				mcpServers: (params.mcpServers ?? []).map((s) => ({
					name: s.name,
					command: s.command,
					args: s.args,
					envNames: (s.env ?? []).map((e) => e.name),
				})),
			});
		else
			log({
				method: message.method,
				...(message.method === "session/prompt"
					? { text: params.prompt?.[0]?.text }
					: {}),
			});
		switch (message.method) {
			case "initialize":
				send({
					id: message.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: {
							loadSession: false,
							mcpCapabilities: { http: false, sse: false },
						},
						authMethods: [],
					},
				});
				break;
			case "session/new":
				send({ id: message.id, result: { sessionId: "fake-session-1" } });
				break;
			case "session/prompt":
				void prompt(message.id, params);
				break;
			case "session/cancel":
				cancelPrompt?.();
				break;
			default:
				if (message.id !== undefined)
					send({
						id: message.id,
						error: { code: -32601, message: "method not found" },
					});
		}
	}
});
process.stdin.on("end", () => process.exit(0));
