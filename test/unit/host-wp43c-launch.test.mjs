import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { runWorkflowAction, waitAction } from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import {
	dashboardDiscoveryPath,
	readDashboardDiscovery,
} from "../../dist/hosts/dashboard/discovery.js";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

let counter = 0;
setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
async function project(t, overrides = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43c-launch-"));
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
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
	const undo = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: executor,
			effectLog: join(cwd, "effects.jsonl"),
		}),
	);
	const runs = [];
	const ctx = { cwd, env, host: "cli" };
	t.after(async () => {
		for (const runId of runs)
			await waitAction(
				{ ...ctx, env: { ...env, AGENT_WORKFLOW_ROLE: "supervisor" } },
				{ runId, timeoutMs: 10_000 },
			);
		const discovery = await readDashboardDiscovery(cwd);
		if (discovery) {
			let stderr = "";
			const code = await runAgentWorkflowCli(["dashboard", "--stop"], {
				cwd,
				env: { ...env, AGENT_WORKFLOW_ROLE: "supervisor" },
				stdout: () => {},
				stderr: (s) => {
					stderr += s;
				},
			});
			assert.equal(code, 0, stderr);
		}
		undo();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});
	return {
		ctx,
		launch: async (task = "Show my run", context = ctx, request = {}) => {
			const out = await runWorkflowAction(context, {
				workflow: "wf.json",
				task,
				executor,
				...request,
			});
			if (out.data.runId) runs.push(out.data.runId);
			return out;
		},
	};
}

test("real fixture launch auto-starts a real detached dashboard and always prints a token-free link", {
	timeout: 20_000,
}, async (t) => {
	const { ctx, launch } = await project(t, { CLAUDECODE: "1" });
	const first = await launch();
	assert.ok(first.ok, first.text);
	assert.ok(await stat(dashboardDiscoveryPath(ctx.cwd)));
	const discovery = await readDashboardDiscovery(ctx.cwd);
	assert.ok(discovery);
	assert.notEqual(discovery.pid, process.pid);
	assert.equal(discovery.detached, true);
	const url = `http://127.0.0.1:${discovery.port}/?run=${first.data.runId}`;
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
				`Dashboard: http://127.0.0.1:${discovery.port}/?run=${second.data.runId}`,
			),
	);
	assert.doesNotMatch(second.text, /first time in this browser/);
	assert.equal((await readDashboardDiscovery(ctx.cwd)).pid, discovery.pid);
});

test("AGENT_WORKFLOW_DASHBOARD_AUTH=1: the auto-started dashboard requires sign-in and the launch says so once", {
	timeout: 20_000,
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
	const url = `http://127.0.0.1:${discovery.port}/?run=${first.data.runId}`;
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
	timeout: 15_000,
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
	timeout: 15_000,
}, async (t) => {
	const { ctx, launch } = await project(t);
	const out = await launch("readonly host", { ...ctx, readonly: true });
	assert.ok(out.ok, out.text);
	assert.equal(out.data.dashboard, undefined);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
});

test("dashboard startup failure is bounded and cannot fail the fixture launch", {
	timeout: 15_000,
}, async (t) => {
	const { ctx, launch } = await project(t, {
		AGENT_WORKFLOW_DASHBOARD_IDLE_MS: "invalid",
	});
	const at = Date.now();
	const out = await launch();
	assert.ok(out.ok, out.text);
	assert.ok(Date.now() - at < 6000, "3s discovery budget plus fixture launch");
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
