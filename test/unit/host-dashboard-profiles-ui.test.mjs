// test-tier: integration
// Profiles are a short list and one focused editor. Real Chrome/routes; isolated user home, no model calls.
import assert from "node:assert/strict";
import test from "node:test";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { scanMarks } from "../helpers/dashboard-marks.mjs";
import {
	profileAction,
	workflowPreferenceAction,
} from "../../dist/hosts/catalog.js";

const chrome = await findChrome();
async function open(t, options = {}) {
	assert.ok(chrome, "Chrome is required");
	const project = await managementProject(t, options);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	return {
		...project,
		browser,
		url: `${project.origin}/?project=${project.server.projectId}&view=profiles`,
	};
}
async function load(browser, url) {
	await browser.send("Page.navigate", { url });
	await browser.waitFor(
		() =>
			!!document.querySelector(
				'.profile-preferences [aria-label="Workflow to configure"]',
			),
	);
}
async function set(browser, label, value) {
	await browser.evaluate(
		(label, value) => {
			const field = document.querySelector(`[aria-label="${label}"]`);
			if (!field) throw new Error(`Missing field ${label}`);
			const details = field.closest("details");
			if (details) details.open = true;
			field.value = value;
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
async function click(browser, text) {
	await browser.evaluate((text) => {
		const node = [...document.querySelectorAll("#center button")].find(
			(node) => node.textContent === text && node.checkVisibility(),
		);
		if (!node) throw new Error(`Missing visible button ${text}`);
		node.click();
	}, text);
	if (text === "Cancel")
		await browser.waitFor(() => {
			const overview = document.querySelector(".profile-overview");
			return overview && !overview.hidden;
		});
}
async function edit(browser, name) {
	await browser.click(`[data-profile-open="${name}"]`);
	await browser.waitFor(
		() => !!document.querySelector('[data-management-action="save-profile"]'),
	);
}
async function selectRole(browser, key) {
	await browser.evaluate(() => {
		document.querySelector(".profile-other-roles").open = true;
	});
	await set(browser, "Role to edit", key);
	await browser.waitFor(
		`!!document.querySelector(${JSON.stringify(`[aria-label="Role ${key} Model"]`)})`,
	);
}
async function save(browser) {
	await browser.click('[data-management-action="save-profile"]');
	await browser.waitFor(() => !!document.querySelector(".profile-save-status"));
}
const profile = async (ctx, name) =>
	(await profileAction(ctx, { op: "show", name })).data.profile;

test("Profiles: compact landing, focused editing, Cancel and hidden values preserved on save", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	const values = {
		executor: "codex",
		model: "fixture-model",
		effort: "low",
		permissionMode: "safe",
		strictCapabilities: ["readOnly"],
		roles: {
			verification: { executor: "claude", model: "sonnet", effort: "high" },
		},
	};
	await profileAction(p.ctx, { op: "set", name: "daily", values });
	await load(p.browser, p.url);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			rows: [...document.querySelectorAll(".profile-row")].map(
				(row) => row.dataset.profileOpen,
			),
			maps: document.querySelectorAll(".profile-overview pre").length,
			inputs: [
				...document.querySelectorAll("#center input, #center select"),
			].filter((node) => node.checkVisibility()).length,
			folded: !document.querySelector(".profile-preferences").open,
			deletes: [...document.querySelectorAll("#center button")].some((node) =>
				/Delete |Use .* by default|Clear default/.test(node.textContent),
			),
		})),
		{
			rows: ["codex", "claude", "pi", "daily"],
			maps: 0,
			inputs: 0,
			folded: true,
			deletes: false,
		},
	);
	// A built-in executor default is not a saved profile yet; setting it as default would be refused.
	await edit(p.browser, "codex");
	assert.equal(
		await p.browser.evaluate(
			() => !!document.querySelector(".profile-options"),
		),
		false,
	);
	await click(p.browser, "Cancel");
	await edit(p.browser, "daily");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			overviewHidden: document.querySelector(".profile-overview").hidden,
			advancedOpen: document.querySelector(".profile-advanced").open,
			visibleFields: [
				...document.querySelectorAll(
					".profile-common input, .profile-common select",
				),
			]
				.filter((node) => node.checkVisibility())
				.map((node) => node.getAttribute("aria-label")),
		})),
		{
			overviewHidden: true,
			advancedOpen: false,
			visibleFields: [],
		},
	);
	await set(p.browser, "Effort", "high");
	await click(p.browser, "Cancel");
	assert.equal((await profile(p.ctx, "daily")).effort, "low");
	assert.equal(
		await p.browser.evaluate(() => document.activeElement.dataset.profileOpen),
		"daily",
	);
	await edit(p.browser, "daily");
	await set(p.browser, "Effort", "high");
	await save(p.browser);
	const after = await profile(p.ctx, "daily");
	assert.equal(after.effort, "high");
	assert.equal(after.permissionMode, "safe");
	assert.deepEqual(after.strictCapabilities, ["readOnly"]);
	assert.deepEqual(after.roles, values.roles);
	await edit(p.browser, "daily");
	await selectRole(p.browser, "verification");
	await click(p.browser, "Reset role");
	await save(p.browser);
	assert.equal(
		(await profile(p.ctx, "daily")).roles,
		undefined,
		"a removed role is explicitly unset",
	);
	await edit(p.browser, "daily");
	await p.browser.click(".profile-other-roles > summary");
	await click(p.browser, "Add agent override");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Agent name"]'),
	);
	await p.browser.click('[data-management-action="save-profile"]');
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-editor [role=alert]")?.textContent ===
			"Enter a valid agent name.",
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".profile-advanced").open,
		),
		false,
	);
	assert.equal(
		await p.browser.evaluate(() =>
			document.activeElement.getAttribute("aria-label"),
		),
		"Agent name",
	);
	await click(p.browser, "Cancel");
	assert.equal((await profile(p.ctx, "daily")).roles, undefined);
	assert.deepEqual(await scanMarks(p.browser), []);
	assert.deepEqual(p.browser.errors, []);
});

