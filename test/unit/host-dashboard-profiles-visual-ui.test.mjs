// test-tier: integration
// Real Chrome and isolated profile storage. No model calls or real user settings.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { profileAction } from "../../dist/hosts/catalog.js";
import { executorPreset } from "../../dist/core/executor-presets.js";
import { overlayExecutorProfile } from "../../dist/core/executor-policy.js";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { scanMarks } from "../helpers/dashboard-marks.mjs";

const chrome = await findChrome();
async function open(t) {
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const url = `${p.origin}/?project=${p.server.projectId}&view=profiles`;
	return { ...p, browser, url };
}
async function list(p) {
	await p.browser.send("Page.navigate", { url: p.url });
	await waitList(p.browser);
}
async function waitList(browser) {
	await browser.waitFor(() => {
		const overview = document.querySelector(".profile-overview");
		return (
			overview &&
			!overview.hidden &&
			!new URL(location.href).searchParams.has("profile") &&
			!new URL(location.href).searchParams.has("createProfile")
		);
	});
}
async function edit(browser, name) {
	await browser.click(`[data-profile-open="${name}"]`);
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="save-profile"]'),
	);
}
async function set(browser, label, value) {
	await browser.evaluate(
		(label, value) => {
			const field = document.querySelector(`[aria-label="${label}"]`);
			if (!field) throw new Error(`Missing field: ${label}`);
			field.value = value;
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
async function select(browser, key) {
	await browser.click(`[data-role-card="${key}"]`);
	await browser.waitFor(() => !!document.querySelector(".role-inspector h3"));
}
async function save(p) {
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-save-status"),
	);
	return (await profileAction(p.ctx, { op: "show", name: "daily" })).data
		.profile;
}

test("Profiles detail: Back/Cancel, browser Back/Forward, reload and direct links", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", effort: "low" },
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
	await set(p.browser, "Effort", "high");
	await p.browser.click("[data-profile-back]");
	await waitList(p.browser);
	assert.equal(
		(await profileAction(p.ctx, { op: "show", name: "daily" })).data.profile
			.effort,
		"low",
	);
	assert.equal(
		await p.browser.evaluate(() => document.activeElement.dataset.profileOpen),
		"daily",
	);
	await p.browser.evaluate(() => history.forward());
	await p.browser.waitFor(
		() =>
			!!document.querySelector(
				'[data-profile-edit="daily"] [aria-label="Effort"]',
			),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="Effort"]').value,
		),
		"low",
	);
	await p.browser.send("Page.reload");
	await p.browser.waitFor(
		() =>
			!!document.querySelector(
				'[data-profile-edit="daily"] [aria-label="Effort"]',
			),
	);
	await p.browser.evaluate(() => history.back());
	await waitList(p.browser);
	const listIndex = (await p.browser.send("Page.getNavigationHistory"))
		.currentIndex;
	await edit(p.browser, "daily");
	await set(p.browser, "Effort", "high");
	await save(p);
	assert.equal(
		(await p.browser.send("Page.getNavigationHistory")).currentIndex,
		listIndex,
		"saving consumes the editor entry rather than creating a duplicate list",
	);
	await p.browser.evaluate(() => history.forward());
	await p.browser.waitFor(
		() => document.querySelector('[aria-label="Effort"]')?.value === "high",
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
			.find((node) => node.textContent === "Cancel")
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

test("Profiles visual map: selecting is inert, role/agent changes stay local, reset and narrow keyboard editing", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	const original = {
		executor: "codex",
		model: "fixture-model",
		effort: "low",
		permissionMode: "safe",
		strictCapabilities: ["readOnly"],
		roles: {
			verification: { executor: "claude", model: "sonnet", effort: "high" },
			"agent:reader": { model: "custom/model-id", effort: "max" },
		},
	};
	await profileAction(p.ctx, { op: "set", name: "daily", values: original });
	await list(p);
	await edit(p.browser, "daily");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			cards: [
				...document.querySelectorAll(".profile-editor [data-role-card]"),
			].map((node) => node.dataset.roleCard),
			common: document.querySelector('.profile-common [aria-label="Model"]')
				.value,
			verification: [
				...document.querySelectorAll(
					'[data-role-card="verification"] .role-fact-value > span',
				),
			].map((node) => node.textContent),
			arrows: document.querySelectorAll(
				".visual-role-editor .edge, .visual-role-editor marker",
			).length,
			factsStacked: [...document.querySelectorAll(".role-facts")].every(
				(node) =>
					getComputedStyle(node).gridTemplateColumns.split(/\s+/).length === 1,
			),
			barePanelText: [...document.querySelector(".role-inspector").childNodes]
				.filter((node) => node.nodeType === Node.TEXT_NODE)
				.map((node) => node.textContent.trim())
				.filter(Boolean),
		})),
		{
			cards: [
				"default",
				"planning",
				"research-execution",
				"synthesis",
				"verification",
				"final-judgment",
				"agent:reader",
			],
			common: "fixture-model",
			verification: ["claude", "sonnet", "high"],
			arrows: 0,
			factsStacked: true,
			barePanelText: [],
		},
	);
	await select(p.browser, "planning");
	await select(p.browser, "synthesis");
	let after = await save(p);
	assert.deepEqual(
		after.roles,
		original.roles,
		"selecting unconfigured cards must not write empty/explicit role entries",
	);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await set(p.browser, "Role verification Model", "manual/new-model");
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-role-card="verification"]').textContent,
		),
		/manual\/new-model/,
	);
	after = await save(p);
	assert.equal(after.roles.verification.model, "manual/new-model");
	assert.deepEqual(after.roles["agent:reader"], original.roles["agent:reader"]);
	assert.equal(after.permissionMode, "safe");
	assert.deepEqual(after.strictCapabilities, ["readOnly"]);
	assert.equal(after.model, "fixture-model");
	await edit(p.browser, "daily");
	await select(p.browser, "agent:reader");
	await set(p.browser, "Agent name", "reviewer");
	await set(p.browser, "Role agent:reader Effort", "high");
	after = await save(p);
	assert.equal(
		after.roles["agent:reader"],
		undefined,
		"renamed key is explicitly unset",
	);
	assert.deepEqual(after.roles["agent:reviewer"], {
		model: "custom/model-id",
		effort: "high",
	});
	await edit(p.browser, "daily");
	await p.browser.evaluate(() =>
		[...document.querySelectorAll(".visual-role-editor button")]
			.find((node) => node.textContent === "Add agent override")
			.click(),
	);
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Agent name"]'),
	);
	await set(p.browser, "Agent name", "reviewer");
	await set(p.browser, "Role new Model", "new-agent/model");
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(
		() =>
			document.querySelector('.profile-editor [role="alert"]')?.textContent ===
			"Each agent can have only one override.",
	);
	assert.deepEqual(
		(await profileAction(p.ctx, { op: "show", name: "daily" })).data.profile
			.roles["agent:reviewer"],
		{ model: "custom/model-id", effort: "high" },
	);
	await set(p.browser, "Agent name", "writer");
	after = await save(p);
	assert.deepEqual(after.roles["agent:writer"], { model: "new-agent/model" });
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await p.browser.click("[data-role-reset]");
	after = await save(p);
	assert.equal(after.roles.verification, undefined);
	assert.deepEqual(after.roles["agent:reviewer"], {
		model: "custom/model-id",
		effort: "high",
	});
	await edit(p.browser, "daily");
	// Hold A's real model response while B finishes, then release A: stale selection must not win.
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith("/api/executors/models")) {
				window.fetch = original;
				await new Promise((resolve) => {
					window.releaseRoleModels = resolve;
				});
				const response = await original(...args);
				await response.clone().json();
				window.roleModelsCompleted = true;
				return response;
			}
			return original(...args);
		};
	});
	await p.browser.click('[data-role-card="planning"]');
	await p.browser.waitFor(() => !!window.releaseRoleModels);
	await select(p.browser, "verification");
	await p.browser.evaluate(() => window.releaseRoleModels());
	await p.browser.waitFor(() => window.roleModelsCompleted);
	await p.browser.evaluate(async () => {
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		);
	});
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector h3")?.textContent,
		),
		"Verification",
	);
	// A recoverable catalog failure must be an error+Retry, not an endless Loading status.
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith("/api/executors/models")) {
				window.fetch = original;
				throw new Error("fixture model catalog failure");
			}
			return original(...args);
		};
	});
	await p.browser.click('[data-role-card="synthesis"]');
	await p.browser.waitFor(
		() =>
			document.querySelector('.role-inspector [role="alert"]')?.textContent ===
			"fixture model catalog failure",
	);
	assert.equal(
		await p.browser.evaluate(
			() => !!document.querySelector('.role-inspector [role="status"]'),
		),
		false,
	);
	await p.browser.click("[data-role-retry]");
	await p.browser.waitFor(
		() =>
			document.querySelector(".role-inspector h3")?.textContent === "Synthesis",
	);
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: false,
	});
	for (const theme of ["light", "dark"]) {
		await p.browser.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: theme }],
		});
		await p.browser.evaluate(() =>
			document.querySelector('[data-role-card="verification"]').focus(),
		);
		// A native button activates on Enter's keypress. Unlike picker keydown handlers,
		// CDP needs the carriage-return text to generate that native activation.
		await p.browser.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			text: "\r",
			unmodifiedText: "\r",
		});
		await p.browser.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		try {
			await p.browser.waitFor(
				() =>
					document.activeElement ===
					document.querySelector(".role-inspector h3"),
			);
		} catch (error) {
			assert.fail(
				`${theme} keyboard: ${JSON.stringify(await p.browser.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 500), panel: document.querySelector(".role-inspector")?.textContent.slice(0, 700), selected: document.querySelector('[data-role-card][aria-pressed="true"]')?.dataset.roleCard })))}`,
			);
		}
		await p.browser.key("Tab");
		assert.equal(
			await p.browser.evaluate(() =>
				document.activeElement.getAttribute("aria-label"),
			),
			"Role verification Executor",
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelector(".management-page").scrollWidth <=
					document.querySelector("#center").clientWidth,
			),
			true,
		);
		assert.equal(
			await p.browser.evaluate(() => {
				const box = document
					.querySelector(".role-inspector")
					.getBoundingClientRect();
				return box.top < innerHeight && box.bottom > 0;
			}),
			true,
		);
		assert.deepEqual(await scanMarks(p.browser), []);
	}
	assert.deepEqual(p.browser.errors, []);
	assert.equal(existsSync(p.effects), false);
});

