// test-tier: integration
// Real Chrome and isolated profile storage. No model calls or real user settings.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { profileAction } from "../../dist/hosts/catalog.js";
import { executorPreset } from "../../dist/core/executor-presets.js";
import { overlayExecutorProfile } from "../../dist/core/executor-policy.js";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
import { scanMarks } from "../helpers/dashboard-marks.mjs";

const chrome = await findChrome();
async function open(t, options = {}) {
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t, options);
	await profileGraphFixtures(p.cwd);
	const browser = await createBrowser(chrome);
	t.after(() => browser.close());
	const url = `${p.origin}/?project=${p.server.projectId}&view=profiles&workflow=model-flow`;
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
async function select(browser, key) {
	const stage = {
		planning: "plan",
		verification: "verify-a",
		synthesis: "combine",
		"final-judgment": "final",
		default: "plan",
	}[key];
	if (stage) {
		await browser.waitFor(
			() => !!document.querySelector(".profile-flow .node"),
		);
		await browser.click(`.profile-flow [data-stage="${stage}"]`);
		await browser.waitFor(() => !!document.querySelector(".role-inspector h3"));
		await browser.evaluate((key) => {
			const scope = document.querySelector(
				'[aria-label="Profile setting scope"]',
			);
			if (scope && scope.value !== key) {
				scope.closest("details").open = true;
				scope.value = key;
				scope.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}, key);
	} else {
		await browser.evaluate(() => {
			document.querySelector(".profile-other-roles").open = true;
		});
		await set(browser, "Role to edit", key);
	}
	await browser.waitFor(
		`!!document.querySelector(${JSON.stringify(`[aria-label="Role ${key} Model"]`)})`,
	);
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

test("Profiles Run diagram: selecting is inert, scoped role/agent changes stay local, reset and narrow keyboard editing", {
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
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			cards: document.querySelectorAll("[data-role-card]").length,
			common: document.querySelector('.profile-common [aria-label="Model"]')
				.value,
			collapsed: !document.querySelector(".profile-common").open,
			plan: document.querySelector('[data-stage-line="plan"]').textContent,
			verification: document.querySelector('[data-stage-line="verify-a"]')
				.textContent,
			edges: document.querySelectorAll(".profile-flow .edge").length,
			runtimeBars: document.querySelectorAll(
				".profile-flow .bar, .profile-flow .fraction",
			).length,
			barePanelText: [...document.querySelector(".role-inspector").childNodes]
				.filter((node) => node.nodeType === Node.TEXT_NODE)
				.map((node) => node.textContent.trim())
				.filter(Boolean),
		})),
		{
			cards: 0,
			common: "fixture-model",
			collapsed: true,
			plan: "custom/model-id, max",
			verification: "custom/model-id, max",
			edges: 3,
			runtimeBars: 0,
			barePanelText: [],
		},
	);
	await select(p.browser, "planning");
	await select(p.browser, "synthesis");
	let after = await save(p);
	assert.deepEqual(
		after.roles,
		original.roles,
		"selecting unconfigured nodes/scopes must not write empty role entries",
	);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await set(p.browser, "Role verification Model", "manual/new-model");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector('[data-stage-line="verify-a"]').textContent,
		),
		/custom\/model-id/,
		"the more-specific agent model still wins",
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-note").textContent,
		),
		/Model: agent:reader/,
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
	await p.browser.evaluate(() => {
		document.querySelector(".profile-other-roles").open = true;
		[...document.querySelectorAll(".visual-role-editor button")]
			.find((node) => node.textContent === "Add agent override")
			.click();
	});
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
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
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
	await p.browser.click('.profile-flow .node[data-stage="plan"]');
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
	await p.browser.click('.profile-flow .node[data-stage="combine"]');
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
			document
				.querySelector('.profile-flow .stage-row[data-stage="verify-a"]')
				.focus(),
		);
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
		await p.browser.waitFor(
			() =>
				document.activeElement === document.querySelector(".role-inspector h3"),
		);
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

