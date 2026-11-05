// 2026-11-05 (owner: wait in code, wake the host once; live checks internal host-wake-20261105):
// the Claude Code plugin's completion monitor runs `notify-check --follow --session <id>` for its
// session: it reports only the runs that session launched (the MCP server records the link) and keeps
// a stamp alive, and a launch from a session with a live monitor tells the agent to end its turn
// instead of calling workflow_wait. `--run` follows one run and exits once it has settled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const cli = await import("../../dist/hosts/cli/index.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const notify = await import("../../dist/hosts/notify-check.js");
const plugins = await import("../../tools/release/plugins.mjs");
const SESSION = "6f391173-db3f-4427-95fa-b09adc22b84f";
const OTHER = "0a1b2c3d-0000-4000-8000-000000000000";

let root;
let counter = 0;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-monitor-wake-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "notify-check"), {
		recursive: true,
	});
	return cwd;
}

/** A run record whose one task is running or completed. */
async function writeRun(cwd, runId, status) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			name: "deep-review",
			type: "workflow",
			status,
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date().toISOString(),
			tasks: [
				{
					taskId: "task-1",
					specId: "a.main",
					displayName: "a.main",
					status,
					statusDetail: status,
					files: {
						systemPrompt: "",
						taskPrompt: "",
						output: "",
						stderr: "",
						result: "",
					},
				},
			],
			taskSummary: {
				total: 1,
				completed: status === "completed" ? 1 : 0,
				failed: 0,
				interrupted: 0,
				pending: 0,
				running: status === "running" ? 1 : 0,
				blocked: 0,
				skipped: 0,
			},
		}),
	);
}

async function follow(cwd, runId, onTick) {
	const out = [];
	const err = [];
	let ticks = 0;
	const code = await cli.runAgentWorkflowCli(
		[
			"notify-check",
			"--follow",
			"--run",
			runId,
			"--interval",
			"1",
			"--host",
			"claude-code",
		],
		{
			cwd,
			env: process.env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY: false,
			sleep: async () => {
				ticks += 1;
				if (ticks > 20) throw new Error("did not exit");
				await onTick?.(ticks);
			},
		},
	);
	return { code, out, err: err.join(""), ticks };
}

test("notify-check --follow --run: prints the one run's line when it settles and exits by itself", async () => {
	const cwd = await project();
	await writeRun(cwd, "workflow_mine", "running");
	await writeRun(cwd, "workflow_other", "running");
	const result = await follow(cwd, "workflow_mine", async (tick) => {
		if (tick === 1) await writeRun(cwd, "workflow_other", "completed");
		if (tick === 2) await writeRun(cwd, "workflow_mine", "completed");
	});
	assert.equal(result.code, 0, result.err);
	assert.equal(result.out.length, 1);
	assert.match(result.out[0], /workflow_mine\) finished/);
	assert.doesNotMatch(result.out.join(""), /workflow_other/);
	// Already reported (here by the run above): exits at once, prints nothing.
	const again = await follow(cwd, "workflow_mine");
	assert.equal(again.code, 0);
	assert.deepEqual(again.out, []);
	assert.equal(again.ticks, 0);
	// The other run was not consumed by the filtered follower.
	const all = await cli.runAgentWorkflowCli(
		["notify-check", "--host", "claude-code"],
		{
			cwd,
			env: process.env,
			stdout: (text) => result.out.push(text),
			stderr: () => {},
			isTTY: false,
		},
	);
	assert.equal(all, 0);
	assert.match(result.out.at(-1), /workflow_other\) finished/);
	// An unknown run is a usage error.
	const missing = await cli.runAgentWorkflowCli(
		["notify-check", "--follow", "--run", "workflow_nope"],
		{ cwd, env: process.env, stdout: () => {}, stderr: () => {}, isTTY: false },
	);
	assert.equal(missing, 2);
});

test("--session: only the runs this session launched; the monitor stamp says the monitor is alive", async () => {
	const cwd = await project();
	await writeRun(cwd, "workflow_mine", "completed");
	await writeRun(cwd, "workflow_theirs", "completed");
	await notify.recordRunHostSession(cwd, "workflow_mine", SESSION);
	await notify.recordRunHostSession(cwd, "workflow_theirs", OTHER);
	assert.equal(await notify.hostSessionMonitorAlive(cwd, SESSION), false);
	const checked = await notify.notifyCheck(cwd, {
		host: "claude-code",
		session: SESSION,
	});
	assert.deepEqual(
		checked.data.notifications.map((row) => row.runId),
		["workflow_mine"],
	);
	assert.equal(await notify.hostSessionMonitorAlive(cwd, SESSION), true);
	assert.equal(await notify.hostSessionMonitorAlive(cwd, OTHER), false);
	assert.equal(
		await notify.hostSessionMonitorAlive(
			cwd,
			SESSION,
			Date.now() + notify.MONITOR_ALIVE_MS + 1_000,
		),
		false,
	);
	// The other session's run is still there for its own monitor (or the prompt hook).
	const theirs = await notify.notifyCheck(cwd, {
		host: "claude-code",
		session: OTHER,
	});
	assert.deepEqual(
		theirs.data.notifications.map((row) => row.runId),
		["workflow_theirs"],
	);
	assert.equal(
		await cli.runAgentWorkflowCli(["notify-check", "--session", "../x"], {
			cwd,
			env: process.env,
			stdout: () => {},
			stderr: () => {},
			isTTY: false,
		}),
		2,
	);
});

