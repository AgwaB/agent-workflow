import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import {
	dashboardDiscoveryPath,
	dashboardSessionPath,
	ensureDashboard,
	readDashboardDiscovery,
	readOrCreateDashboardSession,
	resetDashboardSession,
	setDashboardStartBudgetForTests,
} from "../../dist/hosts/dashboard/discovery.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";

// The dashboard a launch starts gets 15 s here instead of 3 s: these tests check the auto-start
// and the link, not how fast a loaded machine (the whole suite in parallel) boots Node.
setDashboardStartBudgetForTests(15_000);

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43c-session-"));
	const servers = [];
	t.after(async () => {
		for (const server of servers) await server.close();
		await cli(cwd, ["--stop"]);
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	return {
		cwd,
		// WP43d: these are the --auth (persistent session) contracts; open mode has no session.
		start: async (options = {}) => {
			const server = await startDashboardServer({
				cwd,
				discovery: true,
				env: {},
				auth: true,
				...options,
			});
			servers.push(server);
			return server;
		},
	};
}
async function cli(cwd, args, env = {}) {
	let stdout = "",
		stderr = "";
	const code = await runAgentWorkflowCli(["dashboard", ...args], {
		cwd,
		env,
		isTTY: false,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stdout, stderr };
}
async function http(server, path, cookie) {
	const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
		headers: cookie ? { Cookie: cookie } : {},
		redirect: "manual",
		signal: AbortSignal.timeout(2000),
	});
	const text = await response.text();
	return { status: response.status, headers: response.headers, text };
}

test("session creation is atomic and private; malformed sessions regenerate", async (t) => {
	const { cwd } = await project(t);
	const tokens = await Promise.all(
		Array.from({ length: 12 }, () => readOrCreateDashboardSession(cwd)),
	);
	assert.equal(new Set(tokens).size, 1);
	const path = dashboardSessionPath(cwd);
	assert.equal(path, join(cwd, ".agent-workflow/dashboard-session"));
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	for (const malformed of [
		"",
		"x".repeat(42),
		"x".repeat(44),
		"/".repeat(43),
		"not a token",
	]) {
		await writeFile(path, malformed);
		const repaired = await Promise.all(
			Array.from({ length: 8 }, () => readOrCreateDashboardSession(cwd)),
		);
		assert.equal(new Set(repaired).size, 1);
		const regenerated = repaired[0];
		assert.match(regenerated, /^[A-Za-z0-9_-]{43}$/);
		assert.notEqual(regenerated, tokens[0]);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
	const before = await readOrCreateDashboardSession(cwd);
	assert.notEqual(await resetDashboardSession(cwd), before);
});

test("cookie survives two starts; CLI reset stops a detached server and invalidates the old cookie", {
	timeout: 60_000,
}, async (t) => {
	const { cwd, start } = await project(t);
	const first = await start();
	const boot = await http(first, `/?token=${first.token}`);
	assert.equal(boot.status, 302);
	const cookie = boot.headers.get("set-cookie").split(";")[0];
	await first.close();
	const second = await start();
	assert.equal(second.token, first.token);
	assert.equal((await http(second, "/api/session", cookie)).status, 200);
	assert.notEqual(second.launchKey, first.launchKey);
	await second.close();
	const detached = await ensureDashboard(
		cwd,
		{
			...process.env,
			AGENT_WORKFLOW_DASHBOARD_IDLE_MS: "120000",
			AGENT_WORKFLOW_DASHBOARD_AUTH: "1",
		},
		{ start: true },
	);
	assert.ok(detached);
	assert.equal(detached.auth, true);
	assert.equal((await http(detached, "/api/session", cookie)).status, 200);
	assert.equal(detached.detached, true);
	assert.ok(Number.isFinite(Date.parse(detached.idleExitAt)));
	const status = await cli(cwd, ["--status"]);
	assert.equal(status.code, 0, status.stderr);
	assert.match(status.stdout, /auth on, idle exit in 2m/);
	const reset = await cli(cwd, ["--reset-session"]);
	assert.equal(reset.code, 0, reset.stderr);
	assert.equal(await readDashboardDiscovery(cwd), undefined);
	await assert.rejects(stat(dashboardDiscoveryPath(cwd)), { code: "ENOENT" });
	await assert.rejects(http(detached, "/api/session", cookie));
	const third = await start();
	assert.notEqual(third.token, first.token);
	assert.equal((await http(third, "/api/session", cookie)).status, 401);
	assert.equal((await stat(dashboardSessionPath(cwd))).mode & 0o777, 0o600);
	await third.close();
	assert.equal((await cli(cwd, ["--reset-session"])).code, 0);
});

test("open mode never creates a session file; --status reports auth off", {
	timeout: 60_000,
}, async (t) => {
	const { cwd, start } = await project(t);
	const server = await start({ auth: false });
	assert.equal(server.auth, false);
	await assert.rejects(stat(dashboardSessionPath(cwd)), { code: "ENOENT" });
	assert.equal((await http(server, "/")).status, 200);
	await server.close();
	const detached = await ensureDashboard(
		cwd,
		{ ...process.env, AGENT_WORKFLOW_DASHBOARD_IDLE_MS: "120000" },
		{ start: true },
	);
	assert.ok(detached);
	assert.equal(detached.auth, false);
	assert.equal((await http(detached, "/api/session")).status, 200);
	const status = await cli(cwd, ["--status"]);
	assert.equal(status.code, 0, status.stderr);
	assert.match(status.stdout, /auth off, idle exit in 2m/);
	await assert.rejects(stat(dashboardSessionPath(cwd)), { code: "ENOENT" });
	assert.equal((await cli(cwd, ["--stop"])).code, 0);
});

test("401 sign-in page uses only escaped project basename, no path or credentials", async (t) => {
	const { cwd, start } = await project(t);
	const server = await start();
	// app.css is public (the sign-in page is styled with it); the page and the app script are not.
	assert.equal((await http(server, "/app.css")).status, 200);
	for (const path of ["/", "/?run=workflow_test", "/app.js"]) {
		const response = await http(server, path);
		assert.equal(response.status, 401);
		assert.match(response.headers.get("content-type"), /text\/html/);
		assert.ok(response.headers.get("content-security-policy"));
		assert.ok(
			response.text.includes(
				`This browser isn't signed in to the agent-workflow dashboard for ${basename(cwd)}.`,
			),
		);
		assert.match(
			response.text,
			/Sign in once; after that, links like this one open directly\./,
		);
		assert.match(response.text, /id="signin"/);
		assert.match(
			response.text,
			/Or run <code>agent-workflow dashboard --open<\/code> in a terminal, or ask your agent to open the dashboard\./,
		);
		for (const secret of [cwd, server.token, server.launchKey])
			assert.ok(!response.text.includes(secret));
		assert.doesNotMatch(
			response.text,
			/<script>|token=|<script src="(?!\/signin\.js")/,
		);
	}
	const explicit = await start({ token: "a".repeat(43), discovery: false });
	assert.equal(explicit.token, "a".repeat(43));
});

