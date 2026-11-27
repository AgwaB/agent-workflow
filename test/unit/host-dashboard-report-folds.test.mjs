// test-tier: integration
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const runFixture = JSON.parse(
	await readFile(
		new URL(
			"../fixtures/dashboard/run-workflow_mvt23704_e8e6d7.json",
			import.meta.url,
		),
		"utf8",
	),
);
const research = {
	...runFixture,
	name: "deep-research",
	runId: "workflow_mvt23704_000001",
};

test("report folds are collapsed, text-only, and stay with their action", {
	timeout: 30000,
}, async (t) => {
	const run = research.runId;
	const server = await createFixtureServer({ snapshots: [research] });
	t.after(() => server.close());
	server.reports.set(
		run,
		[
			"# 조사 보고서",
			"",
			"주장 2개 · 인용 1개 · 출처 1곳",
			"",
			"## 할 일",
			"",
			"1. **일부 확인** First step",
			"   <details>",
			"   <summary>관련 권고 <img src=x></summary>",
			"",
			"   - related one",
			"   - related two",
			"",
			"   </details>",
			"2. **Verified** Second step",
			"",
			"<details>",
			"<summary>근거 보기</summary>",
			"",
			"<details>",
			"<summary>Nested fold</summary>",
			"",
			"<script>window.markupRan = true</script>",
			"### finding-001 — not a card",
			"Severity: high",
			"",
			"</details>",
			"</details>",
			"",
			"<details open>",
			"<summary>Not an allowed fold</summary>",
			"</details>",
			"",
			"<details>",
			"<summary onclick=invalid>Attribute in summary</summary>",
			"</details>",
			"",
			"&lt;details&gt;",
			"&lt;summary&gt;Escaped&lt;/summary&gt;",
			"",
			"```",
			"<details>",
			"<summary>Fenced</summary>",
			"</details>",
			"```",
			"",
			"<details>",
			"<summary>Unclosed</summary>",
		].join("\n"),
	);
	const browser = await createBrowser(await findChrome());
	t.after(() => browser.close());
	await browser.open(`${server.origin}/?run=${run}&view=report`);
	await browser.waitFor(
		() => document.querySelectorAll(".report-content details").length === 3,
	);
	const out = await browser.evaluate(() => {
		const content = document.querySelector(".report-content");
		return {
			open: content.querySelectorAll("details[open]").length,
			unsafe: content.querySelectorAll("img, script, [onclick]").length,
			cards: content.querySelectorAll(".finding-card").length,
			steps: [...content.querySelectorAll("ol > li > .md-status-chip")].map(
				(node) => node.textContent,
			),
			related: content.querySelector("ol > li > details ul")?.children.length,
			summary: content.querySelector("details summary").textContent,
			text: content.textContent,
		};
	});
	assert.equal(out.open, 0);
	assert.equal(out.unsafe, 0);
	assert.equal(out.cards, 0);
	assert.deepEqual(out.steps, ["일부 확인", "Verified"]);
	assert.equal(out.related, 2);
	assert.equal(out.summary, "관련 권고 <img src=x>");
	assert.match(out.text, /<script>window.markupRan = true<\/script>/);
	assert.match(out.text, /<details open>/);
	assert.match(out.text, /<summary onclick=invalid>/);
	assert.match(out.text, /<summary>Unclosed<\/summary>/);
	await browser.click(".report-content ol > li > details > summary");
	await browser.waitFor(
		() => document.querySelector(".report-content ol > li > details").open,
	);
});

async function reportBrowser(t, text, runs = [research]) {
	const server = await createFixtureServer({ snapshots: runs });
	t.after(() => server.close());
	for (const run of runs) server.reports.set(run.runId, text);
	const browser = await createBrowser(await findChrome());
	t.after(() => browser.close());
	return {
		browser,
		async open(run) {
			await browser.open(`${server.origin}/?run=${run.runId}&view=report`);
			await browser.waitFor(() =>
				document.querySelector(".report-content .md-h1"),
			);
		},
	};
}

