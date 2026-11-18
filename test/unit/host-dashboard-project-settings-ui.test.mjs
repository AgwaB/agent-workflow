// test-tier: integration
// Test-owned headless Chrome, real B2 routes, isolated homes/projects and fake executors only.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWorkflowExecutor } from "../../dist/core/executor-registry.js";
import { resetExecutorProbeCacheForTests } from "../../dist/core/executor-default.js";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { projectSettingsGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
import { projectWorkflowSettingsPath } from "../../dist/hosts/project-workflow-settings.js";
const chrome = await findChrome();
const tokens = ({
	storeEpoch,
	revision,
	definitionFingerprint,
	resolutionToken,
}) => ({ storeEpoch, revision, definitionFingerprint, resolutionToken });
async function open(t, options = {}) {
	assert.ok(chrome, "Chrome required for native editor checks");
	const p = await managementProject(t, options);
	await projectSettingsGraphFixtures(p.cwd);
	const catalog = (await p.http(`${p.base}/workflows`)).data.data.workflows;
	const entries = catalog.filter((entry) => entry.name === "canonical-editor");
	assert.equal(entries.length, 2, "same-name explicit sources remain distinct");
	const entry = entries.find((entry) =>
		entry.specPath.endsWith("canonical-editor.json"),
	);
	assert.match(
		entry.workflowKey || "",
		/^[a-f0-9]{64}$/,
		JSON.stringify({
			entry,
			detail: await p.http(`${p.base}/workflows/canonical-editor`),
		}),
	);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
		window.__requests = []; window.__holds = {}; window.__releases = {};
		const originalFetch = window.fetch;
		window.fetch = async (...args) => {
			const path = String(args[0]), options = args[1] || {};
			const request = {path, method: options.method || 'GET', body: options.body && JSON.parse(options.body)};
			if (path.includes('/settings') || path.endsWith('/check')) window.__requests.push(request);
			const fail = (path.endsWith('/preview') && window.__failPreview) || (options.method === 'PUT' && window.__failPUT);
			if (fail) { window.__failPreview = false; window.__failPUT = false; }
			const response = fail ? new Response(JSON.stringify({error: 'fixture calculation unavailable'}), {status: 503, headers: {'content-type': 'application/json'}}) : await originalFetch(...args);
			const op = path.endsWith('/preview') ? 'preview' : path.endsWith('/settings') ? (options.method || 'GET') : '';
			if (window.__holds[op]) { window.__holds[op] = false; await new Promise(resolve => { window.__releases[op] = resolve; }); }
			const json = response.json.bind(response);
			response.json = async () => {
				const data = await json();
				request.response = {status: response.status, data};
				if (data.pending) request.calculationId = data.calculationId;
				if (path.startsWith('/api/calculations/') && !data.pending) {
					const logical = window.__requests.find(r => r.calculationId === path.split('/').at(-1));
					if (logical) logical.response = {status: response.status, data};
				}
				return data;
			};
			return response;
		};
	`,
	});
	const url = `${p.origin}/?project=${p.server.projectId}&view=workflows&workflow=${entry.workflowKey}`;
	const path = `${p.base}/workflows/${entry.workflowKey}/settings`;
	return { ...p, browser, url, path, entry, entries };
}
async function load(p) {
	await p.browser.send("Page.navigate", { url: p.url });
	try {
		await p.browser.waitFor(
			() => !!document.querySelector(".project-workflow-actions"),
		);
	} catch (error) {
		throw new Error(
			`${error.message}\n${await p.browser.evaluate(() => document.querySelector("#center").textContent)}`,
		);
	}
	await p.browser.waitFor(
		() =>
			!document
				.querySelector('[data-testid="workflow-settings-status"]')
				.textContent.includes("Loading"),
	);
	await p.browser.waitFor(
		() =>
			!!document.querySelector('.profile-flow [data-stage="iterate.check"]'),
	);
}
async function settled(p) {
	await p.browser.waitFor(() => {
		const request = window.__requests.findLast((r) =>
			r.path.endsWith("/preview"),
		);
		const load = window.__requests.findLast(
			(r) => r.path.endsWith("/settings") && r.method === "GET",
		);
		if (
			!request?.response ||
			request.response.status !== 200 ||
			window.__requests.indexOf(request) < window.__requests.indexOf(load) ||
			!document.querySelector(".project-common [data-binding]")
		)
			return false;
		return [
			...document.querySelectorAll(".project-workflow-editor [data-binding]"),
		].every((node) => {
			const value =
				node.dataset.binding === "common"
					? request.body.intent.defaults
					: request.body.intent.slots?.[node.dataset.binding];
			return ["Executor", "Model", "Effort"].every(
				(key) =>
					node.querySelector(`[aria-label$=" ${key}"]`).value ===
					(value?.[key.toLowerCase()] || ""),
			);
		});
	});
}
// Tasks are selected in the graph itself (keyboard path); there is no duplicate task list.
async function select(p, id) {
	await p.browser.evaluate((id) => {
		const node = document.querySelector(
			`.profile-flow [data-stage="${CSS.escape(id)}"]`,
		);
		if (!node) throw new Error(`Missing graph node: ${id}`);
		node.focus({ preventScroll: true });
	}, id);
	await p.browser.key("Enter");
}
// Code steps start hidden (2026-11-18, owner); tests that walk every authored node show them first.
async function showCodeSteps(p) {
	const shown = await p.browser.evaluate(() =>
		document
			.querySelector(".profile-flow .code-switch")
			?.textContent.includes("shown"),
	);
	if (!shown) {
		await p.browser.click(".profile-flow .code-switch");
		await p.browser.waitFor(() =>
			document
				.querySelector(".profile-flow .code-switch")
				?.textContent.includes("shown"),
		);
	}
}
const graphIds = (p) =>
	p.browser.evaluate(() =>
		[
			...new Set(
				[...document.querySelectorAll(".profile-flow [data-stage]")]
					.map((node) => node.dataset.stage)
					.filter((id) => !id.startsWith("__group_")),
			),
		].sort(),
	);
async function custom(p) {
	const radio = '[name="task-settings-scope"][value="custom"]';
	const needed = await p.browser.evaluate((selector) => {
		const node = document.querySelector(selector);
		return node && !node.checked;
	}, radio);
	if (needed) {
		await settled(p);
		await p.browser.click(radio);
		await settled(p);
	}
}
async function set(p, label, value) {
	if (label.startsWith("Slot ")) await custom(p);
	await p.browser.evaluate(
		(label, value) => {
			const node = document.querySelector(
				`[aria-label="${CSS.escape(label)}"]`,
			);
			if (!node) throw new Error(`Missing ${label}`);
			if (node.disabled) throw new Error(`Disabled ${label}`);
			if (
				node.tagName === "SELECT" &&
				![...node.options].some((option) => option.value === value)
			)
				throw new Error(`Unavailable ${label} option: ${value}`);
			node.value = value;
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
async function saved(p) {
	await p.browser.click('[data-management-action="save-project-settings"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="workflow-settings-status"]')
			?.textContent.startsWith("Settings saved"),
	);
}
const intent = async (p) => (await p.http(p.path)).data.settings.intent;
async function baseline(p, label) {
	const native = await p.browser.evaluate(
		(label) =>
			document.querySelector(`[aria-label="${label}"]`).tagName === "SELECT",
		label,
	);
	if (native) {
		assert.equal(
			await p.browser.evaluate(
				(label) =>
					document.querySelector(`[aria-label="${label}"] option[value=""]`)
						.textContent,
				label,
			),
			"Use baseline settings",
		);
		await set(p, label, "");
		return;
	}
	await p.browser.click(`[aria-label="${label}"]`);
	const menu = await p.browser.evaluate(
		(label) =>
			document
				.querySelector(`[aria-label="${label}"]`)
				.getAttribute("aria-controls"),
		label,
	);
	assert.equal(
		await p.browser.evaluate(
			(menu) => document.querySelector(`#${menu} [data-value=""]`)?.textContent,
			menu,
		),
		"Use baseline settings",
	);
	await p.browser.click(`#${menu} [data-value=""]`);
}

async function seed(p, value) {
	const current = (await p.http(p.path)).data.settings;
	const result = await p.http(p.path, {
		method: "PUT",
		body: {
			expected: tokens(current),
			intent: { defaults: { executor: "management-fake" } },
		},
	});
	assert.equal(result.status, 200, JSON.stringify(result.data));
	// Test-owned legacy store: the model was saved before its catalog stopped offering it.
	const file = projectWorkflowSettingsPath(p.cwd, { env: p.env });
	const store = JSON.parse(await readFile(file, "utf8"));
	store.workflows[p.entry.workflowKey].intent = value;
	await writeFile(file, JSON.stringify(store));
}
async function refused(p, text = "Draft retained") {
	await p.browser.waitFor(
		`[...document.querySelectorAll('.project-workflow-header [role="alert"]')].some((node) => !node.hidden && node.textContent.includes(${JSON.stringify(text)}))`,
	);
}

async function presetProject(t, options = {}) {
	const p = await open(t, options);
	for (const id of ["codex", "claude"])
		t.after(
			registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					capabilities: {
						effortLevels: ["low", "medium", "high", "xhigh", "max"],
					},
					probe: {
						installed: true,
						auth: "ok",
						models:
							id === "codex"
								? ["gpt-6.1-sol", "gpt-6-luna"]
								: ["claude-opus-5-5"],
						modelListComplete: true,
					},
				}),
			),
		);
	resetExecutorProbeCacheForTests();
	const file = join(p.cwd, ".agent-workflow/workflows/canonical-editor.json");
	const spec = JSON.parse(await readFile(file, "utf8"));
	spec.artifactGraph.stages[0].stages[0].profileRole = "planning";
	spec.artifactGraph.stages[1].stages[1].profileRole = "synthesis";
	spec.artifactGraph.stages.at(-1).profileRole = "final-judgment";
	const loop = spec.artifactGraph.stages.find(
		(stage) => stage.id === "adaptive",
	).dynamic.decisionLoop;
	loop.planner.profileRole = "planning";
	loop.workerDefaults.profileRole = "verification";
	await writeFile(file, JSON.stringify(spec));
	return p;
}
const presetValue = (p) =>
	p.browser.evaluate(
		() => document.querySelector('[aria-label="Preset"]').value,
	);
