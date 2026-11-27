import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createArtifactGraphRuntimeValidationSnapshot,
	executeSupportTask,
} from "../../dist/core/artifact-graph-runtime.js";
import {
	validateJsonSchema,
	validateJsonSchemaSubset,
} from "../../dist/core/json-schema.js";
import { fromStatePath } from "../../dist/core/store.js";
import {
	buildWorkflowOutputRetryInstructions,
	parseWorkflowOutputForBundle,
} from "../../dist/core/workflow-output-artifacts.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render, {
	numbersDroppedBy,
} from "../../workflows/deep-research/helpers/render-executive.mjs";
import { buildSynthesisPages } from "../../workflows/deep-research/helpers/synthesis-pages.mjs";
import translationCheck from "../../workflows/deep-research/helpers/translation-check.mjs";
import * as h from "../helpers/unit-test-support.mjs";

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
			"../../workflows/deep-research/schemas/deep-research-final-synthesis-v2-control.schema.json",
			import.meta.url,
		),
		"utf8",
	),
);
// Validate live output independently from the historical input used by most renderer tests.
function liveControl(control) {
	const { bottomLine, ...synthesis } = control.synthesis;
	return {
		...control,
		synthesis: {
			...synthesis,
			conclusion: [bottomLine, "Check the evidence."],
			keyPoints: [],
		},
	};
}

async function inputs(edit = (_sources) => {}) {
	const packetSources = structuredClone(fixture.sources);
	edit(packetSources);
	const packet = await finalPacket({ sources: packetSources });
	const synthesis = {
		bottomLine:
			"문서상 기능은 확인했지만 실제 수요와 기능 부재는 확인하지 못했습니다.",
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
				recommendation: "조건 확인 + 안전한 복구를 먼저 검증하세요.",
				supportingClaimIds: ["claim-001"],
			},
		],
		actionPlan: [],
		caveatNotes: [
			{
				note: "claim-001 source-ref join: schema cap and fact slots require audit.",
				relatedClaimIds: ["claim-001"],
				gapIds: ["gap-remaining-001"],
			},
		],
		parentDecisionNotes: [],
	};
	return {
		"final-audit-packet": packet,
		"final-audit": {
			schema: "deep-research-final-synthesis-v2",
			inputIntegrity: { status: "complete" },
			digest: "Reader-facing result",
			synthesis,
		},
	};
}

test("historical synthesis stays readable without copying audit-only caveats or changing source evidence", async () => {
	const sources = await inputs();
	const before = structuredClone(sources);
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.deepEqual(sources, before);
	assert.doesNotMatch(
		result.completionSummaryMarkdown,
		/Audited claims|Fact slots|schema.cap|fact slots|claim-001|source-ref|denominator|evidence:/,
	);
	assert.doesNotMatch(
		result.completionSummaryMarkdown,
		/추가로 확인할 질문이 남아/,
	);
	assert.match(result.auditMarkdown, /claim-001 source-ref join/);
	assert.match(result.auditMarkdown, /Audited claims \(48 total\)/);
	assert.equal(result.claimSummary.total, 48);
});

test("completion escapes raw prose exactly once including comparison cells", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	synthesis.recommendations[0].recommendation =
		"A + B <script> & *literal* [text](target)";
	synthesis.comparisonRows[0].assessment = "A + B | C <script>\nnew line";
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	assert.ok(
		result.completionSummaryMarkdown.includes(
			"A \\+ B &lt;script&gt; &amp; \\*literal\\* \\[text\\](target)",
		),
	);
	assert.ok(
		result.completionSummaryMarkdown.includes(
			"A \\+ B \\| C &lt;script&gt; new line",
		),
	);
	assert.ok(!result.completionSummaryMarkdown.includes("\\\\\\+"));
	assert.doesNotMatch(result.completionSummaryMarkdown, /<script>|&amp;lt;/);
});

test("deep-research keeps the established completion bytes for tilde prose", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	const text = "Keep ~~draft~~ wording";
	synthesis.bottomLine = `${text}.`;
	sources["final-audit"] = liveControl(sources["final-audit"]);
	sources["final-audit"].synthesis.keyPoints = [
		{ title: "~~draft~~ guidance", text },
	];
	synthesis.comparisonRows[0].assessment = text;
	synthesis.recommendations[0].recommendation = text;
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	assert.deepEqual(
		result.completionSummaryMarkdown
			.split("\n")
			.filter((line) => line.includes("draft")),
		[
			`${text}.`,
			String.raw`- **\~~draft~~ guidance** — ${text}`,
			`| A | Current | Reference | ${text} (Proposal) |`,
			`- ${text} (Proposal)`,
		],
	);
});

test("reader limitations are distinct and bounded while all audit notes remain", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	synthesis.caveatNotes = Array.from({ length: 10 }, (_, i) => ({
		note: `Internal audit detail ${i}: claim-001`,
		readerNote: `Practical limitation ${Math.floor(i / 2)} changes the decision.`,
		relatedClaimIds: ["claim-001"],
	}));
	assert.equal(
		validateJsonSchema(liveControl(sources["final-audit"]), schema).valid,
		true,
	);
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	assert.equal(
		(result.completionSummaryMarkdown.match(/Practical limitation/g) ?? [])
			.length,
		4,
	);
	assert.doesNotMatch(
		result.completionSummaryMarkdown,
		/Internal audit detail|Practical limitation 4/,
	);
	for (let i = 0; i < 10; i++)
		assert.ok(result.auditMarkdown.includes(`Internal audit detail ${i}`));
});

test("invalid readerNote is rejected by schema and renderer rather than object-stringified", async () => {
	for (const readerNote of [[], {}, "", "x".repeat(1201)]) {
		const sources = await inputs();
		sources["final-audit"].synthesis.caveatNotes[0].readerNote = readerNote;
		assert.equal(
			validateJsonSchema(liveControl(sources["final-audit"]), schema).valid,
			false,
		);
		const result = await render({ sources });
		assert.equal(result.status, "blocked");
		assert.equal(result.completionSummaryMarkdown, "");
	}
});

test("reader prose cannot bypass the canonical reconciliation gate", async () => {
	const sources = await inputs();
	sources["final-audit"].synthesis.caveatNotes[0].readerNote =
		"Everything is ready.";
	sources["final-audit-packet"].packet.verdictCounts.verified += 1;
	const result = await render({ sources });
	assert.equal(result.status, "failed");
	assert.equal(result.gates.packetReconciliationPassed, false);
	assert.equal(result.completionSummaryMarkdown, "");
});

