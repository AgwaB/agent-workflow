// User scope, identity, startup races and all-project liveness. Never use the user's fixed ports.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { Server } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { agentWorkflowHome } from "../../dist/core/home-dir.js";
import {
	registerProject,
	projectId,
	stateBase,
	listRegisteredProjects,
} from "../../dist/core/state-location.js";
import { dashboardProject } from "../helpers/dashboard-project.mjs";
import { startDashboardServer } from "../helpers/dashboard-server.mjs";
import { dashboardPortCandidates } from "../../dist/hosts/dashboard/ports.js";
import {
	DASHBOARD_PROTOCOL,
	dashboardDiscoveryPath,
	dashboardPortPath,
	readDashboardDiscovery,
	probeDashboard,
	mintLaunchUrl,
	ensureDashboard,
	writeDashboardDiscovery,
	writePreferredDashboardPort,
	setDashboardStartBudgetForTests,
} from "../../dist/hosts/dashboard/discovery.js";

setDashboardStartBudgetForTests(15_000);
async function waitFor(read, accepts = Boolean) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const value = await read();
		if (accepts(value)) return value;
		await sleep(25);
	}
	assert.fail("condition did not settle");
}
async function listener(t, handler) {
	const server = createServer(handler);
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return server.address().port;
}
async function persistRun(cwd, status) {
	const dir = join(
		stateBase(cwd),
		".agent-workflow/workflows/workflow_overview",
	);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId: "workflow_overview",
			name: "Overview",
			type: "workflow",
			cwd,
			status,
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-06T00:00:00.000Z",
			tasks: [
				{
					taskId: "task-1",
					specId: "work.main",
					stageId: "work",
					agent: "reader",
					agentFile: "",
					agentDescription: "reader",
					roles: [],
					displayName: "Work",
					kind: "single",
					status,
					statusDetail: status,
					runtime: { approvalMode: "never" },
					worktree: {
						enabled: false,
						path: null,
						branch: null,
						baseCwd: null,
						warning: null,
					},
					cwd,
					backendTaskId: "",
					files: {
						output: "",
						stderr: "",
						systemPrompt: "",
						taskPrompt: "",
						result: "",
					},
				},
			],
			taskSummary: {
				total: 1,
				pending: 0,
				running: 0,
				blocked: status === "blocked" ? 1 : 0,
				completed: status === "completed" ? 1 : 0,
				failed: 0,
				skipped: 0,
				interrupted: 0,
			},
		}),
	);
}

test("pure port policy covers explicit CLI/env, default range, custom last port and ephemeral", () => {
	assert.deepEqual(
		dashboardPortCandidates({
			explicit: 12345,
			customHome: false,
			lastPort: 23456,
		}),
		[12345],
	);
	assert.deepEqual(
		dashboardPortCandidates({ explicit: 12345, customHome: true }),
		[12345],
	);
	assert.deepEqual(
		dashboardPortCandidates({ customHome: false, lastPort: 23456 }),
		[7417, 7418, 7419, 7420, 7421, 7422, 7423, 7424, 7425, 7426, 0],
	);
	assert.deepEqual(
		dashboardPortCandidates({ customHome: true, lastPort: 23456 }),
		[23456, 0],
	);
	assert.deepEqual(dashboardPortCandidates({ customHome: true }), [0]);
});

test("identity is a nonce-specific HMAC; wrong keys, replayed nonces and foreign listeners fail without credentials", async (t) => {
	const p = await dashboardProject(t, "aw-user-identity-");
	const server = await p.start({ discovery: true, auth: true });
	const discovery = await readDashboardDiscovery(p.cwd);
	assert.ok(await probeDashboard(discovery));
	assert.equal(
		await probeDashboard({ ...discovery, launchKey: "x".repeat(43) }),
		false,
	);
	const nonce = "n".repeat(43);
	const response = await fetch(
		`http://127.0.0.1:${server.port}/api/identity?nonce=${nonce}`,
	);
	assert.equal(response.status, 200);
	const identity = await response.json();
	assert.equal(
		identity.proof,
		createHmac("sha256", server.launchKey).update(nonce).digest("hex"),
	);
	assert.equal(identity.protocol, DASHBOARD_PROTOCOL);
	assert.notEqual(
		identity.proof,
		createHmac("sha256", server.launchKey).update("other-nonce").digest("hex"),
	);
	assert.equal(
		(await fetch(`http://127.0.0.1:${server.port}/api/identity?nonce=bad`))
			.status,
		400,
	);
	let requests = 0;
	const foreignPort = await listener(t, (req, res) => {
		requests++;
		assert.match(req.url, /^\/api\/identity\?nonce=/);
		assert.equal(req.headers["x-aw-launch-key"], undefined);
		assert.equal(req.headers.cookie, undefined);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(identity)); // A proof for the wrong nonce must never be accepted.
	});
	const foreign = { ...discovery, port: foreignPort };
	assert.equal(await probeDashboard(foreign), false);
	await assert.rejects(
		mintLaunchUrl(foreign, { project: projectId(p.cwd) }),
		/identity/,
	);
	assert.equal(requests, 2, "no launch-key request followed the failed probes");
});

