// needsHuman rows carry an additive machine-readable cause so "the verifier never ran"
// is distinguishable from "the verifier judged it ambiguous" (agent-workflow 2026-11-17).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.cwd(), "workflows", "deep-review", "helpers");
const pipelineModule = await import(
	pathToFileURL(join(root, "finding-pipeline.mjs")).href
);
const pipeline = pipelineModule.default;
const { NEEDS_HUMAN_CAUSES, summarizeNeedsHumanCauses } = pipelineModule;
const render = (
	await import(pathToFileURL(join(root, "render-review-report.mjs")).href)
).default;

const finding = (id, extra = {}) => ({
	id,
	findingId: id,
	rootCauseId: `rc-${id}`,
	title: `${id} behavioral finding`,
	severity: "high",
	file: `src/${id}.ts`,
	locations: [{ file: `src/${id}.ts`, line: 4 }],
	evidence: `Observed ${id}`,
	evidenceQuotes: [`${id}()`],
	rationale: `Risk from ${id}`,
	recommendedAction: `Fix ${id}`,
	confidence: "high",
	...extra,
});

const verdict = (id, value, extra = {}) => ({
	findingId: id,
	finding: `${id} behavioral finding`,
	verdict: value,
	evidence: [`checked ${id}`],
	counterEvidence: [],
	recommendedAction: `Act on ${id}`,
	...extra,
});

const partition = (findings, verifiers, dedupExtra = {}) =>
	pipeline({
		sources: {
			"dedup-findings.main": { findings, ...dedupExtra },
			...Object.fromEntries(
				Object.entries(verifiers).map(([id, v]) => [`devil-advocate.${id}`, v]),
			),
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});

const causeOf = (result, id) =>
	result.partitions.needsHuman.find((row) => row.findingId === id)
		?.needsHumanCause;

test("verifier_missing: no verdict is distinguished from a verifier NEEDS_HUMAN verdict", async () => {
	const result = await partition([finding("a"), finding("b"), finding("c")], {
		b: verdict("b", "NEEDS_HUMAN"),
		c: verdict("c", "KEEP"),
	});
	assert.equal(causeOf(result, "a"), "verifier_missing");
	assert.equal(causeOf(result, "b"), "verifier_needs_human");
	assert.equal(result.partitionSummary.needsHuman, 2);
	assert.equal(result.partitions.needsHuman.length, 2);
	assert.equal(result.partitionSummary.missingVerdicts, 1);
	assert.equal(result.partitionSummary.needsHumanByCause.verifier_missing, 1);
	assert.equal(
		result.partitionSummary.needsHumanByCause.verifier_needs_human,
		1,
	);
});

test("verifier_output_invalid: an unrecognized verdict is not reported as a verifier judgement", async () => {
	for (const value of ["UNSURE", "keep", null]) {
		const result = await partition([finding("a")], {
			a: verdict("a", value),
		});
		assert.equal(
			causeOf(result, "a"),
			"verifier_output_invalid",
			String(value),
		);
		assert.deepEqual(result.partitionSummary.needsHumanByCause, {
			verifier_output_invalid: 1,
		});
	}
});

test("evidence_insufficient: a KEEP verdict on a finding without code-preserved quotes is demoted with its own cause", async () => {
	const result = await partition([finding("a", { evidenceQuotes: [] })], {
		a: verdict("a", "KEEP"),
	});
	assert.equal(causeOf(result, "a"), "evidence_insufficient");
});

test("coverage_gap: reviewer coverage issues carry the cause", async () => {
	const result = await partition(
		[],
		{},
		{
			coverageIssues: [
				{
					source: "runtime",
					reason: "planned_lens_missing_materialized_reviewer",
				},
			],
		},
	);
	assert.equal(result.partitions.needsHuman.length, 1);
	assert.equal(
		result.partitions.needsHuman[0].findingId,
		"reviewer-coverage-001",
	);
	assert.equal(result.partitions.needsHuman[0].needsHumanCause, "coverage_gap");
	assert.deepEqual(result.partitionSummary.needsHumanByCause, {
		coverage_gap: 1,
	});
});

test("support_unassociated: a support-only finding without a proven root carries the cause", async () => {
	const result = await partition(
		[
			finding("s", {
				file: "test/s.test.ts",
				locations: [{ file: "test/s.test.ts", line: 4 }],
			}),
		],
		{ s: verdict("s", "KEEP") },
	);
	assert.equal(causeOf(result, "s"), "support_unassociated");
});

test("verifier_output_invalid: malformed singleton verdicts carry the cause", async () => {
	const result = await partition([finding("a")], {
		a: verdict("a", "KEEP", { finding: "a different title" }),
	});
	assert.equal(causeOf(result, "a"), "verifier_output_invalid");
	assert.equal(result.partitionSummary.verdictIntegrityIssues, 1);
});

test("summary counts add up and every cause is in the documented enum", async () => {
	const result = await partition(
		[finding("a"), finding("b"), finding("c")],
		{
			b: verdict("b", "NEEDS_HUMAN"),
			c: verdict("c", "KEEP", { evidence: [] }),
		},
		{ coverageIssues: [{ source: "x", reason: "missing" }] },
	);
	const byCause = result.partitionSummary.needsHumanByCause;
	assert.equal(
		Object.values(byCause).reduce((sum, n) => sum + n, 0),
		result.partitionSummary.needsHuman,
	);
	for (const cause of Object.keys(byCause)) {
		assert.ok(NEEDS_HUMAN_CAUSES.includes(cause), cause);
	}
	assert.deepEqual(
		summarizeNeedsHumanCauses(result.partitions.needsHuman),
		byCause,
	);
	assert.deepEqual(summarizeNeedsHumanCauses([{}]), { unspecified: 1 });
	// verdict inputs unchanged: counts for the other buckets are untouched
	assert.equal(result.partitionSummary.keep, 0);
});

test("rendered report shows the cause breakdown and a per-row cause", async () => {
	const result = await partition([finding("a"), finding("b")], {
		b: verdict("b", "NEEDS_HUMAN"),
	});
	const output = await render({
		sources: {
			"partition-verdicts.main": result,
			report: {
				summary: "s",
				risks: [],
				recommendedNextAction: "n",
				verdict: "NEEDS_WORK",
			},
		},
		options: {},
	});
	const md = output.markdown;
	assert.match(md, /Causes:/u);
	assert.match(
		md,
		/1 × `verifier_missing` — verifier never returned a verdict/u,
	);
	assert.match(
		md,
		/1 × `verifier_needs_human` — verifier judged it ambiguous/u,
	);
	assert.match(md, /Needs-human cause: `verifier_missing`/u);
});
