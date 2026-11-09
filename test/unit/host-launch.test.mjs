// test-tier: integration
import { projectId } from "../../dist/core/state-location.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { waitAction } from "../../dist/hosts/api.js";
import { setWorkerLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { dashboardProject } from "../helpers/dashboard-project.mjs";
import {
	dashboardDiscoveryPath,
	readDashboardDiscovery,
	setDashboardStartBudgetForTests,
} from "../../dist/hosts/dashboard/discovery.js";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

// The dashboard a launch starts gets 15 s here instead of 3 s: these tests check the auto-start
// and the link, not how fast a loaded machine (the whole suite in parallel) boots Node.
setDashboardStartBudgetForTests(15_000);

let counter = 0;
setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
async function project(t, overrides = {}) {
	const fixture = await dashboardProject(t, "aw-wp43c-launch-");
	const { cwd } = fixture;
	const env = {
		...process.env,
		AGENT_WORKFLOW_ROLE: "supervisor",
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "1",
		BROWSER: "none",
		...overrides,
	};
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "always-link-fixture",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const executor = `wp43c-fixture-${++counter}`;
	fixture.dispose(
		registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: executor,
				effectLog: join(cwd, "effects.jsonl"),
			}),
		),
	);
	const ctx = { cwd, env, host: "cli" };
	return {
		ctx,
		launch: async (task = "Show my run", context = ctx, request = {}) => {
			return fixture.launch(context, {
				workflow: "wf.json",
				task,
				executor,
				...request,
			});
		},
	};
}

