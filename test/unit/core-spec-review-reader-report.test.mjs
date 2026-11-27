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
