// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowser, findChrome } from "../helpers/dashboard-browser.mjs";
import { createFixtureServer } from "../helpers/dashboard-ui-fixture-server.mjs";
import {
	managementProject,
	persistManagementRun,
} from "../helpers/dashboard-management.mjs";
const chrome = await findChrome();
async function setup(t, options = {}) {
	assert.ok(chrome, "native Chrome required");
	const f = await createFixtureServer(options);
	t.after(() => f.close());
	const stopped = [...f.runs.values()].find(
		(r) => r.status === "completed" && !r.reportAvailable,
	);
	stopped.status = "interrupted";
	stopped.tasks[0].status = "interrupted";
	stopped.tasks[0].statusDetail = "interrupted";
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	return { f, b };
}
async function entry(b, url) {
	await b.open(url);
	await b.waitFor(() => !!document.querySelector(".run-header, .report-page"));
}
const state = (b) =>
	b.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));

test("first entry matrix uses recorded state once; explicit view/task/stage/tab/layout wins", {
	timeout: 120000,
}, async (t) => {
	const { f, b } = await setup(t);
	const active = [...f.runs.values()].find((r) => r.status === "running");
	const completed = [...f.runs.values()].find(
		(r) => r.status === "completed" && r.reportAvailable,
	);
	const failed = [...f.runs.values()].find(
		(r) => r.status === "failed" && !r.verdictGate,
	);
	const interrupted = [...f.runs.values()].find(
		(r) => r.status === "interrupted",
	);
	for (const r of [active, completed, failed, interrupted]) assert.ok(r);
	await entry(b, `${f.origin}/?run=${active.runId}`);
	assert.equal(
		(await state(b)).task,
		active.tasks.find((t) => t.status === "running" && !t.placeholder)?.specId,
	);
	await entry(b, `${f.origin}/?run=${completed.runId}`);
	assert.equal((await state(b)).view, "report");
	assert.match(
		await b.evaluate(() => document.querySelector("#center").textContent),
		/Needs work/i,
	);
	completed.reportAvailable = false;
	await entry(b, `${f.origin}/?run=${completed.runId}`);
	assert.notEqual((await state(b)).view, "report");
	assert.match(
		await b.evaluate(() => document.querySelector("#center").textContent),
		/Needs work/i,
	);
	for (const r of [failed, interrupted]) {
		await entry(b, `${f.origin}/?run=${r.runId}`);
		assert.equal(
			(await state(b)).task,
			r.tasks.find((t) =>
				["failed", "interrupted", "blocked"].includes(t.status),
			)?.specId,
		);
		assert.match(
			await b.evaluate(() => document.querySelector("#center").textContent),
			/Failed|Stopped/,
		);
	}
	completed.reportAvailable = true;
	for (const query of [
		"view=runs",
		"view=details",
		`task=${completed.tasks[0].specId}`,
		`stage=${completed.tasks[0].stageId}`,
		"tab=output",
		"layout=td",
		"layout=lr",
		"layout=timeline",
	]) {
		await entry(b, `${f.origin}/?run=${completed.runId}&${query}`);
		assert.notEqual((await state(b)).view, "report", query);
		const [key, value] = query.split("=");
		assert.equal((await state(b))[key], value, query);
	}
	await entry(b, `${f.origin}/?run=${active.runId}&view=report`);
	assert.equal((await state(b)).view, "report");
});