for (const [status, qualifier] of [
	["partially_supported", "Only partly supported by the available sources"],
	["unsupported", "Insufficient supporting evidence"],
	["conflicting", "Sources disagree"],
	["verification_blocked", "Could not be checked"],
	["unverified", "Not yet checked"],
]) {
	test(`reader wording preserves the ${status} evidence boundary on historical controls`, async () => {
		const result = await render({
			sources: {
				"final-audit": {
					schema: "legacy-audit",
					digest: "Investigate before committing.",
					finalReport: {
						summary: "Investigate before committing.",
						researchMetadata: {},
						coverageSummary: {},
						factSlotCoverage: [],
						mainFindings: [],
						actionPlan: [],
						remainingGaps: [],
						parentDecisionNotes: [],
						unverifiedButRelevant: [],
						recommendations: [
							{
								recommendation: "Check the dependency.",
								evidenceStatus: status,
							},
						],
					},
					claimVerdictIndex: { claims: [{ id: "claim-001", status }] },
				},
			},
		});
		assert.equal(result.status, "passed");
		assert.ok(result.completionSummaryMarkdown.includes(qualifier));
		assert.match(result.completionSummaryMarkdown, /No claims were verified/);
		assert.doesNotMatch(
			result.completionSummaryMarkdown,
			/all requested areas were covered/,
		);
		assert.doesNotMatch(
			result.completionSummaryMarkdown,
			/claim-001|evidence:|Fact slots/,
		);
		assert.match(result.auditMarkdown, /claim-001/);
	});
}

test("a verified subset discloses unclassified evidence in the report, not as generic limits", async () => {
	for (const kind of [
		"unclassified-claim",
		"unknown-slot",
		"unverified-lead",
		"contested",
		"unsupported",
	]) {
		const control = {
			schema: "legacy-audit",
			digest: "Check before committing.",
			finalReport: {
				summary: "Check before committing.",
				researchMetadata: {},
				coverageSummary: {
					preserved: 0,
					omittedPreserved: 0,
					omittedVerificationCandidates: 0,
					coverageGaps: 0,
				},
				factSlotCoverage: [
					{ status: kind === "unknown-slot" ? "unknown" : "filled" },
				],
				mainFindings: [],
				recommendations: [],
				actionPlan: [],
				remainingGaps: [],
				parentDecisionNotes: [],
				unverifiedButRelevant:
					kind === "unverified-lead" ? [{ note: "Demand is unknown." }] : [],
				contestedFindings:
					kind === "contested" ? [{ note: "Sources disagree." }] : [],
				unsupportedFindings:
					kind === "unsupported" ? [{ note: "No support found." }] : [],
			},
			claimVerdictIndex: { claims: [{ id: "claim-001", status: "verified" }] },
		};
		if (kind === "unclassified-claim")
			control.claimVerdictIndex.claims.push({
				id: "claim-002",
				status: "unverified",
			});
		const result = await render({ sources: { "final-audit": control } });
		assert.equal(result.status, "passed");
		assert.doesNotMatch(
			result.completionSummaryMarkdown,
			/Questions remain unanswered/,
			kind,
		);
		const marker = {
			"unclassified-claim": /1 verified, 0 partly supported, 2 total/,
			"unknown-slot": /Unknown/,
			"unverified-lead": /Demand is unknown/,
			contested: /Sources disagree/,
			unsupported: /No support found/,
		}[kind];
		assert.match(result.reportMarkdown, marker, kind);
	}
});

