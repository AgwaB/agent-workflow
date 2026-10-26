// Offline Pi emulator for the conformance `mcp_tool` scenario (WP6). The stub CLI cannot run MCP,
// so this script stands in for `pi --mode json --print`: it reads the adapter's generated per-run
// extension config (`const config = …` in pi-extension.mjs) and the secret channel env (deleted
// first, as the real extension does), calls the injected server's `echo` tool with the prompt nonce,
// applies Pi 1.1's MCP text cut (20 KiB `truncateMiddle` + notice, ported from
// pi-coding-agent dist/extensions/mcp/tools.js `limitMcpContent`) and prints Pi JSON events.
// Behaviour was checked against the real Pi CLI with a faux provider (docs/executors/pi.md).
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const { callMcpTool } = await import(
	join(here, "../../../../dist/sdk/conformance/index.js")
);

const logPath =
	process.env.AW_FAKE_PI_LOG ??
	process.argv[1].replace(/\.mjs$/u, ".log.jsonl");
const argv = process.argv.slice(2);
appendFileSync(
	logPath,
	`${JSON.stringify({ type: "start", pid: process.pid, argv, envKeys: Object.keys(process.env).sort(), cwd: process.cwd() })}\n`,
);
if (argv.includes("--version")) {
	console.log("1.1.0");
	process.exit(0);
}
if (!argv.includes("--mode")) process.exit(0);

const secretsRaw = process.env.AGENT_WORKFLOW_PI_RUN_SECRETS_JSON;
delete process.env.AGENT_WORKFLOW_PI_RUN_SECRETS_JSON;
const secrets = secretsRaw ? JSON.parse(secretsRaw) : {};
const extension = argv[argv.indexOf("-e") + 1];
const source = readFileSync(extension, "utf8");
const config = JSON.parse(/^const config = (.*);$/mu.exec(source)[1]);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const nonce = /conformance-nonce:([A-Za-z0-9-]+)/u.exec(prompt)?.[1] ?? "none";

const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
function truncateMiddle(content, maxBytes) {
	const buf = Buffer.from(content, "utf-8");
	if (buf.length <= maxBytes)
		return { content, truncated: false, totalBytes: buf.length };
	const isBoundary = (index) =>
		index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removed = Array.from(
		buf.subarray(headEnd, tailStart).toString("utf-8"),
	).length;
	return {
		content: `${head}…${removed} chars truncated…${tail}`,
		truncated: true,
		totalBytes: buf.length,
	};
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
out({
	type: "session",
	version: 3,
	id: "fake-session",
	timestamp: new Date().toISOString(),
	cwd: process.cwd(),
});
out({ type: "agent_start" });
const index = config.mcpServers.findIndex(
	(server) => server.name === "conformance",
);
let text = "no conformance server";
if (index >= 0) {
	const server = config.mcpServers[index];
	const env = {};
	for (const key of server.envKeys) env[key] = secrets.mcpEnv?.[index]?.[key];
	const name = `mcp__${server.name}__echo`;
	out({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: name,
		args: { text: nonce },
	});
	const result = await callMcpTool(
		{ name: server.name, command: server.command, args: server.args, env },
		"echo",
		{ text: nonce },
	);
	const combined = result.text;
	const cut = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	text = cut.truncated
		? `Warning: truncated output (original token count: ${Math.ceil(cut.totalBytes / 4)})\nTotal output lines: 1\n\n${cut.content}\n\n[Full output: /tmp/pi-mcp-fake.txt (read it with offset/limit)]`
		: combined;
	out({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: name,
		result: { content: [{ type: "text", text }] },
		isError: result.isError === true,
	});
}
out({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: `echoed ${nonce}` }],
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 10,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 13,
			cost: { total: 0 },
		},
		stopReason: "stop",
	},
});
out({ type: "agent_settled", aborted: false });
