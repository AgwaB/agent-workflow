// WP43c "always a link": the dashboard session token persists per project (sign in once per
// browser), `--reset-session` rotates it, unsigned browsers get a sign-in page, launches auto-start
// a detached dashboard so the result always carries a token-free link, and detached dashboards
// idle out when nobody is watching and nothing is live.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { runWorkflowAction } from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import {
	dashboardSessionPath,
	readDashboardDiscovery,
	resetDashboardSession,
	startDashboardServer,
} from "../../dist/hosts/dashboard/index.js";

setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
let counter = 0;

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43c-"));
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
			name: "always-a-link",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const executor = `wp43c-fixture-${++counter}`;
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
	delete env.AGENT_WORKFLOW_ROLE;
	return { cwd, executor, env, host: "cli" };
}

const cookieOf = (url) => `aw_session=${url.split("token=")[1]}`;
async function get(origin, path, headers = {}) {
	const response = await fetch(origin + path, { headers, redirect: "manual" });
	const text = await response.text();
	return { status: response.status, text, headers: response.headers };
}

test("the session persists across dashboard restarts; --reset-session signs every browser out", {
	timeout: 20_000,
}, async (t) => {
	const p = await project(t);
	const first = await startDashboardServer({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
	});
	const sessionFile = dashboardSessionPath(p.cwd);
	assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
	assert.equal((await readFile(sessionFile, "utf8")).trim(), first.token);
	const cookie = cookieOf(first.url);
	assert.equal(
		(await get(`http://127.0.0.1:${first.port}`, "/api/session", { cookie }))
			.status,
		200,
	);
	await first.close();
	const second = await startDashboardServer({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
	});
	t.after(() => second.close());
	assert.equal(second.token, first.token, "same project → same session token");
	assert.equal(
		(await get(`http://127.0.0.1:${second.port}`, "/api/session", { cookie }))
			.status,
		200,
		"a browser signed in before the restart is still signed in",
	);
	await second.close();
	const rotated = await resetDashboardSession(p.cwd);
	assert.notEqual(rotated, first.token);
	const third = await startDashboardServer({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
	});
	t.after(() => third.close());
	assert.equal(third.token, rotated);
	assert.equal(
		(await get(`http://127.0.0.1:${third.port}`, "/api/session", { cookie }))
			.status,
		401,
	);
});

test("an unsigned browser gets the sign-in page: project name only, no token, no paths", {
	timeout: 15_000,
}, async (t) => {
	const p = await project(t);
	const s = await startDashboardServer({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
	});
	t.after(() => s.close());
	const page = await get(`http://127.0.0.1:${s.port}`, "/?run=workflow_x");
	assert.equal(page.status, 401);
	assert.match(page.headers.get("content-type"), /text\/html/);
	assert.match(
		page.text,
		/isn't signed in to the agent-workflow dashboard for/,
	);
	assert.match(page.text, /agent-workflow dashboard --open/);
	assert.match(page.text, /ask your agent to open the dashboard/);
	assert.ok(page.text.includes(p.cwd.split("/").pop()), "project basename");
	assert.doesNotMatch(page.text, /token=|launchKey/);
	assert.ok(!page.text.includes(p.cwd), "no absolute path");
	assert.match(
		page.headers.get("content-security-policy"),
		/default-src 'none'/,
	);
});

