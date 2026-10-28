// Harmless stdio MCP server for live bundle 5 (D5): one tool `echo` that returns its text.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const log = process.env.LIVE5_ECHO_LOG;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id === undefined) return;
	if (m.method === "initialize")
		return send({
			jsonrpc: "2.0",
			id: m.id,
			result: {
				protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "live5echo", version: "0.0.1" },
			},
		});
	if (m.method === "tools/list")
		return send({
			jsonrpc: "2.0",
			id: m.id,
			result: {
				tools: [
					{
						name: "echo",
						description:
							"Echo the given text back (live bundle 5 test server).",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
		});
	if (m.method === "tools/call") {
		if (log)
			appendFileSync(
				log,
				`${new Date().toISOString()} ${process.pid} ${JSON.stringify(m.params)}\n`,
			);
		return send({
			jsonrpc: "2.0",
			id: m.id,
			result: {
				content: [
					{ type: "text", text: `echo: ${m.params?.arguments?.text ?? ""}` },
				],
			},
		});
	}
	if (m.method === "ping")
		return send({ jsonrpc: "2.0", id: m.id, result: {} });
	send({
		jsonrpc: "2.0",
		id: m.id,
		error: { code: -32601, message: "method not found" },
	});
});