const draftIntent = (p) =>
	p.browser.evaluate(
		() =>
			window.__requests.findLast((r) => r.path.endsWith("/preview")).body
				.intent,
	);

test("R3-R4: native preset fill, manual editing, discard, save and reload use one complete intent", {
	timeout: 90000,
}, async (t) => {
	const p = await presetProject(t);
	await load(p);
	await settled(p);
	assert.deepEqual(
		await p.browser.evaluate(() => {
			const node = document.querySelector('[aria-label="Preset"]');
			return (
				node && {
					tag: node.tagName,
					options: [...node.options].map((o) => [o.value, o.textContent]),
				}
			);
		}),
		{
			tag: "SELECT",
			options: [
				["", "Custom"],
				["codex", "codex"],
				["codex-high", "codex-high"],
				["claude", "claude"],
				["mixed", "mixed"],
			],
		},
	);
	await p.browser.evaluate(() =>
		document.querySelector('[aria-label="Preset"]').focus(),
	);
	await set(p, "Preset", "codex-high");
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.activeElement ===
				document.querySelector('[aria-label="Preset"]'),
		),
		true,
		"preset fill preserves keyboard focus",
	);
	const filled = await draftIntent(p);
	assert.deepEqual(filled.defaults, {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "high",
	});
	assert.deepEqual(filled.slots["iterate.work"], {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "xhigh",
	});
	assert.deepEqual(filled.slots["iterate.check"], {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "max",
	});
	assert.deepEqual(filled.slots["nested.peer"], {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "xhigh",
	});
	assert.deepEqual(filled.slots.constructor, {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "xhigh",
	});
	assert.deepEqual(filled.slots["adaptive.$planner"], {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "xhigh",
	});
	assert.deepEqual(filled.slots["adaptive.$workerDefaults"], {
		executor: "codex",
		model: "gpt-6.1-sol",
		effort: "max",
	});
	assert.equal(filled.slots.items, undefined, "unknown role uses defaults");
	assert.equal(await presetValue(p), "codex-high");
	await set(p, "Preset", "");
	assert.equal(
		await presetValue(p),
		"codex-high",
		"Custom never stores a name or clears intent",
	);
	assert.deepEqual(await intent(p), {}, "selection does not save");
	await set(p, "All steps Effort", "medium");
	await settled(p);
	assert.equal(await presetValue(p), "");
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	await p.browser.waitFor(
		() => document.querySelector('[aria-label="Preset"]')?.value === "",
	);
	await settled(p);
	assert.deepEqual(await draftIntent(p), {});
	await set(p, "Preset", "codex-high");
	await settled(p);
	await saved(p);
	assert.deepEqual(await intent(p), filled);
	const puts = await p.browser.evaluate(() =>
		window.__requests.filter((r) => r.method === "PUT"),
	);
	assert.equal(puts.length, 1);
	assert.deepEqual(puts[0].body.intent, filled);
	assert.deepEqual(Object.keys(puts[0].body).sort(), ["expected", "intent"]);
	await load(p);
	await settled(p);
	assert.equal(await presetValue(p), "codex-high");
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Effort", "high");
	await settled(p);
	await p.browser.click('[data-testid="all-tasks-back"]');
	assert.equal(await presetValue(p), "", "task edits also become Custom");
});

test("R3: mixed uses server role keys, safe raw IDs and actual-parent dynamic bindings", {
	timeout: 90000,
}, async (t) => {
	const p = await presetProject(t);
	await load(p);
	await settled(p);
	const metadata = (await p.http(p.path)).data;
	assert.deepEqual(metadata.slotRoleKeys["iterate.work"], [
		"agent:reader",
		"planning",
		"default",
	]);
	await set(p, "Preset", "mixed");
	await settled(p);
	const filled = await draftIntent(p);
	assert.deepEqual(filled.defaults, {
		executor: "codex",
		model: "gpt-6-luna",
		effort: "medium",
	});
	assert.deepEqual(filled.slots["iterate.work"], {
		executor: "claude",
		model: "claude-opus-5-5",
		effort: "high",
	});
	assert.deepEqual(filled.slots["iterate.check"], {
		executor: "codex",
		model: "gpt-6-luna",
		effort: "high",
	});
	assert.equal(filled.slots["nested.peer"].executor, "claude");
	assert.equal(filled.slots.constructor.executor, "claude");
	assert.equal(filled.slots.__proto__.executor, "codex");
	assert.equal(
		filled.slots["adaptive.$planner"],
		undefined,
		"incompatible OPUS template inherits its codex parent",
	);
	assert.deepEqual(filled.slots["adaptive.$workerDefaults"], {
		executor: "codex",
		model: "gpt-6-luna",
		effort: "high",
	});
	for (const slot of metadata.editableSlots.filter(
		(slot) => slot.kind === "dynamic-profile",
	))
		assert.ok(
			!filled.slots[slot.id] || filled.slots[slot.id].executor === "codex",
			"template cannot pin a different executor from its actual parent",
		);
	assert.equal(await presetValue(p), "mixed");
	await saved(p);
	assert.deepEqual(await intent(p), filled);
});

test("R3-R4: preset selection is disabled in read-only projects", {
	timeout: 90000,
}, async (t) => {
	const p = await presetProject(t, { readonly: true });
	await load(p);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="Preset"]')?.disabled,
		),
		true,
	);
	assert.deepEqual(await intent(p), {});
});

test("scope S1: loading is an accessible spinner with reserved editor space", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 1476,
		height: 997,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: "window.__holds.GET = true;",
	});
	await p.browser.send("Page.navigate", { url: p.url });
	await p.browser.waitFor(() => !!window.__releases.GET);
	const before = await p.browser.evaluate(() => {
		const host = document.querySelector(".project-workflow-editor");
		const r = host.getBoundingClientRect();
		return {
			spinner: !!host.querySelector('[role="status"][aria-label="Loading"]'),
			text: host.textContent,
			top: r.top,
			height: r.height,
		};
	});
	assert.equal(before.spinner, true);
	assert.doesNotMatch(before.text, /Loading project settings/);
	assert.ok(before.height >= 440);
	await p.browser.evaluate(() => window.__releases.GET());
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-flow .graph"),
	);
	await settled(p);
	const after = await p.browser.evaluate(() => {
		const r = document
			.querySelector(".project-workflow-editor")
			.getBoundingClientRect();
		return {
			top: r.top,
			height: r.height,
			loading: !!document.querySelector('[aria-label="Loading"]'),
		};
	});
	assert.equal(after.loading, false);
	assert.equal(after.top, before.top);
	assert.equal(
		after.height,
		before.height,
		"reserved space prevents a load jump",
	);
});

test("scope S2: All steps is the default panel and edits workflow defaults only", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			titles: [...document.querySelectorAll(".project-settings-side h2")]
				.filter((n) => n.checkVisibility())
				.map((n) => n.textContent),
			old: document
				.querySelector(".management-page")
				.textContent.includes("Common settings"),
		})),
		{ titles: ["All steps"], old: false },
	);
	await set(p, "All steps Executor", "management-fake");
	await set(p, "All steps Effort", "high");
	await saved(p);
	assert.deepEqual(await intent(p), {
		defaults: { executor: "management-fake", effort: "high" },
	});
});

test("scope S3: task scope choice captures resolved settings, removes only its binding and returns with Escape", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			back: document.querySelector('[data-testid="all-tasks-back"]')
				?.textContent,
			choices: [
				...document.querySelectorAll('[name="task-settings-scope"]'),
			].map((n) => ({
				text: n.closest("label").textContent,
				checked: n.checked,
			})),
			fields: [
				...document.querySelectorAll(".role-inspector [data-binding]"),
			].filter((n) => n.checkVisibility()).length,
			old: !!document.querySelector(".binding-actions"),
		})),
		{
			back: "← All steps",
			choices: [
				{ text: "Same as all steps", checked: true },
				{ text: "Custom", checked: false },
			],
			fields: 0,
			old: false,
		},
	);
	const initial = await p.browser.evaluate(
		() =>
			window.__requests.findLast((r) => r.path.endsWith("/preview")).response
				.data.check.data.configuration.slots["iterate.check"],
	);
	await p.browser.click('[name="task-settings-scope"][value="custom"]');
	await settled(p);
	const custom = await p.browser.evaluate(() =>
		window.__requests.findLast((r) => r.path.endsWith("/preview")),
	);
	assert.deepEqual(custom.body.intent.slots["iterate.check"], {
		executor: initial.executor.value,
		model: initial.model.value,
		effort: initial.effort.requested,
	});
	assert.deepEqual(
		["executor", "model", "effort"].map((k) =>
			k === "effort"
				? custom.response.data.check.data.configuration.slots["iterate.check"][
						k
					].resolved
				: custom.response.data.check.data.configuration.slots["iterate.check"][
						k
					].value,
		),
		["executor", "model", "effort"].map((k) =>
			k === "effort" ? initial[k].resolved : initial[k].value,
		),
	);
	await select(p, "nested.check");
	await p.browser.click('[name="task-settings-scope"][value="custom"]');
	await settled(p);
	await select(p, "iterate.check");
	await p.browser.click('[name="task-settings-scope"][value="all"]');
	await settled(p);
	await saved(p);
	assert.equal(Object.hasOwn((await intent(p)).slots, "iterate.check"), false);
	assert.ok(Object.hasOwn((await intent(p)).slots, "nested.check"));
	await p.browser.click('[data-testid="all-tasks-back"]');
	assert.equal(
		await p.browser.evaluate(() =>
			document.querySelector(".project-common").checkVisibility(),
		),
		true,
	);
	await select(p, "iterate.check");
	await p.browser.evaluate(() =>
		document
			.querySelector(".project-workflow-editor")
			.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
	);
	assert.equal(
		await p.browser.evaluate(() =>
			document.querySelector(".project-common").checkVisibility(),
		),
		true,
	);
	assert.equal(
		await p.browser.evaluate(() => document.activeElement.dataset.stage),
		"iterate.check",
	);
});

