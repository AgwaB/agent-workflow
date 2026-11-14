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

import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";

const chrome = await findChrome();
async function open(t, options = {}) {
	assert.ok(chrome, "Chrome is required");
	const project = await managementProject(t, options);
	await profileGraphFixtures(project.cwd);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	return {
		...project,
		browser,
		url: `${project.origin}/?project=${project.server.projectId}&view=profiles&workflow=model-flow`,
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
			const configuration = field.closest(".profile-configuration");
			const restore = configuration?.hidden;
			if (configuration?.hidden)
				document.querySelector("[data-profile-configure]").click();
			if (field.closest(".profile-model-view")?.hidden)
				document.querySelector("[data-profile-configure]").click();
			const management = field.closest(".profile-scope-options");
			if (management?.hidden)
				document.querySelector("[data-assignment-manage]").click();
			const details = field.closest("details");
			if (details) details.open = true;
			field.value = value;
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
			if (restore) document.querySelector("[data-profile-configure]").click();
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
	const stage = key === "default" ? "plan" : "verify-a";
	await browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
	await browser.evaluate(() => {
		if (document.querySelector(".profile-model-view")?.hidden)
			document.querySelector("[data-profile-configure]").click();
	});
	await browser.click(`.profile-flow [data-stage="${stage}"]`);
	await browser.waitFor(
		`!!document.querySelector(${JSON.stringify(`[aria-label="Role ${key === "default" ? "planning" : key} Model"]`)})`,
	);
	await set(browser, "Profile setting scope", key);
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
			directWorkflowEntry: document
				.querySelector('[aria-label="Workflow to configure"]')
				.checkVisibility(),
			deletes: [...document.querySelectorAll("#center button")].some((node) =>
				/Delete |Use .* by default|Clear default/.test(node.textContent),
			),
		})),
		{
			rows: ["codex", "claude", "pi", "daily"],
			maps: 0,
			inputs: 1,
			directWorkflowEntry: true,
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
			advancedVisible: document
				.querySelector(".profile-advanced")
				.checkVisibility(),
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
			advancedVisible: false,
			visibleFields: ["Executor", "Model", "Effort"],
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
	assert.equal(
		await p.browser.evaluate(
			() =>
				!!document.querySelector(
					'.profile-other-roles, [aria-label="Role to edit"], [aria-label="Agent name"]',
				),
		),
		false,
	);
	await click(p.browser, "Cancel");
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
	await p.browser.click("[data-profile-configure]");
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
	await p.browser.click("[data-profile-configure]");
	await set(p.browser, "Profile preset", "mixed");
	await selectRole(p.browser, "verification");
	await p.browser.click("[data-role-reset]");
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Role verification Model"]')
				?.value === "sonnet",
	);
	await save(p.browser);
	assert.deepEqual((await profile(p.ctx, "mixed-review")).roles.verification, {
		executor: "claude",
		model: "sonnet",
		effort: "high",
	});
	await edit(p.browser, "mixed-review");
	await p.browser.evaluate(() => {
		if (document.querySelector(".profile-configuration").hidden)
			document.querySelector("[data-profile-configure]").click();
	});
	await click(p.browser, "Use mixed-review by default");
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-profile-open="mixed-review"]')
			?.textContent.includes("Default profile"),
	);
	assert.equal(
		(await profileAction(p.ctx, { op: "list" })).data.default,
		"mixed-review",
	);
	await edit(p.browser, "mixed-review");
	await p.browser.evaluate(() => {
		if (document.querySelector(".profile-configuration").hidden)
			document.querySelector("[data-profile-configure]").click();
	});
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
	await p.browser.evaluate(() => {
		if (document.querySelector(".profile-configuration").hidden)
			document.querySelector("[data-profile-configure]").click();
	});
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

	await set(p.browser, "Workflow to configure", "model-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Workflow preferred profile"]'),
	);
	await set(p.browser, "Workflow preferred profile", "mixed");

	await p.browser.waitFor(
		() => !!document.querySelector(".profile-preferences .profile-flow .node"),
	);
	await selectRole(p.browser, "verification");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences .role-sharing-note")
				?.textContent === "Used by Verify a and Verify b.",
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
			notice: "Used by Verify a and Verify b.",
			footnote:
				"Preview, not a run. A launch option can override these settings.",
			sticky: "static",
		},
	);
	await selectRole(p.browser, "default");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences .role-sharing-note")
				?.textContent === "Used by 5 steps here.",
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".profile-preferences .role-sharing-note")
					.textContent,
		),
		"Used by 5 steps here.",
	);
	await selectRole(p.browser, "verification");
	await set(p.browser, "Role verification Executor", "claude");
	await set(p.browser, "Role verification Effort", "high");
	await click(p.browser, "Save workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences p[role=status]")
				?.textContent === "Workflow settings saved.",
	);
	const saved = (
		await workflowPreferenceAction(p.ctx, {
			op: "show",
			workflow: "model-flow",
		})
	).data.preference;
	assert.equal(saved.profile, "mixed");
	assert.equal(saved.roles.verification.effort, "high");
	await click(p.browser, "Reset role");
	await click(p.browser, "Save workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences p[role=status]")
				?.textContent === "Workflow settings saved.",
	);
	assert.equal(
		(
			await workflowPreferenceAction(p.ctx, {
				op: "show",
				workflow: "model-flow",
			})
		).data.preference.roles,
		undefined,
	);
	await click(p.browser, "Clear workflow preference");
	await p.browser.waitFor(
		() =>
			document.querySelector(".profile-preferences p[role=status]")
				?.textContent === "Workflow settings cleared.",
	);
	assert.equal(
		(
			await workflowPreferenceAction(p.ctx, {
				op: "show",
				workflow: "model-flow",
			})
		).data.preference,
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
	await p.browser.click("[data-profile-configure]");
	await p.browser.evaluate(() => {
		if (document.querySelector(".profile-configuration").hidden)
			document.querySelector("[data-profile-configure]").click();
	});
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

test("Workflow preference keeps unmapped saved entries and has no outside-diagram editor", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	const hidden = {
		"agent:ghost": { model: "x" },
		"research-execution": { model: "unused" },
	};
	await workflowPreferenceAction(p.ctx, {
		op: "set",
		workflow: "model-flow",
		roles: hidden,
	});
	await load(p.browser, p.url);

	await set(p.browser, "Workflow to configure", "model-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Workflow preferred profile"]'),
	);

	await selectRole(p.browser, "verification");
	assert.equal(
		await p.browser.evaluate(
			() =>
				!!document.querySelector(
					'.profile-preferences .profile-other-roles, .profile-preferences [aria-label="Role to edit"], .profile-preferences [aria-label="Agent name"]',
				) ||
				[...document.querySelectorAll(".profile-preferences button")].some(
					(n) => n.textContent === "Add agent override",
				),
		),
		false,
	);
	await set(p.browser, "Role verification Model", "changed");
	await click(p.browser, "Save workflow preference");
	await p.browser.waitFor(() =>
		[...document.querySelectorAll(".profile-preferences p[role=status]")].some(
			(n) => n.textContent === "Workflow settings saved.",
		),
	);
	const saved = (
		await workflowPreferenceAction(p.ctx, {
			op: "show",
			workflow: "model-flow",
		})
	).data.preference;
	for (const key of Object.keys(hidden))
		assert.equal(JSON.stringify(saved.roles[key]), JSON.stringify(hidden[key]));
	assert.equal(saved.roles.verification.model, "changed");
});

