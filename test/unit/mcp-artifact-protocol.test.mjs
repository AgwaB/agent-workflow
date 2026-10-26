// New in agent-workflow (WP5): stdio framing, JSON-RPC errors, version negotiation and lifecycle
// of the workflow_artifact MCP server (dist/mcp/artifact-server/server.js).
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";

import {
	WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
	WORKFLOW_ARTIFACT_TOOL_GUIDELINES,
	WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
} from "../../dist/core/artifact-access.js";
import {
	MCP_LATEST_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	negotiateMcpProtocolVersion,
} from "../../dist/mcp/artifact-server/index.js";
import { createRunFixture, startServer } from "../fixtures/mcp/helpers.mjs";

async function withServer(t, fn, options = {}) {
	const fixture = await createRunFixture(options.fixture);
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const server = startServer(
		["--config", fixture.configPath, ...(options.args ?? [])],
		options,
	);
	t.after(() => server.child.kill("SIGKILL"));
	await fn(server, fixture);
	return server;
}

function assertProtocolOnly(server) {
	for (const line of server.lines) {
		const message = JSON.parse(line);
		const messages = Array.isArray(message) ? message : [message];
		for (const entry of messages) assert.equal(entry.jsonrpc, "2.0", line);
	}
}

test("initialize negotiates: supported versions are echoed, others get the latest", async (t) => {
	assert.equal(MCP_LATEST_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS[0]);
	for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS)
		assert.equal(negotiateMcpProtocolVersion(version), version);
	for (const version of [
		...MCP_SUPPORTED_PROTOCOL_VERSIONS,
		"2024-10-07",
		"2099-01-01",
		"x",
	]) {
		await withServer(t, async (server) => {
			const response = await server.initialize(version);
			const expected = MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version)
				? version
				: MCP_LATEST_PROTOCOL_VERSION;
			assert.equal(response.result.protocolVersion, expected, version);
			assert.deepEqual(response.result.capabilities, {
				tools: { listChanged: false },
			});
			assert.equal(response.result.serverInfo.name, "agent-workflow-artifact");
			assert.equal(
				response.result.instructions,
				WORKFLOW_ARTIFACT_TOOL_GUIDELINES.map((line) => `- ${line}`).join("\n"),
			);
			assert.deepEqual(await server.close(), { code: 0, signal: null });
			assertProtocolOnly(server);
		});
	}
});

test("tools/list advertises exactly the core schema, gated per protocol version", async (t) => {
	for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
		await withServer(t, async (server) => {
			await server.initialize(version);
			const response = await server.request("tools/list", {});
			assert.equal(response.result.tools.length, 1);
			const [tool] = response.result.tools;
			assert.equal(tool.name, "workflow_artifact");
			assert.equal(tool.description, WORKFLOW_ARTIFACT_TOOL_DESCRIPTION);
			assert.deepEqual(tool.inputSchema, WORKFLOW_ARTIFACT_TOOL_PARAMETERS);
			assert.equal("annotations" in tool, version !== "2024-11-05", version);
			assert.equal(
				"title" in tool,
				version === "2025-06-18" || version === "2025-11-25",
				version,
			);
			if (tool.annotations) assert.equal(tool.annotations.readOnlyHint, true);
			assert.equal("outputSchema" in tool, false);
			await server.close();
		});
	}
});

test("framing: split chunks, CRLF, blank lines, several messages per chunk, EOF without newline", async (t) => {
	await withServer(t, async (server) => {
		const init = JSON.stringify({
			jsonrpc: "2.0",
			id: "a",
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {} },
		});
		server.send(init.slice(0, 10));
		await new Promise((resolve) => setTimeout(resolve, 20));
		server.send(`${init.slice(10)}\r\n\n   \n`);
		assert.equal(
			(await server.waitFor((message) => message.id === "a")).result
				.protocolVersion,
			"2025-06-18",
		);
		const ping = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
		server.send(`${ping(1)}\n${ping(2)}\n${ping(3)}`);
		assert.deepEqual((await server.waitFor((m) => m.id === 1)).result, {});
		assert.deepEqual((await server.waitFor((m) => m.id === 2)).result, {});
		server.child.stdin.end();
		assert.deepEqual((await server.waitFor((m) => m.id === 3)).result, {});
		assert.deepEqual(await server.exited, { code: 0, signal: null });
		assertProtocolOnly(server);
	});
});

