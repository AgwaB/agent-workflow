// 2026-11-05 (owner: wait in code, wake the host once; live check host-wake-20261105): a Claude Code
// session waits for a launch through a Monitor on `notify-check --follow --run <id>`, which reads the
// run state in code, prints one line when the run has settled (the line wakes the idle session) and
// exits. The launch's next step offers that command to Claude Code hosts only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const cli = await import("../../dist/hosts/cli/index.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");

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

test("monitorCommand runs this package's CLI: one line for a settled run, then it exits", async () => {
	const cwd = await project();
	await writeRun(cwd, "workflow_done", "completed");
	const command = mcpTools.monitorCommand(cwd, "workflow_done");
	assert.match(
		command,
		/notify-check --follow --run workflow_done --host claude-code$/,
	);
	const ran = spawnSync("/bin/sh", ["-c", command], {
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(ran.status, 0, ran.stderr);
	assert.match(
		ran.stdout,
		/^agent-workflow: workflow "deep-review" \(run workflow_done\) finished/,
	);
	assert.equal(ran.stdout.trim().split("\n").length, 1);
});

test("the launch's next step offers the Monitor to Claude Code hosts only", async () => {
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
	const text = async (host) =>
		(
			await mcpTools
				.createHostMcpService({ root: cwd, host, env: process.env, api })
				.call("workflow_run", { workflow: "deep-review", task: "t" }, call)
		).content
			.map((part) => part.text)
			.join("\n");
	const claude = await text("claude-code");
	assert.match(claude, /if you have the Monitor tool/);
	assert.ok(
		claude.includes(
			mcpTools.monitorCommand(cwd, "workflow_launched").replaceAll("'", "'"),
		),
	);
	assert.match(
		claude,
		/Without the Monitor tool \(print mode, SDK\): call workflow_wait/,
	);
	const codex = await text("codex");
	assert.doesNotMatch(codex, /Monitor/);
	assert.match(
		codex,
		/Then call workflow_wait \{"runId":"workflow_launched"\} and repeat while stillRunning is true\./,
	);
});
