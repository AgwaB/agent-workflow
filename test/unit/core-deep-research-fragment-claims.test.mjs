// agent-workflow 2026-11-08 (context-quality E2): candidates copied from a heading, field label or JSON line were
// verified without saying what they are about, and the sanitizer's own rewrite produced such text. A fragment now gets
// its entity prepended when the entity is unambiguous; otherwise it is left as it was.
import assert from "node:assert/strict";
import test from "node:test";

import sanitize from "../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs";

const URL = "https://nodejs.org/api/globals.html";

async function run({
	claim,
	entities = ["AbortSignal.any()"],
	factEntity = "AbortSignal.any()",
	quote = "Added in: v20.3.0, v18.17.0",
}) {
	const out = await sanitize({
		sources: {
			"plan.main": { factSlots: [{ id: "slot-1", entities }] },
			"normalize-input-packet.main": {
				packet: {
					plan: { factSlots: [{ id: "slot-1", entities }] },
					research: {
						sources: [{ sourceRef: "src-1", sourceUrls: [URL] }],
						extractedFacts: [
							{
								slotId: "slot-1",
								entity: factEntity,
								sourceUrls: [URL],
								sourceRefs: ["src-1"],
								quote,
								value: quote,
							},
						],
					},
				},
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-001",
							claim,
							sourceUrls: [URL],
							factSlotIds: ["slot-1"],
							verificationNeed: "core",
						},
					],
					preservedClaims: [],
				},
				factSlotCoverage: [
					{
						slotId: "slot-1",
						status: "filled",
						verificationCandidateIds: ["claim-001"],
					},
				],
				coverageGaps: [],
			},
		},
	});
	return {
		candidate: out.claimInventory.verificationCandidates[0],
		preserved: out.claimInventory.preservedClaims,
		diagnostics: out.sanitizerDiagnostics,
	};
}

const RECORD =
	"Category: Standards Track; Published: May 2021; Status: Proposed Standard";

test("a kept field-label fragment gets its single planned entity; the copied text is preserved", async () => {
	const { candidate, preserved, diagnostics } = await run({
		claim: RECORD,
		entities: ["RFC 9000"],
		factEntity: "RFC 9000",
		quote: RECORD,
	});
	assert.equal(candidate.claim, `RFC 9000 — ${RECORD}`);
	assert.equal(candidate.originalClaim, RECORD);
	assert.deepEqual(candidate.sanitizerRewriteReasons, [
		"fragment_named_entity",
	]);
	assert.deepEqual(diagnostics.entityNamedCandidateIds, ["claim-001"]);
	assert.equal(diagnostics.rewriteReasonCounts.fragment_named_entity, 1);
	assert.deepEqual(
		preserved.map((row) => [row.id, row.status, row.claim]),
		[
			[
				"preserved-claim-001",
				"preserved_rewritten_before_verification",
				RECORD,
			],
		],
	);
});

test("the sanitizer's own rewrite to a quote names the entity (the golden-fixture mechanism)", async () => {
	// A sentence that does not match its hint is rewritten to the hint's quote — a field label.
	const { candidate } = await run({
		claim:
			"AbortSignal.any() has been available in Node.js for a long time across releases.",
	});
	assert.equal(
		candidate.claim,
		"AbortSignal.any() — Added in: v20.3.0, v18.17.0",
	);
	// Two planned entities, the evidence fact names one of them → that one.
	assert.equal(
		(
			await run({
				claim: "Edge has supported this method for many releases now, broadly.",
				entities: ["Chrome", "Edge"],
				factEntity: "edge",
				quote: "Added in: 116",
			})
		).candidate.claim,
		"Edge — Added in: 116",
	);
});

test("statements, ambiguous entities and headings that only name the entity are left as they were", async () => {
	for (const [label, input] of [
		[
			"names its subject",
			{
				claim: "AbortSignal.any() was added in Node.js v20.3.0 and v18.17.0.",
				quote: "AbortSignal.any() was added in Node.js v20.3.0 and v18.17.0.",
			},
		],
		[
			"already contains the entity",
			{
				claim: "AbortSignal.any() — Added in: v20.3.0, v18.17.0",
				quote: "AbortSignal.any() — Added in: v20.3.0, v18.17.0",
			},
		],
		[
			"two planned entities, fact entity not one of them",
			{
				claim: "Added in: v20.3.0, v18.17.0",
				entities: ["Chrome", "Edge"],
				factEntity: "notes.md",
			},
		],
		[
			"a sentence that names one part of a combined entity",
			{
				claim:
					"RFC 9204 (QPACK: Field Compression for HTTP/3)는 2022년 6월 발행되었다.",
				entities: ["RFC 9204 / QPACK header compression"],
				factEntity: "RFC 9204",
				quote:
					"RFC 9204 (QPACK: Field Compression for HTTP/3)는 2022년 6월 발행되었다.",
			},
		],
		[
			"heading that only names the entity",
			{ claim: "# AbortSignal.any()", quote: "# AbortSignal.any()" },
		],
	]) {
		const { candidate, diagnostics } = await run(input);
		assert.equal(
			candidate?.claim ?? null,
			candidate ? input.claim : null,
			label,
		);
		assert.deepEqual(diagnostics.entityNamedCandidateIds, [], label);
	}
});

// agent-workflow 2026-11-10: "Label - value" lines and table rows were not recognised; recorded runs kept
// "RFC - Proposed Standard (May 2021)" unnamed and translations dropped its date.
test("a dash-label line or a table row gets its entity prepended; one that names it is left alone", async () => {
	for (const [claim, entity, expected] of [
		[
			"RFC - Proposed Standard (May 2021)",
			"RFC 9000",
			"RFC 9000 — RFC - Proposed Standard (May 2021)",
		],
		[
			"Document | Type | | RFC - Proposed Standard (June 2022)",
			"RFC 9114",
			"RFC 9114 — Document | Type | | RFC - Proposed Standard (June 2022)",
		],
		[
			"RFC 9114 | HTTP/3 | June 2022",
			"RFC 9114",
			"RFC 9114 | HTTP/3 | June 2022",
		],
		[
			"RFC 9000 is listed as RFC - Proposed Standard (May 2021).",
			"RFC 9000",
			"RFC 9000 is listed as RFC - Proposed Standard (May 2021).",
		],
	]) {
		const { candidate, diagnostics } = await run({
			claim,
			entities: [entity],
			factEntity: entity,
			quote: claim,
		});
		assert.equal(candidate?.claim, expected, claim);
		assert.deepEqual(
			diagnostics.entityNamedCandidateIds,
			expected === claim ? [] : ["claim-001"],
			claim,
		);
	}
});