test("scope S4: graph has current model and effort, Custom marker, and no stale lineage", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	// The full line, not the width-fitted label (fonts differ per OS: "Custom" can render "Cust…").
	const line = () =>
		p.browser.evaluate(() => {
			const text = document.querySelector(
				'.profile-flow [data-stage-line="iterate.check"]',
			);
			return text.dataset.full ?? text.textContent;
		});
	assert.match(await line(), /fixture-model · medium/);
	assert.doesNotMatch(await line(), /source:|origin:|Custom/);
	await select(p, "iterate.check");
	await p.browser.click('[name="task-settings-scope"][value="custom"]');
	await settled(p);
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "Slot iterate.check Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	assert.match(await line(), /Custom/);
	assert.doesNotMatch(await line(), /fixture-model|medium|source:|origin:/);
	await p.browser.evaluate(() => window.__releases.preview());
	await settled(p);
	assert.match(await line(), /fixture-model · high.*Custom/s);
});

test("scope S5: explicit executor changes clear only models excluded by complete available inventories", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	const raw = "legacy/Unlisted";
	await seed(p, {
		defaults: { executor: "management-fake", model: raw, effort: "low" },
		slots: {
			"iterate.check": {
				executor: "management-fake",
				model: raw,
				effort: "medium",
			},
		},
	});
	await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
		const catalogFetch = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]) !== '/api/executors/models') return catalogFetch(...args);
			return new Response(JSON.stringify({data: {executors: [
				{id: 'management-fake', models: ['fixture-model'], modelListComplete: true},
				{id: 'codex', models: ['fixture-model'], modelListComplete: true},
				{id: 'claude', models: ['fixture-model'], modelListComplete: false},
				{id: 'pi', models: null, modelListComplete: true},
				{id: 'antigravity', models: [], modelListComplete: true, error: 'inventory unavailable'}
			]}}), {headers: {'Content-Type': 'application/json'}});
		};`,
	});
	await load(p);
	await refused(p);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Model"]').value,
		),
		raw,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		true,
	);
	for (const id of ["claude", "pi", "antigravity"]) {
		await set(p, "All steps Executor", id);
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelector('[aria-label="All steps Model"]').value,
			),
			raw,
			id,
		);
	}
	await set(p, "All steps Executor", "codex");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Model"]').value,
		),
		"",
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".project-common").textContent,
		),
		/Model cleared/,
	);
	await set(p, "All steps Model", "fixture-model");
	await set(p, "All steps Executor", "management-fake");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Model"]').value,
		),
		"fixture-model",
	);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "codex");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Model"]').value,
		),
		"",
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/Model cleared/,
	);
	await p.browser.waitFor(
		() =>
			window.__requests.findLast((r) => r.path.endsWith("/preview"))?.body
				.intent.slots?.["iterate.check"]?.executor === "codex",
	);
	assert.deepEqual(
		await p.browser.evaluate(
			() =>
				window.__requests.findLast((r) => r.path.endsWith("/preview")).body
					.intent.slots["iterate.check"],
		),
		{ executor: "codex", effort: "medium" },
	);
});

test("scope S6: diagnostics and About are deleted; description and real spec alert remain", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
		const detailFetch = window.fetch;
		window.fetch = async (...args) => {
			const response = await detailFetch(...args);
			if (!new URL(args[0], location.href).pathname.endsWith('/workflows/' + new URLSearchParams(location.search).get('workflow'))) return response;
			const value = await response.json(); value.validation = {error: 'unique real spec problem'};
			return new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
		};`,
	});
	await load(p);
	await settled(p);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			removed: document.querySelectorAll(
				'.management-diagnostics, [data-management-action="check"], [data-testid="saved-launch-check"], .property-table',
			).length,
			// F2 promotes scope titles to h2; diagnostics remain deleted.
			headings: [...document.querySelectorAll(".management-page h2")]
				.filter((n) => n.checkVisibility())
				.map((n) => n.textContent),
			description: document.querySelector(".workflow-description")?.textContent,
			alert: document.querySelector('[data-testid="workflow-spec-problems"]')
				?.textContent,
		})),
		{
			removed: 0,
			headings: ["All steps"],
			description: "No description.",
			alert: "unique real spec problem",
		},
	);
});

test("scope S7: title actions are sticky at the top, show dirty feedback, and have no bottom footer", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			header: !!document.querySelector(".project-workflow-header h1"),
			actions: !!document.querySelector(
				".project-workflow-header .project-workflow-actions",
			),
			bottom: document.querySelectorAll(".profile-editor-actions-sticky")
				.length,
			dirty: document.querySelector('[data-testid="workflow-settings-dirty"]')
				?.hidden,
			disabled: document.querySelector(
				'[data-management-action="save-project-settings"]',
			).disabled,
			position: getComputedStyle(
				document.querySelector(".project-workflow-header") || document.body,
			).position,
		})),
		{
			header: true,
			actions: true,
			bottom: 0,
			dirty: true,
			disabled: true,
			position: "sticky",
		},
	);
	await set(p, "All steps Executor", "management-fake");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			hidden: document.querySelector('[data-testid="workflow-settings-dirty"]')
				.hidden,
			text: document.querySelector('[data-testid="workflow-settings-dirty"]')
				.textContent,
		})),
		{ hidden: false, text: "Unsaved changes" },
	);
	await saved(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="workflow-settings-dirty"]')
					.hidden,
		),
		true,
	);
});

test("automatic settings: meaningful edits calculate without a manual action", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Effort", "high");
	await p.browser.waitFor(
		() =>
			window.__requests.some(
				(r) =>
					r.path.endsWith("/preview") &&
					r.body.intent.slots?.["iterate.check"]?.effort === "high",
			),
		3000,
	);
	await p.browser.waitFor(() =>
		document
			.querySelector('.role-inspector [data-calculated="effort"]')
			.textContent.includes("requested: high"),
	);
	assert.deepEqual(await intent(p), {}, "automatic calculation never persists");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll(".project-workflow-actions button")].map(
				(n) => n.textContent,
			),
		),
		["Save", "Discard changes"],
	);
});

test("automatic settings: same-turn coalescing preserves DOM, open picker, lineage and native options", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.path.endsWith("/preview")).length,
		),
		1,
		"writable initial load calculates once",
	);
	await select(p, "iterate.check");
	await custom(p);
	await p.browser.evaluate(() => {
		window.__beforeCount = window.__requests.filter((r) =>
			r.path.endsWith("/preview"),
		).length;
		window.__holds.preview = true;
		window.__graph = document.querySelector(".profile-flow .graph");
		window.__fitCamera = window.__graph
			.querySelector("g")
			.getAttribute("transform");
		const rect = window.__graph.getBoundingClientRect();
		window.__graph.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: -80,
				ctrlKey: true,
				clientX: rect.x + rect.width / 2,
				clientY: rect.y + rect.height / 2,
				bubbles: true,
				cancelable: true,
			}),
		);
		for (const [label, value] of [
			["Slot iterate.check Executor", "management-fake"],
			["Slot iterate.check Effort", "low"],
			["Slot iterate.check Effort", "high"],
		]) {
			const node = document.querySelector(`[aria-label="${label}"]`);
			node.value = value;
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		}
		window.__common = document.querySelector(".project-common");
		window.__panel = document.querySelector(".role-inspector");
		window.__model = document.querySelector(
			'[aria-label="Slot iterate.check Model"]',
		);
		window.__options = [...window.__model.options];
		document.querySelector(".role-inspector details").open = true;
	});
	await p.browser.waitFor(() => !!window.__releases.preview);
	await p.browser.click('[aria-label="Slot iterate.check Effort"]');
	await p.browser.key("ArrowDown");
	const before = await p.browser.evaluate(() => ({
		active: document.activeElement.getAttribute("aria-activedescendant"),
		scroll: document.querySelector(".management-page").scrollTop,
		camera: document
			.querySelector(".profile-flow .graph > g")
			.getAttribute("transform"),
	}));
	assert.notEqual(
		before.camera,
		await p.browser.evaluate(() => window.__fitCamera),
		"test uses a manually zoomed camera, not the initial fit",
	);
	await p.browser.evaluate(() => window.__releases.preview());
	await settled(p);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			active: document.activeElement.getAttribute("aria-activedescendant"),
			scroll: document.querySelector(".management-page").scrollTop,
			camera: document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		})),
		before,
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			common: window.__common === document.querySelector(".project-common"),
			panel: window.__panel === document.querySelector(".role-inspector"),
			graph: window.__graph === document.querySelector(".profile-flow .graph"),
			model:
				window.__model ===
				document.querySelector('[aria-label="Slot iterate.check Model"]'),
			options: window.__options.every(
				(option, i) => option === window.__model.options[i],
			),
			open: document
				.querySelector('[aria-label="Slot iterate.check Effort"]')
				.getAttribute("aria-expanded"),
			lineage: document.querySelector(".role-inspector details").open,
			count:
				window.__requests.filter((r) => r.path.endsWith("/preview")).length -
				window.__beforeCount,
		})),
		{
			common: true,
			panel: true,
			graph: true,
			model: true,
			options: true,
			open: "true",
			lineage: true,
			count: 1,
		},
	);
	assert.deepEqual(await intent(p), {});
});

