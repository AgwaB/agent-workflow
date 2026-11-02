// A scripted ACP v1 agent for the ACP executor tests (no model). NDJSON JSON-RPC on stdio.
// Scenario: env FAKE_ACP_SCENARIO (complete | raw | permission | hang | error | fs | secret | crash, and the
// conformance scenarios usage_unknown | slow | approval | mcp_tool | fail_*). FAKE_ACP_ATTEMPT (set by the
// conformance harness through the request env) tags the launch record.
// Every request it receives (method, params without env values) is appended to FAKE_ACP_LOG.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
	geminiHome: process.env.GEMINI_HOME ?? null,
	blockedPresent: [
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_PROJECT",
		"AGY_ACP_TEST",
	].filter((key) => key in process.env),
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
		case "agy_transcript": {
			// Antigravity: MCP rawOutput is a summary; the real results are in the home's transcript.
			const call = (id, title, kind, rawInput, rawOutput) => {
				update(sessionId, {
					sessionUpdate: "tool_call",
					toolCallId: id,
					title,
					kind,
					status: "pending",
					rawInput,
				});
				update(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: id,
					status: "completed",
					rawOutput,
				});
			};
			call(
				"t1",
				"aw_stub_echo",
				"other",
				{ arguments: { text: "hi" }, text: "hi" },
				"Echo tool",
			);
			call(
				"t2",
				"aw_stub_echo",
				"other",
				{ arguments: { text: "big" }, text: "big" },
				"Echo tool",
			);
			call(
				"t3",
				"seq 1 3",
				"execute",
				{ CommandLine: "seq 1 3" },
				{ combinedOutput: "1\n2\n3\n", exitCode: 0 },
			);
			call(
				"t4",
				"aw_stub_echo",
				"other",
				{ arguments: { text: "evil" }, text: "evil" },
				"Echo tool",
			);
			const home = process.env.GEMINI_HOME;
			if (home) {
				const session = join(home, "antigravity-acp", "brain", sessionId);
				const logs = join(session, ".system_generated", "logs");
				const step = join(session, ".system_generated", "steps", "3");
				mkdirSync(logs, { recursive: true });
				mkdirSync(step, { recursive: true });
				writeFileSync(join(step, "output.txt"), `big ${"x".repeat(5000)}`);
				const header =
					"Created At: 2026-11-02T00:00:00Z\nCompleted At: 2026-11-02T00:00:01Z\n";
				const mcp = (text) => ({
					name: "call_mcp_tool",
					args: {
						ServerName: "aw_stub",
						ToolName: "echo",
						Arguments: { text },
					},
				});
				const rows = [
					{
						step_index: 0,
						type: "USER_INPUT",
						status: "DONE",
						content: "earlier turn",
					},
					{
						step_index: 1,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						tool_calls: [mcp("old")],
					},
					{
						step_index: 2,
						type: "MCP_TOOL",
						status: "DONE",
						content: `${header}old-result`,
					},
					{
						step_index: 3,
						type: "USER_INPUT",
						status: "DONE",
						content: "this turn",
					},
					{
						step_index: 4,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						tool_calls: [
							mcp("hi"),
							mcp("big"),
							{ name: "run_command", args: { CommandLine: "seq 1 3" } },
							mcp("evil"),
						],
					},
					{
						step_index: 5,
						type: "MCP_TOOL",
						status: "DONE",
						content: `${header}hi-result`,
					},
					{
						step_index: 6,
						type: "MCP_TOOL",
						status: "DONE",
						content: `${header}The output was large and was saved to: ${pathToFileURL(join(step, "output.txt")).href}`,
					},
					{
						step_index: 7,
						type: "RUN_COMMAND",
						status: "DONE",
						content: `${header}1\n2\n3`,
					},
					{
						step_index: 8,
						type: "MCP_TOOL",
						status: "DONE",
						content: `${header}The output was large and was saved to: file:///etc/hosts`,
					},
					{
						step_index: 9,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						content: "done",
					},
				];
				writeFileSync(
					join(logs, "transcript_full.jsonl"),
					rows.map((row) => JSON.stringify(row)).join("\n"),
				);
			}
			chunk(sessionId, "done");
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "agy_shell": {
			// Antigravity-shaped permission requests: run_command (always execute) and an MCP call (other).
			const ask = async (toolCallId, title, kind, rawInput) => {
				const answer = await request("session/request_permission", {
					sessionId,
					toolCall: { toolCallId, title, kind, status: "pending", rawInput },
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "deny", name: "Deny", kind: "reject_once" },
					],
				});
				log({
					permission: toolCallId,
					answer: answer?.outcome?.optionId ?? answer?.outcome?.outcome,
				});
			};
			await ask("s1", "rg -n stop src", "execute", {
				CommandLine: "rg -n stop src",
				Cwd: "/w",
			});
			await ask("s2", "echo OK > f.txt", "execute", {
				CommandLine: "echo OK > f.txt",
				Cwd: "/w",
			});
			await ask("s3", "workflow_artifact_workflow_artifact", "other", {
				arguments: { action: "list" },
				action: "list",
			});
			chunk(sessionId, "done");
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "agy_web": {
			// Antigravity web tools: search_web reports a summary; read_url_content only a title, with the
			// page saved to a step file the transcript names by absolute path.
			const ask = async (toolCallId, title, kind) =>
				request("session/request_permission", {
					sessionId,
					toolCall: { toolCallId, title, kind, status: "pending" },
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "deny", name: "Deny", kind: "reject_once" },
					],
				});
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "w1",
				title: "Run search_web?",
				kind: "search",
				status: "pending",
				rawInput: { query: "abort timeout" },
			});
			const a1 = await ask("w1", "Run search_web?", "search");
			log({ permission: "w1", answer: a1?.outcome?.optionId });
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "w1",
				status: "completed",
				rawOutput: "Summary: see https://docs.example/api/globals [1]",
			});
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "w2",
				title: "Run read_url_content?",
				kind: "fetch",
				status: "pending",
				rawInput: { Url: "https://docs.example/api/globals" },
			});
			const a2 = await ask("w2", "Run read_url_content?", "fetch");
			log({ permission: "w2", answer: a2?.outcome?.optionId });
			// As live: the running update replaces rawInput with lower-case keys.
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "w2",
				status: "in_progress",
				title: "Running read_url_content",
				rawInput: {
					url: "https://docs.example/api/globals",
					title: "",
					summary: "",
					content_path: "",
				},
			});
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "w2",
				status: "completed",
				rawOutput: "Fetch globals docs",
			});
			const home = process.env.GEMINI_HOME;
			if (home) {
				const session = join(home, "antigravity-acp", "brain", sessionId);
				const logs = join(session, ".system_generated", "logs");
				const step = join(session, ".system_generated", "steps", "4");
				mkdirSync(logs, { recursive: true });
				mkdirSync(step, { recursive: true });
				writeFileSync(
					join(step, "content.md"),
					"# Globals\n\nReturns a new AbortSignal which will be aborted in delay milliseconds.\n",
				);
				const header =
					"Created At: 2026-11-02T00:00:00Z\nCompleted At: 2026-11-02T00:00:01Z\n";
				const rows = [
					{
						step_index: 0,
						type: "USER_INPUT",
						status: "DONE",
						content: "this turn",
					},
					{
						step_index: 1,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						tool_calls: [
							{ name: "search_web", args: { query: "abort timeout" } },
						],
					},
					{
						step_index: 2,
						type: "SEARCH_WEB",
						status: "DONE",
						content: `${header}The search returned the following summary: …`,
					},
					{
						step_index: 3,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						tool_calls: [
							{
								name: "read_url_content",
								args: { Url: "https://docs.example/api/globals" },
							},
						],
					},
					{
						step_index: 4,
						type: "READ_URL_CONTENT",
						status: "DONE",
						content: `${header}Title: Globals\n\nThe full content of the article at https://docs.example/api/globals has been saved to: ${join(step, "content.md")}\n\nYou can use the view_file tool to read specific sections if needed.`,
					},
					{
						step_index: 5,
						type: "PLANNER_RESPONSE",
						status: "DONE",
						content: "done",
					},
				];
				writeFileSync(
					join(logs, "transcript_full.jsonl"),
					rows.map((row) => JSON.stringify(row)).join("\n"),
				);
			}
			chunk(sessionId, "done");
			return send({ id, result: { stopReason: "end_turn" } });
		}
		case "agy_quota":
			chunk(sessionId, "Usage Limit Reached\n\nYour quota resets in 3 days.");
			return send({ id, result: { stopReason: "end_turn" } });
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
				...(params._meta === undefined ? {} : { meta: params._meta }),
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
						agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
					},
				});
				break;
			case "session/new":
				send({
					id: message.id,
					result: {
						sessionId: "fake-session-1",
						configOptions: [
							{
								id: "model",
								type: "select",
								options: [{ value: "fake-model-a" }, { value: "fake-model-b" }],
							},
							{
								id: "thinking_level",
								type: "select",
								options: [
									{ value: "low" },
									{ value: "medium" },
									{ value: "high" },
								],
							},
						],
					},
				});
				break;
			case "session/prompt":
				void prompt(message.id, params);
				break;
			case "authenticate":
				log({ method: message.method, params });
				process.stderr.write(
					"Open the following link to authenticate: https://example.invalid/login\n",
				);
				send({ id: message.id, result: {} });
				break;
			case "session/set_mode":
			case "session/set_config_option":
				log({ method: message.method, params });
				send({ id: message.id, result: {} });
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