test("Profiles: presets, default/clear and deletion stay available inside the editor", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p.browser, p.url);
	await click(p.browser, "New profile");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile name"]'),
	);
	await set(p.browser, "Profile name", "mixed-review");
	await p.browser.click(".profile-advanced > summary");
	await set(p.browser, "Profile preset", "mixed");
	await selectRole(p.browser, "verification");
	await set(p.browser, "Role verification Model", "manual/preset-model");
	await save(p.browser);
	assert.equal(
		(await profile(p.ctx, "mixed-review")).roles.verification.executor,
		"claude",
	);
	assert.deepEqual(
		(await profile(p.ctx, "mixed-review")).roles.verification,
		{ executor: "claude", model: "manual/preset-model", effort: "high" },
		"editing one preset field preserves its other fields",
	);
	// Reset means the selected preset, not an unset that removes the preset's freshly merged role.
	await edit(p.browser, "mixed-review");
	await p.browser.click(".profile-advanced > summary");
	await set(p.browser, "Profile preset", "mixed");
	await selectRole(p.browser, "verification");
	await p.browser.click("[data-role-reset]");
	await p.browser.waitFor(() =>
		document
			.querySelector(".profile-scope-note")
			?.textContent.includes("Model: Preset"),
	);
	await save(p.browser);
	assert.deepEqual((await profile(p.ctx, "mixed-review")).roles.verification, {
		executor: "claude",
		model: "sonnet",
		effort: "high",
	});
	await edit(p.browser, "mixed-review");
	await p.browser.click(".profile-options > summary");
	await click(p.browser, "Use mixed-review by default");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-default")?.textContent ===
			"Default profile: mixed-review",
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "list" })).data.default,
		"mixed-review",
	);
	await edit(p.browser, "mixed-review");
	await p.browser.click(".profile-options > summary");
	await click(p.browser, "Clear default");
	await p.browser.waitFor(() =>
		document
			.querySelector(".profile-default")
			?.textContent.startsWith("No default profile."),
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "list" })).data.default,
		undefined,
	);
	await edit(p.browser, "mixed-review");
	await p.browser.click(".profile-options > summary");
	await click(p.browser, "Delete mixed-review");
	assert.ok(
		await profile(p.ctx, "mixed-review"),
		"opening confirmation does not delete",
	);
	await click(p.browser, "Keep profile");
	assert.ok(await profile(p.ctx, "mixed-review"));
	await click(p.browser, "Delete mixed-review");
	await click(p.browser, "Confirm");
	await p.browser.waitFor(
		() => !document.querySelector(".profile-overview")?.hidden,
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "list" })).data.profiles.length,
		0,
	);
	assert.deepEqual(p.browser.errors, []);
});

