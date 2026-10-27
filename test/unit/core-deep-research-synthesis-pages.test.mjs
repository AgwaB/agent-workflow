// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/deep-research-synthesis-pages.test.mjs. MIT, same author. Changes: imports from dist/core (subagent-backend names from their WP4c modules); harness from test/helpers/; setSubagentApiForTests→setTaskRuntimeApiForTests; paths .pi/{workflows,agents,workflow-subagents}→.agent-workflow/…, env PI_WORKFLOW_*→AGENT_WORKFLOW_*.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { checkRequiredArtifactReads } from "../../dist/core/required-reads.js";
import { validateJsonSchema } from "../../dist/core/json-schema.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import {
	SYNTHESIS_PAGE_COUNT as PAGES,
	SYNTHESIS_READ_MAX_CHARS as MAX,
	buildSynthesisPages,
	canonicalSynthesisData,
	reconstructSynthesisPages,
	validateSynthesisPages,
} from "../../workflows/deep-research/helpers/synthesis-pages.mjs";
import {
	DEFAULT_MCP_OUTPUT_TOKENS,
	mcpOutputLimitChars,
} from "../../dist/executors/claude/config.js";
import { CODEX_MCP_OUTPUT_LIMIT_CHARS } from "../../dist/executors/codex/index.js";
import {
	PI_MCP_OUTPUT_LIMIT_CHARS,
	PI_MCP_OUTPUT_NOTICE_CHARS,
} from "../../dist/executors/pi/index.js";
import {
	artifactServerOutputLimit,
	fitsDeliveryLimit,
} from "../../dist/sdk/mcp-delivery.js";
import { artifactReadFixture } from "../helpers/workflow-artifact-fixture.mjs";

const fixture = JSON.parse(
	await readFile(
		new URL(
			"../fixtures/deep-research/max-synthesis-handoff-replay.json",
			import.meta.url,
		),
		"utf8",
	),
);
const schema = JSON.parse(
	await readFile(
		new URL(
			"../../workflows/deep-research/schemas/deep-research-final-audit-packet-control.schema.json",
			import.meta.url,
		),
		"utf8",
	),
);
const paths = [
	"$.packet.synthesisInput.header",
	...Array.from(
		{ length: PAGES },
		(_, i) => `$.packet.synthesisInput.pages[${i}]`,
	),
];
// Index of the last page read in `required` (index 0 is the header).
const LAST = PAGES;
const required = paths.map((path) => ({
	source: "final-audit-packet",
	artifact: "control",
	path,
	maxChars: MAX,
	count: 1,
}));
const overlay = {
	schema: "deep-research-final-synthesis-v1",
	digest: "Synthetic scale handoff; evidence remains limited.",
	synthesis: {
		bottomLine:
			"Regional freshness defaults are supported; historical client compatibility remains unresolved.",
		keyFindingIds: ["claim-001", "claim-018", "claim-019"],
		recommendations: [
			{
				recommendation: "Test legacy clients before rollout.",
				supportingClaimIds: ["claim-019"],
			},
		],
		actionPlan: [],
		caveatNotes: [
			{
				note: "Partial evidence is not a rollout guarantee.",
				relatedClaimIds: ["claim-019"],
				gapIds: ["gap-remaining-001"],
			},
		],
		parentDecisionNotes: [],
	},
};
const renderPacket = (control) =>
	render({
		sources: { "final-audit-packet": control, "final-audit": overlay },
	});
const json = (value) => JSON.parse(JSON.stringify(value));

function deliveredValue(result) {
	assert.equal(result.details.truncated, false);
	return JSON.parse(result.content[0].text.split("\n\n").slice(1).join("\n\n"))
		.value;
}

async function readBank(t, control) {
	const f = await artifactReadFixture(t, control, "final-audit-packet");
	const delivered = [];
	for (const requirement of required) {
		const result = await f.read(requirement);
		const value = deliveredValue(result);
		assert.equal(
			result.details.projection.originalChars,
			JSON.stringify(value).length,
		);
		assert(JSON.stringify(value).length <= MAX);
		assert(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX);
		delivered.push(value);
	}
	assert.deepEqual(await checkRequiredArtifactReads(f.consumer, required), {
		missing: [],
		projectionFailures: [],
	});
	return { f, input: { header: delivered[0], pages: delivered.slice(1) } };
}

