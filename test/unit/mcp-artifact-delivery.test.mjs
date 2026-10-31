// New in agent-workflow (WP5, R#9): the delivery bound. Responses never exceed the client's MCP
// output limit; a cut read is recorded `truncated: true` + `deliveryUnverified: true`, so it can
// never satisfy a required read. WP5b: an oversized whole-artifact read is served as its first
// page (test/unit/mcp-artifact-paging.test.mjs); projections and lists are still cut.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { artifactMcpServerSpec } from "../../dist/core/artifact-access.js";
import { EXPERIMENTAL_TOOL_DEDUP_ENV } from "../../dist/core/experimental-speed-flags.js";
import { readWorkflowArtifactReadLedger } from "../../dist/core/workflow-artifact-tool.js";
import {
	artifactMcpServerSpecWithOutputLimit,
	cutToDeliveryBudget,
	DEFAULT_MCP_OUTPUT_LIMIT_CHARS,
	fitsDeliveryLimit,
	MIN_MCP_OUTPUT_LIMIT_CHARS,
} from "../../dist/mcp/artifact-server/index.js";
import {
	createRunFixture,
	resultText,
	runServerToExit,
	startServer,
} from "../fixtures/mcp/helpers.mjs";

const BIG_ANALYSIS = Array.from(
	{ length: 400 },
	(_, index) => `analysis line ${index} ${"x".repeat(40)}`,
).join("\n"); // ~20 KB, below the core 50 KB / 2000-line read cap

/**
 * Same predicate as pi-workflow's required-read check (`requiredArtifactReadSatisfied`:
 * `!entry.truncated`), extended with the WP5 rule the engine adopts (WP4c-1):
 * `deliveryUnverified` rows never count.
 */
function satisfiesRequiredRead(rows, source, artifact) {
	return rows.some(
		(row) =>
			!row.truncated &&
			row.deliveryUnverified !== true &&
			row.source === source &&
			row.artifact === artifact,
	);
}

