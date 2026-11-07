import { agentWorkflowHome } from "../../dist/core/home-dir.js";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	dashboardDiscoveryPath,
	writeDashboardDiscovery,
	removeDashboardDiscovery,
	readDashboardDiscovery,
	detectAgentEnvironment,
	ensureDashboard,
	openInBrowser,
} from "../../dist/hosts/dashboard/discovery.js";
import { startDashboardServer } from "../helpers/dashboard-server.mjs";
const key = "a".repeat(43);
async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43b-discovery-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	return cwd;
}
test("discovery is private, atomic, correctly located and requires a valid schema and live pid", async (t) => {
	const cwd = await project(t);
	const path = dashboardDiscoveryPath(cwd);
	assert.equal(path, join(agentWorkflowHome(), "dashboard.json"));
	await writeDashboardDiscovery(cwd, {
		pid: process.pid,
		port: 1234,
		launchKey: key,
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const raw = JSON.parse(await readFile(path, "utf8"));
	assert.equal(raw.schema, "agent-workflow-dashboard-v1");
	const discovery = await readDashboardDiscovery(cwd, {
		probe: async () => true,
	});
	// WP43d: a file without `auth` (older server) means sign-in is on.
	assert.deepEqual(discovery, {
		pid: process.pid,
		port: 1234,
		launchKey: key,
		protocol: raw.protocol,
		version: raw.version,
		home: raw.home,
		url: raw.url,
		startedAt: raw.startedAt,
		auth: true,
	});
	assert.equal(
		await readDashboardDiscovery(cwd, { probe: async () => false }),
		undefined,
	);
	await writeDashboardDiscovery(cwd, {
		pid: process.pid,
		port: 1234,
		launchKey: key,
		auth: false,
	});
	assert.equal(
		(await readDashboardDiscovery(cwd, { probe: async () => true })).auth,
		false,
	);
	await writeFile(path, JSON.stringify({ ...raw, auth: "yes" }));
	assert.equal(
		await readDashboardDiscovery(cwd, { probe: async () => true }),
		undefined,
	);
	await removeDashboardDiscovery(cwd, "not-the-owner");
	assert.ok(await stat(path));
	await writeFile(path, JSON.stringify({ ...raw, schema: "unknown" }));
	assert.equal(await readDashboardDiscovery(cwd), undefined);
	await writeFile(path, JSON.stringify({ ...raw, pid: 2147483647 }));
	assert.equal(await readDashboardDiscovery(cwd), undefined);
	await assert.rejects(stat(path), { code: "ENOENT" });
	await removeDashboardDiscovery(cwd);
});
for (const auth of [false, true])
	test(`discovery probes the real dashboard without credentials (auth ${auth}), cleans up on close`, async (t) => {
		const cwd = await project(t);
		const s = await startDashboardServer({
			cwd,
			env: {},
			discovery: true,
			auth,
		});
		t.after(() => s.close());
		const found = await readDashboardDiscovery(cwd);
		assert.equal(found.port, s.port);
		assert.equal(found.launchKey, s.launchKey);
		assert.equal(found.auth, auth);
		assert.notEqual(found.launchKey, s.token);
		assert.deepEqual(await ensureDashboard(cwd, {}, { start: false }), found);
		await s.close();
		assert.equal(await readDashboardDiscovery(cwd), undefined);
		await assert.rejects(stat(dashboardDiscoveryPath(cwd)), { code: "ENOENT" });
		assert.equal(await ensureDashboard(cwd, {}, { start: false }), undefined);
	});
// 2026-11-01: the probe bound is 3 s (was 0.5 s): a healthy dashboard on a loaded machine answered
// later than 0.5 s. Wrong answers are rejected at once; only a stalled one waits for the bound.
test("probe rejects other services, malformed errors and redirects at once, and a stalled response within 3 s", {
	timeout: 20_000,
}, async (t) => {
	const cwd = await project(t);
	let mode = "ok";
	const server = createServer((req, res) => {
		if (mode === "hang") return;
		res.writeHead(
			mode === "redirect"
				? 302
				: mode === "ok" ||
						mode === "open-auth" ||
						mode === "open" ||
						mode === "valid"
					? 200
					: 401,
			{
				"Content-Type": "application/json",
				Location: "/api/session",
			},
		);
		// "open-auth": a 200 that claims auth (not an open dashboard's answer); "open": the real one.
		res.end(
			mode === "valid"
				? JSON.stringify({
						protocol: 2,
						proof: createHmac("sha256", key)
							.update(
								new URL(req.url, "http://localhost").searchParams.get("nonce"),
							)
							.digest("hex"),
					})
				: mode === "bad"
					? "{}"
					: mode === "open-auth"
						? '{"apiVersion":1,"auth":true}'
						: mode === "open"
							? '{"apiVersion":1,"auth":false}'
							: '{"error":"use the printed dashboard URL"}',
		);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	await writeDashboardDiscovery(cwd, {
		pid: process.pid,
		port: server.address().port,
		launchKey: key,
	});
	for (mode of ["ok", "open-auth", "open", "bad", "redirect", "hang"]) {
		await writeDashboardDiscovery(cwd, {
			pid: process.pid,
			port: server.address().port,
			launchKey: key,
		});
		const start = Date.now();
		assert.equal(await readDashboardDiscovery(cwd), undefined, mode);
		const elapsed = Date.now() - start;
		if (mode === "hang")
			assert.ok(
				elapsed >= 2_500 && elapsed < 4_500,
				`bounded probe: ${elapsed} ms`,
			);
		else
			assert.ok(
				elapsed < 2_000,
				`${mode} is rejected without waiting: ${elapsed} ms`,
			);
	}
	mode = "valid";
	await writeDashboardDiscovery(cwd, {
		pid: process.pid,
		port: server.address().port,
		launchKey: key,
	});
	assert.ok(await readDashboardDiscovery(cwd), mode);
	const start = Date.now();
	assert.equal(
		await readDashboardDiscovery(cwd, { probe: () => new Promise(() => {}) }),
		undefined,
	);
	assert.ok(
		Date.now() - start < 4_500,
		"a probe that never settles is bounded",
	);
});
test("agent detection matrix: set markers (even empty), host contexts, ordinary terminals", () => {
	for (const marker of [
		"CLAUDECODE",
		"CODEX_SANDBOX",
		"CODEX_THREAD_ID",
		"CURSOR_AGENT",
		"AI_AGENT",
	]) {
		for (const value of ["1", "", "0"]) {
			const detected = detectAgentEnvironment({ [marker]: value });
			assert.equal(detected.detected, true);
			assert.equal(detected.reason, marker);
		}
	}
	for (const host of ["pi", "codex", "claude-code"])
		assert.equal(detectAgentEnvironment({}, host).detected, true);
	for (const host of [undefined, "cli", "other"])
		assert.deepEqual(detectAgentEnvironment({}, host), { detected: false });
});
test("browser opener failures are nonthrowing", async () => {
	// No executable search path: do not launch an actual browser.
	if (process.platform !== "win32")
		assert.equal(
			await openInBrowser("http://127.0.0.1:1/", { PATH: "/nonexistent" }),
			false,
		);
});
