// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

test("report folds are collapsed, text-only, and stay with their action", {
	timeout: 30000,
}, async (t) => {
	const run = "workflow_mvt23704_e8e6d7";
	const server = await createFixtureServer();
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