test("both research specs require the exact header and all sixteen indexed pages", async () => {
	for (const filename of ["spec.json", "tiered-verification.spec.json"]) {
		const spec = JSON.parse(
			await readFile(
				new URL(`../../workflows/deep-research/${filename}`, import.meta.url),
				"utf8",
			),
		);
		const stage = spec.artifactGraph.stages.find(
			(row) => row.id === "final-audit",
		);
		assert.deepEqual(stage.inputPolicy.requiredReads, required);
		assert.equal(stage.inputPolicy.enforcement, "fail");
		for (const path of paths) assert(stage.prompt.includes(path));
		assert.match(stage.prompt, /including empty tails/);
		assert.match(stage.prompt, /Do not make extra workflow_artifact reads/);
		assert.doesNotMatch(stage.prompt, /synthesisInput\.integritySummary/);
		if (filename === "tiered-verification.spec.json") {
			assert.match(
				stage.prompt,
				/packet\.verifierIntegrity\.invalidNormalizedCandidateCount/,
			);
			assert.match(
				stage.prompt,
				/packet\.verifierIntegrity\.invalidNormalizedCandidateRows/,
			);
		}
	}
});

test("48 evidence-bearing claims, 56 slots, 22 questions reach actual synthesis reads losslessly", async (t) => {
	const control = await finalPacket({ sources: fixture.sources });
	const packet = control.packet;
	assert.equal(validateJsonSchema(control, schema).valid, true);
	assert.equal(packet.synthesisInput.header.budgetBlock, undefined);
	assert(JSON.stringify(packet.synthesisInput).length > 8 * MAX);
	const { input } = await readBank(t, control);
	const decoded = reconstructSynthesisPages(input);
	assert.deepEqual(decoded, canonicalSynthesisData(packet));
	assert.deepEqual(
		validateSynthesisPages({ ...packet, synthesisInput: input }),
		[],
	);
	assert.equal(decoded.claimVerdictLedger.length, 48);
	assert.equal(decoded.factSlotCoverage.length, 56);
	assert.equal(decoded.researchQuestionCoverage.length, 22);
	assert.equal(decoded.preservedClaims.length, 24);
	assert.equal(decoded.researchScopeCoverage.length, 16);
	assert.equal(decoded.remainingGaps.length + decoded.coverageGaps.length, 47);
	const evidence = decoded.claimVerdictLedger.flatMap((row) => row.evidence);
	assert.equal(
		new Set(evidence.map((row) => JSON.stringify(row))).size,
		evidence.length,
	);
	assert(evidence.length >= 48);
	for (const [index, claim] of decoded.claimVerdictLedger.entries()) {
		const audited = fixture.sources["audit-claims"].claimDigests[index];
		assert.deepEqual(claim, json(packet.claimVerdictLedger[index]));
		assert.equal(claim.support, audited.verdictDigest.support);
		assert.equal(claim.caveat, audited.verdictDigest.caveat);
		assert.equal(claim.claim, audited.claim);
		assert.equal(
			claim.correctionOrCounterclaim,
			audited.correctionOrCounterclaim,
		);
		assert.deepEqual(claim.evidence, audited.evidence);
		assert(claim.support.length > 120);
	}
	const result = await renderPacket(control);
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	const contradictory = structuredClone(control);
	contradictory.packet.verifierIntegrity.gateSummary.sourceRefJoinFailures = 1;
	contradictory.packet.synthesisInput = buildSynthesisPages(
		contradictory.packet,
	);
	assert.deepEqual(validateSynthesisPages(contradictory.packet), []);
	const rejected = await renderPacket(contradictory);
	assert.equal(rejected.status, "failed");
	assert(
		rejected.gates.packetReconciliationBlockers.includes(
			"gate source-ref count does not match rows",
		),
	);
	assert.equal(result.claimSummary.verified, 18);
	assert.equal(result.claimSummary.partially_supported, 30);
	assert.equal(result.factSlotSummary.partial, 48);
	assert.equal(result.factSlotSummary.missingOrConflicting, 8);
	assert.equal(result.gates.packetReconciliationPassed, true);
	const reordered = await finalPacket({
		sources: Object.fromEntries(Object.entries(fixture.sources).reverse()),
	});
	assert.deepEqual(reordered, control);
	const rowsReordered = structuredClone(fixture.sources);
	rowsReordered["audit-claims"].claimDigests.reverse();
	const reversed = await finalPacket({ sources: rowsReordered });
	assert.deepEqual(
		reconstructSynthesisPages(reversed.packet.synthesisInput),
		canonicalSynthesisData(reversed.packet),
	);
});

