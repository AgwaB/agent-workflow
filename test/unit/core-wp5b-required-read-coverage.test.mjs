// New in agent-workflow (WP5b): read-ledger page rows and the coverage rule for required reads.
// A whole-artifact required read is satisfied by one whole verified row (as before) or by verified
// page rows (deliveryUnverified: false) of ONE artifact version (contentSha256) that cover
// [0, totalChars) in any order, overlaps allowed. Gaps, unverified pages and mixed versions fail.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	checkRequiredArtifactReads,
	formatRequiredReadFailureMessage,
} from "../../dist/core/required-reads.js";
import { readWorkflowArtifactReadLedger } from "../../dist/core/workflow-artifact-tool.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TOTAL = 1000;

function row(fields = {}) {
	return {
		schema: "workflow-artifact-read-v1",
		runId: "run",
		taskId: "consumer",
		source: "producer",
		artifact: "analysis",
		at: "2026-10-27T00:00:00.000Z",
		bytes: TOTAL,
		returnedBytes: 10,
		truncated: false,
		...fields,
	};
}

function page(start, end, fields = {}) {
	return row({
		returnedBytes: end - start,
		truncated: !(start === 0 && end === TOTAL),
		rangeStart: start,
		rangeEnd: end,
		totalChars: TOTAL,
		contentSha256: SHA_A,
		deliveryUnverified: false,
		...fields,
	});
}

async function ledgerDir(t, rows) {
	const dir = await mkdtemp(join(tmpdir(), "aw-wp5b-coverage-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(
		join(dir, "read-ledger.jsonl"),
		rows.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);
	return dir;
}

async function check(t, rows, required = ["producer.analysis"], policy = []) {
	return await checkRequiredArtifactReads(
		await ledgerDir(t, rows),
		required,
		policy,
	);
}

test("ledger rows: page fields round-trip; old shapes stay valid; inconsistent page fields are refused", async (t) => {
	const dir = await ledgerDir(t, [
		row(),
		row({ truncated: true, deliveryUnverified: true }),
		row({ path: "$.claims", maxItems: 2 }),
		page(0, 400),
	]);
	const parsed = await readWorkflowArtifactReadLedger(
		join(dir, "read-ledger.jsonl"),
	);
	assert.equal("rangeStart" in parsed[0], false);
	assert.equal("deliveryUnverified" in parsed[0], false);
	assert.equal(parsed[1].deliveryUnverified, true);
	assert.equal(parsed[2].path, "$.claims");
	assert.deepEqual(
		[
			parsed[3].rangeStart,
			parsed[3].rangeEnd,
			parsed[3].totalChars,
			parsed[3].contentSha256,
			parsed[3].deliveryUnverified,
			parsed[3].truncated,
		],
		[0, 400, TOTAL, SHA_A, false, true],
	);
	for (const bad of [
		{ ...page(0, 400), contentSha256: undefined },
		{ ...page(0, 400), rangeEnd: undefined },
		page(500, 400),
		page(0, TOTAL + 1),
		page(0, 400, { contentSha256: "XYZ" }),
		page(0, 400, { rangeStart: -1 }),
		page(0, 400, { path: "$" }),
	]) {
		const badDir = await ledgerDir(t, [bad]);
		await assert.rejects(
			readWorkflowArtifactReadLedger(join(badDir, "read-ledger.jsonl")),
			/invalid page range fields|must be a non-negative integer/,
			JSON.stringify(bad),
		);
	}
});

test("coverage satisfied: in order, out of order, with overlaps, or one whole page", async (t) => {
	for (const rows of [
		[page(0, 400), page(400, 800), page(800, TOTAL)],
		[page(800, TOTAL), page(0, 400), page(400, 800)],
		[page(0, 500), page(300, 900), page(850, TOTAL), page(100, 200)],
		[page(0, TOTAL)],
	]) {
		const result = await check(t, rows);
		assert.deepEqual(
			result,
			{ missing: [], projectionFailures: [] },
			JSON.stringify(rows.map((entry) => [entry.rangeStart, entry.rangeEnd])),
		);
	}
	// A legacy whole row still satisfies on its own.
	assert.deepEqual((await check(t, [row()])).missing, []);
});

test("coverage not satisfied: a gap names the missing ranges", async (t) => {
	const result = await check(t, [page(0, 300), page(500, 600), page(700, 900)]);
	assert.deepEqual(result.missing, ["producer.analysis"]);
	assert.deepEqual(result.incompleteCoverage, [
		"producer.analysis: paged read incomplete, missing chars 300–500, 600–700, 900–1000 of 1000",
	]);
	assert.match(
		formatRequiredReadFailureMessage(result),
		/^missing required workflow artifact reads: producer\.analysis; incomplete paged reads \(read the missing ranges with offset\): producer\.analysis: paged read incomplete, missing chars 300–500, 600–700, 900–1000 of 1000$/u,
	);
});

test("coverage not satisfied: an unverified or cut page never counts", async (t) => {
	for (const bad of [
		page(400, 800, { deliveryUnverified: true }),
		page(400, 800, { deliveryUnverified: undefined }),
	]) {
		const result = await check(t, [page(0, 400), bad, page(800, TOTAL)]);
		assert.deepEqual(result.missing, ["producer.analysis"]);
		assert.deepEqual(result.incompleteCoverage, [
			"producer.analysis: paged read incomplete, missing chars 400–800 of 1000",
		]);
	}
	// A cut whole page (the server flags it truncated + deliveryUnverified) does not count either.
	const cut = await check(t, [
		page(0, TOTAL, { truncated: true, deliveryUnverified: true }),
	]);
	assert.deepEqual(cut.missing, ["producer.analysis"]);
	assert.equal(cut.incompleteCoverage, undefined);
});

test("coverage not satisfied: pages of different artifact versions do not combine", async (t) => {
	const result = await check(t, [
		page(0, 600),
		page(600, TOTAL, { contentSha256: SHA_B }),
	]);
	assert.deepEqual(result.missing, ["producer.analysis"]);
	assert.deepEqual(result.incompleteCoverage, [
		"producer.analysis: paged read incomplete, missing chars 600–1000 of 1000 (pages of 2 artifact versions; pages of different versions do not combine)",
	]);
	// Re-reading the changed version completely satisfies the requirement.
	assert.deepEqual(
		(
			await check(t, [
				page(0, 600),
				page(600, TOTAL, { contentSha256: SHA_B }),
				page(0, 600, { contentSha256: SHA_B }),
			])
		).missing,
		[],
	);
});

test("coverage scope: other sources, projected requirements and projection policies are unchanged", async (t) => {
	const full = [page(0, 500), page(500, TOTAL)];
	// Pages of another artifact do not satisfy.
	assert.deepEqual((await check(t, full, ["producer.control"])).missing, [
		"producer.control",
	]);
	// A projected requirement needs a projected row; pages carry no path.
	const projected = await check(t, full, [
		{ source: "producer", artifact: "analysis", path: "$.claims" },
	]);
	assert.deepEqual(projected.missing, ["producer.analysis path=$.claims"]);
	assert.equal(projected.incompleteCoverage, undefined);
	// A policy with no path still needs a non-truncated row (projection policies are unchanged).
	const policy = await check(
		t,
		full,
		[],
		[{ source: "producer", artifact: "analysis" }],
	);
	assert.deepEqual(policy.projectionFailures, ["producer.analysis"]);
	// count: one complete page set counts as one whole read.
	assert.deepEqual(
		(
			await check(
				t,
				[...full, row()],
				[{ source: "producer", artifact: "analysis", count: 2 }],
			)
		).missing,
		[],
	);
});
