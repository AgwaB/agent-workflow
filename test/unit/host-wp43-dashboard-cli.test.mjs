import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import { COMMAND_HELP, GENERAL_HELP } from "../../dist/hosts/help.js";
import { startDashboardServer } from "../helpers/dashboard-server.mjs";

async function invoke(args, extra = {}) {
	const stdout = [],
		stderr = [];
	const code = await runAgentWorkflowCli(args, {
		cwd: process.cwd(),
		env: {},
		isTTY: false,
		stdout: (s) => stdout.push(s),
		stderr: (s) => stderr.push(s),
		...extra,
	});
	return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("dashboard CLI rejects invalid ports and unknown flags with usage exit 2", async () => {
	for (const args of [
		["--port", "abc"],
		["--port", "70000"],
		["--port", "0"],
		["--port", "-1"],
		["--port", "1.5"],
		["--port"],
		["--once"],
		["unexpected"],
		["--readonly", "--readonly"],
	]) {
		const result = await invoke(["dashboard", ...args]);
		assert.equal(result.code, 2, args.join(" "));
		assert.notEqual(result.stderr, "");
		assert.equal(result.stdout, "");
	}
});

test("dashboard project must be a directory, and occupied ports exit 2", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "aw-dashboard-cli-"));
	t.after(() =>
		rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	await writeFile(join(root, "file"), "not a directory");
	for (const name of ["file", "missing"])
		assert.equal(
			(await invoke(["dashboard", "--project", join(root, name)])).code,
			2,
		);
	const s = await startDashboardServer({ cwd: root, env: {} });
	t.after(() => s.close());
	assert.equal((await invoke(["dashboard", "--port", String(s.port)])).code, 2);
});

test("dashboard prints one URL, supports project/read-only, and honors io.signal with an explicit opener on pipes", {
	timeout: 5000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "aw-dashboard-cli-"));
	t.after(() =>
		rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const controller = new AbortController();
	const lines = [];
	let ready;
	const started = new Promise((resolve) => {
		ready = resolve;
	});
	const command = invoke(
		["dashboard", "--readonly", "--auth", "--open", "--project", root],
		{
			signal: controller.signal,
			open: async () => true,
			stdout: (line) => {
				lines.push(line);
				ready();
			},
		},
	);
	t.after(() => controller.abort());
	await started;
	assert.equal(lines.length, 1);
	assert.match(
		lines[0],
		/^Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+&project=[\w-]+ \(read-only\)\n$/,
	);
	const url = new URL(lines[0].split(" ")[1]);
	const response = await fetch(new URL("/api/session", url), {
		headers: { Cookie: `aw_session=${url.searchParams.get("token")}` },
	});
	const session = await response.json();
	assert.equal(session.apiVersion, 2);
	assert.ok(url.searchParams.get("project"));
	assert.equal(session.mode, "read-only");
	assert.equal(session.auth, true);
	controller.abort();
	assert.equal((await command).code, 0);
});

test("dashboard (default, WP43d) prints a plain URL that opens without sign-in", {
	timeout: 5000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "aw-dashboard-cli-open-"));
	t.after(() =>
		rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const controller = new AbortController();
	const lines = [];
	let ready;
	const started = new Promise((resolve) => {
		ready = resolve;
	});
	const command = invoke(["dashboard", "--project", root], {
		signal: controller.signal,
		stdout: (line) => {
			lines.push(line);
			ready();
		},
	});
	t.after(() => controller.abort());
	await started;
	assert.equal(lines.length, 1);
	assert.match(
		lines[0],
		/^Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?project=[\w-]+\n$/,
	);
	const url = new URL(lines[0].split(" ")[1]);
	const page = await fetch(url);
	assert.equal(page.status, 200);
	assert.equal(page.headers.get("set-cookie"), null);
	const session = await (await fetch(new URL("/api/session", url))).json();
	assert.equal(session.auth, false);
	assert.equal(session.mode, "read-write");
	controller.abort();
	assert.equal((await command).code, 0);
});

test("dashboard is listed in general and command help", async () => {
	assert.match(GENERAL_HELP, /dashboard/);
	assert.match(COMMAND_HELP.dashboard, /--port/);
	assert.equal((await invoke(["dashboard", "--help"])).code, 0);
});

test("real CLI closes cleanly on SIGTERM and exits 0", {
	timeout: 8000,
}, async (t) => {
	const bin = fileURLToPath(
		new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
	);
	const child = spawn(process.execPath, [bin, "dashboard", "--readonly"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: "" },
	});
	t.after(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", (data) => {
			assert.match(data.toString(), /^Dashboard:/);
			resolve();
		});
	});
	child.kill("SIGTERM");
	assert.deepEqual(await closed, { code: 0, signal: null });
});

test("dashboard CLI names the user directory when it cannot write it (sandboxed shell)", async () => {
	// A missing home below a read-only parent: the owner-permission repair of an existing home
	// cannot help, as in a sandboxed shell that may not write the user directory at all.
	const root = await mkdtemp(join(tmpdir(), "aw-dashboard-eacces-"));
	const locked = join(root, "locked");
	const home = join(locked, "home");
	const previous = process.env.AGENT_WORKFLOW_HOME;
	try {
		await mkdir(locked);
		await chmod(locked, 0o500);
		process.env.AGENT_WORKFLOW_HOME = home;
		const result = await invoke(["dashboard", "--detached"], {
			env: { AGENT_WORKFLOW_HOME: home },
		});
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.stderr, /E(ACCES|PERM)/);
		assert.ok(
			result.stderr.includes(`keeps runs and the dashboard in ${home}`),
			result.stderr,
		);
		assert.match(result.stderr, /sandboxed shell/);
	} finally {
		if (previous === undefined) delete process.env.AGENT_WORKFLOW_HOME;
		else process.env.AGENT_WORKFLOW_HOME = previous;
		await chmod(locked, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});
