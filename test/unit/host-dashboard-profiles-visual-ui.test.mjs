// test-tier: integration
// Native history, feedback and layout checks for the retained minimal profile editor.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { profileAction } from "../../dist/hosts/catalog.js";
import {
	profilesFixture,
	loadProfiles,
	editProfile,
	setProfileField,
	saveProfile,
} from "../helpers/dashboard-profiles.mjs";
async function open(t) {
	const p = await profilesFixture(t);
	return { ...p, browser: p.b };
}
const set = setProfileField,
	edit = editProfile;
async function list(p) {
	await loadProfiles(p);
	await waitList(p.browser);
}
async function waitList(b) {
	await b.waitFor(
		() =>
			!!document.querySelector(".profile-overview:not([hidden])") &&
			!new URL(location.href).searchParams.has("profile") &&
			!new URL(location.href).searchParams.has("createProfile"),
	);
}
async function save(p) {
	await saveProfile(p.browser);
}

test("Profiles detail: Back/Cancel, browser Back/Forward, reload and direct links", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", permissionMode: "safe" },
	});
	await list(p);
	await edit(p.browser, "daily");
	assert.equal(
		await p.browser.evaluate(() =>
			new URL(location.href).searchParams.get("profile"),
		),
		"daily",
	);
	assert.match(
		await p.browser.evaluate(() => document.title),
		/Profiles \| daily/,
	);
	await set(p.browser, "Profile permission mode", "free");
	await p.browser.evaluate(() => {
		window.confirm = () => true;
	});
	await p.browser.click("[data-profile-back]");
	await waitList(p.browser);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "daily" })).data.profile
			.permissionMode,
		"safe",
	);
	assert.equal(
		await p.browser.evaluate(() => document.activeElement.dataset.profileOpen),
		"daily",
	);
	await p.browser.evaluate(() => history.forward());
	await p.browser.waitFor(
		() =>
			!!document.querySelector(
				'[data-profile-edit="daily"] [aria-label="Profile permission mode"]',
			),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Profile permission mode"]').value,
		),
		"safe",
	);
	await p.browser.send("Page.reload");
	await p.browser.waitFor(
		() =>
			!!document.querySelector(
				'[data-profile-edit="daily"] [aria-label="Profile permission mode"]',
			),
	);
	await p.browser.evaluate(() => history.back());
	await waitList(p.browser);
	const listIndex = (await p.browser.send("Page.getNavigationHistory"))
		.currentIndex;
	await edit(p.browser, "daily");
	await set(p.browser, "Profile permission mode", "free");
	await save(p);
	assert.equal(
		(await p.browser.send("Page.getNavigationHistory")).currentIndex,
		listIndex,
		"saving consumes the editor entry rather than creating a duplicate list",
	);
	await p.browser.evaluate(() => history.forward());
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Profile permission mode"]')
				?.value === "free",
	);
	await p.browser.evaluate(() => history.back());
	await waitList(p.browser);
	await p.browser.click("[data-profile-new]");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	assert.equal(
		await p.browser.evaluate(() =>
			new URL(location.href).searchParams.get("createProfile"),
		),
		"1",
	);
	await set(p.browser, "Profile name", "discarded");
	await p.browser.evaluate(() =>
		[...document.querySelectorAll(".profile-editor button")]
			.find((node) => node.textContent === "Discard changes")
			.click(),
	);
	await waitList(p.browser);
	assert.equal(
		await p.browser.evaluate(() =>
			document.activeElement.hasAttribute("data-profile-new"),
		),
		true,
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "list" })).data.profiles.length,
		1,
	);
	// A deep link has no dashboard-created history marker; its Back still has a safe list destination.
	await p.browser.send("Page.navigate", { url: `${p.url}&profile=daily` });
	await p.browser.waitFor(
		() =>
			!!document.querySelector(
				'[data-profile-edit="daily"] [data-profile-back]',
			),
	);
	await p.browser.click("[data-profile-back]");
	await waitList(p.browser);
	await p.browser.send("Page.navigate", { url: `${p.url}&profile=missing` });
	await p.browser.waitFor(
		() =>
			document.querySelector(".profiles-page [role=alert]")?.textContent ===
			"Profile not found.",
	);
	await p.browser.click('[aria-label="Back to profiles"]');
	await waitList(p.browser);
	assert.deepEqual(p.browser.errors, []);
	assert.equal(existsSync(p.effects), false);
});