test("Profiles: workflow settings are selected on demand and role removal works across repeated saves", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p.browser, p.url);
	assert.equal(
		await p.browser.evaluate(
			() =>
				!!document.querySelector('[aria-label="Workflow preferred profile"]'),
		),
		false,
	);
	await p.browser.click(".profile-preferences > summary");
	await set(p.browser, "Workflow to configure", "manage");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Workflow preferred profile"]'),
	);
	await set(p.browser, "Workflow preferred profile", "mixed");
	await p.browser.click(".profile-preferences .more-details > summary");
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-preferences .profile-flow .node"),
	);
	await selectRole(p.browser, "verification");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences .role-sharing-note")
				?.textContent === "Not used by the steps shown here.",
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			notice: document.querySelector(".profile-preferences .role-sharing-note")
				.textContent,
			footnote: document.querySelector(".profile-preferences .role-map-note")
				.textContent,
			sticky: getComputedStyle(
				document.querySelector(".profile-preferences .profile-editor-actions"),
			).position,
		})),
		{
			notice: "Not used by the steps shown here.",
			footnote:
				"Preview, not a run. A launch option can override these settings.",
			sticky: "static",
		},
	);
	await selectRole(p.browser, "default");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences .role-sharing-note")
				?.textContent === "Used by Read.",
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".profile-preferences .role-sharing-note")
					.textContent,
		),
		"Used by Read.",
	);
	await selectRole(p.browser, "verification");
	await set(p.browser, "Role verification Executor", "claude");
	await set(p.browser, "Role verification Effort", "high");
	await click(p.browser, "Save workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences [role=status]")
				?.textContent === "Workflow settings saved.",
	);
	const saved = (
		await workflowPreferenceAction(p.ctx, { op: "show", workflow: "manage" })
	).data.preference;
	assert.equal(saved.profile, "mixed");
	assert.equal(saved.roles.verification.effort, "high");
	await click(p.browser, "Reset role");
	await click(p.browser, "Save workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences [role=status]")
				?.textContent === "Workflow settings saved.",
	);
	assert.equal(
		(await workflowPreferenceAction(p.ctx, { op: "show", workflow: "manage" }))
			.data.preference.roles,
		undefined,
	);
	await click(p.browser, "Clear workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences [role=status]")
				?.textContent === "Workflow settings cleared.",
	);
	assert.equal(
		(await workflowPreferenceAction(p.ctx, { op: "show", workflow: "manage" }))
			.data.preference,
		undefined,
	);
	assert.deepEqual(p.browser.errors, []);
});

test("Profiles: read-only editing and narrow layouts keep settings safe and reachable", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t, { readonly: true });
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", model: "fixture-model", effort: "low" },
	});
	await load(p.browser, p.url);
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await edit(p.browser, "daily");
	await p.browser.click(".profile-advanced > summary");
	await p.browser.click(".profile-options > summary");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-management-action="save-profile"]')
					.disabled,
		),
		true,
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll(".profile-options button")]
				.filter((node) => node.checkVisibility())
				.map((node) => node.disabled),
		),
		[true, true],
	);
	await set(p.browser, "Effort", "high");
	await click(p.browser, "Cancel");
	assert.equal((await profile(p.ctx, "daily")).effort, "low");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".management-page").scrollWidth <=
				document.querySelector("#center").clientWidth,
		),
		true,
	);
	assert.deepEqual(await scanMarks(p.browser), []);
	assert.deepEqual(p.browser.errors, []);
});
