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

// 2026-11-12 (owner: one dismissal for every host): a failed run's need is dismissed through the
// project's notice acknowledgements, so the Pi, Claude Code and Codex reminders stay quiet too;
// "Show N dismissed" clears it; a new failure of the run (another state) shows again.
test("Needs you: a dismissal is the shared notice acknowledgement", {
	skip: chrome
		? false
		: "Chrome is not installed (set CHROME to a local executable)",
	timeout: 60_000,
}, async (t) => {
	const fixture = await createFixtureServer({ notices: true });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(
		() => document.querySelectorAll("#rail .need").length === 2,
	);
	assert.match(
		await browser.evaluate(() =>
			document.querySelector("#rail .need-dismiss").getAttribute("title"),
		),
		/Dismiss everywhere/,
	);
	await browser.click("#rail .need-dismiss");
	await browser.waitFor(
		() =>
			document.querySelector("#rail .need-restore")?.textContent ===
			"Show 1 dismissed",
	);
	const acknowledge = fixture.mutations.find(
		(entry) => entry.action === "notices-acknowledge",
	);
	assert.equal(acknowledge?.runId, FAILED_RUN);
	assert.equal(acknowledge.body.reason, "Dismissed in the dashboard");
	assert.match(acknowledge.body.state, /^[a-f0-9]{64}$/);
	assert.equal(
		await browser.evaluate(() =>
			localStorage.getItem(
				Object.keys(localStorage).find((key) =>
					key.startsWith("agent-workflow:dismissed-needs:"),
				) ?? "",
			),
		),
		"[]",
		"not kept in this browser only",
	);

	// Another browser (a reload with no local state) sees the dismissal too.
	await browser.evaluate(() => localStorage.clear());
	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(() => document.querySelector("#rail .need-restore"));
	assert.deepEqual((await rail(browser)).needs, [
		"Controller needs a decision",
	]);

	await browser.click("#rail .need-restore");
	await browser.waitFor(
		() => document.querySelectorAll("#rail .need").length === 2,
	);
	assert.ok(
		fixture.mutations.some(
			(entry) => entry.action === "notices-clear" && entry.runId === FAILED_RUN,
		),
	);

	// Dismiss again, then the run fails again (a new state): it shows again.
	await browser.click("#rail .need-dismiss");
	await browser.waitFor(() => document.querySelector("#rail .need-restore"));
	const run = fixture.runs.get(FAILED_RUN);
	run.updatedAt = new Date(Date.parse(run.updatedAt) + 60_000).toISOString();
	run.needsYou = run.needsYou.map((need) => ({
		...need,
		since: new Date(Date.parse(need.since) + 60_000).toISOString(),
	}));
	fixture.publish();
	await browser.open(`${fixture.origin}/`);
	await browser.waitFor(
		() => document.querySelectorAll("#rail .need").length === 2,
	);
});
