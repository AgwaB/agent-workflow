// test-tier: integration
// 2026-11-23 (owner): a run that waits for a person (blocked) is not working, so its clock stops
// where the work stopped instead of counting up until someone presses Stop.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();

test("a blocked run's clock stops at its last change; a running run's clock keeps going", {
	timeout: 90000,
}, async (t) => {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	const run = [...f.runs.values()].find((r) => r.status === "running");
	// The fixture clock sits at its recorded time, near this run's own start.
	const start = Date.parse(run.createdAt) - 20 * 60_000;
	run.createdAt = new Date(start).toISOString();
	run.updatedAt = new Date(start + 6_000).toISOString();
	delete run.activeMs;
	const header = async (status) => {
		run.status = status;
		await b.open(`${f.origin}/?run=${run.runId}&view=runs`);
		await b.waitFor(() => !!document.querySelector(".run-header"));
		return b.evaluate(() => document.querySelector(".run-header").innerText);
	};
	assert.match(await header("blocked"), /\b6s\b/);
	assert.match(await header("running"), /\b(2\d|3\d)m \d\ds\b/);
});