test("automatic settings: failure has no same-generation loop, keeps unknown sources and contextual recovery", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	await custom(p);
	await p.browser.evaluate(() => {
		window.__failPreview = true;
		window.__holds.preview = true;
	});
	await set(p, "Slot iterate.check Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	const before = await p.browser.evaluate(() => {
		document.querySelector(".management-page").scrollTop = 500;
		document
			.querySelector('[aria-label="Slot iterate.check Effort"]')
			.focus({ preventScroll: true });
		return {
			scroll: document.querySelector(".management-page").scrollTop,
			focus: document.activeElement.getAttribute("aria-label"),
			camera: document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		};
	});
	await p.browser.evaluate(() => window.__releases.preview());
	await refused(p, "Automatic calculation failed");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			scroll: document.querySelector(".management-page").scrollTop,
			focus: document.activeElement.getAttribute("aria-label"),
			camera: document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		})),
		before,
	);
	const count = await p.browser.evaluate(
		() => window.__requests.filter((r) => r.path.endsWith("/preview")).length,
	);
	assert.equal(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll(".role-inspector [data-calculated]")].every(
				(node) => node.hidden && node.textContent === "",
			),
		),
		true,
	);
	await select(p, "nested.check");
	await select(p, "iterate.check");
	await p.browser.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await new Promise(requestAnimationFrame);
	});
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.path.endsWith("/preview")).length,
		),
		count,
		"inspection and rendering never retry a failed generation",
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Effort"]')
					.value,
		),
		"high",
	);
	await p.browser.click('.project-workflow-header [role="alert"] button');
	await settled(p);
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('.role-inspector [data-calculated="effort"]')
					.textContent,
		),
		/requested: high/,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('.project-workflow-header [role="alert"]')
					.hidden,
		),
		true,
	);
	assert.deepEqual(await intent(p), {});
});

test("automatic settings: pending preview and queued newer draft cannot invalidate Save or reuse old CAS", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await settled(p);
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "All steps Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	const old = tokens((await p.http(p.path)).data.settings);
	await p.browser.evaluate(() => {
		window.__holds.PUT = true;
		const field = document.querySelector('[aria-label="All steps Effort"]');
		field.value = "medium";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	const count = await p.browser.evaluate(
		() => window.__requests.filter((r) => r.path.endsWith("/preview")).length,
	);
	await set(p, "All steps Effort", "low");
	await p.browser.evaluate(() => window.__releases.preview());
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.path.endsWith("/preview")).length,
		),
		count,
		"calculation paused throughout PUT",
	);
	await p.browser.evaluate(() => window.__releases.PUT());
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="workflow-settings-status"]')
			.textContent.startsWith("Submitted settings saved"),
	);
	await settled(p);
	const requests = await p.browser.evaluate(() => window.__requests);
	const puts = requests.filter((r) => r.method === "PUT");
	assert.equal(puts.length, 1);
	assert.deepEqual(puts[0].body.expected, old);
	assert.equal(puts[0].body.intent.defaults.effort, "medium");
	assert.equal((await intent(p)).defaults.effort, "medium");
	const latest = requests.findLast((r) => r.path.endsWith("/preview"));
	assert.equal(latest.body.intent.defaults.effort, "low");
	assert.deepEqual(
		latest.body.expected,
		tokens((await p.http(p.path)).data.settings),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		false,
	);
	await saved(p);
	assert.equal((await intent(p)).defaults.effort, "low");
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.method === "PUT").length,
		),
		2,
	);
});

test("automatic settings: stale failure cannot replace newer success or move focus/scroll", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	await custom(p);
	await p.browser.evaluate(() => {
		window.__failPreview = true;
		window.__holds.preview = true;
	});
	await set(p, "Slot iterate.check Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	await set(p, "Slot iterate.check Effort", "low");
	await settled(p);
	const before = await p.browser.evaluate(() => {
		document.querySelector(".management-page").scrollTop = 500;
		document
			.querySelector('[aria-label="Slot iterate.check Model"]')
			.focus({ preventScroll: true });
		return {
			scroll: document.querySelector(".management-page").scrollTop,
			focus: document.activeElement.getAttribute("aria-label"),
		};
	});
	await p.browser.evaluate(async () => {
		window.__releases.preview();
		await new Promise(requestAnimationFrame);
	});
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			scroll: document.querySelector(".management-page").scrollTop,
			focus: document.activeElement.getAttribute("aria-label"),
		})),
		before,
	);
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('.role-inspector [data-calculated="effort"]')
					.textContent,
		),
		/requested: low/,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('.project-workflow-header [role="alert"]')
					.hidden,
		),
		true,
	);
});

test("automatic settings: failed Save retains newer whole intent, error and old CAS without automatic retry", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await set(p, "All steps Effort", "high");
	await settled(p);
	await p.browser.evaluate(() => {
		window.__failPUT = true;
		window.__holds.PUT = true;
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	await set(p, "All steps Effort", "low");
	await p.browser.evaluate(() => window.__releases.PUT());
	await refused(p, "Save not confirmed");
	assert.deepEqual(await intent(p), {});
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Effort"]').value,
		),
		"low",
	);
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.method === "PUT").length,
		),
		1,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		false,
	);
	await saved(p);
	assert.equal((await intent(p)).defaults.effort, "low");
	const puts = await p.browser.evaluate(() =>
		window.__requests.filter((r) => r.method === "PUT"),
	);
	assert.equal(puts.length, 2);
	assert.deepEqual(
		puts[1].body.expected,
		puts[0].body.expected,
		"failed Save never rebases tokens",
	);
});

test("automatic settings: open dynamic controls use refreshed actual parent without pinning it", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "adaptive.$workerDefaults");
	await p.browser.evaluate(() => {
		window.__dynamicModel = document.querySelector(
			'[aria-label="Slot adaptive.$workerDefaults Model"]',
		);
	});
	await set(p, "All steps Executor", "codex");
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				window.__dynamicModel ===
				document.querySelector(
					'[aria-label="Slot adaptive.$workerDefaults Model"]',
				),
		),
		true,
	);
	await set(p, "Slot adaptive.$workerDefaults Model", "fixture-model");
	await saved(p);
	assert.deepEqual(await intent(p), {
		defaults: { executor: "codex" },
		slots: {
			"adaptive.$workerDefaults": {
				executor: "codex",
				model: "fixture-model",
				effort: "medium",
			},
		},
	});
});

test("automatic settings: Discard cancel keeps draft, confirm reloads authoritative saved data", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await set(p, "All steps Effort", "high");
	await saved(p);
	await set(p, "All steps Effort", "low");
	await settled(p);
	await p.browser.evaluate(() => {
		window.__confirmations = 0;
		window.confirm = () => {
			++window.__confirmations;
			return false;
		};
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	assert.equal(await p.browser.evaluate(() => window.__confirmations), 1);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Effort"]').value,
		),
		"low",
	);
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Effort"]').value,
		),
		"high",
	);
	assert.equal((await intent(p)).defaults.effort, "high");
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.method === "PUT").length,
		),
		1,
		"discard sends no write",
	);
	assert.equal(
		await p.browser.evaluate(
			() => window.__requests.filter((r) => r.method === "DELETE").length,
		),
		0,
	);
});

test("minimal settings: requested clutter is deleted, not folded or hidden", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	// The whole page (including panels after the editor) has rendered.
	await p.browser.waitFor(
		() => !!document.querySelector(".workflow-description"),
	);
	const dom = await p.browser.evaluate(() => ({
		text: document.querySelector(".management-page").textContent,
		removed: document.querySelectorAll(
			'.project-authored, [data-canonical-slot], .project-shared-advanced, [data-testid="workflow-stage-summary"], .property-table.numbered',
		).length,
		about: [...document.querySelectorAll(".management-page h2")].some(
			(node) => node.textContent === "About",
		),
		common: [
			...document.querySelectorAll(
				".project-common h2, .project-common label > span",
			),
		].map((node) => node.textContent),
		commonExtra: document.querySelectorAll(
			".project-common p, .project-common details",
		).length,
		heading: document.querySelector(".management-page h1").textContent,
		topTags: document.querySelectorAll(".management-page > p .tag").length,
		source: document.querySelectorAll(
			'[data-testid="workflow-settings-source"]',
		).length,
		commonClear: document.querySelectorAll('[data-remove-binding="common"]')
			.length,
		commonHints: document.querySelectorAll(".project-common [data-calculated]")
			.length,
		emptyHeadings: [...document.querySelectorAll("h1,h2,h3")].filter(
			(node) => !node.textContent.trim(),
		).length,
	}));
	assert.equal(dom.heading, "canonical-editor");
	assert.equal(dom.topTags, 0);
	assert.equal(dom.source, 0);
	assert.equal(dom.commonClear, 0);
	assert.equal(dom.commonHints, 0);
	assert.equal(dom.emptyHeadings, 0);
	assert.equal(dom.removed, 0, "duplicate task list, shared link, stage table");
	assert.equal(
		dom.about,
		false,
		"description is under the title, not an About section",
	);
	for (const text of [
		"Settings for this project's next new runs",
		"For this workflow's next new Runs in this project. Existing Runs stay unchanged.",
		"Unknown until draft calculation",
		"Execution environment:",
		"manual model IDs supported",
		"Common settings actions",
		"Clear common settings in this draft",
		"Scope and nested Runs",
		"Model authoring",
		"Calculate draft settings",
		"Save project/workflow settings",
		"Cancel / reload",
		"No unsaved changes",
		"Calculate draft settings to refresh unknown values",
		"Expanded authored tasks",
		"Graph edges are compiled dependencies",
		"Advanced: shared profiles",
		"Validation and task summary",
		"Read-only stage summary",
		"Valid specification",
	])
		assert.equal(dom.text.includes(text), false, text);
	assert.deepEqual(dom.common, [
		"All steps",
		"Preset",
		"Executor",
		"Model",
		"Effort",
	]);
	assert.equal(dom.commonExtra, 0);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Effort", "high");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[
				...document.querySelectorAll(
					"[data-calculated], [data-source-lineage]",
				),
			].map((node) => ({ text: node.textContent, hidden: node.hidden })),
		),
		Array.from({ length: 6 }, () => ({ text: "", hidden: true })),
		"stale source values disappear without replacement copy",
	);
	assert.equal(
		await p.browser.evaluate(() =>
			document
				.querySelector(".project-workflow-editor")
				.textContent.includes("Unknown until draft calculation"),
		),
		false,
	);
});

