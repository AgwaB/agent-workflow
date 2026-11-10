import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateJsonSchema } from "../../dist/core/json-schema.js";

const schemaFor = (stage) =>
	JSON.parse(
		readFileSync(
			new URL(
				`../../workflows/deep-research/schemas/deep-research-${stage}-control.schema.json`,
				import.meta.url,
			),
			"utf8",
		),
	);
const planSchema = schemaFor("plan");
const normalizerSchema = schemaFor("normalize-claims");
const plan = {
	schema: "deep-research-plan-v1",
	digest: "plan",
	depth: "standard",
	taskType: "research_survey",
	researchAxes: [{}],
	factSlots: [{}],
	sourcePolicy: {},
	verificationPriorities: [{}],
	expectedFinalShape: {},
	planRisks: [],
	researchScope: [{}],
	researchQuestions: [{}],
	researchScopeCoverage: [{}],
	verificationRubric: {},
};
const normalized = {
	schema: "deep-research-normalize-claims-v1",
	digest: "normalized",
	claimInventory: {
		verificationCandidates: [
			{
				id: "claim-001",
				claim: "RFC 9000 was published in May 2021.",
				verificationNeed: "core",
			},
		],
		preservedClaims: [
			{ id: "preserved-001", claim: "RFC 9000 specifies QUIC." },
		],
		duplicates: [],
	},
	factSlotCoverage: [{ slotId: "slot-001", status: "filled" }],
};

// agent-workflow 2026-11-10 (regression audit G7): unconstrained plan enums and missing normalizer fields passed validation — 0b1b077
test("plan and normalizer reject invalid enums and missing consumed fields", async (t) => {
	assert.equal(validateJsonSchema(plan, planSchema).valid, true);
	assert.equal(validateJsonSchema(normalized, normalizerSchema).valid, true);
	const alternateId = structuredClone(normalized);
	alternateId.factSlotCoverage[0].id = "slot-001";
	delete alternateId.factSlotCoverage[0].slotId;
	assert.equal(
		validateJsonSchema(alternateId, normalizerSchema).valid,
		true,
		"slot id is an accepted alternative to slotId",
	);
	for (const field of ["depth", "taskType"]) {
		await t.test(`plan rejects invalid ${field}`, () => {
			const control = { ...plan, [field]: "invalid" };
			const result = validateJsonSchema(control, planSchema);
			assert.equal(result.valid, false, `invalid ${field} must be rejected`);
			assert.deepEqual(
				result.issues.map((issue) => issue.path),
				[`$.${field}`],
			);
		});
	}
	const cases = [
		["candidate id", "claimInventory.verificationCandidates.0", ["id"]],
		["candidate claim", "claimInventory.verificationCandidates.0", ["claim"]],
		[
			"candidate verificationNeed",
			"claimInventory.verificationCandidates.0",
			["verificationNeed"],
		],
		["preserved id", "claimInventory.preservedClaims.0", ["id"]],
		["preserved claim", "claimInventory.preservedClaims.0", ["claim"]],
		["slot status", "factSlotCoverage.0", ["status"]],
		["slot identifiers", "factSlotCoverage.0", ["slotId", "id"]],
	];
	for (const [name, target, fields] of cases) {
		await t.test(`normalizer requires ${name}`, () => {
			const control = structuredClone(normalized);
			const row = target.split(".").reduce((value, key) => value[key], control);
			for (const field of fields) delete row[field];
			const result = validateJsonSchema(control, normalizerSchema);
			assert.equal(result.valid, false, `missing ${name} must be rejected`);
			const rowPath = `$.${target.replace(/\.0$/, "[0]")}`;
			assert.deepEqual(
				result.issues.map((issue) => issue.path),
				[fields.length === 1 ? `${rowPath}.${fields[0]}` : rowPath],
			);
		});
	}
});
