// test-tier: integration
// New in agent-workflow (WP5): interop proof against the official MCP TypeScript SDK client
// (@modelcontextprotocol/sdk, devDependency only) over a real stdio transport.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	CallToolResultSchema,
	InitializeResultSchema,
	LATEST_PROTOCOL_VERSION,
	ListToolsResultSchema,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

import {
	WORKFLOW_ARTIFACT_TOOL_DESCRIPTION,
	WORKFLOW_ARTIFACT_TOOL_PARAMETERS,
} from "../../dist/core/artifact-access.js";
import {
	MCP_LATEST_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "../../dist/mcp/artifact-server/index.js";
import {
	createRunFixture,
	SERVER,
	startServer,
} from "../fixtures/mcp/helpers.mjs";

test("supported protocol versions come from the official SDK constants", () => {
	assert.equal(MCP_LATEST_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION);
	// Every published revision the SDK supports, minus the pre-release 2024-10-07 draft.
	assert.deepEqual(
		[...MCP_SUPPORTED_PROTOCOL_VERSIONS],
		SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version !== "2024-10-07"),
	);
});

test("official SDK stdio client: connect, list tools, call tool, close", async (t) => {
	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER, "--config", fixture.configPath],
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = new Client({ name: "aw-sdk-interop", version: "0.0.0" });
	await client.connect(transport);
	t.after(() => client.close().catch(() => undefined));

	assert.equal(client.getServerVersion()?.name, "agent-workflow-artifact");
	assert.deepEqual(client.getServerCapabilities(), {
		tools: { listChanged: false },
	});
	assert.match(client.getInstructions() ?? "", /workflow_artifact/);

	const { tools } = await client.listTools();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "workflow_artifact");
	assert.equal(tools[0].description, WORKFLOW_ARTIFACT_TOOL_DESCRIPTION);
	assert.deepEqual(tools[0].inputSchema, WORKFLOW_ARTIFACT_TOOL_PARAMETERS);

	const listed = await client.callTool({
		name: "workflow_artifact",
		arguments: { action: "list" },
	});
	assert.equal(listed.isError, false);
	const list = JSON.parse(listed.content[0].text);
	assert.deepEqual(
		list.sources.map((source) => [source.source, source.artifacts]),
		[["producer", ["control", "analysis", "refs", "raw"]]],
	);

	const read = await client.callTool({
		name: "workflow_artifact",
		arguments: { action: "read", source: "producer", artifact: "analysis" },
	});
	assert.equal(read.isError, false);
	assert.match(
		read.content[0].text,
		/^# workflow_artifact: producer\.analysis/,
	);
	assert.match(read.content[0].text, /Line three of the analysis/);
	assert.equal(read.structuredContent, undefined);

	const failed = await client.callTool({
		name: "workflow_artifact",
		arguments: { action: "read", source: "producer", artifact: "prompt" },
	});
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /not available in workflow-task/);

	await assert.rejects(
		client.callTool({ name: "missing_tool", arguments: {} }),
		/Unknown tool/,
	);
	assert.deepEqual(await client.ping(), {});

	await client.close();
	const ledger = (await readFile(fixture.ledgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		ledger.map((row) => [row.source, row.artifact, row.truncated]),
		[["producer", "analysis", false]],
	);
	assert.equal(stderr, "");
});

test("raw responses for every supported version validate against the SDK result schemas", async (t) => {
	for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
		const fixture = await createRunFixture();
		t.after(() =>
			rm(fixture.cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		const server = startServer(["--config", fixture.configPath]);
		t.after(() => server.child.kill("SIGKILL"));
		const init = await server.initialize(version);
		InitializeResultSchema.parse(init.result);
		ListToolsResultSchema.parse(
			(await server.request("tools/list", {})).result,
		);
		CallToolResultSchema.parse(await server.callTool({ action: "list" }));
		CallToolResultSchema.parse(
			await server.callTool({
				action: "read",
				source: "producer",
				artifact: "control",
			}),
		);
		CallToolResultSchema.parse(
			await server.callTool({
				action: "read",
				source: "nope",
				artifact: "control",
			}),
		);
		await server.close();
	}
});
