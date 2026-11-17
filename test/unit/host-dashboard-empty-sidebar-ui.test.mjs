// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
const chrome = await findChrome();
async function setup(t, count = 1) {
	assert.ok(chrome, "native Chrome required");
	const base = JSON.parse(
		await readFile(
			new URL(
				"../fixtures/dashboard/run-workflow_mvt1jojn_3dd217.json",
				import.meta.url,
			),
		),
	);
	base.reportAvailable = false;
	base.tasks[0] = {
		...base.tasks[0],
		specId: "recheck-requirements.item",
		stageId: "recheck-requirements",
		kind: "foreach",
		placeholder: true,
		status: "completed",
		statusDetail: "foreach_empty",
		startedAt: null,
		usage: null,
	};
	const snapshots = Array.from({ length: count }, (_, i) => ({
		...structuredClone(base),
		runId: `empty_${i}`,
	}));
	const f = await createFixtureServer({ snapshots });
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	return { f, b };
}
async function open(f, b, query = "", width = 1440) {
	await b.open(`${f.origin}/?run=empty_0&view=runs&${query}`, width);
	await b.waitFor(
		() => !!document.querySelector('.node[data-stage="recheck-requirements"]'),
	);
}
test("empty foreach node and legacy placeholder links explain stage, not an executed agent", async (t) => {
	const { f, b } = await setup(t);
	await open(f, b);
	await b.click('.node[data-stage="recheck-requirements"]');
	await b.waitFor(() => !document.querySelector("#inspector").hidden);
	for (const legacy of [false, true]) {
		if (legacy) await open(f, b, "task=recheck-requirements.item");
		const text = await b.evaluate(
			() => document.querySelector("#inspector").textContent,
		);
		assert.match(text, /Recheck requirements/);
		assert.match(text, /No applicable items/);
		assert.match(text, /No agents ran/);
		assert.doesNotMatch(
			text,
			/unknown|No result files|Recorded model|Open agent|0 agents, 0 done/i,
		);
		assert.equal(
			await b.evaluate(
				() =>
					document.querySelectorAll(
						"#inspector [data-tab], #inspector .executor-line, #inspector .item-filters",
					).length,
			),
			0,
		);
	}
	for (const status of ["pending", "running", "failed", "blocked"]) {
		const r = f.runs.get("empty_0");
		r.tasks[0].status = status;
		r.tasks[0].statusDetail = status;
		r.tasks[0].lastMessage = ["failed", "blocked"].includes(status)
			? `Known ${status} cause: source input unavailable`
			: null;
		await open(f, b, "task=recheck-requirements.item");
		const text = await b.evaluate(
			() => document.querySelector("#inspector").textContent,
		);
		assert.doesNotMatch(text, /No applicable items|No agents ran/);
		assert.match(
			text,
			new RegExp(status === "pending" ? "Waiting|Pending" : status, "i"),
		);
		if (["failed", "blocked"].includes(status))
			assert.ok(text.includes(r.tasks[0].lastMessage));
	}
});
for (const width of [970, 1440])
	for (const count of [1, 35]) {
		test(`rail order/footer and native secondary actions ${width}px ${count} rows`, async (t) => {
			const { f, b } = await setup(t, count);
			await b.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await open(f, b, "", width);
			await b.waitFor(() => document.querySelectorAll(".run-row").length > 0);
			if (await b.evaluate(() => document.querySelector("#rail").inert))
				await b.click('[aria-label="Show runs"]');
			const result = await b.evaluate(() => {
				const rail = document.querySelector("#rail"),
					rows = [...rail.querySelectorAll(".run-row")],
					footer = rail.querySelector(".rail-footer"),
					actions = rail.querySelector(".run-actions");
				return {
					footer: !!footer,
					after:
						!!footer &&
						!!(
							rows.at(-1).compareDocumentPosition(footer) &
							Node.DOCUMENT_POSITION_FOLLOWING
						),
					closed: !!actions && !actions.open,
					overflow: document.documentElement.scrollWidth > innerWidth,
					bottom: footer?.getBoundingClientRect().bottom,
					railBottom: rail.getBoundingClientRect().bottom,
				};
			});
			assert.ok(result.footer && result.after && result.closed);
			assert.equal(result.overflow, false);
			if (count === 1)
				assert.ok(Math.abs(result.bottom - result.railBottom) < 25);
			if (await b.evaluate(() => document.querySelector("#rail").inert))
				await b.click('[aria-label="Show runs"]');
			await b.evaluate(() =>
				document.querySelector(".run-actions summary").focus(),
			);
			assert.equal(
				await b.evaluate(() =>
					document.activeElement.matches(".run-actions summary"),
				),
				true,
			);
			await b.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				text: "\r",
			});
			await b.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
			});
			await b.waitFor(() => document.querySelector(".run-actions").open);
			assert.equal(f.mutations.length, 0);
			await b.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Escape",
			});
			await b.waitFor(() => !document.querySelector(".run-actions").open);
			assert.equal(
				await b.evaluate(() =>
					document.activeElement.matches(".run-actions summary"),
				),
				true,
			);
			await b.evaluate(() => {
				const rail = document.querySelector("#rail");
				rail.scrollTop = rail.scrollHeight;
			});
			assert.ok(
				await b.evaluate(() => {
					const r = document.querySelector("#rail").getBoundingClientRect(),
						f = document.querySelector(".rail-footer").getBoundingClientRect();
					return f.bottom <= r.bottom && f.top >= r.top;
				}),
			);
			await b.click(".run-actions summary");
			await b.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Tab",
				code: "Tab",
				windowsVirtualKeyCode: 9,
			});
			await b.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Tab",
				code: "Tab",
				windowsVirtualKeyCode: 9,
			});
			assert.equal(
				await b.evaluate(() =>
					document.activeElement.matches('[data-testid="manage-run-deletion"]'),
				),
				true,
			);
			await b.click('[data-testid="manage-run-deletion"]');
			// The URL changes before the new document renders its rail.
			await b.waitFor(
				() =>
					new URLSearchParams(location.search).get("view") === "history" &&
					!!document.querySelector("#rail .rail-footer"),
			);
			assert.equal(f.mutations.length, 0);
			await b.evaluate(() => {
				const rail = document.querySelector("#rail");
				rail.scrollTop = rail.scrollHeight;
			});
			assert.ok(
				await b.evaluate(() => {
					const r = document.querySelector("#rail").getBoundingClientRect(),
						f = document.querySelector(".rail-footer").getBoundingClientRect();
					return f.bottom <= r.bottom && f.top >= r.top;
				}),
			);
		});
	}
