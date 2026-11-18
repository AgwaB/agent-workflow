// test-tier: integration
// Executors has no drafts; retain unrelated workflow-load and browser lifecycle coverage.
import assert from "node:assert/strict";
import test from "node:test";
import {
	executorsFixture,
	loadExecutors,
} from "../helpers/dashboard-profiles.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
const opts = { timeout: 60000 };

for (const noNavigation of [false, true]) {
	test(
		`Executors observation never installs a dirty departure guard (Navigation API absent: ${noNavigation})`,
		opts,
		async (t) => {
			const p = await executorsFixture(t),
				{ b } = p;
			if (noNavigation)
				await b.send("Page.addScriptToEvaluateOnNewDocument", {
					source:
						'Object.defineProperty(window, "navigation", { value: undefined });',
				});
			await loadExecutors(p);
			await b.evaluate(() => {
				sessionStorage.setItem("executorGuardCalls", "0");
				window.confirm = () => {
					sessionStorage.setItem(
						"executorGuardCalls",
						String(Number(sessionStorage.getItem("executorGuardCalls")) + 1),
					);
					return false;
				};
			});
			assert.equal(
				await b.evaluate(
					() =>
						!window.dispatchEvent(
							new Event("beforeunload", { cancelable: true }),
						),
				),
				false,
			);
			await b.click('[data-management-action="doctor-refresh"]');
			await b.waitFor(
				() =>
					!document.querySelector('[data-management-action="doctor-refresh"]')
						.disabled,
			);
			assert.equal(
				await b.evaluate(() =>
					Number(sessionStorage.getItem("executorGuardCalls")),
				),
				0,
			);
			await b.click('.management-nav a[href*="view=workflows"]');
			await b.waitFor(
				() => document.querySelector("h1")?.textContent === "Workflows",
			);
			assert.equal(
				await b.evaluate(() =>
					Number(sessionStorage.getItem("executorGuardCalls")),
				),
				0,
			);
			assert.deepEqual(b.errors, []);
		},
	);
}

test(
	"workflow page opening has no Check form and registers no settings draft",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await profileGraphFixtures(p.cwd);
		await p.b.send("Page.navigate", {
			url:
				p.url.replace("view=executors", "view=workflows") +
				"&workflow=model-flow",
		});
		await p.b.waitFor(
			() => !!document.querySelector(".project-workflow-actions"),
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll(
						'[data-management-action="check"], [aria-label="Check profile"]',
					).length,
			),
			0,
		);
		assert.equal(
			await p.b.evaluate(
				() =>
					!window.dispatchEvent(
						new Event("beforeunload", { cancelable: true }),
					),
			),
			false,
		);
	},
);

test("settings drafts: pending nextEvent settles on browser close", {
	timeout: 15000,
}, async () => {
	const b = await createBrowser(await findChrome());
	const pending = b.nextEvent("Never.emitted", 10000).then(
		() => "resolved",
		() => "rejected",
	);
	await b.close();
	assert.equal(await pending, "rejected");
	await assert.rejects(b.nextEvent("After.close"), /Browser closed/);
});