test("Simple profile editing exposes model fields and separates configuration management", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	const roles = {
		default: { model: "saved/default" },
		verification: { model: "shadowed/role" },
		"agent:reader": { model: "manual/agent", effort: "off" },
		"agent:ghost": { model: "unknown/agent" },
	};
	await profileAction(p.ctx, {
		op: "set",
		name: "simple",
		values: {
			executor: "codex",
			model: "manual/common",
			permissionMode: "safe",
			strictCapabilities: ["readOnly"],
			roles,
		},
	});
	await load(p.browser, p.url);
	await edit(p.browser, "simple");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			fields: ["Executor", "Model", "Effort"].map((label) =>
				document.querySelector(`[aria-label="${label}"]`).checkVisibility(),
			),
			folds: document.querySelectorAll(".profile-editor details").length,
			rareVisible: document
				.querySelector('[aria-label="Profile permission mode"]')
				.checkVisibility(),
			restrictions: document.querySelector(".profile-restrictions")
				?.textContent,
		})),
		{
			fields: [true, true, true],
			folds: 0,
			rareVisible: false,
			restrictions: "Permissions: safe; Strict: readOnly",
		},
	);
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow [data-stage="verify-a"]'),
	);
	await p.browser.click('.profile-flow [data-stage="verify-a"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Role agent:reader Model"]').value,
		),
		"manual/agent",
	);
	assert.match(
		await p.browser.evaluate(
			() =>
				document
					.querySelector("[data-effort-note]")
					.closest(".profile-editor")
					.querySelector(".role-inspector [data-effort-note]").textContent,
		),
		/nearest supported effort/,
	);
	assert.equal(
		await p.browser.evaluate(() =>
			document
				.querySelector('[aria-label="Profile setting scope"]')
				.checkVisibility(),
		),
		false,
	);
	await p.browser.click("[data-assignment-manage]");
	assert.ok(
		await p.browser.evaluate(() =>
			[
				...document.querySelector('[aria-label="Profile setting scope"]')
					.options,
			].some((o) => o.value === "agent:ghost"),
		),
	);
	for (const key of ["verification", "default", "agent:ghost"]) {
		await set(p.browser, "Profile setting scope", key);
		await p.browser.waitFor(
			`!!document.querySelector(${JSON.stringify(`[aria-label="Role ${key} Model"]`)})`,
		);
		assert.equal(
			await p.browser.evaluate(
				(label) => document.querySelector(`[aria-label="${label}"]`).value,
				`Role ${key} Model`,
			),
			roles[key].model,
		);
	}
	await p.browser.click("[data-profile-configure]");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".profile-model-view").hidden,
		),
		true,
	);
	await set(p.browser, "Profile permission mode", "free");
	await save(p.browser);
	assert.equal((await profile(p.ctx, "simple")).permissionMode, "free");
	assert.deepEqual((await profile(p.ctx, "simple")).roles, roles);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelectorAll(".profile-save-status details").length,
		),
		0,
	);
	assert.deepEqual(p.browser.errors, []);
});

