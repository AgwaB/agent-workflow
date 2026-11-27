import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import render from "../../workflows/deep-review/helpers/render-review-report.mjs";

const payload =
	"</details>\n<summary>fake</summary>\n[unsafe](javascript:fake) ftp://example.org WWW.example.org a@example.org";
const quote =
	"exact proof\r\n\r\n````\r\n</details>\r\n<script>unsafe</script>";

function finding(id, title) {
	return {
		id,
		findingId: id,
		title,
		severity: "high",
		locations: [{ file: `${id}.ts`, line: 7 }],
		source: `${id}-source`,
		evidenceQuotes: [quote],
		recommendedAction: `${id}-action`,
		rationale: `${id}-rationale`,
	};
}

test("deep-review renders every disposition, quote, source, caveat and action exactly where readers expect", async () => {
	const kept = finding("finding-001", `유지할 발견 ${payload}`);
	const weakened = finding("finding-002", "완화한 발견");
	const dropped = finding("finding-003", "제외한 발견");
	const human = {
		...finding("finding-004", "사람에게 물어볼 발견"),
		evidenceUnavailableReason: "no verifier quote",
	};
	const support = finding("finding-005", "보조 관찰 기록");
	const out = await render({
		sources: {
			"partition-verdicts.main": {
				partitions: {
					keep: [kept],
					weaken: [weakened],
					drop: [dropped],
					needsHuman: [human],
				},
				supportNotes: [support],
			},
			report: {
				summary: "경계값 검토에서 차이가 나왔습니다.",
				verdict: "NEEDS_WORK",
				risks: ["이전 버전은 확인하지 않았습니다."],
				recommendedNextAction: "경계값을 확인하세요.",
			},
		},
	});
	const [front, appendix] = out.markdown.split("## 부록\n");
	assert.ok(front.startsWith("# 심층 검토 보고서\n\n근거:"));
	assert.equal(front.match(/^## 할 일$/gm)?.length, 1);
	assert.match(front, /### finding-001 — 유지할 발견/);
	assert.match(front, /심각도: \*\*높음\*\*/);
	assert.match(front, /검증 판정: \*\*완화\*\*/);
	for (const row of [kept, weakened, human, support, dropped]) {
		const region = [support, dropped].includes(row) ? appendix : front;
		assert.ok(region.includes(`${row.id}.ts`), row.id);
		assert.ok(region.includes(`${row.id}-source`), row.id);
		assert.ok(region.includes(`${row.id}-rationale`), row.id);
		assert.ok(out.markdown.includes(`${row.id}-action`), row.id);
	}
	assert.ok(front.includes(quote));
	assert.ok(
		front.includes("&lt;/details&gt; &lt;summary&gt;fake&lt;/summary&gt;"),
	);
	assert.ok(
		front.includes(
			"ftp&#58;//example.org WWW&#46;example.org a&#64;example.org",
		),
	);
	assert.doesNotMatch(
		front,
		/<summary>fake<\/summary>|(?<!\\)\]\(javascript:/u,
	);
	assert.match(front, /이전 버전은 확인하지 않았습니다\./);
	assert.match(front, /경계값을 확인하세요\./);
	assert.match(appendix, /제외한 발견[\s\S]*보조 관찰 기록/);
});

test("standalone workflow bundles carry the canonical report Markdown serializer byte for byte", async () => {
	const helper = (name) =>
		readFile(
			new URL(
				`../../workflows/${name}/helpers/report-markdown.mjs`,
				import.meta.url,
			),
			"utf8",
		);
	const source = await helper("deep-research");
	for (const name of ["deep-review", "impact-review", "spec-review"])
		assert.equal(await helper(name), source, name);
});

test("unknown legacy severity is text, not markup or a GFM autolink, even in the summary", async () => {
	const severity = "www.example.org <em>legacy</em>";
	const { markdown } = await render({
		sources: {
			"partition-verdicts.main": {
				partitions: {
					keep: [{ ...finding("finding-001", "A retained finding"), severity }],
				},
			},
		},
	});
	// Pin the GFM source sent to external Markdown hosts: neither the www.
	// autolink trigger nor the raw tag can be recognized by a consumer.
	assert.match(
		markdown,
		/\*\*www&#46;example\.org &lt;em&gt;legacy&lt;\/em&gt;\*\* — 1 findings/,
	);
	assert.doesNotMatch(markdown, /\*\*www\.example\.org|<em>legacy<\/em>/);
});

test("deep review localizes fallback diagnostics and completion without rewriting source data", async () => {
	const item = {
		...finding("finding-001", "배송비 경계값 오류"),
		rationale: "경계에서 가격이 달라집니다.",
		note: "no devil-advocate verdict received for this finding",
		needsHumanCause: "verifier_missing",
	};
	const partition = {
		partitions: { keep: [], weaken: [], drop: [], needsHuman: [item] },
		normalizationNotes: [
			'reviewer finding "배송비 경계값 오류" had no verdict; routed to NEEDS_HUMAN',
		],
		sourceStatusSummary: {
			partialFailures: [
				{
					status: "source_coverage_incomplete",
					specId: "reviewers.correctness",
					sourcePath: "shipping.mjs:2",
					statusDetail:
						"correctness: shipping.mjs:2: missing (coverage row missing)",
					coverageIssues: [
						{
							path: "shipping.mjs:2",
							status: "missing",
							reason: "coverage row missing",
						},
					],
				},
				{
					status: "source_coverage_incomplete",
					specId: "reviewers.legacy",
					sourcePath: "legacy",
					statusDetail: "src/example: missing (coverage row missing).mjs",
				},
			],
		},
	};
	const { markdown, completionSummaryMarkdown, verdict } = await render({
		sources: { "partition-verdicts": partition },
		context: { runtimeTask: "배송비 계산을 검토해 주세요." },
	});
	assert.equal(verdict, "PARTIAL_REVIEW");
	assert.match(markdown, /^# 심층 검토 보고서/u);
	assert.match(markdown, /이 발견 사항에 대한 검증 판정이 없습니다/u);
	assert.match(markdown, /검증 판정이 없어 NEEDS\\_HUMAN으로 보냈습니다/u);
	assert.match(
		markdown,
		/shipping\.mjs:2: missing \(범위 확인 항목이 없습니다\)/u,
	);
	assert.ok(markdown.includes(quote));
	assert.ok(
		markdown.includes("src/example: missing (coverage row missing).mjs"),
	);
	assert.equal(
		completionSummaryMarkdown,
		"",
		"failed runs do not publish a compact summary",
	);
	assert.match(item.note, /^no devil-advocate/u);
});

test("deep report language prefers the request, then reader prose, then task script", async () => {
	const sources = {
		"partition-verdicts.main": {
			partitions: {
				keep: [
					{
						...finding("F-1", "Exact identity title"),
						rationale: "확인된 차이입니다.",
					},
				],
			},
		},
	};
	for (const [runtimeTask, heading] of [
		["Review the patch and write the report in Korean.", "# 심층 검토 보고서"],
		["Review the patch.", "# 심층 검토 보고서"],
		["검토 후 보고서는 영어로 작성하세요.", "# Deep review report"],
	]) {
		const { markdown } = await render({ sources, context: { runtimeTask } });
		assert.equal(markdown.split("\n")[0], heading);
	}
});