test("a launch auto-starts a detached dashboard and always carries a token-free link; off switch and worker role respected", {
	timeout: 40_000,
}, async (t) => {
	const p = await project(t);
	t.after(async () => {
		await runAgentWorkflowCli(["dashboard", "--stop", "--project", p.cwd], {
			cwd: p.cwd,
			env: p.env,
			stdout: () => {},
			stderr: () => {},
			isTTY: false,
		}).catch(() => undefined);
	});
	// Off switch: no dashboard, honest line.
	const off = await runWorkflowAction(
		{ ...p, env: { ...p.env, AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0" } },
		{ workflow: "wf.json", task: "off", executor: p.executor },
	);
	assert.equal(off.data.dashboard, undefined);
	assert.match(
		off.text,
		/Dashboard: not running · agent-workflow dashboard --open/,
	);
	assert.equal(await readDashboardDiscovery(p.cwd), undefined);
	// Worker role: never starts one.
	const worker = await runWorkflowAction(
		{ ...p, env: { ...p.env, AGENT_WORKFLOW_ROLE: "worker" } },
		{ workflow: "wf.json", task: "worker", executor: p.executor },
	).catch((error) => ({ refused: String(error) }));
	if (!("refused" in worker)) assert.equal(worker.data.dashboard, undefined);
	assert.equal(await readDashboardDiscovery(p.cwd), undefined);
	// Default: auto-start, link with the first-time hint.
	const started = await runWorkflowAction(p, {
		workflow: "wf.json",
		task: "autostart",
		executor: p.executor,
	});
	assert.equal(started.data.dashboard?.started, true, started.text);
	const discovery = await readDashboardDiscovery(p.cwd);
	assert.ok(discovery, "a detached dashboard is running");
	assert.equal(discovery.detached, true);
	assert.equal(started.data.dashboard.port, discovery.port);
	assert.equal(
		started.data.dashboard.url,
		`http://127.0.0.1:${discovery.port}/?run=${started.data.runId}`,
	);
	assert.match(
		started.text,
		/Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?run=workflow_[\w-]+ · first time in this browser\? agent-workflow dashboard --open/,
	);
	assert.doesNotMatch(started.text, /token=/);
	// A second launch reuses it: plain link, no hint, same port.
	const reused = await runWorkflowAction(p, {
		workflow: "wf.json",
		task: "reuse",
		executor: p.executor,
	});
	assert.equal(reused.data.dashboard?.started, undefined);
	assert.equal(reused.data.dashboard.port, discovery.port);
	assert.match(
		reused.text,
		/Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?run=workflow_[\w-]+\n/,
	);
	assert.doesNotMatch(reused.text, /first time in this browser/);
	// The detached server uses the persisted session: a browser signed in earlier can open the link.
	const token = (await readFile(dashboardSessionPath(p.cwd), "utf8")).trim();
	const run = await get(
		`http://127.0.0.1:${discovery.port}`,
		`/api/runs/${reused.data.runId}`,
		{
			cookie: `aw_session=${token}`,
		},
	);
	assert.equal(run.status, 200);
	// --status reports the idle exit.
	const lines = [];
	await runAgentWorkflowCli(["dashboard", "--status", "--project", p.cwd], {
		cwd: p.cwd,
		env: p.env,
		stdout: (line) => lines.push(line),
		stderr: () => {},
		isTTY: false,
	});
	assert.match(lines.join(""), /idle exit in \d+m/);
});

test("a detached dashboard idles out only with no SSE client and no live run", {
	timeout: 30_000,
}, async (t) => {
	const p = await project(t);
	let idled = 0;
	const s = await startDashboardServer({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		idleExitMs: 1500,
		onIdleExit: () => {
			idled += 1;
		},
	});
	t.after(() => s.close().catch(() => undefined));
	const cookie = cookieOf(s.url);
	// A connected SSE client keeps it alive past the idle window.
	const controller = new AbortController();
	const stream = fetch(`http://127.0.0.1:${s.port}/api/events`, {
		headers: { cookie },
		signal: controller.signal,
	});
	await new Promise((resolve) => setTimeout(resolve, 3000));
	assert.equal(idled, 0, "not idle while a client is connected");
	assert.ok(await readDashboardDiscovery(p.cwd));
	controller.abort();
	await stream.catch(() => undefined);
	// Alone, it exits within a few checks and removes its discovery file.
	const deadline = Date.now() + 20_000;
	while (idled === 0 && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(idled, 1, "idled out once nobody watched");
	assert.equal(await readDashboardDiscovery(p.cwd), undefined);
});
