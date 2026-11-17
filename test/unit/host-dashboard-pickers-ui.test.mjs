// test-tier: integration
// Shared selection menus remain covered on the project Workflow editor, not removed Profile model controls.
import assert from "node:assert/strict";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";

async function setup(t) {
	const chrome = await findChrome();
	assert.ok(chrome);
	const p = await managementProject(t);
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await b.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=workflows&workflow=manage`,
	});
	await b.waitFor(
		() => !!document.querySelector('[aria-label="All tasks Effort"]'),
	);
	return { ...p, b };
}
const control = (name) => `[aria-label="All tasks ${name}"]`;
const expanded = (b, name) =>
	b.evaluate(
		(name) =>
			document
				.querySelector(`[aria-label="All tasks ${name}"]`)
				.getAttribute("aria-expanded") === "true",
		name,
	);
async function choose(b, name, value) {
	await b.click(control(name));
	const id = await b.evaluate(
		(name) =>
			document
				.querySelector(`[aria-label="All tasks ${name}"]`)
				.getAttribute("aria-controls"),
		name,
	);
	await b.click(`#${id} [data-value="${value}"]`);
}
test("Shared Workflow pickers: anchored menus, native pointer selection, keyboard and light-dismiss", {
	timeout: 90000,
}, async (t) => {
	const { b } = await setup(t);
	await choose(b, "Executor", "codex");
	const styles = await b.evaluate(() =>
		["Executor", "Effort"].map((name) => {
			const n = document.querySelector(`[aria-label="All tasks ${name}"]`),
				s = getComputedStyle(n);
			return [
				n.getAttribute("role"),
				s.backgroundImage,
				s.height,
				s.paddingRight,
			];
		}),
	);
	assert.deepEqual(styles[0], styles[1]);
	assert.match(styles[0][1], /linear-gradient/);
	for (const name of ["Executor", "Effort"]) {
		await b.click(control(name));
		// M1 scales from the anchor: assert resting geometry, not an in-flight frame.
		await b.waitForMotionEnd();
		assert.deepEqual(
			await b.evaluate((name) => {
				const n = document.querySelector(`[aria-label="All tasks ${name}"]`),
					menu = document.getElementById(n.getAttribute("aria-controls")),
					a = n.getBoundingClientRect(),
					r = menu.getBoundingClientRect();
				return {
					below: r.top - a.bottom,
					width: r.width - a.width,
					left: r.left - a.left,
					open: document.querySelectorAll(".picker-menu:not([hidden])").length,
				};
			}, name),
			{ below: 6, width: 0, left: 0, open: 1 },
		);
		await b.key("Escape");
		assert.equal(await expanded(b, name), false);
	}
	await choose(b, "Executor", "codex");
	await choose(b, "Effort", "high");
	assert.equal(
		await b.evaluate(
			() => document.querySelector('[aria-label="All tasks Effort"]').value,
		),
		"high",
	);
	await b.click(control("Effort"));
	await b.key("ArrowDown");
	await b.key("Escape");
	assert.equal(
		await b.evaluate(
			() => document.querySelector('[aria-label="All tasks Effort"]').value,
		),
		"high",
	);
	await b.click(control("Executor"));
	await b.key("Tab");
	assert.equal(await expanded(b, "Executor"), false);
	await b.click(control("Effort"));
	await b.click(".project-common h2");
	assert.equal(await expanded(b, "Effort"), false);
	assert.equal(
		await b.evaluate(
			() => document.querySelector('[aria-label="All tasks Model"]').tagName,
		),
		"SELECT",
	);
	assert.deepEqual(b.errors, []);
});
test("Shared Workflow picker: long downward menus stay scrollable and keyboard options visible on narrow screens", {
	timeout: 90000,
}, async (t) => {
	const { b } = await setup(t);
	await choose(b, "Executor", "codex");
	for (const theme of ["dark", "light"]) {
		await b.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: theme }],
		});
		await b.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 420,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await b.evaluate(() =>
			document
				.querySelector('[aria-label="All tasks Effort"]')
				.scrollIntoView({ block: "center", behavior: "instant" }),
		);
		await b.click(control("Effort"));
		await b.waitForMotionEnd();
		await b.waitFor(
			() =>
				document
					.querySelector('[aria-label="All tasks Effort"]')
					.getAttribute("aria-expanded") === "true",
		);
		const r = await b.evaluate(() => {
			const n = document.querySelector('[aria-label="All tasks Effort"]'),
				m = document.getElementById(n.getAttribute("aria-controls")),
				a = n.getBoundingClientRect(),
				r = m.getBoundingClientRect();
			return {
				below: r.top - a.bottom,
				bottom: r.bottom,
				screen: innerHeight,
				width: document.body.scrollWidth,
				height: m.clientHeight,
				scroll: m.scrollHeight,
				inline: m.hasAttribute("style"),
			};
		});
		assert.equal(r.below, 6);
		assert.ok(r.bottom <= r.screen, JSON.stringify(r));
		assert.ok(r.scroll > r.height);
		assert.equal(r.width, 390);
		assert.equal(r.inline, false);
		await b.key("End");
		assert.deepEqual(
			await b.evaluate(() => {
				const n = document.querySelector('[aria-label="All tasks Effort"]'),
					a = document.getElementById(n.getAttribute("aria-activedescendant")),
					r = a.getBoundingClientRect(),
					m = a.parentElement.getBoundingClientRect();
				return {
					label: a.textContent,
					visible: r.bottom <= m.bottom && r.top >= m.top,
				};
			}),
			{ label: "ultra", visible: true },
		);
		await b.key("Escape");
	}
	assert.deepEqual(b.errors, []);
});
