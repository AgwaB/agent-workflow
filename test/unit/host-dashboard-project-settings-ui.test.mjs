// test-tier: integration
// Test-owned headless Chrome, real B2 routes, isolated homes/projects and fake executors only.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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
			if (path.includes('/settings') || path.endsWith('/check')) window.__requests.push({path, method: options.method || 'GET', body: options.body && JSON.parse(options.body)});
			const response = await originalFetch(...args);
			const op = path.endsWith('/preview') ? 'preview' : path.endsWith('/settings') ? (options.method || 'GET') : '';
			if (window.__holds[op]) { window.__holds[op] = false; await new Promise(resolve => { window.__releases[op] = resolve; }); }
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
			() =>
				!!document.querySelector('[data-testid="project-settings-preview"]'),
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
		() => !!document.querySelector('[data-canonical-slot="iterate.check"]'),
	);
}
async function settled(p) {
	await p.browser.waitFor(() =>
		document
			.querySelector('[data-testid="workflow-settings-status"]')
			?.textContent.includes("Calculated preview"),
	);
}
async function select(p, id) {
	await p.browser.click(`[data-canonical-slot="${id}"]`);
}
async function set(p, label, value) {
	await p.browser.evaluate(
		(label, value) => {
			const node = document.querySelector(
				`[aria-label="${CSS.escape(label)}"]`,
			);
			if (!node) throw new Error(`Missing ${label}`);
			if (node.disabled) throw new Error(`Disabled ${label}`);
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

for (const width of [970, 1476])
	test(`polish: scoped Save and draft status stay visible through a long editor at ${width}px`, {
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
					...document.querySelectorAll(
						'[data-management-action="save-project-settings"], [data-testid="workflow-settings-status"]',
					),
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
			assert.match(
				boxes[0].text + boxes[1].text,
				/project\/workflow|this project/,
			);
			assert.match(boxes[0].text + boxes[1].text, /Unsaved changes/);
		}
		assert.deepEqual(await intent(p), {}, "visibility changes never save");
	});

test("polish: baseline pickers replace duplicate resets, one draft calculation and folded saved checks/stage summary", {
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
			stagesFolded: !!document.querySelector(
				'[data-testid="workflow-stage-summary"]:not([open])',
			),
			checkFolded: !!document.querySelector(
				'[data-testid="saved-launch-check"]:not([open])',
			),
			preview: document.querySelector(
				'[data-testid="project-settings-preview"]',
			).textContent,
		})),
		{
			resets: 0,
			draftChecks: 0,
			title: "Common settings",
			stagesFolded: true,
			checkFolded: true,
			preview: "Calculate draft settings",
		},
	);
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Model", "fixture-model");
	await set(p, "Common Effort", "high");
	await baseline(p, "Common Model");
	assert.deepEqual(
		await p.browser.evaluate(() =>
			["Executor", "Model", "Effort"].map(
				(key) => document.querySelector(`[aria-label="Common ${key}"]`).value,
			),
		),
		["management-fake", "", "high"],
	);
	await p.browser.click('[data-testid="project-settings-preview"]');
	await settled(p);
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
		document.querySelector('[data-testid="project-settings-preview"]').click();
	});
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
	await p.browser.waitFor(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						resolve(
							document
								.querySelector('[data-testid="workflow-settings-status"]')
								.textContent.includes("Calculated preview"),
						),
					),
				),
			),
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
		await p.browser.click('[data-testid="project-settings-preview"]');
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
					const field = hint.previousElementSibling.getBoundingClientRect(),
						h = hint.getBoundingClientRect(),
						next = hint.nextElementSibling.getBoundingClientRect();
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
		assert.ok(
			await p.browser.evaluate(
				() => document.querySelectorAll("[data-canonical-slot]").length > 10,
			),
			"expanded definitions stay available",
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
						'[data-canonical-slot][aria-pressed="true"]',
					),
				].map((item) => item.dataset.canonicalSlot),
			),
			[node.id],
			"authored selection is exposed accessibly",
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
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelectorAll("[data-canonical-slot]").length,
		),
		authored.length,
		"no invented future workers",
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
	await set(p, "Common Executor", "management-fake");
	await set(p, "Common Model", "fixture-model");
	await set(p, "Common Effort", "high");
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "management-fake");
	await set(p, "Slot iterate.check Model", "fixture-model");
	await set(p, "Slot iterate.check Effort", "low");
	await select(p, "nested.check");
	await set(p, "Slot nested.check Executor", "management-fake");
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
		["management-fake", "fixture-model", ""],
	);
	for (const id of ["__proto__", "constructor"]) {
		await select(p, id);
		await set(p, `Slot ${id} Executor`, "management-fake");
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
		["management-fake", "", "low"],
	);
	await p.browser.click('[data-testid="project-settings-preview"]');
	await settled(p);
	assert.deepEqual(await intent(p), {}, "Preview is not persistence");
	await saved(p);
	const result = await intent(p);
	assert.deepEqual(result.defaults, {
		executor: "management-fake",
		model: "fixture-model",
		effort: "high",
	});
	assert.deepEqual(result.slots["iterate.check"], {
		executor: "management-fake",
		effort: "low",
	});
	assert.deepEqual(result.slots["nested.check"], {
		executor: "management-fake",
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

test("409 and manual unknown values retain complete draft, deliberate reload and binding removal restore baseline", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "management-fake");
	await set(p, "Slot iterate.check Model", "manual-provider/unknown-id");
	await select(p, "iterate.work");
	await select(p, "iterate.check");
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Slot iterate.check Model"]').value,
		),
		"manual-provider/unknown-id",
	);
	await p.browser.click('[data-testid="project-settings-preview"]');
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
					intent: { defaults: { executor: "management-fake", effort: "high" } },
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
	assert.equal((await intent(p)).slots, undefined);
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-testid="project-settings-reload"]').click();
	});
	await settled(p);
	await p.browser.evaluate(() => {
		window.confirm = () => true;
		document.querySelector('[data-remove-binding="common"]').click();
	});
	await saved(p);
	assert.deepEqual(await intent(p), {});
	await p.browser.click('[data-testid="project-settings-preview"]');
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
	await set(p, "Common Effort", "high");
	await p.browser.evaluate(() => {
		window.__holds.preview = true;
		document.querySelector('[data-testid="project-settings-preview"]').click();
	});
	await p.browser.waitFor(() => !!window.__releases.preview);
	await select(p, "iterate.check");
	await set(p, "Slot iterate.check Executor", "management-fake");
	await set(p, "Slot iterate.check Effort", "low");
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
	// Inert prevents human edits during Save; inject a deterministic intervening input to exercise the generation fence too.
	await set(p, "Common Effort", "low");
	await p.browser.evaluate(() => window.__releases.PUT());
	await p.browser.waitFor(
		() => !document.querySelector(".project-common").parentElement.inert,
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
	assert.match(
		await p.browser.evaluate(
			() =>
				document.querySelector('.role-inspector [role="status"]').textContent,
		),
		/actual parent executor: unknown; Preview required/,
		"changed defaults invalidate the displayed parent executor",
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
	await set(p, "Slot iterate.check Executor", "management-fake");
	await set(p, "Slot iterate.check Model", "manual/keep-this-id");
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
		["manual/keep-this-id", "high"],
	);
});

test("delayed keyed load cannot populate another source/project; same-name cards use independent server keys", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await load(p);
	await settled(p);
	await p.browser.evaluate(() => {
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
			() => !!document.querySelector('[data-canonical-slot="iterate.check"]'),
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
	await load(p);
	await settled(p);
	await set(p, "Common Executor", "management-offline");
	await set(p, "Common Model", "manual-unknown");
	await p.browser.click('[data-testid="project-settings-preview"]');
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
	assert.deepEqual(await intent(p), {}, "Check did not save");
	await saved(p);
	assert.equal((await intent(p)).defaults.model, "manual-unknown");
});

test("readonly canonical editor truthfully exposes unknown provenance, disables mutations and keeps structural inspection", {
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
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/Unknown \/ not calculated/,
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			window.__requests.filter((r) => r.method !== "GET"),
		),
		[],
	);
	assert.deepEqual(await intent(p), {});
});
