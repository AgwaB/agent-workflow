// test-tier: integration
// Native Chrome, isolated local fixtures; no owner browser or port 58064.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
// Optional third-party audit input, not a runtime/package dependency.
const axeSource = process.env.AGENT_WORKFLOW_AXE_SOURCE;
const complete = "workflow_mvt23704_e8e6d7";
async function browser(t, reduced = false) {
	assert.ok(chrome, "Chrome required");
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setEmulatedMedia", {
		features: [
			{
				name: "prefers-reduced-motion",
				value: reduced ? "reduce" : "no-preference",
			},
		],
	});
	await b.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
	window.__motion = [];
	const animate = Element.prototype.animate;
	Element.prototype.animate = function(frames, options) {
	 const animation = animate.call(this, frames, options);
	 window.__motion.push({target:this.className?.baseVal ?? this.className, frames, options});
	 return animation;
	};
	const fetchOriginal = window.fetch;
	window.fetch = async (...args) => {
	 if (window.__holdSave && args[1]?.method === 'PUT') {
	  window.__holdSave = false;
	  await new Promise(resolve => window.__releaseSave = resolve);
	 }
	 return fetchOriginal(...args);
	};`,
	});
	return b;
}
async function settings(t, reduced = false) {
	const p = await managementProject(t);
	const spec = await profileGraphFixtures(p.cwd);
	// Start with a parallel group in a short canvas: the audit's title/chip collision.
	spec.artifactGraph.stages = spec.artifactGraph.stages.filter(
		(s) => s.id !== "plan",
	);
	for (const s of spec.artifactGraph.stages)
		s.after = (s.after || []).filter((id) => id !== "plan");
	await writeFile(
		join(p.cwd, ".agent-workflow/workflows/model-flow.json"),
		JSON.stringify(spec),
	);
	const b = await browser(t, reduced);
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await b.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=workflows&workflow=model-flow`,
	});
	await b.waitFor(
		() =>
			!!document.querySelector(".profile-flow .node.group") &&
			!!document.querySelector('[aria-label="All tasks Effort"]'),
	);
	await b.waitForMotionEnd();
	return { p, b };
}
async function run(t, reduced = true, view = "runs") {
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await browser(t, reduced);
	await b.open(`${f.origin}/?run=${complete}&view=${view}`);
	if (view === "report")
		await b.waitFor(() => !!document.querySelector("#report-view"));
	else await b.waitFor(() => !!document.querySelector("#canvas .node"));
	return { f, b };
}
async function axe(b) {
	const source = await readFile(axeSource, "utf8");
	await b.send("Runtime.evaluate", { expression: source });
	return b.evaluate(async () =>
		(await window.axe.run(document, { resultTypes: ["violations"] })).violations
			.filter((v) => ["serious", "critical"].includes(v.impact))
			.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
	);
}

