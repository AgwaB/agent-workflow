import assert from "node:assert/strict";
import test from "node:test";

import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import sanitize from "../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs";
import { buildSynthesisPages } from "../../workflows/deep-research/helpers/synthesis-pages.mjs";

async function demotedClaimPacket() {
	const sources = {
		"plan.main": {
			factSlots: [{ id: "slot-1" }, { id: "slot-2" }],
		},
		"normalize-input-packet.main": {
			packet: {
				research: {
					extractedFacts: [
						{
							slotId: "slot-2",
							quote: "This document defines the core of QUIC transport.",
							sourceUrls: ["https://rfc.test/rfc9000"],
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
						claim: "The feature is disabled.",
						sourceUrls: ["https://example.test/feature"],
						factSlotIds: ["slot-1"],
					},
					{
						id: "claim-002",
						claim: "RFC 9000 was published in May 2021.",
						sourceUrls: ["https://rfc.test/rfc9000"],
						factSlotIds: ["slot-2"],
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
				{
					slotId: "slot-2",
					status: "filled",
					verificationCandidateIds: ["claim-002"],
				},
			],
			coverageGaps: [],
		},
	};
	const sanitized = await sanitize({ sources });
	const verifierOwner = {
		source: "verify-claims.claim-001",
		stageId: "verify-claims",
		specId: "verify-claims.claim-001",
		taskId: "task-verify",
		itemIdentity: "claim-001",
		placeholderSpecId: "verify-claims.item",
		status: "completed",
	};
	const packet = await finalPacket({
		sources: {
			...sources,
			"sanitize-claims.main": sanitized,
			"audit-claims.main": {
				claimDigests: [
					{
						id: "claim-001",
						claim: "The feature is disabled.",
						status: "verified",
						confidence: "high",
						factSlotIds: ["slot-1"],
						verifierOwner,
					},
				],
				gateSummary: {
					invalidVerifierRows: 0,
					duplicateVerifierRows: 0,
					verifierOwnerIssues: 0,
					missingVerifierResults: 0,
					invalidNormalizedCandidates: 0,
					sourceRefJoinFailures: 0,
					zeroCandidateFloorBlockers: 0,
				},
				verdictCounts: { verified: 1 },
				statusPartitions: { verified: ["claim-001"] },
				verifierOwnerLedger: [verifierOwner],
			},
		},
	});
	return { packet, sanitized };
}

function synthesis() {
	return {
		schema: "deep-research-final-synthesis-v1",
		digest: "Keep the publication date unverified.",
		synthesis: {
			bottomLine: "The feature is verified; the publication date is not.",
			keyFindingIds: ["claim-001"],
			recommendations: [
				{
					recommendation: "Verify the publication date before citing it.",
					supportingClaimIds: ["claim-002"],
					evidenceStatus: "verified",
				},
			],
			actionPlan: [],
			caveatNotes: [
				{
					note: "The publication date was not sent to a verifier.",
					relatedClaimIds: ["claim-002"],
					gapIds: ["gap-coverage-001"],
				},
			],
			parentDecisionNotes: [],
		},
	};
}

const renderPacket = (packet, control = synthesis()) =>
	render({
		sources: {
			"final-audit.main": control,
			"final-audit-packet.main": packet,
		},
	});

test("demoted research claims keep their IDs through gaps, synthesis and rendering", async () => {
	const { packet, sanitized } = await demotedClaimPacket();
	assert.deepEqual(sanitized.sanitizerDiagnostics.demotedCandidateIds, [
		"claim-002",
	]);
	assert.equal(sanitized.sanitizerDiagnostics.rewrittenCandidateCount, 0);
	assert.equal(sanitized.coverageGaps[0].claimId, "claim-002");
	assert.deepEqual(packet.packet.invariantChecks.candidateIds, ["claim-001"]);

	const result = await renderPacket(packet);
	assert.equal(
		result.status,
		"passed",
		JSON.stringify({ warnings: result.renderWarnings, gates: result.gates }),
	);
	assert.equal(packet.packet.preservedClaims[0].id, "claim-002");
	assert.equal(result.gates.packetReconciliationPassed, true);
	assert.equal(result.gates.renderedAllStructuredItems, true);
	assert.equal(result.claimSummary.total, 1);
	assert.equal(result.claimSummary.verified, 1);
	assert.match(result.reportMarkdown, /publication date was not sent/);
	assert.match(
		result.reportMarkdown
			.split("## Recommendations")[1]
			.split("## Action plan")[0],
		/Evidence status: unverified/,
	);
});

test("demoted IDs cannot be promoted to audited key findings", async () => {
	const { packet } = await demotedClaimPacket();
	const control = synthesis();
	control.synthesis.keyFindingIds = ["claim-002"];
	const result = await renderPacket(packet, control);
	assert.equal(result.status, "failed");
	assert(
		result.renderWarnings.some(
			(row) => row.label === "key findings" && row.missingId === "claim-002",
		),
	);
});

test("unknown and colliding preserved references still fail closed", async () => {
	const { packet } = await demotedClaimPacket();
	const control = synthesis();
	control.synthesis.caveatNotes[0].relatedClaimIds = ["unknown-claim"];
	const unknown = await renderPacket(packet, control);
	assert.equal(unknown.status, "failed");
	assert(
		unknown.renderWarnings.some((row) => row.missingId === "unknown-claim"),
	);

	packet.packet.preservedClaims[0].id = "claim-001";
	packet.packet.synthesisInput = buildSynthesisPages(packet.packet);
	const collision = await renderPacket(packet);
	assert.equal(collision.status, "failed");
	assert(
		collision.renderWarnings.some(
			(row) => row.label === "ambiguous preserved claim ID",
		),
	);
});