test("the plugin's monitor command: waits for runs, then prints this session's line (dev CLI, real shell)", async () => {
	const cwd = await project();
	const monitor = plugins.claudeCompletionMonitor(
		plugins.devCliLaunch(process.cwd()),
	);
	assert.equal(monitor.name, "run-completion");
	const start = (env) =>
		spawn("/bin/sh", ["-c", monitor.command], {
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
	// No session id (older Claude Code): exits at once.
	const none = start({ CLAUDE_CODE_SESSION_ID: "" });
	assert.equal(await new Promise((done) => none.on("exit", done)), 0);
	await writeRun(cwd, "workflow_mine", "completed");
	await writeRun(cwd, "workflow_theirs", "completed");
	await notify.recordRunHostSession(cwd, "workflow_mine", SESSION);
	await notify.recordRunHostSession(cwd, "workflow_theirs", OTHER);
	const child = start({ CLAUDE_CODE_SESSION_ID: SESSION });
	let out = "";
	const line = await new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`no line: ${out}`)), 60_000);
		child.stdout.on("data", (chunk) => {
			out += chunk;
			if (out.includes("\n")) {
				clearTimeout(timer);
				done(out);
			}
		});
	});
	child.kill();
	assert.match(
		line,
		/^agent-workflow: workflow "deep-review" \(run workflow_mine\) finished/,
	);
	assert.doesNotMatch(line, /workflow_theirs/);
});

test("a launch's next step: end the turn when this Claude Code session's monitor is alive, else workflow_wait", async () => {
	const cwd = await project();
	const api = new Proxy(
		{},
		{
			get(_, name) {
				if (name === "registerTestExecutorFromEnv")
					return async () => undefined;
				if (name === "runWorkflowAction")
					return async () => ({
						action: "run",
						ok: true,
						outcome: "running",
						text: "Workflow started: deep-review",
						data: {
							runId: "workflow_launched",
							status: "running",
							name: "deep-review",
						},
					});
				return undefined;
			},
		},
	);
	const call = {
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		signal: new AbortController().signal,
		sendRequest: async () => ({}),
		sendNotification: async () => undefined,
	};
	const text = async (host, env = {}) =>
		(
			await mcpTools
				.createHostMcpService({
					root: cwd,
					host,
					env: { ...process.env, ...env },
					api,
				})
				.call("workflow_run", { workflow: "deep-review", task: "t" }, call)
		).content
			.map((part) => part.text)
			.join("\n");
	const WAIT =
		/Then call workflow_wait \{"runId":"workflow_launched"\} and repeat while stillRunning is true\./;
	// No monitor yet: wait as before, but the launch is linked to the session.
	assert.match(
		await text("claude-code", { CLAUDE_CODE_SESSION_ID: SESSION }),
		WAIT,
	);
	await writeRun(cwd, "workflow_launched", "running");
	await notify.notifyCheck(cwd, { host: "claude-code", session: SESSION });
	const monitored = await text("claude-code", {
		CLAUDE_CODE_SESSION_ID: SESSION,
	});
	assert.match(
		monitored,
		/completion monitor \(from the plugin\) reports the run when it has finished: end your turn now and do not call workflow_wait/,
	);
	assert.doesNotMatch(monitored, /notify-check|node /);
	// Another session, or another host: wait.
	assert.match(
		await text("claude-code", { CLAUDE_CODE_SESSION_ID: OTHER }),
		WAIT,
	);
	assert.match(await text("codex", { CLAUDE_CODE_SESSION_ID: SESSION }), WAIT);
});

// 2026-11-05 (live: a Claude Code session killed with SIGKILL left its monitor running under launchd):
// the monitor stops when the process that started it is gone, in the shell wait and in the CLI.
test("the plugin's monitor command exits when the Claude Code process that started it is killed", async () => {
	const monitor = plugins.claudeCompletionMonitor(
		plugins.devCliLaunch(process.cwd()),
	);
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (const withRuns of [false, true]) {
		const cwd = await project();
		if (withRuns)
			await mkdir(join(cwd, ".agent-workflow", "workflows"), {
				recursive: true,
			});
		// A stand-in for Claude Code: starts the monitor through sh -c, prints its pid, waits.
		const parent = spawn(
			process.execPath,
			[
				"-e",
				`const { spawn } = require("node:child_process");
				const child = spawn("/bin/sh", ["-c", process.env.MONITOR_COMMAND], { stdio: "ignore" });
				process.stdout.write(String(child.pid) + "\\n");
				setInterval(() => {}, 1000);`,
			],
			{
				cwd,
				env: {
					...process.env,
					MONITOR_COMMAND: monitor.command,
					CLAUDE_CODE_SESSION_ID: SESSION,
					CLAUDE_PROJECT_DIR: cwd,
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const child = Number(
			await new Promise((done) =>
				parent.stdout.once("data", (chunk) => done(String(chunk).trim())),
			),
		);
		await new Promise((done) => setTimeout(done, 1_500));
		assert.equal(alive(child), true, "monitor running while its parent lives");
		parent.kill("SIGKILL");
		const deadline = Date.now() + 15_000;
		while (alive(child) && Date.now() < deadline)
			await new Promise((done) => setTimeout(done, 250));
		assert.equal(
			alive(child),
			false,
			`orphaned monitor still running (${withRuns ? "CLI" : "shell wait"})`,
		);
	}
});

test("notify-check --follow stops once its parent is gone", async () => {
	const cwd = await project();
	let checks = 0;
	const code = await cli.runAgentWorkflowCli(
		["notify-check", "--follow", "--host", "claude-code"],
		{
			cwd,
			env: process.env,
			stdout: () => {},
			stderr: () => {},
			isTTY: false,
			parentAlive: () => checks < 2,
			sleep: async () => {
				checks += 1;
				if (checks > 10) throw new Error("did not stop");
			},
		},
	);
	assert.equal(code, 0);
	assert.equal(checks, 2);
});