test("live completion preserves deliberate stage, camera and history; Escape restores graph", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const r = [...f.runs.values()].find((r) => r.status === "running");
	await entry(b, `${f.origin}/?run=${r.runId}&stage=reviewers&layout=lr`);
	await b.waitFor(() => !!document.querySelector(".canvas svg"));
	const camera = await b.evaluate(() =>
		document.querySelector(".canvas svg").getAttribute("viewBox"),
	);
	r.status = "completed";
	r.updatedAt = new Date(Date.parse(r.updatedAt) + 10000).toISOString();
	r.reportAvailable = true;
	f.publish();
	await b.waitFor(() =>
		document.querySelector("#run-header")?.textContent.includes("Open report"),
	);
	assert.equal((await state(b)).stage, "reviewers");
	assert.equal((await state(b)).layout, "lr");
	assert.equal(
		await b.evaluate(() =>
			document.querySelector(".canvas svg").getAttribute("viewBox"),
		),
		camera,
	);
	await b.click('[aria-label="Run details"]');
	await b.evaluate(() => history.back());
	await b.waitFor(
		() => new URLSearchParams(location.search).get("stage") === "reviewers",
	);
	await b.evaluate(() => history.forward());
	await b.waitFor(
		() => new URLSearchParams(location.search).get("view") === "details",
	);
	await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
	await b.waitFor(() => document.querySelector("#inspector").hidden);
	assert.equal(
		await b.evaluate(() =>
			document.querySelector(".canvas svg").getAttribute("viewBox"),
		),
		camera,
	);
});

test("Run values are recorded, usage is separate/unknown, captured plan never observed; no settings editor", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const r = [...f.runs.values()].find((r) => r.status === "running");
	const task = r.tasks.find((t) => !t.placeholder);
	task.model = "recorded-plan";
	task.reportedModel = "reported-different";
	r.configuration = {
		schema: 1,
		slots: {
			example: { model: { value: "captured-request", source: "project-slot" } },
		},
	};
	await entry(b, `${f.origin}/?run=${r.runId}&task=${task.specId}`);
	assert.match(
		await b.evaluate(
			() => document.querySelector(".executor-line").textContent,
		),
		/Recorded model: recorded-plan.*Executor-reported model: reported-different/,
	);
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelectorAll(
					'.project-workflow-editor, [aria-label$=" Model"], [data-management-action="save-project-settings"]',
				).length,
		),
		0,
	);
	delete task.reportedModel;
	r.updatedAt = new Date(Date.parse(r.updatedAt) + 10000).toISOString();
	f.publish();
	await b.waitFor(() =>
		document
			.querySelector(".executor-line")
			?.textContent.includes("unknown / not reported"),
	);
	await b.click('[aria-label="Run details"]');
	assert.match(
		await b.evaluate(
			() =>
				document.querySelector('[data-testid="captured-run-plan"]').textContent,
		),
		/requested\/resolved plan.*not today's settings or provider-observed.*captured-request/s,
	);
	await b.waitFor(() =>
		document
			.querySelector('[data-testid="run-workflow-unavailable"]')
			?.textContent.includes("lookup unavailable"),
	);
});

test("trusted current Workflow target uses actual keyed E1 API, missing definition explains absence", {
	timeout: 90000,
}, async (t) => {
	const p = await managementProject(t);
	const a = await persistManagementRun(
		p.cwd,
		"workflow_navigation_link",
		"completed",
		{ specPath: ".agent-workflow/workflows/manage.json" },
	);
	const missing = await persistManagementRun(
		p.cwd,
		"workflow_navigation_missing",
	);
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await entry(
		b,
		`${p.origin}/?project=${p.server.projectId}&run=${a.run.runId}&view=runs`,
	);
	await b.waitFor(
		() => !!document.querySelector('[data-testid="run-workflow-link"]'),
	);
	const link = await b.evaluate(() => ({
		text: document.querySelector('[data-testid="run-workflow-link"]')
			.textContent,
		href: document
			.querySelector('[data-testid="run-workflow-link"]')
			.getAttribute("href"),
	}));
	const catalog = (await p.http(`${p.base}/workflows`)).data.data.workflows;
	assert.ok(
		link.href.includes(catalog.find((w) => w.name === "manage").workflowKey),
	);
	assert.match(link.text, /future Runs only/);
	await b.evaluate(() => {
		const original = window.fetch;
		window.fetch = async (...args) => {
			const response = await original(...args);
			if (
				String(args[0]).includes(
					"workflow_navigation_missing/workflow-settings-target",
				)
			)
				await new Promise((resolve) => {
					window.__releaseTarget = resolve;
				});
			return response;
		};
	});
	await b.click('[data-run="workflow_navigation_missing"]');
	await b.waitFor(() => !!window.__releaseTarget);
	await b.click('[data-run="workflow_navigation_link"]');
	await b.waitFor(
		() => !!document.querySelector('[data-testid="run-workflow-link"]'),
	);
	await b.evaluate(() => window.__releaseTarget());
	assert.equal(
		(await state(b)).run,
		a.run.runId,
		"late missing-target response cannot move or relabel another Run",
	);
	assert.equal(
		await b.evaluate(() =>
			document
				.querySelector('[data-testid="run-workflow-link"]')
				.getAttribute("href"),
		),
		link.href,
	);
	await entry(
		b,
		`${p.origin}/?project=${p.server.projectId}&run=${missing.run.runId}`,
	);
	await b.waitFor(() =>
		document
			.querySelector('[data-testid="run-workflow-unavailable"]')
			?.textContent.includes("definition-unmatched"),
	);
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelectorAll('[data-testid="run-workflow-link"]').length,
		),
		0,
	);
});

