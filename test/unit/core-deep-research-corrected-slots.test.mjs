import assert from "node:assert/strict";
import test from "node:test";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";

// 2026-11-10 (owner, after the P3 hard-claim round): a verifier that does not verify a claim but corrects it
// (partially_supported or unsupported with correctionOrCounterclaim) marks part of the slot's value as wrong. A
// verified claim on another aspect of the same slot used to keep it `filled`; now it is `partial` and the
// correction is in its gap reason (a slot already partial or missing already says so and is left alone). Conflicting keeps precedence; a downgrade without a correction changes nothing.
async function packetFor(digests, slotStatus = "filled") {
	const slotIds = [...new Set(digests.flatMap((claim) => claim.factSlotIds))];
	const result = await finalPacket({
		sources: {
			"plan.main": { factSlots: slotIds.map((id) => ({ id })) },
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: digests.map(({ id, factSlotIds }) => ({
						id,
						factSlotIds,
					})),
				},
				factSlotCoverage: slotIds.map((slotId) => ({
					slotId,
					status: slotStatus,
					bestValue:
						"RFC 9369 defines QUIC version 2 and was published in May 2021.",
				})),
			},
			"audit-claims.main": { claimDigests: digests, gateSummary: {} },
		},
	});
	return new Map(
		result.packet.factSlotCoverage.map((slot) => [slot.slotId, slot]),
	);
}

const verifiedScope = (slot) => ({
	id: `${slot}-scope`,
	status: "verified",
	factSlotIds: [slot],
});

test("a corrected claim the verifier did not verify makes a filled slot partial", async () => {
	for (const status of ["partially_supported", "unsupported"]) {
		const slots = await packetFor([
			verifiedScope("slot-a"),
			{
				id: "claim-date",
				status,
				factSlotIds: ["slot-a"],
				correctionOrCounterclaim:
					"RFC 9369 was published in May 2023, not May 2021.",
			},
		]);
		const slot = slots.get("slot-a");
		assert.equal(slot.status, "partial", status);
		assert.match(
			slot.gapReason,
			/verifier correction on a claim it did not verify \(claim-date: RFC 9369 was published in May 2023, not May 2021\.\)/,
		);
	}
});

test("without a correction, or when it conflicts, the earlier slot rules hold", async () => {
	const slots = await packetFor([
		verifiedScope("slot-plain"),
		{
			id: "claim-plain",
			status: "partially_supported",
			factSlotIds: ["slot-plain"],
		},
		verifiedScope("slot-blank"),
		{
			id: "claim-blank",
			status: "partially_supported",
			factSlotIds: ["slot-blank"],
			correctionOrCounterclaim: "  ",
		},
		verifiedScope("slot-conflict"),
		{
			id: "claim-conflict",
			status: "conflicting",
			factSlotIds: ["slot-conflict"],
			correctionOrCounterclaim: "May 2023",
		},
		verifiedScope("slot-verified-correction"),
		{
			id: "claim-verified-note",
			status: "verified",
			factSlotIds: ["slot-verified-correction"],
			correctionOrCounterclaim:
				"A verified claim's note is not a correction of the slot.",
		},
	]);
	assert.equal(slots.get("slot-plain").status, "filled");
	assert.equal(slots.get("slot-blank").status, "filled");
	assert.equal(slots.get("slot-conflict").status, "conflicting");
	assert.equal(slots.get("slot-conflict").bestValue, "May 2023");
	assert.equal(slots.get("slot-verified-correction").status, "filled");
});

test("a slot that is already partial or missing is left as it was", async () => {
	for (const status of ["partial", "missing"]) {
		const slots = await packetFor(
			[
				{
					id: "claim-date",
					status: "unsupported",
					factSlotIds: ["slot-a"],
					correctionOrCounterclaim: "May 2023",
				},
			],
			status,
		);
		assert.equal(slots.get("slot-a").status, status);
		assert.doesNotMatch(
			slots.get("slot-a").gapReason ?? "",
			/claim-date: May 2023/,
		);
	}
});