test("real read gate rejects missing tail, wrong root, truncation, and duplicate qualifying reads", async (t) => {
	const control = await finalPacket({ sources: fixture.sources });
	const f = await artifactReadFixture(t, control, "final-audit-packet");
	// Even an untruncated whole-root read is not a different required path.
	// This larger read is a negative test only, never an allowed synthesis call.
	await f.read({ path: "$.packet", maxChars: 1000000 });
	assert.equal(
		(await checkRequiredArtifactReads(f.consumer, required)).missing.length,
		required.length,
	);
	for (const req of required.slice(0, -1)) await f.read(req);
	assert.equal(
		(await checkRequiredArtifactReads(f.consumer, required)).missing.length,
		1,
	);
	const damaged = structuredClone(control);
	damaged.packet.synthesisInput.pages[PAGES - 1].entries.push({
		field: "hostile",
		value: "😀".repeat(MAX),
	});
	await writeFile(f.bundle.files.control, JSON.stringify(damaged));
	const clipped = await f.read(required[LAST]);
	assert.equal(clipped.details.truncated, true);
	assert.equal(
		(await checkRequiredArtifactReads(f.consumer, required)).missing.length,
		1,
	);
	await writeFile(f.bundle.files.control, JSON.stringify(control));
	await f.read(required[LAST]);
	assert.deepEqual(await checkRequiredArtifactReads(f.consumer, required), {
		missing: [],
		projectionFailures: [],
	});
	await f.read(required[LAST]);
	assert.equal(
		(await checkRequiredArtifactReads(f.consumer, required)).missing.length,
		1,
	);
});

test("missing, duplicate, extra, tampered and hidden omitted canonical page data fail render", async () => {
	const control = await finalPacket({ sources: fixture.sources });
	for (const mutate of [
		(p) => {
			p.synthesisInput.pages.pop();
		},
		(p) => {
			p.synthesisInput.pages[1] = structuredClone(p.synthesisInput.pages[0]);
		},
		(p) => {
			p.synthesisInput.pages[1] = {
				...structuredClone(p.synthesisInput.pages[0]),
				index: 1,
			};
			p.synthesisInput.header.pageEntryCounts[1] =
				p.synthesisInput.pages[1].entries.length;
		},
		(p) => {
			p.synthesisInput.pages.push({ index: PAGES, entries: [] });
		},
		(p) => {
			p.synthesisInput.header.pageCount = PAGES - 1;
		},
		(p) => {
			p.synthesisInput.header.pageEntryCounts[0] += 1;
		},
		(p) => {
			p.synthesisInput.pages[0].entries.push(
				p.synthesisInput.pages[0].entries[0],
			);
		},
		(p) => {
			p.synthesisInput.pages
				.flatMap((page) => page.entries)
				.find((e) => e.field === "claimVerdictLedger").value.support =
				"tampered";
		},
		(p) => {
			p.synthesisInput.pages
				.flatMap((page) => page.entries)
				.find((e) => e.field === "claimVerdictLedger").value.evidence[0].quote =
				"tampered";
		},
		(p) => {
			p.synthesisInput = buildSynthesisPages({
				...canonicalSynthesisData(p),
				claimVerdictLedger: [],
			});
		},
		(p) => {
			p.synthesisInput = buildSynthesisPages({
				...canonicalSynthesisData(p),
				researchQuestionCoverage: [],
				factSlotCoverage: [],
			});
		},
		(p) => {
			p.synthesisInput = buildSynthesisPages({
				...canonicalSynthesisData(p),
				preservedClaims: [],
				remainingGaps: [],
				researchScopeCoverage: [],
			});
		},
		(p) => {
			p.synthesisInput = buildSynthesisPages({});
		},
		(p) => {
			delete p.synthesisInput;
		},
	]) {
		const damaged = structuredClone(control);
		mutate(damaged.packet);
		assert(validateSynthesisPages(damaged.packet).length > 0);
		const result = await renderPacket(damaged);
		assert(
			["failed", "blocked"].includes(result.status),
			JSON.stringify(result.gates),
		);
	}
});

