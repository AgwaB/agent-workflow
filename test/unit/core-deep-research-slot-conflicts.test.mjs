// agent-workflow 2026-11-08 (context-quality backlog K1): deterministic conflict detection on
// structured fact-slot data. The input packet flags a slot whose research observations disagree on a
// date or number for the same entity; the final packet keeps that slot `conflicting` unless a verified
// claim states one of the values; the report shows the contest and its resolution.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateJsonSchema } from "../../dist/core/json-schema.js";
import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import normalizeInputPacket from "../../workflows/deep-research/helpers/normalize-input-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import {
	detectSlotConflicts,
	parseStructuredDate,
	valuesStatedBy,
} from "../../workflows/deep-research/helpers/slot-conflicts.mjs";

const packetSchema = JSON.parse(
	await readFile(
		new URL(
			"../../workflows/deep-research/schemas/deep-research-final-audit-packet-control.schema.json",
			import.meta.url,
		),
		"utf8",
	),
);

const RFC = "https://www.rfc-editor.org/rfc/rfc9000.html";
const fact = (id, overrides) => ({
	id,
	sourceId: id.split(".")[0],
	slotId: "slot-001",
	entity: "RFC 9000",
	factType: "date",
	...overrides,
});

test("parseStructuredDate accepts whole-string dates in the formats research workers emit and nothing else", () => {
	assert.deepEqual(parseStructuredDate("2021"), { year: 2021 });
	assert.deepEqual(parseStructuredDate("2021-05"), { year: 2021, month: 5 });
	assert.deepEqual(parseStructuredDate("2021-05-27"), { year: 2021, month: 5 });
	assert.deepEqual(parseStructuredDate("May 2021"), { year: 2021, month: 5 });
	assert.deepEqual(parseStructuredDate("Sept 2023"), { year: 2023, month: 9 });
	assert.deepEqual(parseStructuredDate("2021년 5월 27일"), {
		year: 2021,
		month: 5,
	});
	for (const text of [
		"2024 snapshot",
		"living standard",
		"2021-05; 2022-06",
		"v20.3.0",
		"",
		"2021-13",
	])
		assert.equal(parseStructuredDate(text), null, text);
});

