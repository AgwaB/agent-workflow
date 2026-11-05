// MCP artifact results and read-ledger rows match the core tool for the same run fixture.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { EXPERIMENTAL_TOOL_DEDUP_ENV } from "../../dist/core/experimental-speed-flags.js";
import {
	handleWorkflowArtifactToolCall,
	readWorkflowArtifactReadLedger,
	WORKFLOW_ARTIFACT_READ_SCHEMA,
} from "../../dist/core/workflow-artifact-tool.js";
import { workflowArtifactFailureResult } from "../../dist/core/artifact-access.js";
import {
	createRunFixture,
	resultText,
	startServer,
} from "../fixtures/mcp/helpers.mjs";

const CALLS = [
	{ action: "list" },
	{ action: "read", source: "producer", artifact: "analysis" },
	{
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
		maxItems: 2,
	},
	{
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
		maxChars: 20,
	},
	{
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.questions",
	},
	{ action: "read", source: "producer", artifact: "refs" },
	{ action: "read", source: "producer", artifact: "raw" },
	{ action: "read", source: "producer", artifact: "prompt" },
	{
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.missing",
	},
	{ action: "read", source: "producer", artifact: "analysis" },
];

async function coreCall(args, config) {
	try {
		const result = await handleWorkflowArtifactToolCall(args, config);
		return { text: resultText(result), isError: false };
	} catch (error) {
		return {
			text: resultText(workflowArtifactFailureResult(error, config)),
			isError: true,
		};
	}
}

async function ledgerLines(path) {
	try {
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

const withoutAt = (line) => {
	const { at, ...rest } = JSON.parse(line);
	assert.ok(Number.isFinite(Date.parse(at)), `at must be an ISO time: ${at}`);
	return rest;
};

async function compare(t, { fixtureOptions = {}, env = {}, calls = CALLS }) {
	const fixture = await createRunFixture(fixtureOptions);
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const server = startServer(
		["--config", fixture.configPath, "--max-output-chars", "1000000"],
		{ env },
	);
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	const coreLedger = join(fixture.taskDir, "core-read-ledger.jsonl");
	const coreConfig = { ...fixture.config, ledgerPath: coreLedger };
	delete coreConfig.version;
	const saved = Object.fromEntries(
		Object.keys(env).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, env);
	try {
		for (const args of calls) {
			const served = await server.callTool(args);
			const direct = await coreCall(args, coreConfig);
			assert.equal(resultText(served), direct.text, JSON.stringify(args));
			assert.equal(served.isError, direct.isError, JSON.stringify(args));
		}
	} finally {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
	await server.close();
	const servedRows = await ledgerLines(fixture.ledgerPath);
	const coreRows = await ledgerLines(coreLedger);
	assert.deepEqual(servedRows.map(withoutAt), coreRows.map(withoutAt));
	// Byte format matches too: same key order, one JSON object per line.
	assert.deepEqual(
		servedRows.map((line) => Object.keys(JSON.parse(line))),
		coreRows.map((line) => Object.keys(JSON.parse(line))),
	);
	return { fixture, servedRows };
}

test("list/read text and ledger rows match the core tool", async (t) => {
	const { fixture, servedRows } = await compare(t, {});
	const rows = servedRows.map((line) => JSON.parse(line));
	assert.deepEqual(
		rows.map((row) => [row.artifact, row.path ?? null, row.truncated]),
		[
			["analysis", null, false],
			["control", "$.claims", true], // maxItems 2 of 4: itemsTruncated
			["control", "$.claims", true], // maxChars 20: charsTruncated
			["control", "$.researchQuestions", false],
			["refs", null, false],
			["raw", null, false],
			["analysis", null, false],
		],
	);
	for (const row of rows) {
		assert.equal(row.schema, WORKFLOW_ARTIFACT_READ_SCHEMA);
		assert.equal(row.runId, fixture.config.runId);
		assert.equal(row.taskId, fixture.config.taskId);
		assert.equal("deliveryUnverified" in row, false);
	}
	assert.deepEqual(rows[5].rawAssurance, {
		kind: "independent_unattested",
		originalBytes: "unattested",
	});
	// The engine's reader accepts every row the server wrote.
	const parsed = await readWorkflowArtifactReadLedger(fixture.ledgerPath);
	assert.equal(parsed.length, rows.length);
});

test("core maxBytes truncation is recorded exactly like the core tool", async (t) => {
	const { servedRows } = await compare(t, {
		fixtureOptions: { maxBytes: 40 },
		calls: [{ action: "read", source: "producer", artifact: "control" }],
	});
	const [row] = servedRows.map((line) => JSON.parse(line));
	assert.equal(row.truncated, true);
	assert.equal(row.returnedBytes, 40);
	assert.equal("deliveryUnverified" in row, false);
});

test("duplicate-read suppression (experimental dedup flag) matches the core tool", async (t) => {
	const { servedRows } = await compare(t, {
		env: { [EXPERIMENTAL_TOOL_DEDUP_ENV]: "1" },
		calls: [
			{ action: "read", source: "producer", artifact: "analysis" },
			{ action: "read", source: "producer", artifact: "analysis" },
			{
				action: "read",
				source: "producer",
				artifact: "control",
				path: "$.claims",
				maxItems: 1,
			},
			{
				action: "read",
				source: "producer",
				artifact: "control",
				path: "$.claims",
				maxItems: 1,
			},
			{ action: "read", source: "producer", artifact: "raw" },
			{ action: "read", source: "producer", artifact: "raw" },
		],
	});
	const rows = servedRows.map((line) => JSON.parse(line));
	assert.deepEqual(
		rows.map((row) => [row.artifact, row.returnedBytes === 0]),
		[
			["analysis", false],
			["analysis", true],
			["control", false],
			["control", true],
			["raw", false],
			["raw", false],
		],
	);
});

test("running sources are re-read (no completed-read cache), like the core tool", async (t) => {
	await compare(t, {
		fixtureOptions: { status: "running" },
		calls: [
			{ action: "read", source: "producer", artifact: "analysis" },
			{ action: "read", source: "producer", artifact: "analysis" },
		],
	});
});