test("the same report enables folds, localized chips and trust styling only in research", {
	timeout: 30000,
}, async (t) => {
	const text = [
		"# Report",
		"",
		"Claims: 2 verified · 1 quote · 1 source",
		"",
		"**Verified**",
		"",
		"<details>",
		"<summary>Example</summary>",
		"",
		"### finding-001 — Keep the card",
		"Severity: high",
		"",
		"</details>",
	].join("\n");
	const { browser, open } = await reportBrowser(t, text, [
		runFixture,
		research,
	]);
	for (const [run, expected] of [
		[runFixture, [0, 0, 0, 1]],
		[research, [1, 1, 1, 0]],
	]) {
		await open(run);
		const out = await browser.evaluate(() => {
			const content = document.querySelector(".report-content");
			return [
				"details.md-fold",
				".md-status-chip",
				".md-trust",
				".finding-card",
			].map((selector) => content.querySelectorAll(selector).length);
		});
		assert.deepEqual(out, expected, run.name);
	}
});

test("an unmatched backtick in a list item does not hide the next deep-review finding", {
	timeout: 30000,
}, async (t) => {
	const { browser, open } = await reportBrowser(
		t,
		[
			"# Review report",
			"",
			"- Unmatched ` in preceding item",
			"### finding-001 — Correct `src/main.ts`",
			"Severity: high",
		].join("\n"),
		[runFixture],
	);
	await open(runFixture);
	const out = await browser.evaluate(() => {
		const content = document.querySelector(".report-content");
		return [
			content.querySelector("li")?.textContent,
			content.querySelector(".finding-card .finding-title")?.textContent,
		];
	});
	assert.deepEqual(out, [
		"Unmatched ` in preceding item",
		"Correct src/main.ts",
	]);
});

test("an ambiguous fold stays literal and code regions never create folds or finding cards", {
	timeout: 30000,
}, async (t) => {
	const text = [
		"# Report",
		"",
		"<details>",
		"<summary>Ambiguous outer</summary>",
		"<details open>",
		"<summary>Attributed inner</summary>",
		"</details>",
		"</details>",
		"",
		"```text multiple words",
		"<details>",
		"<summary>In fence</summary>",
		"### finding-001 — code",
		"Severity: high",
		"</details>",
		"```",
		"",
		"    <details>",
		"    <summary>Indented code</summary>",
		"    </details>",
		"",
		"Multiline `code sample",
		"<details>",
		"<summary>In code span</summary>",
		"### finding-002 — code",
		"Severity: high",
		"</details>",
		"finishes here`",
		"",
		"<details>",
		"<summary>Balanced outer</summary>",
		"<details>",
		"<summary>Balanced inner</summary>",
		"</details>",
		"</details>",
	].join("\n");
	const { browser, open } = await reportBrowser(t, text);
	await open(research);
	const out = await browser.evaluate(() => {
		const content = document.querySelector(".report-content");
		return {
			summaries: [...content.querySelectorAll("details > summary")].map(
				(node) => node.textContent,
			),
			cards: content.querySelectorAll(".finding-card").length,
			code: [...content.querySelectorAll("code")].map(
				(node) => node.textContent,
			),
			text: content.textContent,
		};
	});
	assert.deepEqual(out.summaries, ["Balanced outer", "Balanced inner"]);
	assert.equal(out.cards, 0);
	assert.match(out.text, /<summary>Ambiguous outer<\/summary>/);
	for (const label of ["In fence", "Indented code", "In code span"])
		assert.ok(
			out.code.some((value) => value.includes(label)),
			label,
		);
});

test("localized coverage statuses and confidence levels get chips", {
	timeout: 30000,
}, async (t) => {
	const labels = [
		"Covered with conflicts",
		"상충 포함",
		"Gap",
		"공백",
		"Out of scope",
		"범위 밖",
		"Unknown",
		"알 수 없음",
		"높음",
		"보통",
		"낮음",
	];
	const { browser, open } = await reportBrowser(
		t,
		["# Report", "", ...labels.map((label) => `- **${label}**`)].join("\n"),
	);
	await open(research);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".report-content .md-status-chip")].map(
				(node) => node.textContent,
			),
		),
		labels,
	);
});

