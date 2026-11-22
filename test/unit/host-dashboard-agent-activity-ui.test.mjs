// test-tier: integration
// 2026-11-23 (owner): an open agent reads like a terminal session that keeps going (Activity);
// a live redraw does not move an opened result in a stage's list; loading shows no spinner in
// the panel's corner.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const RUN = "workflow_mvt9k2qa_7c41e0";

async function setup(t, height = 997) {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1476,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	return { f, b };
}
const rows = (b) =>
	b.evaluate(() =>
		[...document.querySelectorAll("#activity-view > *")].map((row) =>
			row.textContent.trim(),
		),
	);

test("a running agent opens on Activity: tool lines, output and words, followed live", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	await b.open(`${f.origin}/?run=${RUN}&task=reviewers.ledger-double-write`);
	await b.waitFor(
		() =>
			document.querySelectorAll("#activity-view .activity-tool").length === 2,
	);
	const first = await b.evaluate(() => ({
		tab: document.querySelector('[aria-selected="true"][data-tab]')
			?.textContent,
		marks: [...document.querySelectorAll(".activity-tool")].map((row) => [
			row.dataset.status,
			row.querySelector(".activity-mark").textContent,
		]),
		output: document.querySelector(".activity-output")?.textContent,
		injected: globalThis.dashboardInjected === true,
		logHidden: document.querySelector("#log-text").hidden,
	}));
	assert.deepEqual(first, {
		tab: "Activity",
		marks: [
			["completed", "✓"],
			["running", "●"],
		],
		output: "ok 1 - retries\nok 2 - backoff",
		injected: false,
		logHidden: true,
	});
	assert.match((await rows(b))[0], /Looking at the retry code <script>/);
	// New activity arrives without a click, and the view stays at its bottom.
	f.activities.set("task-10", [
		...Array.from({ length: 60 }, (_, index) => ({
			kind: "tool",
			label: `Reading file-${index}.ts`,
			status: "completed",
		})),
		{ kind: "tool", label: "Running npm run lint", status: "running" },
	]);
	await b.waitFor(
		() =>
			document.querySelectorAll("#activity-view .activity-tool").length === 61,
		undefined,
		10000,
	);
	const follow = () =>
		b.evaluate(() => {
			const view = document.querySelector("#activity-view");
			return {
				bottom: view.scrollTop + view.clientHeight >= view.scrollHeight - 8,
				top: view.scrollTop,
				last: view.lastElementChild.textContent.trim(),
			};
		});
	assert.deepEqual(
		{ ...(await follow()), top: undefined },
		{ bottom: true, top: undefined, last: "●Running npm run lint" },
	);
	// A reader who scrolled up keeps their place while more arrives.
	await b.evaluate(() => {
		document.querySelector("#activity-view").scrollTop = 40;
	});
	f.activities.get("task-10").push({
		kind: "tool",
		label: "Running npm test",
		status: "running",
	});
	await b.waitFor(
		() =>
			document.querySelectorAll("#activity-view .activity-tool").length === 62,
		undefined,
		10000,
	);
	const kept = await follow();
	assert.equal(kept.top, 40);
	assert.equal(kept.bottom, false);
});

test("a finished agent opens on Result; its Activity is read once and not polled", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	await b.open(`${f.origin}/?run=${RUN}&task=reviewers.refund-idempotency`);
	await b.waitFor(() => !!document.querySelector('[data-tab="events"]'));
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelector('[aria-selected="true"][data-tab]').textContent,
		),
		"Result",
	);
	await b.click('[data-tab="events"]');
	await b.waitFor(
		() => document.querySelectorAll("#activity-view .activity-tool").length > 0,
	);
	const reads = f.activityRequests.filter((id) => id === "task-9").length;
	await new Promise((resolve) => setTimeout(resolve, 4500));
	assert.equal(
		f.activityRequests.filter((id) => id === "task-9").length,
		reads,
		"no polling for a finished agent",
	);
});

test("a live redraw keeps an opened result's place in a stage list", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	await b.open(`${f.origin}/?run=${RUN}&stage=reviewers`, 1476, 420);
	await b.waitFor(() => document.querySelectorAll(".agent-item").length === 3);
	await b.evaluate(() =>
		[...document.querySelectorAll(".agent-item")]
			.find((row) => /refund/i.test(row.textContent))
			.click(),
	);
	await b.waitFor(
		() => !!document.querySelector(".item-expand .result-analysis"),
	);
	const scrolled = await b.evaluate(() => {
		const inspector = document.querySelector("#inspector");
		inspector.scrollTop = inspector.scrollHeight;
		return inspector.scrollTop;
	});
	assert.ok(scrolled > 0, "the inspector scrolls at this height");
	for (let round = 0; round < 3; round++) {
		f.runs.get(RUN).updatedAt = new Date(Date.now() + round).toISOString();
		f.publish();
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	assert.equal(
		await b.evaluate(() => document.querySelector("#inspector").scrollTop),
		scrolled,
	);
});

test("loading draws no spinner in the panel corner; screen readers still hear it", {
	timeout: 60000,
}, async (t) => {
	const { f, b } = await setup(t);
	await b.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `const originalFetch = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith('/runs'))
				await new Promise((resolve) => (window.__release = resolve));
			return originalFetch(...args);
		};`,
	});
	await b.send("Page.navigate", { url: `${f.origin}/?view=runs` });
	await b.waitFor(() => !!window.__release);
	const loading = await b.evaluate(() => {
		const status = document.querySelector('#center [role="status"]');
		const box = status.getBoundingClientRect();
		return {
			label: status.getAttribute("aria-label"),
			visible: box.width > 2 && box.height > 2,
			spinners: document.querySelectorAll("#center .project-settings-spinner")
				.length,
		};
	});
	await b.evaluate(() => window.__release());
	assert.deepEqual(loading, {
		label: "Loading dashboard",
		visible: false,
		spinners: 0,
	});
});