test("audit F1/F2/F6: settings graph clears controls, uses h2 and one surface", {
	timeout: 90000,
}, async (t) => {
	const { b } = await settings(t);
	await b.evaluate(() =>
		document.querySelector(".profile-flow .graph").dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: 10000,
				deltaX: 10000,
				bubbles: true,
				cancelable: true,
			}),
		),
	);
	const facts = await b.evaluate(() => {
		const chip = document
			.querySelector(".profile-flow .code-switch")
			.getBoundingClientRect();
		const titles = [
			...document.querySelectorAll(".profile-flow .node-name"),
		].map((n) => n.getBoundingClientRect());
		return {
			overlaps: titles.some(
				(r) =>
					r.left < chip.right &&
					r.right > chip.left &&
					r.top < chip.bottom &&
					r.bottom > chip.top,
			),
			clearance: Math.min(...titles.map((r) => r.top)) - chip.bottom,
			heading: document.querySelector('[data-testid="all-tasks-title"]')
				.tagName,
			nested: !!document.querySelector(".management-card .profile-flow"),
		};
	});
	assert.equal(facts.overlaps, false, "F1 title must clear code switch");
	assert.ok(
		facts.clearance >= 12,
		`F1 reserved chip row: ${JSON.stringify(facts)}`,
	);
	assert.equal(facts.heading, "H2", "F2 heading cannot skip h2");
	assert.equal(facts.nested, false, "F6 graph is not a card inside a card");
});
test("audit F2: settings headings do not skip levels", {
	timeout: 90000,
}, async (t) => {
	const { b } = await settings(t);
	assert.equal(
		await b.evaluate(
			() => document.querySelector('[data-testid="all-tasks-title"]').tagName,
		),
		"H2",
	);
});
test("audit F6: editor is not a nested card", { timeout: 90000 }, async (t) => {
	const { b } = await settings(t);
	assert.equal(
		await b.evaluate(
			() => !!document.querySelector(".management-card .profile-flow"),
		),
		false,
	);
});
test("audit F3: rail has a primary native control, separate report, and whole-row click", {
	timeout: 90000,
}, async (t) => {
	const { b } = await run(t);
	assert.deepEqual(
		await b.evaluate(() => {
			const row = document.querySelector(
				`.run-row[data-run="workflow_mvt23704_e8e6d7"]`,
			);
			return {
				role: row.getAttribute("role"),
				primary: row.querySelector(".run-open")?.tagName,
				nested: row.querySelectorAll('[role="button"] a, button a').length,
			};
		}),
		{ role: null, primary: "BUTTON", nested: 0 },
	);
	await b.evaluate(() =>
		document
			.querySelector('.run-row[data-run="workflow_mvt23704_e8e6d7"] .run-open')
			.focus(),
	);
	await b.key("Enter");
	await b.waitFor(() => !!document.querySelector("#canvas .node"));
	await b.click('.run-row[data-run="workflow_mvt23704_e8e6d7"] .run-report');
	await b.waitFor(() => !!document.querySelector("#report-view"));
});
test("audit F4: grouped graph controls are labelled siblings with keyboard access", {
	timeout: 90000,
}, async (t) => {
	const { b } = await settings(t);
	assert.deepEqual(
		await b.evaluate(() => {
			const node = document.querySelector(".node.group");
			return {
				role: node.getAttribute("role"),
				nested: node.querySelectorAll('[role="button"] [role="button"]').length,
				members: [...node.querySelectorAll(".stage-row")].every(
					(n) =>
						n.getAttribute("tabindex") === "0" &&
						!!n.getAttribute("aria-label"),
				),
			};
		}),
		{ role: "group", nested: 0, members: true },
	);
	await b.evaluate(() =>
		document.querySelector(".node.group .stage-row").focus(),
	);
	await b.key("Enter");
	await b.waitFor(() => !document.querySelector(".role-inspector").hidden);
	await b.key("Escape");
	await b.waitFor(() => !document.querySelector(".project-common").hidden);
});
test("audit F5: overflowing report code is labelled and keyboard scrollable", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await run(t, true, "report");
	f.reports.set(
		complete,
		`# Report\n\n\`\`\`text\n${"wide ".repeat(350)}\n\`\`\``,
	);
	await b.open(`${f.origin}/?run=${complete}&view=report`, 800, 700);
	await b.waitFor(() => !!document.querySelector("#report-view pre"));
	const facts = await b.evaluate(() => {
		const pre = document.querySelector("#report-view pre");
		pre.focus();
		return {
			focus: document.activeElement === pre,
			label: !!pre.getAttribute("aria-label"),
			overflow: pre.scrollWidth > pre.clientWidth,
		};
	});
	assert.deepEqual(facts, { focus: true, label: true, overflow: true });
	await b.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "ArrowRight",
		windowsVirtualKeyCode: 39,
	});
	await b.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "ArrowRight",
		windowsVirtualKeyCode: 39,
	});
	await b.waitFor(
		() => document.querySelector("#report-view pre").scrollLeft > 0,
	);
});
test("audit F7/F8: un-nested full-width workflow list and spaced run context", {
	timeout: 90000,
}, async (t) => {
	const { p, b } = await settings(t);
	await b.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=workflows`,
	});
	await b.waitFor(() => !!document.querySelector(".workflow-card"));
	assert.deepEqual(
		await b.evaluate(() => ({
			nested: !!document.querySelector(".management-card .workflow-card"),
			jargon: document
				.querySelector("#center")
				.textContent.includes("Selected project, shared host actions"),
			paths: [...document.querySelectorAll(".workflow-card")].some(
				(n) =>
					n.textContent.includes("/Users/") || n.textContent.includes("/var/"),
			),
			width:
				document.querySelector(".management-page").clientWidth ===
				document.querySelector("#center").clientWidth,
		})),
		{ nested: false, jargon: false, paths: false, width: true },
	);
	const r = await run(t);
	assert.ok(
		(await r.b.evaluate(() =>
			parseFloat(
				getComputedStyle(document.querySelector(".run-context")).marginTop,
			),
		)) >= 12,
	);
});
test("audit axe: zero serious/critical on settings, runs, run and report", {
	timeout: 90000,
	skip:
		!axeSource &&
		"Set AGENT_WORKFLOW_AXE_SOURCE to the external axe.min.js audit input",
}, async (t) => {
	const s = await settings(t, true);
	const evidence = { settings: await axe(s.b) };
	const r = await run(t, true);
	evidence.run = await axe(r.b);
	await r.b.open(`${r.f.origin}/?view=runs`);
	evidence.runs = await axe(r.b);
	r.f.reports.set(
		complete,
		`# Report\n\n\`\`\`text\n${"wide ".repeat(350)}\n\`\`\``,
	);
	await r.b.open(`${r.f.origin}/?run=${complete}&view=report`, 800, 700);
	await r.b.waitFor(() => !!document.querySelector("#report-view pre"));
	evidence.report = await axe(r.b);
	t.diagnostic(JSON.stringify(evidence));
	assert.deepEqual(evidence, { settings: [], run: [], runs: [], report: [] });
});
for (const reduced of [false, true]) {
	test(`motion M1/M2: picker enter/exit and layout indicator, reduced=${reduced}`, {
		timeout: 90000,
	}, async (t) => {
		const { b } = await settings(t, reduced);
		await b.evaluate(() => {
			window.__motion = [];
			const picker = document.querySelector(
				'[aria-label="All tasks Executor"]',
			);
			picker.focus();
			picker.click();
		});
		let records = await b.evaluate(() =>
			window.__motion.filter((m) => String(m.target).includes("picker-menu")),
		);
		assert.equal(records.length, 1, "M1 opening feedback");
		assert.equal(records[0].options.duration, 160);
		assert.equal(records[0].options.easing, "cubic-bezier(0.16, 1, 0.3, 1)");
		assert.equal(
			records[0].frames.some((f) => !!f.transform),
			!reduced,
		);
		await b.key("Escape");
		records = await b.evaluate(() =>
			window.__motion.filter((m) => String(m.target).includes("picker-menu")),
		);
		assert.equal(records.at(-1).options.duration, 100);
		assert.equal(
			records.at(-1).frames.some((f) => !!f.transform),
			!reduced,
		);
		await b.waitFor(() => document.querySelector(".picker-menu").hidden);
		await b.evaluate(() => {
			window.__motion = [];
			document.querySelector('.profile-flow [aria-label="Left-right"]').click();
		});
		await b.waitFor(
			() => !!document.querySelector('.layout-switch[data-selected="lr"]'),
		);
		const indicator = await b.evaluate(() => ({
			records: window.__motion.filter((m) =>
				String(m.target).includes("layout-indicator"),
			),
			pressed: document
				.querySelector('.profile-flow [aria-label="Left-right"]')
				.getAttribute("aria-pressed"),
		}));
		assert.equal(indicator.pressed, "true");
		assert.equal(indicator.records.length, 1);
		assert.equal(indicator.records[0].options.duration, 200);
		assert.equal(
			indicator.records[0].frames.some((f) => !!f.transform),
			!reduced,
		);
		assert.deepEqual(b.errors, []);
	});
	test(`motion M2: independent layout selection, reduced=${reduced}`, {
		timeout: 90000,
	}, async (t) => {
		const { b } = await settings(t, reduced);
		await b.evaluate(() => {
			window.__motion = [];
			document.querySelector('.profile-flow [aria-label="Left-right"]').click();
		});
		assert.equal(
			await b.evaluate(
				() => !!document.querySelector('.layout-switch[data-selected="lr"]'),
			),
			true,
		);
		const records = await b.evaluate(() =>
			window.__motion.filter((m) =>
				String(m.target).includes("layout-indicator"),
			),
		);
		assert.equal(records.length, 1);
		assert.equal(records[0].options.duration, 200);
		assert.equal(
			records[0].frames.some((f) => !!f.transform),
			!reduced,
		);
	});
	test(`motion M3: project Save states retain size and drafts, reduced=${reduced}`, {
		timeout: 90000,
	}, async (t) => {
		const { b } = await settings(t, reduced);
		const projectSave = '[data-management-action="save-project-settings"]';
		await b.evaluate(() => {
			const n = document.querySelector('[aria-label="All tasks Executor"]');
			n.value = "codex";
			n.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await b.waitFor(
			() =>
				!document.querySelector(
					'[data-management-action="save-project-settings"]',
				).disabled,
		);
		{
			const selector = projectSave;
			const width = await b.evaluate((selector) => {
				window.__holdSave = true;
				const n = document.querySelector(selector);
				const w = n.getBoundingClientRect().width;
				n.click();
				return w;
			}, selector);
			await b.waitFor(() => !!window.__releaseSave);
			const during = await b.evaluate((selector) => {
				const n = document.querySelector(selector);
				return {
					text: n.textContent,
					width: n.getBoundingClientRect().width,
					busy: n.getAttribute("aria-busy"),
					disabled: n.disabled,
				};
			}, selector);
			assert.equal(during.text, "Saving…");
			assert.equal(during.busy, "true");
			assert.equal(during.disabled, true);
			assert.equal(during.width, width);
			await b.evaluate(() => window.__releaseSave());
			await b.waitFor(
				() => !!document.querySelector('[data-save-state="saved"]'),
			);
			const saved = await b.evaluate((selector) => {
				const n = document.querySelector(selector);
				return { text: n.textContent, width: n.getBoundingClientRect().width };
			}, selector);
			assert.equal(saved.text, "Saved ✓");
			assert.equal(saved.width, width);
			await b.waitFor(
				() => !document.querySelector('[data-save-state="saved"]'),
			);
			assert.equal(
				await b.evaluate(
					(selector) => document.querySelector(selector).textContent,
					selector,
				),
				"Save",
			);
		}
		assert.deepEqual(b.errors, []);
	});
}
