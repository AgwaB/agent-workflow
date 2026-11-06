import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-03 (owner decision): deep-review reports read in the task's language.
// The report stage writes its summary, risks and next action in that language; each devil-advocate
// verifier writes its own prose there and adds readerTitle / readerRationale — the finding's title
// and rationale translated — which the report shows while the reviewer's originals stay the
// identity and the ledger text. No new stage or model call.
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

const SOURCE = ["first();", "danger = true;", "third();", ""].join("\n");
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
	locations: [{ file: "src/a.ts", line: 2 }],
	evidence: "danger stays on",
	evidenceQuotes: ["danger = true;"],
	rationale: "The flag is never reset, so later calls run in danger mode.",
	recommendedAction: "Turn it off",
	confidence: "high",
};
const report = {
	summary: "위험 플래그가 꺼지지 않는 문제 하나가 남았습니다.",
	verdict: "NEEDS_WORK",
	risks: [],
	recommendedNextAction: "플래그를 끄는 코드를 추가하세요.",
};

async function run(t, verifierExtra) {
	const cwd = mkdtempSync(join(tmpdir(), "aw-deep-review-reader-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "src", "a.ts"), SOURCE);
	const dedup = await pipeline({
		sources: {
			triage: {
				reviewLenses: [{ id: "runtime", evidenceToInspect: ["src/a.ts:1-3"] }],
			},
			"reviewers.runtime": {
				lens: "runtime",
				findings: [finding],
				evidenceChecked: ["src/a.ts:1-3"],
				sourceCoverage: [
					{
						path: "src/a.ts:1-3",
						status: "read",
						evidence: "danger = true;",
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
	const partition = await pipeline({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.f1": {
				findingId: "f1",
				finding: finding.title,
				verdict: "KEEP",
				evidence: [{ file: "src/a.ts", line: 2, quote: "danger = true;" }],
				counterEvidence: [],
				recommendedAction: "플래그를 끄세요.",
				...verifierExtra,
			},
		},
		context: {
			cwd,
			stateCwd: cwd ? stateDir(cwd) : undefined,
			sourceStatuses: statuses,
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	const out = await render({
		sources: { "partition-verdicts.main": partition, report },
	});
	return { partition, out };
}

test("a verifier's readerTitle and readerRationale are what the report shows; the ledger keeps the originals", async (t) => {
	const { partition, out } = await run(t, {
		readerTitle: "위험 플래그가 켜진 채로 남음",
		readerRationale:
			"플래그가 다시 꺼지지 않아 이후 호출이 위험 모드로 실행됩니다.",
	});
	const kept = partition.partitions.keep[0];
	assert.equal(kept.title, "Danger flag stays on");
	assert.equal(kept.rationale, finding.rationale);
	assert.equal(kept.readerTitle, "위험 플래그가 켜진 채로 남음");
	assert.equal(out.verdict, "NEEDS_WORK");
	assert.match(out.markdown, /### f1 — 위험 플래그가 켜진 채로 남음/);
	assert.match(out.markdown, /Rationale:\n\n플래그가 다시 꺼지지 않아/);
	assert.match(out.markdown, /Recommended action:\n\n플래그를 끄세요\./);
	assert.doesNotMatch(out.markdown, /### f1 — Danger flag stays on/);
	assert.match(
		out.completionSummaryMarkdown ?? out.markdown,
		/위험 플래그가 켜진 채로 남음/,
	);
});

test("without reader text, or with an empty one, the original title and rationale show and the verdict stands", async (t) => {
	for (const extra of [{}, { readerTitle: "   ", readerRationale: "" }]) {
		const { partition, out } = await run(t, extra);
		assert.equal(partition.partitions.keep.length, 1, JSON.stringify(extra));
		assert.equal(partition.partitions.keep[0].readerTitle, undefined);
		assert.match(out.markdown, /### f1 — Danger flag stays on/);
		assert.match(out.markdown, /Rationale:\n\nThe flag is never reset/);
	}
});

test("deep-review and spec-review prompts ask for the task's language; the verifier schema allows the reader fields", () => {
	const spec = JSON.parse(
		readFileSync("workflows/deep-review/spec.json", "utf8"),
	);
	const stage = (id) => spec.artifactGraph.stages.find((s) => s.id === id);
	assert.match(
		stage("report").prompt,
		/summary, risks and recommendedNextAction in the runtime task's requested language/,
	);
	assert.match(
		stage("devil-advocate").each.prompt,
		/add readerTitle and readerRationale: faithful translations/,
	);
	assert.match(
		stage("devil-advocate").each.prompt,
		/evidenceUnavailableReason, readerTitle, and readerRationale\./,
	);
	const spec2 = JSON.parse(
		readFileSync("workflows/spec-review/spec.json", "utf8"),
	);
	assert.match(
		spec2.artifactGraph.stages.find((s) => s.id === "report").prompt,
		/in the runtime task's requested language/,
	);
	const schema = JSON.parse(
		readFileSync(
			"workflows/deep-review/schemas/deep-review-devil-advocate-control.schema.json",
			"utf8",
		),
	);
	assert.deepEqual(
		[
			schema.properties.readerTitle.maxLength,
			schema.properties.readerRationale.maxLength,
		],
		[800, 4000],
	);
});
