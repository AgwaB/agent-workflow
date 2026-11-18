// test-tier: integration
// Local fixture observations only: no model calls or owner browser space.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
const chrome = await findChrome();
async function setup(t) {
	assert.ok(chrome, "Chrome required");
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	return { fixture, browser };
}
test("polish: Overview Last result links the exact latest Run/report, not an invented workflow identity", {
	timeout: 90000,
}, async (t) => {
	const { fixture, browser } = await setup(t);
	await browser.open(fixture.origin);
	await browser.waitFor(() => !!document.querySelector(".home-table tbody tr"));
	const rows = await browser.evaluate(() =>
		[...document.querySelectorAll(".home-table tbody tr")].map((row) => ({
			name: row.dataset.workflow,
			href: row.querySelector(".c-last a")?.getAttribute("href"),
			settings: row.querySelector(".c-wf a").getAttribute("href"),
		})),
	);
	for (const row of rows) {
		const runs = [...fixture.runs.values()]
			.filter((r) => r.name === row.name)
			.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
		const last =
			runs.findLast((r) => ["completed", "failed"].includes(r.status)) ??
			runs.at(-1);
		assert.ok(row.href, JSON.stringify(row));
		assert.equal(
			new URL(row.href, fixture.origin).searchParams.get("run"),
			last.runId,
		);
		assert.equal(
			new URL(row.href, fixture.origin).searchParams.get("view"),
			last.reportAvailable ? "report" : null,
		);
		assert.equal(
			new URL(row.settings, fixture.origin).searchParams.get("view"),
			"workflows",
		);
		assert.equal(
			new URL(row.settings, fixture.origin).searchParams.has("workflow"),
			false,
		);
	}
});
test("polish: stage summary labels recorded model/effort and executor-reported unknown separately; actual agent remains accessible", {
	timeout: 90000,
}, async (t) => {
	const { fixture, browser } = await setup(t);
	const run = fixture.runs.get("workflow_mvt9n8dd_19b2f4");
	const task = run.tasks.find((t) => t.stageId === "prep");
	task.effort = "low";
	await browser.open(`${fixture.origin}/?run=${run.runId}&stage=prep`);
	await browser.waitFor(() => !!document.querySelector(".agents-meta"));
	let text = await browser.evaluate(
		() => document.querySelector(".agents-meta").textContent,
	);
	assert.match(text, /Recorded model: claude-haiku-5-5/);
	assert.match(text, /Recorded effort: low/);
	assert.match(text, /Executor-reported model: unknown \/ not reported/);
	task.reportedModel = "provider/actual";
	fixture.publish();
	await browser.waitFor(() =>
		document
			.querySelector(".agents-meta")
			.textContent.includes("provider/actual"),
	);
	text = await browser.evaluate(
		() => document.querySelector(".agents-meta").textContent,
	);
	assert.match(text, /Recorded model: claude-haiku-5-5/);
	assert.match(text, /Executor-reported model: provider\/actual/);
	assert.ok(
		await browser.evaluate(() =>
			[...document.querySelectorAll("#inspector button")].some((n) =>
				/Open agent/.test(n.textContent),
			),
		),
	);
});
test("polish: completed Run shows result before concise contextual policy details without adding Stop/Resume", {
	timeout: 90000,
}, async (t) => {
	const { fixture, browser } = await setup(t);
	const run = [...fixture.runs.values()].find(
		(r) => r.status === "completed" && r.reportAvailable,
	);
	await browser.open(
		`${fixture.origin}/?run=${run.runId}&stage=${encodeURIComponent(run.tasks[0].stageId)}`,
	);
	await browser.waitFor(() => !!document.querySelector("#run-header .result"));
	const facts = await browser.evaluate(() => {
		const result = document.querySelector("#run-header .result"),
			context = document.querySelector("#run-header .run-context");
		return {
			before: !!(
				result.compareDocumentPosition(context) &
				Node.DOCUMENT_POSITION_FOLLOWING
			),
			reason: document.querySelectorAll('[data-testid="run-action-reason"]')
				.length,
			policy: context.querySelectorAll("details").length,
			buttons: [...document.querySelectorAll("#run-header button")].map(
				(n) => n.textContent,
			),
		};
	});
	assert.equal(facts.before, true);
	assert.equal(facts.reason, 0, "finished Runs carry no action note");
	assert.equal(facts.policy, 0, "no Run action policy disclosure");
	assert.equal(
		facts.buttons.some((s) => /Stop|Resume/.test(s)),
		false,
	);
	assert.ok(facts.buttons.includes("Open report"));
});