test("Stop/Resume status, readonly, confirmation/cancel and repeated effects warning", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const active = [...f.runs.values()].find((r) => r.status === "running");
	const stopped = [...f.runs.values()].find((r) => r.status === "interrupted");
	const complete = [...f.runs.values()].find((r) => r.status === "completed");
	await entry(b, `${f.origin}/?run=${active.runId}&view=runs`);
	await b.click('[data-action="stop"]');
	assert.match(
		await b.evaluate(() => document.querySelector("#dialog").textContent),
		/durable stop intent.*supervisor/s,
	);
	await b.click("[data-cancel]");
	assert.equal(f.mutations.length, 0);
	await b.click('[data-action="stop"]');
	await b.click("#confirm-action");
	await b.waitFor(() =>
		document.querySelector("#center").textContent.includes("Stopping"),
	);
	assert.equal(f.mutations[0].action, "stop");
	await entry(b, `${f.origin}/?run=${stopped.runId}&view=runs`);
	await b.click('[data-action="resume"]');
	assert.match(
		await b.evaluate(() => document.querySelector("#dialog").textContent),
		/execute again and repeat side effects/,
	);
	await b.click("[data-cancel]");
	assert.equal(f.mutations.length, 1);
	await b.evaluate(() => {
		window.__originalMutationFetch = window.fetch;
		window.fetch = (...args) =>
			String(args[0]).endsWith("/resume")
				? Promise.resolve(
						new Response(
							JSON.stringify({ error: "Fixture ownership/capability refusal" }),
							{ status: 409 },
						),
					)
				: window.__originalMutationFetch(...args);
	});
	await b.click('[data-action="resume"]');
	await b.click("#confirm-action");
	await b.waitFor(() =>
		document
			.querySelector("#notice")
			?.textContent.includes("Fixture ownership/capability refusal"),
	);
	assert.equal(
		f.mutations.length,
		1,
		"server refusal is not retried or treated as success",
	);
	await b.click("[data-cancel]");
	await b.evaluate(() => {
		window.fetch = window.__originalMutationFetch;
	});
	await b.click('[data-action="resume"]');
	await b.click("#confirm-action");
	await b.waitFor(() => !document.querySelector("#dialog").open);
	assert.equal(f.mutations[1].action, "resume");
	await entry(b, `${f.origin}/?run=${complete.runId}&view=runs`);
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelectorAll(
					'[data-action="stop"], [data-action="resume"]',
				).length,
		),
		0,
	);
	assert.match(
		await b.evaluate(
			() =>
				document.querySelector('[data-testid="run-action-reason"]').textContent,
		),
		/business verdicts are results/,
	);
	f.setReadonly(true);
	await entry(b, `${f.origin}/?run=${active.runId}&view=runs`);
	assert.equal(
		await b.evaluate(
			() => document.querySelector('[data-action="stop"]').disabled,
		),
		true,
	);
});
