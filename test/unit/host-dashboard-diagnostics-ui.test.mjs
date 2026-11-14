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
 const original = window.fetch; window.checkBodies = [];
 const fixtures = ${JSON.stringify(data)};
 window.fetch = async (url, options) => {
  const key = Object.keys(fixtures).find(k => String(url).includes(k));
  if (!key) return original(url, options);
  if (String(url).endsWith('/check')) window.checkBodies.push(JSON.parse(options.body));
  return new Response(JSON.stringify(fixtures[key]), {headers:{'Content-Type':'application/json'}});
 };
 })();`,
	});
	await b.send("Page.navigate", {
		url: `${p.origin}/?project=${p.server.projectId}&view=${view}`,
	});
	await b.waitFor(() => !!document.querySelector(".management-page"));
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
	"D model exceptions: real catalog states, exact complete-list aliases and live associations",
	opts,
	async (t) => {
		const base = {
			usable: true,
			state: "ready",
			models: ["provider/alpha", "beta", "a/b/c"],
			modelListComplete: true,
			effortLevels: ["low", "high"],
			modelEfforts: { "provider/alpha": ["low"] },
		};
		const entries = [
			{ ...base, id: "ready" },
			{
				...base,
				id: "missing",
				usable: false,
				state: "not-installed",
				models: null,
			},
			{ ...base, id: "logout", usable: false, state: "logged-out" },
			{
				...base,
				id: "broken",
				usable: false,
				state: "probe-failed",
				error: "probe <failed>",
			},
			{ ...base, id: "partial", modelListComplete: false },
			{ ...base, id: "null", models: null },
		];
		const { b } = await setup(t, {
			"/api/executors/models": { data: { executors: entries } },
			"/workflows/manage/check": {
				text: "Simulated check; no run started",
				data: {},
			},
		});
		await b.waitFor(() => !!document.querySelector('[aria-label="Executor"]'));
		await click(b, "Check different settings");
		const note = () =>
			b.evaluate(() =>
				[...document.querySelectorAll(".check-overrides small")]
					.filter((n) => !n.hidden)
					.map((n) => n.textContent)
					.join("\n"),
			);
		for (const [id, pattern] of [
			["missing", /not installed/i],
			["logout", /log in|not logged in/i],
			["broken", /probe <failed>/],
			["future", /Unknown executor: future/],
		]) {
			await set(b, "Executor", id);
			assert.match(await note(), pattern);
			const linked = await b.evaluate(() =>
				["Executor", "Model"].every((label) => {
					const n = document.querySelector(`[aria-label="${label}"]`);
					return n
						.getAttribute("aria-describedby")
						?.split(/\s+/)
						.some((id) => {
							const m = document.getElementById(id);
							return (
								m?.getAttribute("role") === "status" &&
								m.textContent &&
								!m.hidden
							);
						});
				}),
			);
			assert.equal(linked, true);
		}
		await set(b, "Executor", "ready");
		assert.equal(await note(), "");
		await b.evaluate(() => {
			const n = document.querySelector('[aria-label="Model"]');
			n.setAttribute("aria-describedby", "other-description");
		});
		for (const value of [
			"alpha",
			"provider/alpha",
			"beta",
			"other/beta",
			"b/c",
			"a/b/c",
			"c",
		]) {
			await set(b, "Model", value);
			assert.equal(await note(), "", value);
		}
		for (const value of ["other/alpha", "other/c", " alpha", "manual-id"]) {
			await set(b, "Model", value);
			assert.match(
				await note(),
				/not in ready's complete model list\./i,
				value,
			);
			assert.doesNotMatch(await note(), /launch refuses/i, value);
			assert.equal(
				await b.evaluate(
					() => document.querySelector('[aria-label="Model"]').value,
				),
				value,
			);
		}
		assert.ok(
			await b.evaluate(() =>
				document
					.querySelector('[aria-label="Model"]')
					.getAttribute("aria-describedby")
					.includes("other-description"),
			),
		);
		await set(b, "Executor", "partial");
		assert.equal(
			await b.evaluate(() =>
				document
					.querySelector('[aria-label="Model"]')
					.getAttribute("aria-describedby"),
			),
			"other-description",
		);
		await set(b, "Model", "arbitrary/manual");
		assert.equal(await note(), "");
		await set(b, "Executor", "null");
		await set(b, "Model", "arbitrary/manual");
		assert.equal(await note(), "");
		await set(b, "Executor", "ready");
		await set(b, "Effort", "high");
		await set(b, "Model", "provider/alpha");
		assert.match(await note(), /high is not available/);
		assert.equal(
			await b.evaluate(() => {
				const n = document.querySelector('[aria-label="Effort"]');
				return document
					.getElementById(n.getAttribute("aria-describedby"))
					?.getAttribute("role");
			}),
			"status",
		);
		await set(b, "Effort", "low");
		assert.equal(await note(), "");
		await set(b, "Effort", "high");
		await set(b, "Effort", "");
		assert.equal(await note(), "");
		assert.equal(
			await b.evaluate(() =>
				document
					.querySelector('[aria-label="Effort"]')
					.hasAttribute("aria-describedby"),
			),
			false,
		);
		await set(b, "Model", "manual-id");
		await b.click('[data-management-action="check"]');
		await b.waitFor(
			() =>
				document.querySelector(".management-result") ||
				document.querySelector(".management-error"),
		);
		// The warning does not clear/reject the submitted manual model.
		assert.equal(
			await b.evaluate(
				() => document.querySelector('[aria-label="Model"]').value,
			),
			"manual-id",
		);
	},
);

test(
	"D Check diagnostics preserve exact keys, empty values, primitive arrays and override state",
	opts,
	async (t) => {
		const extra = {
			"final-judgment": "x",
			my_role: "y",
			"provider/model": false,
			zero: 0,
			emptyArray: [],
			emptyObject: {},
			emptyString: "",
			literal: "<img src=x onerror=bad()>",
			list: ["first", false, 0, ""],
		};
		const { b } = await setup(t, {
			"/workflows/manage/check": {
				text: "No model call",
				data: {
					capability: {
						preview:
							"web safety controls are not engine-enforced\nfree permission mode: authored readOnly is not enforced",
						degradations: [],
						forcedReadOnly: ["stage-one"],
					},
					extra,
				},
			},
		});
		await b.waitFor(
			() => !!document.querySelector('[data-management-action="check"]'),
		);
		const state = () =>
			b.evaluate(() => {
				const n = [...document.querySelectorAll("button")].find(
					(n) => n.textContent === "Check different settings",
				);
				return {
					expanded: n.getAttribute("aria-expanded"),
					linked:
						document.getElementById(n.getAttribute("aria-controls")) ===
						document.querySelector(".check-overrides"),
				};
			});
		assert.deepEqual(await state(), { expanded: "false", linked: true });
		await click(b, "Check different settings");
		assert.deepEqual(await state(), { expanded: "true", linked: true });
		await b.click('[aria-label="Check profile"]');
		await set(b, "Check profile", "no-match-profile");
		assert.doesNotMatch(
			await b.evaluate(
				() => document.querySelector(".picker-empty").textContent,
			),
			/model ID/,
		);
		await set(b, "Model", "retained/manual");
		await click(b, "Check different settings");
		assert.deepEqual(await state(), { expanded: "false", linked: true });
		assert.match(
			await b.evaluate(
				() => document.querySelector(".check-settings-summary").textContent,
			),
			/retained\/manual/,
		);
		await b.click('[data-management-action="check"]');
		await b.waitFor(() => !!document.querySelector(".management-result"));
		assert.deepEqual(await b.evaluate(() => window.checkBodies), [
			{ model: "retained/manual", profile: "no-match-profile" },
		]);
		await click(b, "Check details");
		const rendered = await b.evaluate(() => ({
			text: document.querySelector(".management-result").innerText,
			keys: [...document.querySelectorAll(".management-result dt")].map(
				(n) => n.textContent,
			),
			lists: [...document.querySelectorAll(".management-result ul")].map(
				(n) => n.textContent,
			),
			injected: document.querySelectorAll(".management-result img").length,
		}));
		for (const key of Object.keys(extra))
			assert.ok(rendered.keys.includes(key), key);
		for (const value of [
			"[]",
			"{}",
			'""',
			"false",
			"0",
			extra.literal,
			"web safety controls are not engine-enforced",
			"authored readOnly is not enforced",
		])
			assert.ok(rendered.text.includes(value), value);
		assert.ok(
			rendered.lists.some(
				(text) =>
					text.includes("first") &&
					text.includes("false") &&
					text.includes("0"),
			),
		);
		assert.equal(rendered.injected, 0);
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

test(
	"D complete catalog warning is advisory: saved manual models and unrelated values survive Save",
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
								state: "ready",
								usable: true,
								models: ["listed"],
								modelListComplete: true,
								effortLevels: ["low", "high"],
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
			url: `${p.origin}/?project=${p.server.projectId}&view=profiles`,
		});
		await b.waitFor(
			() => !!document.querySelector('[data-profile-open="manual-warning"]'),
		);
		await b.click('[data-profile-open="manual-warning"]');
		await b.waitFor(
			() => !!document.querySelector('[data-management-action="save-profile"]'),
		);
		assert.match(
			await b.evaluate(
				() => document.querySelector(".profile-editor").innerText,
			),
			/not in codex's complete model list\./i,
		);
		assert.doesNotMatch(
			await b.evaluate(
				() => document.querySelector(".profile-editor").innerText,
			),
			/launch refuses/i,
		);
		assert.equal(
			await b.evaluate(() => {
				const ids = [
					...document.querySelectorAll('.profile-editor small[role="status"]'),
				].map((n) => n.id);
				return (
					ids.length > 0 &&
					ids.every(Boolean) &&
					ids.length === new Set(ids).size
				);
			}),
			true,
		);
		await set(b, "Effort", "high");
		await b.click('[data-management-action="save-profile"]');
		await b.waitFor(() => !!document.querySelector(".profile-save-status"));
		const stored = (
			await profileAction(p.ctx, { op: "show", name: "manual-warning" })
		).data.profile;
		for (const key of ["executor", "model", "roles", "permissionMode"])
			assert.deepEqual(stored[key], values[key]);
		assert.equal(stored.effort, "high");
	},
);
