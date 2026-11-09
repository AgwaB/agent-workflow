// agent-workflow 2026-11-08 (context-quality backlog P2): the engine's web quote check
// (check-web-quotes) is an input to audit-claims. A verified claim whose web quotes were all looked
// for on a fetched, readable page and not found is downgraded to partially_supported
// (web_quote_not_on_page); quotes the engine could not check never change a verdict.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";

const owner = (id) => ({
	source: `verify-claims.${id}`,
	stageId: "verify-claims",
	specId: `verify-claims.${id}`,
	taskId: `task-${id}`,
	itemIdentity: id,
	placeholderSpecId: "verify-claims.item",
	status: "completed",
});
const PAGE = "https://docs.example.test/page";
const candidate = (id) => ({
	id,
	claim: `Fact ${id} from the docs.`,
	sourceUrls: [PAGE],
	factSlotIds: ["slot-1"],
});
const verified = (id, quote) => ({
	id,
	status: "verified",
	confidence: "high",
	verifierOwner: owner(id),
	evidence: [{ url: PAGE, quote }],
});
const result = (claimId, index, grade, reason) => ({
	claimId,
	evidenceIndex: index,
	url: PAGE,
	quote: "q",
	grade,
	...(reason ? { reason } : {}),
});

async function audit(
	check,
	ids = ["claim-1", "claim-2", "claim-3", "claim-4"],
) {
	const candidates = ids.map(candidate);
	const sources = {
		"plan.main": { factSlots: [{ id: "slot-1" }] },
		"normalize-claims.main": {
			claimInventory: { verificationCandidates: candidates },
			factSlotCoverage: [],
		},
		"sanitize-claims.main": {
			claimInventory: { verificationCandidates: candidates },
			factSlotCoverage: [],
		},
		...Object.fromEntries(
			ids.map((id) => [`verify-claims.${id}`, verified(id, `quote for ${id}`)]),
		),
		...(check === undefined ? {} : { "check-web-quotes.main": check }),
	};
	const out = await claimGate({ sources });
	return {
		out,
		status: Object.fromEntries(
			out.auditedClaims.map((row) => [row.id, row.status]),
		),
		code: Object.fromEntries(
			out.auditedClaims.map((row) => [row.id, row.evidenceGate?.reasonCode]),
		),
	};
}

test("a verified claim whose only quotes are absent from the fetched page is downgraded; others keep their verdict", async () => {
	const { out, status, code } = await audit(
		{
			schema: "deep-research-web-quote-check-v1",
			enabled: true,
			results: [
				// claim-1: fetched, readable, quote not there → downgrade.
				result("claim-1", 0, "unverified", "quote-not-on-page"),
				// claim-2: found on the engine's re-fetch → unchanged.
				result("claim-2", 0, "verified-refetched"),
				// claim-3: one quote missing, another found → unchanged (not all absent).
				result("claim-3", 0, "unverified", "quote-not-on-page"),
				result("claim-3", 1, "verified-captured"),
				// claim-4: could not be checked (fetch failed) → unchanged; proves nothing.
				result("claim-4", 0, "unverified", "network-error"),
				// claim-5 (review 2026-11-09): one quote absent, the other unchecked → unchanged (not all looked for).
				result("claim-5", 0, "unverified", "quote-not-on-page"),
				result("claim-5", 1, "unverified", "network-error"),
			],
		},
		["claim-1", "claim-2", "claim-3", "claim-4", "claim-5"],
	);
	assert.deepEqual(status, {
		"claim-1": "partially_supported",
		"claim-2": "verified",
		"claim-3": "verified",
		"claim-4": "verified",
		"claim-5": "verified",
	});
	assert.equal(code["claim-1"], "web_quote_not_on_page");
	assert.equal(out.gateSummary.webQuoteCheck, "applied");
	assert.equal(out.gateSummary.webQuoteNotOnPageDowngrades, 1);
	const row = out.auditedClaims.find((entry) => entry.id === "claim-1");
	assert.deepEqual(row.evidenceGate.webQuoteCheck, {
		checked: 1,
		verified: 0,
		notOnPage: 1,
		unchecked: 0,
	});
	assert.ok(
		out.remainingGaps.some(
			(gap) =>
				gap.claimId === "claim-1" &&
				gap.evidenceState === "web_quote_not_on_page",
		),
	);
	const kept = out.auditedClaims.find((entry) => entry.id === "claim-3");
	assert.deepEqual(kept.verdictDigest.webQuoteCheck, {
		checked: 2,
		verified: 1,
		notOnPage: 1,
		unchecked: 0,
	});
});

test("an absent, disabled or failed quote check changes no verdict", async () => {
	for (const check of [
		undefined,
		{ schema: "deep-research-web-quote-check-v1", enabled: false, results: [] },
		{
			schema: "deep-research-web-quote-check-v1",
			enabled: true,
			error: "fetch pool unavailable",
			results: [],
		},
	]) {
		const { out, status } = await audit(check, ["claim-1"]);
		assert.equal(status["claim-1"], "verified");
		assert.equal(out.gateSummary.webQuoteCheck, "unavailable");
		assert.equal(out.gateSummary.webQuoteNotOnPageDowngrades, 0);
	}
});

test("audit-claims declares check-web-quotes as a source in both research specs", async () => {
	for (const file of [
		"../../workflows/deep-research/spec.json",
		"../../workflows/deep-research/tiered-verification.spec.json",
	]) {
		const spec = JSON.parse(
			await readFile(new URL(file, import.meta.url), "utf8"),
		);
		const audit = spec.artifactGraph.stages.find(
			(stage) => stage.id === "audit-claims",
		);
		assert.ok(audit.from.includes("check-web-quotes"), file);
		const index = (id) =>
			spec.artifactGraph.stages.findIndex((stage) => stage.id === id);
		assert.ok(index("check-web-quotes") < index("audit-claims"), file);
	}
});
