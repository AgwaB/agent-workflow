// test-tier: integration
// The owner wants the same below-field menu for Executor, Model and Effort, not native OS popups.
import assert from "node:assert/strict";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";

const chrome = await findChrome();
async function setup(t, values = {}) {
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t);
	await profileAction(p.ctx, { op: "set", name: "picker-test", values });
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await browser.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=profiles`,
	});
	await browser.waitFor(
		() => !!document.querySelector('[data-profile-open="picker-test"]'),
	);
	await browser.click('[data-profile-open="picker-test"]');
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="save-profile"]'),
	);
	return { ...p, browser };
}
const field = (name) => `.profile-editor [aria-label="${name}"]`;
async function value(browser, label) {
	return browser.evaluate(
		(label) => document.querySelector(`[aria-label="${label}"]`).value,
		label,
	);
}
async function menu(browser, label) {
	return `#${await browser.evaluate((label) => document.querySelector(`[aria-label="${label}"]`).getAttribute("aria-controls"), label)}`;
}
async function pick(browser, label, selected) {
	await browser.click(field(label));
	await browser.click(
		`${await menu(browser, label)} [data-value="${selected}"]`,
	);
}
async function shown(browser, label) {
	return browser.evaluate(
		(label) =>
			document
				.querySelector(`[aria-label="${label}"]`)
				.getAttribute("aria-expanded") === "true",
		label,
	);
}

test("model pickers: one style, anchored below, pointer selection, keyboard and light-dismiss", {
	timeout: 90000,
}, async (t) => {
	const { browser } = await setup(t, {
		executor: "codex",
		model: "fixture-model",
		effort: "max",
	});
	const styles = await browser.evaluate(() =>
		["Executor", "Model", "Effort"].map((label) => {
			const node = document.querySelector(`[aria-label="${label}"]`);
			const style = getComputedStyle(node);
			return [
				node.getAttribute("role"),
				style.backgroundImage,
				style.paddingRight,
				style.height,
			];
		}),
	);
	assert.deepEqual(styles[0], styles[1]);
	assert.deepEqual(styles[1], styles[2]);
	assert.match(styles[0][1], /linear-gradient/);
	for (const label of ["Executor", "Model", "Effort"]) {
		await browser.click(field(label));
		const box = await browser.evaluate((label) => {
			const input = document.querySelector(`[aria-label="${label}"]`);
			const list = document.getElementById(input.getAttribute("aria-controls"));
			const a = input.getBoundingClientRect(),
				b = list.getBoundingClientRect();
			return {
				below: b.top - a.bottom,
				width: b.width - a.width,
				left: b.left - a.left,
				open: document.querySelectorAll(".picker-menu:not([hidden])").length,
			};
		}, label);
		assert.ok(
			box.below >= 5 && box.below <= 7,
			`${label}: ${JSON.stringify(box)}`,
		);
		assert.equal(box.width, 0);
		assert.equal(box.left, 0);
		assert.equal(box.open, 1);
		const padding = await browser.evaluate((label) => {
			const control = document.querySelector(`[aria-label="${label}"]`);
			const list = document.getElementById(
				control.getAttribute("aria-controls"),
			);
			const rect = list.getBoundingClientRect();
			window.pickerToggles = [];
			window.pickerObserver = new MutationObserver((entries) =>
				window.pickerToggles.push(...entries.map((entry) => entry.oldValue)),
			);
			window.pickerObserver.observe(control, {
				attributes: true,
				attributeOldValue: true,
				attributeFilter: ["aria-expanded"],
			});
			return { x: rect.left + 3, y: rect.top + 3 };
		}, label);
		await browser.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			...padding,
			button: "left",
			clickCount: 1,
		});
		await browser.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			...padding,
			button: "left",
			clickCount: 1,
		});
		assert.deepEqual(
			await browser.evaluate(() => {
				window.pickerObserver.disconnect();
				return window.pickerToggles;
			}),
			[],
			`${label}: menu padding does not close/reopen the list`,
		);
		assert.equal(await shown(browser, label), true);
		await browser.key("Escape");
		assert.equal(await shown(browser, label), false);
	}
	// A previously saved effort the selected model does not offer stays visible until changed.
	assert.equal(await value(browser, "Effort"), "max");
	assert.match(
		await browser.evaluate(
			() =>
				document.querySelector(
					'.profile-editor [role="option"][data-value="max"]',
				).textContent,
		),
		/not available here/,
	);
	await pick(browser, "Effort", "high");
	assert.equal(await value(browser, "Effort"), "high");
	assert.equal(await shown(browser, "Effort"), false);
	await browser.click(field("Effort"));
	await browser.key("ArrowDown");
	await browser.key("Escape");
	assert.equal(
		await value(browser, "Effort"),
		"high",
		"Escape does not commit the highlight",
	);
	await pick(browser, "Executor", "claude");
	await browser.click(field("Effort"));
	await browser.key("End");
	await browser.key("Enter");
	assert.equal(await value(browser, "Effort"), "max");
	assert.equal(await shown(browser, "Effort"), false);
	await browser.click(field("Executor"));
	await browser.key("Tab");
	assert.equal(await shown(browser, "Executor"), false);
	assert.equal(
		await browser.evaluate(() =>
			document.activeElement.getAttribute("aria-label"),
		),
		"Model",
	);
	await browser.click(field("Model"));
	await browser.click(".profile-editor h2");
	assert.equal(await shown(browser, "Model"), false);
	assert.equal(
		await browser.evaluate(() =>
			document
				.querySelector(".profile-editor")
				.textContent.includes("Same from the terminal"),
		),
		false,
	);
	assert.deepEqual(browser.errors, []);
});

