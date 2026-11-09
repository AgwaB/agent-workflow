import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../dist/core/json-schema.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render, {
	numbersDroppedBy,
} from "../../workflows/deep-research/helpers/render-executive.mjs";
import { buildSynthesisPages } from "../../workflows/deep-research/helpers/synthesis-pages.mjs";
import translationCheck from "../../workflows/deep-research/helpers/translation-check.mjs";

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
	assert.match(result.completionSummaryMarkdown, /추가로 확인할 질문이 남아/);
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

test("reader limitations are distinct and bounded while all audit notes remain", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	synthesis.caveatNotes = Array.from({ length: 10 }, (_, i) => ({
		note: `Internal audit detail ${i}: claim-001`,
		readerNote: `Practical limitation ${Math.floor(i / 2)} changes the decision.`,
		relatedClaimIds: ["claim-001"],
	}));
	assert.equal(validateJsonSchema(sources["final-audit"], schema).valid, true);
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
			validateJsonSchema(sources["final-audit"], schema).valid,
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
		assert.match(
			result.completionSummaryMarkdown,
			/not enough verified evidence/,
		);
		assert.match(
			result.completionSummaryMarkdown,
			/does not establish that all requested areas were covered/,
		);
		assert.doesNotMatch(
			result.completionSummaryMarkdown,
			/claim-001|evidence:|Fact slots/,
		);
		if (status === "conflicting")
			assert.match(result.completionSummaryMarkdown, /Some sources disagree/);
		assert.match(result.auditMarkdown, /claim-001/);
	});
}

test("a verified subset does not hide unclassified legacy evidence or coverage", async () => {
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
		assert.match(
			result.completionSummaryMarkdown,
			/Some evidence could not be fully checked|Questions remain unanswered|Some sources disagree/,
			kind,
		);
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
	assert.equal(validateJsonSchema(sources["final-audit"], schema).valid, true);
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
		/### 1\. 리전-01은 캐시 항목에 21초 신선도 창을 적용한다\./,
	);
	assert.match(report, /\n리전-01 참조 문서가 이 값을 따로 명시한다\./);
	assert.match(
		report,
		/\*\*Unverified lead:\*\* 리전-01은 선택형 캐시 무효화를/,
	);
	assert.match(
		report,
		/\| 지역 정책 차원 01 \| [^|]+ \| .+ \| 지역 만료 정책을 일반화하지 않는다\. \|/,
	);
	// Labels and statuses stay; untranslated rows keep their original text.
	assert.match(
		report,
		/## Main findings[\s\S]*Evidence status: \*\*verified\*\*/,
	);
	assert.match(report, /\*\*Unverified lead:\*\* Region-02 may expose/);
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
	assert.equal(validateJsonSchema(sources["final-audit"], schema).valid, true);
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.match(result.reportMarkdown, /### 1\. 번역된 주장\./);
	assert.doesNotMatch(
		result.reportMarkdown,
		/두 번째 번역|없는 주장|없는 영역/,
	);
	assert.match(
		result.reportMarkdown,
		/\*\*Unverified lead:\*\* Region-02 may expose/,
	);
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
				/### 1\. RFC 9000은 2021년 5월에 발행되었다\./,
			);
		else {
			assert.match(
				result.reportMarkdown,
				/### 1\. RFC 9000 was published in May 2021\./,
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
	assert.equal(check.batches.length, 1);
	const [batch] = check.batches;
	assert.equal(batch.id, "refused-translations");
	assert.equal(
		batch.reportLanguageSample,
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
	retried["retranslate.refused-translations"] = {
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
		/### 1\. RFC 9000은 2021년 5월에 발행되었다\./,
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
		join(cwd, "notes.md"),
		"# QUIC notes\n- QUIC에는 버전 1 이후의 새 버전도 있다.\n",
	);
	const blamed = await inputs();
	blamed["final-audit"].synthesis.bottomLine =
		"notes.md의 QUIC v2 번호를 9369로 수정하고 RFC 9368의 역할을 별도로 명시하세요.";
	const result = await render({ sources: blamed, context: { cwd } });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	const note =
		"엔진 확인: 이 보고서가 `notes.md`에서 고치라고 한 값(9369, 9368)은 그 파일에 없습니다. 그 값이 이 파일에서 나왔다는 설명은 확인되지 않았습니다.";
	for (const markdown of [
		result.reportMarkdown,
		result.completionSummaryMarkdown,
	]) {
		const at = markdown.indexOf(note);
		assert.ok(at > 0, markdown.slice(-600));
		assert.match(markdown.slice(0, at), /Source verification: [^\n]+\n\n$/);
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
			validateJsonSchema(sources["final-audit"], schema).valid,
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
			`**Gap:** ${slot.label}: ${slot.gapReason.replace(/[.]$/, "")}`,
		),
		"named gap",
	);
	assert.ok(result.reportMarkdown.includes(`**Gap:** ${bare.scopeItem}`));
	assert.doesNotMatch(result.reportMarkdown, /related slots: slot-/);
	// With a translated slot the gap reads in the task's language.
	withTranslations(sources, {
		factSlots: [
			{ id: slot.slotId, area: "이전 범위 영역", gap: "확인이 더 필요하다." },
		],
	});
	result = await render({ sources });
	assert.ok(
		result.reportMarkdown.includes(
			`**Gap:** 이전 범위 영역: 확인이 더 필요하다`,
		),
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

test("claims the sanitizer held back read as one reader line, and pipeline notes leave gap text", async () => {
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
		result.reportMarkdown.indexOf("## Caveats and remaining gaps"),
	);
	assert.doesNotMatch(section, /sanitized|source\\_hint|claim-00[89]/);
	assert.match(
		section,
		/- \*\*Held back before verification:\*\* 5 candidate claims did not reach the verifiers — the claim's wording did not match the quoted source passage\. The evidence audit has the details\. \(\[example\.com\]\(<https:\/\/example\.com\/a0>\), \[example\.com\]\(<https:\/\/example\.com\/a1>\)\)/,
	);
	assert.match(section, /Memory limits: decay rates were not found\./);
	assert.equal(
		(section.match(/Held back before verification/g) ?? []).length,
		1,
	);
});