test("JSON-RPC errors use the standard codes", async (t) => {
	await withServer(t, async (server) => {
		server.send("{not json\n");
		const parse = await server.waitFor((m) => m.error?.code === -32700);
		assert.equal(parse.id, null);

		server.sendJson({ id: "no-jsonrpc", method: "ping" });
		assert.equal(
			(await server.waitFor((m) => m.id === "no-jsonrpc")).error.code,
			-32600,
		);
		server.sendJson({ jsonrpc: "2.0", id: null, method: "ping" });
		assert.equal(
			(await server.waitFor((m) => m.id === null && m.error?.code === -32600))
				.error.code,
			-32600,
		);
		server.send("42\n");
		await server.waitFor(
			(m) => m.id === null && /Invalid Request$/.test(m.error?.message ?? ""),
		);

		const early = await server.request("tools/list", {});
		assert.equal(early.error.code, -32600, "tools/list before initialize");
		assert.equal(
			(await server.request("initialize", { capabilities: {} })).error.code,
			-32602,
		);
		await server.initialize("2025-06-18");
		assert.equal(
			(await server.request("initialize", { protocolVersion: "2025-06-18" }))
				.error.code,
			-32600,
		);
		assert.equal(
			(await server.request("resources/list", {})).error.code,
			-32601,
		);
		assert.equal((await server.request("nope", {})).error.code, -32601);
		assert.equal(
			(await server.request("tools/call", { arguments: {} })).error.code,
			-32602,
		);
		assert.equal(
			(await server.request("tools/call", { name: "other", arguments: {} }))
				.error.code,
			-32602,
		);
		assert.equal(
			(
				await server.request("tools/call", {
					name: "workflow_artifact",
					arguments: [1],
				})
			).error.code,
			-32602,
		);
		// Invalid tool arguments are a tool-level error the model can correct.
		const bad = await server.request("tools/call", {
			name: "workflow_artifact",
			arguments: { action: "delete" },
		});
		assert.equal(bad.result.isError, true);
		assert.match(bad.result.content[0].text, /artifact_read_failed/);
		// Batches are not part of 2025-06-18.
		server.send(
			`${JSON.stringify([{ jsonrpc: "2.0", id: "batched", method: "ping" }])}\n`,
		);
		await server.waitFor(
			(m) =>
				m.id === null &&
				/batches are not supported/.test(m.error?.message ?? ""),
		);
		// Notifications and stray responses get no answer.
		server.notify("notifications/cancelled", { requestId: 1 });
		server.sendJson({ jsonrpc: "2.0", id: "stray", result: {} });
		assert.deepEqual((await server.request("ping")).result, {});
		assert.equal(
			server.lines.some((line) => JSON.parse(line).id === "stray"),
			false,
		);
		await server.close();
		assertProtocolOnly(server);
	});
});

test("2025-03-26 sessions accept JSON-RPC batches", async (t) => {
	await withServer(t, async (server) => {
		await server.initialize("2025-03-26");
		server.send(
			`${JSON.stringify([
				{ jsonrpc: "2.0", id: 10, method: "ping" },
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 11, method: "tools/list" },
				{ jsonrpc: "2.0", id: 12, method: "missing" },
			])}\n`,
		);
		const batch = await server.waitFor((m) => Array.isArray(m));
		assert.deepEqual(
			batch.map((entry) => entry.id),
			[10, 11, 12],
		);
		assert.deepEqual(batch[0].result, {});
		assert.equal(batch[1].result.tools[0].name, "workflow_artifact");
		assert.equal(batch[2].error.code, -32601);
		server.send("[]\n");
		await server.waitFor((m) => /empty batch/.test(m.error?.message ?? ""));
		await server.close();
	});
});

test("EOF drains an in-flight read (ledger row recorded) and exits 0", async (t) => {
	await withServer(t, async (server, fixture) => {
		await server.initialize();
		server.sendJson({
			jsonrpc: "2.0",
			id: "eof-read",
			method: "tools/call",
			params: {
				name: "workflow_artifact",
				arguments: { action: "read", source: "producer", artifact: "analysis" },
			},
		});
		server.child.stdin.end();
		const response = await server.waitFor((m) => m.id === "eof-read");
		assert.equal(response.result.isError, false);
		assert.deepEqual(await server.exited, { code: 0, signal: null });
		const ledger = (await readFile(fixture.ledgerPath, "utf8"))
			.trim()
			.split("\n");
		assert.equal(ledger.length, 1);
	});
});

test("SIGTERM exits gracefully with status 0", async (t) => {
	await withServer(t, async (server) => {
		await server.initialize();
		server.child.kill("SIGTERM");
		assert.deepEqual(await server.exited, { code: 0, signal: null });
		assertProtocolOnly(server);
		assert.equal(server.stderr, "");
	});
});