test("exact boundary counts UTF-8 bytes and JSON escaping but excludes tool envelope; no surrogate clipping", async (t) => {
	const canonical = {
		claimVerdictLedger: [
			{ id: "claim-astral-😀", claim: '😀 " \\ \n \t \u0000' },
		],
	};
	let input = buildSynthesisPages(canonical);
	const padding =
		MAX - Buffer.byteLength(JSON.stringify(input.pages[0]), "utf8");
	canonical.claimVerdictLedger[0].claim += "x".repeat(padding);
	input = buildSynthesisPages(canonical);
	assert.equal(Buffer.byteLength(JSON.stringify(input.pages[0]), "utf8"), MAX);
	assert(JSON.stringify(input.pages[0]).length < MAX);
	const { f, input: delivered } = await readBank(t, {
		schema: "test",
		digest: "boundary",
		packet: { ...canonical, synthesisInput: input },
	});
	assert.deepEqual(reconstructSynthesisPages(delivered), canonical);
	const response = await f.read(required[1]);
	assert(
		response.content[0].text.length > MAX,
		"envelope is outside the selected-value cap",
	);
	canonical.claimVerdictLedger[0].claim += "😀";
	const blocked = buildSynthesisPages(canonical);
	assert.equal(blocked.header.budgetBlock.reason, "oversized_row");
	assert.equal(canonical.claimVerdictLedger[0].claim.endsWith("😀"), true);
});

test("empty collections require empty tails; hostile row, metadata and exhausted bank stay blocked", async (t) => {
	const canonical = {
		claimVerdictLedger: [],
		factSlotCoverage: [],
		researchQuestionCoverage: [],
		preservedClaims: [],
		remainingGaps: [],
		coverageGaps: [],
		researchScopeCoverage: [],
	};
	const input = buildSynthesisPages(canonical);
	assert(input.pages.every((page) => page.entries.length === 0));
	const emptyControl = {
		schema: "test",
		digest: "empty",
		packet: { ...canonical, synthesisInput: input },
	};
	const { input: delivered } = await readBank(t, emptyControl);
	assert.deepEqual(reconstructSynthesisPages(delivered), canonical);
	const missingTail = await artifactReadFixture(
		t,
		emptyControl,
		"final-audit-packet",
	);
	for (const req of required.slice(0, -1)) await missingTail.read(req);
	assert.equal(
		(await checkRequiredArtifactReads(missingTail.consumer, required)).missing
			.length,
		1,
	);
	assert.deepEqual(deliveredValue(await missingTail.read(required[LAST])), {
		index: PAGES - 1,
		entries: [],
	});
	assert.deepEqual(
		await checkRequiredArtifactReads(missingTail.consumer, required),
		{ missing: [], projectionFailures: [] },
	);
	const emptyPacket = await finalPacket({
		sources: {
			plan: { researchQuestions: [], factSlots: [] },
			"normalize-claims": {
				claimInventory: { verificationCandidates: [], preservedClaims: [] },
				factSlotCoverage: [],
				coverageGaps: [],
				researchScopeCoverage: [],
			},
			"audit-claims": {
				claimDigests: [],
				gateSummary: { missingVerifierResults: 0 },
				verdictCounts: { verified: 0 },
			},
		},
	});
	assert.deepEqual(
		reconstructSynthesisPages(emptyPacket.packet.synthesisInput),
		canonicalSynthesisData(emptyPacket.packet),
	);
	assert.equal(validateJsonSchema(emptyPacket, schema).valid, true);
	for (const [data, reason] of [
		[
			{ claimVerdictLedger: [{ id: "hostile-" + "😀".repeat(12000) }] },
			"oversized_row",
		],
		[
			{ verifierIntegrity: { hostile: "\\\u0000".repeat(6000) } },
			"oversized_row",
		],
		[
			{
				claimVerdictLedger: Array.from({ length: PAGES + 1 }, (_, index) => ({
					id: `claim-${index}`,
					support: "x".repeat(MAX - 500),
				})),
			},
			"page_bank_exhausted",
		],
	]) {
		const original = structuredClone(data);
		const blocked = buildSynthesisPages(data);
		assert.equal(blocked.header.budgetBlock.reason, reason);
		assert.equal(blocked.header.budgetBlock.canonicalLedgerPreserved, true);
		assert.deepEqual(data, original);
		assert(blocked.pages.every((page) => page.entries.length === 0));
		assert.throws(() => reconstructSynthesisPages(blocked));
		await readBank(t, {
			schema: "test",
			digest: "blocked",
			packet: { ...data, synthesisInput: blocked },
		});
	}
	const exhausted = await finalPacket({ sources: fixture.sources });
	for (const claim of exhausted.packet.claimVerdictLedger.slice(0, 10))
		claim.support = "x".repeat(10000);
	const before = canonicalSynthesisData(exhausted.packet);
	exhausted.packet.synthesisInput = buildSynthesisPages(exhausted.packet);
	assert.equal(
		exhausted.packet.synthesisInput.header.budgetBlock.reason,
		"page_bank_exhausted",
	);
	assert.deepEqual(canonicalSynthesisData(exhausted.packet), before);
	const rendered = await renderPacket(exhausted);
	assert.equal(rendered.status, "failed");
	assert(
		rendered.gates.packetReconciliationBlockers.includes(
			"synthesis input budget block is present",
		),
	);
});

