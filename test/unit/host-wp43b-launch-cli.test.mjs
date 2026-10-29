import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { runWorkflowAction, waitAction } from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import {
	dashboardDiscoveryPath,
	ensureDashboard,
	readDashboardDiscovery,
} from "../../dist/hosts/dashboard/discovery.js";
let counter = 0;
setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43b-launch-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
	);
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "dashboard-fixture",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const executor = `wp43b-fixture-${++counter}`;
	t.after(
		registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: executor,
				effectLog: join(cwd, "effects.jsonl"),
			}),
		),
	);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		AGENT_WORKFLOW_DASHBOARD_OPEN: "0",
	};
	return { cwd, executor, env, host: "cli" };
}
async function invoke(ctx, args, extra = {}) {
	const stdout = [],
		stderr = [];
	const code = await runAgentWorkflowCli(args, {
		...ctx,
		isTTY: false,
		stdout: (s) => stdout.push(s),
		stderr: (s) => stderr.push(s),
		...extra,
	});
	return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}
test("real host launch carries a token-free dashboard link only while discovery validates", {
	timeout: 20_000,
}, async (t) => {
	const ctx = await project(t);
	const s = await startDashboardServer({
		cwd: ctx.cwd,
		env: ctx.env,
		discovery: true,
	});
	t.after(() => s.close());
	const launch = async (task) => {
		const out = await runWorkflowAction(ctx, {
			workflow: "wf.json",
			task,
			executor: ctx.executor,
		});
		assert.ok(out.data.runId, out.text);
		assert.equal(
			(await waitAction(ctx, { runId: out.data.runId, timeoutMs: 10_000 })).data
				.terminal,
			true,
		);
		return out;
	};
	const first = await launch("With dashboard");
	const url = `http://127.0.0.1:${s.port}/?run=${first.data.runId}`;
	assert.deepEqual(first.data.dashboard, { url, port: s.port });
	assert.ok(first.text.includes(`Dashboard: ${url}`));
	assert.ok(!JSON.stringify(first).includes(s.launchKey));
	assert.ok(!JSON.stringify(first).includes(s.token));
	await s.close();
	await assert.rejects(stat(dashboardDiscoveryPath(ctx.cwd)), {
		code: "ENOENT",
	});
	const second = await launch("Without dashboard");
	assert.equal(second.data.dashboard, undefined);
	assert.ok(!second.text.includes("Dashboard:"));
});
test("run --open overrides agent/non-TTY suppression, opens once and bootstraps to the run", {
	timeout: 15_000,
}, async (t) => {
	const ctx = await project(t);
	const s = await startDashboardServer({
		cwd: ctx.cwd,
		env: ctx.env,
		discovery: true,
	});
	t.after(() => s.close());
	const urls = [];
	const out = await invoke(
		ctx,
		[
			"run",
			"wf.json",
			"open explicitly",
			"--executor",
			ctx.executor,
			"--open",
			"--json",
		],
		{
			env: { ...ctx.env, CLAUDECODE: "1", AGENT_WORKFLOW_DASHBOARD_OPEN: "1" },
			open: async (url) => {
				urls.push(url);
				return true;
			},
		},
	);
	assert.equal(out.code, 0, out.stderr);
	assert.equal(urls.length, 1);
	const data = JSON.parse(out.stdout).data;
	const response = await fetch(urls[0], { redirect: "manual" });
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), `/?run=${data.runId}`);
	assert.equal((await fetch(urls[0], { redirect: "manual" })).status, 401);
	assert.ok(!out.stdout.includes(new URL(urls[0]).searchParams.get("token")));
});
test("env opt-in is suppressed in agents and on pipes; failures cannot fail the workflow", {
	timeout: 25_000,
}, async (t) => {
	const ctx = await project(t);
	const s = await startDashboardServer({
		cwd: ctx.cwd,
		env: ctx.env,
		discovery: true,
	});
	t.after(() => s.close());
	let opens = 0;
	const args = (task) => [
		"run",
		"wf.json",
		task,
		"--executor",
		ctx.executor,
		"--yes",
	];
	const suppressed = await invoke(ctx, args("agent suppression"), {
		isTTY: true,
		env: { ...ctx.env, CLAUDECODE: "1", AGENT_WORKFLOW_DASHBOARD_OPEN: "1" },
		open: () => {
			opens++;
			return true;
		},
	});
	assert.equal(suppressed.code, 0, suppressed.stderr);
	assert.match(
		suppressed.stderr,
		/Dashboard: http:\/\/127\.0\.0\.1:.*not opened: AI agent environment; pass --open to force/,
	);
	const piped = await invoke(ctx, args("pipe suppression"), {
		env: {
			AGENT_WORKFLOW_HOME: ctx.env.AGENT_WORKFLOW_HOME,
			AGENT_WORKFLOW_DASHBOARD_OPEN: "1",
		},
		open: () => {
			opens++;
			return true;
		},
	});
	assert.equal(piped.code, 0, piped.stderr);
	assert.equal(opens, 0);
	const failed = await invoke(ctx, [...args("opener failure"), "--open"], {
		open: () => {
			throw new Error("private error must not be printed");
		},
	});
	assert.equal(failed.code, 0, failed.stderr);
	assert.match(failed.stderr, /Could not open the browser/);
	assert.ok(!failed.stderr.includes("private error"));
});
test("ensure starts a real detached dashboard; status, reuse --open and stop round trip", {
	timeout: 10_000,
}, async (t) => {
	const ctx = await project(t);
	let pid;
	t.after(() => {
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	});
	const start = Date.now();
	const discovery = await ensureDashboard(ctx.cwd, ctx.env, { start: true });
	assert.ok(discovery);
	pid = discovery.pid;
	assert.notEqual(pid, process.pid);
	assert.ok(Date.now() - start < 3100);
	const status = await invoke(ctx, ["dashboard", "--status"]);
	assert.equal(status.code, 0, status.stderr);
	assert.ok(status.stdout.includes(`pid ${pid}`));
	assert.ok(status.stdout.includes(`127.0.0.1:${discovery.port}`));
	assert.ok(status.stdout.includes(discovery.startedAt));
	assert.ok(!status.stdout.includes(discovery.launchKey));
	const urls = [];
	const opened = await invoke(ctx, ["dashboard", "--open"], {
		open: (url) => {
			urls.push(url);
			return true;
		},
	});
	assert.equal(opened.code, 0, opened.stderr);
	assert.equal(urls.length, 1);
	assert.equal((await fetch(urls[0], { redirect: "manual" })).status, 302);
	assert.equal((await readDashboardDiscovery(ctx.cwd)).pid, pid);
	assert.equal((await invoke(ctx, ["dashboard", "--stop"])).code, 0);
	assert.equal(await readDashboardDiscovery(ctx.cwd), undefined);
	assert.equal((await invoke(ctx, ["dashboard", "--status"])).code, 1);
	assert.equal((await invoke(ctx, ["dashboard", "--stop"])).code, 1);
});