test("the written report restores literal quote and source text in the dashboard", {
	timeout: 30000,
}, async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-report-dom-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const result = await render({
		context: { cwd, runId: research.runId, taskId: "task-1" },
		sources: {
			"final-audit": {
				schema: "legacy-audit",
				digest: "Check the evidence.",
				claimVerdictIndex: { claims: [] },
				finalReport: {
					researchMetadata: {},
					coverageSummary: {},
					factSlotCoverage: [],
					recommendations: [],
					remainingGaps: [],
					parentDecisionNotes: [],
					unverifiedButRelevant: [],
					actionPlan: [{ step: "<step> [check](target)" }],
					mainFindings: [
						{
							finding: "A quote",
							evidence: [
								{ quote: "One  two\n  <quote> *literal* [detail](target)" },
							],
							sourceUrls: ["https://[invalid\n<bad-url>"],
						},
					],
				},
			},
		},
	});
	assert.equal(result.status, "passed");
	const md = await readFile(
		join(
			cwd,
			".agent-workflow",
			"workflows",
			research.runId,
			"tasks",
			"task-1",
			result.sidecarPath,
		),
		"utf8",
	);
	const { browser, open } = await reportBrowser(t, md);
	await open(research);
	const out = await browser.evaluate(() => {
		const report = document.querySelector(".report-content");
		return {
			text: report.textContent,
			quote: report.querySelector(".md-quote")?.textContent,
			unexpected: report.querySelectorAll(
				"step, quote, bad-url, em, h3 + details .md-url",
			).length,
		};
	});
	assert.equal(out.unexpected, 0);
	assert.equal(out.quote, '"One  two\\n  <quote> *literal* [detail](target)"');
	assert.match(out.text, /<step> \[check\]\(target\)/);
	assert.match(out.text, /https:\/\/\[invalid <bad-url>/);
});

test("the dashboard decodes angle-delimited links with reserved path and query characters", {
	timeout: 30000,
}, async (t) => {
	const { browser, open } = await reportBrowser(
		t,
		[
			"# Research report",
			"",
			"[Download](<https://example.org/file(a)?sig=(XYZ)&amp;x=&amp;amp;#line>)",
		].join("\n"),
	);
	await open(research);
	const target = await browser.evaluate(
		() => document.querySelector(".report-content .md-url")?.textContent,
	);
	assert.equal(target, " (https://example.org/file(a)?sig=(XYZ)&x=&amp;#line)");
});

