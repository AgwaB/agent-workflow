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
