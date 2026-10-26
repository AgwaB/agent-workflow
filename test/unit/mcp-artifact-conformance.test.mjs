// New in agent-workflow (WP5): the WP9a conformance MCP checks (`mcp.*`) applied to the real
// workflow_artifact server. The kit's `mcp.*` checks drive an executor with the kit's stub server;
// the server-side half of each check is exercised here with the kit's own MCP client
// (`callMcpTool`) against the launch spec core hands to executors.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { artifactMcpServerSpec } from "../../dist/core/artifact-access.js";
import {
	CONFORMANCE_CATALOG,
	callMcpTool,
	MCP_SECRET_ENV,
} from "../../dist/sdk/conformance/index.js";
import { artifactMcpServerSpecWithOutputLimit } from "../../dist/mcp/artifact-server/index.js";
import { createRunFixture } from "../fixtures/mcp/helpers.mjs";

const SECRET = "conformance-secret-5d2a91";

test("the kit catalog still defines the mcp.* checks this file mirrors", () => {
	const ids = (CONFORMANCE_CATALOG ?? []).map((check) => check.id);
	for (const id of [
		"mcp.injection",
		"mcp.argv_no_secrets",
		"mcp.delivery_bound",
	])
		assert.ok(ids.includes(id), id);
});

test("mcp.injection: the core launch spec starts the server and its tool result arrives", async (t) => {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const spec = {
		...artifactMcpServerSpec(fixture.config),
		env: { [MCP_SECRET_ENV]: SECRET },
	};
	const listed = await callMcpTool(spec, "workflow_artifact", {
		action: "list",
	});
	assert.deepEqual(listed.tools, ["workflow_artifact"]);
	assert.equal(listed.isError, false);
	assert.equal(JSON.parse(listed.text).sources[0].source, "producer");
	const read = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
		maxItems: 1,
	});
	assert.equal(read.isError, false);
	assert.match(read.text, /"c1"/);
	const failed = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "unknown",
		artifact: "control",
	});
	assert.equal(failed.isError, true);
});

test("mcp.argv_no_secrets: argv carries only paths; env secrets never reach argv, ledger or output", async (t) => {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const spec = {
		...artifactMcpServerSpecWithOutputLimit(fixture.config, 4096),
		env: { [MCP_SECRET_ENV]: SECRET },
	};
	assert.deepEqual(spec.args.slice(1), [
		"--config",
		join(fixture.taskDir, "artifact-access.json"),
		"--max-output-chars",
		"4096",
	]);
	for (const arg of spec.args) assert.ok(!arg.includes(SECRET));
	const result = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "producer",
		artifact: "analysis",
	});
	assert.ok(!JSON.stringify(result.raw).includes(SECRET));
	const ledger = await readFile(fixture.ledgerPath, "utf8");
	assert.ok(!ledger.includes(SECRET));
	assert.ok(!(await readFile(fixture.configPath, "utf8")).includes(SECRET));
});

test("mcp.delivery_bound: output served at 2x the declared limit is delivered within it", async (t) => {
	const fixture = await createRunFixture();
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	const limit = 4096; // the fake harness default mcpOutputLimitChars
	await writeFile(
		join(fixture.producerDir, "analysis.md"),
		"z".repeat(limit * 2),
	);
	const spec = artifactMcpServerSpecWithOutputLimit(fixture.config, limit);
	const result = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "producer",
		artifact: "analysis",
	});
	assert.ok(result.text.length <= limit, `delivered ${result.text.length}`);
	const [row] = (await readFile(fixture.ledgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(row.bytes, limit * 2);
	assert.equal(row.truncated, true);
	assert.equal(row.deliveryUnverified, true);
});
