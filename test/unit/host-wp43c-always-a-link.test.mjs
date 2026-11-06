// WP43c "always a link": the dashboard session token persists per project (sign in once per
// browser), `--reset-session` rotates it, unsigned browsers get a sign-in page, launches auto-start
// a detached dashboard so the result always carries a token-free link, and detached dashboards
// idle out when nobody is watching and nothing is live.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { dashboardProject } from "../helpers/dashboard-project.mjs";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import {
	dashboardSessionPath,
	readDashboardDiscovery,
	resetDashboardSession,
} from "../../dist/hosts/dashboard/index.js";
import { setDashboardStartBudgetForTests } from "../../dist/hosts/dashboard/discovery.js";

// The dashboard a launch starts gets 15 s here instead of 3 s: these tests check the auto-start
// and the link, not how fast a loaded machine (the whole suite in parallel) boots Node.
setDashboardStartBudgetForTests(15_000);

setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
let counter = 0;

async function project(t) {
	const fixture = await dashboardProject(t, "aw-wp43c-");
	const { cwd } = fixture;
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
	fixture.dispose(
		registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: executor,
				effectLog: join(cwd, "effects.jsonl"),
			}),
		),
	);
	const env = {
		...process.env,
		AGENT_WORKFLOW_DASHBOARD_OPEN: "0",
		// The unit runner disables auto-start globally; this suite covers it, so opt in.
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "1",
	};
	delete env.AGENT_WORKFLOW_ROLE;
	return { ...fixture, executor, env, host: "cli" };
}

const cookieOf = (url) => `aw_session=${url.split("token=")[1]}`;
async function get(origin, path, headers = {}) {
	const response = await fetch(origin + path, { headers, redirect: "manual" });
	const text = await response.text();
	return { status: response.status, text, headers: response.headers };
}

