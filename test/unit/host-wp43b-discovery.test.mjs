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
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
const key = "a".repeat(43);
async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp43b-discovery-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}
test("discovery is private, atomic, correctly located and requires a valid schema and live pid", async (t) => {
	const cwd = await project(t);
	const path = dashboardDiscoveryPath(cwd);
	assert.equal(path, join(cwd, ".agent-workflow/dashboard.json"));
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
	assert.deepEqual(discovery, {
		pid: process.pid,
		port: 1234,
		launchKey: key,
		startedAt: raw.startedAt,
	});
	assert.equal(
		await readDashboardDiscovery(cwd, { probe: async () => false }),
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
test("discovery probes the real unauthenticated dashboard, cleans up on close", async (t) => {
	const cwd = await project(t);
	const s = await startDashboardServer({ cwd, env: {}, discovery: true });
	t.after(() => s.close());
	const found = await readDashboardDiscovery(cwd);
	assert.equal(found.port, s.port);
	assert.equal(found.launchKey, s.launchKey);
	assert.notEqual(found.launchKey, s.token);
	assert.deepEqual(await ensureDashboard(cwd, {}, { start: false }), found);
	await s.close();
	assert.equal(await readDashboardDiscovery(cwd), undefined);
	await assert.rejects(stat(dashboardDiscoveryPath(cwd)), { code: "ENOENT" });
	assert.equal(await ensureDashboard(cwd, {}, { start: false }), undefined);
});
test("probe rejects other services, malformed errors, redirects, and a stalled response within 500ms", {
	timeout: 5000,
}, async (t) => {
	const cwd = await project(t);
	let mode = "ok";
	const server = createServer((_req, res) => {
		if (mode === "hang") return;
		res.writeHead(mode === "redirect" ? 302 : mode === "ok" ? 200 : 401, {
			"Content-Type": "application/json",
			Location: "/api/session",
		});
		res.end(
			mode === "bad" ? "{}" : '{"error":"use the printed dashboard URL"}',
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
	for (mode of ["ok", "bad", "redirect", "hang"]) {
		const start = Date.now();
		assert.equal(await readDashboardDiscovery(cwd), undefined, mode);
		assert.ok(Date.now() - start < 900, "bounded probe");
	}
	mode = "valid";
	assert.ok(await readDashboardDiscovery(cwd));
	const start = Date.now();
	assert.equal(
		await readDashboardDiscovery(cwd, { probe: () => new Promise(() => {}) }),
		undefined,
	);
	assert.ok(Date.now() - start < 900);
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
