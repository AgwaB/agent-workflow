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