test("both research prompts separate plain reader notes from audit bookkeeping", async () => {
	for (const name of ["spec.json", "tiered-verification.spec.json"]) {
		const spec = JSON.parse(
			await readFile(
				new URL(`../../workflows/deep-research/${name}`, import.meta.url),
				"utf8",
			),
		);
		const prompt = spec.artifactGraph.stages.find(
			(stage) => stage.id === "final-audit",
		).prompt;
		assert.match(prompt, /Separate reader-facing prose from audit bookkeeping/);
		assert.match(prompt, /at most 4 distinct/);
		assert.match(prompt, /plain text, not pre-escaped Markdown/);
		assert.match(prompt, /"readerNote":"The available evidence/);
		assert.equal(
			spec.artifactGraph.stages.find((stage) => stage.id === "final-audit")
				.inputPolicy.requiredReads.length,
			17, // header + 16 synthesis pages (M16)
		);
	}
});

// 2026-11-03 (owner decision): the claim, lead and fact-slot text the reader sees follows the task's
// language through synthesis.translations; titles, labels, statuses, quotes and sources stay as they
// are and the audit keeps the original rows.
function withTranslations(sources, translations) {
	sources["final-audit"].synthesis.translations = translations;
	return sources;
}

test("translations put claim, lead and fact-slot text into the task's language; the rest stays", async () => {
	const sources = withTranslations(await inputs(), {
		claims: [
			{
				id: "claim-001",
				text: "리전-01은 캐시 항목에 21초 신선도 창을 적용한다.",
				explanation: "리전-01 참조 문서가 이 값을 따로 명시한다.",
			},
			{
				id: "lead-001",
				text: "리전-01은 선택형 캐시 무효화를 제공할 수 있다.",
			},
		],
		factSlots: [
			{
				id: "slot-001",
				area: "지역 정책 차원 01",
				whyItMatters: "지역 만료 정책을 일반화하지 않는다.",
			},
		],
	});
	assert.equal(
		validateJsonSchema(liveControl(sources["final-audit"]), schema).valid,
		true,
	);
	const original = (
		await finalPacket({ sources: structuredClone(fixture.sources) })
	).packet;
	const claim = original.claimVerdictLedger.find(
		(row) => row.id === "claim-001",
	);
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	const report = result.reportMarkdown;
	assert.match(
		report,
		/### \*\*확인됨\*\* 리전-01은 캐시 항목에 21초 신선도 창을 적용한다\./,
	);
	assert.match(report, /\n리전-01 참조 문서가 이 값을 따로 명시한다\./);
	assert.match(report, /- 리전-01은 선택형 캐시 무효화를/);
	assert.match(
		report,
		/\| 지역 정책 차원 01 \| [^|]+ \| .+ \| 지역 만료 정책을 일반화하지 않는다\. \|/,
	);
	// Labels and statuses localize; untranslated rows keep their original text.
	assert.match(report, /## 근거가 된 발견[\s\S]*\*\*확인됨\*\*/);
	assert.match(report, /- Region-02 may expose/);
	assert.match(report, /\| Regional policy dimension 02 \|/);
	// The audit keeps the original claim and reports what was applied.
	assert.ok(result.auditMarkdown.includes(claim.claim.slice(0, 40)));
	assert.doesNotMatch(result.auditMarkdown, /리전-01은 캐시/);
	assert.match(
		result.auditMarkdown,
		/- Reader translations: 3 applied, 0 ignored, 23 left untranslated\./,
	);
});

test("a translation with an unknown or repeated id or empty text is ignored, not a failure", async () => {
	const sources = withTranslations(await inputs(), {
		claims: [
			{ id: "claim-001", text: "번역된 주장." },
			{ id: "claim-001", text: "두 번째 번역." },
			{ id: "claim-999", text: "없는 주장." },
			{ id: "lead-002", text: "   " },
		],
		factSlots: [{ id: "slot-999", area: "없는 영역" }],
	});
	assert.equal(
		validateJsonSchema(liveControl(sources["final-audit"]), schema).valid,
		true,
	);
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.match(result.reportMarkdown, /### \*\*확인됨\*\* 번역된 주장\./);
	assert.doesNotMatch(
		result.reportMarkdown,
		/두 번째 번역|없는 주장|없는 영역/,
	);
	assert.match(result.reportMarkdown, /- Region-02 may expose/);
	assert.match(
		result.auditMarkdown,
		/- Reader translations: 1 applied, 4 ignored \(claim-001, claim-999, lead-002, slot-999\), 24 left untranslated\./,
	);
});

// 2026-11-09: recorded final audits translated "RFC 9114 | HTTP/3 | June 2022." without the year and slot labels
// without their RFC number (15 of 141 claim texts, 6 of 24 areas). A translated field that drops a number of its
// source is not used; the original shows and the audit names it.
test("a translation that drops a number of its source is not used; the original shows", async () => {
	for (const [translated, applied] of [
		["RFC 9000은 2021년 5월에 발행되었다.", true],
		["RFC 9000은 발행되었다.", false],
	]) {
		const sources = withTranslations(await inputs(), {
			claims: [{ id: "claim-001", text: translated }],
			factSlots: [{ id: "slot-001", area: "지역 정책 차원 01" }],
		});
		const packet = sources["final-audit-packet"].packet;
		packet.claimVerdictLedger.find((row) => row.id === "claim-001").claim =
			"RFC 9000 was published in May 2021.";
		packet.factSlotCoverage.find((row) => row.slotId === "slot-001").label =
			"Regional policy dimension 01 (RFC 9204)";
		delete packet.synthesisInput;
		packet.synthesisInput = buildSynthesisPages(packet);
		const result = await render({ sources });
		assert.equal(result.status, "passed", JSON.stringify(result.gates));
		if (applied)
			assert.match(
				result.reportMarkdown,
				/### \*\*확인됨\*\* RFC 9000은 2021년 5월에 발행되었다\./,
			);
		else {
			assert.match(
				result.reportMarkdown,
				/### \*\*확인됨\*\* RFC 9000 was published in May 2021\./,
			);
			assert.doesNotMatch(result.reportMarkdown, /RFC 9000은 발행되었다/);
		}
		// the area dropped "9204" in both cases: the label stays
		assert.match(
			result.reportMarkdown,
			/\| Regional policy dimension 01 \(RFC 9204\) \|/,
		);
		assert.match(
			result.auditMarkdown,
			applied
				? /- Reader translations: 1 applied, 1 ignored \(slot-001 area: drops 9204\), 24 left untranslated\./
				: /- Reader translations: 0 applied, 2 ignored \(claim-001: drops 2021, slot-001 area: drops 9204\), 24 left untranslated\./,
		);
	}
});

// 2026-11-10: recorded runs refused 22 such fields in 8 of 12 runs. translation-check lists them, the retranslate stage
// tries each once, and the renderer uses a retranslation only when it keeps every number.
test("refused translations are listed for one retranslation, which the report uses only when faithful", async () => {
	const refusedSources = async () => {
		const sources = withTranslations(await inputs(), {
			claims: [{ id: "claim-001", text: "RFC 9000은 발행되었다." }],
			factSlots: [{ id: "slot-001", area: "지역 정책 차원 01" }],
		});
		const packet = sources["final-audit-packet"].packet;
		packet.claimVerdictLedger.find((row) => row.id === "claim-001").claim =
			"RFC 9000 was published in May 2021.";
		packet.factSlotCoverage.find((row) => row.slotId === "slot-001").label =
			"Regional policy dimension 01 (RFC 9204)";
		delete packet.synthesisInput;
		packet.synthesisInput = buildSynthesisPages(packet);
		return sources;
	};
	const sources = await refusedSources();
	const check = await translationCheck({ sources });
	// 26 items in batches of at most 12.
	assert.deepEqual(
		check.batches.map((batch) => [batch.id, batch.items.length]),
		[
			["refused-translations-1", 12],
			["refused-translations-2", 12],
			["refused-translations-3", 2],
		],
	);
	const batch = {
		items: check.batches.flatMap((entry) => entry.items),
	};
	for (const entry of check.batches)
		assert.equal(
			entry.reportLanguageSample,
			sources["final-audit"].synthesis.bottomLine,
		);
	assert.deepEqual(
		batch.items.filter((item) => item.refusedTranslation !== undefined),
		[
			{
				key: "claim-001|text",
				source: "RFC 9000 was published in May 2021.",
				refusedTranslation: "RFC 9000은 발행되었다.",
				droppedNumbers: ["2021"],
			},
			{
				key: "slot-001|area",
				source: "Regional policy dimension 01 (RFC 9204)",
				refusedTranslation: "지역 정책 차원 01",
				droppedNumbers: ["9204"],
			},
		],
	);
	// The fixture's 24 English leads are shown in a Korean report without a translation: listed to translate.
	const missing = batch.items.filter(
		(item) => item.refusedTranslation === undefined,
	);
	assert.equal(missing.length, 24);
	assert.ok(missing.every((item) => /^lead-\d+\|text$/u.test(item.key)));
	const noTranslations = await refusedSources();
	delete noTranslations["final-audit"].synthesis.translations;
	assert.deepEqual(
		(await translationCheck({ sources: noTranslations })).batches,
		[],
		"without translations nothing is expected",
	);
	const english = await refusedSources();
	english["final-audit"].synthesis.bottomLine = "Documented features hold.";
	assert.deepEqual(
		(await translationCheck({ sources: english })).batches[0].items.map(
			(item) => item.key,
		),
		["claim-001|text", "slot-001|area"],
		"a Latin-script report lists no missing translations",
	);

	// One retranslation keeps its numbers (used), the other still drops one (refused, the original shows).
	const retried = await refusedSources();
	retried["retranslate.refused-translations-1"] = {
		schema: "deep-research-retranslate-v1",
		digest: "d",
		translations: [
			{ key: "claim-001|text", text: "RFC 9000은 2021년 5월에 발행되었다." },
			{ key: "slot-001|area", text: "지역 정책 차원 01" },
			{ key: "lead-001|text", text: "번역된 단서 01." },
		],
	};
	const result = await render({ sources: retried });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.match(
		result.reportMarkdown,
		/### \*\*확인됨\*\* RFC 9000은 2021년 5월에 발행되었다\./,
	);
	assert.match(
		result.reportMarkdown,
		/\| Regional policy dimension 01 \(RFC 9204\) \|/,
	);
	assert.match(
		result.auditMarkdown,
		/- Reader translations: 2 applied \(2 retranslated\), 1 ignored \(slot-001 area: drops 9204\), 23 left untranslated\./,
	);
});

// 2026-11-10 (E8): a sentence that blames a local file for values the file does not contain was flagged in the audit
// only; the reader now sees the engine's note beside the source-verification line.
test("the reader sees an engine note when the report blames a file for values it does not contain", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-attribution-reader-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(
		join(cwd, "--notes.md"),
		"# QUIC notes\n- QUIC에는 버전 1 이후의 새 버전도 있다.\n",
	);
	const blamed = await inputs();
	blamed["final-audit"].synthesis.bottomLine =
		"근거 파일 --notes.md의 QUIC v2 번호를 9369로 수정하고 RFC 9368의 역할을 별도로 명시하세요.";
	const result = await render({ sources: blamed, context: { cwd } });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	const note =
		"엔진 확인: 이 보고서가 `--notes.md`에서 고치라고 한 값(9369, 9368)은 그 파일에 없습니다. 그 값이 이 파일에서 나왔다는 설명은 확인되지 않았습니다.";
	for (const [markdown, expectedNote] of [
		[result.reportMarkdown, note],
		[
			result.completionSummaryMarkdown,
			note.replace("--notes.md", "\\--notes.md"),
		],
	]) {
		const at = markdown.indexOf(expectedNote);
		assert.ok(at > 0, JSON.stringify(result.sourceAttributionWarnings));
		assert.match(markdown.slice(0, at), /## 알아둘 한계\n\n(?:- [^\n]+\n)*- $/);
	}
	const plain = await render({ sources: await inputs(), context: { cwd } });
	assert.doesNotMatch(plain.reportMarkdown, /엔진 확인|Engine check/);
});

test("numbersDroppedBy keeps faithful Korean number forms and catches real drops", () => {
	// Review 2026-11-09 (gpt-6-astra, claude-fable-5-1): the first version refused these faithful forms.
	for (const [source, translated] of [
		["May 12, 2023 release", "2023.5.12. 출시"],
		["about 3,000 cases", "약3000건"],
		["RFC 9000", "RFC9000은"],
		["1.5 million users", "150만 명"],
		["$10,000 per year", "연간 1만 달러"],
		["2,000,000,000 won", "20억 원"],
		["ratio 1.5", "비율 1,5"],
		[
			"RFC 9000, 2021-05, TLS 1.3, 1,000 rows",
			"RFC 9000은 2021년 5월, TLS 1.3, 1000개",
		],
		["rq-007 gapRecorded; QUIC v1, claim-010, 21 seconds", "없음"],
		["Capacity is 1000 rows", "용량은1000개이다"],
		// re-review 2026-11-09 (claude-fable-5-1): a scaled source written as a plain numeral
		["1.5 million users", "1,500,000명의 사용자"],
		["1.5 million users", "1500000명"],
		["May 2023 release", "2023.5. 출시"],
		// 2026-11-09: Korean compound numerals are one value
		["1,500 users", "1천500명"],
		["15,000 users", "1만 5천 명"],
		["320,000,000 won", "3억 2천만 원"],
		["20,000,000 won", "2천만 원"],
		["105,000", "10만 5천"],
		["1,050", "1천50"],
	])
		assert.deepEqual(
			numbersDroppedBy(source, translated),
			[],
			`${source} -> ${translated}`,
		);
	for (const [source, translated, dropped] of [
		["drops to -1000", "감소", ["-1000"]],
		[
			"RFC 9114 | HTTP/3 | June 2022.",
			"RFC 9114는 HTTP/3를 정의한다.",
			["2022"],
		],
		["TLS 1.3 is required", "TLS가 필요하다", ["1.3"]],
		["RFC 9000", "RFC 19000", ["9000"]],
		["1.5 million", "15만", ["1.5"]],
		["May 2023", "2022년 5월", ["2023"]],
		// re-review 2026-11-09 (gpt-6-astra): a changed value that contains the digits
		["1000 users", "0.1000 users", ["1000"]],
		["1000 users", "1000.5 users", ["1000"]],
		["12,345 rows", "12.345개", ["12345"]],
		["1,500 users", "1천 명", ["1500"]],
		["1,500 users", "1천500.5명", ["1500"]],
		// round-4 review: an explicit zero is not an implied one
		["100 million won", "0억 원", ["100"]],
		["10,000 won", "0만원", ["10000"]],
		// round-5 review: a zero coefficient inside a compound section
		["10,000 won", "0천만 원", ["10000"]],
		["100 million won", "0백억 원", ["100"]],
	])
		assert.deepEqual(
			numbersDroppedBy(source, translated),
			dropped,
			`${source} -> ${translated}`,
		);
});

test("a malformed translations container is rejected by schema and renderer", async () => {
	for (const translations of [[], { claims: "x" }, { notes: [] }]) {
		const sources = withTranslations(await inputs(), translations);
		assert.equal(
			validateJsonSchema(liveControl(sources["final-audit"]), schema).valid,
			false,
		);
		const result = await render({ sources });
		assert.equal(result.status, "blocked");
	}
});

test("a coverage gap without its own text names its areas, not its ids", async () => {
	const sources = await inputs((packetSources) => {
		const [named, bare] = packetSources["normalize-claims"].coverageGaps;
		for (const gap of [named, bare]) {
			delete gap.reason;
			delete gap.nextStep;
		}
		bare.relatedFactSlotIds = [];
	});
	const packet = sources["final-audit-packet"].packet;
	const [named, bare] = packet.coverageGaps;
	const slot = packet.factSlotCoverage.find(
		(row) => row.slotId === named.relatedFactSlotIds[0],
	);
	let result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.ok(
		result.reportMarkdown.includes(
			`- ${slot.label}: ${slot.gapReason.replace(/[.]$/, "")}`,
		),
		"named gap",
	);
	assert.ok(result.reportMarkdown.includes(`- ${bare.scopeItem}`));
	assert.doesNotMatch(result.reportMarkdown, /related slots: slot-/);
	// With a translated slot the gap reads in the task's language.
	withTranslations(sources, {
		factSlots: [
			{ id: slot.slotId, area: "이전 범위 영역", gap: "확인이 더 필요하다." },
		],
	});
	result = await render({ sources });
	assert.ok(
		result.reportMarkdown.includes(`- 이전 범위 영역: 확인이 더 필요하다`),
	);
});

test("evidence-strength sources are links, not escaped Markdown", async () => {
	const result = await render({ sources: await inputs() });
	assert.equal(result.status, "passed");
	const row = result.reportMarkdown
		.split("\n")
		.find((line) => line.startsWith("| Regional policy dimension 01 |"));
	assert.match(
		row,
		/\[service-01\.example\.invalid\]\(<https:\/\/service-01\.example\.invalid\/[^>]+>\)/,
	);
	assert.doesNotMatch(row, /\\\[|\\</);
});

test("both research prompts ask for faithful translations of the shown audit text", async () => {
	for (const name of ["spec.json", "tiered-verification.spec.json"]) {
		const spec = JSON.parse(
			await readFile(
				new URL(`../../workflows/deep-research/${name}`, import.meta.url),
				"utf8",
			),
		);
		const prompt = spec.artifactGraph.stages.find(
			(stage) => stage.id === "final-audit",
		).prompt;
		assert.match(prompt, /Optional synthesis\.translations/);
		assert.match(prompt, /do not strengthen, merge or re-judge claims/);
		assert.match(prompt, /Do not translate quotes, source titles, URLs or ids/);
		assert.match(prompt, /"translations":\{"claims":\[\{"id":"claim-001"/);
	}
});

test("the sanitizer summary preserves each gap but removes redundant pipeline notes", async () => {
	// 2026-11-03 (owner: the report listed "sanitized from verifier candidates:
	// source_hint_claim_mismatch" once per claim, and "sanitized verifier candidates: claim-004"
	// inside gap text).
	const sources = await inputs();
	const packet = sources["final-audit-packet"].packet;
	packet.remainingGaps = [
		...Array.from({ length: 5 }, (_, i) => ({
			claimId: `claim-10${i}`,
			evidenceState: "not_sent_to_verifier",
			reason: "sanitized from verifier candidates: source_hint_claim_mismatch",
			sourceUrls: [`https://example.com/a${i % 2}`],
		})),
		{
			gapId: "gap-slot",
			gap: "Memory limits: decay rates were not found.; sanitized verifier candidates: claim-008, claim-009",
		},
	];
	const result = await render({ sources });
	const section = result.reportMarkdown.slice(
		result.reportMarkdown.indexOf("<summary>검증 공백과 미확인 단서"),
	);
	assert.doesNotMatch(section, /sanitized|source\\_hint|claim-00[89]/);
	assert.match(section, /검증 전 보류: 5개/);
	assert.match(section, /Memory limits: decay rates were not found\./);
	assert.equal((section.match(/검증 전 보류/g) ?? []).length, 1);
});

// 2026-11-10 (owner, after the P3 hard-claim round): verifiers rate a false claim partially_supported or unsupported
// and give the right value in correctionOrCounterclaim. The audit ledger shows that correction — also when the
// verifier left an empty caveat, which used to hide it behind `??` — and a verified row keeps its caveat alone.
test("the audit ledger shows a verifier's correction for claims it did not verify", async () => {
	const sources = await inputs((packetSources) => {
		const digests = packetSources["audit-claims"].claimDigests;
		const edit = (id, status, caveat, correction) => {
			const row = digests.find((claim) => claim.id === id);
			row.status = status;
			row.verdictDigest = { ...row.verdictDigest, caveat };
			row.correctionOrCounterclaim = correction;
		};
		edit(
			"claim-002",
			"partially_supported",
			"",
			"Region-02 caches for 23 seconds, not 22.",
		);
		edit(
			"claim-003",
			"unsupported",
			"Only the regional page was found.",
			"Region-03 caches for 30 seconds.",
		);
		edit(
			"claim-004",
			"verified",
			"Wording differs slightly.",
			"Not shown for a verified row with a caveat.",
		);
		edit("claim-005", "verified", "", "Shown when there is no caveat.");
		edit(
			"claim-006",
			"partially_supported",
			"Region-06 caches for 26 seconds per the page.",
			"Region-06 caches for 26 seconds per the page.",
		);
	});
	const result = await render({ sources });
	const row = (id) =>
		result.auditMarkdown
			.split("\n")
			.find((line) => line.startsWith(`| ${id} |`));
	assert.match(
		row("claim-002"),
		/\| Region-02 caches for 23 seconds, not 22\. \|$/,
	);
	assert.match(
		row("claim-003"),
		/\| Only the regional page was found\. Correction: Region-03 caches for 30 seconds\. \|$/,
	);
	assert.match(row("claim-004"), /\| Wording differs slightly\. \|$/);
	assert.match(row("claim-005"), /\| Shown when there is no caveat\. \|$/);
	// A correction the caveat already states is not repeated.
	assert.match(
		row("claim-006"),
		/\| Region-06 caches for 26 seconds per the page\. \|$/,
	);
});

// 2026-11-10 (owner decision pending, INBOX): Unsupported and Contested caveat lines carry the value the verifier
// found ("Correction: …", "정정: …" in Korean reports); lines without a correction, or already containing it, stay.
const CAMEL = { unsupported: "unsupported", conflicting: "conflicting" };
async function withRejectedClaims(changes, claimText = {}) {
	return inputs((packetSources) => {
		const audit = packetSources["audit-claims"];
		for (const row of audit.claimDigests) {
			const change = changes[row.id];
			if (!change) continue;
			[row.status, row.correctionOrCounterclaim] = change;
			if (claimText[row.id]) row.claim = claimText[row.id];
		}
		const partitions = audit.statusPartitions;
		for (const key of Object.keys(partitions))
			partitions[key] = partitions[key].filter((id) => !changes[id]);
		for (const [id, [status]] of Object.entries(changes))
			partitions[CAMEL[status]].push(id);
		for (const key of Object.keys(partitions))
			audit.verdictCounts[key] = partitions[key].length;
	});
}
const caveatLine = (result, kind, needle) => {
	const label = result.reportMarkdown.startsWith("# 조사")
		? { Unsupported: "근거 부족", Contested: "출처 상충" }[kind]
		: kind;
	const body = result.reportMarkdown
		.split(`<summary>${label} (`)[1]
		?.split("</details>")[0];
	const line = body
		?.split("\n")
		.find((row) => row.startsWith("- ") && row.includes(needle));
	assert.ok(line, `no ${kind} line with ${needle}`);
	return line;
};

test("unsupported and contested caveat lines show the verifier's correction", async () => {
	const sources = await withRejectedClaims(
		{
			"claim-002": [
				"unsupported",
				"RFC 9204 was published in June 2022, not June 2021.",
			],
			"claim-003": ["conflicting", "Region-03 caches for 30 seconds."],
			"claim-004": ["unsupported", ""],
			"claim-005": ["unsupported", "- caches for 25 seconds."],
		},
		{ "claim-005": "Region-05 policy - caches for 25 seconds." },
	);
	sources["final-audit"].synthesis.bottomLine =
		"The documented behavior is confirmed; demand is not.";
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	// After the claim, before its sources.
	assert.match(
		caveatLine(result, "Unsupported", "Region-02"),
		/ Correction: RFC 9204 was published in June 2022, not June 2021\.( \(|$)/,
	);
	assert.match(
		caveatLine(result, "Contested", "Region-03"),
		/ Correction: Region-03 caches for 30 seconds\./,
	);
	assert.doesNotMatch(
		caveatLine(result, "Unsupported", "Region-04"),
		/Correction:/,
	);
	// Already in the claim (even where Markdown escaping of "- " would differ): not repeated.
	assert.doesNotMatch(
		caveatLine(result, "Unsupported", "Region-05"),
		/Correction:/,
	);
	// A Korean report labels it 정정 — also when the rejected claim itself is English.
	for (const claimText of ["RFC 9204는 2021년 6월에 발행되었다.", undefined]) {
		const korean = await withRejectedClaims(
			{
				"claim-002": [
					"unsupported",
					"RFC 9204 was published in June 2022, not June 2021.",
				],
			},
			claimText ? { "claim-002": claimText } : {},
		);
		korean["final-audit"].synthesis.bottomLine = "핵심 결론입니다.";
		const rendered = await render({ sources: korean });
		assert.match(
			caveatLine(
				rendered,
				"Unsupported",
				claimText ? "RFC 9204는" : "Region-02",
			),
			/ 정정: RFC 9204 was published in June 2022, not June 2021\./,
		);
	}
});

// Review 2026-11-10 (gpt-6.1-sol): a legacy final audit names the rejected claim without the correction that its
// claim index holds; the line joins it by id.
test("a legacy report row gets the correction from the claim index", async () => {
	const result = await render({
		sources: {
			"final-audit": {
				schema: "legacy-audit",
				digest: "English report.",
				finalReport: {
					summary: "English report.",
					researchMetadata: {},
					coverageSummary: {},
					factSlotCoverage: [],
					mainFindings: [],
					recommendations: [],
					actionPlan: [],
					remainingGaps: [],
					parentDecisionNotes: [],
					unverifiedButRelevant: [],
					notableUnsupportedClaims: [
						{
							claimId: "c1",
							claim: "Old value.",
							sourceUrls: ["https://example.com"],
						},
					],
				},
				claimVerdictIndex: {
					claims: [
						{
							id: "c1",
							status: "unsupported",
							claim: "Old value.",
							correctionOrCounterclaim: "New value.",
						},
					],
				},
			},
		},
	});
	assert.match(
		caveatLine(result, "Unsupported", "Old value."),
		/ Correction: New value\./,
	);
});

for (const ko of [false, true]) {
	test(`conclusion-first ${ko ? "Korean" : "English"} report conserves every displayed row and source`, async () => {
		const sources = await inputs();
		const overlay = sources["final-audit"].synthesis;
		const conclusion = ko
			? ["첫 번째 결론입니다.", "두 번째 결론입니다."]
			: ["The first conclusion.", "The second conclusion."];
		overlay.keyFindingIds = ["claim-001", "claim-002"];
		overlay.recommendations = [
			{
				recommendation: "Matched recommendation one",
				supportingClaimIds: ["claim-002"],
			},
			{
				recommendation: "Standalone recommendation two",
				supportingClaimIds: [],
			},
		];
		overlay.actionPlan = [
			{
				action: "First plan step",
				recommendationNumbers: [1],
				supportingClaimIds: ["claim-001"],
			},
			{
				action: "Second plan step",
				recommendationNumbers: [],
				supportingClaimIds: [],
			},
		];
		overlay.caveatNotes = [
			{ note: "Unique audit caveat", readerNote: "Unique practical limit" },
		];
		for (const structured of [true, false]) {
			if (structured) {
				delete overlay.bottomLine;
				overlay.conclusion = conclusion;
				overlay.keyPoints = [
					{ title: "Short title", text: "A separate point" },
				];
				overlay.openQuestion = ko
					? "남은 문제가 무엇인가요?"
					: "What remains unresolved?";
			} else {
				delete overlay.conclusion;
				delete overlay.keyPoints;
				delete overlay.openQuestion;
				overlay.bottomLine = conclusion.join(" ");
				delete overlay.actionPlan[0].recommendationNumbers;
				delete overlay.actionPlan[1].recommendationNumbers;
			}
			assert.equal(
				validateJsonSchema(sources["final-audit"], schema).valid,
				structured,
			);
			const result = await render({ sources });
			assert.equal(result.status, "passed");
			const md = result.reportMarkdown;
			assert.ok(md.includes(conclusion.join("\n\n")));
			assert.match(
				md,
				ko ? /^# 조사 보고서\n\n주장 / : /^# Research report\n\nClaims: /,
			);
			assert.match(
				md,
				ko ? /<summary>근거 보기<\/summary>/ : /<summary>Evidence<\/summary>/,
			);
			if (structured) {
				assert.ok(md.includes("**Short title** — A separate point"));
				assert.ok(md.split("\n")[2].includes(overlay.openQuestion));
				assert.match(
					md,
					/1\. \*\*[^*]+\*\* First plan step\n +<details>[\s\S]+?Matched recommendation one[\s\S]+?<\/details>\n2\./,
				);
			}
			const expected = [
				...overlay.recommendations.map((row) => row.recommendation),
				...overlay.actionPlan.map((row) => row.action),
				overlay.caveatNotes[0].note,
				overlay.caveatNotes[0].readerNote,
			];
			for (const row of sources[
				"final-audit-packet"
			].packet.claimVerdictLedger.filter((row) =>
				overlay.keyFindingIds.includes(row.id),
			))
				expected.push(row.claim);
			for (const item of expected) assert.ok(md.includes(item), item);
			for (const url of result.sourceUrls) assert.ok(md.includes(url), url);
			assert.equal(md.match(/Matched recommendation one/g)?.length, 1);
			assert.equal(md.match(/Standalone recommendation two/g)?.length, 1);
		}
	});
}

function legacyReport(fields) {
	return {
		"final-audit": {
			schema: "legacy-audit",
			digest: "Read the evidence.",
			claimVerdictIndex: { claims: [] },
			finalReport: {
				summary: "Read the evidence.",
				researchMetadata: {},
				coverageSummary: {},
				factSlotCoverage: [],
				mainFindings: [],
				recommendations: [],
				actionPlan: [],
				remainingGaps: [],
				parentDecisionNotes: [],
				unverifiedButRelevant: [],
				...fields,
			},
		},
	};
}

test("written report keeps untrusted markup and invalid destinations literal", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-reader-literal-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const sources = legacyReport({
		coverageSummary: { researchQuestions: "unchecked\n<untrusted-count>" },
		actionPlan: [{ step: "<untrusted-step> [step](target)" }],
		mainFindings: [
			{
				finding: "Quoted evidence",
				evidence: [
					{
						quote: "one  two\n  <untrusted-quote> *emphasis* [quote](target)",
					},
				],
				sourceUrls: [
					"https://[broken\n<untrusted-url>",
					"data:rejected",
					"https://example.org/path",
				],
			},
		],
	});
	const result = await render({
		sources,
		context: { cwd, runId: "run", taskId: "task" },
	});
	assert.equal(result.status, "passed");
	const md = await readFile(
		join(
			cwd,
			".agent-workflow",
			"workflows",
			"run",
			"tasks",
			"task",
			result.sidecarPath,
		),
		"utf8",
	);
	assert.doesNotMatch(
		md,
		/<untrusted-|\[(?:step|quote)\]\(target\)|(?<!\\)\*emphasis\*|unchecked/,
	);
	assert.match(md, /one  two\\+n  &lt;untrusted-quote&gt;/);
	assert.match(md, /&lt;untrusted-step&gt;/);
	assert.match(md, /&lt;untrusted-url&gt;/);
	assert.match(md, /data:rejected/);
	assert.deepEqual(
		[...md.matchAll(/(?<!\\)\]\(<([^>]+)>\)/g)].map((m) => m[1]),
		["https://example.org/path", "https://example.org/path"],
	);
});

// Check raw GFM delimiter triggers even without the optional Marked test parser,
// then decode one Markdown layer.
const decodeEntities = (text) =>
	text.replace(
		/&(amp|lt|gt|#\d+);/g,
		(_, name) =>
			({ amp: "&", lt: "<", gt: ">" })[name] ??
			String.fromCodePoint(Number(name.slice(1))),
	);
const decodeLiteral = (text) =>
	decodeEntities(text.replace(/\\([!-/:-@[-`{-~])/g, "$1"));

test("GFM keeps rejected URLs and emails literal without changing quote text", async (t) => {
	const quote =
		"Write editor+docs@example.org or visit WWW.Example.org and HTTPS://Example.org.";
	const rejected = [
		"<mailto:editor@example.org>",
		"editor+docs@example.org",
		"www.Example.org",
		"https://[broken",
		"ftp://example.org/manual",
		"<ssh://example.org/repo>",
		"x+custom://example.org/manual",
	];
	const result = await render({
		sources: legacyReport({
			mainFindings: [
				{
					finding: "Literal references",
					evidence: [{ quote }],
					sourceUrls: rejected,
				},
			],
		}),
	});
	assert.equal(result.status, "passed");
	const lines = result.reportMarkdown.split("\n");
	const quoteLine = lines.find((line) => line.includes("Write editor"));
	const refsLine = lines.find((line) => line.includes("mailto"));
	await t.test(
		"Marked does not emit anchors for rejected references",
		async (t) => {
			let parser;
			try {
				parser = import.meta.resolve("marked");
			} catch (err) {
				if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
				return t.skip("Marked is not installed");
			}
			const { marked } = await import(parser);
			const html = marked.parseInline(refsLine, { gfm: true });
			assert.doesNotMatch(html, /<a\b/i);
			for (const ref of rejected)
				assert.ok(decodeEntities(html).includes(ref), ref);
		},
	);
	for (const line of [quoteLine, refsLine]) {
		assert.doesNotMatch(line, /:\/\/|www\.|@|<[^>]+>|(?<!\\)\]\(/i);
	}
	assert.ok(decodeLiteral(quoteLine).includes(JSON.stringify(quote)));
	for (const ref of rejected)
		assert.ok(decodeLiteral(refsLine).includes(ref), ref);
});

test("published Markdown destinations preserve the original HTTP URL bytes", async () => {
	const url = "HTTPS://Example.org:443/v1/../file(a)|b?sig=(XYZ)&a=&amp;#line.";
	const result = await render({
		sources: legacyReport({
			mainFindings: [{ finding: "Signed URL", sourceUrls: [url] }],
		}),
	});
	assert.equal(result.status, "passed");
	// The source index lists pages (no fragment); a link in the report body keeps its exact destination.
	const page = url.split("#")[0];
	assert.deepEqual(result.sourceUrls, [page]);
	assert.deepEqual(
		[...result.reportMarkdown.matchAll(/(?<!\\)\]\(<([^>]+)>\)/g)].map((m) =>
			decodeLiteral(m[1]),
		),
		[url, page],
	);
});

test("legacy action matching keeps hosts with $ distinct", async () => {
	const stepUrl = "https://a$$.example/docs";
	const otherUrl = "https://a$.example/docs";
	const result = await render({
		sources: legacyReport({
			actionPlan: [{ action: "Read the docs", sourceUrls: [stepUrl] }],
			recommendations: [
				{ recommendation: "Review the other host", sourceUrls: [otherUrl] },
			],
		}),
	});
	assert.equal(result.status, "passed");
	const actions = result.reportMarkdown
		.split("## To do\n")[1]
		.split("\n## ")[0];
	assert.deepEqual(
		[...actions.matchAll(/^\d+\. \*\*.*?\*\* (.+)$/gm)].map((m) => m[1]),
		["Read the docs", "Review the other host"],
	);
});
test("legacy actions match canonical URLs without rewriting their citations", async () => {
	const stepUrl = "HTTPS://EXAMPLE.org:443/docs?sig=ABC#part.";
	const relatedUrl = "https://example.org/docs?sig=ABC#part.";
	const otherUrl = "https://example.org/docs?sig=DEF#part.";
	const result = await render({
		sources: legacyReport({
			actionPlan: [{ action: "Read the docs", sourceUrls: [stepUrl] }],
			recommendations: [
				{ recommendation: "Review the same page", sourceUrls: [relatedUrl] },
				{ recommendation: "Review another page", sourceUrls: [otherUrl] },
			],
		}),
	});
	assert.equal(result.status, "passed");
	const actions = result.reportMarkdown
		.split("## To do\n")[1]
		.split("\n## ")[0];
	assert.deepEqual(
		[...actions.matchAll(/^\d+\. \*\*.*?\*\* (.+)$/gm)].map((m) => m[1]),
		["Read the docs", "Review another page"],
	);
	assert.match(actions, /^ +\- \*\*.*?\*\* Review the same page/m);
	assert.deepEqual(
		[...actions.matchAll(/\]\(<([^>]+)>\)/g)].map((m) => m[1]),
		[stepUrl, relatedUrl, otherUrl],
	);
});

test("live validation retries blank reader entries and the stored reader blocks them", async () => {
	const sources = await inputs();
	const control = liveControl(sources["final-audit"]);
	sources["final-audit"] = control;
	assert.equal(validateJsonSchemaSubset(schema).valid, true);
	for (const [fields, path] of [
		[{ conclusion: [" ", "\t\u00a0"] }, "$.synthesis.conclusion[0]"],
		[{ conclusion: ["Ask Dr. Lee.", "\u3000"] }, "$.synthesis.conclusion[1]"],
		[
			{ keyPoints: [{ title: " ", text: "Nonblank" }] },
			"$.synthesis.keyPoints[0].title",
		],
		[
			{ keyPoints: [{ title: "Nonblank", text: " \n " }] },
			"$.synthesis.keyPoints[0].text",
		],
	]) {
		const candidate = {
			...control,
			synthesis: { ...control.synthesis, ...fields },
		};
		const options = { controlJsonSchema: schema };
		const parsed = parseWorkflowOutputForBundle(
			`<control>${JSON.stringify(candidate)}</control>\n<analysis>Analysis</analysis>\n<refs>[]</refs>`,
			options,
		);
		const stored = await render({
			sources: { ...sources, "final-audit": candidate },
		});
		assert.deepEqual([parsed.valid, stored.status], [false, "blocked"], path);
		assert.ok(
			buildWorkflowOutputRetryInstructions(parsed.issues, options).includes(
				`${path}: control JSON schema failed: string must not be blank`,
			),
		);
	}
});

test("live synthesis requires the pair; stored paragraphs and bounded abbreviated entries still render", async () => {
	const sources = await inputs();
	const control = sources["final-audit"];
	const legacy = control.synthesis;
	const { bottomLine, ...rest } = legacy;
	const conclusion = ["Ask Dr. Lee before publishing.", "Then check the data."];
	const keyPoints = [{ title: "Review", text: "Only after checking." }];
	for (const [fields, live, stored] of [
		[{ bottomLine }, false, true],
		[{}, false, false],
		[{ conclusion }, false, false],
		[{ keyPoints }, false, false],
		[{ bottomLine, conclusion }, false, false],
		[{ bottomLine, keyPoints }, false, false],
		[{ bottomLine, conclusion, keyPoints }, false, false],
		[{ conclusion, keyPoints }, true, true],
	]) {
		control.synthesis = { ...rest, ...fields };
		assert.equal(
			validateJsonSchema(control, schema).valid,
			live,
			JSON.stringify(fields),
		);
		const result = await render({ sources });
		assert.equal(
			result.status,
			stored ? "passed" : "blocked",
			JSON.stringify(fields),
		);
		if (live)
			assert.ok(result.reportMarkdown.includes(conclusion.join("\n\n")));
	}
});

test("legacy caveat aliases retain grouped notes, corrections and sources", async () => {
	const sources = legacyReport({
		contestedAreas: {
			topic: {
				note: "A grouped contested note.",
				correctionOrCounterclaim: "The actual correction.",
				sourceUrls: ["https://example.org/only-source"],
			},
		},
		contestedFindings: "A second contested note.",
		notableUnsupportedClaims: "A first unsupported note.",
		unsupportedFindings: { topic: { note: "A second unsupported note." } },
	});
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	for (const text of [
		"A grouped contested note.",
		"The actual correction.",
		"https://example.org/only-source",
		"A second contested note.",
		"A first unsupported note.",
		"A second unsupported note.",
	])
		assert.ok(result.reportMarkdown.includes(text), text);
});

test("coverage status is localized and unfamiliar status and confidence stay literal", async () => {
	const sources = legacyReport({
		researchScopeCoverage: [{ status: "covered_with_conflicts" }],
		mainFindings: [
			{
				finding: "One finding",
				evidenceStatus: "custom <status>",
				confidence: "Custom <confidence>",
			},
		],
	});
	const result = await render({ sources });
	assert.match(result.reportMarkdown, /Covered with conflicts 1/);
	assert.match(result.reportMarkdown, /custom &lt;status&gt;/);
	assert.match(result.reportMarkdown, /Confidence: Custom &lt;confidence&gt;/);
});

test("trust line counts canonical local files and web hosts but not citation labels", async () => {
	const sources = legacyReport({
		mainFindings: [
			{
				finding: "One finding",
				sourceRefs: [
					"RFC 9204, Section 3.1",
					"file:src/main.ts#L4-L8",
					"repo:src/main.ts#L20-22",
					"file:docs/배포 Notes.md#L2",
				],
				sourceUrls: [
					"https://example.org/path",
					"https://www.example.org/next",
				],
				evidence: [
					{ file: "example.org", quote: "One local quote" },
					{ file: "./src/main.ts", quote: "Another local quote" },
					{
						file: "docs/배포 Notes.md",
						lineStart: 2,
						lineEnd: 3,
						quote: "A release note",
					},
				],
			},
		],
	});
	const result = await render({ sources });
	assert.match(result.reportMarkdown.split("\n")[2], /Sources: 4/);
	assert.deepEqual(
		[...result.reportMarkdown.matchAll(/^- Local source: (.+)$/gm)]
			.map((m) => m[1].replaceAll("`", ""))
			.sort(),
		["docs/배포 Notes.md", "example.org", "src/main.ts"],
	);
	for (const citation of [
		"`src/main.ts#L4-L8`",
		"`src/main.ts#L20-22`",
		"`docs/배포 Notes.md#L2`",
		"RFC 9204, Section 3.1",
	])
		assert.ok(result.reportMarkdown.includes(citation), citation);
	assert.doesNotMatch(result.reportMarkdown, /Local source: .*RFC/);
});

test("contradicted file attribution appears in visible limits and the audit", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-reader-attribution-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(
		join(cwd, "notes.md"),
		"The notes contain no protocol numbers.\n",
	);
	const sources = legacyReport({
		actionPlan: [{ action: "Fix the incorrect RFC 9204 in notes.md." }],
	});
	const result = await render({ sources, context: { cwd } });
	assert.match(
		result.reportMarkdown,
		/## Limits to keep in mind\n\n- Engine check:[^\n]+notes\.md[^\n]+9204/,
	);
	assert.match(
		result.completionSummaryMarkdown,
		/## Limits to keep in mind[\s\S]*?- Engine check:/,
	);
	assert.match(result.auditMarkdown, /values not in the file: 9204/);
});

test("a word cap cannot publish disputed advice without its visible correction", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-reader-capped-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(
		join(cwd, "notes.md"),
		"There are no protocol numbers here.\n",
	);
	const action = "Fix the incorrect RFC 9204 in notes.md.";
	const sources = legacyReport({ actionPlan: [{ action }] });
	const context = { cwd, runId: "run", taskId: "task" };
	const full = await render({ sources, context });
	assert.equal(full.status, "passed");
	const maxWords = full.reportMarkdown
		.split("## Limits to keep in mind")[0]
		.match(/\S+/g).length;
	const capped = await render({ sources, context, options: { maxWords } });
	assert.equal(capped.status, "failed");
	assert.equal(capped.completionSummaryMarkdown, "");
	assert.doesNotMatch(capped.reportMarkdown, /Fix the incorrect RFC/);
	assert.equal(capped.gates.truncatedWithAttributionWarnings, true);
	assert.ok(capped.wordCount <= maxWords);
	assert.equal(
		await readFile(
			join(
				cwd,
				".agent-workflow",
				"workflows",
				"run",
				"tasks",
				"task",
				capped.sidecarPath,
			),
			"utf8",
		),
		`${capped.reportMarkdown}\n`,
	);
	assert.match(capped.auditMarkdown, /values not in the file: 9204/);
});

test("the engine stores the cap diagnostic instead of the disputed conclusion", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-reader-capped-engine-"));
	t.after(async () => {
		await h.flushPendingIndexUpdatesForTests();
		await rm(cwd, { recursive: true, force: true });
	});
	await writeFile(join(cwd, "notes.md"), "No protocol numbers here.\n");
	const action = "Fix the incorrect RFC 9204 in notes.md.";
	const sources = legacyReport({ summary: action, actionPlan: [{ action }] });
	const specPath = join(cwd, "spec.json");
	const spec = h.artifactGraphWorkflowSpec({
		artifactGraph: {
			stages: [
				{
					id: "render",
					support: { uses: "./render.mjs", options: { maxWords: 1 } },
				},
			],
		},
	});
	h.writeAgent(cwd, "unit-scout");
	await writeFile(specPath, JSON.stringify(spec));
	const renderer = new URL(
		"../../workflows/deep-research/helpers/render-executive.mjs",
		import.meta.url,
	);
	await writeFile(
		join(cwd, "render.mjs"),
		`import render from ${JSON.stringify(renderer.href)};\nexport default (args) => render({ ...args, sources: ${JSON.stringify(sources)} });`,
	);
	const compiled = await h.compileWorkflow(spec, {
		cwd,
		specPath,
		task: "Render",
	});
	const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath);
	await h.writeStaticRunArtifacts(cwd, run, compiled, spec);
	const [task] = run.tasks;
	assert.equal(
		await executeSupportTask(
			cwd,
			run,
			task,
			compiled.tasks[0],
			createArtifactGraphRuntimeValidationSnapshot(run),
		),
		false,
	);
	const {
		tasks: [stored],
	} = await h.readRunRecord(cwd, run.runId);
	assert.equal(stored.statusDetail, "support_declared_failed");
	const dir = dirname(fromStatePath(cwd, task.files.result));
	const control = JSON.parse(await readFile(join(dir, "control.json"), "utf8"));
	assert.equal(control.gates.truncatedWithAttributionWarnings, true);
	const diagnostic =
		"The report with source attribution corrections exceeds the word cap. See the audit.";
	assert.equal(stored.lastMessage, `support declared failed: ${diagnostic}`);
	assert.equal(control.digest, diagnostic);
});