test("detectSlotConflicts flags a date or number disagreement for the same slot and entity only", () => {
	const result = detectSlotConflicts({
		planSlots: [
			{ id: "slot-001", label: "RFC 9000 publication" },
			{ id: "slot-002" },
			{ id: "slot-007" },
		],
		extractedFacts: [
			// Same entity (case/punctuation-insensitive), May 2021 (web) vs May 2022 (local note).
			fact("q1.fact-001", {
				value: "May 2021",
				dateOrYear: "2021-05",
				sourceType: "web",
				sourceUrls: [RFC],
			}),
			fact("q2.fact-001", {
				entity: "rfc 9000",
				value: "2022년 5월",
				dateOrYear: "2022-05",
				sourceType: "local_repo",
				file: "notes.md",
				sourceRefs: ["notes"],
			}),
			// Year-only agrees with 2021-05: compatible, not a conflict on its own.
			fact("q3.fact-001", {
				factType: "version",
				value: "RFC 9000",
				dateOrYear: "2021",
			}),
			// Different entities in one slot are not compared (summary slot).
			fact("q1.fact-003", {
				slotId: "slot-007",
				entity: "RFC 9114",
				dateOrYear: "2022",
			}),
			fact("q2.fact-004", {
				slotId: "slot-007",
				entity: "RFC 9369",
				dateOrYear: "2023",
			}),
			// Numeric scalars: 9001 vs 9002 disjoint ⇒ conflict; a long prose value is not compared.
			fact("q1.fact-002", {
				slotId: "slot-002",
				entity: "RFC 9001",
				factType: "numeric",
				value: "RFC 9001",
				dateOrYear: undefined,
			}),
			fact("q2.fact-002", {
				slotId: "slot-002",
				entity: "RFC 9001",
				factType: "numeric",
				value: "RFC 9002",
				dateOrYear: undefined,
			}),
			fact("q2.fact-005", {
				slotId: "slot-002",
				entity: "RFC 9001",
				factType: "numeric",
				value:
					"RFC 9001 is one of the three core QUIC v1 documents published together",
				dateOrYear: undefined,
			}),
			// Unslotted and unparseable observations are ignored.
			fact("q4.fact-001", { slotId: "unslotted", dateOrYear: "2030-01" }),
			fact("q4.fact-002", { dateOrYear: "2024 snapshot" }),
		],
	});
	assert.deepEqual(result.summary, {
		comparedGroups: 2,
		conflictCount: 2,
		contestedSlotIds: ["slot-001", "slot-002"],
	});
	const [dateConflict, numberConflict] = result.conflicts;
	assert.equal(dateConflict.id, "conflict-001");
	assert.equal(dateConflict.label, "RFC 9000 publication");
	assert.equal(dateConflict.aspect, "date");
	assert.equal(dateConflict.action, "route_to_verifier");
	assert.deepEqual(
		dateConflict.values.map((entry) => [
			entry.normalized,
			entry.sourceTypes,
			entry.sourceUrls,
			entry.files,
		]),
		[
			["2021-05", ["web"], [RFC], []],
			["2022-05", ["local_repo"], [], ["notes.md"]],
			["2021", [], [], []],
		],
	);
	assert.equal(numberConflict.aspect, "number");
	assert.deepEqual(
		numberConflict.values.map((entry) => entry.normalized),
		["9001", "9002"],
	);

	// Resolution: a claim must state a value at the contested precision.
	assert.deepEqual(
		valuesStatedBy(dateConflict, "RFC 9000 was published in May 2021."),
		["2021-05", "2021"],
	);
	assert.deepEqual(valuesStatedBy(dateConflict, "RFC 9000, 2021년 5월 발행"), [
		"2021-05",
		"2021",
	]);
	assert.deepEqual(
		valuesStatedBy(dateConflict, "RFC 9000 defines QUIC version 1."),
		[],
	);
	assert.deepEqual(
		valuesStatedBy(numberConflict, "RFC 9002 covers loss detection."),
		["9002"],
	);

	// Agreement in different notations is not a conflict.
	const agree = detectSlotConflicts({
		planSlots: [{ id: "slot-001" }],
		extractedFacts: [
			fact("q1.fact-001", { dateOrYear: "2021-05" }),
			fact("q2.fact-001", { dateOrYear: "May 2021" }),
			fact("q3.fact-001", { dateOrYear: "2021" }),
		],
	});
	assert.deepEqual(agree.summary, {
		comparedGroups: 1,
		conflictCount: 0,
		contestedSlotIds: [],
	});
});

const plan = {
	factSlots: [
		{
			id: "slot-001",
			label: "RFC 9000 publication month",
			required: true,
			verificationPriority: "core",
		},
		{ id: "slot-002", label: "RFC 9001 scope" },
	],
	researchQuestions: [{ id: "rq-001" }],
};
const researchQuestion = (questionId, extractedFacts) => ({
	schema: "deep-research-research-question-v1",
	digest: questionId,
	questionId,
	question: "When was RFC 9000 published?",
	extractedFacts,
	claims: [],
	sources: [],
});
const researchSources = {
	"plan.main": plan,
	"research-questions.rq-001": researchQuestion("rq-001", [
		{
			slotId: "slot-001",
			entity: "RFC 9000",
			factType: "date",
			value: "May 2021",
			dateOrYear: "2021-05",
			sourceType: "web",
			sourceUrls: [RFC],
			quote: "May 2021",
		},
		{
			slotId: "slot-001",
			entity: "RFC 9000",
			factType: "date",
			value: "May 2022",
			dateOrYear: "2022-05",
			sourceType: "local_repo",
			file: "notes.md",
			lineStart: 3,
			lineEnd: 3,
			sourceRefs: ["notes-md"],
			quote: "RFC 9000 (May 2022)",
		},
		{
			slotId: "slot-002",
			entity: "RFC 9001",
			factType: "scope",
			value: "Uses TLS 1.3 to secure QUIC",
			dateOrYear: "2021-05",
			sourceUrls: ["https://www.rfc-editor.org/rfc/rfc9001.html"],
		},
	]),
};