test("Assignment management creates default and agent entries without rewriting Common", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "assignments",
		values: { executor: "codex", model: "common/manual" },
	});
	await load(p.browser, p.url);
	await edit(p.browser, "assignments");
	// Assignment candidates include graph agents; wait for that asynchronous catalog before choosing one.
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
	await p.browser.click("[data-assignment-open]");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role default Model"]'),
	);
	await set(p.browser, "Role default Model", "default/manual");
	await set(p.browser, "Profile setting scope", "agent:reader");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	await set(p.browser, "Role agent:reader Model", "agent/manual");
	await save(p.browser);
	const saved = await profile(p.ctx, "assignments");
	assert.equal(saved.model, "common/manual");
	assert.deepEqual(saved.roles, {
		default: { model: "default/manual" },
		"agent:reader": { model: "agent/manual" },
	});
	assert.deepEqual(p.browser.errors, []);
});

test("Common effort warning clears after choosing supported effort or Automatic", {
	timeout: 30000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "stale-effort",
		values: { executor: "claude", effort: "minimal" },
	});
	await load(p.browser, p.url);
	await edit(p.browser, "stale-effort");
	const warning = () =>
		p.browser.evaluate(
			() => document.querySelector("[data-effort-note]").textContent,
		);
	assert.match(await warning(), /minimal is not available/);
	await set(p.browser, "Effort", "high");
	assert.equal(await warning(), "");
	await set(p.browser, "Effort", "minimal");
	assert.match(await warning(), /minimal is not available/);
	await set(p.browser, "Effort", "");
	assert.equal(await warning(), "");
	await click(p.browser, "Cancel");
	assert.equal((await profile(p.ctx, "stale-effort")).effort, "minimal");
});