test("minimal settings: executor menu has no empty choice and baseline is not pinned", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await p.browser.click('[aria-label="All steps Executor"]');
	const menu = await p.browser.evaluate(() => {
		const control = document.querySelector('[aria-label="All steps Executor"]');
		return {
			value: control.value,
			options: [
				...document
					.getElementById(control.getAttribute("aria-controls"))
					.querySelectorAll('[role="option"]'),
			].map((node) => ({ value: node.dataset.value, text: node.textContent })),
		};
	});
	assert.equal(menu.value, "");
	assert.ok(menu.options.length > 0);
	assert.ok(
		menu.options.every(
			(option) => option.value && option.text !== "No local binding",
		),
	);
	assert.deepEqual(await intent(p), {});
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		true,
	);
});

for (const failedInventory of [false, true, "request"])
	test(`minimal settings: native model selections preserve saved raw IDs and siblings through refresh (inventory failure=${failedInventory})`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		const raw = "legacy-provider/Raw:unlisted+ID";
		const targetExecutor =
			failedInventory === "request" ? "management-fake" : "codex";
		const initial = {
			defaults: { executor: "management-fake", model: raw, effort: "low" },
			slots: {
				"iterate.check": {
					executor: "management-fake",
					model: `${raw}/task`,
					effort: "medium",
				},
			},
		};
		await seed(p, initial);
		const file = projectWorkflowSettingsPath(p.cwd, { env: p.env });
		const originalBytes = await readFile(file, "utf8");
		if (failedInventory)
			await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
				source: `
			const inventoryFetch = window.fetch;
			window.fetch = async (...args) => {
				const response = await inventoryFetch(...args);
				if (String(args[0]) === '/api/executors/models') {
					if (${failedInventory === "request"}) return new Response(JSON.stringify({error: 'fixture inventory unavailable'}), {status: 503, headers: {'Content-Type':'application/json'}});
					const value = await response.json();
					value.data.executors = [{id: 'codex', models: [], error: 'fixture inventory unavailable'}];
					return new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type':'application/json'}});
				}
				return response;
			};
		`,
			});
		await load(p);
		await refused(p);
		await select(p, "iterate.check");
		const snapshot = () =>
			p.browser.evaluate(() =>
				["All steps", "Slot iterate.check"].map((prefix) => {
					const control = document.querySelector(
						`[aria-label="${prefix} Model"]`,
					);
					return {
						tag: control.tagName,
						value: control.value,
						options: [...(control.options || [])].map((option) => option.value),
						textInputs: control
							.closest("[data-binding]")
							.querySelectorAll(
								'input:not([readonly]), [contenteditable="true"], input[type="search"]',
							).length,
					};
				}),
			);
		let fields = await snapshot();
		for (const [index, value] of [raw, `${raw}/task`].entries()) {
			assert.equal(fields[index].tag, "SELECT");
			assert.equal(fields[index].value, value);
			assert.ok(fields[index].options.includes(value));
			assert.equal(fields[index].textInputs, 0);
		}
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelector(
						'[data-management-action="save-project-settings"]',
					).disabled,
			),
			true,
			"loading unlisted values never dirties or rebinds intent",
		);
		await set(p, "All steps Effort", "high");
		await set(p, "Slot iterate.check Executor", targetExecutor);
		const expectedTaskModel = failedInventory ? `${raw}/task` : "";
		fields = await snapshot();
		assert.deepEqual(
			fields.map((field) => field.value),
			[raw, expectedTaskModel],
		);
		if (failedInventory)
			assert.match(
				await p.browser.evaluate(
					() => document.querySelector(".role-inspector").textContent,
				),
				/fixture inventory unavailable/,
			);
		await select(p, "nested.check");
		await select(p, "iterate.check");
		assert.deepEqual(
			(await snapshot()).map((field) => field.value),
			[raw, expectedTaskModel],
		);
		// The latest calculation's outcome may show or move an alert above Save; a click whose
		// coordinates were read before that missed the button (CI ubuntu/Node 22, 2026-11-17).
		await p.browser.waitFor(
			() =>
				!!window.__requests.findLast((r) => r.path.endsWith("/preview"))
					?.response,
		);
		await p.browser.click('[data-management-action="save-project-settings"]');
		await refused(p, "Save not confirmed");
		assert.deepEqual(
			await p.browser.evaluate(
				() =>
					window.__requests.find((request) => request.method === "PUT").body
						.intent,
			),
			{
				defaults: { ...initial.defaults, effort: "high" },
				slots: {
					"iterate.check": {
						...(failedInventory
							? initial.slots["iterate.check"]
							: { effort: "medium" }),
						executor: targetExecutor,
					},
				},
			},
		);
		assert.equal(
			await readFile(file, "utf8"),
			originalBytes,
			"catalog refusal never changes the legacy store",
		);
		assert.deepEqual(
			(await snapshot()).map((field) => field.value),
			[raw, expectedTaskModel],
		);
		await p.browser.evaluate(() => {
			window.confirm = () => true;
			document.querySelector('[data-testid="project-settings-reload"]').click();
		});
		await refused(p);
		await select(p, "iterate.check");
		assert.deepEqual(
			(await snapshot()).map((field) => field.value),
			[raw, `${raw}/task`],
		);
		assert.equal((await p.http(`${p.base}/runs`)).data.runs.length, 0);
	});

for (const width of [970, 1476])
	test(`layout: full-width page, graph beside sticky settings at ${width}px`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 997,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await load(p);
		await settled(p);
		await p.browser.waitFor(
			() => !!document.querySelector(".workflow-description"),
		);
		const measure = () =>
			p.browser.evaluate(() => {
				const box = (s) =>
					document.querySelector(s).getBoundingClientRect().toJSON();
				return {
					page: box(".management-page"),
					center: box("#center"),
					graph: box(".profile-flow"),
					common: box(".project-common"),
					panel: box(".role-inspector"),
					checkVisible: !!document.querySelector(
						'[data-testid="saved-launch-check"]',
					),
				};
			});
		const before = await measure();
		// Scrolling works anywhere in the center column: the page is not a narrow centred strip.
		assert.ok(
			before.page.left - before.center.left <= 1 &&
				before.center.right - before.page.right <= 1,
			JSON.stringify(before),
		);
		assert.equal(before.checkVisible, false, "Check is deleted");
		if (width === 1476) {
			assert.ok(
				before.common.left >= before.graph.right,
				"settings column sits beside the graph",
			);
			await p.browser.evaluate(() => {
				document.querySelector(".management-page").scrollTop = 400;
			});
			const after = await measure();
			assert.ok(
				// Without sticking it would move up the full 400px and leave the page top.
				after.common.top >= after.page.top &&
					after.common.top >= before.common.top - 400 + 200,
				`settings stay in view while the page scrolls: ${JSON.stringify(after.common)}`,
			);
		} else
			assert.ok(
				before.common.bottom <= before.graph.top,
				"narrow: active settings panel, then the graph",
			);
		assert.deepEqual(await intent(p), {}, "layout never saves");
	});

for (const width of [390, 970, 1476])
	test(`polish: short Save and Discard stay visible through a long editor at ${width}px`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 997,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await load(p);
		await settled(p);
		await set(p, "All steps Executor", "management-fake");
		await set(p, "All steps Effort", "high");
		for (const end of [false, true]) {
			await p.browser.evaluate((end) => {
				const page = document.querySelector(".management-page");
				page.scrollTop = end ? page.scrollHeight : 0;
			}, end);
			const boxes = await p.browser.evaluate(() => {
				const page = document
					.querySelector(".management-page")
					.getBoundingClientRect();
				return [
					...document.querySelectorAll(".project-workflow-actions button"),
				].map((node) => {
					const r = node.getBoundingClientRect();
					return {
						text: node.textContent,
						visible: node.checkVisibility(),
						top: r.top,
						bottom: r.bottom,
						left: r.left,
						right: r.right,
						page: {
							top: page.top,
							bottom: Math.min(page.bottom, innerHeight),
							left: page.left,
							right: page.right,
						},
					};
				});
			});
			for (const box of boxes)
				assert.ok(
					box.visible &&
						box.top >= box.page.top &&
						box.bottom <= box.page.bottom &&
						box.left >= box.page.left &&
						box.right <= box.page.right,
					JSON.stringify(box),
				);
			assert.deepEqual(
				boxes.map((box) => box.text),
				["Save", "Discard changes"],
			);
		}
		assert.deepEqual(await intent(p), {}, "visibility changes never save");
	});