test("normalize-input-packet emits slotConflicts with an instruction to route the slot to verification", async () => {
	const packet = await normalizeInputPacket({
		sources: researchSources,
		context: {
			sourceStatuses: [
				{
					source: "research-questions.rq-001",
					specId: "research-questions.rq-001",
					stageId: "research-questions",
					status: "completed",
					itemIdentity: "rq-001",
				},
			],
		},
	});
	const conflicts = packet.packet.slotConflicts;
	assert.equal(conflicts.schema, "deep-research-slot-conflicts-v1");
	assert.deepEqual(conflicts.summary.contestedSlotIds, ["slot-001"]);
	assert.deepEqual(
		conflicts.conflicts[0].values.map((entry) => [
			entry.normalized,
			entry.factIds,
			entry.sourceUrls,
			entry.files,
		]),
		[
			["2021-05", ["research-questions.rq-001.fact-001"], [RFC], []],
			["2022-05", ["research-questions.rq-001.fact-002"], [], ["notes.md"]],
		],
	);
	assert.match(
		packet.packet.instructions.slotConflicts,
		/status to conflicting/,
	);
	assert.match(
		packet.packet.instructions.slotConflicts,
		/verificationNeed core/,
	);
});

async function finalPacketFor({ normalizedStatus, verifierStatus, claimText }) {
	const inputPacket = await normalizeInputPacket({
		sources: researchSources,
		context: {},
	});
	const candidates = [
		{
			id: "claim-001",
			claim: claimText,
			sourceUrls: [RFC],
			sourceRefs: ["notes-md"],
			factSlotIds: ["slot-001"],
			verificationNeed: "core",
			sourceQuality: "primary",
		},
	];
	const normalized = {
		claimInventory: {
			verificationCandidates: candidates,
			preservedClaims: [],
			duplicates: [],
		},
		factSlotCoverage: [
			{
				slotId: "slot-001",
				label: "RFC 9000 publication month",
				status: normalizedStatus,
				bestValue: "May 2021",
				verificationCandidateIds: ["claim-001"],
				gapReason: "",
			},
			{
				slotId: "slot-002",
				label: "RFC 9001 scope",
				status: "partial",
				bestValue: "TLS 1.3",
				verificationCandidateIds: [],
				gapReason: "not selected",
			},
		],
		coverageGaps: [],
		researchScopeCoverage: [],
	};
	const owner = {
		source: "verify-claims.claim-001",
		stageId: "verify-claims",
		specId: "verify-claims.claim-001",
		taskId: "task-9",
		itemIdentity: "claim-001",
		placeholderSpecId: "verify-claims.item",
		status: "completed",
	};
	const audit = await claimGate({
		sources: {
			"plan.main": plan,
			"normalize-input-packet.main": inputPacket,
			"normalize-claims.main": normalized,
			"sanitize-claims.main": normalized,
			"verify-claims.claim-001": {
				id: "claim-001",
				status: verifierStatus,
				confidence: "high",
				verifierOwner: owner,
				evidence: [{ url: RFC, quote: "May 2021" }],
			},
		},
	});
	for (const row of audit.claimDigests) row.verifierOwner = owner;
	audit.verifierOwnerLedger = [owner];
	return finalPacket({
		sources: {
			"plan.main": plan,
			"normalize-input-packet.main": inputPacket,
			"normalize-claims.main": normalized,
			"sanitize-claims.main": normalized,
			"audit-claims.main": audit,
		},
	});
}