test("E: actual per-field shadowing explains unchanged node without conflating effort or executor scope", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "shadowed",
		values: {
			executor: "codex",
			roles: {
				"agent:reader": { model: "agent/manual" },
				verification: { model: "role/manual", effort: "high" },
				"agent:legacy-agent": { model: "legacy/manual" },
			},
		},
	});
	await load(p.browser, p.url);
	await edit(p.browser, "shadowed");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow [data-stage="verify-a"]'),
	);
	await p.browser.click('.profile-flow [data-stage="verify-a"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	await set(p.browser, "Profile setting scope", "verification");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Model"]'),
	);
	await set(p.browser, "Role verification Model", "shadowed/edit");
	const note = await p.browser.evaluate(
		() => document.querySelector(".role-inheritance").textContent,
	);
	assert.match(note, /Agent: reader.*[Mm]odel/);
	assert.doesNotMatch(note, /[Ee]ffort/);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector('[data-stage="verify-a"]').textContent,
		),
		/agent\/manual/,
	);
	// A more-specific executor wins too; model resolution follows that winning executor.
	await set(p.browser, "Profile setting scope", "agent:reader");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Executor"]'),
	);
	await set(p.browser, "Role agent:reader Executor", "claude");
	await set(p.browser, "Role agent:reader Model", "claude/manual");
	await set(p.browser, "Profile setting scope", "verification");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Executor"]'),
	);
	// The winning agent executor makes the codex-scoped role inapplicable; a role cannot claim its effort is used.
	await set(p.browser, "Role verification Executor", "codex");
	await set(p.browser, "Role verification Model", "codex/manual");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").textContent,
		),
		/Agent: reader.*[Mm]odel/,
	);
	await set(p.browser, "Profile setting scope", "agent:legacy-agent");
	await p.browser.waitFor(
		() =>
			!!document.querySelector('[aria-label="Role agent:legacy-agent Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelectorAll(
					".profile-flow .node.selected, .profile-flow .stage-row.selected",
				).length,
		),
		0,
	);
	await p.browser.key("Escape");
	assert.equal(
		await p.browser.evaluate(() => document.activeElement?.dataset.stage),
		"verify-a",
	);
	assert.deepEqual(p.browser.errors, []);
});

test("E: Profile options is an action switch, not a contradictory expanded disclosure", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "options",
		values: { model: "manual/model" },
	});
	await load(p.browser, p.url);
	await edit(p.browser, "options");
	await p.browser.click("[data-profile-configure]");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			label: document.querySelector("[data-profile-configure]").textContent,
			expanded: document
				.querySelector("[data-profile-configure]")
				.getAttribute("aria-expanded"),
			hidden: document.querySelector(".profile-model-view").hidden,
		})),
		{ label: "Model settings", expanded: null, hidden: true },
	);
	await p.browser.click("[data-profile-configure]");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="Model"]').value,
		),
		"manual/model",
	);
});

test("E: a badged default has no blank divider", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "defaulted",
		values: { model: "manual/model" },
	});
	await profileAction(p.ctx, { op: "default", name: "defaulted" });
	await load(p.browser, p.url);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".profile-default")?.checkVisibility() ?? false,
		),
		false,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-profile-open="defaulted"] .profile-badge')
					.textContent,
		),
		"Default profile",
	);
});

