import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-01 (owner decision): deep-review accepts evidence that differs from the
// file only in trivial ways and records the correction instead of failing. Models often read files
// without line numbers (Codex `sed -n`, Pi `read`) and retype quotes; in recorded Codex runs this
// alone left most reviews PARTIAL_REVIEW.
// - Cited lines, planned ranges past the end of the file, and coverage quotes outside the planned
//   range are accepted when at most 10 lines off.
// - Whitespace, line-ending and quote/dash/space-character differences are accepted; the stored
//   evidence becomes the file's own text.
// - The match must be unique in the file. Different words, farther lines, repeated quotes still fail.
// The report lists every correction under "Evidence corrections".
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
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			sourceStatuses: statuses.slice(0, 2),
		},
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
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			sourceStatuses: statuses,
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
}

test("planned ranges: end ≤10 lines past the file is clamped and recorded; farther or past the start fails", async (t) => {
	const cwd = project(t);
	const near = await dedup(cwd, "src/a.ts:2-12", "danger = true;");
	assert.equal(near.findings[0].sourceCoverageComplete, true);
	assert.deepEqual(near.reviewerLedger.plannedRangeCorrections, [
		{
			source: "reviewers.runtime",
			lens: "runtime",
			kind: "planned-range-end",
			path: "src/a.ts:2-12",
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
			"src/a.ts:2-30",
			"danger = true;",
			"required source range is outside the file",
		],
		[
			"src/a.ts:9-12",
			"danger = true;",
			"required source range is outside the file",
		],
		[
			"src/a.ts:2-12",
			"danger = false;",
			"content quote was not found in required source range",
		],
	]) {
		const failed = await dedup(cwd, planned, quote);
		assert.equal(failed.findings[0].sourceCoverageComplete, false, planned);
		assert.ok(
			failed.sourceStatusSummary.partialFailures[0].statusDetail.includes(
				`${planned}: read (${reason})`,
			),
			planned,
		);
	}
});

test("coverage quotes: a few lines outside the range or whitespace-only differences are recorded", async (t) => {
	const cwd = project(t);
	const outside = await dedup(cwd, "src/a.ts:5-6", "danger = true;");
	assert.equal(outside.findings[0].sourceCoverageComplete, true);
	assert.deepEqual(outside.reviewerLedger.plannedRangeCorrections, [
		{
			source: "reviewers.runtime",
			lens: "runtime",
			kind: "coverage-quote",
			path: "src/a.ts:5-6",
			actual: "4",
			reason: "line",
		},
	]);
	const spaced = await dedup(cwd, "src/a.ts:1-6", "danger  =  true;");
	assert.equal(
		spaced.findings[0].sourceCoverageComplete,
		false,
		"inner spacing is a content difference",
	);
	const tabbed = await dedup(cwd, "src/a.ts:1-6", "\t\tdanger = true;  ");
	assert.equal(tabbed.findings[0].sourceCoverageComplete, true);
	assert.equal(
		tabbed.reviewerLedger.plannedRangeCorrections[0].reason,
		"whitespace",
	);
});