test("real fixture launch auto-starts a real detached dashboard and always prints a token-free link", {
	timeout: 60_000,
}, async (t) => {
	const { ctx, launch } = await project(t, { CLAUDECODE: "1" });
	const first = await launch();
	assert.ok(first.ok, first.text);
	assert.ok(await stat(dashboardDiscoveryPath(ctx.cwd)));
	const discovery = await readDashboardDiscovery(ctx.cwd);
	assert.ok(discovery);
	assert.notEqual(discovery.pid, process.pid);
	assert.equal(discovery.detached, true);
	const url = `http://127.0.0.1:${discovery.port}/?project=${projectId(ctx.cwd)}&run=${first.data.runId}`;
	// WP43d default: the auto-started dashboard needs no sign-in, so no "first time" hint.
	assert.equal(discovery.auth, false);
	assert.deepEqual(first.data.dashboard, {
		url,
		port: discovery.port,
		started: true,
	});
	assert.ok(first.text.split("\n").includes(`Dashboard: ${url}`), first.text);
	assert.doesNotMatch(first.text, /first time in this browser|sign in/);
	assert.doesNotMatch(JSON.stringify(first), /token=|launchKey/);
	// The link opens directly: no cookie, no sign-in page.
	const landing = await fetch(url);
	assert.equal(landing.status, 200);
	assert.equal(landing.headers.get("set-cookie"), null);
	assert.doesNotMatch(await landing.text(), /isn't signed in/);
	if (process.platform !== "win32") {
		const { stdout } = await promisify(execFile)("ps", [
			"-p",
			String(discovery.pid),
			"-o",
			"pgid=,args=",
		]);
		assert.match(stdout, /cli\.mjs dashboard --project .* --detached/);
		assert.equal(
			Number(stdout.trim().split(/\s+/)[0]),
			discovery.pid,
			"detached process group",
		);
	}
	const second = await launch("Use the existing dashboard");
	assert.equal(second.data.dashboard.started, undefined);
	assert.ok(
		second.text
			.split("\n")
			.includes(
				`Dashboard: http://127.0.0.1:${discovery.port}/?project=${projectId(ctx.cwd)}&run=${second.data.runId}`,
			),
	);
	assert.doesNotMatch(second.text, /first time in this browser/);
	assert.equal((await readDashboardDiscovery(ctx.cwd)).pid, discovery.pid);
	// 2026-11-03: the settled wait gives the link again (the report view when there is a report).
	let waited;
	do
		waited = await waitAction(ctx, {
			runId: first.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	const view = waited.data.reportArtifacts.length > 0 ? "&view=report" : "";
	const finished = `http://127.0.0.1:${discovery.port}/?project=${projectId(ctx.cwd)}&run=${first.data.runId}${view}`;
	assert.equal(waited.data.dashboard?.url, finished);
	assert.ok(
		waited.text.split("\n").includes(`Dashboard: ${finished}`),
		waited.text,
	);
});

test("AGENT_WORKFLOW_DASHBOARD_AUTH=1: the auto-started dashboard requires sign-in and the launch says so once", {
	timeout: 60_000,
}, async (t) => {
	const { ctx, launch } = await project(t, {
		CLAUDECODE: "1",
		AGENT_WORKFLOW_DASHBOARD_AUTH: "1",
	});
	const first = await launch();
	assert.ok(first.ok, first.text);
	const discovery = await readDashboardDiscovery(ctx.cwd);
	assert.ok(discovery);
	assert.equal(discovery.auth, true);
	const url = `http://127.0.0.1:${discovery.port}/?project=${projectId(ctx.cwd)}&run=${first.data.runId}`;
	assert.deepEqual(first.data.dashboard, {
		url,
		port: discovery.port,
		started: true,
		auth: true,
	});
	assert.ok(
		first.text.includes(
			`Dashboard: ${url} · first time in this browser? agent-workflow dashboard --open`,
		),
		first.text,
	);
	assert.equal((await fetch(url)).status, 401);
	const second = await launch("Use the existing auth dashboard");
	assert.equal(second.data.dashboard.auth, true);
	assert.doesNotMatch(second.text, /first time in this browser/);
});

test("auto-start off switch retains the not-running line", {
	timeout: 60_000,
}, async (t) => {
	const { ctx, launch } = await project(t, {
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
	});
	const out = await launch();
	assert.ok(out.ok, out.text);
	assert.equal(out.data.dashboard, undefined);
	assert.match(
		out.text,
		/Dashboard: not running · agent-workflow dashboard --open/,
	);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
});

test("worker role refuses launch before starting any dashboard", async (t) => {
	const { ctx, launch } = await project(t, { AGENT_WORKFLOW_ROLE: "worker" });
	await assert.rejects(launch(), /not allowed.*AGENT_WORKFLOW_ROLE=worker/);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
	await assert.rejects(stat(dashboardDiscoveryPath(ctx.cwd)), {
		code: "ENOENT",
	});
});

test("readonly host context does not auto-start", {
	timeout: 60_000,
}, async (t) => {
	const { ctx, launch } = await project(t);
	const out = await launch("readonly host", { ...ctx, readonly: true });
	assert.ok(out.ok, out.text);
	assert.equal(out.data.dashboard, undefined);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
});

test("dashboard startup failure is bounded and cannot fail the fixture launch", {
	timeout: 60_000,
}, async (t) => {
	// The real 3 s budget: a dashboard that never comes up delays the launch by about that much.
	setDashboardStartBudgetForTests(undefined);
	t.after(() => setDashboardStartBudgetForTests(15_000));
	const { ctx, launch } = await project(t, {
		AGENT_WORKFLOW_DASHBOARD_IDLE_MS: "invalid",
	});
	const at = Date.now();
	const out = await launch();
	assert.ok(out.ok, out.text);
	// Bounded, not hung: 3 s plus the fixture launch, which a loaded machine can take seconds for.
	assert.ok(
		Date.now() - at < 15_000,
		"3s discovery budget plus fixture launch",
	);
	assert.equal(out.data.dashboard, undefined);
	assert.match(
		out.text,
		/Dashboard: not running · agent-workflow dashboard --open/,
	);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
});

test("refused workflow launch does not auto-start", async (t) => {
	const { ctx, launch } = await project(t);
	await assert.rejects(
		launch("bad workflow", ctx, { workflow: "missing.json" }),
	);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
});

test("an expired dashboard start budget leaves no late detached child", {
	timeout: 60_000,
	skip:
		process.platform === "win32" ? "process command inspection uses ps" : false,
}, async (t) => {
	const fixture = await dashboardProject(t, "aw-wp43c-budget-");
	setDashboardStartBudgetForTests(1);
	t.after(() => setDashboardStartBudgetForTests(15_000));
	assert.equal(
		await fixture.ensure({ ...process.env, BROWSER: "none" }),
		undefined,
	);
	const { stdout } = await promisify(execFile)("ps", ["-axo", "command="]);
	assert.ok(
		!stdout
			.split("\n")
			.some(
				(line) =>
					line.includes("cli.mjs dashboard") && line.includes(fixture.cwd),
			),
		"timed-out child exited before ensureDashboard returned",
	);
	assert.equal(await readDashboardDiscovery(fixture.cwd), undefined);
});