test("E: unrelated assignment clears active selection but Escape returns to its prior node", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "selection",
		values: { roles: { "agent:legacy-agent": { model: "legacy/manual" } } },
	});
	await load(p.browser, p.url);
	await edit(p.browser, "selection");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow [data-stage="verify-a"]'),
	);
	await p.browser.click('.profile-flow [data-stage="verify-a"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Model"]'),
	);
	await set(p.browser, "Profile setting scope", "agent:legacy-agent");
	await p.browser.waitFor(
		() =>
			!!document.querySelector('[aria-label="Role agent:legacy-agent Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelectorAll(".profile-flow .selected").length,
		),
		0,
	);
	await p.browser.key("Escape");
	assert.equal(
		await p.browser.evaluate(() => document.activeElement?.dataset.stage),
		"verify-a",
	);
});

test("E: manual pan/zoom and fitted graph survive options round trip and real resize", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "graph-view",
		values: { model: "manual/model" },
	});
	await load(p.browser, p.url);
	await edit(p.browser, "graph-view");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
	const transform = () =>
		p.browser.evaluate(() =>
			document
				.querySelector(".profile-flow svg.graph > g")
				.getAttribute("transform"),
		);
	const roundtrip = async () => {
		await p.browser.click("[data-profile-configure]");
		await p.browser.evaluate(() => new Promise((r) => setTimeout(r, 120)));
		await p.browser.click("[data-profile-configure]");
	};
	const fitted = await transform();
	await roundtrip();
	assert.equal(await transform(), fitted, "fitted view preserved");
	await p.browser.evaluate(() => {
		const c = document.querySelector(".profile-flow-canvas");
		const b = c.getBoundingClientRect();
		c.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: -30,
				ctrlKey: true,
				clientX: b.x + b.width / 2,
				clientY: b.y + b.height / 2,
				cancelable: true,
			}),
		);
		c.dispatchEvent(
			new WheelEvent("wheel", { deltaX: -45, deltaY: 35, cancelable: true }),
		);
	});
	const manual = await transform();
	assert.notEqual(manual, fitted, "actual pan/zoom occurred");
	await roundtrip();
	assert.equal(await transform(), manual, "manual view preserved");
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 1100,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await p.browser.evaluate(() => new Promise((r) => setTimeout(r, 120)));
	const resized = await transform();
	assert.notEqual(resized, manual, "real resize still updates the view");
	await roundtrip();
	assert.equal(await transform(), resized);
	await p.browser.click('.profile-flow [title="Fit graph"]');
	const refitted = await transform();
	assert.notEqual(refitted, resized);
	await roundtrip();
	assert.equal(await transform(), refitted);
	assert.deepEqual(p.browser.errors, []);
});

test("E: unmatched default reference remains identified", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `const original=window.fetch; window.fetch=async (...args)=>{const r=await original(...args); if(String(args[0]).endsWith('/profiles')){const d=await r.json();d.data.default='hand-edited-missing';return new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}});}return r;};`,
	});
	await load(p.browser, p.url);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".profile-default")?.textContent || "",
		),
		/hand-edited-missing/,
	);
});

test("F: workflow preference upper default beats lower preset agent or role without false shadowing", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await load(p.browser, p.url);
	await set(p.browser, "Workflow to configure", "model-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Workflow preferred profile"]'),
	);
	await set(p.browser, "Workflow preferred profile", "mixed");
	await selectRole(p.browser, "verification");
	await set(p.browser, "Profile setting scope", "default");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role default Model"]'),
	);
	await set(p.browser, "Role default Model", "upper/default");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").hidden,
		),
		true,
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector('[data-stage="verify-a"]').textContent,
		),
		/upper\/default/,
	);
	await set(p.browser, "Profile setting scope", "agent:reader");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	await set(p.browser, "Role agent:reader Model", "upper/agent");
	await set(p.browser, "Profile setting scope", "default");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role default Model"]'),
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").textContent,
		),
		/Agent: reader takes precedence for model/,
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector('[data-stage="verify-a"]').textContent,
		),
		/upper\/agent/,
	);
});