test("verifier quotes: moved to their only occurrence within 10 lines, whitespace folded to file text", async (t) => {
	const cwd = project(t);
	const base = await dedup(cwd, "src/a.ts:1-6", "danger = true;");

	const moved = await partition(cwd, base, [
		{ file: "src/a.ts", line: 6, quote: "danger = true;" },
		{ file: "src/a.ts", line: 12, lineEnd: 13, quote: "second();\nrepeat();" },
		{ file: "src/a.ts", line: 1, quote: "first();" },
		{ file: "src/a.ts", line: 6, quote: "  sixth();\t" },
	]);
	assert.equal(moved.partitionSummary.keep, 1);
	assert.equal(moved.partitionSummary.partialFailures, 0);
	assert.deepEqual(moved.partitions.keep[0].evidence, [
		{ file: "src/a.ts", line: 4, quote: "danger = true;" },
		{ file: "src/a.ts", line: 2, lineEnd: 3, quote: "second();\nrepeat();" },
		{ file: "src/a.ts", line: 1, quote: "first();" },
		{ file: "src/a.ts", line: 6, quote: "sixth();" },
	]);
	assert.deepEqual(
		moved.evidenceCorrections.map(({ cited, actual, reason }) => [
			cited,
			actual,
			reason,
		]),
		[
			["6", "4", "line"],
			["12-13", "2-3", "line"],
			["6", "6", "whitespace"],
		],
	);
	assert.ok(
		moved.partitions.keep[0].verifierEvidence.includes("sixth();"),
		"verifier quotes use the file text",
	);
	assert.ok(
		!moved.partitions.keep[0].verifierEvidence.includes("  sixth();\t"),
	);
	assert.ok(
		moved.normalizationNotes.some((note) =>
			note.includes("cited src/a.ts:6; the exact quote occurs once, at 4"),
		),
	);

	for (const [quote, line] of [
		["repeat();", 1],
		["danger = false;", 1],
		["danger = true;", 20],
	]) {
		const failed = await partition(cwd, base, [
			{ file: "src/a.ts", line, quote },
		]);
		assert.equal(failed.partitionSummary.keep, 0, quote);
		assert.equal(failed.partitionSummary.needsHuman, 1, quote);
		assert.equal(failed.evidenceCorrections, undefined, quote);
	}
});

test("the report lists the corrections; without corrections there is no section", async (t) => {
	const cwd = project(t);
	const base = await dedup(cwd, "src/a.ts:1-12", "danger = true;");
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
	assert.ok(lines.includes("## Evidence corrections"));
	assert.ok(
		lines.includes(
			"| triage plan for runtime | src/a.ts | 1-12 | 1-6 | the planned range ends past the file (6 lines) |",
		),
	);
	assert.ok(
		lines.includes(
			"| verifier of f1 | src/a.ts | 6 | 4 | the quote occurs once in the file, at these lines |",
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
	assert.equal(plain.markdown.includes("## Evidence corrections"), false);
});

// agent-workflow 2026-11-04 (live run of every bundled workflow, Codex deep-review PARTIAL_REVIEW):
// a verifier quoted a soft-wrapped Markdown sentence as one line; triage planned two blank lines.
test("a quote joining a wrapped line, and a metadata-only row for blank planned lines, are recorded corrections", async (t) => {
	const cwd = project(t);
	writeFileSync(
		join(cwd, "SPEC.md"),
		"# Spec\n\n- **C1.** Only `aborted`,\n  `AbortError` and `ABORT_ERR` count as cancellation.\n\n\n- **C2.** Next.\n",
	);
	const base = await dedup(cwd, "src/a.ts:1-6", "danger = true;");
	const joined = await partition(cwd, base, [
		{ file: "src/a.ts", line: 4, quote: "danger = true;" },
		{
			file: "SPEC.md",
			line: 3,
			lineEnd: 4,
			quote:
				"Only `aborted`, `AbortError` and `ABORT_ERR` count as cancellation.",
		},
	]);
	assert.equal(joined.partitionSummary.keep, 1);
	assert.deepEqual(joined.partitions.keep[0].evidence[1], {
		file: "SPEC.md",
		line: 3,
		lineEnd: 4,
		quote:
			"- **C1.** Only `aborted`,\n  `AbortError` and `ABORT_ERR` count as cancellation.",
	});
	assert.equal(joined.evidenceCorrections[0].reason, "whitespace");
	// Spacing inside a line is still content; a wrapped quote with other words still fails.
	const changed = await partition(cwd, base, [
		{
			file: "SPEC.md",
			line: 3,
			quote:
				"Only `aborted`, `AbortError` or `ABORT_ERR` count as cancellation.",
		},
	]);
	assert.equal(changed.partitionSummary.keep, 0);

	const blankReview = (planned) =>
		pipeline({
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
							status: "metadata-only",
							evidence: "",
							artifact: "",
							reason: "the planned line is blank",
						},
					],
					noIssueNotes: [],
				},
			},
			context: {
				cwd,
				stateCwd: cwd ? stateDir(cwd) : undefined,
				sourceStatuses: statuses.slice(0, 2),
			},
			options: { mode: "dedup" },
		});
	const blank = await blankReview("SPEC.md:5-6");
	assert.equal(blank.findings[0].sourceCoverageComplete, true);
	assert.deepEqual(blank.reviewerLedger.plannedRangeCorrections, [
		{
			source: "reviewers.runtime",
			lens: "runtime",
			kind: "blank-planned-range",
			path: "SPEC.md:5-6",
		},
	]);
	for (const planned of ["SPEC.md:4-5", "SPEC.md", "SPEC.md:40"])
		assert.equal(
			(await blankReview(planned)).findings[0].sourceCoverageComplete,
			false,
			planned,
		);
	const out = await render({
		sources: {
			"partition-verdicts.main": await partition(cwd, blank, [
				{ file: "src/a.ts", line: 4, quote: "danger = true;" },
			]),
			report: {
				summary: "Fix it",
				verdict: "NEEDS_WORK",
				risks: [],
				recommendedNextAction: "Fix it",
			},
		},
	});
	assert.equal(out.verdict, "NEEDS_WORK");
	assert.ok(
		out.markdown
			.split("\n")
			.includes(
				"| triage plan for runtime | SPEC.md | 5-6 | — | the planned lines are blank, so there was nothing to quote |",
			),
	);
});