test("trusted review reports share collapsed folds and chips without losing deep-review cards", {
	timeout: 50000,
}, async (t) => {
	const names = [
		"deep-review",
		"impact-review",
		"spec-review",
		"other-workflow",
	];
	const snapshots = names.map((name, index) => ({
		...runFixture,
		name,
		runId: `workflow_mvt23704_20000${index}`,
	}));
	const server = await createFixtureServer({ snapshots, readonly: true });
	t.after(() => server.close());
	const browser = await createBrowser(await findChrome());
	t.after(() => browser.close());
	for (const snapshot of snapshots) {
		const card = snapshot.name === "deep-review";
		const trusted = snapshot.name !== "other-workflow";
		server.reports.set(
			snapshot.runId,
			[
				"# 검토 보고서",
				"",
				"근거: 항목 1건 · 출처 1곳 · 검토 완료",
				"",
				"## 결론",
				"",
				"판정: **수정 필요**.",
				"",
				"## 발견 사항",
				"",
				...(card
					? [
							"### finding-001 — 경계값 불일치",
							"",
							"심각도: **높음**",
							"검증 판정: **유지**",
						]
					: ["### **회귀 위험** — 경계값 불일치"]),
				"",
				"<details>",
				"<summary>근거 보기</summary>",
				"",
				"&lt;details&gt; \\[unsafe\\](javascript:fake) ftp&#58;//example.org",
				"",
				"```text",
				"<details>",
				"<summary>Not a fold</summary>",
				"</details>",
				"```",
				"",
				"</details>",
				"",
				"## 부록",
				"",
				"<details>",
				"<summary>검토 기록</summary>",
				"",
				"출처 1곳",
				"",
				"</details>",
			].join("\n"),
		);
		await browser.open(`${server.origin}/?run=${snapshot.runId}&view=report`);
		await browser.waitFor(() =>
			document
				.querySelector(".report-content")
				?.textContent.includes("경계값 불일치"),
		);
		const dom = await browser.evaluate(() => {
			const root = document.querySelector(".report-content");
			return {
				trust: root.querySelectorAll(".md-trust").length,
				folds: root.querySelectorAll("details:not([open])").length,
				unsafe: root.querySelectorAll(
					"a[href^='javascript:'], a[href^='ftp:'], script, [onclick]",
				).length,
				severity: root.querySelector(".finding-card")?.dataset.severity,
				verdict: root.querySelector(".finding-card")?.dataset.verdict,
				chip: root.querySelector(".md-status-chip")?.textContent,
			};
		});
		assert.equal(dom.trust, Number(trusted), snapshot.name);
		assert.equal(dom.folds, trusted ? 2 : 0, snapshot.name);
		assert.equal(dom.unsafe, 0, snapshot.name);
		assert.equal(dom.severity, card ? "high" : undefined);
		assert.equal(dom.verdict, card ? "kept" : undefined);
		assert.equal(dom.chip, trusted ? "수정 필요" : undefined);
	}
});

async function deepReviewFixture({
	title = "Active observation",
	file = "source.ts",
	symbol = "entry",
} = {}) {
	const { default: deepReview } = await import(
		"../../workflows/deep-review/helpers/render-review-report.mjs"
	);
	return (
		await deepReview({
			sources: {
				"partition-verdicts.main": {
					partitions: {
						keep: [
							{
								findingId: "finding-001",
								title,
								severity: "high",
								locations: [{ file, line: 7, symbol }],
							},
						],
						drop: [
							{
								findingId: "finding-002",
								title: "Archived observation",
								severity: "low",
							},
						],
						needsHuman: [
							{
								findingId: "reviewer-coverage-003",
								title: "Live coverage observation",
								severity: "high",
								recommendedAction: "Recheck the missing source",
							},
						],
					},
				},
			},
		})
	).markdown;
}

const deepReviewRun = { ...research, name: "deep-review" };
const prose = "Keep ~~draft~~ & &gt; `word` | literal";
const filename = "A&B &amp; `x`|a.ts";
const symbol = "`~~foo~~ &lt; |`";

async function literalReport() {
	const { escapeTableCell } = await import(
		"../../workflows/deep-review/helpers/report-markdown.mjs"
	);
	const markdown = await deepReviewFixture({
		title: prose,
		file: filename,
		symbol,
	});
	return `${markdown}\n\n## Literal cells\n\n| Comparison |\n|---|\n| ${escapeTableCell(prose)} |`;
}

async function checkLiteralViewer(browser) {
	const result = await browser.evaluate(() => {
		const root = document.querySelector(".report-content");
		const h = root.querySelector(".finding-title");
		return {
			heading: h?.textContent.replace(/^finding-001 — /, ""),
			locations: [...root.querySelectorAll("td code")]
				.slice(0, 2)
				.map((node) => node.textContent),
			cell: [...root.querySelectorAll("td")].at(-1)?.textContent,
			deletions: root.querySelectorAll("del").length,
		};
	});
	assert.equal(result.heading, prose);
	assert.deepEqual(result.locations, [filename, symbol]);
	assert.equal(result.cell, prose);
	assert.equal(result.deletions, 0);
}

