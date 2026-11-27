import assert from "node:assert/strict";
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
