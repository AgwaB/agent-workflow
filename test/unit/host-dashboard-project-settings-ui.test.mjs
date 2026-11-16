// test-tier: integration
// Test-owned headless Chrome, real B2 routes, isolated homes/projects and fake executors only.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
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
			response.json = async () => { const data = await json(); request.response = {status: response.status, data}; return data; };
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
async function set(p, label, value) {
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
		`[...document.querySelectorAll('.project-workflow-editor [role="alert"]')].some((node) => !node.hidden && node.textContent.includes(${JSON.stringify(text)}))`,
	);
}

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
			["Common Executor", "management-fake"],
			["Common Effort", "low"],
			["Common Effort", "high"],
		]) {
			const node = document.querySelector(`[aria-label="${label}"]`);
			node.value = value;
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		}
		window.__common = document.querySelector(".project-common");
		window.__panel = document.querySelector(".role-inspector");
		window.__model = document.querySelector('[aria-label="Common Model"]');
		window.__options = [...window.__model.options];
		document.querySelector(".role-inspector details").open = true;
	});
	await p.browser.waitFor(() => !!window.__releases.preview);
	await p.browser.click('[aria-label="Common Effort"]');
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
				document.querySelector('[aria-label="Common Model"]'),
			options: window.__options.every(
				(option, i) => option === window.__model.options[i],
			),
			open: document
				.querySelector('[aria-label="Common Effort"]')
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
	await p.browser.click('.project-workflow-editor [role="alert"] button');
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
				document.querySelector('.project-workflow-editor [role="alert"]')
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
	await set(p, "Common Executor", "management-fake");
	await settled(p);
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "Common Effort", "high");
	await p.browser.waitFor(() => !!window.__releases.preview);
	const old = tokens((await p.http(p.path)).data.settings);
	await p.browser.evaluate(() => {
		window.__holds.PUT = true;
		const field = document.querySelector('[aria-label="Common Effort"]');
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
	await set(p, "Common Effort", "low");
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
				document.querySelector('.project-workflow-editor [role="alert"]')
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
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Effort", "high");
	await settled(p);
	await p.browser.evaluate(() => {
		window.__failPUT = true;
		window.__holds.PUT = true;
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	await set(p, "Common Effort", "low");
	await p.browser.evaluate(() => window.__releases.PUT());
	await refused(p, "Save not confirmed");
	assert.deepEqual(await intent(p), {});
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="Common Effort"]').value,
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
	await set(p, "Common Executor", "codex");
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
			"adaptive.$workerDefaults": { executor: "codex", model: "fixture-model" },
		},
	});
});

