// agent-workflow 2026-11-23 (skill-tools-check run workflow_mwrnt675_966ff4: "findings 1-3 are near-duplicates and finding
// titles are raw table rows"). The fixture holds the real controls of a recorded run of the same question
// (workflow_mwt0o0kf_362bc9): the sanitizer rewrote a mismatched claim to the source's table row, and that row became the
// finding's heading. Candidates that the rewrite turned into one claim on one page are merged before verification, and a
// table-row claim is rendered from its cells.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import sanitize from "../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs";

const run = JSON.parse(
	await readFile(
		new URL(
			"../fixtures/deep-research/node-lts-quick-run.json",
			import.meta.url,
		),
		"utf8",
	),
);
const RELEASES = "https://nodejs.org/en/about/previous-releases";
const SCHEDULE =
	"https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule";

function candidate(id, claim, extra = {}) {
	return {
		id,
		claim,
		sourceUrls: [RELEASES],
		sourceRefs: ["source-001"],
		sourceQuality: "primary",
		reasonToVerify: "slot coverage",
		scopeItems: ["Current Active LTS Node.js line"],
		factSlotIds: ["slot-001"],
		verificationNeed: "core",
		...extra,
	};
}

async function sanitizeWith(extraCandidates, coverageIds) {
	const claims = structuredClone(run["normalize-claims"]);
	claims.claimInventory.verificationCandidates.push(...extraCandidates);
	if (coverageIds)
		claims.factSlotCoverage[0].verificationCandidateIds = coverageIds;
	return sanitize({
		sources: {
			"normalize-input-packet.main": run["normalize-input-packet"],
			"normalize-claims.main": claims,
		},
	});
}

test("recorded run: the mismatched claim is rewritten to the source row (the shape that becomes the heading)", async () => {
	const out = await sanitizeWith([]);
	const [first] = out.claimInventory.verificationCandidates;
	assert.equal(first.sanitizerRewriteReasons[0], "source_hint_claim_mismatch");
	assert.match(first.claim, /^Node\.js — v26\s+\| Lithium\s+\|/u);
	assert.equal(out.claimInventory.verificationCandidates.length, 2);
	assert.equal(out.sanitizerDiagnostics.mergedDuplicateCount, 0);
});

test("candidates that the rewrite turns into the same source row on one page are one claim; slots, scope and citations are kept", async () => {
	const out = await sanitizeWith(
		[
			candidate(
				"claim-003",
				"Node.js 26 is the latest long-term-support line today.",
				{
					factSlotIds: ["slot-002"],
					scopeItems: ["Official source citations"],
					verificationNeed: "optional",
				},
			),
			candidate(
				"claim-004",
				"Lithium is the codename of the newest LTS release.",
				{
					sourceUrls: [RELEASES, SCHEDULE],
				},
			),
		],
		["claim-001", "claim-004"],
	);
	const rows = out.claimInventory.verificationCandidates;
	assert.deepEqual(
		rows.map((row) => row.id),
		["claim-001", "claim-002", "claim-003"],
	);
	const merged = rows.find((row) => row.id === "claim-001");
	assert.deepEqual(merged.mergedCandidateIds, ["claim-004"]);
	assert.deepEqual(merged.sourceUrls, [RELEASES, SCHEDULE]);
	assert.equal(merged.verificationNeed, "core");
	assert.deepEqual(out.claimInventory.duplicates.at(-1), {
		id: "claim-004",
		claim: merged.claim,
		canonicalClaimId: "claim-001",
		reason: "identical_claim_same_source",
	});
	// the slot row that listed the dropped id now points at the claim that absorbed it
	assert.deepEqual(out.factSlotCoverage[0].verificationCandidateIds, [
		"claim-001",
	]);
	assert.equal(out.sanitizerDiagnostics.mergedDuplicateCount, 1);
	assert.deepEqual(out.sanitizerDiagnostics.mergedDuplicateIds, ["claim-004"]);
	assert.equal(out.sanitizerDiagnostics.keptCandidateCount, rows.length);
});