test("a foreign listener on the preferred ephemeral port is not adopted; strict CLI/env ports never fall back", async (t) => {
	const p = await dashboardProject(t, "aw-user-foreign-");
	let requests = 0;
	const occupied = await listener(t, (req, res) => {
		requests++;
		assert.equal(req.headers["x-aw-launch-key"], undefined);
		assert.equal(req.headers.cookie, undefined);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"apiVersion":2,"auth":false}');
	});
	await writeDashboardDiscovery(p.cwd, {
		pid: process.pid,
		port: occupied,
		launchKey: "a".repeat(43),
	});
	await writePreferredDashboardPort(p.cwd, occupied);
	const found = await p.ensure({ ...process.env });
	assert.ok(found);
	assert.notEqual(found.port, occupied);
	assert.ok(found.port < 7417 || found.port > 7426);
	assert.ok(requests > 0);
	for (const options of [
		{ port: occupied },
		{ env: { AGENT_WORKFLOW_DASHBOARD_PORT: String(occupied) } },
	])
		await assert.rejects(
			startDashboardServer({ cwd: p.cwd, ...options }),
			/port is unavailable/,
		);
	assert.equal(
		Number((await readFile(dashboardPortPath(p.cwd), "utf8")).trim()),
		found.port,
	);
});

test("two concurrent ensures across projects publish one user server; stale discovery and dead/expired locks recover", async (t) => {
	const p = await dashboardProject(t, "aw-user-lock-");
	const other = join(p.cwd, "second");
	await mkdir(other);
	await registerProject(other);
	await writeDashboardDiscovery(p.cwd, {
		pid: 2147483647,
		port: 1234,
		launchKey: "a".repeat(43),
	});
	assert.equal(await readDashboardDiscovery(other), undefined);
	await assert.rejects(stat(dashboardDiscoveryPath(p.cwd)), { code: "ENOENT" });
	const lock = join(agentWorkflowHome(), "dashboard.lock");
	await writeFile(
		lock,
		JSON.stringify({ pid: 2147483647, startedAt: Date.now(), owner: "dead" }),
		{ mode: 0o600 },
	);
	const [a, b] = await Promise.all([
		p.ensure({ ...process.env }),
		ensureDashboard(other, { ...process.env }, { start: true }),
	]);
	assert.ok(a);
	assert.ok(b);
	assert.equal(a.pid, b.pid);
	assert.equal(a.port, b.port);
	assert.equal(a.launchKey, b.launchKey);
	await assert.rejects(stat(lock), { code: "ENOENT" });
	await writeFile(
		lock,
		JSON.stringify({ pid: process.pid, startedAt: 0, owner: "expired" }),
		{ mode: 0o600 },
	);
	assert.equal((await p.ensure({ ...process.env })).pid, a.pid);
});

test("new launcher authenticates shutdown of older protocol and takes its port; older launcher reuses newer", async (t) => {
	const p = await dashboardProject(t, "aw-user-protocol-");
	const older = await p.start({
		discovery: true,
		protocol: DASHBOARD_PROTOCOL - 1,
	});
	const origin = `http://127.0.0.1:${older.port}`;
	assert.equal(
		(await fetch(`${origin}/api/shutdown`, { method: "POST" })).status,
		401,
	);
	assert.equal(
		(
			await fetch(`${origin}/api/shutdown`, {
				method: "POST",
				headers: {
					"X-AW-Launch-Key": older.launchKey,
					Origin: "http://evil.invalid",
				},
			})
		).status,
		403,
	);
	const replacement = await p.ensure({ ...process.env });
	assert.equal(replacement.protocol, DASHBOARD_PROTOCOL);
	assert.equal(replacement.port, older.port);
	assert.notEqual(replacement.launchKey, older.launchKey);
	// Stop the detached replacement through its authenticated endpoint before embedding a newer one.
	const { shutdownDashboard } = await import(
		"../../dist/hosts/dashboard/discovery.js"
	);
	await shutdownDashboard(replacement);
	await waitFor(
		() => readDashboardDiscovery(p.cwd),
		(value) => !value,
	);
	const newer = await p.start({
		discovery: true,
		protocol: DASHBOARD_PROTOCOL + 1,
	});
	const reused = await p.ensure({ ...process.env });
	assert.equal(reused.pid, process.pid);
	assert.equal(reused.launchKey, newer.launchKey);
	assert.equal(reused.protocol, DASHBOARD_PROTOCOL + 1);
});

