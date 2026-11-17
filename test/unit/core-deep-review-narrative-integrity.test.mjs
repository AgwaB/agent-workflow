// The narrative stage sees only the report packet, so the packet carries verifier-coverage/integrity
// facts, and the renderer says so when its final verdict differs from the verdict the narrative was
// written for (agent-workflow 2026-11-17; run workflow_mwibvq2c_a062a2 printed PARTIAL_REVIEW above a
// NEEDS_WORK narrative that claimed no integrity issues).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.cwd(), "workflows", "deep-review", "helpers");
const pipeline = (
	await import(pathToFileURL(join(root, "finding-pipeline.mjs")).href)
).default;
const render = (
	await import(pathToFileURL(join(root, "render-review-report.mjs")).href)
).default;

const finding = (id) => ({
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
});
const verdict = (id, value) => ({
	findingId: id,
	finding: `${id} behavioral finding`,
	verdict: value,
	evidence: [`checked ${id}`],
	counterEvidence: [],
	recommendedAction: `Act on ${id}`,
});
const partition = (findings, verifiers) =>
	pipeline({
		sources: {
			"dedup-findings.main": { findings },
			...Object.fromEntries(
				Object.entries(verifiers).map(([id, v]) => [`devil-advocate.${id}`, v]),
			),
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});

test("report packet carries verifier-coverage facts when verifier verdicts are missing", async () => {
	const result = await partition([finding("a"), finding("b"), finding("c")], {
		a: verdict("a", "KEEP"),
	});
	const packet = result.reportPacket;
	const preview = packet.integrityPreview;
	assert.equal(preview.hasIssues, true);
	assert.equal(preview.verifierCoverageComplete, false);
	assert.equal(preview.missingVerifierFindingCount, 2);
	const summary = packet.partitionSummary;
	assert.equal(summary.missingVerdicts, 2);
	assert.equal(summary.verdictsReceived, 1);
	assert.equal(summary.reviewerFindings, 3);
	assert.equal(summary.needsHumanByCause.verifier_missing, 2);
	assert.match(
		preview.issues[0],
		/2 of 3 reviewer findings have no verifier verdict/,
	);
	assert.equal(packet.expectedVerdict, "NEEDS_WORK");
	assert.equal(packet.actualChars, JSON.stringify(packet).length);
	assert.ok(packet.actualChars <= packet.maxChars);
});

test("report packet integrity preview is free of verifier gaps when every finding has a verdict", async () => {
	const result = await partition([finding("a")], { a: verdict("a", "KEEP") });
	const preview = result.reportPacket.integrityPreview;
	// This minimal fixture has no reviewer attestations, so other issues may be listed; verifier gaps must not.
	assert.equal(result.reportPacket.partitionSummary.missingVerdicts, 0);
	assert.equal(preview.missingVerifierFindingCount, 0);
	assert.ok(preview.issues.every((issue) => !/verifier verdict/.test(issue)));
});

const renderWith = async (part, narrativeVerdict) =>
	render({
		sources: {
			"partition-verdicts.main": part,
			report: { summary: "s", verdict: narrativeVerdict },
		},
	});

test("renderer names both verdicts when the final verdict differs from the narrative's", async () => {
	const part = await partition([finding("a"), finding("b")], {
		a: verdict("a", "KEEP"),
	});
	const out = await renderWith(part, part.reportPacket.expectedVerdict);
	assert.equal(out.verdict, "PARTIAL_REVIEW");
	const note = out.markdown
		.split("\n")
		.find((line) => line.startsWith("> Verdict note:"));
	assert.ok(note, out.markdown);
	assert.match(note, /written for verdict `NEEDS\\_WORK`/);
	assert.match(note, /final report verdict is `PARTIAL\\_REVIEW`/);
	assert.match(note, /1 verifier verdict\(s\) are missing/);
	assert.ok(
		out.markdown.indexOf("> Verdict note:") <
			out.markdown.indexOf("Summary: s"),
	);
});

test("renderer prints no verdict note when the narrative and final verdicts agree", async () => {
	const out = await render({
		sources: {
			"partition-verdicts.main": {
				sourceStatusSummary: {
					partialFailures: [{ specId: "x", source: "x", status: "failed" }],
				},
				partitions: { keep: [], weaken: [], drop: [], needsHuman: [] },
			},
			report: { summary: "s", verdict: "PARTIAL_REVIEW" },
		},
	});
	assert.equal(out.verdict, "PARTIAL_REVIEW");
	assert.doesNotMatch(out.markdown, /Verdict note:/);
});
