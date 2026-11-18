// test-tier: integration
// Isolated browser fixtures only: no real executors, workflows or profile writes.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();

test("F3 static management omits the live indicator in both access modes", {
	timeout: 120_000,
}, async (t) => {
	assert.ok(chrome, "Chrome is required for F3 connection validation");
	for (const readonly of [false, true]) {
		const p = await managementProject(t, { readonly });
		const browser = await createBrowser(chrome);
		t.after(() => browser.close());
		for (const view of ["workflows", "profiles", "executors"]) {
			await t.test(`${view}, readonly=${readonly}`, async () => {
				await browser.send("Page.navigate", {
					url: `${p.origin}/?project=${p.server.projectId}&view=${view}`,
				});
				await browser.waitFor(
					() =>
						document.readyState === "complete" &&
						!!document.querySelector(".management-page"),
				);
				assert.deepEqual(
					await browser.evaluate(() => ({
						// In-app navigation keeps the node and hides it on static views.
						indicators: [
							...document.querySelectorAll("#connection, .connection"),
						].filter((n) => n.checkVisibility() && !n.closest("[hidden]"))
							.length,
						readonly: !!document.querySelector("#readonly-badge"),
					})),
					{ indicators: 0, readonly },
				);
			});
		}
	}
});

test("F3 live Overview, Run, report and All projects retain their indicator", {
	timeout: 60_000,
}, async (t) => {
	assert.ok(chrome, "Chrome is required for F3 connection validation");
	const fixture = await createFixtureServer({ readonly: true });
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	for (const [view, query] of [
		["Overview", "project=payments-api-123456789abc"],
		["Run", "run=workflow_mvt9k2qa_7c41e0"],
		["report", "run=workflow_mvt23704_e8e6d7&view=report"],
		["All projects", ""],
	]) {
		await t.test(view, async () => {
			await browser.open(`${fixture.origin}/?${query}`);
			await browser.waitFor(() =>
				document.querySelector("#connection")?.textContent.includes("Live"),
			);
			assert.deepEqual(
				await browser.evaluate(() => ({
					indicators: document.querySelectorAll("#connection").length,
					role: document.querySelector("#connection").getAttribute("role"),
					readonly: !!document.querySelector("#readonly-badge"),
				})),
				{ indicators: 1, role: "status", readonly: true },
			);
			if (view === "report")
				assert.ok(
					await browser.evaluate(
						() => !!document.querySelector(".report-view"),
					),
				);
		});
	}
});