test("automatic settings: Discard cancel keeps draft, confirm reloads authoritative saved data", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Effort", "high");
	await saved(p);
	await set(p, "Common Effort", "low");
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
			() => document.querySelector('[aria-label="Common Effort"]').value,
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
			() => document.querySelector('[aria-label="Common Effort"]').value,
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
		() => !!document.querySelector('[data-management-action="check"]'),
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
				".project-common h3, .project-common label > span",
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
	assert.equal(dom.about, true, "workflow description is kept");
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
		"Common settings",
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
	await p.browser.click('[aria-label="Common Executor"]');
	const menu = await p.browser.evaluate(() => {
		const control = document.querySelector('[aria-label="Common Executor"]');
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
				["Common", "Slot iterate.check"].map((prefix) => {
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
		await set(p, "Common Effort", "high");
		await set(p, "Slot iterate.check Executor", targetExecutor);
		fields = await snapshot();
		assert.deepEqual(
			fields.map((field) => field.value),
			[raw, `${raw}/task`],
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
			[raw, `${raw}/task`],
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
						...initial.slots["iterate.check"],
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
			[raw, `${raw}/task`],
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
			() => !!document.querySelector('[data-management-action="check"]'),
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
					checkVisible: document
						.querySelector('[data-testid="saved-launch-check"]')
						.checkVisibility(),
				};
			});
		const before = await measure();
		// Scrolling works anywhere in the center column: the page is not a narrow centred strip.
		assert.ok(
			before.page.left - before.center.left <= 1 &&
				before.center.right - before.page.right <= 1,
			JSON.stringify(before),
		);
		assert.equal(before.checkVisible, false, "Check lives in diagnostics");
		if (width === 1476) {
			assert.ok(
				before.common.left >= before.graph.right &&
					before.panel.left >= before.graph.right &&
					before.panel.top >= before.common.bottom,
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
				before.common.bottom <= before.graph.top &&
					before.graph.bottom <= before.panel.top,
				"narrow: common settings, graph, then the selected task",
			);
		assert.deepEqual(await intent(p), {}, "layout never saves");
	});

for (const width of [970, 1476])
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
		await set(p, "Common Executor", "management-fake");
		await set(p, "Common Effort", "high");
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
		() => !!document.querySelector('[data-management-action="check"]'),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			resets: document.querySelectorAll("[data-reset-field]").length,
			draftChecks: document.querySelectorAll(
				'[data-testid="project-settings-check"]',
			).length,
			title: document.querySelector(".project-common h3").textContent,
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
			title: "Common settings",
			stageSummary: false,
			checkFolded: true,
			buttons: ["Save", "Discard changes"],
		},
	);
	await set(p, "Common Executor", "codex");
	await set(p, "Common Model", "fixture-model");
	await set(p, "Common Effort", "high");
	await baseline(p, "Common Model");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Executor", "Model", "Effort"].map(
				(key) => document.querySelector(`[aria-label="Common ${key}"]`).value,
			),
		),
		["codex", "", "high"],
	);
	await settled(p);
	await p.browser.evaluate(() =>
		[...document.querySelectorAll("button")]
			.find((n) => n.textContent === "Workflow diagnostics")
			.click(),
	);
	await p.browser.click('[data-testid="saved-launch-check"] > summary');
	await p.browser.click('[data-management-action="check"]');
	await p.browser.waitFor(() =>
		window.__requests.some(
			(r) => r.path.endsWith("/check") && !r.path.includes("/settings/"),
		),
	);
	assert.deepEqual(
		await p.browser.evaluate(
			() =>
				window.__requests.find(
					(r) => r.path.endsWith("/check") && !r.path.includes("/settings/"),
				).body,
		),
		{},
		"saved/launch Check never submits unsaved intent",
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
		const camera = await p.browser.evaluate(() =>
			document
				.querySelector(".profile-flow .graph > g")
				.getAttribute("transform"),
		);
		assert.match(camera, /^translate\([^)]*\) scale\(/);
		await select(p, "constructor");
		const lowerGeometry = await p.browser.evaluate(() => {
			const panel = document.querySelector(".role-inspector");
			return [
				...panel.querySelectorAll(
					'h3, [aria-label="Slot constructor Executor"], [aria-label="Slot constructor Model"]',
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
		const geometry = await p.browser.evaluate(() => {
			const panel = document.querySelector(".role-inspector");
			const title = panel.querySelector("h3").getBoundingClientRect();
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
			"Select an authored task",
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
			node.id,
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
		"Select an authored task",
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
	await set(p, "Common Executor", "codex");
	await set(p, "Common Model", "fixture-model");
	await set(p, "Common Effort", "high");
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
			...document.querySelectorAll('.project-workflow-editor [role="alert"]'),
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
			...document.querySelectorAll('.project-workflow-editor [role="alert"]'),
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
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-remove-binding="iterate.check"]').click();
	});
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
	await set(p, "Common Executor", "management-fake");
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
	});
	await set(p, "Common Effort", "high");
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
		"iterate.check",
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
		"undefined",
		"departure destroyed the old response continuation with its document",
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
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Effort", "high");
	await p.browser.evaluate(() => {
		window.__holds.PUT = true;
		document
			.querySelector('[data-management-action="save-project-settings"]')
			.click();
	});
	await p.browser.waitFor(() => !!window.__releases.PUT);
	// Editing stays available during Save; a newer generation must survive the submitted snapshot.
	await set(p, "Common Effort", "low");
	await p.browser.evaluate(() => window.__releases.PUT());
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="workflow-settings-status"]')
			.textContent.startsWith("Submitted settings saved"),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[aria-label="Common Effort"]').value,
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
				.querySelector('.project-workflow-editor [role="alert"]')
				.textContent.includes("Conflict (409)"),
	);
	assert.equal(
		(await intent(p)).defaults.effort,
		"low",
		"newer draft saves against the confirmed submitted revision",
	);
});

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
			[slot.id]: { executor: slot.parentExecutor, model: "fixture-model" },
		},
	});
	assert.equal(
		(await intent(p)).defaults,
		undefined,
		"leaf did not pin parent/common executor",
	);
	const other =
		slot.parentExecutor === "management-fake" ? "codex" : "management-fake";
	await set(p, "Common Executor", other);
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
	await p.browser.click('[data-management-action="save-project-settings"]');
	await p.browser.waitFor(() =>
		document
			.querySelector('.project-workflow-editor [role="alert"]')
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
	await set(p, "Common Executor", "management-fake");
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
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Effort", "low");
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
			await set(q, "Common Executor", "management-fake");
			await set(q, "Common Effort", "high");
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
	await set(p, "Common Effort", "high");
	await settled(p);
	await p.browser.waitFor(() =>
		document
			.querySelector('.project-workflow-editor [role="alert"]')
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