test("run --open starts a missing dashboard, while ordinary launches stay headless", {
	timeout: 10_000,
}, async (t) => {
	const ctx = await project(t);
	let dashboard;
	t.after(async () => {
		if (dashboard) {
			await invoke(ctx, ["dashboard", "--stop"]);
			try {
				process.kill(dashboard.pid, "SIGKILL");
			} catch {}
		}
	});
	const urls = [];
	const result = await invoke(
		ctx,
		[
			"run",
			"wf.json",
			"start a dashboard",
			"--executor",
			ctx.executor,
			"--open",
			"--json",
		],
		{
			open: (url) => {
				urls.push(url);
				return true;
			},
		},
	);
	dashboard = await readDashboardDiscovery(ctx.cwd);
	assert.equal(result.code, 0, result.stderr);
	assert.ok(dashboard);
	assert.equal(urls.length, 1);
	const runId = JSON.parse(result.stdout).data.runId;
	assert.equal(
		(await fetch(urls[0], { redirect: "manual" })).headers.get("location"),
		`/?run=${runId}`,
	);
});
test("dashboard --detached prints no token and io.signal removes discovery", {
	timeout: 5000,
}, async (t) => {
	const ctx = await project(t);
	const controller = new AbortController();
	t.after(() => controller.abort());
	let ready;
	const started = new Promise((done) => {
		ready = done;
	});
	const lines = [];
	const command = invoke(ctx, ["dashboard", "--detached"], {
		signal: controller.signal,
		stdout: (line) => {
			lines.push(line);
			ready();
		},
	});
	await started;
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^Dashboard listening on 127\.0\.0\.1:\d+\n$/);
	assert.ok(await readDashboardDiscovery(ctx.cwd));
	controller.abort();
	assert.equal((await command).code, 0);
	await assert.rejects(stat(dashboardDiscoveryPath(ctx.cwd)), {
		code: "ENOENT",
	});
});
test("terminal env opt-in opens once outside agent environments", {
	timeout: 10_000,
}, async (t) => {
	const ctx = await project(t);
	const s = await startDashboardServer({
		cwd: ctx.cwd,
		env: ctx.env,
		discovery: true,
	});
	t.after(() => s.close());
	const env = { ...ctx.env, AGENT_WORKFLOW_DASHBOARD_OPEN: "1" };
	for (const marker of [
		"CLAUDECODE",
		"CODEX_SANDBOX",
		"CODEX_THREAD_ID",
		"CURSOR_AGENT",
		"AI_AGENT",
	])
		delete env[marker];
	let opened = 0;
	const result = await invoke(
		ctx,
		["run", "wf.json", "terminal opt-in", "--executor", ctx.executor, "--yes"],
		{
			env,
			isTTY: true,
			open: () => {
				opened++;
				return true;
			},
		},
	);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(opened, 1);
});