test("polish: baseline pickers replace duplicate resets, automatic calculation and folded saved checks/stage summary", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await p.browser.waitFor(
		() => !!document.querySelector(".workflow-description"),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			resets: document.querySelectorAll("[data-reset-field]").length,
			draftChecks: document.querySelectorAll(
				'[data-testid="project-settings-check"]',
			).length,
			title: document.querySelector(".project-common h2").textContent,
			stageSummary: !!document.querySelector(
				'[data-testid="workflow-stage-summary"]',
			),
			checkFolded: !!document.querySelector(
				'[data-testid="saved-launch-check"]:not([open])',
			),
			buttons: [
				...document.querySelectorAll(".project-workflow-actions button"),
			].map((node) => node.textContent),
		})),
		{
			resets: 0,
			draftChecks: 0,
			title: "All steps",
			stageSummary: false,
			checkFolded: false,
			buttons: ["Save", "Discard changes"],
		},
	);
	await set(p, "All steps Executor", "codex");
	await set(p, "All steps Model", "fixture-model");
	await set(p, "All steps Effort", "high");
	await baseline(p, "All steps Model");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Executor", "Model", "Effort"].map(
				(key) =>
					document.querySelector(`[aria-label="All steps ${key}"]`).value,
			),
		),
		["codex", "", "high"],
	);
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelectorAll(
					'[data-management-action="check"], .management-diagnostics',
				).length,
		),
		0,
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			window.__requests.filter((r) => r.path.endsWith("/check")),
		),
		[],
		"no obsolete Check is submitted",
	);
	assert.deepEqual(await intent(p), {});
});

test("polish: a calculation response never scrolls or focuses a task editor on update", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	await custom(p);
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "Slot iterate.check Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	const before = await p.browser.evaluate(() => {
		const page = document.querySelector(".management-page");
		page.scrollTop = page.scrollHeight;
		document
			.querySelector('[data-testid="project-settings-reload"]')
			.focus({ preventScroll: true });
		return {
			scroll: page.scrollTop,
			camera: document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		};
	});
	assert.match(before.camera, /^translate\([^)]*\) scale\(/);
	await p.browser.evaluate(() => window.__releases.preview());
	await settled(p);
	await p.browser.waitFor(() =>
		document
			.querySelector('.role-inspector [data-calculated="effort"]')
			.textContent.includes("requested: high"),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			scroll: document.querySelector(".management-page").scrollTop,
			camera: document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		})),
		before,
	);
	assert.equal(
		await p.browser.evaluate(() => document.activeElement?.dataset.testid),
		"project-settings-reload",
	);
});

test("implicit ordinary executor immediately reflects model binding", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	const resolved = await p.browser.evaluate(
		() =>
			document
				.querySelector('.role-inspector [data-calculated="executor"]')
				.textContent.split(";")[0],
	);
	await set(p, "Slot iterate.check Model", "fixture-model");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Executor"]')
					.value,
		),
		resolved,
	);
	for (const id of ["nested.peer", "adaptive.$planner"]) {
		await settled(p);
		await select(p, id);
		const actual = await p.browser.evaluate(
			() =>
				document
					.querySelector('.role-inspector [data-calculated="executor"]')
					.textContent.split(";")[0],
		);
		await set(p, `Slot ${id} Effort`, "high");
		assert.equal(
			await p.browser.evaluate(
				(id) =>
					document.querySelector(`[aria-label="Slot ${id} Executor"]`).value,
				id,
			),
			actual,
			`effort-only implicit ${id} binding echoes immediately`,
		);
	}
	assert.equal(
		(await intent(p)).defaults,
		undefined,
		"draft-only inference never pins common settings",
	);
});

for (const width of [970, 1476])
	test(`field hints stay adjacent and explicit selection reveals inspector at ${width}px`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 1000,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await load(p);
		await settled(p);
		await showCodeSteps(p);
		// The graph fits in the first frame after its draw (app.js resize()); sample the camera after it.
		await p.browser.evaluate(
			() =>
				new Promise((done) =>
					requestAnimationFrame(() => requestAnimationFrame(done)),
				),
		);
		const camera = await p.browser.evaluate(() =>
			document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		);
		assert.match(camera, /^translate\([^)]*\) scale\(/);
		await select(p, "constructor");
		await custom(p);
		const lowerGeometry = await p.browser.evaluate(() => {
			const panel = document.querySelector(".role-inspector");
			return [
				...panel.querySelectorAll(
					'h2, [aria-label="Slot constructor Executor"], [aria-label="Slot constructor Model"]',
				),
			].map((n) => {
				const r = n.getBoundingClientRect();
				return { top: r.top, bottom: r.bottom, height: innerHeight };
			});
		});
		for (const rect of lowerGeometry)
			assert.ok(
				rect.top >= 0 && rect.bottom <= rect.height,
				JSON.stringify(lowerGeometry),
			);
		assert.equal(
			lowerGeometry.length,
			3,
			"lower authored selection reveals title and controls",
		);
		await select(p, "iterate.check");
		await custom(p);
		await select(p, "iterate.check");
		const geometry = await p.browser.evaluate(() => {
			const panel = document.querySelector(".role-inspector");
			const title = panel.querySelector("h2").getBoundingClientRect();
			return {
				title: { top: title.top, bottom: title.bottom },
				height: innerHeight,
				fields: [...panel.querySelectorAll("[data-calculated]")].map((hint) => {
					let sibling = hint.nextElementSibling;
					while (sibling.hidden) sibling = sibling.nextElementSibling;
					const field = hint.previousElementSibling.getBoundingClientRect(),
						h = hint.getBoundingClientRect(),
						next = sibling.getBoundingClientRect();
					return {
						name: hint.dataset.calculated,
						fieldBottom: field.bottom,
						hintTop: h.top,
						hintBottom: h.bottom,
						nextTop: next.top,
					};
				}),
			};
		});
		assert.ok(
			geometry.title.top >= 0 && geometry.title.bottom <= geometry.height,
			JSON.stringify(geometry),
		);
		assert.equal(
			await p.browser.evaluate(() => document.activeElement?.dataset.testid),
			"canonical-slot-title",
			"explicit selection focuses the editor without moving the graph camera",
		);
		for (const field of geometry.fields) {
			assert.ok(field.hintTop >= field.fieldBottom - 1, JSON.stringify(field));
			assert.ok(field.hintTop - field.fieldBottom < 30, JSON.stringify(field));
			assert.ok(field.hintBottom <= field.nextTop + 1, JSON.stringify(field));
		}
		assert.equal(
			await p.browser.evaluate(() =>
				document
					.querySelector(".profile-flow .graph > g")
					.getAttribute("transform"),
			),
			camera,
			"explicit selection preserves graph camera",
		);
		assert.deepEqual(
			await graphIds(p),
			(await p.http(p.path)).data.authored.map((node) => node.id).sort(),
			"every authored definition stays selectable in the graph",
		);
		await p.browser.evaluate(() =>
			document
				.querySelector(".project-workflow-editor")
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				),
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelector('[data-testid="canonical-slot-title"]')
						.textContent,
			),
			"All steps",
		);
		assert.equal(
			await p.browser.evaluate(() => document.activeElement?.dataset.stage),
			"iterate.check",
			"Escape restores exact graph focus",
		);
	});

test("canonical editor: expanded nested/foreach/dynamic slots, exact header and structural explanations; real graph camera remains operable", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await showCodeSteps(p);
	const authored = (await p.http(p.path)).data.authored;
	assert.ok(authored.some((node) => node.id === "nested.check"));
	for (const node of authored) {
		await select(p, node.id);
		assert.deepEqual(
			await p.browser.evaluate(() =>
				[
					...document.querySelectorAll(
						'.profile-flow [data-stage][aria-pressed="true"]',
					),
				].map((item) => item.dataset.stage),
			),
			[node.id],
			"graph selection is exposed accessibly",
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					document.querySelector('[data-testid="canonical-slot-title"]')
						.textContent,
			),
			// The panel names the step like the graph does, not by its internal id.
			((text) => text.charAt(0).toUpperCase() + text.slice(1))(
				node.id.replace(/[-_]+/g, " "),
			),
		);
		assert.equal(
			await p.browser.evaluate(
				() =>
					!!document.querySelector('.role-inspector [aria-label$=" Model"]'),
			),
			node.editable,
			node.id,
		);
	}
	assert.deepEqual(
		await graphIds(p),
		authored.map((node) => node.id).sort(),
		"graph covers every authored definition and invents no future workers",
	);
	assert.ok(
		await p.browser.evaluate(
			() =>
				document.querySelectorAll(
					".profile-flow .edge, .profile-flow .link, .profile-flow path",
				).length > 0,
		),
	);
	await select(p, "iterate.check");
	await p.browser.evaluate(() =>
		document
			.querySelector(".project-workflow-editor")
			.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="canonical-slot-title"]')
					.textContent,
		),
		"All steps",
	);
	const controls = await p.browser.evaluate(() =>
		[...document.querySelectorAll(".profile-flow button")].map((node) =>
			node.getAttribute("aria-label"),
		),
	);
	assert.ok(controls.includes("Top-down"));
	assert.ok(controls.includes("Left-right"));
	assert.equal((await p.http(`${p.base}/runs`)).data.runs.length, 0);
});