// Live bundle 3 (M16): Pi's artifact server limit is 18,432 (UTF-16 units and UTF-8 bytes); 24,000-unit
// pages were cut by the server, marked deliveryUnverified and failed final-audit's required reads.
test("every synthesis read fits each stage-1 executor's workflow_artifact delivery limit", async (t) => {
	const limits = {
		pi: artifactServerOutputLimit({
			mcpOutputLimitChars: PI_MCP_OUTPUT_LIMIT_CHARS,
			mcpOutputNoticeChars: PI_MCP_OUTPUT_NOTICE_CHARS,
		}),
		claude: artifactServerOutputLimit({
			mcpOutputLimitChars: mcpOutputLimitChars(DEFAULT_MCP_OUTPUT_TOKENS),
		}),
		codex: artifactServerOutputLimit({
			mcpOutputLimitChars: CODEX_MCP_OUTPUT_LIMIT_CHARS,
		}),
	};
	assert.equal(limits.pi, 18432);
	const smallest = Math.min(...Object.values(limits));
	// A full page of multi-byte text: at the byte cap, far below the UTF-16 cap.
	const korean = { claimVerdictLedger: [{ id: "claim-ko", claim: "" }] };
	let page = buildSynthesisPages(korean).pages[0];
	korean.claimVerdictLedger[0].claim = "가".repeat(
		Math.floor((MAX - Buffer.byteLength(JSON.stringify(page), "utf8")) / 3),
	);
	page = buildSynthesisPages(korean).pages[0];
	assert(Buffer.byteLength(JSON.stringify(page), "utf8") > MAX - 3);
	assert.equal(page.entries.length, 1);
	for (const control of [
		await finalPacket({ sources: fixture.sources }),
		{
			schema: "test",
			digest: "multi-byte",
			packet: { ...korean, synthesisInput: buildSynthesisPages(korean) },
		},
	]) {
		const f = await artifactReadFixture(t, control, "final-audit-packet");
		for (const requirement of required) {
			const result = await f.read(requirement);
			const text = result.content.map((part) => part.text).join("");
			assert.equal(result.details.truncated, false, requirement.path);
			assert(
				fitsDeliveryLimit(text, smallest),
				`${requirement.path}: ${text.length} units / ${Buffer.byteLength(text, "utf8")} bytes > ${smallest}`,
			);
		}
	}
});
