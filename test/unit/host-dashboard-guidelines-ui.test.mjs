// test-tier: integration
// Retained geometry and skip-link behavior on the executor permission editor.
import assert from "node:assert/strict";
import test from "node:test";
import {
	executorsFixture,
	loadExecutors,
	setPermission,
} from "../helpers/dashboard-profiles.mjs";
async function open(t) {
	const p = await executorsFixture(t);
	await loadExecutors(p);
	return { ...p, browser: p.b };
}
test("G3: narrow and coarse executor controls retain usable geometry and desktop density", {
	timeout: 120000,
}, async (t) => {
	const p = await executorsFixture(t),
		{ b } = p;
	await loadExecutors(p);
	for (const [width, coarse] of [
		[390, false],
		[390, true],
		[1280, true],
		[1280, false],
		[1600, false],
	]) {
		await b.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await b.send("Emulation.setTouchEmulationEnabled", {
			enabled: coarse,
			maxTouchPoints: 1,
		});
		const sizes = await b.evaluate(() => ({
			coarse: matchMedia("(pointer: coarse)").matches,
			font: parseFloat(
				getComputedStyle(
					document.querySelector('[aria-label="codex permission mode"]'),
				).fontSize,
			),
			buttons: [
				...document.querySelectorAll(
					".executor-permission-actions button, .top button, .management-nav a, .executor-permissions summary",
				),
			]
				.filter((n) => n.checkVisibility())
				.map((n) => {
					const r = n.getBoundingClientRect();
					return { name: n.textContent, size: [r.width, r.height] };
				}),
			overflow: document.documentElement.scrollWidth > innerWidth,
		}));
		assert.equal(sizes.coarse, coarse);
		const touchSized = width <= 800 || coarse;
		assert.equal(sizes.font, touchSized ? 16 : 14);
		assert.equal(sizes.overflow, false);
		if (touchSized)
			for (const control of sizes.buttons)
				assert.ok(
					control.size.every((size) => size >= 44),
					JSON.stringify(control),
				);
		else assert.equal(sizes.buttons.find((n) => n.name === "Save").size[1], 32);
	}
	assert.deepEqual(b.errors, []);
});

test("G5: first Tab exposes skip link, activation focuses main without navigation or draft reset", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	const b = p.browser;
	await setPermission(b, "safe");
	await b.evaluate(() => {
		document.activeElement?.blur();
		window.skipDocument = document;
	});
	// Reset the sequential keyboard starting point to the document's beginning.
	await b.evaluate(() => {
		const start = document.createElement("span");
		start.tabIndex = -1;
		document.body.prepend(start);
		start.focus();
		start.remove();
	});
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
	const before = await b.evaluate(() => ({
		href: location.href,
		length: history.length,
		first: document.activeElement.textContent,
		visible: document.activeElement.getBoundingClientRect().top >= 0,
	}));
	assert.equal(before.first, "Skip to content");
	assert.equal(before.visible, true);
	await b.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
	});
	assert.deepEqual(
		await b.evaluate(() => ({
			href: location.href,
			length: history.length,
			focus: document.activeElement.id,
			draft: document.querySelector('[aria-label="codex permission mode"]')
				.value,
			same: document === window.skipDocument,
			tabIndex: document.querySelector("main").tabIndex,
		})),
		{
			href: before.href,
			length: before.length,
			focus: "center",
			draft: "safe",
			same: true,
			tabIndex: -1,
		},
	);
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
		await b.evaluate(() => !!document.activeElement.closest("main")),
		true,
	);
});