// agent-workflow 2026-11-04: normalization notes are reader text; they use the verifier's
// readerTitle (the finding's title in the task's language) when there is one.
test("normalization notes name the finding by its reader title", async (t) => {
	const cwd = project(t);
	const base = await dedup(cwd, "src/a.ts:1-6", "danger = true;");
	const out = await pipeline({
		sources: {
			"dedup-findings.main": base,
			"devil-advocate.f1": {
				findingId: "f1",
				finding: finding.title,
				verdict: "KEEP",
				evidence: [{ file: "src/a.ts", line: 6, quote: "danger = true;" }],
				counterEvidence: [],
				recommendedAction: "끄세요",
				readerTitle: "위험 플래그가 켜진 채로 남음",
			},
		},
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			sourceStatuses: statuses,
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.ok(
		out.normalizationNotes.some((note) =>
			note.includes(
				'verifier evidence for "위험 플래그가 켜진 채로 남음" cited src/a.ts:6',
			),
		),
		JSON.stringify(out.normalizationNotes),
	);
	assert.ok(
		!out.normalizationNotes.some((note) => note.includes(finding.title)),
	);
});

// agent-workflow 2026-11-04: a quote of Markdown prose that drops inline-code backticks or emphasis
// asterisks matches (only in Markdown files); other text still has to match.
test("Markdown quotes may drop backticks and asterisks; code files may not", async (t) => {
	const cwd = project(t);
	writeFileSync(
		join(cwd, "SPEC.md"),
		"# Spec\n\n- **T3.** `outputRetryAttempts`와 `launchRetryAttempts`는 공개 계약이다.\n",
	);
	writeFileSync(
		join(cwd, "src", "b.ts"),
		"const name = `launchRetryAttempts`;\n",
	);
	const base = await dedup(cwd, "src/a.ts:1-6", "danger = true;");
	const md = await partition(cwd, base, [
		{ file: "src/a.ts", line: 4, quote: "danger = true;" },
		{
			file: "SPEC.md",
			line: 3,
			quote: "T3. outputRetryAttempts와 launchRetryAttempts는 공개 계약이다.",
		},
	]);
	assert.equal(md.partitionSummary.keep, 1);
	assert.equal(
		md.partitions.keep[0].evidence[1].quote,
		"- **T3.** `outputRetryAttempts`와 `launchRetryAttempts`는 공개 계약이다.",
	);
	const code = await partition(cwd, base, [
		{ file: "src/b.ts", line: 1, quote: "const name = launchRetryAttempts;" },
	]);
	assert.equal(code.partitionSummary.keep, 0, "not in a code file");
});