async function setup(t, args, options = {}) {
	const fixture = await createRunFixture(options.fixture);
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	await writeFile(join(fixture.producerDir, "analysis.md"), BIG_ANALYSIS);
	if (options.analysis !== undefined)
		await writeFile(join(fixture.producerDir, "analysis.md"), options.analysis);
	const server = startServer(["--config", fixture.configPath, ...args], {
		env: options.env,
	});
	t.after(() => server.child.kill("SIGKILL"));
	await server.initialize();
	const rows = async () =>
		(await readFile(fixture.ledgerPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { fixture, server, rows };
}

test("delivery helpers count UTF-16 chars and UTF-8 bytes, never split surrogate pairs", () => {
	assert.equal(fitsDeliveryLimit("abc", 3), true);
	assert.equal(fitsDeliveryLimit("é", 1), false, "2 UTF-8 bytes");
	assert.equal(fitsDeliveryLimit("😀", 2), false, "4 UTF-8 bytes");
	assert.equal(cutToDeliveryBudget("ab😀cd", 4), "ab");
	assert.equal(cutToDeliveryBudget("ab😀cd", 6), "ab😀");
	assert.equal(cutToDeliveryBudget("한국어", 7), "한국");
	assert.equal(cutToDeliveryBudget("short", 100), "short");
});

const BIG_CLAIMS = JSON.stringify({
	claims: Array.from({ length: 200 }, (_, index) => ({
		id: `c${index}`,
		text: `claim ${index} ${"y".repeat(30)}`,
	})),
});

test("a client limit cuts a projection, flags the ledger row and never satisfies a required read", async (t) => {
	const limit = 1000;
	const { server, rows, fixture } = await setup(t, [
		"--max-output-chars",
		String(limit),
	]);
	await writeFile(join(fixture.producerDir, "control.json"), BIG_CLAIMS);
	const result = await server.callTool({
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
	});
	const text = resultText(result);
	assert.equal(result.isError, false);
	assert.ok(text.length <= limit, `${text.length} chars`);
	assert.ok(Buffer.byteLength(text) <= limit);
	assert.match(
		text,
		/^# workflow_artifact: producer\.control path=\$\.claims\n\n/,
	);
	assert.match(
		text,
		/delivery bound: response cut to the client limit of 1000 chars/,
	);
	assert.match(text, /does not satisfy required reads/);
	const [row] = await rows();
	assert.equal(row.truncated, true);
	assert.equal(row.deliveryUnverified, true);
	assert.equal(row.bytes, Buffer.byteLength(BIG_CLAIMS));
	const header = "# workflow_artifact: producer.control path=$.claims\n\n";
	const notice = text.slice(
		text.indexOf("\n\n[workflow_artifact delivery bound"),
	);
	assert.equal(
		row.returnedBytes,
		Buffer.byteLength(text.slice(header.length, text.length - notice.length)),
	);
	assert.equal(
		satisfiesRequiredRead(await rows(), "producer", "control"),
		false,
	);

	// A small read still fits: clean row, satisfies the requirement.
	await server.callTool({
		action: "read",
		source: "producer",
		artifact: "refs",
	});
	const all = await rows();
	assert.equal("deliveryUnverified" in all[1], false);
	assert.equal(satisfiesRequiredRead(all, "producer", "refs"), true);
	// The core ledger reader still parses the rows (it drops the extra flag; see docs/mcp.md).
	const parsed = await readWorkflowArtifactReadLedger(fixture.ledgerPath);
	assert.deepEqual(
		parsed.map((row) => row.truncated),
		[true, false],
	);
});

test("without a client limit the conservative default applies (first page of a whole read)", async (t) => {
	assert.equal(DEFAULT_MCP_OUTPUT_LIMIT_CHARS, 8192);
	const { server, rows } = await setup(t, []);
	const text = resultText(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
	);
	assert.ok(text.length <= DEFAULT_MCP_OUTPUT_LIMIT_CHARS);
	assert.match(text, /call again with offset=\d+ to continue\]$/);
	const [row] = await rows();
	assert.equal(row.deliveryUnverified, false);
	assert.equal(row.truncated, true);
	assert.equal(row.rangeStart, 0);
	assert.ok(row.rangeEnd > 7000 && row.rangeEnd < BIG_ANALYSIS.length);
	assert.equal(row.totalChars, BIG_ANALYSIS.length);
});

test("multi-byte content is bounded in bytes as well as chars", async (t) => {
	const analysis = "한국어 텍스트와 😀 이모지\n".repeat(300);
	const { server, rows } = await setup(t, ["--max-output-chars", "600"], {
		analysis,
	});
	const text = resultText(
		await server.callTool({
			action: "read",
			source: "producer",
			artifact: "analysis",
		}),
	);
	assert.ok(Buffer.byteLength(text) <= 600, `${Buffer.byteLength(text)} bytes`);
	assert.doesNotMatch(text, /\uFFFD/);
	const [row] = await rows();
	assert.equal(row.deliveryUnverified, false);
	assert.equal(row.truncated, true);
	assert.equal(
		row.returnedBytes,
		Buffer.byteLength(analysis.slice(row.rangeStart, row.rangeEnd)),
	);
});

test("projected reads that fit are clean; oversized projections are cut and flagged", async (t) => {
	const claims = Array.from({ length: 200 }, (_, index) => ({
		id: `c${index}`,
		text: `claim ${index} ${"y".repeat(30)}`,
	}));
	const { server, rows, fixture } = await setup(t, [
		"--max-output-chars",
		"2000",
	]);
	await writeFile(
		join(fixture.producerDir, "control.json"),
		JSON.stringify({ claims }),
	);
	await server.callTool({
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
		maxItems: 3,
	});
	await server.callTool({
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
	});
	const [small, big] = await rows();
	assert.equal(small.deliveryUnverified, undefined);
	assert.equal(small.maxItems, 3);
	assert.equal(big.deliveryUnverified, true);
	assert.equal(big.truncated, true);
	assert.equal(big.path, "$.claims");
});

test("a duplicate-suppressed re-read of a cut read stays deliveryUnverified", async (t) => {
	const { server, rows, fixture } = await setup(
		t,
		["--max-output-chars", "1000"],
		{
			env: { [EXPERIMENTAL_TOOL_DEDUP_ENV]: "1" },
		},
	);
	await writeFile(join(fixture.producerDir, "control.json"), BIG_CLAIMS);
	const args = {
		action: "read",
		source: "producer",
		artifact: "control",
		path: "$.claims",
	};
	await server.callTool(args);
	const duplicate = resultText(await server.callTool(args));
	assert.match(duplicate, /duplicate read suppressed/);
	const [first, second] = await rows();
	assert.equal(first.deliveryUnverified, true);
	assert.equal(second.returnedBytes, 0);
	assert.equal(second.truncated, true);
	assert.equal(second.deliveryUnverified, true);
	assert.equal(
		satisfiesRequiredRead(await rows(), "producer", "control"),
		false,
	);
});

test("list output is bounded too and writes no ledger row", async (t) => {
	const sources = Array.from({ length: 40 }, (_, index) => ({
		source: `producer-${index}`,
		status: "completed",
		lastMessage: "m".repeat(200),
		artifacts: {},
	}));
	const { server, fixture } = await setup(t, ["--max-output-chars", "1500"], {
		fixture: { sources },
	});
	const text = resultText(await server.callTool({ action: "list" }));
	assert.ok(text.length <= 1500);
	assert.match(text, /delivery bound: response cut to 1500 chars/);
	await assert.rejects(readFile(fixture.ledgerPath), { code: "ENOENT" });
});

test("invalid --max-output-chars values refuse to start", async (t) => {
	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	for (const value of [
		"0",
		"-5",
		"abc",
		"1.5",
		String(MIN_MCP_OUTPUT_LIMIT_CHARS - 1),
		"99999999999",
	]) {
		const result = await runServerToExit([
			"--config",
			fixture.configPath,
			"--max-output-chars",
			value,
		]);
		assert.equal(result.code, 2, value);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /--max-output-chars/);
	}
});

test("artifactMcpServerSpecWithOutputLimit appends the flag to the core spec", async (t) => {
	const fixture = await createRunFixture();
	t.after(() =>
		rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const base = artifactMcpServerSpec(fixture.config);
	assert.deepEqual(artifactMcpServerSpecWithOutputLimit(fixture.config, null), {
		...base,
		args: [...base.args],
	});
	const spec = artifactMcpServerSpecWithOutputLimit(fixture.config, 4096);
	assert.deepEqual(spec.args, [...base.args, "--max-output-chars", "4096"]);
	assert.throws(() => artifactMcpServerSpecWithOutputLimit(fixture.config, 10));
	// The core spec points at the built server this suite exercises.
	assert.match(
		base.args[0],
		/dist[/\\]mcp[/\\]artifact-server[/\\]server\.js$/,
	);
	const server = startServer(spec.args.slice(1));
	t.after(() => server.child.kill("SIGKILL"));
	assert.equal(
		(await server.initialize()).result.serverInfo.name,
		"agent-workflow-artifact",
	);
	await server.close();
});