test("model pickers: manual model IDs survive, suggestions commit once, and clearing uses executor defaults", {
	timeout: 90000,
}, async (t) => {
	const p = await setup(t, {
		executor: "codex",
		model: "saved/unknown-model",
		effort: "high",
	});
	assert.equal(await value(p.browser, "Model"), "saved/unknown-model");
	await p.browser.click(field("Model"));
	await p.browser.evaluate(() =>
		document.querySelector('[aria-label="Model"]').select(),
	);
	await p.browser.send("Input.insertText", { text: "custom/new-model" });
	assert.equal(await shown(p.browser, "Model"), true);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".picker-empty").textContent,
		),
		"No suggestions. You can type a model ID.",
	);
	await p.browser.click(".picker-empty");
	assert.equal(
		await p.browser.evaluate(() => !!document.querySelector(".picker-empty")),
		true,
		"clicking empty menu text must not clear filtering or reopen the menu",
	);
	await p.browser.key("Enter");
	assert.equal(await shown(p.browser, "Model"), false);
	assert.equal(await value(p.browser, "Model"), "custom/new-model");
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-save-status"),
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "picker-test" })).data
			.profile.model,
		"custom/new-model",
	);
	await p.browser.click('[data-profile-open="picker-test"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Model"]'),
	);
	// With an unknown current ID, Up starts at the last suggestion, not the reset option.
	await p.browser.click(field("Model"));
	await p.browser.key("ArrowUp");
	await p.browser.key("Enter");
	assert.equal(await value(p.browser, "Model"), "fixture-model");
	await pick(p.browser, "Model", "fixture-model");
	assert.equal(await value(p.browser, "Model"), "fixture-model");
	assert.equal(
		await shown(p.browser, "Model"),
		false,
		"committing does not reopen the suggestions",
	);
	await pick(p.browser, "Model", "");
	assert.equal(await value(p.browser, "Model"), "");
	assert.equal(await shown(p.browser, "Model"), false);
	assert.deepEqual(p.browser.errors, []);
});

test("model pickers: lower page and narrow viewports scroll the same downward list into view", {
	timeout: 90000,
}, async (t) => {
	const { browser } = await setup(t);
	for (const theme of ["dark", "light"]) {
		await browser.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: theme }],
		});
		await browser.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 420,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await browser.click(field("Effort"));
		const rects = await browser.evaluate(() => {
			const control = document.querySelector('[aria-label="Effort"]');
			const menu = document.getElementById(
				control.getAttribute("aria-controls"),
			);
			const a = control.getBoundingClientRect(),
				b = menu.getBoundingClientRect();
			return {
				below: b.top - a.bottom,
				bottom: b.bottom,
				top: a.top,
				screen: innerHeight,
				width: document.body.scrollWidth,
				height: menu.clientHeight,
				scroll: menu.scrollHeight,
			};
		});
		assert.ok(rects.below >= 5 && rects.below <= 7, JSON.stringify(rects));
		assert.ok(
			rects.bottom <= rects.screen && rects.top >= 48,
			JSON.stringify(rects),
		);
		assert.ok(
			rects.scroll > rects.height,
			"long lists scroll inside their surface",
		);
		assert.equal(rects.width, 390);
		await browser.key("End");
		const active = await browser.evaluate(() => {
			const control = document.querySelector('[aria-label="Effort"]');
			const node = document.getElementById(
				control.getAttribute("aria-activedescendant"),
			);
			const parent = node.parentElement.getBoundingClientRect(),
				rect = node.getBoundingClientRect();
			return {
				label: node.textContent,
				visible: rect.bottom <= parent.bottom && rect.top >= parent.top,
			};
		});
		assert.equal(active.label, "ultra");
		assert.equal(active.visible, true);
		await browser.key("Escape");
	}
	assert.deepEqual(browser.errors, []);
});