test("registry overview lists two projects, counts summaries and retains missing paths; unsafe entries stay hidden", async (t) => {
	const p = await dashboardProject(t, "aw-user-projects-");
	const other = join(p.cwd, "other");
	await mkdir(other);
	await registerProject(other);
	await persistRun(p.cwd, "completed");
	await persistRun(other, "blocked");
	const server = await p.start();
	const otherId = projectId(other);
	const otherBase = stateBase(other);
	await rm(other, { recursive: true });
	const response = await fetch(`http://127.0.0.1:${server.port}/api/projects`);
	const { projects } = await response.json();
	assert.equal(projects.length, 2);
	assert.deepEqual(
		projects.find((project) => project.id === projectId(p.cwd)).counts,
		{ running: 0, needsAttention: 0, lastActivity: "2026-11-06T00:00:00.000Z" },
	);
	const missing = projects.find((project) => project.id === otherId);
	assert.equal(missing.pathMissing, true);
	assert.deepEqual(missing.counts, {
		running: 1,
		needsAttention: 1,
		lastActivity: "2026-11-06T00:00:00.000Z",
	});
	assert.equal(
		(
			await fetch(
				`http://127.0.0.1:${server.port}/api/projects/${missing.id}/runs`,
			)
		).status,
		200,
	);
	const registry = join(otherBase, "project.json");
	await chmod(registry, 0o644);
	assert.equal(
		(await listRegisteredProjects()).length,
		1,
		"public-readable registry is not trusted",
	);
	await chmod(registry, 0o600);
	const saved = await readFile(registry, "utf8");
	await rm(registry);
	await symlink(join(stateBase(p.cwd), "project.json"), registry);
	assert.equal(
		(await listRegisteredProjects()).length,
		1,
		"symlink registry is not trusted",
	);
	await rm(registry);
	await writeFile(registry, saved, { mode: 0o600 });
});

test("malformed/unknown project ids fail before any source access; old unscoped routes are gone", async (t) => {
	const p = await dashboardProject(t, "aw-user-validation-");
	let accesses = 0;
	const server = await p.start({
		source: {
			listRuns: async () => {
				accesses++;
				return [];
			},
			run: async () => {
				accesses++;
			},
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	for (const [id, status] of [
		["bad", 400],
		["x-123456789abc", 404],
		["bad%2Fid", 400],
		["bad%00id", 400],
		["%ZZ", 400],
	]) {
		assert.equal(
			(await fetch(`${origin}/api/projects/${id}/runs`)).status,
			status,
		);
		assert.equal(
			(await fetch(`${origin}/api/events?project=${id}`)).status,
			status,
		);
	}
	assert.equal((await fetch(`${origin}/api/runs`)).status, 404);
	assert.equal((await fetch(`${origin}/api/events`)).status, 400);
	assert.equal(accesses, 0);
	const link = await mintLaunchUrl(server, {
		project: projectId(p.cwd),
		run: "workflow_example",
	});
	assert.equal(new URL(link).searchParams.get("project"), projectId(p.cwd));
	assert.equal(
		(await fetch(link, { redirect: "manual" })).headers.get("location"),
		`/?project=${projectId(p.cwd)}&run=workflow_example`,
	);
});

test("idle exit includes active runs in other projects, not just the selected project", async (t) => {
	const p = await dashboardProject(t, "aw-user-idle-");
	const other = join(p.cwd, "other");
	await mkdir(other);
	await registerProject(other);
	await persistRun(other, "blocked");
	let now = Date.now(),
		exited = false;
	const server = await p.start({
		discovery: true,
		source: {
			counts: async () => ({
				running: 0,
				needsAttention: 0,
				lastActivity: null,
			}),
		},
		now: () => now,
		idleExitMs: 1000,
		idleCheckMs: 100,
		onIdleExit: () => {
			exited = true;
		},
	});
	now += 2000;
	await sleep(350);
	assert.equal(exited, false);
	assert.ok(await readDashboardDiscovery(p.cwd));
	await persistRun(other, "completed");
	await waitFor(() => exited);
	await assert.rejects(fetch(`http://127.0.0.1:${server.port}/api/session`));
});

for (const code of ["EPERM", "EACCES"])
	test(`${code} stops binding immediately and explains sandbox alternatives`, async (t) => {
		const p = await dashboardProject(t, "aw-user-permission-");
		let attempts = 0;
		t.mock.method(Server.prototype, "listen", function () {
			attempts++;
			this.emit("error", Object.assign(new Error(code), { code }));
			return this;
		});
		await assert.rejects(p.start(), /sandboxed shell.*terminal, hook or MCP/);
		assert.equal(attempts, 1);
	});
