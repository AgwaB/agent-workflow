// test-tier: integration
// Layout details the owner flagged on 2026-11-18: one gutter per panel, padded log boxes,
// readable times instead of raw ISO stamps, and the same page gutter on every view.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";

const chrome = await findChrome();
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d/;

async function setup(t) {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1476,
		height: 997,
		deviceScaleFactor: 1,
		mobile: false,
	});
	return { f, b };
}

test("agent panel: tabs, output, log box, details and terminal command share one gutter", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const run = [...f.runs.values()].find(
		(r) => r.status === "completed" && r.tasks.some((task) => task.startedAt),
	);
	const task = run.tasks.find((entry) => entry.startedAt && entry.completedAt);
	await b.open(`${f.origin}/?run=${run.runId}&task=${task.specId}&tab=stderr`);
	await b.waitFor(() => !!document.querySelector("#inspector .task-details"));
	const facts = await b.evaluate(() => {
		const panel = document.querySelector("#inspector");
		panel.querySelector(".task-details").open = true;
		const textLeft = (selector) => {
			const node = panel.querySelector(selector);
			const range = document.createRange();
			range.selectNodeContents(node);
			return Math.round(range.getBoundingClientRect().left);
		};
		const box = (selector) => {
			const rect = panel.querySelector(selector).getBoundingClientRect();
			return [Math.round(rect.left), Math.round(rect.right)];
		};
		const log = panel.querySelector("#log-text");
		return {
			tab: textLeft(".tabs button"),
			label: textLeft(".output-label"),
			log: box("#log-text"),
			command: box(".task-details .command"),
			logPadding: Number.parseFloat(getComputedStyle(log).paddingLeft),
			details: panel.querySelector(".task-details").textContent,
		};
	});
	assert.equal(facts.label, facts.tab, "output label on the tab text's gutter");
	assert.equal(facts.log[0], facts.tab, "log box on the same gutter");
	assert.deepEqual(
		facts.command,
		facts.log,
		"log and command boxes share width",
	);
	assert.ok(facts.logPadding >= 10, "log text does not touch its border");
	assert.doesNotMatch(facts.details, ISO, "Started/Ended read as local times");
});
