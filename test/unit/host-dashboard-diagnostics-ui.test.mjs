// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";
const chrome = await findChrome();

// Contract-shaped Doctor stale-index response, not an actual 51-run reproduction.
test("F: stale index hint has a subject and real zero counts remain diagnostic facts", {
	timeout: 60000,
}, async (t) => {
	const hint =
		"run `agent-workflow prune` to preview the cleanup, then `agent-workflow prune --yes`";
	const { b } = await setup(
		t,
		{
			"/api/doctor": {
				data: {
					executors: [],
					runIndex: { entries: 51, stale: 1, dangling: 0, prunable: 0, hint },
				},
			},
		},
		"executors",
	);
	await b.waitFor(() => !!document.querySelector(".executors"));
	const normal = await b.evaluate(
		() => document.querySelector(".management-page").innerText,
	);
	assert.ok(normal.includes(`Run index: ${hint}`), normal);
	await click(b, "Executor diagnostics");
	const diagnostic = await b.evaluate(() => ({
		text: document.querySelector(".management-diagnostics").innerText,
		keys: [...document.querySelectorAll(".management-diagnostics dt")].map(
			(n) => n.textContent,
		),
	}));
	assert.ok(diagnostic.text.includes(hint));
	for (const key of ["entries", "stale", "dangling", "prunable"])
		assert.ok(diagnostic.keys.includes(key), key);
	assert.match(diagnostic.text, /prunable\s+0/);
});
const opts = { timeout: 60000 };
async function setup(t, data, view = "workflows&workflow=manage") {
	assert.ok(chrome, "Chrome required");
	const p = await managementProject(t);
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
 const original = window.fetch; window.checkBodies = []; window.checkPaths = [];
 const fixtures = ${JSON.stringify(data)};
 window.fetch = async (url, options) => {
  const workflowKey = new URLSearchParams(location.search).get("workflow");
  const key = Object.keys(fixtures).find(k => String(url).includes(k.replace(":workflowKey", workflowKey)));
  if (!key) return original(url, options);
  if (String(url).endsWith('/check')) { window.checkBodies.push(JSON.parse(options.body)); window.checkPaths.push(String(url)); }
  return new Response(JSON.stringify(fixtures[key]), {headers:{'Content-Type':'application/json'}});
 };
 })();`,
	});
	await b.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=${view}`,
	});
	await b.waitFor(() => !!document.querySelector(".management-page"));
	if (view.startsWith("workflows&workflow="))
		await b.waitFor(
			() =>
				!!document.querySelector(
					'[data-management-action="save-project-settings"]',
				),
		);
	return { b, p };
}
async function click(b, text) {
	await b.evaluate((text) => {
		const n = [...document.querySelectorAll("#center button")].find(
			(n) => n.textContent === text,
		);
		if (!n) throw Error(`Missing ${text}`);
		n.click();
	}, text);
}
async function set(b, label, value) {
	await b.evaluate(
		(label, value) => {
			const n = document.querySelector(`[aria-label="${label}"]`);
			n.value = value;
			n.dispatchEvent(new Event("input", { bubbles: true }));
			n.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}

test(
	"D workflow page deletes Check and diagnostic payloads, retaining ordinary scope editing",
	opts,
	async (t) => {
		const { b } = await setup(t, {
			"/workflows/:workflowKey/check": {
				text: "must not render",
				data: { secret: "unused diagnostics" },
			},
		});
		assert.deepEqual(
			await b.evaluate(() => ({
				checks: window.checkPaths,
				removed: document.querySelectorAll(
					".management-diagnostics, .saved-launch-check, .check-overrides, [data-management-action='check']",
				).length,
				scope: document.querySelector(".project-common h3").textContent,
			})),
			{ checks: [], removed: 0, scope: "All tasks" },
		);
		await set(b, "All tasks Executor", "codex");
		await set(b, "All tasks Effort", "high");
		assert.equal(
			await b.evaluate(
				() =>
					document.querySelector(
						'[data-management-action="save-project-settings"]',
					).disabled,
			),
			false,
		);
		assert.deepEqual(await b.evaluate(() => window.checkPaths), []);
	},
);

test(
	"D Executors retain unusable-default source, index failure and hint without invented check time",
	opts,
	async (t) => {
		const data = {
			executors: [
				{
					id: "antigravity",
					usable: false,
					state: "logged-out",
					fix: "Log in",
				},
			],
			defaultExecutor: {
				id: "antigravity",
				source: "user-profile",
				profile: "blocked-default",
				usable: false,
				reason: 'The default saved user profile "blocked-default" selects it.',
			},
			runIndex: {
				entries: 0,
				stale: 0,
				dangling: 0,
				error: "unreadable index (Unexpected end of JSON input)",
				hint: "agent-workflow runs prune --dry-run",
				path: "/fixture/index",
				prunable: 0,
			},
		};
		const { b } = await setup(t, { "/api/doctor": { data } }, "executors");
		await b.waitFor(() => !!document.querySelector(".executors"));
		const text = await b.evaluate(
			() => document.querySelector(".management-page").innerText,
		);
		assert.match(text, /not ready/i);
		assert.match(text, /blocked-default/);
		assert.match(text, /unreadable index \(Unexpected end of JSON input\)/);
		assert.match(text, /agent-workflow runs prune --dry-run/);
		assert.doesNotMatch(
			text,
			/Runs use antigravity|0 entries, 0 stale, 0 dangling|Checked \d/,
		);
		await click(b, "Executor diagnostics");
		const diagnostics = await b.evaluate(
			() => document.querySelector(".management-diagnostics").innerText,
		);
		for (const value of [
			"user-profile",
			"blocked-default",
			data.defaultExecutor.reason,
			data.runIndex.error,
			data.runIndex.hint,
			"/fixture/index",
		])
			assert.ok(diagnostics.includes(value), value);
		const keys = await b.evaluate(() =>
			[...document.querySelectorAll(".management-diagnostics dt")].map(
				(n) => n.textContent,
			),
		);
		for (const key of ["entries", "stale", "dangling", "prunable"])
			assert.ok(!keys.includes(key), key);
	},
);

// Profile model controls and their warning-only catalog path are deleted, not hidden.
test(
	"D Profiles omits catalog warnings and retains hidden manual model/role values on permission Save",
	opts,
	async (t) => {
		const { b, p } = await setup(
			t,
			{
				"/api/executors/models": {
					data: {
						executors: [
							{
								id: "codex",
								state: "probe-failed",
								usable: false,
								error: "must not render",
								models: ["listed"],
								modelListComplete: true,
							},
						],
					},
				},
			},
			"profiles",
		);
		const values = {
			executor: "codex",
			model: "manual/retained",
			effort: "low",
			roles: { "agent:future-role": { model: "unknown/role" } },
			permissionMode: "safe",
		};
		await profileAction(p.ctx, { op: "set", name: "manual-warning", values });
		await b.send("Page.navigate", {
			url: `${p.origin}/?project=${p.server.projectId}&view=profiles&profile=manual-warning`,
		});
		await b.waitFor(
			() => !!document.querySelector('[data-management-action="save-profile"]'),
		);
		assert.equal(
			await b.evaluate(
				() =>
					document.querySelectorAll(
						'.profile-editor [aria-label="Executor"], .profile-editor [aria-label="Model"], .profile-editor [aria-label="Effort"], .profile-editor [data-effort-note]',
					).length,
			),
			0,
		);
		assert.doesNotMatch(
			await b.evaluate(
				() => document.querySelector(".profile-editor").innerText,
			),
			/must not render|complete model list|not available here/,
		);
		await set(b, "Profile permission mode", "free");
		await b.click('[data-management-action="save-profile"]');
		await b.waitFor(() => !!document.querySelector(".profile-save-status"));
		const stored = (
			await profileAction(p.ctx, { op: "show", name: "manual-warning" })
		).data.profile;
		for (const key of ["executor", "model", "effort", "roles"])
			assert.deepEqual(stored[key], values[key]);
		assert.equal(stored.permissionMode, "free");
	},
);
