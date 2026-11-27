import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import render from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";

const quote = "exact bytes\r\n\r\n````\r\n<summary>not a fold</summary>";

function finding(id, title, verdict) {
	return {
		id,
		title,
		verdict,
		severity: "high",
		claim: `${id}-claim`,
		source: `${id}-source`,
		requirementIds: ["REQ-1"],
		recommendedAction: `${id}-action`,
		evidence: [quote],
	};
}

test("spec reader keeps every gap, requirement, caveat, source and action", async () => {
	const out = await render({
		sources: {
			"partition-findings.main": {
				finalFindings: [
					finding("F-1", "확인된 차이", "KEEP"),
					finding("F-2", "완화된 차이", "WEAKEN"),
				],
				needsHuman: [finding("H-1", "사람이 검토할 차이", "NEEDS_HUMAN")],
				droppedFindings: [finding("D-1", "제외된 차이", "DROP")],
				requirementCoverage: [
					{
						requirementId: "REQ-1",
						status: "covered",
						reason: "original-source",
						recheck: {
							from: "unclear",
							status: "covered",
							reason: "different-recheck-source",
						},
					},
					{
						requirementId: "REQ-2",
						status: "unclear",
						reason: "[link](javascript:fake)\n</details>\nftp://example.org",
					},
				],
				scopeLimitations: [
					{ kind: "NONBLOCKING", text: "읽기 전용 검토였습니다." },
				],
				noIssueNotes: ["not-confirmed-note"],
				evidenceGate: { complete: false, source: "snapshot.json" },
			},
			report: {
				verdict: "GAPS_FOUND",
				summary: "경계값에 차이가 있습니다.",
				risks: ["다른 경계값은 확인하지 않았습니다."],
				recommendedNextAction: "경계값을 다시 확인하세요.",
			},
		},
	});
	const [front, appendix] = out.markdown.split("## 부록\n");
	assert.match(front, /^# 명세 검토 보고서\n\n근거:/);
	assert.equal(front.match(/^## 할 일$/gm)?.length, 1);
	for (const id of ["F-1", "F-2", "H-1", "D-1"]) {
		const part = id === "D-1" ? appendix : front;
		for (const type of ["claim", "source", "action"])
			assert.ok(part.includes(`${id}-${type}`), `${id}-${type}`);
	}
	assert.ok(front.includes(quote));
	assert.match(front, /읽기 전용 검토였습니다\./);
	assert.match(front, /다른 경계값은 확인하지 않았습니다\./);
	assert.match(front, /경계값을 다시 확인하세요\./);
	for (const text of [
		"REQ-1",
		"REQ-2",
		"original-source",
		"different-recheck-source",
		"not-confirmed-note",
		"snapshot.json",
	])
		assert.ok(appendix.includes(text), text);
	assert.match(appendix, /&lt;\/details&gt; ftp&#58;\/\/example.org/);
	assert.doesNotMatch(appendix, /(?<!\\)\]\(javascript:/u);
});

test("spec dispositions and audit fields survive publication independently of historical verdicts", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-spec-reader-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await render({
		context: { cwd, runId: "reader", taskId: "task-1" },
		sources: {
			"partition-findings.main": {
				needsHuman: [
					{
						id: "H1",
						title: "Distinct title",
						verdict: "KEEP",
						finalClaim: "Distinct claim",
						reason: "Distinct reason",
						source: "Distinct source",
						origin: { kind: "Distinct origin" },
						evidenceStatus: "Distinct status",
					},
				],
				droppedFindings: [
					{ id: "D1", title: "Archived title", verdict: "WEAKEN" },
				],
				requirementCoverage: [
					{
						requirementId: "R1",
						status: "needsHuman",
						evidence: ["legacy-source.ts:7"],
					},
				],
				evidenceGate: {
					coverage: [{ index: 0, id: "R1", rows: [null, {}, 4] }],
				},
				requirementRechecks: {
					ignored: [{ itemIdentity: "R1", reason: "Distinct ignored reason" }],
				},
				scopeLimitations: [{ kind: "NONBLOCKING", text: "Distinct caveat" }],
			},
		},
	});
	const md = await readFile(
		join(cwd, ".agent-workflow/workflows/reader/tasks/task-1/final-report.md"),
		"utf8",
	);
	const [front, appendix] = md.split("## Appendix");
	assert.match(front, /#### \*\*Needs human review\*\* — H1 · Distinct title/);
	assert.match(front, /Historical verifier verdict: Kept/);
	for (const field of ["claim", "reason", "source", "origin", "status"])
		assert.ok(front.includes(`Distinct ${field}`), field);
	assert.match(front, /NONBLOCKING.*Distinct caveat/);
	assert.match(appendix, /#### \*\*Dropped\*\* — D1 · Archived title/);
	assert.match(appendix, /Historical verifier verdict: Weakened/);
	assert.match(appendix, /\| R1 \| Needs human review \|/);
	assert.match(appendix, /display-only[\s\S]*legacy-source\.ts:7/);
	assert.match(appendix, /Ignored rechecks[\s\S]*Distinct ignored reason/);
});

test("unbound audit rows never replace the original coverage citation", async () => {
	const citation = "legacy-source.ts:7";
	for (const [index, status] of [
		[99, "verified"],
		[0, "verified"],
		[0, "unverified"],
	]) {
		const result = await render({
			sources: {
				"partition-findings.main": {
					requirementCoverage: [
						{ requirementId: "R1", status: "needsHuman", evidence: [citation] },
					],
					evidenceGate: {
						coverage: [
							{
								index: 0,
								id: "R1",
								rows: [{ field: "evidence", index, status, citation }],
							},
						],
					},
				},
			},
		});
		const [coverage] = result.markdown.split("### Byte evidence audit");
		assert.match(
			coverage,
			/display-only[^\n]*R1\n\n```text\nlegacy-source\.ts:7\n```/,
			`${index}, ${status}`,
		);
	}
});

test("spec review localizes machine diagnostics but preserves model prose and exact evidence", async () => {
	const item = {
		...finding("H-1", "배송비 경계값", "NEEDS_HUMAN"),
		claim: undefined,
		reason:
			"Unverified DROP: exact local byte evidence required in counterEvidence before removal",
		finalClaim:
			"No final verifier claim was supplied; the item remains unresolved.",
		recommendedAction:
			"Reconcile the unresolved evidence and rerun the review.",
		uncertainty: "Whether this applies to guest orders is unclear.",
	};
	const { markdown, verdict, scopeLimitations } = await render({
		context: { runtimeTask: "명세에서 정한 배송비를 검토해 주세요." },
		sources: {
			"partition-findings": {
				needsHuman: [item],
				scopeLimitations: [
					{ kind: "NONBLOCKING", text: "테스트를 실행하지 않았습니다." },
				],
			},
		},
	});
	assert.equal(verdict, "INCONCLUSIVE");
	assert.match(markdown, /^# 명세 검토 보고서/u);
	assert.match(markdown, /비차단 범위 제한: 테스트를 실행하지 않았습니다/u);
	assert.match(
		markdown,
		/DROP 미검증: 제외하려면 저장소 원문과 정확히 일치하는 반증이 필요합니다/u,
	);
	assert.match(markdown, /최종 검증 주장이 없어 이 항목이 미해결 상태입니다/u);
	assert.match(
		markdown,
		/\*\*H-1\*\* — 미해결 근거를 대조한 뒤 검토를 다시 실행하세요/u,
	);
	assert.ok(markdown.includes(item.uncertainty));
	assert.ok(markdown.includes(quote));
	assert.equal(scopeLimitations[0].kind, "NONBLOCKING");
});

test("spec report language prefers the request, then reader prose, then task script", async () => {
	const sources = {
		"partition-findings.main": {
			finalFindings: [finding("F-1", "확인된 차이", "KEEP")],
		},
	};
	for (const [runtimeTask, heading] of [
		["Review the patch and write the report in Korean.", "# 명세 검토 보고서"],
		[
			"Do not write the report in English; write the report in Korean.",
			"# 명세 검토 보고서",
		],
		["Review the patch.", "# 명세 검토 보고서"],
		["검토 후 보고서는 영어로 작성하세요.", "# Spec review report"],
	]) {
		const { markdown } = await render({ sources, context: { runtimeTask } });
		assert.equal(markdown.split("\n")[0], heading);
	}
});