test("Profile role hints match the core executor-default overlay without inventing final workflow values", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await list(p);
	const baseline = executorPreset("codex").roles;
	const cases = [
		{ key: "planning", roles: {}, common: {} },
		{
			key: "planning",
			roles: { default: { effort: "high" } },
			common: { effort: "low" },
		},
		{
			key: "default",
			roles: { default: { effort: "high" } },
			common: { effort: "low" },
		},
		{
			key: "verification",
			roles: {
				verification: {
					executor: "claude",
					model: "foreign-model",
					effort: "off",
				},
			},
			common: { model: "my-model", effort: "max" },
		},
		{
			key: "synthesis",
			roles: { synthesis: { executor: "codex", model: "my-role" } },
			common: { executor: "claude", model: "not-for-codex", effort: "low" },
		},
		{
			key: "agent:reader",
			roles: { "agent:reader": { model: "agent-model" } },
			common: { model: "flat-model", effort: "low" },
		},
	];
	const actual = await p.browser.evaluate(
		async (cases, baseline) => {
			const { profileRolePreview } = await import("./app.js");
			return cases.map((entry) =>
				profileRolePreview(entry.key, entry.roles, {
					executor: "codex",
					baseline,
					common: entry.common,
				}),
			);
		},
		cases,
		baseline,
	);
	for (let i = 0; i < cases.length; i++) {
		const entry = cases[i];
		const expected = overlayExecutorProfile("codex", baseline, {
			...entry.common,
			roles: entry.roles,
		});
		assert.deepEqual(
			actual[i].values,
			{ executor: "codex", ...(expected[entry.key] || {}) },
			`case ${i}`,
		);
	}
	assert.equal(actual[3].ignored, true);
	assert.equal(
		actual[1].values.effort,
		"low",
		"roles.default must not replace a specific built-in role's flat overlay",
	);
	const unresolved = await p.browser.evaluate(async () => {
		const { profileRolePreview } = await import("./app.js");
		return [
			profileRolePreview(
				"verification",
				{ verification: { effort: "high" } },
				{
					common: { executor: "codex", model: "not-final" },
					presetRoles: {
						verification: { executor: "claude", model: "replaced-as-a-whole" },
					},
				},
			),
			profileRolePreview("planning", {}, { executor: "pi", common: {} }),
		];
	});
	assert.deepEqual(unresolved[0].values, { effort: "high" });
	assert.deepEqual(unresolved[1].values, { executor: "pi" });
	// Exercise the real executor-default editor too, not only the pure hint helper.
	await edit(p.browser, "codex");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-role-card="planning"] [data-role-field="model"]',
				).dataset.origin,
		),
		"Built-in",
	);
	await set(p.browser, "Effort", "low");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-role-card="planning"] [data-role-field="effort"]',
				).dataset.origin,
		),
		"Common setting",
	);
	await select(p.browser, "verification");
	await set(p.browser, "Role verification Executor", "claude");
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-role-card="verification"] .role-warning')
					?.textContent,
		),
		/Not used by codex defaults/,
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[
				...document.querySelectorAll(
					'[data-role-card="verification"] .role-fact-value > span',
				),
			].map((node) => node.textContent),
		),
		["codex", "gpt-5.6-luna", "low"],
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-role-card="planning"] [data-role-field="model"] small',
				).textContent,
		),
		"Built-in",
		"field origins are visible, not tooltip-only",
	);
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-save-status"),
	);
	const defaults = (
		await profileAction(p.ctx, { op: "list" })
	).data.executorDefaults.find((entry) => entry.executor === "codex");
	assert.deepEqual(defaults.roles.verification, {
		executor: "codex",
		model: "gpt-5.6-luna",
		effort: "low",
	});
	assert.deepEqual(p.browser.errors, []);
});
