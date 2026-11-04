// agent-workflow 2026-11-04 (owner decision, live run of every bundled workflow): confirmed findings
// decide the verdict before unresolved or incomplete parts of a review. All six non-clean
// verdicts that day had 2–6 grounded findings but read INCONCLUSIVE / PARTIAL_REVIEW because one or
// two requirements stayed "unclear" or two reviewers could not quote their planned lines, so the
// same review gave different verdicts on different executors. The partition (spec-review) and the
// report packet (deep-review) now carry the deterministic verdict the report stage copies.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const helper = (workflow, file) =>
	import(
		pathToFileURL(join(process.cwd(), "workflows", workflow, "helpers", file))
			.href
	);
const { specReviewVerdict } = await helper(
	"spec-review",
	"spec-evidence-gate.mjs",
);
const { requiredReportVerdict } = await helper(
	"deep-review",
	"review-verdict.mjs",
);
const pipeline = (await helper("deep-review", "finding-pipeline.mjs")).default;
const render = (await helper("deep-review", "render-review-report.mjs"))
	.default;

test("spec-review: grounded gaps are GAPS_FOUND before unresolved requirements; CONFORMS still needs everything", () => {
	const base = {
		sourceCoverageComplete: true,
		verifierCoverageComplete: true,
		requirementReconciliation: { complete: false, allCovered: false },
		gapsGrounded: true,
		finalCount: 6,
		integrityRows: 0,
		unresolvedRows: 2,
	};
	assert.equal(specReviewVerdict(base), "GAPS_FOUND");
	// Without grounded gaps the unresolved requirements still make the review inconclusive.
	assert.equal(
		specReviewVerdict({ ...base, gapsGrounded: false }),
		"INCONCLUSIVE",
	);
	// Process failures still come first.
	assert.equal(
		specReviewVerdict({ ...base, sourceCoverageComplete: false }),
		"INCONCLUSIVE",
	);
	assert.equal(
		specReviewVerdict({ ...base, verifierCoverageComplete: false }),
		"INCONCLUSIVE",
	);
	assert.equal(
		specReviewVerdict({
			...base,
			gapsGrounded: false,
			finalCount: 0,
			unresolvedRows: 0,
			requirementReconciliation: { complete: true, allCovered: true },
		}),
		"CONFORMS",
	);
	assert.equal(
		specReviewVerdict({
			...base,
			gapsGrounded: false,
			finalCount: 0,
			unresolvedRows: 1,
			requirementReconciliation: { complete: true, allCovered: false },
		}),
		"NEEDS_HUMAN",
	);
});

test("deep-review: kept findings are NEEDS_WORK even when part of the review is incomplete", () => {
	const complete = { complete: true };
	const partition = (partialFailures) => ({
		reviewerLedger: complete,
		dedupSummary: complete,
		verifierCoverage: complete,
		partitionSummary: { partialFailures },
		sourceStatusSummary: {
			total: 4,
			completed: 4,
			nonCompleted: 0,
			partialFailures: [],
		},
		partitions: { needsHuman: [] },
	});
	assert.equal(requiredReportVerdict(partition(2), 2), "NEEDS_WORK");
	assert.equal(requiredReportVerdict(partition(2), 0), "PARTIAL_REVIEW");
	assert.equal(requiredReportVerdict(partition(0), 0), "REVIEW_COMPLETE");
	assert.equal(requiredReportVerdict(partition(0), 1), "NEEDS_WORK");
});

test("deep-review end to end: an incomplete reviewer plus a grounded KEEP renders NEEDS_WORK, passed; the packet carries the verdict", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-verdict-precedence-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	writeFileSync(
		join(cwd, "src", "a.ts"),
		"first();\nsecond();\ndanger = true;\nfourth();\n",
	);
	const finding = {
		findingId: "f1",
		rootCauseId: "rc-f1",
		title: "Danger flag stays on",
		severity: "high",
		file: "src/a.ts",
		locations: [{ file: "src/a.ts", line: 3 }],
		evidence: "danger stays on",
		evidenceQuotes: ["danger = true;"],
		rationale: "Risk",
		recommendedAction: "Turn it off",
		confidence: "high",
	};
	const statuses = [
		{
			source: "triage",
			specId: "triage",
			taskId: "t1",
			stageId: "triage",
			status: "completed",
		},
		...["runtime", "api"].map((lens, index) => ({
			source: `reviewers.${lens}`,
			specId: `reviewers.${lens}`,
			taskId: `t${index + 2}`,
			stageId: "reviewers",
			itemIdentity: lens,
			placeholderSpecId: "reviewers.item",
			status: "completed",
		})),
	];
	const dedup = await pipeline({
		sources: {
			triage: {
				reviewLenses: [
					{ id: "runtime", evidenceToInspect: ["src/a.ts:1-4"] },
					{ id: "api", evidenceToInspect: ["src/a.ts:2"] },
				],
			},
			"reviewers.runtime": {
				lens: "runtime",
				findings: [finding],
				evidenceChecked: ["src/a.ts:1-4"],
				sourceCoverage: [
					{
						path: "src/a.ts:1-4",
						status: "read",
						evidence: "danger = true;",
						artifact: "",
						reason: "",
					},
				],
				noIssueNotes: [],
			},
			// This reviewer could not read its planned line: the review is partial.
			"reviewers.api": {
				lens: "api",
				findings: [],
				evidenceChecked: ["src/a.ts:2"],
				sourceCoverage: [
					{
						path: "src/a.ts:2",
						status: "metadata-only",
						evidence: "",
						artifact: "",
						reason: "the read tool failed on this range",
					},
				],
				noIssueNotes: ["No API issue was found in what could be read."],
			},
		},
		context: { cwd, sourceStatuses: statuses },
		options: { mode: "dedup" },
	});
	const partition = await pipeline({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.f1": {
				findingId: "f1",
				finding: finding.title,
				verdict: "KEEP",
				evidence: [{ file: "src/a.ts", line: 3, quote: "danger = true;" }],
				counterEvidence: [],
				recommendedAction: "Turn it off",
			},
		},
		context: {
			cwd,
			sourceStatuses: [
				...statuses,
				{
					source: "devil-advocate.f1",
					specId: "devil-advocate.f1",
					taskId: "t9",
					stageId: "devil-advocate",
					itemIdentity: "f1",
					placeholderSpecId: "devil-advocate.item",
					status: "completed",
				},
			],
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.equal(partition.partitionSummary.keep, 1);
	assert.ok(
		partition.partitionSummary.partialFailures > 0,
		"the review is partial",
	);
	assert.equal(partition.reportPacket.expectedVerdict, "NEEDS_WORK");
	const out = await render({
		sources: {
			"partition-verdicts.main": partition,
			report: {
				summary: "One confirmed issue; one reviewer could not read its source.",
				verdict: partition.reportPacket.expectedVerdict,
				risks: ["The api lens did not read src/a.ts:2."],
				recommendedNextAction: "Fix it and rerun the api lens.",
			},
		},
	});
	assert.equal(out.verdict, "NEEDS_WORK");
	assert.equal(out.status, "passed");
	assert.match(out.markdown, /Coverage: partial|partial/u);
});