test("one canonical draft: common and independent peers survive selection; per-field resets retain executor/siblings; full CAS and own special keys save once", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "codex");
	await set(p, "All steps Model", "fixture-model");
	await set(p, "All steps Effort", "high");
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "codex");
	await set(p, "Slot iterate.check Model", "fixture-model");
	await set(p, "Slot iterate.check Effort", "low");
	await select(p, "nested.check");
	await set(p, "Slot nested.check Executor", "codex");
	await set(p, "Slot nested.check Effort", "medium");
	await set(p, "Slot nested.check Model", "fixture-model");
	await baseline(p, "Slot nested.check Effort");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Executor", "Model", "Effort"].map(
				(key) =>
					document.querySelector(`[aria-label="Slot nested.check ${key}"]`)
						.value,
			),
		),
		["codex", "fixture-model", ""],
	);
	for (const id of ["__proto__", "constructor"]) {
		await select(p, id);
		await set(p, `Slot ${id} Executor`, "codex");
		await set(p, `Slot ${id} Model`, "fixture-model");
	}
	await select(p, "iterate.check");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Effort"]')
					.value,
		),
		"low",
	);
	await baseline(p, "Slot iterate.check Model");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Executor", "Model", "Effort"].map(
				(key) =>
					document.querySelector(`[aria-label="Slot iterate.check ${key}"]`)
						.value,
			),
		),
		["codex", "", "low"],
	);
	await settled(p);
	assert.deepEqual(await intent(p), {}, "Preview is not persistence");
	await saved(p);
	const result = await intent(p);
	assert.deepEqual(result.defaults, {
		executor: "codex",
		model: "fixture-model",
		effort: "high",
	});
	assert.deepEqual(result.slots["iterate.check"], {
		executor: "codex",
		effort: "low",
	});
	assert.deepEqual(result.slots["nested.check"], {
		executor: "codex",
		model: "fixture-model",
	});
	assert.ok(Object.hasOwn(result.slots, "__proto__"));
	assert.ok(Object.hasOwn(result.slots, "constructor"));
	assert.equal(Object.hasOwn(result.slots, "iterate.work"), false);
	assert.equal(
		(
			await p.http(
				`${p.base}/workflows/${p.entries.find((e) => e.workflowKey !== p.entry.workflowKey).workflowKey}/settings`,
			)
		).data.settings.present,
		false,
	);
	const requests = await p.browser.evaluate(() =>
		window.__requests.filter((r) => r.method === "PUT"),
	);
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].body.intent, result);
	assert.deepEqual(Object.keys(requests[0].body.expected).sort(), [
		"definitionFingerprint",
		"resolutionToken",
		"revision",
		"storeEpoch",
	]);
});

test("409 and saved legacy unknown values retain complete draft, deliberate reload and task binding removal restore baseline", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await seed(p, {
		slots: {
			"iterate.check": {
				executor: "codex",
				model: "manual-provider/unknown-id",
			},
		},
	});
	await load(p);
	await refused(p);
	await select(p, "iterate.check");
	await select(p, "iterate.work");
	await select(p, "iterate.check");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Model"]').value,
		),
		"manual-provider/unknown-id",
	);
	await p.browser.waitFor(() =>
		[
			...document.querySelectorAll('.project-workflow-header [role="alert"]'),
		].some((n) => n.textContent.includes("Draft retained")),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Model"]').value,
		),
		"manual-provider/unknown-id",
	);
	await set(p, "Slot iterate.check Model", "fixture-model");
	const current = (await p.http(p.path)).data.settings;
	assert.equal(
		(
			await p.http(p.path, {
				method: "PUT",
				body: {
					expected: tokens(current),
					intent: {
						slots: {
							"iterate.check": { executor: "management-fake", effort: "high" },
						},
					},
				},
			})
		).status,
		200,
	);
	await p.browser.click('[data-management-action="save-project-settings"]');
	await p.browser.waitFor(() =>
		[
			...document.querySelectorAll('.project-workflow-header [role="alert"]'),
		].some((n) => n.textContent.includes("Conflict (409)")),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Model"]').value,
		),
		"fixture-model",
	);
	assert.deepEqual((await intent(p)).slots, {
		"iterate.check": { executor: "management-fake", effort: "high" },
	});
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	await settled(p);
	await select(p, "iterate.check");
	await p.browser.click('[name="task-settings-scope"][value="all"]');
	await saved(p);
	assert.deepEqual(await intent(p), { slots: {} });
	await settled(p);
	await select(p, "iterate.check");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/fixture-model; source: author-default/,
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/requested: medium/,
	);
});

test("late preview/save responses cannot replace a newer selection/draft or departed workflow; dirty navigation is guarded", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "All steps Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "management-fake");
	await set(p, "Slot iterate.check Effort", "low");
	await settled(p); // Newer response wins before the held older response is released.
	await p.browser.evaluate(() => {
		window.__releases.preview();
		window.__previewReleased = true;
	});
	// Ordered evaluation after releasing the fetch promise, not a fixed timing sleep.
	await p.browser.evaluate(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="canonical-slot-title"]')
					.textContent,
		),
		"Iterate.check",
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Effort"]')
					.value,
		),
		"low",
	);
	await p.browser.evaluate(() => {
		window.__holds.PUT = true;
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	await p.browser.evaluate(() => {
		window.__confirmations = 0;
		window.confirm = () => {
			++window.__confirmations;
			return false;
		};
		document.querySelector(".back-link").click();
	});
	assert.equal(await p.browser.evaluate(() => window.__confirmations), 1);
	assert.ok(
		await p.browser.evaluate(
			() => !!document.querySelector(".project-workflow-editor"),
		),
	);
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector(".back-link").click();
	});
	await p.browser.waitFor(() => !!document.querySelector(".workflow-cards"));
	assert.equal(
		await p.browser.evaluate(() => typeof window.__releases.PUT),
		"function",
		"in-app departure preserves the document and fences the old continuation",
	);
	await p.browser.evaluate(async () => {
		window.__releases.PUT();
		await new Promise(requestAnimationFrame);
	});
	await p.browser.waitFor(
		() => document.querySelector("#global-progress").hidden,
	);
	assert.equal(
		await p.browser.evaluate(
			() => !!document.querySelector(".project-workflow-editor"),
		),
		false,
	);
	assert.equal(
		(await intent(p)).slots["iterate.check"].effort,
		"low",
		"real save occurred only at captured route",
	);
});

test("late Save completion never blesses or replaces an intervening draft generation", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await set(p, "All steps Effort", "high");
	await p.browser.evaluate(() => {
		window.__holds.PUT = true;
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	// Editing stays available during Save; a newer generation must survive the submitted snapshot.
	await set(p, "All steps Effort", "low");
	await p.browser.evaluate(() => window.__releases.PUT());
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="workflow-settings-status"]')
			.textContent.startsWith("Submitted settings saved"),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="All steps Effort"]').value,
		),
		"low",
	);
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="workflow-settings-status"]')
					.textContent,
		),
		/Unsaved changes/,
	);
	assert.equal(
		(await intent(p)).defaults.effort,
		"high",
		"only submitted intent persisted; newer draft was not silently saved",
	);
	await p.browser.click('[data-management-action="save-project-settings"]');
	await p.browser.waitFor(
		() =>
			document
				.querySelector('[data-testid="workflow-settings-status"]')
				.textContent.startsWith("Settings saved") ||
			document
				.querySelector('.project-workflow-header [role="alert"]')
				.textContent.includes("Conflict (409)"),
	);
	assert.equal(
		(await intent(p)).defaults.effort,
		"low",
		"newer draft saves against the confirmed submitted revision",
	);
});

for (const noNavigation of [false, true]) {
	test(`N4: dirty in-app Back/Forward guard preserves URL, draft and history (Navigation API absent: ${noNavigation})`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		if (noNavigation)
			await p.browser.send("Page.addScriptToEvaluateOnNewDocument", {
				source:
					'Object.defineProperty(window, "navigation", { value: undefined });',
			});
		await load(p);
		await settled(p);
		await p.browser.click(".back-link");
		await p.browser.waitFor(() => !!document.querySelector(".workflow-cards"));
		await p.browser.evaluate(
			(key) =>
				document
					.querySelector(`.workflow-card[data-workflow-key="${key}"]`)
					.click(),
			p.entry.workflowKey,
		);
		await p.browser.waitFor(
			() => !!document.querySelector(".project-workflow-actions"),
		);
		await settled(p);
		await set(p, "All steps Executor", "management-fake");
		await set(p, "All steps Effort", "high");
		await settled(p);
		await p.browser.evaluate(() => {
			window.__draftDocument = "kept";
			window.__draftHref = location.href;
			window.__discardCalls = 0;
			window.confirm = () => {
				window.__discardCalls++;
				return !!window.__allowDiscard;
			};
		});
		assert.equal(
			await p.browser.evaluate(
				() => !dispatchEvent(new Event("beforeunload", { cancelable: true })),
			),
			true,
		);
		await p.browser.evaluate(() => history.back());
		await p.browser.waitFor(
			() => window.__discardCalls === 1 && location.href === window.__draftHref,
		);
		assert.equal(
			await p.browser.evaluate(
				() => document.querySelector('[aria-label="All steps Effort"]').value,
			),
			"high",
		);
		assert.equal(
			await p.browser.evaluate(() => window.__draftDocument),
			"kept",
		);
		await p.browser.evaluate(() => {
			window.__allowDiscard = true;
			history.back();
		});
		await p.browser.waitFor(() => !!document.querySelector(".workflow-cards"));
		assert.equal(
			await p.browser.evaluate(() => window.__discardCalls),
			2,
			"one confirmation per traversal, never a duplicate",
		);
		await p.browser.evaluate(() => history.forward());
		await p.browser.waitFor(
			() => !!document.querySelector(".project-workflow-actions"),
		);
		await settled(p);
		assert.equal(
			await p.browser.evaluate(() => window.__draftDocument),
			"kept",
		);
		assert.equal(
			await p.browser.evaluate(() => window.__discardCalls),
			2,
			"accepted discard leaves no ghost draft",
		);
		assert.equal(
			await p.browser.evaluate(
				() => !dispatchEvent(new Event("beforeunload", { cancelable: true })),
			),
			false,
		);
		assert.deepEqual(await intent(p), {});
	});
}

