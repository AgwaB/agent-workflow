// 2026-11-01 (owner choice): the dashboard follows the system colour scheme, and a top-bar button
// pins Light or Dark (kept in the browser) — Auto → Light → Dark → Auto. Light text stays readable.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();

const scheme = (browser, value) =>
	browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value }],
	});
const look = (browser) =>
	browser.evaluate(() => {
		const root = getComputedStyle(document.documentElement);
		const button = document.querySelector("#theme-button");
		return {
			background: getComputedStyle(document.documentElement).backgroundColor,
			pinned: document.documentElement.dataset.theme ?? null,
			button: button?.textContent,
			label: button?.getAttribute("aria-label"),
			focused: document.activeElement === button,
			tile: getComputedStyle(document.querySelector(".logo .logo-tile")).fill,
			text: root.getPropertyValue("--text").trim(),
		};
	});
const LIGHT = "rgb(246, 245, 241)";
const DARK = "rgb(20, 20, 20)";

test("theme: Auto follows the system; the button pins Light/Dark, persists, and keeps focus", {
	timeout: 60_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());

	await scheme(browser, "light");
	await browser.open(`${fixture.origin}/`);
	let now = await look(browser);
	assert.equal(now.background, LIGHT);
	assert.equal(now.pinned, null);
	assert.equal(now.button, "Auto");
	assert.equal(now.label, "Theme: Auto. Switch to Light");
	// The logo tile follows the theme too (no hard-coded light tile on a light page).
	assert.notEqual(now.tile, "rgb(238, 239, 242)");

	await scheme(browser, "dark");
	await browser.waitFor(
		() =>
			getComputedStyle(document.documentElement).backgroundColor ===
			"rgb(20, 20, 20)",
	);

	await browser.click("#theme-button");
	now = await look(browser);
	assert.deepEqual(
		[now.button, now.pinned, now.background, now.focused],
		["Light", "light", LIGHT, true],
		"pinned light wins over a dark system",
	);
	await browser.click("#theme-button");
	await scheme(browser, "light");
	now = await look(browser);
	assert.deepEqual(
		[now.button, now.pinned, now.background, now.focused],
		["Dark", "dark", DARK, true],
		"pinned dark wins over a light system",
	);
	// Kept across a reload.
	await browser.open(`${fixture.origin}/`);
	now = await look(browser);
	assert.deepEqual(
		[now.button, now.pinned, now.background],
		["Dark", "dark", DARK],
	);
	await browser.click("#theme-button");
	now = await look(browser);
	assert.deepEqual(
		[now.button, now.pinned, now.background],
		["Auto", null, LIGHT],
	);
	assert.equal(
		await browser.evaluate(() => localStorage.getItem("agent-workflow:theme")),
		null,
	);
});

test("theme: light text and meaning colours meet WCAG AA on light surfaces", {
	timeout: 60_000,
}, async (t) => {
	const fixture = await createFixtureServer();
	t.after(() => fixture.close());
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await scheme(browser, "light");
	await browser.open(`${fixture.origin}/`);
	const ratios = await browser.evaluate(() => {
		const probe = document.createElement("span");
		document.body.append(probe);
		const rgb = (variable) => {
			probe.style.color = `var(${variable})`;
			return getComputedStyle(probe)
				.color.match(/\d+(\.\d+)?/g)
				.slice(0, 3)
				.map(Number);
		};
		const lum = ([r, g, b]) => {
			const c = [r, g, b].map((v) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
		};
		const ratio = (a, b) => {
			const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
			return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
		};
		const out = {};
		for (const fg of [
			"--text",
			"--muted",
			"--faint",
			"--accent",
			"--warn",
			"--err",
		])
			for (const bg of ["--bg", "--panel", "--surface", "--selected"])
				out[`${fg} on ${bg}`] = ratio(fg, bg);
		// The amber tag: its text on its own tint over every surface.
		probe.style.color = "var(--warn-on-tint)";
		const tagText = getComputedStyle(probe)
			.color.match(/\d+(\.\d+)?/g)
			.slice(0, 3)
			.map(Number);
		probe.style.color = "var(--warn-tint)";
		const tint = getComputedStyle(probe)
			.color.match(/\d+(\.\d+)?/g)
			.map(Number);
		for (const bg of ["--bg", "--panel", "--surface"]) {
			const base = rgb(bg);
			const mixed = base.map((v, i) => v + (tint[i] - v) * (tint[3] ?? 1));
			const [x, y] = [lum(tagText), lum(mixed)].sort((p, q) => q - p);
			out[`incomplete tag on ${bg}`] =
				Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
		}
		probe.remove();
		return out;
	});
	for (const [pair, value] of Object.entries(ratios))
		assert.ok(value >= 4.5, `${pair}: ${value}`);
});
