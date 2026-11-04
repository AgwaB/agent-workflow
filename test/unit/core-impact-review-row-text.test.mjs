// agent-workflow 2026-11-01: impact-review rows are free-form objects (the schemas only require an
// object), and every row used to print as JSON — 200 rows in five recorded Codex reports. A flat
// row now reads as its main text followed by its other fields (nothing dropped); a row with nested
// values keeps the stable JSON form.
import assert from "node:assert/strict";
import test from "node:test";
import renderImpactReport from "../../workflows/impact-review/helpers/render-impact-report.mjs";

const stages = {
	"change-scope": [
		"changeInputs",
		"affectedFiles",
		"affectedComponents",
		"publicSurfaces",
		"assumptions",
		"outOfScope",
	],
	"implementation-map": ["components", "entryPoints", "dataFlows", "unknowns"],
	"validation-map": [
		"tests",
		"docs",
		"releaseArtifacts",
		"validationCommandsMentioned",
		"knownGaps",
	],
	"api-contract-impact": ["impacts", "assumptions"],
	"state-data-impact": ["impacts", "assumptions"],
	"validation-impact": [
		"coveredAreas",
		"missingValidation",
		"recommendedCommands",
		"assumptions",
	],
	"docs-release-impact": ["impacts", "assumptions"],
	"security-performance-impact": ["impacts", "assumptions"],
	"contract-consistency": ["issues", "confirmedConsistencies"],
	"regression-risk": ["risks", "riskReducers"],
	"ship-readiness": ["requiredBeforeShip", "niceToHave", "assumptions"],
	"impact-synthesis": [
		"blockingIssues",
		"nonBlockingIssues",
		"confirmedSafeAreas",
		"recommendedNextActions",
		"validationToRun",
		"needsHuman",
	],
};

function blockedControls() {
	const out = {};
	for (const [stage, fields] of Object.entries(stages)) {
		const value = { schema: "stage-control-v1", digest: `${stage}-digest` };
		for (const field of fields) value[field] = [];
		if (stage === "change-scope")
			value.changeSummary = "Review the supplied change.";
		if (stage === "validation-impact") value.coverageStatus = "strong";
		if (stage.endsWith("-impact") && stage !== "validation-impact")
			value.status = "none";
		if (stage === "contract-consistency") value.status = "pass";
		if (stage === "regression-risk") value.riskLevel = "low";
		if (stage === "ship-readiness") value.status = "blocked";
		if (stage === "impact-synthesis")
			Object.assign(value, {
				summary: "Blocked.",
				verdict: "BLOCKED",
				riskLevel: "low",
			});
		out[`impact-analysis.${stage}`] = value;
	}
	return out;
}

const context = {
	sourceStatuses: Object.keys(stages).map((stage, index) => ({
		source: `impact-analysis.${stage}`,
		specId: `impact-analysis.${stage}.main`,
		stageId: stage,
		taskId: `task-${index + 1}`,
		status: "completed",
	})),
};

test("flat rows render as readable text with every field; nested rows stay JSON", async () => {
	const sources = blockedControls();
	Object.assign(sources["impact-analysis.impact-synthesis"], {
		blockingIssues: [
			{ issue: "Store contract is missing", action: "Restore it" },
		],
		nonBlockingIssues: [{ id: "N1", detail: { nested: true } }],
		validationToRun: [{ check: "npm test", purpose: "regressions" }],
		needsHuman: [{ question: "Which diff?", reason: "No diff was supplied" }],
		recommendedNextActions: [
			{ id: "A1", text: "Add tests", owner: "team", steps: ["unit", "e2e"] },
		],
	});
	const result = await renderImpactReport({ sources, context });
	const md = result.markdown;
	for (const line of [
		"- Store contract is missing — action: Restore it",
		"- npm test — purpose: regressions",
		"- Which diff? — reason: No diff was supplied",
		"- Add tests — id: A1; owner: team; steps: unit, e2e",
		'- \\{"detail":\\{"nested":true\\},"id":"N1"\\}',
	])
		assert.ok(md.split("\n").includes(line), `missing line: ${line}`);
	assert.doesNotMatch(
		md,
		/\\\{"(?:action|issue|check|question|text)"/u,
		"flat rows are not JSON",
	);
	assert.match(
		result.completionSummaryMarkdown,
		/Store contract is missing — action: Restore it/u,
	);
});

test("the completion summary stays within its schema limit however many action rows there are", async () => {
	// Live 2026-11-04: 7,132 chars (Claude, Antigravity) failed the render control schema (6,000).
	const sources = blockedControls();
	const long = (label, i) =>
		`${label} ${i}: ${"변경된 공개 계약과 상태 처리를 확인해야 합니다. ".repeat(20)}`;
	Object.assign(sources["impact-analysis.impact-synthesis"], {
		summary: long("summary", 0),
		blockingIssues: Array.from({ length: 6 }, (_, i) => ({
			issue: long("blocking", i),
			action: "fix",
		})),
		recommendedNextActions: Array.from({ length: 6 }, (_, i) =>
			long("next", i),
		),
		validationToRun: Array.from({ length: 6 }, (_, i) => long("check", i)),
		needsHuman: Array.from({ length: 10 }, (_, i) => long("question", i)),
	});
	Object.assign(sources["impact-analysis.ship-readiness"], {
		requiredBeforeShip: Array.from({ length: 6 }, (_, i) =>
			long("required", i),
		),
		assumptions: Array.from({ length: 6 }, (_, i) => long("assumption", i)),
	});
	const result = await renderImpactReport({ sources, context });
	const summary = result.completionSummaryMarkdown;
	assert.ok(summary.length > 0, "the summary is rendered");
	assert.ok(
		Array.from(summary).length <= 6000,
		`${Array.from(summary).length} chars`,
	);
	assert.match(
		summary,
		/- 30 additional action row\(s\) are covered in the full report\./u,
	);
	// The full report keeps every row.
	for (let i = 0; i < 6; i++)
		assert.match(result.markdown, new RegExp(`next ${i}:`, "u"));
});

// agent-workflow 2026-11-04 (live runs): the summary hid reviewed file names — "workflow-stop.ts"
// became "[run omitted]" and a reviewed "control.json" became "[artifact omitted]". Only this
// engine's own names are hidden now.
test("the completion summary keeps reviewed file names and hides only engine artifacts, run ids and task ids", async () => {
	const sources = blockedControls();
	sources["impact-analysis.impact-synthesis"].summary =
		"src/workflow-stop.ts and src/workflow-terminal.ts read control.json; see run workflow_mw1rwnkc_7f6ae1 task-12, .agent-workflow/workflows/x/tasks/task-3/control.json and final-audit.control.json.";
	const summary = (await renderImpactReport({ sources, context }))
		.completionSummaryMarkdown;
	for (const kept of [
		"workflow-stop.ts",
		"workflow-terminal.ts",
		"read control.json",
	])
		assert.ok(summary.includes(kept), kept);
	for (const hidden of [
		"workflow_mw1rwnkc_7f6ae1",
		"task-12",
		".agent-workflow/workflows",
		"final-audit.control.json",
	])
		assert.ok(!summary.includes(hidden), hidden);
	assert.match(summary, /\[run omitted\]/u);
	assert.match(summary, /\[task omitted\]/u);
	assert.match(summary, /final-audit\.\[artifact omitted\]/u);
	// A path starting with "." keeps the space before it.
	assert.match(summary, /\[task omitted\], \[artifact omitted\]/u);
});
