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
import { checkRequiredArtifactReads } from "../../dist/core/required-reads.js";
import { artifactMcpServerSpecWithOutputLimit } from "../../dist/mcp/artifact-server/index.js";
import { artifactServerOutputLimit } from "../../dist/sdk/index.js";
import { createRunFixture } from "../fixtures/mcp/helpers.mjs";

const SECRET = "conformance-secret-5d2a91";

test("the kit catalog still defines the mcp.* checks this file mirrors", () => {
	const ids = (CONFORMANCE_CATALOG ?? []).map((check) => check.id);
	for (const id of [
		"mcp.injection",
		"mcp.argv_no_secrets",
		"mcp.delivery_bound",
		"mcp.paged_read",
	])
		assert.ok(ids.includes(id), id);
});

test("mcp.injection: the core launch spec starts the server and its tool result arrives", async (t) => {
	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
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
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
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
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const limit = 4096; // the fake harness default mcpOutputLimitChars
	await writeFile(
		join(fixture.producerDir, "analysis.md"),
		"z".repeat(limit * 2),
	);
	await writeFile(
		join(fixture.producerDir, "control.json"),
		JSON.stringify({ claims: ["w".repeat(limit * 2)] }),
	);
	const spec = artifactMcpServerSpecWithOutputLimit(fixture.config, limit);
	// A whole read is paged (WP5b): the first page fits and is verified, not cut.
	const page = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "producer",
		artifact: "analysis",
	});
	assert.ok(page.text.length <= limit, `delivered ${page.text.length}`);
	// A projection that does not fit is cut and flagged.
	const cut = await callMcpTool(spec, "workflow_artifact", {
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
	});
	assert.ok(cut.text.length <= limit, `delivered ${cut.text.length}`);
	const [pageRow, cutRow] = (await readFile(fixture.ledgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(pageRow.bytes, limit * 2);
	assert.equal(pageRow.truncated, true);
	assert.equal(pageRow.deliveryUnverified, false);
	assert.equal(pageRow.rangeStart, 0);
	assert.equal(cutRow.truncated, true);
	assert.equal(cutRow.deliveryUnverified, true);
});

test("mcp.paged_read: a 3x-limit artifact is delivered completely through pages within the declared limit", async (t) => {
	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const declared = 4096; // the fake harness default mcpOutputLimitChars
	const pageLimit = artifactServerOutputLimit({
		mcpOutputLimitChars: declared,
	});
	assert.equal(pageLimit, 3840);
	const analysis = Array.from(
		{ length: 400 },
		(_, index) => `${index} ${"ü😀".repeat(5)} line`,
	).join("\n");
	assert.ok(analysis.length > declared * 2);
	await writeFile(join(fixture.producerDir, "analysis.md"), analysis);
	const spec = artifactMcpServerSpecWithOutputLimit(fixture.config, pageLimit);
	const pages = [];
	let offset = 0;
	while (offset !== undefined) {
		const result = await callMcpTool(spec, "workflow_artifact", {
			action: "read",
			source: "producer",
			artifact: "analysis",
			offset,
		});
		assert.equal(result.isError, false, result.text);
		assert.ok(result.text.length <= declared);
		assert.ok(Buffer.byteLength(result.text) <= declared);
		const match =
			/^# workflow_artifact: producer\.analysis\n\n([\s\S]*)\n\n\[workflow_artifact page: chars (\d+)–(\d+) of (\d+); (?:call again with offset=(\d+) to continue|end of artifact)\]$/u.exec(
				result.text,
			);
		assert.ok(match);
		assert.equal(Number(match[2]), offset);
		pages.push(match[1]);
		offset = match[5] === undefined ? undefined : Number(match[5]);
	}
	assert.ok(pages.length >= 3);
	assert.equal(pages.join(""), analysis);
	assert.deepEqual(
		await checkRequiredArtifactReads(fixture.taskDir, ["producer.analysis"]),
		{ missing: [], projectionFailures: [] },
	);
});
