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
	await b.waitFor(() => !!document.querySelector(".run-header, .report-view"));
}
const state = (b) =>
	b.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
async function assertNoSelection(b) {
	const { task, stage, tab } = await state(b);
	assert.deepEqual(
		{ task, stage, tab },
		{
			task: undefined,
			stage: undefined,
			tab: undefined,
		},
	);
}
const inspectorHidden = (b) =>
	b.evaluate(() => document.querySelector("#inspector").hidden);

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
	const running = active.tasks.find(
		(t) => t.status === "running" && !t.placeholder,
	);
	assert.ok(running);
	await entry(b, `${f.origin}/?run=${active.runId}`);
	assert.ok(await b.evaluate(() => !!document.querySelector(".canvas svg")));
	assert.ok(
		await inspectorHidden(b),
		"a clean live entry must show only the graph",
	);
	await assertNoSelection(b);
	await entry(b, `${f.origin}/?run=${active.runId}&task=${running.specId}`);
	assert.equal((await state(b)).task, running.specId);
	assert.equal(await inspectorHidden(b), false);
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelector('#inspector [aria-selected="true"]').dataset.tab,
		),
		"events",
	);
	await entry(b, `${f.origin}/?run=${completed.runId}`);
	assert.equal((await state(b)).view, "report");
	assert.ok(await b.evaluate(() => !!document.querySelector(".report-view")));
	assert.ok(await inspectorHidden(b));
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
		assert.equal(await inspectorHidden(b), false);
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

test("a dirty report bookmark opens a clean report and returns to an unselected graph", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const r = [...f.runs.values()].find(
		(r) => r.status === "completed" && r.reportAvailable,
	);
	await entry(
		b,
		`${f.origin}/?run=${r.runId}&stage=${r.tasks[0].stageId}&tab=events&view=report`,
	);
	assert.equal((await state(b)).view, "report");
	assert.ok(await inspectorHidden(b));
	await assertNoSelection(b);
	await b.click('[data-action="open-run"]');
	await b.waitFor(() => !!document.querySelector(".canvas svg"));
	assert.ok(await inspectorHidden(b));
	await assertNoSelection(b);
});

test("header and rail reports clear inspector state without changing the prior graph history entry", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const r = [...f.runs.values()].find(
		(r) => r.status === "completed" && r.reportAvailable,
	);
	// A narrow viewport collapses the rail when the inspector is open.
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const task = r.tasks[0].specId;
	const graph = `${f.origin}/?run=${r.runId}&task=${task}&tab=output`;
	for (const reportLink of [
		"#run-header .actions .primary",
		'.run-row[aria-current="true"] .run-report',
	]) {
		await entry(b, graph);
		assert.equal(await inspectorHidden(b), false);
		await b.click(reportLink);
		await b.waitFor(() => !!document.querySelector(".report-view"));
		assert.ok(await inspectorHidden(b));
		await assertNoSelection(b);
		await b.click('[data-action="open-run"]');
		await b.waitFor(() => !!document.querySelector(".canvas svg"));
		assert.ok(await inspectorHidden(b));
		await assertNoSelection(b);
		await b.evaluate(() => history.back());
		await b.waitFor(() => !!document.querySelector(".report-view"));
		await assertNoSelection(b);
		await b.evaluate(() => history.back());
		await b.waitFor(
			() =>
				!document.querySelector("#inspector").hidden &&
				!!document.querySelector(".canvas svg"),
		);
		assert.equal((await state(b)).task, task);
		assert.equal((await state(b)).tab, "output");
		assert.equal(
			await b.evaluate(
				() =>
					document.querySelector('#inspector [aria-selected="true"]').dataset
						.tab,
			),
			"output",
		);
		await b.evaluate(() => history.forward());
		await b.waitFor(() => !!document.querySelector(".report-view"));
		assert.ok(await inspectorHidden(b));
		await assertNoSelection(b);
	}
});

