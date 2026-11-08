// agent-workflow 2026-11-08: short dated claims ("RFC 9369 was published in May 2023.") share too few words with their
// evidence ("Published: May 2023") and were demoted as source_hint_claim_mismatch before any verifier saw them — 18 of
// 27 demotions on 19 recorded research runs (the claims behind E1, and the candidate that would have settled an L4 date
// conflict). A claim whose every year-month appears in the hint is supported; fragments and wrong dates are not.
import assert from "node:assert/strict";
import test from "node:test";

import sanitize from "../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs";

const URL = "https://datatracker.ietf.org/doc/html/rfc9369";

async function sanitizeOne(claim, hint) {
	const sources = {
		"plan.main": { factSlots: [{ id: "slot-022" }] },
		"normalize-input-packet.main": {
			packet: {
				research: {
					extractedFacts: [
						{
							slotId: "slot-022",
							entity: "RFC 9369",
							sourceUrls: [URL],
							...hint,
						},
					],
				},
			},
		},
		"normalize-claims.main": {
			claimInventory: {
				verificationCandidates: [
					{
						id: "claim-017",
						claim,
						sourceUrls: [URL],
						factSlotIds: ["slot-022"],
						verificationNeed: "core",
					},
				],
				preservedClaims: [],
			},
			factSlotCoverage: [
				{
					slotId: "slot-022",
					status: "filled",
					verificationCandidateIds: ["claim-017"],
				},
			],
			coverageGaps: [],
		},
	};
	const out = await sanitize({ sources });
	return {
		kept: out.claimInventory.verificationCandidates.map((row) => row.id),
		demotedReasons: out.sanitizerDiagnostics.demotionReasonCounts,
	};
}

const recordedHint = {
	value: "2023년 5월",
	quote: "Published:\n     May 2023",
	dateOrYear: "May 2023",
};

test("a dated claim whose year-month is in its evidence reaches the verifier", async () => {
	assert.deepEqual(
		(await sanitizeOne("RFC 9369 was published in May 2023.", recordedHint))
			.kept,
		["claim-017"],
	);
	// The year-month may come from the hint's dateOrYear when the quote names the document.
	assert.deepEqual(
		(
			await sanitizeOne("RFC 9369 was published in May 2023.", {
				quote: "RFC 9369 Published",
				dateOrYear: "2023-05",
			})
		).kept,
		["claim-017"],
	);
	// …but one shared word plus a matching date is not enough.
	assert.deepEqual(
		(
			await sanitizeOne("RFC 9369 was published in May 2023.", {
				quote: "Published:",
				dateOrYear: "2023-05",
			})
		).kept,
		[],
	);
	assert.deepEqual(
		(await sanitizeOne("RFC 9369 was published in 2023년 5월.", recordedHint))
			.kept,
		["claim-017"],
	);
});

test("fragments, wrong dates and dateless short claims stay demoted", async () => {
	for (const claim of [
		"Published: May 2023", // fragment: no subject, under four words
		"RFC 9369 was published in May 2022.", // the evidence says May 2023
		"RFC 9369 was published in June 2023.",
		"RFC 9369 is a Proposed Standard.", // no date: the word rule applies unchanged
	]) {
		const result = await sanitizeOne(claim, recordedHint);
		assert.deepEqual(result.kept, [], claim);
		assert.equal(result.demotedReasons.source_hint_claim_mismatch, 1, claim);
	}
});
