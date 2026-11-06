import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	createFixtureServer,
	injection,
} from "../helpers/dashboard-ui-fixture-server.mjs";

test("dashboard adds warning chips on live blocked-count update and safe samples in details", {
	timeout: 60_000,
}, async (t) => {
	const chrome = await findChrome();
	assert.ok(
		chrome,
		"Chrome is required for blocked-actions dashboard coverage",
	);
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const run = fixture.runs.get("workflow_mvt23704_e8e6d7");
	assert.ok(run);
	await browser.open(`${fixture.origin}/?run=${run.runId}`);
	await browser.waitFor(() => document.querySelector("#run-header"));
	assert.equal(
		await browser.evaluate(
			() => document.querySelectorAll(".blocked-actions-chip").length,
		),
		0,
	);
	const affected = run.tasks.find(
		(task) => task.kind !== "support" && !task.placeholder,
	);
	affected.blockedActions = {
		count: 2,
		provider: 2,
		engine: 0,
		samples: [
			{
				tool: "bash",
				command: `touch ${injection}`,
				reason: "Provider rule forbids touch",
				source: "provider",
			},
		],
	};
	run.blockedActions = { count: 2, provider: 2, engine: 0, samples: [] };
	fixture.publish();
	await browser.waitFor(() =>
		document
			.querySelector("#run-header .blocked-actions-chip")
			?.textContent.includes("2 actions blocked"),
	);
	await browser.waitFor(() =>
		document
			.querySelector(".node .blocked-actions-chip")
			?.textContent.includes("2 blocked"),
	);
	assert.deepEqual(
		run.needsYou,
		[],
		"blocked actions do not create a Needs you entry",
	);
	await browser.open(`${fixture.origin}/?run=${run.runId}&view=details`);
	await browser.waitFor(() =>
		document
			.querySelector("#inspector .blocked-actions")
			?.textContent.includes("Provider rule forbids touch"),
	);
	const sample = await browser.evaluate(
		() => document.querySelector("#inspector .blocked-actions").textContent,
	);
	assert.ok(
		sample.includes(injection),
		"untrusted sample is visible as literal text",
	);
	assert.match(sample, /--stream events/);
	assert.equal(
		await browser.evaluate(() => globalThis.dashboardInjected === true),
		false,
	);
	assert.equal(
		await browser.evaluate(
			() =>
				document.querySelectorAll("#inspector .blocked-actions script").length,
		),
		0,
	);
	assert.equal(fixture.mutations.length, 0);
});
