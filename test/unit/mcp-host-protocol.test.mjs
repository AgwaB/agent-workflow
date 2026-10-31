// New in agent-workflow (WP13): the built `agent-workflow` host MCP server process: startup
// arguments (`--host` required and checked), the guarded test-executor hook refusing to start,
// stdio framing and lifecycle through the shared protocol layer (src/mcp/stdio-server.ts), and
// stdout carrying protocol only.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { spawnHostServer } from "../helpers/mcp-host-client.mjs";

const protocol = await import("../../dist/mcp/artifact-server/index.js");

let cwd;
const servers = [];

before(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-mcp-host-proto-")));
});
after(async () => {
	for (const server of servers.splice(0)) server.kill();
	await rm(cwd, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function start(options = {}) {
	const server = spawnHostServer({
		cwd,
		env: { AGENT_WORKFLOW_HOME: join(cwd, "home"), ...options.env },
		...(options.args ? { args: options.args } : {}),
	});
	servers.push(server);
	return server;
}

function assertProtocolOnly(server) {
	for (const line of server.lines) {
		const message = JSON.parse(line);
		for (const entry of Array.isArray(message) ? message : [message])
			assert.equal(entry.jsonrpc, "2.0", line);
	}
}

test("startup: --host is required and must be claude-code, codex or generic", async () => {
	for (const [args, pattern] of [
		[[], /--host is required/],
		[
			["--host", "vscode"],
			/unknown --host vscode \(expected claude-code, codex, generic\)/,
		],
		[["--host", "codex", "--bogus"], /Unknown option '--bogus'/],
	]) {
		const server = start({ args });
		server.child.stdin.end();
		const { code } = await server.exited;
		assert.equal(code, 2, args.join(" "));
		assert.match(server.stderr(), pattern);
		assert.match(server.stderr(), /usage: agent-workflow-mcp --host/);
		assert.deepEqual(server.lines, []);
	}
	for (const host of ["claude-code", "codex", "generic"]) {
		const server = start({ args: ["--host", host] });
		const init = await server.initialize();
		assert.equal(init.result.serverInfo.name, "agent-workflow");
		assert.equal((await server.close()).code, 0);
	}
});

test("startup: a misconfigured test-executor hook refuses to start", async () => {
	const server = start({
		env: { AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: "/nonexistent/hook.mjs" },
	});
	server.child.stdin.end();
	const { code } = await server.exited;
	assert.equal(code, 1);
	assert.match(
		server.stderr(),
		/refusing to start: .*AGENT_WORKFLOW_TEST_EXECUTOR_ACK is not "test-only"/,
	);
});

test("framing and lifecycle: negotiation, not-initialized, parse errors, CRLF, ping, EOF drain", async () => {
	for (const version of [
		...protocol.MCP_SUPPORTED_PROTOCOL_VERSIONS,
		"2099-01-01",
	]) {
		const server = start();
		const init = await server.initialize(version);
		assert.equal(
			init.result.protocolVersion,
			protocol.MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version)
				? version
				: protocol.MCP_LATEST_PROTOCOL_VERSION,
		);
		await server.close();
	}
	const server = start();
	const early = await server.request("tools/list");
	assert.equal(early.error.code, -32600);
	assert.match(early.error.message, /not initialized/);
	await server.initialize("2025-06-18");
	assert.equal(
		(await server.request("initialize", { protocolVersion: "2025-06-18" }))
			.error.code,
		-32600,
	);
	server.send("{not json\n");
	await server.waitFor(
		(message) => message.id === null && message.error?.code === -32700,
	);
	server.send(
		`${JSON.stringify({ jsonrpc: "2.0", id: "crlf", method: "ping" })}\r\n`,
	);
	assert.deepEqual(
		(await server.waitFor((message) => message.id === "crlf")).result,
		{},
	);
	server.send(
		`${JSON.stringify([{ jsonrpc: "2.0", id: "b", method: "ping" }])}\n`,
	);
	await server.waitFor(
		(message) =>
			message.id === null &&
			/batches are not supported/.test(message.error?.message ?? ""),
	);
	// A stray response (no pending server request) is ignored.
	server.sendJson({ jsonrpc: "2.0", id: "aw-server-99", result: {} });
	const listed = await server.call("workflow_list", { limit: 1 });
	assert.equal(listed.isError, false);
	assert.equal(listed.structuredContent.data.workflows.length, 1);
	// The last line without a newline is still served before the server exits on EOF.
	server.send(JSON.stringify({ jsonrpc: "2.0", id: "last", method: "ping" }));
	const { code } = await server.close();
	assert.equal(code, 0);
	assert.ok(server.messages.some((message) => message.id === "last"));
	assertProtocolOnly(server);
});
