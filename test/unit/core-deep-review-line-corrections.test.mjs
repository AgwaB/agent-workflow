// agent-workflow 2026-11-01: deep-review corrects line numbers in code instead of failing on them.
// Models often read files without line numbers (Codex `sed -n`, Pi `read`). In nine recorded Codex
// runs this alone left 6 of 9 reviews PARTIAL_REVIEW: triage planned ranges past the end of the file
// (e.g. 62-118 for a 113-line file) and verifiers cited correct quotes one or two lines off.
// - A planned coverage range that starts inside the file but ends past it is checked through the
//   last line and recorded; one that starts past the file still fails.
// - A verifier quote that is not at its cited lines is accepted when it occurs exactly once in the
//   cited file; the row moves to the actual lines and the correction is recorded. An absent or
//   repeated quote still fails.
// The report lists every correction under "Line corrections".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const helpers = join(process.cwd(), "workflows", "deep-review", "helpers");
const pipeline = (
	await import(pathToFileURL(join(helpers, "finding-pipeline.mjs")).href)
).default;
const render = (
	await import(pathToFileURL(join(helpers, "render-review-report.mjs")).href)
).default;

// 6 lines and a final LF; `repeat();` occurs twice.
const SOURCE = [
	"first();",
	"second();",
	"repeat();",
	"danger = true;",
	"repeat();",
	"sixth();",
	"",
].join("\n");

const statuses = [
	{
		source: "triage",
		specId: "triage",
		taskId: "t1",
		stageId: "triage",
		status: "completed",
	},
	{
		source: "reviewers.runtime",
		specId: "reviewers.runtime",
		taskId: "t2",
		stageId: "reviewers",
		itemIdentity: "runtime",
		placeholderSpecId: "reviewers.item",
		status: "completed",
	},
	{
		source: "devil-advocate.f1",
		specId: "devil-advocate.f1",
		taskId: "t3",
		stageId: "devil-advocate",
		itemIdentity: "f1",
		placeholderSpecId: "devil-advocate.item",
		status: "completed",
	},
];

const finding = {
	findingId: "f1",
	rootCauseId: "rc-f1",
	title: "Danger flag stays on",
	severity: "high",
	file: "src/a.ts",
	locations: [{ file: "src/a.ts", line: 4 }],
	evidence: "danger stays on",
	evidenceQuotes: ["danger = true;"],
	rationale: "Risk",
	recommendedAction: "Turn it off",
	confidence: "high",
};