test("dynamic leaf uses actual parent, never pins/rebinds it; executor changes preserve incompatible intent for explicit review", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	const before = (await p.http(p.path)).data.settings;
	const calculated = await p.http(`${p.path}/preview`, {
		method: "POST",
		body: { expected: tokens(before), intent: {} },
	});
	assert.equal(calculated.status, 200);
	const slot = calculated.data.editableSlots.find(
		(node) => node.id === "adaptive.$workerDefaults",
	);
	assert.ok(slot.parentExecutor);
	await select(p, slot.id);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[aria-label="Slot adaptive.$workerDefaults Executor"]',
				).disabled,
		),
		true,
	);
	await set(p, `Slot ${slot.id} Model`, "fixture-model");
	assert.equal(
		await p.browser.evaluate(
			(id) =>
				document.querySelector(`[aria-label="Slot ${id} Executor"]`).value,
			slot.id,
		),
		slot.parentExecutor,
		"implicit dynamic binding immediately echoes without pinning parent",
	);
	await saved(p);
	assert.deepEqual(await intent(p), {
		slots: {
			[slot.id]: {
				executor: slot.parentExecutor,
				model: "fixture-model",
				effort: "medium",
			},
		},
	});
	assert.equal(
		(await intent(p)).defaults,
		undefined,
		"leaf did not pin parent/common executor",
	);
	const other =
		slot.parentExecutor === "management-fake" ? "codex" : "management-fake";
	await set(p, "All steps Executor", other);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[
				...document.querySelectorAll(
					".role-inspector [data-calculated], .role-inspector [data-source-lineage]",
				),
			].map((node) => ({ text: node.textContent, hidden: node.hidden })),
		),
		Array.from({ length: 6 }, () => ({ text: "", hidden: true })),
		"changed defaults invalidate the displayed parent executor without replacement prose",
	);
	const bytes = await readFile(
		projectWorkflowSettingsPath(p.cwd, { env: p.env }),
		"utf8",
	);
	// The automatic refusal alert grows the header and moves Save (108px -> 175px); a click whose
	// coordinates were read before it appeared misses the button (CI ubuntu/Node 24, 2026-11-17).
	await refused(p, "Automatic calculation failed");
	await p.browser.click('[data-management-action="save-project-settings"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('.project-workflow-header [role="alert"]')
			?.textContent.includes("draft retained"),
	);
	assert.equal(
		await readFile(projectWorkflowSettingsPath(p.cwd, { env: p.env }), "utf8"),
		bytes,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[aria-label="Slot adaptive.$workerDefaults Model"]',
				).value,
		),
		"fixture-model",
	);
	await set(p, "All steps Executor", slot.parentExecutor);
	await settled(p);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "pi");
	await set(p, "Slot iterate.check Model", "fixture-model");
	await set(p, "Slot iterate.check Effort", "high");
	await set(p, "Slot iterate.check Executor", "codex");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Model", "Effort"].map(
				(field) =>
					document.querySelector(`[aria-label="Slot iterate.check ${field}"]`)
						.value,
			),
		),
		["fixture-model", "high"],
	);
});

test("delayed keyed load cannot populate another source/project; same-name cards use independent server keys", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "All steps Executor", "management-fake");
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		window.__holds.GET = true;
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	await p.browser.waitFor(() => !!window.__releases.GET);
	const peer = p.entries.find(
		(entry) => entry.workflowKey !== p.entry.workflowKey,
	);
	await p.browser.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=workflows&workflow=${peer.workflowKey}`,
	});
	await settled(p);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".project-workflow-editor").dataset.workflowKey,
		),
		peer.workflowKey,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				!!document.querySelector('.profile-flow [data-stage="iterate.check"]'),
		),
		false,
	);
	await set(p, "All steps Executor", "management-fake");
	await set(p, "All steps Effort", "low");
	await saved(p);
	assert.deepEqual(await intent(p), {}, "other same-name source untouched");
	const originalBytes = await readFile(
		projectWorkflowSettingsPath(p.cwd, { env: p.env }),
		"utf8",
	);
	await t.test(
		"same definition in a second isolated project",
		async (child) => {
			const q = await open(child);
			await load(q);
			await settled(q);
			await set(q, "All steps Executor", "management-fake");
			await set(q, "All steps Effort", "high");
			await saved(q);
			assert.equal((await intent(q)).defaults.effort, "high");
			assert.equal(
				await readFile(
					projectWorkflowSettingsPath(p.cwd, { env: p.env }),
					"utf8",
				),
				originalBytes,
				"other project bytes unchanged",
			);
		},
	);
	assert.deepEqual(
		await intent(p),
		{},
		"same definition in another project cannot leak intent",
	);
	assert.equal(
		(await p.http(`${p.base}/workflows/${peer.workflowKey}/settings`)).data
			.settings.intent.defaults.effort,
		"low",
	);
});

test("capability refusal remains separate from calculated configuration and explicit Save eligibility", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await seed(p, {
		defaults: { executor: "management-offline", model: "manual-unknown" },
	});
	await load(p);
	await settled(p);
	await set(p, "All steps Effort", "high");
	await settled(p);
	await p.browser.waitFor(() =>
		document
			.querySelector('.project-workflow-header [role="alert"]')
			?.textContent.includes("capability refusal is not a Save result"),
	);
	await select(p, "iterate.check");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/manual-unknown.*source: project-default/,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		),
		false,
	);
	assert.deepEqual(
		await intent(p),
		{ defaults: { executor: "management-offline", model: "manual-unknown" } },
		"Check did not save the changed effort",
	);
	await saved(p);
	assert.equal((await intent(p)).defaults.model, "manual-unknown");
});

test("readonly canonical editor leaves unresolved provenance absent, disables mutations and keeps structural inspection", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t, { readonly: true });
	await load(p);
	await select(p, "nested.check");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot nested.check Model"]')
					.disabled,
		),
		true,
	);
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-testid="workflow-settings-status"]')
					.textContent,
		),
		/Read-only/,
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[
				...document.querySelectorAll(
					".role-inspector [data-calculated], .role-inspector [data-source-lineage]",
				),
			].map((node) => ({ text: node.textContent, hidden: node.hidden })),
		),
		Array.from({ length: 6 }, () => ({ text: "", hidden: true })),
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			window.__requests.filter((r) => r.method !== "GET"),
		),
		[],
	);
	assert.deepEqual(await intent(p), {});
});

for (const width of [390, 970, 1476]) {
	test(`header: calculation and save alerts do not move Save or Discard at ${width}px`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await load(p);
		await settled(p);
		const boxes = () =>
			p.browser.evaluate(() =>
				[
					'[data-management-action="save-project-settings"]',
					'[data-testid="project-settings-reload"]',
				].map((selector) => {
					const { x, y, width, height } = document
						.querySelector(selector)
						.getBoundingClientRect();
					return { x, y, width, height };
				}),
			);
		const shot = async (name) => {
			const dir = process.env.AW_SHOT_DIR;
			if (!dir) return;
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			const { data } = await p.browser.send("Page.captureScreenshot", {
				format: "png",
				clip: { x: 0, y: 0, width, height: 420, scale: 1 },
			});
			await writeFile(
				join(dir, `${name}-${width}.png`),
				Buffer.from(data, "base64"),
			);
		};
		await set(p, "All steps Executor", "management-fake");
		await settled(p);
		await p.browser.evaluate(() => {
			window.__failPreview = true;
			window.__holds.preview = true;
		});
		await set(p, "All steps Effort", "high");
		await p.browser.waitFor(() => !!window.__releases.preview);
		const before = await boxes();
		await p.browser.evaluate(() => window.__releases.preview());
		await refused(p, "Automatic calculation failed");
		await shot("calculation-failed");
		assert.deepEqual(await boxes(), before, "calculation alert moved controls");
		await set(p, "All steps Effort", "low");
		await settled(p);
		const beforeSave = await boxes();
		await p.browser.evaluate(() => {
			window.__failPUT = true;
			document
				.querySelector('[data-management-action="save-project-settings"]')
				.click();
		});
		await refused(p, "Save not confirmed");
		await shot("save-not-confirmed");
		assert.deepEqual(await boxes(), beforeSave, "save alert moved controls");
	});
}

test("code steps: hidden by default, toggled with the Run graph's glide and remembered", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	const state = () =>
		p.browser.evaluate(() => ({
			label: document.querySelector(".profile-flow .code-switch").textContent,
			code: !!document.querySelector('.profile-flow [data-stage="record"]'),
		}));
	assert.match((await state()).label, /hidden/);
	assert.equal((await state()).code, false);
	const animations = await p.browser.evaluate(async () => {
		document.querySelector(".profile-flow .code-switch").click();
		await new Promise((done) =>
			requestAnimationFrame(() => requestAnimationFrame(done)),
		);
		return document.getAnimations().length;
	});
	assert.ok(animations > 0, "the graph glides instead of jumping");
	assert.equal((await state()).code, true);
	assert.equal(
		await p.browser.evaluate(() =>
			localStorage.getItem("agent-workflow:code-steps"),
		),
		"shown",
	);
});

test("step panel: plain name, two short choices, no stray text", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	assert.deepEqual(
		await p.browser.evaluate(() => {
			const panel = document.querySelector(".role-inspector");
			return {
				title: panel.querySelector('[data-testid="canonical-slot-title"]')
					.textContent,
				choices: [...panel.querySelectorAll(".task-settings-scope label")].map(
					(n) => n.textContent.trim(),
				),
				stray: /\bnull\b|undefined|Settings for task/.test(panel.textContent),
			};
		}),
		{
			title: "Iterate.check",
			choices: ["Same as all steps", "Custom"],
			stray: false,
		},
	);
});
