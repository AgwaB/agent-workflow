import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-08 (owner decision, live deep-review: one reviewer misquoted
// src/auth.js:2 and all eight of its verified findings, in four files, went to NEEDS_HUMAN):
// a failed coverage row holds back only the reviewer's findings in that file. The exact-quote
// check, the coverage gap in the report and the partial-review verdict rules are unchanged.
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

const FILES = {
	"src/auth.js":
		"// Permission checks. Roles: admin, guest.\nexport const canDelete = true;\n",
	"src/db.js": "// Database access.\nexport const query = sql + name;\n",
};

function project(t) {
	const cwd = mkdtempSync(join(tmpdir(), "agent-workflow-coverage-scope-"));
	t.after(() =>
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	mkdirSync(join(cwd, "src"), { recursive: true });
	for (const [file, text] of Object.entries(FILES))
		writeFileSync(join(cwd, file), text);
	return cwd;
}

const finding = (id, file, quote) => ({
	findingId: id,
	rootCauseId: `rc-${id}`,
	title: `${id} defect`,
	severity: "high",
	file,
	locations: [{ file, line: 2 }],
	evidence: quote,
	evidenceQuotes: [quote],
	rationale: `Risk from ${id}`,
	recommendedAction: `Fix ${id}`,
	confidence: "high",
});

const findings = [
	finding("auth-delete", "src/auth.js", "export const canDelete = true;"),
	finding("db-sql", "./src/db.js", "export const query = sql + name;"),
];

function statuses(ids = []) {
	return [
		{
			source: "triage",
			specId: "triage",
			taskId: "t1",
			stageId: "triage",
			status: "completed",
		},
		{
			source: "reviewers.contract",
			specId: "reviewers.contract",
			taskId: "t2",
			stageId: "reviewers",
			itemIdentity: "contract",
			placeholderSpecId: "reviewers.item",
			status: "completed",
		},
		...ids.map((id, index) => ({
			source: `devil-advocate.${id}`,
			specId: `devil-advocate.${id}`,
			taskId: `t${index + 3}`,
			stageId: "devil-advocate",
			itemIdentity: id,
			placeholderSpecId: "devil-advocate.item",
			status: "completed",
		})),
	];
}

function dedup(cwd, authQuote, extraRows = []) {
	return pipeline({
		sources: {
			triage: {
				reviewLenses: [
					{
						id: "contract",
						evidenceToInspect: ["src/auth.js:1", "src/db.js:1"],
					},
				],
			},
			"reviewers.contract": {
				lens: "contract",
				findings,
				evidenceChecked: ["src/auth.js:1", "src/db.js:1"],
				sourceCoverage: [
					{
						path: "src/auth.js:1",
						status: "read",
						evidence: authQuote,
						artifact: "",
						reason: "",
					},
					{
						path: "src/db.js:1",
						status: "read",
						evidence: "// Database access.",
						artifact: "",
						reason: "",
					},
					...extraRows,
				],
				noIssueNotes: [],
			},
		},
		context: { cwd, stateCwd: stateDir(cwd), sourceStatuses: statuses() },
		options: { mode: "dedup" },
	});
}

function partition(cwd, dedupResult) {
	const ids = dedupResult.findings.map((row) => row.findingId);
	const sources = { "dedup-findings.main": dedupResult };
	for (const row of dedupResult.findings) {
		const file = row.file;
		sources[`devil-advocate.${row.findingId}`] = {
			findingId: row.findingId,
			finding: row.title,
			verdict: "KEEP",
			evidence: [{ file, line: 2, quote: FILES[file].split("\n")[1] }],
			counterEvidence: [],
			recommendedAction: `Fix ${row.findingId}`,
		};
	}
	return pipeline({
		sources,
		context: { cwd, stateCwd: stateDir(cwd), sourceStatuses: statuses(ids) },
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
}

const byId = (rows) =>
	Object.fromEntries(rows.map((row) => [row.findingId, row]));

test("a misquoted coverage row holds back only the findings in that file", async (t) => {
	const cwd = project(t);
	// "Permission checks." is missing: still an exact-quote failure for src/auth.js:1.
	const result = await dedup(cwd, "// Roles: admin, guest.");
	assert.equal(result.sourceStatusSummary.nonCompleted, 1);
	assert.equal(
		result.sourceStatusSummary.partialFailures[0].sourcePath,
		"src/auth.js:1",
	);
	const rows = byId(result.findings);
	assert.equal(rows["auth-delete"].sourceCoverageComplete, false);
	assert.deepEqual(rows["auth-delete"].sourceCoverageIssuePaths, [
		"src/auth.js:1",
	]);
	assert.equal(rows["db-sql"].sourceCoverageComplete, true);
	assert.deepEqual(rows["db-sql"].sourceCoverageIssuePaths, []);

	const partitioned = await partition(cwd, result);
	assert.deepEqual(
		partitioned.partitions.keep.map((row) => row.findingId),
		["db-sql"],
	);
	assert.deepEqual(
		partitioned.partitions.needsHuman.map((row) => row.findingId),
		["auth-delete"],
	);
	assert.match(
		partitioned.partitions.needsHuman[0].note,
		/originating reviewer did not complete required source coverage: src\/auth\.js:1/u,
	);
	// The review is still partial: the gap stays recorded and reported.
	assert.equal(partitioned.partitionSummary.partialFailures, 1);

	const output = await render({
		sources: {
			"partition-verdicts.main": partitioned,
			report: {
				summary: "One finding stands; one source gap.",
				verdict: "NEEDS_WORK",
			},
		},
	});
	assert.equal(output.verdict, "NEEDS_WORK", JSON.stringify(output.gates));
	assert.match(output.markdown, /Required source coverage gaps/u);
	assert.match(output.markdown, /src\/auth\.js:1/u);
});

test("a coverage failure that names no planned file holds back every finding", async (t) => {
	const cwd = project(t);
	const result = await dedup(
		cwd,
		"// Permission checks. Roles: admin, guest.",
		[
			{
				path: "src/other.js",
				status: "read",
				evidence: "unplanned",
				artifact: "",
				reason: "",
			},
		],
	);
	assert.equal(result.sourceStatusSummary.nonCompleted, 1);
	assert.deepEqual(
		result.findings.map((row) => row.sourceCoverageComplete),
		[false, false],
	);
	const partitioned = await partition(cwd, result);
	assert.equal(partitioned.partitionSummary.keep, 0);
	assert.equal(partitioned.partitionSummary.needsHuman, 2);
});

test("complete coverage keeps every verified finding", async (t) => {
	const cwd = project(t);
	const result = await dedup(cwd, "// Permission checks. Roles: admin, guest.");
	assert.equal(result.sourceStatusSummary.nonCompleted, 0);
	const partitioned = await partition(cwd, result);
	assert.equal(partitioned.partitionSummary.keep, 2);
	assert.equal(partitioned.partitionSummary.needsHuman, 0);
});
