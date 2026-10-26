// Fake `claude` for the offline `mcp_tool` scenario: behaves like claude-code 2.1.310 as an MCP
// client (verified live, see transcripts/complete-tools-mcp and mcp-limit-*): reads `--mcp-config`,
// expands `${VAR}` in server env from its own environment, calls the injected server's `echo` tool
// with the prompt nonce, and spills results longer than MAX_MCP_OUTPUT_TOKENS (counted as chars,
// conservative) into the live "exceeds maximum allowed tokens" notice instead of delivering them.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { callMcpTool } from "../../../../dist/sdk/conformance/index.js";

const argv = process.argv.slice(2);
const logPath = process.env.AW_FAKE_CLAUDE_LOG;
const isRun = argv.includes("--permission-prompt-tool");
const effect = isRun;
appendFileSync(
	logPath,
	`${JSON.stringify({ type: "start", pid: process.pid, argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), effect })}\n`,
);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index < 0 ? undefined : argv[index + 1];
};

if (argv.includes("--version")) {
	console.log("2.1.310 (Claude Code)");
	process.exit(0);
}
if (argv[0] === "auth") {
	send({ loggedIn: true, authMethod: "claude.ai" });
	process.exit(0);
}

const lines = createInterface({ input: process.stdin });
const queue = [];
let wake;
lines.on("line", (line) => {
	queue.push(line);
	wake?.();
});
let closed = false;
lines.on("close", () => {
	closed = true;
	wake?.();
});
const next = async () => {
	while (queue.length === 0 && !closed)
		await new Promise((resolve) => (wake = resolve));
	return queue.shift() ?? null;
};

if (!isRun) {
	const line = await next();
	if (line?.includes("initialize"))
		send({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: "probe-initialize",
				response: { models: [{ value: "haiku" }] },
			},
		});
	process.exit(0);
}

const sessionId =
	flag("--session-id") ??
	flag("--resume") ??
	"00000000-0000-4000-8000-000000000000";
const prompt = JSON.parse((await next()) ?? "{}")?.message?.content ?? "";
const nonce = /conformance-nonce:([A-Za-z0-9-]+)/.exec(prompt)?.[1] ?? "none";
const configPath = flag("--mcp-config");
const config = configPath
	? JSON.parse(readFileSync(configPath, "utf8"))
	: { mcpServers: {} };
const expand = (value) =>
	value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
		(_, name) => process.env[name] ?? "",
	);
const servers = Object.entries(config.mcpServers ?? {});
send({
	type: "system",
	subtype: "init",
	session_id: sessionId,
	model: "claude-haiku-5-5",
	tools: [],
	mcp_servers: servers.map(([name]) => ({
		name,
		status: "connected",
		source: "dynamic",
	})),
	permissionMode: "default",
	apiKeySource: "none",
});
const [name, server] = servers[0] ?? [];
const callId = "toolu_fake_echo_1";
let text = "";
let isError = false;
if (server) {
	send({
		type: "assistant",
		message: {
			id: "msg_fake_1",
			model: "claude-haiku-5-5",
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: callId,
					name: `mcp__${name}__echo`,
					input: { text: nonce },
				},
			],
		},
		parent_tool_use_id: null,
		session_id: sessionId,
	});
	try {
		const env = Object.fromEntries(
			Object.entries(server.env ?? {}).map(([key, value]) => [
				key,
				expand(value),
			]),
		);
		const result = await callMcpTool(
			{ command: server.command, args: server.args, env },
			"echo",
			{ text: nonce },
			{ timeoutMs: 10_000 },
		);
		text = result.text;
		isError = result.isError;
	} catch (error) {
		text = `MCP error: ${error.message}`;
		isError = true;
	}
	const limit = Number(process.env.MAX_MCP_OUTPUT_TOKENS ?? 25000);
	if (text.length > limit)
		text = `Error: result (${text.length.toLocaleString("en-US")} characters across 1 line) exceeds maximum allowed tokens. Output has been saved to <HOME>/.claude/projects/<cwd>/${sessionId}/tool-results/mcp-${name}-echo.txt.`;
	send({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: callId,
					content: [{ type: "text", text }],
					is_error: isError,
				},
			],
		},
		parent_tool_use_id: null,
		session_id: sessionId,
	});
}
const finalText = `echo returned ${text.slice(0, 200)}`;
send({
	type: "assistant",
	message: {
		id: "msg_fake_2",
		model: "claude-haiku-5-5",
		role: "assistant",
		content: [{ type: "text", text: finalText }],
	},
	parent_tool_use_id: null,
	session_id: sessionId,
});
send({
	type: "result",
	subtype: "success",
	is_error: false,
	terminal_reason: "completed",
	session_id: sessionId,
	result: finalText,
	total_cost_usd: 0.0001,
	usage: {
		input_tokens: 10,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 5,
	},
});
await next(); // the adapter ends stdin after the result
process.exit(0);