test("identical claim text on the same page is merged regardless of case, spacing and punctuation", async () => {
	const out = await sanitizeWith([
		candidate(
			"claim-003",
			"the official node.js schedule lists node.js 26 maintenance in october 2027",
			{
				sourceUrls: [`${SCHEDULE}#schedule`],
				factSlotIds: ["slot-002"],
			},
		),
	]);
	const ids = out.claimInventory.verificationCandidates.map((row) => row.id);
	assert.deepEqual(ids, ["claim-001", "claim-002"]);
	const canonical = out.claimInventory.verificationCandidates[1];
	assert.deepEqual(canonical.mergedCandidateIds, ["claim-003"]);
});

test("the same words on one page for two different fact slots are two claims (recorded tiered run: Stability: 2 - Stable)", async () => {
	const out = await sanitizeWith([
		candidate("claim-003", "Stability: 2 - Stable", {
			factSlotIds: ["slot-002"],
		}),
		candidate("claim-004", "Stability: 2 - Stable", {
			factSlotIds: ["slot-003"],
		}),
		candidate("claim-005", "Stability: 2 - Stable", { factSlotIds: [] }),
		candidate("claim-006", "Stability: 2 - Stable", { factSlotIds: [] }),
	]);
	assert.equal(out.sanitizerDiagnostics.mergedDuplicateCount, 0);
});

test("claims that differ in a number, in wording, or in page are never merged", async () => {
	const out = await sanitizeWith([
		candidate(
			"claim-003",
			"The official Node.js schedule lists Node.js 26 Maintenance in October 2028.",
			{
				sourceUrls: [SCHEDULE],
				factSlotIds: ["slot-002"],
			},
		),
		candidate(
			"claim-004",
			"The official Node.js schedule lists Node.js 26 Maintenance in October 2027.",
			{
				sourceUrls: ["https://nodejs.org/en/about/releases"],
				factSlotIds: ["slot-002"],
			},
		),
		candidate(
			"claim-005",
			"The official Node.js schedule does not list Node.js 26 Maintenance in October 2027.",
			{
				sourceUrls: [SCHEDULE],
				factSlotIds: ["slot-002"],
			},
		),
	]);
	assert.equal(out.sanitizerDiagnostics.mergedDuplicateCount, 0);
	assert.equal(
		out.claimInventory.verificationCandidates.some(
			(row) => row.mergedCandidateIds,
		),
		false,
	);
});

test("recorded run: a table-row claim is rendered from its cells in the finding heading and the audit", async () => {
	const result = await render({
		sources: {
			"final-audit-packet": run["final-audit-packet"],
			"final-audit": run["final-audit"],
		},
	});
	assert.equal(result.status, "passed");
	assert.match(
		result.reportMarkdown,
		/^### 2\. Node\.js — v26 · Lithium · May 05, 2026 · Nov 10, 2026 · LTS$/mu,
	);
	assert.doesNotMatch(result.reportMarkdown, /^### \d+\..*\|/mu);
	// the verifier's quote stays verbatim: it is what the engine checks against the page
	assert.match(
		result.reportMarkdown,
		/quote "v26 {2}\| Lithium {2}\| May 05, 2026 {2}\| Nov 10, 2026 {2}\| LTS"/u,
	);
	assert.match(
		result.auditMarkdown,
		/claim-001\*\* \(partially\\_supported\): Node\.js — v26 · Lithium · May 05, 2026 · Nov 10, 2026 · LTS/u,
	);
});

test("a claim that is not a table row keeps its text exactly", async () => {
	const packet = structuredClone(run["final-audit-packet"]);
	const row = packet.packet.claimVerdictLedger.find(
		(item) => item.id === "claim-001",
	);
	assert.ok(row, "fixture has claim-001 in the ledger");
	const cases = [
		["a || b is falsy", "a || b is falsy"],
		["use `a | b` for union", "use \\`a | b\\` for union"],
		["Plain sentence.", "Plain sentence."],
	];
	for (const [claim, heading] of cases) {
		row.claim = claim;
		const result = await render({
			sources: {
				"final-audit-packet": packet,
				"final-audit": run["final-audit"],
			},
		});
		assert.ok(
			result.reportMarkdown.split("\n").includes(`### 2. ${heading}`),
			`heading for ${claim}`,
		);
	}
});