test("F: fixed executor defaults do not invent an agent executor winner and preserve mismatch", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "codex",
		values: {
			roles: {
				verification: {
					executor: "codex",
					model: "manual/verification",
					effort: "high",
				},
			},
		},
	});
	await load(p.browser, p.url);
	await edit(p.browser, "codex");
	await selectRole(p.browser, "verification");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").hidden,
		),
		true,
	);
	// Contract-shaped stored mismatch, supported CLI shape; the input remains readonly.
	await click(p.browser, "Cancel");
	await profileAction(p.ctx, {
		op: "set",
		name: "codex",
		values: {
			roles: {
				verification: {
					executor: "claude",
					model: "ignored/model",
					effort: "high",
				},
			},
		},
	});
	await load(p.browser, p.url);
	await edit(p.browser, "codex");
	await selectRole(p.browser, "verification");
	const note = await p.browser.evaluate(
		() => document.querySelector(".role-inheritance").textContent,
	);
	assert.match(note, /not used by codex stage defaults/);
	assert.doesNotMatch(note, /takes precedence for executor/);
});

for (const kind of ["Built-in", "Common setting", "Preset"])
	test(`F: ${kind} winning role reports per-field baseline shadowing`, {
		timeout: 60000,
	}, async (t) => {
		const p = await open(t);
		const name = kind === "Preset" ? "preset-draft" : "codex";
		await profileAction(p.ctx, {
			op: "set",
			name,
			values:
				kind === "Common setting" ? { model: "common/model" } : { roles: {} },
		});
		await load(p.browser, p.url);
		await edit(p.browser, name);
		if (kind === "Preset") await set(p.browser, "Profile preset", "codex");
		await selectRole(p.browser, "verification");
		await set(p.browser, "Profile setting scope", "default");
		await p.browser.waitFor(
			() => !!document.querySelector('[aria-label="Role default Model"]'),
		);
		if (kind === "Preset") {
			await set(p.browser, "Role default Executor", "");
			await set(p.browser, "Role default Effort", "");
		}
		await set(p.browser, "Role default Model", "shadow/default");
		const note = await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").textContent,
		);
		assert.match(
			note,
			new RegExp(`Verification \\(${kind}\\) takes precedence for model`),
		);
		assert.doesNotMatch(note, /for effort|for executor/);
		assert.doesNotMatch(
			await p.browser.evaluate(
				() => document.querySelector('[data-stage="verify-a"]').textContent,
			),
			/shadow\/default/,
		);
		await set(p.browser, "Role default Effort", "low");
		assert.match(
			await p.browser.evaluate(
				() => document.querySelector(".role-inheritance").textContent,
			),
			/Verification.*takes precedence for effort/,
		);
		// A role assignment at the actual winning scope is used, not shadowed.
		await set(p.browser, "Profile setting scope", "verification");
		await p.browser.waitFor(
			() => !!document.querySelector('[aria-label="Role verification Model"]'),
		);
		await set(p.browser, "Role verification Model", "used/role");
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelector(".role-inheritance").hidden,
			),
			true,
		);
		assert.match(
			await p.browser.evaluate(
				() => document.querySelector('[data-stage="verify-a"]').textContent,
			),
			/used\/role/,
		);
	});

test("E: executor-scoped ignored agent values do not invent shadowing", {
	timeout: 60000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "codex",
		values: {
			roles: {
				"agent:reader": {
					executor: "claude",
					model: "ignored/model",
					effort: "high",
				},
				verification: { model: "used/model", effort: "low" },
			},
		},
	});
	await load(p.browser, p.url);
	await edit(p.browser, "codex");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow [data-stage="verify-a"]'),
	);
	await p.browser.click('.profile-flow [data-stage="verify-a"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	await set(p.browser, "Profile setting scope", "verification");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").hidden,
		),
		true,
	);
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('.profile-flow [data-stage="verify-a"]')
					.textContent,
		),
		/used\/model/,
	);
	assert.doesNotMatch(
		await p.browser.evaluate(
			() =>
				document.querySelector('.profile-flow [data-stage="verify-a"]')
					.textContent,
		),
		/ignored\/model/,
	);
});