test("invalid detached idle environment is usage exit 2; foreground ignores it", async (t) => {
	const { cwd } = await project(t);
	for (const value of [
		"",
		"wat",
		"NaN",
		"Infinity",
		"59999",
		"-1",
		"60000.5",
		"9007199254740992",
	]) {
		const result = await cli(cwd, ["--detached"], {
			AGENT_WORKFLOW_DASHBOARD_IDLE_MS: value,
		});
		assert.equal(result.code, 2, result.stderr);
		assert.match(result.stderr, /AGENT_WORKFLOW_DASHBOARD_IDLE_MS/);
	}
	const controller = new AbortController();
	const result = await runAgentWorkflowCli(["dashboard"], {
		cwd,
		env: { AGENT_WORKFLOW_DASHBOARD_IDLE_MS: "invalid" },
		signal: controller.signal,
		stdout: () => controller.abort(),
		stderr: () => {},
	});
	assert.equal(result, 0);
});

/**
 * Wait for the idle check's async work (file I/O included) to settle. Bounded by real time, not a
 * count of event-loop turns: 1000 turns were not enough on a loaded machine. Only setInterval is
 * mocked here, so setTimeout and Date are real.
 */
async function until(predicate) {
	const deadline = Date.now() + 10_000;
	for (let n = 0; Date.now() < deadline; n++) {
		if (await predicate()) return;
		if (n % 100 === 99) await new Promise((done) => setTimeout(done, 5));
		else await immediate();
	}
	assert.fail("idle callback did not settle");
}

for (const protection of ["none", "SSE", "live run", "source failure"]) {
	test(`60s idle check with idleExitMs 1500: ${protection}`, async (t) => {
		const { cwd, start } = await project(t);
		t.mock.timers.enable({ apis: ["setInterval"] });
		let now = Date.now(),
			exited = false,
			calls = 0,
			live = protection === "live run",
			fails = protection === "source failure";
		const source = {
			listRuns: async () => {
				calls++;
				if (fails) throw new Error("unavailable");
				return live ? [{ live: true }] : [];
			},
		};
		const server = await start({
			source,
			now: () => now,
			idleExitMs: 1500,
			onIdleExit: () => {
				exited = true;
			},
		});
		let stream;
		if (protection === "SSE") {
			stream = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
				headers: { Cookie: `aw_session=${server.token}` },
			});
			assert.equal(stream.status, 200);
		}
		now += 1600;
		const before = calls;
		t.mock.timers.tick(59_999);
		assert.equal(exited, false, "checks run every 60 seconds");
		t.mock.timers.tick(1);
		await until(() => calls > before);
		if (protection === "none") {
			await until(() => exited);
		} else {
			await http(server, "/api/session", `aw_session=${server.token}`);
			assert.equal(exited, false);
			assert.ok(await readDashboardDiscovery(cwd));
			if (stream) {
				await stream.body.cancel();
				// Let the server observe the stream close before advancing its clock.
				await new Promise((done) => setTimeout(done, 50));
			}
			live = false;
			fails = false;
			now += 1600;
			// Under a loaded suite the previous check may still be writing its discovery update when
			// this tick fires (the `checking` guard then skips it) — keep ticking like the real clock.
			for (let n = 0; n < 200 && !exited; n++) {
				t.mock.timers.tick(60_000);
				await new Promise((done) => setTimeout(done, 10));
			}
			assert.ok(exited, "idle exit after the protection ends");
		}
		await assert.rejects(stat(dashboardDiscoveryPath(cwd)), { code: "ENOENT" });
		await assert.rejects(http(server, "/api/session"));
		assert.ok(
			await readFile(dashboardSessionPath(cwd), "utf8"),
			"idle exit preserves sign-in",
		);
	});
}

test("foreground servers do not idle out", async (t) => {
	const { start } = await project(t);
	t.mock.timers.enable({ apis: ["setInterval"] });
	let now = Date.now();
	const server = await start({
		now: () => now,
		source: { listRuns: async () => [] },
	});
	now += 10_000_000;
	t.mock.timers.tick(10_000_000);
	assert.equal(
		(await http(server, "/api/session", `aw_session=${server.token}`)).status,
		200,
	);
});