test("the final packet keeps a contested slot conflicting until a verified claim states one of the values", async () => {
	// The normalizer ignored the contest and the verifier could not verify: conflicting, with both values.
	const unresolved = await finalPacketFor({
		normalizedStatus: "filled",
		verifierStatus: "partially_supported",
		claimText: "RFC 9000 was published in May 2021.",
	});
	assert.equal(validateJsonSchema(unresolved, packetSchema).valid, true);
	const slot = unresolved.packet.factSlotCoverage.find(
		(row) => row.slotId === "slot-001",
	);
	assert.equal(slot.status, "conflicting");
	assert.match(
		slot.gapReason,
		/contested date for RFC 9000: 2021-05 vs 2022-05 \(conflict-001\) not resolved by a verified claim/,
	);
	assert.equal(unresolved.packet.factSlotStatusCounts.conflicting, 1);
	assert.equal(unresolved.packet.researchMetadataSeed.conflictingFactSlots, 1);
	assert.deepEqual(
		unresolved.packet.contestedSlots.map((row) => [
			row.id,
			row.slotId,
			row.aspect,
			row.resolution,
		]),
		[
			[
				"conflict-001",
				"slot-001",
				"date",
				{ status: "unresolved", claimIds: [], values: [] },
			],
		],
	);
	assert.deepEqual(
		unresolved.packet.factSlotReconciliation.unresolvedContestedSlotIds,
		["slot-001"],
	);

	// A verified claim stating "May 2021" settles it; the normalizer's status stands.
	const resolved = await finalPacketFor({
		normalizedStatus: "filled",
		verifierStatus: "verified",
		claimText: "RFC 9000 was published in May 2021.",
	});
	assert.equal(validateJsonSchema(resolved, packetSchema).valid, true);
	assert.equal(
		resolved.packet.factSlotCoverage.find((row) => row.slotId === "slot-001")
			.status,
		"filled",
	);
	assert.deepEqual(resolved.packet.contestedSlots[0].resolution, {
		status: "resolved_by_verified_claim",
		claimIds: ["claim-001"],
		values: ["2021-05"],
	});
	assert.deepEqual(
		resolved.packet.factSlotReconciliation.unresolvedContestedSlotIds,
		[],
	);

	// A verified claim about another aspect of the slot does not settle the date.
	const unrelated = await finalPacketFor({
		normalizedStatus: "filled",
		verifierStatus: "verified",
		claimText: "RFC 9000 defines QUIC version 1.",
	});
	assert.equal(
		unrelated.packet.factSlotCoverage.find((row) => row.slotId === "slot-001")
			.status,
		"conflicting",
	);
	assert.equal(
		unrelated.packet.contestedSlots[0].resolution.status,
		"unresolved",
	);

	// Report: the contest is in the audit, and an unresolved one in the reader's limits.
	for (const [packet, expectResolved] of [
		[unresolved, false],
		[resolved, true],
	]) {
		const rendered = await render({
			sources: {
				"final-audit.main": {
					schema: "deep-research-final-synthesis-v2",
					digest: "synthesis",
					inputIntegrity: { status: "complete" },
					synthesis: {
						bottomLine: "RFC 9000 was published in May 2021.",
						comparisonRows: [],
						keyFindingIds: expectResolved ? ["claim-001"] : [],
						recommendations: [],
						actionPlan: [],
						caveatNotes: [],
						parentDecisionNotes: [],
					},
				},
				"final-audit-packet.main": packet,
			},
		});
		assert.equal(
			rendered.status,
			"passed",
			JSON.stringify(rendered.packetReconciliation),
		);
		assert.match(rendered.auditMarkdown, /## Contested values \(engine\)/);
		assert.match(
			rendered.auditMarkdown,
			/\| slot-001 \| RFC 9000 \| date \| 2021-05 \(https:\/\/www\.rfc-editor\.org\/rfc\/rfc9000\.html\) vs 2022-05 \(notes\.md, notes-md\) \|/,
		);
		if (expectResolved) {
			assert.match(rendered.auditMarkdown, /\| 2021-05 by claim-001 \|/);
			assert.doesNotMatch(
				rendered.completionSummaryMarkdown,
				/Sources gave different values/,
			);
		} else {
			assert.match(rendered.auditMarkdown, /unresolved; slot is conflicting/);
			assert.match(
				rendered.completionSummaryMarkdown,
				/Sources gave different values for RFC 9000 \(2021-05 \/ 2022-05\); no verified evidence settled which is right\./,
			);
		}
	}
});
