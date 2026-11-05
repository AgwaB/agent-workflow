import assert from "node:assert/strict";
import { test } from "node:test";

test("deep-research sanitizer rewrites configured unquoted obligations without synthesizing source URLs", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs?test=${Date.now()}`
	);
	const claudeRef = "wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const owaspRef = "wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const dockerRef = "wsrc_cccccccccccccccccccccccccccccccc";
	const result = await helper({
		sources: {
			"normalize-input-packet.main": {
				packet: {
					research: {
						extractedFacts: [
							{
								slotId: "slot-ci",
								quote:
									"Trust verification is disabled when running non-interactively with the -p flag",
								sourceRefs: [claudeRef],
								sourceUrls: [
									"https://docs.anthropic.test/claude-code/security",
								],
								sourceQuality: "primary",
							},
							{
								slotId: "slot-prompt",
								quote:
									"Segregate and identify external content. Separate and clearly denote untrusted content to limit its influence on user prompts.",
								sourceRefs: [owaspRef],
								sourceUrls: [
									"https://genai.owasp.test/llmrisk/llm01-prompt-injection/",
								],
								sourceQuality: "primary",
							},
							{
								slotId: "slot-fs",
								quote:
									"Docker --read-only mounts the container root filesystem as read only; --tmpfs mounts a tmpfs directory.",
								sourceRefs: [dockerRef],
								sourceUrls: ["https://docs.docker.com/engine/containers/run/"],
								sourceQuality: "primary",
							},
						],
					},
				},
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-ci",
							claim:
								"Claude Code -p flag disables trust verification; teams must pre-configure allowedTools before bypassing the interactive approval gate.",
							factSlotIds: ["slot-ci"],
							sourceRefs: [claudeRef],
							sourceUrls: ["https://docs.anthropic.test/claude-code/security"],
						},
						{
							id: "claim-owasp",
							claim:
								"OWASP recommends privilege control, delimiters, and human approval for high-privilege operations.",
							factSlotIds: ["slot-prompt"],
							sourceRefs: [owaspRef],
							sourceUrls: [
								"https://genai.owasp.test/llmrisk/llm01-prompt-injection/",
							],
						},
						{
							id: "claim-docker",
							claim:
								"Docker --read-only makes the container root filesystem immutable; --tmpfs /tmp allows ephemeral writable scratch space.",
							factSlotIds: ["slot-fs"],
							sourceRefs: [dockerRef],
							sourceUrls: ["https://docs.docker.com/engine/containers/run/"],
						},
					],
					preservedClaims: [],
					duplicates: [],
				},
				factSlotCoverage: [],
				coverageGaps: [],
			},
		},
		options: {
			unquotedNamedMitigationTerms: ["delimiters"],
		},
	});

	const claims = result.claimInventory.verificationCandidates;
	assert.deepEqual(
		claims.map((claim) => claim.id),
		["claim-ci", "claim-owasp", "claim-docker"],
	);
	assert.equal(
		claims[0].claim,
		"Trust verification is disabled when running non-interactively with the -p flag",
	);
	assert.equal(
		claims[1].claim,
		"Segregate and identify external content. Separate and clearly denote untrusted content to limit its influence on user prompts.",
	);
	assert.deepEqual(claims[2].sourceUrls, [
		"https://docs.docker.com/engine/containers/run/",
	]);
	assert.deepEqual(result.sanitizerDiagnostics.rewriteReasonCounts, {
		unsupported_normative_prerequisite: 1,
		source_hint_claim_mismatch: 1,
		unquoted_named_mitigation: 1,
	});
	assert.equal(result.sanitizerDiagnostics.rewrittenCandidateCount, 2);
});

test("deep-research sanitizer: claims in another script than their source quotes reach the verifiers", async () => {
	// 2026-11-03 (Codex run workflow_mw0y4aje_c064c4, a Korean task): Korean claims against English
	// source quotes share no words, so every candidate was demoted as source_hint_claim_mismatch and
	// nothing was verified. Across scripts the word check is skipped; within one script it stays.
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs?test=${Date.now()}`
	);
	const url = "https://www.langchain.test/blog/context-engineering-for-agents";
	const fact = (slotId, quote) => ({
		slotId,
		quote,
		sourceUrls: [url],
		sourceQuality: "primary",
	});
	const candidate = (id, slotId, claim) => ({
		id,
		claim,
		factSlotIds: [slotId],
		sourceUrls: [url],
	});
	const result = await helper({
		sources: {
			"normalize-input-packet.main": {
				packet: {
					research: {
						extractedFacts: [
							fact(
								"slot-ko",
								"We group common strategies for agent context engineering into four buckets: write, select, compress, and isolate.",
							),
							fact(
								"slot-en",
								"Memory lets an agent persist information across separate conversation threads for later reuse.",
							),
						],
					},
				},
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						candidate(
							"claim-ko",
							"slot-ko",
							"LangChain은 에이전트 컨텍스트 관리 전략을 write, select, compress, isolate의 네 범주로 묶는다.",
						),
						candidate(
							"claim-en",
							"slot-en",
							"Retrieval augmented generation always outperforms fine tuning on every benchmark task.",
						),
					],
					preservedClaims: [],
					duplicates: [],
				},
				factSlotCoverage: [],
				coverageGaps: [],
			},
		},
	});
	const diagnostics = result.sanitizerDiagnostics;
	assert.deepEqual(diagnostics.keptCandidateIds, ["claim-ko"]);
	assert.deepEqual(diagnostics.demotedCandidateIds, ["claim-en"]);
	assert.deepEqual(diagnostics.demotionReasonCounts, {
		source_hint_claim_mismatch: 1,
	});
	assert.deepEqual(diagnostics.crossScriptCandidateIds, ["claim-ko"]);
	assert.equal(diagnostics.crossScriptCandidateCount, 1);
});
