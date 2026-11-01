// agent-workflow 2026-11-01: deep-research's experimental check-web-quotes stage. Off by default;
// when the owner opts in, every verifier evidence row with an http(s) URL and a quote goes to the
// engine's web quote check. The report shows the counts (final report) and every unchecked quote
// with its reason (audit); claim verdicts are not changed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import checkWebQuotes, {
	collectWebQuotes,
} from "../../workflows/deep-research/helpers/check-web-quotes.mjs";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const VERIFIERS = {
	"verify-claims": [
		{
			id: "claim-001",
			status: "verified",
			evidence: [
				{ url: "https://docs.example.com/a", quote: "The cache is cleared." },
				{ url: "src/local.ts", line: 3, quote: "local code" },
				{ sourceUrl: "https://img.example.com/t.png", quote: "96.6" },
			],
		},
	],
	"verify-claims.batch-2": {
		id: "claim-002",
		status: "partially_supported",
		evidence: [{ url: "http://docs.example.com/b", quote: "" }],
	},
	"audit-claims": {
		id: "not-a-verifier",
		evidence: [{ url: "https://x/", quote: "x" }],
	},
};

test("off unless the experimental flag is set", async () => {
	for (const context of [{}, { evidence: { refetchEnabled: false } }]) {
		const result = await checkWebQuotes({ sources: VERIFIERS, context });
		assert.equal(result.enabled, false);
		assert.deepEqual(result.results, []);
		assert.match(
			result.digest,
			/AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH=1/,
		);
	}
});

test("collects web evidence rows from verifier stages only", () => {
	assert.deepEqual(
		collectWebQuotes(VERIFIERS).map(({ key, url, quote }) => ({
			key,
			url,
			quote,
		})),
		[
			{
				key: "claim-001#0",
				url: "https://docs.example.com/a",
				quote: "The cache is cleared.",
			},
			{
				key: "claim-001#2",
				url: "https://img.example.com/t.png",
				quote: "96.6",
			},
			{ key: "claim-002#0", url: "http://docs.example.com/b", quote: "" },
		],
	);
});

const ENGINE_RESULTS = {
	results: [
		{
			key: "claim-001#0",
			url: "https://docs.example.com/a",
			grade: "verified-refetched",
			level: "exact",
			view: "rendered",
			page: {
				url: "https://docs.example.com/a",
				finalUrl: "https://docs.example.com/a",
				status: 200,
				contentType: "text/html",
				bodySha256: "a".repeat(64),
				bytes: 10,
				fetchedAt: "2026-11-01T00:00:00.000Z",
				fromCache: false,
			},
		},
		{
			key: "claim-001#2",
			url: "https://img.example.com/t.png",
			grade: "unverified",
			reason: "image",
		},
		{
			key: "claim-002#0",
			url: "http://docs.example.com/b",
			grade: "unverified",
			reason: "no-quote",
		},
	],
	summary: {
		quotes: 3,
		pages: 2,
		verified: 1,
		unverified: 2,
		byLevel: { exact: 1 },
		byReason: { image: 1, "no-quote": 1 },
	},
};

test("when enabled, the engine checks the rows and the stage records the outcome", async () => {
	const asked = [];
	const result = await checkWebQuotes({
		sources: VERIFIERS,
		context: {
			evidence: {
				refetchEnabled: true,
				checkWebQuotes: async (rows) => {
					asked.push(...rows);
					return ENGINE_RESULTS;
				},
			},
		},
	});
	assert.equal(asked.length, 3);
	assert.equal(result.enabled, true);
	assert.match(
		result.digest,
		/1 of 3 quotes found on the cited page \(2 pages\); 2 not checked/,
	);
	assert.deepEqual(
		result.results.map((row) => [
			row.claimId,
			row.evidenceIndex,
			row.grade,
			row.reason ?? row.level,
		]),
		[
			["claim-001", 0, "verified-refetched", "exact"],
			["claim-001", 2, "unverified", "image"],
			["claim-002", 0, "unverified", "no-quote"],
		],
	);
	assert.equal(result.results[0].page.bodySha256, "a".repeat(64));
	assert.equal(result.results[1].quote, "96.6");
});

test("an engine failure is recorded, not thrown", async () => {
	const result = await checkWebQuotes({
		sources: VERIFIERS,
		context: {
			evidence: {
				refetchEnabled: true,
				checkWebQuotes: async () => {
					throw new Error("disk full");
				},
			},
		},
	});
	assert.equal(result.enabled, true);
	assert.equal(result.error, "disk full");
});

const fixture = JSON.parse(
	await readFile(
		new URL(
			"../fixtures/deep-research/max-synthesis-handoff-replay.json",
			import.meta.url,
		),
		"utf8",
	),
);

async function reportSources() {
	const packet = await finalPacket({
		sources: structuredClone(fixture.sources),
	});
	return {
		"final-audit-packet": packet,
		"final-audit": {
			schema: "deep-research-final-synthesis-v2",
			inputIntegrity: { status: "complete" },
			digest: "Reader-facing result",
			synthesis: {
				bottomLine:
					"The documented behaviour was confirmed; demand was not measured.",
				comparisonRows: ["A", "B", "C"].map((area) => ({
					area,
					subjectStatus: "Current",
					referencePattern: "Reference",
					assessment: "Unknown is not absent",
					supportingClaimIds: ["claim-001"],
				})),
				keyFindingIds: ["claim-001"],
				recommendations: [
					{
						recommendation: "Verify recovery first.",
						supportingClaimIds: ["claim-001"],
					},
				],
				actionPlan: [],
				caveatNotes: [],
				parentDecisionNotes: [],
			},
		},
	};
}

test("the report shows the counts and lists unchecked quotes with reasons; verdicts unchanged", async () => {
	const plain = await render({ sources: await reportSources() });
	assert.equal(plain.status, "passed", JSON.stringify(plain.gates));
	assert.doesNotMatch(
		plain.executiveMarkdown + plain.auditMarkdown,
		/Quote check/,
	);
	assert.equal(plain.quoteCheck, undefined);

	const stage = await checkWebQuotes({
		sources: VERIFIERS,
		context: {
			evidence: {
				refetchEnabled: true,
				checkWebQuotes: async () => ENGINE_RESULTS,
			},
		},
	});
	const sources = { ...(await reportSources()), "check-web-quotes": stage };
	const checked = await render({ sources });
	assert.equal(checked.status, "passed", JSON.stringify(checked.gates));
	assert.match(
		checked.executiveMarkdown,
		/Quote check \(engine re-fetch, experimental\): 1 of 3 quotes found on the cited page; 2 not checked \(image 1, no quote given 1\)/,
	);
	assert.match(
		checked.auditMarkdown,
		/## Quote check \(engine re-fetch, experimental\)/,
	);
	assert.match(
		checked.auditMarkdown,
		/\| claim-001 \| https:\/\/img\.example\.com\/t\.png \| 96\.6 \| image \|/,
	);
	assert.deepEqual(checked.claimSummary, plain.claimSummary);
	assert.equal(checked.quoteCheck.verified, 1);

	// A disabled stage adds nothing.
	const off = await render({
		sources: {
			...(await reportSources()),
			"check-web-quotes": { enabled: false, results: [] },
		},
	});
	assert.doesNotMatch(off.executiveMarkdown + off.auditMarkdown, /Quote check/);
});