test("Profiles use the same Run nodes/edges, show shared edits live, and never start a workflow", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 1600,
		height: 1000,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: {
			executor: "codex",
			model: "fixture-model",
			effort: "low",
			roles: { verification: { model: "shared-before" } },
		},
	});
	await list(p);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await p.browser.evaluate(() => {
		window.originalSettingsSvg = document.querySelector(".profile-flow .graph");
	});
	await set(p.browser, "Role verification Model", "manual/shared-after");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			labels: ["verify-a", "verify-b"].map(
				(id) =>
					document.querySelector(`[data-stage-line="${id}"]`).dataset.full,
			),
			secondary: document
				.querySelector('.profile-flow .stage-row[data-stage="verify-b"]')
				.classList.contains("shared-setting"),
			stable:
				window.originalSettingsSvg ===
				document.querySelector(".profile-flow .graph"),
		})),
		{
			labels: ["manual/shared-after, low", "manual/shared-after, low"],
			secondary: true,
			stable: true,
		},
	);
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-note").textContent,
		),
		/2 declared slots in 2 stages/,
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-sharing-note").textContent,
		),
		"Used by Verify a and Verify b. Shared with other workflows on this profile.",
	);
	const shape = await p.browser.evaluate(() => ({
		nodes: [...document.querySelectorAll(".profile-flow .graph .node")].map(
			(node) => [
				node.dataset.stage,
				node.getAttribute("transform"),
				node.querySelector(".outline").getAttribute("width"),
				node.querySelector(".outline").getAttribute("height"),
			],
		),
		rows: [...document.querySelectorAll(".profile-flow .stage-row")].map(
			(node) => node.dataset.stage,
		),
		edges: [...document.querySelectorAll(".profile-flow .edge")].map((edge) =>
			edge.getAttribute("d"),
		),
	}));
	await set(p.browser, "Profile setting scope", "default");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role default Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[aria-label="Role default Model"]').placeholder,
		),
		"Automatic (fixture-model)",
		"default cannot inherit from a higher-precedence role",
	);
	await set(p.browser, "Profile setting scope", "agent:reader");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	await set(p.browser, "Role agent:reader Model", "temporary-agent");
	await set(p.browser, "Role agent:reader Model", "");
	const saved = await save(p);
	assert.equal(
		saved.roles["agent:reader"],
		undefined,
		"clearing an implicit agent scope removes it rather than blocking Save",
	);
	assert.equal(saved.roles.verification.model, "manual/shared-after");
	assert.equal(
		(await p.http(`${p.base}/runs`)).data.runs.length,
		0,
		"settings preview creates no run",
	);
	assert.equal(existsSync(p.effects), false);
	const graph = (await p.http(`${p.base}/workflows/model-flow`)).data.graph;
	// Persist a Run fixture only after verifying preview caused no run/execution.
	const { run } = await persistManagementRun(
		p.cwd,
		"workflow_shape_run",
		"completed",
	);
	const template = run.tasks[0];
	await persistManagementRun(p.cwd, "workflow_shape_run", "completed", {
		name: "model-flow",
		tasks: graph.tasks.map((task, index) => ({
			...template,
			...task,
			taskId: `shape_${index}`,
			status: "completed",
			statusDetail: "completed",
			attempts: 0,
		})),
	});
	const fixtureRun = await p.http(`${p.base}/runs/workflow_shape_run`);
	assert.equal(fixtureRun.status, 200, JSON.stringify(fixtureRun.data));
	await p.browser.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&run=workflow_shape_run`,
	});
	await p.browser.waitFor(
		() => !!document.querySelector('#canvas .node[data-stage="plan"]'),
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			nodes: [...document.querySelectorAll("#canvas .graph .node")].map(
				(node) => [
					node.dataset.stage,
					node.getAttribute("transform"),
					node.querySelector(".outline").getAttribute("width"),
					node.querySelector(".outline").getAttribute("height"),
				],
			),
			rows: [...document.querySelectorAll("#canvas .stage-row")].map(
				(node) => node.dataset.stage,
			),
			edges: [...document.querySelectorAll("#canvas .edge")].map((edge) =>
				edge.getAttribute("d"),
			),
		})),
		shape,
		"same authored workflow produces the Run renderer's exact node/row/edge geometry",
	);
	assert.deepEqual(p.browser.errors, []);
	assert.equal(existsSync(p.effects), false);
});

test("Profile diagrams keep code read-only, expose declared loop slots and recover from stale/failed workflow loads", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", model: "fixture-model" },
	});
	await list(p);
	await edit(p.browser, "daily");
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-flow .code-switch"),
	);
	await p.browser.click(".profile-flow .code-switch");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="record"]'),
	);
	assert.equal(
		await p.browser.evaluate(() =>
			document.activeElement.matches(".profile-flow .code-switch"),
		),
		true,
		"code toggle retains focus after redraw",
	);
	await p.browser.click('.profile-flow .node[data-stage="record"]');
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/runs code, not a model/,
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelectorAll(".role-inspector input").length,
		),
		0,
	);
	await set(p.browser, "Profile workflow", "expanding-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="iterate"]'),
	);
	assert.deepEqual(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll(".profile-flow .node")].map(
				(node) => node.dataset.stage,
			),
		),
		["iterate", "adaptive", "final"],
	);
	await p.browser.click('.profile-flow .node[data-stage="iterate"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile stage slot"]'),
	);
	await set(p.browser, "Profile stage slot", "iterate.check");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Model"]'),
	);
	await set(p.browser, "Role verification Model", "loop-check/model");
	await p.browser.key("Escape");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").textContent,
		),
		/Select a node/,
	);
	// The first request ignores abort deliberately; its late response must not replace B.
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (url, options) => {
			if (String(url).endsWith("/workflows/model-flow")) {
				window.fetch = original;
				await new Promise((resolve) => {
					window.releaseDiagram = resolve;
				});
				const response = await original(url, { ...options, signal: undefined });
				await response.clone().json();
				window.diagramCompleted = true;
				return response;
			}
			return original(url, options);
		};
	});
	await set(p.browser, "Profile workflow", "model-flow");
	await p.browser.waitFor(() => !!window.releaseDiagram);
	await set(p.browser, "Profile workflow", "expanding-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="iterate"]'),
	);
	await p.browser.evaluate(() => window.releaseDiagram());
	await p.browser.waitFor(() => window.diagramCompleted);
	await p.browser.evaluate(async () => {
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		);
	});
	assert.equal(
		await p.browser.evaluate(
			() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
		),
		false,
	);
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith("/workflows/model-flow")) {
				window.fetch = original;
				throw new Error("fixture diagram failure");
			}
			return original(...args);
		};
	});
	await set(p.browser, "Profile workflow", "model-flow");
	await p.browser.waitFor(
		() =>
			document.querySelector('.profile-flow [role="alert"]')?.textContent ===
			"fixture diagram failure",
	);
	assert.equal(
		await p.browser.evaluate(
			() => !!document.querySelector('.profile-flow [role="status"]'),
		),
		false,
	);
	await p.browser.click("[data-workflow-graph-retry]");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="plan"]'),
	);
	await p.browser.evaluate(() => {
		const timeout = AbortSignal.timeout;
		AbortSignal.timeout = () => {
			AbortSignal.timeout = timeout;
			return AbortSignal.abort(
				new DOMException("fixture graph timeout", "TimeoutError"),
			);
		};
	});
	await set(p.browser, "Profile workflow", "expanding-flow");
	await p.browser.waitFor(
		() =>
			document.querySelector('.profile-flow [role="alert"]')?.textContent ===
			"fixture graph timeout",
	);
	await p.browser.click("[data-workflow-graph-retry]");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="iterate"]'),
	);
	const after = await save(p);
	assert.equal(
		after.roles.verification.model,
		"loop-check/model",
		"switching diagrams/closing the inspector does not discard drafts",
	);
	assert.deepEqual(p.browser.errors, []);
	assert.equal(existsSync(p.effects), false);
});

test("Saving while the diagram loads keeps a stable layout and cannot resurrect the editor", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", model: "fixture-model" },
	});
	await list(p);
	await edit(p.browser, "daily");
	await p.browser.waitFor(
		() => !!document.querySelector(".profile-flow .node"),
	);
	await p.browser.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (url, options) => {
			if (String(url).includes("/workflows/")) {
				window.fetch = original;
				await new Promise((resolve) => {
					window.releasePendingGraph = resolve;
				});
				const response = await original(url, { ...options, signal: undefined });
				window.pendingGraphCompleted = true;
				return response;
			}
			return original(url, options);
		};
	});
	await set(p.browser, "Profile workflow", "expanding-flow");
	await p.browser.waitFor(() => !!window.releasePendingGraph);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector(".profile-flow").getBoundingClientRect()
					.height >= 440,
		),
		true,
		"loading reserves the diagram's space",
	);
	await set(p.browser, "Effort", "high");
	const after = await save(p);
	assert.equal(after.effort, "high");
	await p.browser.evaluate(() => window.releasePendingGraph());
	await p.browser.waitFor(() => window.pendingGraphCompleted);
	await p.browser.evaluate(async () => {
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		);
	});
	await waitList(p.browser);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".profile-editor").hidden,
		),
		true,
	);
	assert.equal(existsSync(p.effects), false);
	assert.deepEqual(p.browser.errors, []);
});

test("Readonly profile diagrams remain navigable without enabling model writes", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t, { readonly: true });
	const values = {
		executor: "codex",
		model: "fixture-model",
		roles: { verification: { model: "read-only-model" } },
	};
	await profileAction(p.ctx, { op: "set", name: "daily", values });
	await list(p);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	assert.equal(
		await p.browser.evaluate(() =>
			[...document.querySelectorAll(".role-inspector input")].every(
				(input) => input.disabled,
			),
		),
		true,
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				document.querySelector('[data-management-action="save-profile"]')
					.disabled,
		),
		true,
	);
	await set(p.browser, "Profile workflow", "expanding-flow");
	await p.browser.waitFor(
		() => !!document.querySelector('.profile-flow .node[data-stage="iterate"]'),
	);
	await p.browser.click('.profile-flow .node[data-stage="iterate"]');
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Profile stage slot"]'),
	);
	assert.deepEqual(
		(await profileAction(p.ctx, { op: "show", name: "daily" })).data.profile
			.roles,
		values.roles,
	);
	assert.equal((await p.http(`${p.base}/runs`)).data.runs.length, 0);
	assert.equal(existsSync(p.effects), false);
	assert.deepEqual(p.browser.errors, []);
});

test("Shared profile UX identifies the setting, not the clicked verification node", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: {
			executor: "codex",
			model: "fixture-model",
			roles: { verification: { model: "shared-original" } },
		},
	});
	await list(p);
	await edit(p.browser, "daily");
	await select(p.browser, "synthesis");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-sharing-note").textContent,
		),
		"Used by Combine. Shared with other workflows on this profile.",
	);
	await set(p.browser, "Profile setting scope", "agent:reader");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role agent:reader Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-sharing-note").textContent,
		),
		"Used by 5 steps here. Shared with other workflows on this profile.",
	);
	await p.browser.click(".profile-scope-options > summary");
	await select(p.browser, "research-execution");
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-sharing-note").textContent,
		),
		"Not used by the steps shown here.",
	);
	assert.equal(
		await p.browser.evaluate(
			() =>
				!document.querySelector('[aria-label="Profile setting scope"]') &&
				!document.querySelector(".profile-scope-note").checkVisibility(),
		),
		true,
	);
	await p.browser.click(".profile-scope-options > summary");
	assert.equal(
		await p.browser.evaluate(() =>
			document.querySelector(".profile-scope-note").checkVisibility(),
		),
		true,
	);
	await p.browser.click(".profile-scope-options > summary");
	await select(p.browser, "verification");
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			header: document.querySelector(".profile-flow-header h2").textContent,
			label: document
				.querySelector('[aria-label="Profile workflow"]')
				.closest("label").firstChild.textContent,
			footnote: document.querySelector(".role-map-note").textContent,
			inheritance: document.querySelector(".role-inheritance").textContent,
			common: document.querySelector(".profile-common p").textContent,
		})),
		{
			header: "Models by step",
			label: "Show on",
			footnote:
				"Preview, not a run. A workflow or launch option can override these settings.",
			inheritance: "Empty fields use the default.",
			common: "Empty fields use the default. Applies to future runs.",
		},
	);
	assert.doesNotMatch(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector").innerText,
		),
		/Shared model settings|declared slot|Run diagram|inherit/i,
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector h3").textContent,
		),
		"Verification",
	);
	assert.deepEqual(
		await p.browser.evaluate(() => ({
			label: document.querySelector(".role-panel-label")?.textContent || null,
			notice: document.querySelector(".role-sharing-note")?.textContent,
			scopeOpen: document.querySelector(".profile-scope-options")?.open,
			noteVisible: document
				.querySelector(".profile-scope-note")
				.checkVisibility(),
			scopeVisible: document
				.querySelector('[aria-label="Profile setting scope"]')
				.checkVisibility(),
		})),
		{
			label: null,
			notice:
				"Used by Verify a and Verify b. Shared with other workflows on this profile.",
			scopeOpen: false,
			scopeVisible: false,
			noteVisible: false,
		},
	);
	await p.browser.evaluate(() =>
		document.querySelector(".role-inspector h3").focus(),
	);
	await p.browser.key("Tab");
	assert.equal(
		await p.browser.evaluate(() =>
			document.activeElement.getAttribute("aria-label"),
		),
		"Role verification Executor",
		"main keyboard path goes straight to settings",
	);
	await set(p.browser, "Role verification Model", "manual/shared-ux");
	await p.browser.click('.profile-flow .stage-row[data-stage="verify-b"]');
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Role verification Model"]')
				?.value === "manual/shared-ux",
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".role-inspector h3").textContent,
		),
		"Verification",
	);
	await p.browser.click(".profile-scope-options > summary");
	assert.equal(
		await p.browser.evaluate(() =>
			document
				.querySelector('[aria-label="Profile setting scope"]')
				.checkVisibility(),
		),
		true,
	);
	await set(p.browser, "Profile setting scope", "default");
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role default Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-options").open,
		),
		true,
		"changing scope does not close its disclosure",
	);
	// Closing then selecting in one task must not let the old queued toggle reopen it.
	await p.browser.evaluate(() => {
		document.querySelector(".profile-scope-options").open = false;
		document
			.querySelector('.profile-flow .stage-row[data-stage="verify-a"]')
			.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await p.browser.waitFor(
		() => !!document.querySelector('[aria-label="Role verification Model"]'),
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-options").open,
		),
		false,
		"the last user close survives immediate node selection",
	);
	const saved = await save(p);
	assert.deepEqual(
		saved.roles,
		{ verification: { model: "manual/shared-ux" } },
		"one shared role, no verify-a/verify-b keys or implicit default entry",
	);
	assert.equal(existsSync(p.effects), false);
	assert.deepEqual(p.browser.errors, []);
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
	// Exercise the same hints on actual workflow nodes in the executor-default editor.
	await edit(p.browser, "codex");
	await select(p.browser, "planning");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-note").textContent,
		),
		/Model: Built-in/,
	);
	await set(p.browser, "Effort", "low");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".profile-scope-note").textContent,
		),
		/effort: Common setting/,
	);
	await select(p.browser, "verification");
	await set(p.browser, "Role verification Executor", "claude");
	assert.match(
		await p.browser.evaluate(
			() => document.querySelector(".role-inheritance").textContent,
		),
		/not used by codex stage defaults/,
	);
	assert.equal(
		await p.browser.evaluate(
			() => document.querySelector('[data-stage-line="verify-a"]').textContent,
		),
		"gpt-5.6-luna, low",
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

test("Fresh narrow profile preview keeps the code switch clear of nodes and stage rows", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", model: "fixture-model" },
	});
	await p.browser.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: false,
	});
	for (const workflow of ["model-flow", "deep-research"]) {
		const url = new URL(p.url);
		url.searchParams.set("workflow", workflow);
		url.searchParams.set("profile", "daily");
		await p.browser.send("Page.navigate", { url: url.href });
		await p.browser.waitFor(
			() => !!document.querySelector(".profile-flow .code-switch"),
		);
		for (const action of ["initial fit", "Fit button", "Fit key"]) {
			if (action === "Fit button")
				await p.browser.click('.profile-flow button[title="Fit graph"]');
			if (action === "Fit key")
				await p.browser.evaluate(() => {
					const canvas = document.querySelector(".profile-flow .canvas");
					canvas.dispatchEvent(
						new KeyboardEvent("keydown", { key: "f", bubbles: true }),
					);
				});
			await p.browser.evaluate(
				() =>
					new Promise((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(resolve)),
					),
			);
			assert.deepEqual(
				await p.browser.evaluate(() => {
					const chip = document
						.querySelector(".profile-flow .code-switch")
						.getBoundingClientRect();
					return [
						...document.querySelectorAll(
							".profile-flow .graph .node, .profile-flow .node-name, .profile-flow .stage-row",
						),
					]
						.filter((node) => {
							const box = node.getBoundingClientRect();
							return (
								chip.left < box.right &&
								chip.right > box.left &&
								chip.top < box.bottom &&
								chip.bottom > box.top
							);
						})
						.map((node) => ({
							stage: node.closest("[data-stage]")?.dataset.stage,
							kind: node.getAttribute("class"),
						}));
				}),
				[],
				`${workflow}: chip intersects no node, title or stage row after ${action}`,
			);
			assert.equal(
				await p.browser.evaluate(() => {
					const chip = document
						.querySelector(".profile-flow .code-switch")
						.getBoundingClientRect();
					const node = document.querySelector(".profile-flow .graph .node");
					return (
						node.getBoundingClientRect().top >= chip.bottom &&
						node.querySelector(".node-name").getBoundingClientRect().top >=
							chip.bottom
					);
				}),
				true,
				`${workflow}: first node and title are below the chip after ${action}`,
			);
		}
	}
	assert.deepEqual(p.browser.errors, []);
});

test("Profile Save stays reachable without covering picker options or keyboard focus", {
	timeout: 120000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: { executor: "codex", model: "fixture-model" },
	});
	await list(p);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	for (const [width, height] of [
		[1600, 1000],
		[390, 844],
	]) {
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false,
		});
		assert.equal(
			await p.browser.evaluate(() => {
				const page = document.querySelector(".management-page");
				page.scrollTop = 0;
				const bar = document.querySelector(".profile-editor-actions-sticky");
				const box = page.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.x + box.width / 2,
					box.bottom - 2,
				);
				return hit === bar || bar.contains(hit);
			}),
			true,
			`${width}: sticky bar covers the scrollport bottom`,
		);
		assert.equal(
			await p.browser.evaluate(() => {
				const panel = document.querySelector(".role-inspector");
				return (
					panel.querySelector("h3").getBoundingClientRect().top -
						panel.getBoundingClientRect().top <=
					24
				);
			}),
			true,
			`${width}: inspector title starts at panel padding`,
		);
		assert.equal(
			await p.browser.evaluate(() => {
				const page = document.querySelector(".management-page");
				page.scrollTop = page.scrollHeight;
				const last = document.querySelector(".profile-options > summary");
				const box = last.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.x + box.width / 2,
					box.y + box.height / 2,
				);
				return (
					box.top >= 0 &&
					box.bottom <= innerHeight &&
					(hit === last || last.contains(hit))
				);
			}),
			true,
			`${width}: final Profile options remains visible and hit-testable`,
		);
		for (const theme of ["light", "dark"]) {
			await p.browser.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: theme }],
			});
			assert.equal(
				await p.browser.evaluate(() => {
					const page = document.querySelector(".management-page");
					page.scrollTop = 0;
					const save = document.querySelector(
						'[data-management-action="save-profile"]',
					);
					const box = save.getBoundingClientRect();
					return (
						box.top >= 0 &&
						box.bottom <= innerHeight &&
						document.elementFromPoint(
							box.x + box.width / 2,
							box.y + box.height / 2,
						) === save
					);
				}),
				true,
				`${width} ${theme}: Save at top`,
			);
			await p.browser.evaluate(() => {
				document.querySelector(".profile-common").open = true;
			});
			for (const label of ["Role verification Effort", "Model"]) {
				await p.browser.click(`[aria-label="${label}"]`);
				assert.equal(
					await p.browser.evaluate((label) => {
						const input = document.querySelector(`[aria-label="${label}"]`);
						const menu = document.getElementById(
							input.getAttribute("aria-controls"),
						);
						const box = menu.getBoundingClientRect();
						return (
							!menu.hidden &&
							box.height > 0 &&
							box.top >= 0 &&
							box.bottom <= innerHeight
						);
					}, label),
					true,
					`${width} ${theme}: ${label} menu visible`,
				);
				assert.deepEqual(
					await p.browser.evaluate((label) => {
						const input = document.querySelector(`[aria-label="${label}"]`);
						const menu = document.getElementById(
							input.getAttribute("aria-controls"),
						);
						const bounds = menu.getBoundingClientRect();
						return [...menu.querySelectorAll('[role="option"]')]
							.filter((option) => {
								const box = option.getBoundingClientRect();
								const x = box.x + box.width / 2,
									y = box.y + box.height / 2;
								return (
									y >= bounds.top &&
									y <= bounds.bottom &&
									y >= 0 &&
									y < innerHeight &&
									document.elementFromPoint(x, y) !== option
								);
							})
							.map((option) => option.textContent);
					}, label),
					[],
					`${width} ${theme}: ${label} options hit-testable`,
				);
				await p.browser.key("Escape");
			}
			await p.browser.evaluate(() => {
				document.querySelector(".profile-options").open = true;
				document.querySelector(".role-inspector h3").focus();
			});
			let reachedOptions = false;
			for (let i = 0; i < 35; i++) {
				await p.browser.key("Tab");
				const focus = await p.browser.evaluate(() => {
					const node = document.activeElement,
						box = node.getBoundingClientRect();
					const hit = document.elementFromPoint(
						box.x + box.width / 2,
						box.y + box.height / 2,
					);
					return {
						visible:
							box.top >= 0 &&
							box.bottom <= innerHeight &&
							(hit === node || node.contains(hit)),
						options: !!node.closest(".profile-options"),
					};
				});
				assert.equal(
					focus.visible,
					true,
					`${width} ${theme}: Tab ${i} visible`,
				);
				if (focus.options) {
					reachedOptions = true;
					break;
				}
			}
			assert.equal(reachedOptions, true);
		}
	}
	await save(p);
	for (const [width, height] of [
		[1600, 1000],
		[390, 844],
	]) {
		await p.browser.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false,
		});
		assert.equal(
			await p.browser.evaluate(() => {
				const status = document.querySelector(".profile-save-status");
				const page = document.querySelector(".management-page");
				page.scrollTop = page.scrollHeight;
				const box = status.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.x + box.width / 2,
					box.y + box.height / 2,
				);
				return (
					box.top >= 0 &&
					box.bottom <= innerHeight &&
					(hit === status || status.contains(hit))
				);
			}),
			true,
		);
	}
	assert.deepEqual(p.browser.errors, []);
});

test("Profile slot hints only borrow Common values for a compatible executor", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await list(p);
	const actual = await p.browser.evaluate(async () => {
		const { profileSlotPreview } = await import("./app.js");
		const common = { executor: "claude", model: "sonnet", effort: "high" };
		const slot = { roleKeys: ["verification", "default"] };
		return [
			profileSlotPreview(
				slot,
				{ verification: { executor: "codex" } },
				{ common },
			),
			profileSlotPreview(
				slot,
				{ verification: { executor: "claude" } },
				{ common },
			),
			profileSlotPreview(slot, {}, { common }),
			profileSlotPreview(
				slot,
				{ verification: { executor: "codex" } },
				{
					common: { model: "m", effort: "high" },
				},
			),
			profileSlotPreview(slot, {}, { common: { model: "m", effort: "high" } }),
			profileSlotPreview(
				slot,
				{
					verification: { executor: "codex" },
					default: { model: "m-any" },
				},
				{ common },
			),
			profileSlotPreview(
				slot,
				{
					verification: { executor: "codex" },
					default: { executor: "claude", model: "m-claude", effort: "low" },
				},
				{ common },
			),
			profileSlotPreview(
				slot,
				{},
				{
					executor: "codex",
					common: { model: "executor-model", effort: "low" },
					baseline: { verification: { model: "built-in", effort: "high" } },
				},
			),
		];
	});
	assert.deepEqual(actual, [
		{ values: { executor: "codex" }, sources: { executor: "verification" } },
		{
			values: { executor: "claude", model: "sonnet", effort: "high" },
			sources: { executor: "verification", model: "Common", effort: "Common" },
		},
		{
			values: { executor: "claude", model: "sonnet", effort: "high" },
			sources: { executor: "Common", model: "Common", effort: "Common" },
		},
		{ values: { executor: "codex" }, sources: { executor: "verification" } },
		{
			values: { model: "m", effort: "high" },
			sources: { model: "Common", effort: "Common" },
		},
		{
			values: { executor: "codex", model: "m-any" },
			sources: { executor: "verification", model: "default" },
		},
		{ values: { executor: "codex" }, sources: { executor: "verification" } },
		{
			values: { executor: "codex", model: "executor-model", effort: "low" },
			sources: {
				executor: "verification",
				model: "Common setting",
				effort: "Common setting",
			},
		},
	]);
});

async function hintState(browser) {
	return browser.evaluate(() => ({
		...Object.fromEntries(
			["Executor", "Model", "Effort"].map((field) => {
				const input = document.querySelector(
					`[aria-label="Role verification ${field}"]`,
				);
				return [field, { value: input.value, placeholder: input.placeholder }];
			}),
		),
		label: document.querySelector('[data-stage-line="verify-a"]').dataset.full,
		scope: document.querySelector(".profile-scope-note").textContent,
	}));
}
async function chooseAutomatic(browser, field) {
	await browser.click(`[aria-label="Role verification ${field}"]`);
	await browser.waitFor(
		() => !!document.querySelector('.role-inspector [role="option"]'),
	);
	await browser.evaluate((field) => {
		const picker = document
			.querySelector(`[aria-label="Role verification ${field}"]`)
			.closest(".management-picker");
		const option = [...picker.querySelectorAll('[role="option"]')].find(
			(entry) => entry.textContent === "Automatic",
		);
		if (!option) throw new Error("Missing Automatic option");
		option.click();
	}, field);
	await browser.waitFor(
		`document.querySelector(${JSON.stringify(`[aria-label="Role verification ${field}"]`)})?.value === ""`,
	);
}

test("Profile unset hints keep the draft executor and save only the cleared model", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	const common = { executor: "claude", model: "sonnet", effort: "high" };
	await profileAction(p.ctx, {
		op: "set",
		name: "daily",
		values: {
			...common,
			roles: {
				verification: {
					executor: "codex",
					model: "fixture-model",
					effort: "high",
				},
			},
		},
	});
	await list(p);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await chooseAutomatic(p.browser, "Model");
	let state = await hintState(p.browser);
	assert.equal(state.Executor.value, "codex");
	assert.equal(state.Model.placeholder, "Automatic");
	assert.equal(state.label, "Automatic model, high");
	assert.doesNotMatch(state.label, /sonnet/);
	assert.doesNotMatch(state.scope, /Model: Common/);
	const saved = await save(p);
	assert.deepEqual(saved.roles.verification, {
		executor: "codex",
		effort: "high",
	});
	for (const [field, value] of Object.entries(common))
		assert.equal(saved[field], value);
	await edit(p.browser, "daily");
	await select(p.browser, "verification");
	await chooseAutomatic(p.browser, "Effort");
	state = await hintState(p.browser);
	assert.equal(state.Effort.placeholder, "Automatic");
	assert.equal(state.label, "Automatic");
	await chooseAutomatic(p.browser, "Executor");
	state = await hintState(p.browser);
	assert.equal(state.Executor.placeholder, "Automatic (claude)");
	assert.equal(state.Model.placeholder, "Automatic (sonnet)");
	assert.equal(state.Effort.placeholder, "Automatic (high)");
	assert.equal(state.label, "sonnet, high");
	await set(p.browser, "Role verification Executor", "claude");
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Role verification Executor"]')
				?.value === "claude",
	);
	assert.equal(
		(await hintState(p.browser)).Model.placeholder,
		"Automatic (sonnet)",
	);
	await set(p.browser, "Role verification Executor", "codex");
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Role verification Executor"]')
				?.value === "codex",
	);
	await set(p.browser, "Role verification Model", "fixture-model");
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Role verification Model"]')
				?.value === "fixture-model",
	);
	assert.equal(
		(await hintState(p.browser)).label,
		"fixture-model, automatic effort",
	);
});

for (const [name, values, expected] of [
	[
		"executor-free lower key",
		{
			executor: "claude",
			model: "sonnet",
			roles: {
				default: { model: "m-any" },
				verification: { executor: "codex" },
			},
		},
		"Automatic (m-any)",
	],
	[
		"foreign lower key",
		{
			executor: "claude",
			model: "sonnet",
			roles: {
				default: { executor: "claude", model: "m-claude" },
				verification: { executor: "codex" },
			},
		},
		"Automatic",
	],
	[
		"Common without executor",
		{ model: "m", roles: { verification: { executor: "codex" } } },
		"Automatic",
	],
]) {
	test(`Profile model placeholder respects ${name}`, {
		timeout: 90000,
	}, async (t) => {
		const p = await open(t);
		await profileAction(p.ctx, { op: "set", name: "lower-hints", values });
		await list(p);
		await edit(p.browser, "lower-hints");
		await select(p.browser, "verification");
		assert.equal((await hintState(p.browser)).Model.placeholder, expected);
	});
}

test("Profile unset hints keep the selected preset executor without creating an override", {
	timeout: 90000,
}, async (t) => {
	const p = await open(t);
	await profileAction(p.ctx, {
		op: "set",
		name: "preset-hints",
		values: { executor: "claude", model: "sonnet", effort: "high" },
	});
	const before = (
		await profileAction(p.ctx, {
			op: "show",
			name: "preset-hints",
		})
	).data.profile;
	await list(p);
	await edit(p.browser, "preset-hints");
	await set(p.browser, "Profile preset", "pi");
	await select(p.browser, "default");
	await p.browser.waitFor(
		() =>
			document.querySelector('[aria-label="Profile setting scope"]')?.value ===
				"default" &&
			!!document.querySelector('[aria-label="Role default Model"]') &&
			document.querySelector('[aria-label="Role default Executor"]')?.value ===
				"pi",
	);
	const state = await p.browser.evaluate(() => ({
		executor: document.querySelector('[aria-label="Role default Executor"]')
			.value,
		model: document.querySelector('[aria-label="Role default Model"]').value,
		placeholder: document.querySelector('[aria-label="Role default Model"]')
			.placeholder,
		resetDisabled: document.querySelector("[data-role-reset]").disabled,
	}));
	assert.equal(state.executor, "pi");
	assert.equal(state.model, "");
	assert.equal(
		state.resetDisabled,
		true,
		"selecting must not create an override",
	);
	assert.deepEqual(
		(await profileAction(p.ctx, { op: "show", name: "preset-hints" })).data
			.profile,
		before,
		"without pressing Save the profile on disk stays unchanged",
	);
	assert.equal(state.placeholder, "Automatic");
});