test("D profile Save failure: narrow server feedback is visible and preserves the draft", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await list(p);
	await p.browser.click("[data-profile-new]");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	await set(p.browser, "Profile name", "bad/name");
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(() =>
		[...document.querySelectorAll('.profile-editor [role="alert"]')].some(
			(n) => n.checkVisibility() && n.textContent,
		),
	);
	const feedback = await p.browser.evaluate(() => {
		const error = [
			...document.querySelectorAll('.profile-editor [role="alert"]'),
		].find((n) => n.checkVisibility() && n.textContent);
		const r = error.getBoundingClientRect();
		return {
			visible: r.top >= 0 && r.bottom <= innerHeight,
			text: error.textContent,
			value: document.querySelector('[aria-label="Profile name"]').value,
			overflow: document.documentElement.scrollWidth > innerWidth,
		};
	});
	assert.equal(feedback.value, "bad/name");
	assert.ok(feedback.text.length);
	assert.equal(feedback.visible, true, JSON.stringify(feedback));
	assert.equal(feedback.overflow, false);
	assert.equal(
		await p.browser.evaluate(
			() =>
				!document.querySelector('[data-management-action="save-profile"]')
					.disabled,
		),
		true,
	);
	await p.browser.evaluate(() => {
		window.fetch = async () =>
			new Response(
				JSON.stringify({
					error: "Long server failure: " + "unbroken-detail".repeat(200),
				}),
				{ status: 500 },
			);
	});
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('.profile-editor [role="alert"]:not([hidden])')
			?.textContent.startsWith("Long server failure"),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => {
			const feedback = document.querySelector(".profile-save-feedback"),
				r = feedback.getBoundingClientRect();
			const controls = [
				...document.querySelectorAll(".profile-editor-actions-sticky > button"),
			];
			return {
				visible: r.top >= 0 && r.bottom <= innerHeight,
				scrollable: feedback.scrollHeight > feedback.clientHeight,
				overflow: document.documentElement.scrollWidth > innerWidth,
				covered: controls.some((n) => {
					const b = n.getBoundingClientRect();
					return !n.contains(
						document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
					);
				}),
				value: document.querySelector('[aria-label="Profile name"]').value,
			};
		}),
		{
			visible: true,
			scrollable: true,
			overflow: false,
			covered: false,
			value: "bad/name",
		},
	);
	assert.deepEqual(
		p.browser.errors.filter(
			(e) =>
				!(
					e.source === "network" &&
					e.url.endsWith("/api/profiles/bad%2Fname") &&
					e.text.includes("400")
				),
		),
		[],
	);
});

test("Profiles minimal editor keeps Save/Discard and retained fields reachable at narrow and wide widths", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { permissionMode: "safe", strictCapabilities: ["readOnly"] },
	});
	for (const width of [390, 1600]) {
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await list(p);
		await edit(p.browser, "daily");
		const result = await p.browser.evaluate(() => {
			const fields = [
				...document.querySelectorAll(
					".profile-editor input,.profile-editor select",
				),
			].filter((n) => n.checkVisibility());
			const buttons = [
				...document.querySelectorAll(".profile-editor-actions-sticky > button"),
			];
			const controls = [...fields, ...buttons];
			return {
				labels: fields.map((n) => n.getAttribute("aria-label")),
				overflow: document.documentElement.scrollWidth > innerWidth,
				missing: controls
					.filter((n) => {
						const r = n.getBoundingClientRect();
						return (
							r.top < 0 ||
							r.bottom > innerHeight ||
							!n.contains(
								document.elementFromPoint(
									r.x + r.width / 2,
									r.y + r.height / 2,
								),
							)
						);
					})
					.map((n) => n.textContent || n.getAttribute("aria-label")),
				removed: document.querySelectorAll(
					".profile-editor .graph,.profile-preferences,[data-profile-configure]",
				).length,
			};
		});
		assert.deepEqual(
			result,
			{
				labels: [
					"Profile permission mode",
					"Strict capabilities (comma separated)",
				],
				overflow: false,
				missing: [],
				removed: 0,
			},
			String(width),
		);
	}
	assert.deepEqual(p.browser.errors, []);
});