test("--auth: the session persists across dashboard restarts; --reset-session signs every browser out", {
	timeout: 60_000,
}, async (t) => {
	const p = await project(t);
	const first = await p.start({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		auth: true,
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
	const second = await p.start({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		auth: true,
	});
	assert.equal(second.token, first.token, "same project → same session token");
	assert.equal(
		second.port,
		first.port,
		"same project → same port when it is free (old links keep working)",
	);
	assert.equal(
		(await get(`http://127.0.0.1:${second.port}`, "/api/session", { cookie }))
			.status,
		200,
		"a browser signed in before the restart is still signed in",
	);
	await second.close();
	const rotated = await resetDashboardSession(p.cwd);
	assert.notEqual(rotated, first.token);
	// Preferred port taken by someone else → falls back to an ephemeral port instead of failing.
	const squatter = await p.start({
		cwd: p.cwd,
		env: p.env,
		port: first.port,
	});
	const third = await p.start({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		auth: true,
	});
	assert.notEqual(third.port, first.port);
	await squatter.close();
	assert.equal(third.token, rotated);
	assert.equal(
		(await get(`http://127.0.0.1:${third.port}`, "/api/session", { cookie }))
			.status,
		401,
	);
});

test("--auth: an unsigned browser gets the sign-in page: project name only, no token, no paths", {
	timeout: 60_000,
}, async (t) => {
	const p = await project(t);
	const s = await p.start({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		auth: true,
	});
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
	timeout: 60_000,
}, async (t) => {
	const p = await project(t);

	// Off switch: no dashboard, honest line.
	const off = await p.launch(
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
	const worker = await p
		.launch(
			{ ...p, env: { ...p.env, AGENT_WORKFLOW_ROLE: "worker" } },
			{ workflow: "wf.json", task: "worker", executor: p.executor },
		)
		.catch((error) => ({ refused: String(error) }));
	if (!("refused" in worker)) assert.equal(worker.data.dashboard, undefined);
	assert.equal(await readDashboardDiscovery(p.cwd), undefined);
	// Default: auto-start, plain link (WP43d: no sign-in, so no first-time hint).
	const started = await p.launch(p, {
		workflow: "wf.json",
		task: "autostart",
		executor: p.executor,
	});
	assert.equal(started.data.dashboard?.started, true, started.text);
	const discovery = await readDashboardDiscovery(p.cwd);
	assert.ok(discovery, "a detached dashboard is running");
	assert.equal(discovery.detached, true);
	assert.equal(discovery.auth, false);
	assert.equal(started.data.dashboard.port, discovery.port);
	assert.equal(
		started.data.dashboard.url,
		`http://127.0.0.1:${discovery.port}/?run=${started.data.runId}`,
	);
	assert.equal(started.data.dashboard.auth, undefined);
	assert.match(
		started.text,
		/Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?run=workflow_[\w-]+\n/,
	);
	assert.doesNotMatch(started.text, /first time in this browser|token=/);
	// A second launch reuses it: plain link, no hint, same port.
	const reused = await p.launch(p, {
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
	// The detached server is open: the link and the API work without any cookie, and no session
	// file was created.
	const run = await get(
		`http://127.0.0.1:${discovery.port}`,
		`/api/runs/${reused.data.runId}`,
	);
	assert.equal(run.status, 200);
	assert.equal(run.headers.get("set-cookie"), null);
	const page = await get(
		`http://127.0.0.1:${discovery.port}`,
		`/?run=${reused.data.runId}`,
	);
	assert.equal(page.status, 200);
	assert.doesNotMatch(page.text, /isn't signed in/);
	await assert.rejects(stat(dashboardSessionPath(p.cwd)), { code: "ENOENT" });
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
	timeout: 60_000,
}, async (t) => {
	const p = await project(t);
	let idled = 0;
	const s = await p.start({
		cwd: p.cwd,
		env: p.env,
		discovery: true,
		idleExitMs: 1500,
		idleCheckMs: 300,
		onIdleExit: () => {
			idled += 1;
		},
	});
	// A connected SSE client keeps it alive past the idle window.
	const controller = new AbortController();
	t.after(() => controller.abort());
	const stream = fetch(`http://127.0.0.1:${s.port}/api/events`, {
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

test("--auth: one-click local sign-in: the page's own script may ask the server to open a signed-in tab; cross-site callers may not", {
	timeout: 60_000,
}, async (t) => {
	const p = await project(t);
	const log = join(p.cwd, "opened.log");
	const recorder = join(p.cwd, "browser.sh");
	await writeFile(recorder, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\n`);
	await (await import("node:fs/promises")).chmod(recorder, 0o755);
	const s = await p.start({
		cwd: p.cwd,
		env: { ...p.env, BROWSER: recorder },
		discovery: true,
		auth: true,
	});
	const origin = `http://127.0.0.1:${s.port}`;
	const page = await get(origin, "/?run=workflow_abc");
	assert.equal(page.status, 401);
	assert.match(page.text, /id="signin"/);
	assert.match(page.text, /<script src="\/signin\.js">/);
	assert.match(page.text, /<link rel="stylesheet" href="\/app\.css">/);
	const script = await get(origin, "/signin.js");
	assert.equal(script.status, 200);
	assert.match(script.headers.get("content-type"), /javascript/);
	assert.match(script.text, /\/api\/signin-local/);
	assert.doesNotMatch(script.text, /token=/);
	assert.equal(
		(await get(origin, "/app.css")).status,
		200,
		"stylesheet is public",
	);
	const post = (headers, body = { next: "?run=workflow_abc" }) =>
		fetch(`${origin}/api/signin-local`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	assert.equal((await post({})).status, 403, "no fetch metadata → refused");
	assert.equal(
		(await post({ "sec-fetch-site": "cross-site", origin })).status,
		403,
		"cross-site → refused",
	);
	assert.equal(
		(
			await post({
				"sec-fetch-site": "same-origin",
				origin: "http://evil.example",
			})
		).status,
		403,
		"foreign origin → refused",
	);
	const ok = await post({ "sec-fetch-site": "same-origin", origin });
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { opened: true });
	assert.equal(
		(await post({ "sec-fetch-site": "same-origin", origin })).status,
		429,
		"one open per few seconds",
	);
	let recorded = "";
	// The BROWSER stand-in writes asynchronously: poll up to 15 s (3 s was too short under load).
	for (let i = 0; i < 150 && !recorded; i++) {
		await new Promise((r) => setTimeout(r, 100));
		recorded = await readFile(log, "utf8").catch(() => "");
	}
	const url = recorded.trim();
	assert.match(
		url,
		new RegExp(`^${origin}/\\?token=[A-Za-z0-9_-]{43}&run=workflow_abc$`),
	);
	assert.notEqual(
		url.split("token=")[1].split("&")[0],
		s.token,
		"a one-time token, not the session",
	);
	const boot = await fetch(url, { redirect: "manual" });
	assert.equal(boot.status, 302);
	assert.equal(boot.headers.get("location"), "/?run=workflow_abc");
	assert.match(boot.headers.get("set-cookie"), /aw_session=/);
	await boot.arrayBuffer();
	assert.equal(
		(await fetch(url, { redirect: "manual" })).status,
		401,
		"single use",
	);
});