test("exported report uses GFM escapes for literal prose and code table cells", async () => {
	const md = await literalReport();
	assert.ok(
		md.includes("Keep \\~\\~draft\\~\\~ &amp; &amp;gt; \\`word\\` \\| literal"),
	);
	assert.ok(
		md.includes(
			"| Keep \\~\\~draft\\~\\~ &amp; &amp;gt; \\`word\\` &#124; literal |",
		),
	);
	assert.ok(md.includes("``A&B &amp; `x`\\|a.ts``"));
	assert.ok(md.includes("`` `~~foo~~ &lt; \\|` ``"));
});

test("report text and code span table cells round-trip through the dashboard", {
	timeout: 30000,
}, async (t) => {
	const md = await literalReport();
	const { browser, open } = await reportBrowser(t, md, [deepReviewRun]);
	await open(deepReviewRun);
	await checkLiteralViewer(browser);
});

test("review outline skips closed records and links reviewer coverage cards to their actions", {
	timeout: 30000,
}, async (t) => {
	const { browser, open } = await reportBrowser(t, await deepReviewFixture(), [
		deepReviewRun,
	]);
	await open(deepReviewRun);
	const data = await browser.evaluate(() => ({
		links: [...document.querySelectorAll(".report-outline .outline-text")].map(
			(node) => node.textContent,
		),
		archived: [
			...document.querySelectorAll(
				".report-content details:not([open]) .md-h3",
			),
		].some((node) => node.textContent.includes("Archived observation")),
		card: document.querySelector(
			'.finding-card[aria-label="reviewer-coverage-003"] .finding-title',
		)?.textContent,
	}));
	assert.ok(data.archived);
	assert.ok(!data.links.includes("Archived observation"));
	assert.ok(data.links.includes("Live coverage observation"));
	assert.equal(data.card, "Live coverage observation");
	await browser.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (s) => {
					window.copied = s;
				},
			},
		});
		document
			.querySelector('[data-copy-finding="reviewer-coverage-003"]')
			.click();
	});
	assert.match(
		await browser.evaluate(() => window.copied),
		/Recommended action: Recheck the missing source/,
	);
});

test("Korean impact risk none is neutral and distinct from missing", {
	timeout: 30000,
}, async (t) => {
	const { reportRiskStatus } = await import(
		"../../workflows/impact-review/helpers/report-markdown.mjs"
	);
	const none = reportRiskStatus("none", (_en, ko) => ko);
	const run = { ...research, name: "impact-review" };
	const { browser, open } = await reportBrowser(
		t,
		`# 보고서\n\n근거: 출처 7개 · 검토 완료 · 검증됨\n\n위험도: **${none}**.\n\n**없음**`,
		[run],
	);
	await open(run);
	assert.deepEqual(
		await browser.evaluate(() =>
			[...document.querySelectorAll(".report-content .md-status-chip")].map(
				(n) => [n.textContent, n.dataset.tone],
			),
		),
		[
			["위험 없음", "neutral"],
			["없음", "bad"],
		],
	);
});

test("dashboard translates bold prose without consuming code or changing link targets", {
	timeout: 30000,
}, async (t) => {
	const { browser, open } = await reportBrowser(
		t,
		[
			"# Deep review report",
			"",
			"Evidence: one observation",
			"",
			"**READY with `READY &gt;`**",
			"",
			"[a `symbol`](https://example.com/`literal`?x=1&amp;y=2)",
		].join("\n"),
		[deepReviewRun],
	);
	await open(deepReviewRun);
	assert.deepEqual(
		await browser.evaluate(() => {
			const root = document.querySelector(".report-content");
			return {
				bold: root.querySelector("strong")?.textContent,
				code: root.querySelector("strong code")?.textContent,
				linkCode:
					root.querySelector(".md-url")?.previousElementSibling?.textContent,
				target: root.querySelector(".md-url")?.textContent,
			};
		}),
		{
			bold: "Ready with READY &gt;",
			code: "READY &gt;",
			linkCode: "symbol",
			target: " (https://example.com/`literal`?x=1&y=2)",
		},
	);
});