function project(t) {
	const cwd = mkdtempSync(join(tmpdir(), "aw-deep-review-lines-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "src", "a.ts"), SOURCE);
	return cwd;
}

function dedup(cwd, planned, quote) {
	return pipeline({
		sources: {
			triage: {
				reviewLenses: [{ id: "runtime", evidenceToInspect: [planned] }],
			},
			"reviewers.runtime": {
				lens: "runtime",
				findings: [finding],
				evidenceChecked: [planned],
				sourceCoverage: [
					{
						path: planned,
						status: "read",
						evidence: quote,
						artifact: "",
						reason: "",
					},
				],
				noIssueNotes: [],
			},
		},
		context: { cwd, sourceStatuses: statuses.slice(0, 2) },
		options: { mode: "dedup" },
	});
}

function partition(cwd, dedupOutput, evidence) {
	return pipeline({
		sources: {
			"dedup-findings.main": dedupOutput,
			"devil-advocate.f1": {
				findingId: "f1",
				finding: finding.title,
				verdict: "KEEP",
				evidence,
				counterEvidence: [],
				recommendedAction: "Turn it off",
			},
		},
		context: { cwd, sourceStatuses: statuses },
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
}

test("a planned range ending past the file is checked through its last line and recorded", async (t) => {
	const cwd = project(t);
	const past = await dedup(cwd, "src/a.ts:2-50", "danger = true;");
	assert.equal(past.findings[0].sourceCoverageComplete, true);
	assert.equal(past.sourceStatusSummary.nonCompleted, 0);
	assert.deepEqual(past.reviewerLedger.plannedRangeCorrections, [
		{
			kind: "planned-range-end",
			source: "reviewers.runtime",
			lens: "runtime",
			path: "src/a.ts:2-50",
			fileLines: 6,
			checked: "2-6",
		},
	]);
	const inside = await dedup(cwd, "src/a.ts:2-5", "danger = true;");
	assert.equal(
		inside.reviewerLedger.plannedRangeCorrections,
		undefined,
		"no correction, no field",
	);

	for (const [planned, quote, reason] of [
		[
			"src/a.ts:2-50",
			"first();",
			"content quote was not found in required source range",
		],
		[
			"src/a.ts:9-12",
			"danger = true;",
			"required source range is outside the file",
		],
		[
			"src/a.ts:5-6",
			"danger = true;",
			"content quote was not found in required source range",
		],
	]) {
		const failed = await dedup(cwd, planned, quote);
		assert.equal(failed.findings[0].sourceCoverageComplete, false, planned);
		assert.ok(
			failed.sourceStatusSummary.partialFailures[0].statusDetail.includes(
				`${planned}: read (${reason})`,
			),
		);
		assert.equal(failed.reviewerLedger.plannedRangeCorrections, undefined);
	}
});

test("a verifier quote cited at the wrong lines moves to its only occurrence; absent or repeated quotes fail", async (t) => {
	const cwd = project(t);
	const base = await dedup(cwd, "src/a.ts:1-6", "danger = true;");

	const moved = await partition(cwd, base, [
		{ file: "src/a.ts", line: 6, quote: "danger = true;" },
		{ file: "src/a.ts", line: 40, lineEnd: 41, quote: "second();\nrepeat();" },
		{ file: "src/a.ts", line: 1, quote: "first();" },
	]);
	assert.equal(moved.partitionSummary.keep, 1);
	assert.equal(moved.partitionSummary.partialFailures, 0);
	assert.deepEqual(moved.partitions.keep[0].evidence, [
		{ file: "src/a.ts", line: 4, quote: "danger = true;" },
		{ file: "src/a.ts", line: 2, lineEnd: 3, quote: "second();\nrepeat();" },
		{ file: "src/a.ts", line: 1, quote: "first();" },
	]);
	assert.deepEqual(moved.evidenceCorrections, [
		{
			kind: "verifier-line",
			source: "devil-advocate.f1",
			findingId: "f1",
			file: "src/a.ts",
			cited: "6",
			actual: "4",
		},
		{
			kind: "verifier-line",
			source: "devil-advocate.f1",
			findingId: "f1",
			file: "src/a.ts",
			cited: "40-41",
			actual: "2-3",
		},
	]);
	assert.ok(
		moved.normalizationNotes.some((note) =>
			note.includes("cited src/a.ts:6; the exact quote occurs once, at 4"),
		),
	);

	const exact = await partition(cwd, base, [
		{ file: "src/a.ts", line: 4, quote: "danger = true;" },
	]);
	assert.equal(exact.partitionSummary.keep, 1);
	assert.equal(exact.evidenceCorrections, undefined, "no correction, no field");

	for (const quote of ["repeat();", "danger = false;"]) {
		const failed = await partition(cwd, base, [
			{ file: "src/a.ts", line: 1, quote },
		]);
		assert.equal(failed.partitionSummary.keep, 0, quote);
		assert.equal(failed.partitionSummary.needsHuman, 1, quote);
		assert.match(
			failed.partitions.needsHuman[0].note,
			/src\/a\.ts:1-1 did not contain the exact verifier quote/u,
		);
		assert.equal(failed.evidenceCorrections, undefined);
	}
});

test("the report lists the corrections; without corrections there is no section", async (t) => {
	const cwd = project(t);
	const base = await dedup(cwd, "src/a.ts:1-50", "danger = true;");
	const report = {
		summary: "Fix it",
		verdict: "NEEDS_WORK",
		risks: [],
		recommendedNextAction: "Fix it",
	};
	const corrected = await partition(cwd, base, [
		{ file: "src/a.ts", line: 6, quote: "danger = true;" },
	]);
	const out = await render({
		sources: { "partition-verdicts.main": corrected, report },
	});
	assert.equal(out.verdict, "NEEDS_WORK");
	const lines = out.markdown.split("\n");
	assert.ok(lines.includes("## Line corrections"));
	assert.ok(
		lines.includes(
			"| triage plan for reviewer runtime | src/a.ts | 1-50 | 1-6 | the planned range ends past the file (6 lines) |",
		),
	);
	assert.ok(
		lines.includes(
			"| verifier of f1 | src/a.ts | 6 | 4 | the quote occurs exactly once in the file, at these lines |",
		),
	);

	const clean = await partition(
		cwd,
		await dedup(cwd, "src/a.ts:1-6", "danger = true;"),
		[{ file: "src/a.ts", line: 4, quote: "danger = true;" }],
	);
	const plain = await render({
		sources: { "partition-verdicts.main": clean, report },
	});
	assert.equal(plain.markdown.includes("## Line corrections"), false);
});