test("inspector dismissal and Run details leave the next task on its default tab", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	const r = [...f.runs.values()].find((r) => r.status === "running");
	for (const leave of ["close", "escape", "details"]) {
		await entry(b, `${f.origin}/?run=${r.runId}&task=triage.main&tab=output`);
		if (leave === "escape")
			await b.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Escape",
			});
		else
			await b.click(
				leave === "close"
					? '[aria-label="Close inspector"]'
					: '[aria-label="Run details"]',
			);
		assert.equal(await inspectorHidden(b), leave !== "details");
		await assertNoSelection(b);
		await b.click('[data-task="reviewers.refund-idempotency"]');
		assert.equal((await state(b)).task, "reviewers.refund-idempotency");
		assert.equal(
			await b.evaluate(
				() =>
					document.querySelector('#inspector [aria-selected="true"]').dataset
						.tab,
			),
			"result",
		);
	}
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
	// Exercise lookup failure explicitly; the shared historical fixture now implements the endpoint.
	await b.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
			const original = window.fetch;
			window.fetch = async (url, ...args) => {
				if (String(url).endsWith("/workflow-settings-target")) throw new Error("Fixture lookup unavailable");
				return original(url, ...args);
			};
		})();`,
	});
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
		/Planned models.*not today's settings and not what the provider reported.*captured-request/s,
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
	assert.equal(link.text, "Workflow settings");
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
	// A finished Run has no action note or policy disclosure; its status line says it finished.
	assert.deepEqual(
		await b.evaluate(() => ({
			reason: document.querySelectorAll('[data-testid="run-action-reason"]')
				.length,
			policy: document.querySelectorAll(".run-context details").length,
		})),
		{ reason: 0, policy: 0 },
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

test("primary Run history restores rich rail and observation; deletion stays secondary", {
	timeout: 90000,
}, async (t) => {
	const { f, b } = await setup(t);
	[...f.runs.values()].find((r) => r.status === "running").taskPreview =
		"History restoration task preview";
	await b.open(f.origin);
	await b.waitFor(() => !!document.querySelector("#home-view"));
	const historyLink = '.management-nav a[href*="view=runs"]';
	assert.equal(
		await b.evaluate(() =>
			[...document.querySelectorAll('[aria-label="Dashboard views"] a')]
				.find((a) => a.textContent === "Run history")
				?.getAttribute("href")
				.includes("view=runs"),
		),
		true,
		"primary History must use existing Run observation, not deletion management",
	);
	await b.click(historyLink);
	await b.waitFor(
		() =>
			!!document.querySelector(".run-header") &&
			document.querySelectorAll(".run-row").length > 1,
	);
	const active = [...f.runs.values()].find((r) => r.status === "running");
	assert.equal((await state(b)).run, active.runId);
	assert.equal((await state(b)).view, "runs");
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelectorAll("[data-history-id], .project-workflow-editor")
					.length,
		),
		0,
	);
	const rows = await b.evaluate(() =>
		[...document.querySelectorAll(".run-row")].map((row) => ({
			id: row.dataset.run,
			started: !!row.querySelector(".run-started"),
			counts: !!row.querySelector(".run-count"),
			elapsed: !!row.querySelector(".elapsed"),
			preview: !!row.querySelector(".run-task"),
		})),
	);
	assert.ok(rows.every((r) => r.started && r.counts && r.elapsed));
	assert.ok(rows.some((r) => r.preview));
	assert.ok(
		await b.evaluate(
			() => !!document.querySelector('.run-row[aria-current="true"] progress'),
		),
	);
	const completed = [...f.runs.values()].find(
		(r) => r.status === "completed" && r.reportAvailable,
	);
	await b.click(`[data-run="${completed.runId}"]`);
	await b.waitFor(() => !!document.querySelector(".report-view"));
	assert.equal((await state(b)).run, completed.runId);
	assert.equal(
		await b.evaluate(
			() => document.querySelector('.run-row[aria-current="true"]').dataset.run,
		),
		completed.runId,
	);
	assert.ok(
		await b.evaluate(
			() =>
				!!document.querySelector('.run-row[aria-current="true"] .run-report'),
		),
	);
	await b.click(`[data-run="${active.runId}"]`);
	await b.waitFor(() => !!document.querySelector(".run-header"));
	assert.equal((await state(b)).run, active.runId);
	assert.equal(
		await b.evaluate(
			() => document.querySelector('.run-row[aria-current="true"]').dataset.run,
		),
		active.runId,
	);
	await b.click('[data-task="reviewers.webhook-retry-path"]');
	await b.waitFor(() => !!document.querySelector('[data-tab="events"]'));
	await b.click('[data-tab="events"]');
	assert.ok(await b.evaluate(() => !!document.querySelector("#inspector")));
	assert.ok(
		await b.evaluate(
			() =>
				!!document.querySelector(
					'.management-nav a[aria-current="page"][href*="view=runs"]',
				),
		),
	);
	assert.equal(
		await b.evaluate(
			() =>
				document.querySelector('[data-testid="manage-run-deletion"]')
					.textContent,
		),
		"Delete run records…",
	);
});

test("empty history stays truthful while loading and after a Run-list failure", {
	timeout: 90000,
}, async (t) => {
	const f = await createFixtureServer({ snapshots: [] });
	t.after(() => f.close());
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `const originalFetch = window.fetch;
		const failHistory = new URLSearchParams(location.search).has("fixtureFailure");
		window.fetch = async (...args) => {
			if (String(args[0]).endsWith('/runs')) {
				await new Promise(resolve => window.__releaseHistory = resolve);
				if (failHistory)
					return new Response(JSON.stringify({error:'Fixture history unavailable'}), {status:500});
			}
			return originalFetch(...args);
		};`,
	});
	await b.send("Page.navigate", { url: `${f.origin}/?view=runs` });
	await b.waitFor(() => !!window.__releaseHistory);
	// Loading shows a spinner (2026-11-17: replaced the "Connecting…" text), never "No runs".
	assert.deepEqual(
		await b.evaluate(() => ({
			loading: document
				.querySelector('#center [role="status"]')
				?.getAttribute("aria-label"),
			empty: /No runs/.test(document.querySelector("#center").textContent),
		})),
		{ loading: "Loading dashboard", empty: false },
	);
	assert.equal(
		await b.evaluate(
			() => document.querySelectorAll(".run-row, [data-history-id]").length,
		),
		0,
	);
	await b.evaluate(() => window.__releaseHistory());
	await b.waitFor(() =>
		document.querySelector("#rail")?.textContent.includes("No runs yet"),
	);
	assert.match(
		await b.evaluate(() => document.querySelector("#center").textContent),
		/No runs in this project/,
	);
	assert.equal((await state(b)).run, undefined);
	assert.deepEqual(
		await b.evaluate(() =>
			[
				...document.querySelectorAll(
					'[aria-label="Dashboard views"] a[aria-current="page"]',
				),
			].map((a) => a.textContent),
		),
		["Run history"],
	);
	assert.ok(
		await b.evaluate(
			() => !!document.querySelector('[data-testid="manage-run-deletion"]'),
		),
	);
	await b.send("Page.navigate", {
		url: `${f.origin}/?view=runs&fixtureFailure=1`,
	});
	await b.waitFor(() => !!window.__releaseHistory);
	await b.evaluate(() => window.__releaseHistory());
	await b.waitFor(() =>
		document
			.querySelector("#center")
			.textContent.includes("Dashboard unavailable"),
	);
	assert.match(
		await b.evaluate(() => document.querySelector("#center").textContent),
		/Fixture history unavailable/,
	);
	assert.equal(
		await b.evaluate(
			() => document.querySelectorAll("[data-history-id]").length,
		),
		0,
	);
});
