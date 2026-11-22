// test-tier: integration
// 2026-11-23 (owner: "run details are not human-readable"; "the theme belongs in one global
// place"): the task keeps its Markdown, a tool launch shows one argument per line without a second
// copy of the task, the recorded plan is one row per step, and the theme is set only in the top bar.
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";

const chrome = await findChrome();
const TASK =
	"## Background\n\nCheck the retry helper.\n\n1. Read `src/retry.js`.\n2. Compare it with README.md.\n\n- keep it short";

test("run details: Markdown task, readable launch arguments, per-step plan table", {
	timeout: 90000,
}, async (t) => {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	const r = [...f.runs.values()].find((run) => run.status === "completed");
	const command = `aw_run ${JSON.stringify({ workflow: "deep-research", task: TASK, profile: "high" })}`;
	r.task = TASK;
	r.launch = { host: "pi", command };
	r.configuration = {
		schema: "agent-workflow-configuration-v1",
		slots: {
			plan: {
				executor: { source: "project-slot", value: "codex" },
				model: { source: "project-slot", value: "gpt-6.2-sol" },
				effort: {
					source: "project-slot",
					requested: "xhigh",
					resolved: "high",
				},
			},
			"research-questions": {
				executor: { source: "project-default", value: "codex" },
				model: { source: "project-default", value: "gpt-6.2-sol" },
				effort: {
					source: "project-default",
					requested: "high",
					resolved: "high",
				},
			},
		},
		shadowed: [],
	};
	await b
		.send("Browser.grantPermissions", {
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
			origin: f.origin,
		})
		.catch(() => {});
	await b.open(`${f.origin}/?run=${r.runId}&view=details`);
	await b.waitFor(() => !!document.querySelector("#inspector .plan-table"));
	const view = await b.evaluate(() => {
		const inspector = document.querySelector("#inspector");
		const task = inspector.querySelector(".run-task-text");
		return {
			heading: task.querySelector("h4, h3, .md-h2")?.textContent,
			ordered: [...task.querySelectorAll("ol li")].map((li) => li.textContent),
			code: task.querySelector("code")?.textContent,
			wraps: task.scrollWidth <= task.clientWidth + 1,
			launch: inspector.querySelector(".command pre").textContent,
			plan: [...inspector.querySelectorAll(".plan-table tbody tr")].map((row) =>
				[...row.children].map((cell) => cell.textContent),
			),
			raw: /originScope|"source"|schema/.test(inspector.textContent),
		};
	});
	assert.deepEqual(view, {
		heading: "Background",
		ordered: ["Read src/retry.js.", "Compare it with README.md."],
		code: "src/retry.js",
		wraps: true,
		launch:
			"aw_run\n  workflow: deep-research\n  task: (the task above)\n  profile: high",
		plan: [
			["Plan", "codex", "gpt-6.2-sol", "xhigh → high", "this step's setting"],
			[
				"Research questions",
				"codex",
				"gpt-6.2-sol",
				"high",
				"workflow default",
			],
		],
		raw: false,
	});
	// Copy still copies the command exactly as recorded.
	await b.evaluate(() => {
		window.__copied = null;
		navigator.clipboard.writeText = async (text) => {
			window.__copied = text;
		};
		document.querySelector("#inspector .command button").click();
	});
	await b.waitFor(() => window.__copied !== null);
	assert.equal(await b.evaluate(() => window.__copied), command);
});

test("theme: only the top bar chooses it, with a mark that says what it is", {
	timeout: 60000,
}, async (t) => {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer();
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	const done = [...f.runs.values()].find((run) => run.reportAvailable);
	await b.open(`${f.origin}/?run=${done.runId}&view=report`);
	await b.waitFor(
		() => !!document.querySelector("#report-content h1, #report-content h2"),
	);
	const marks = [];
	for (let i = 0; i < 3; i++) {
		marks.push(
			await b.evaluate(() => {
				const button = document.querySelector("#theme-button");
				return [
					button.textContent,
					getComputedStyle(button, "::before").content,
				];
			}),
		);
		await b.click("#theme-button");
	}
	assert.deepEqual(marks, [
		["Auto", '"◐"'],
		["Light", '"☀"'],
		["Dark", '"☾"'],
	]);
	assert.equal(
		await b.evaluate(
			() =>
				[...document.querySelectorAll("#center button")].filter((button) =>
					/^(Light|Dark) page$/.test(button.textContent),
				).length,
		),
		0,
		"no second theme control in the report",
	);
});
