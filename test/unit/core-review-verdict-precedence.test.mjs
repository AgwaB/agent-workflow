import { stateDir } from "../helpers/state-dir.mjs";
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
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			sourceStatuses: statuses,
		},
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
			stateCwd: cwd ? stateDir(cwd) : undefined,
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

// Live 2026-11-04 (Claude spec-review after the change): one verifier said NEEDS_HUMAN. Its gate row
// stays in the saved ledger beside the final rows; the renderer must still see the confirmed gap as
// grounded, or it computes INCONCLUSIVE while the partition handed the report GAPS_FOUND.
test("spec-review end to end: a KEEP gap and a NEEDS_HUMAN verifier give GAPS_FOUND, passed, with the open row listed", async (t) => {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const partitionStep = (
		await helper("spec-review", "spec-review-pipeline.mjs")
	).default;
	const renderSpec = (
		await helper("spec-review", "render-spec-review-report.mjs")
	).default;
	const cwd = mkdtempSync(join(tmpdir(), "aw-verdict-spec-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "source.ts"), "export const enabled = false;\n");
	writeFileSync(
		join(cwd, "SPEC.md"),
		"The implementation must preserve the local behavior.\nIt must log every stop.\n",
	);
	const runId = "unit-verdict";
	const save = async (taskId, file, value) => {
		const dir = join(
			stateDir(cwd),
			".agent-workflow/workflows",
			runId,
			"tasks",
			taskId,
		);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, file), JSON.stringify(value));
	};
	const source = (stage) => ({
		source: stage,
		stageId: stage,
		specId: `${stage}.main`,
		taskId: `task-${stage}`,
		status: "completed",
		artifacts: { control: { path: "control.json" } },
	});
	const upstream = ["extract-spec", "map-implementation", "inspect-tests"].map(
		source,
	);
	const requirement = (id, line, text) => ({
		id,
		requirement: text,
		specEvidence: {
			file: "SPEC.md",
			lineStart: line,
			lineEnd: line,
			quote: text,
		},
		priority: "high",
		implementationSignals: ["source.ts:1"],
		testSignals: [],
	});
	for (const row of upstream)
		await save(
			row.taskId,
			"control.json",
			row.stageId === "extract-spec"
				? {
						specSources: ["SPEC.md"],
						requirements: [
							requirement(
								"REQ-1",
								1,
								"The implementation must preserve the local behavior.",
							),
							requirement("REQ-2", 2, "It must log every stop."),
						],
					}
				: {},
		);
	const candidateRow = (id, requirementId) => ({
		id,
		title: `Gap ${id}`,
		claim: "A gap exists",
		severity: "medium",
		requirementIds: [requirementId],
		specEvidence: [],
		implementationEvidence: [],
		testEvidence: [],
		uncertainty: "Verify",
	});
	const analysis = {
		schema: "stage-control-v1",
		digest: "candidate",
		candidateFindings: [
			candidateRow("finding-001", "REQ-1"),
			candidateRow("finding-002", "REQ-2"),
		],
		requirementCoverage: [
			{ requirementId: "REQ-1", status: "gap" },
			{ requirementId: "REQ-2", status: "unclear" },
		],
		needsHuman: [],
		noIssueNotes: [],
	};
	await save("task-candidate", "control.json", analysis);
	await save("task-candidate", "source-manifest.json", {
		schema: "workflow-source-manifest-v1",
		runId,
		taskId: "task-candidate",
		sources: upstream,
	});
	await save("task-partition-findings", "source-manifest.json", {
		schema: "workflow-source-manifest-v1",
		runId,
		taskId: "task-partition-findings",
		sources: [{ ...source("candidate-findings"), taskId: "task-candidate" }],
	});
	const verifierStatus = (id, taskId) => ({
		source: `verify-findings.${id}`,
		stageId: "verify-findings",
		specId: `verify-findings.${id}`,
		taskId,
		itemIdentity: id,
		placeholderSpecId: "verify-findings.item",
		status: "completed",
	});
	const statuses = [
		{
			source: "candidate-findings",
			stageId: "candidate-findings",
			specId: "candidate-findings.main",
			taskId: "task-candidate",
			status: "completed",
		},
		verifierStatus("finding-001", "task-v1"),
		verifierStatus("finding-002", "task-v2"),
	];
	const verifier = (id, verdict, evidence) => ({
		schema: "stage-control-v1",
		digest: "verify",
		id,
		verdict,
		severity: "medium",
		evidence,
		counterEvidence: [],
		finalClaim: "A gap exists",
		recommendedAction: "Inspect",
	});
	const p = await partitionStep({
		sources: {
			"candidate-findings": analysis,
			"verify-findings.finding-001": verifier("finding-001", "KEEP", [
				{
					file: "source.ts",
					lineStart: 1,
					lineEnd: 1,
					quote: "export const enabled = false;",
				},
			]),
			"verify-findings.finding-002": verifier("finding-002", "NEEDS_HUMAN", []),
		},
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			runId,
			sourceStatuses: statuses,
		},
	});
	assert.equal(p.finalFindings.length, 1);
	assert.ok(p.needsHuman.some((row) => row.id === "finding-002"));
	assert.ok(p.evidenceGate.findings.some((row) => row.id === "finding-002"));
	assert.equal(p.readProjection.ledgerVerdict, "GAPS_FOUND");
	const result = await renderSpec({
		sources: {
			"partition-findings": p,
			report: {
				schema: "spec-review-report-v1",
				digest: "report",
				summary: "One confirmed gap; one requirement open.",
				verdict: p.readProjection.ledgerVerdict,
				risks: [],
				recommendedNextAction: "Fix the gap; decide REQ-2.",
				ownerLedger: p.verifierCoverage.ownerLedger,
				ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation,
			},
		},
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			runId,
			sourceStatuses: ["partition-findings", "report"].map((name) => ({
				source: name,
				stageId: name,
				specId: `${name}.main`,
				taskId: `task-${name}`,
				status: "completed",
			})),
		},
	});
	assert.deepEqual(
		[result.verdict, result.status],
		["GAPS_FOUND", "passed"],
		JSON.stringify(result.blockers),
	);
	assert.match(
		result.completionSummaryMarkdown,
		/Requirements not settled by this review: REQ-2 \(unclear\)/u,
	);
	assert.match(
		result.completionSummaryMarkdown,
		/1 needs-human row\(s\) remain unresolved/u,
	);
});
