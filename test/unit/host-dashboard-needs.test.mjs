// test-tier: integration
// 2026-11-01: a failure in "Needs you" can be dismissed (this browser); executor decisions cannot; the top
// count follows; "Show N dismissed" restores; a new failure of the same run shows again.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const FAILED_RUN = "workflow_mvt8x01c_aa3e91";

const rail = (browser) =>
	browser.evaluate(() => ({
		needs: [...document.querySelectorAll("#rail .need .need-title")].map(
			(el) => el.textContent,
		),
		dismiss: [...document.querySelectorAll("#rail .need-dismiss")].map((el) =>
			el.getAttribute("aria-label"),
		),
		restore: document.querySelector("#rail .need-restore")?.textContent ?? null,
		top: document
			.querySelector(".needs-button")
			?.textContent.replace(/\s+/g, " ")
			.trim(),
	}));

test("Needs you: dismiss a failure, keep executor decisions, restore, and see a new failure again", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 60_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(
		() => document.querySelectorAll("#rail .need").length === 2,
	);
	let now = await rail(browser);
	assert.equal(now.top, "Needs you 2");
	assert.deepEqual(
		now.dismiss,
		["Dismiss: map-implementation failed"],
		"only the failure",
	);

	await browser.click("#rail .need-dismiss");
	now = await rail(browser);
	assert.deepEqual(now.needs, ["Controller needs a decision"]);
	assert.equal(now.restore, "Show 1 dismissed");
	assert.equal(now.top, "Needs you 1");
	assert.equal(
		await browser.evaluate(() =>
			document.activeElement?.classList.contains("need"),
		),
		true,
		"focus moves to the next need",
	);

	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector("#rail .need-restore"));
	assert.deepEqual(
		(await rail(browser)).needs,
		["Controller needs a decision"],
		"kept on reload",
	);

	// A new failure of the same run (another time) is not covered by the old dismissal.
	const run = fixture.runs.get(FAILED_RUN);
	run.needsYou = run.needsYou.map((need) => ({
		...need,
		since: new Date(Date.parse(need.since) + 60_000).toISOString(),
	}));
	run.updatedAt = new Date(Date.parse(run.updatedAt) + 60_000).toISOString();
	fixture.publish();
	await browser.waitFor(
		() => document.querySelectorAll("#rail .need").length === 2,
	);
	now = await rail(browser);
	assert.equal(now.top, "Needs you 2");
	assert.equal(
		now.restore,
		null,
		"the old dismissal no longer matches anything shown",
	);

	await browser.click("#rail .need-dismiss");
	await browser.click("#rail .need-restore");
	now = await rail(browser);
	assert.equal(now.needs.length, 2);
	assert.equal(now.restore, null);
});
