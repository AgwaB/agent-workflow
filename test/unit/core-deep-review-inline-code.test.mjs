// Code spans in the deep-review report are literal in CommonMark: Markdown escapes must not
// appear inside them (agent-workflow 2026-11-17: reports showed `NEEDS\_WORK`, `ABORT\_ERR`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stateDir } from "../helpers/state-dir.mjs";

const helpers = join(process.cwd(), "workflows", "deep-review", "helpers");
const pipeline = (
	await import(pathToFileURL(join(helpers, "finding-pipeline.mjs")).href)
).default;
const render = (
	await import(pathToFileURL(join(helpers, "render-review-report.mjs")).href)
).default;

const FILE = "src/a_b*c|d`e.ts";
const SOURCE = "first();\ndanger = true;\nthird();\n";
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
	file: FILE,
	locations: [{ file: FILE, line: 2 }],
	evidence: "danger stays on",
	evidenceQuotes: ["danger = true;"],
	rationale: "The flag is never reset.",
	recommendedAction: "Turn it off",
	confidence: "high",
};

test("code spans keep _ and * literal; pipes stay table-safe; backticks fence", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-inline-code-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, FILE), SOURCE);
	const ctx = (n) => ({
		cwd,
		stateCwd: stateDir(cwd),
		sourceStatuses: statuses.slice(0, n),
	});
	const dedup = await pipeline({
		sources: {
			triage: {
				reviewLenses: [{ id: "runtime", evidenceToInspect: [`${FILE}:1-3`] }],
			},
			"reviewers.runtime": {
				lens: "runtime",
				findings: [finding],
				evidenceChecked: [`${FILE}:1-3`],
				sourceCoverage: [
					{
						path: `${FILE}:1-3`,
						status: "read",
						evidence: "danger = true;",
						artifact: "",
						reason: "",
					},
				],
				noIssueNotes: [],
			},
		},
		context: ctx(2),
		options: { mode: "dedup" },
	});
	const partition = await pipeline({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.f1": {
				findingId: "f1",
				finding: finding.title,
				verdict: "KEEP",
				evidence: [{ file: FILE, line: 2, quote: "danger = true;" }],
				counterEvidence: [],
				recommendedAction: "Turn it off",
			},
		},
		context: ctx(3),
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	const out = await render({
		sources: {
			"partition-verdicts.main": partition,
			report: {
				summary: "s",
				verdict: "PASS",
				risks: [],
				recommendedNextAction: "n",
			},
		},
	});
	const spans = [
		...out.markdown.matchAll(/(``+|`)(?!`)(.+?)(?<!`)\1(?!`)/g),
	].map((m) => m[2]);
	assert.ok(spans.length > 0);
	assert.match(out.markdown, /`PARTIAL_REVIEW`/);
	assert.doesNotMatch(out.markdown, /`[^`\n]*\\[_*][^`\n]*`/);
	const row = out.markdown.split("\n").find((l) => l.includes("a_b*c"));
	assert.ok(row, "location row present");
	assert.match(row, /a_b\*c\\\|d/);
	assert.doesNotMatch(row, /a\\_b/);
	assert.ok(row.includes("``src/a_b*c\\|d`e.ts``"), row);
});
