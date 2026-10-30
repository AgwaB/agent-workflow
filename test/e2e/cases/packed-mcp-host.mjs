#!/usr/bin/env node
// New in agent-workflow (WP13): the installed `agent-workflow-mcp` bin (host MCP server) over stdio
// with a raw JSON-RPC client, the way Claude Code / Codex would start it: initialize → tools/list →
// workflow_list → workflow_run (bundled-style e2e-review workflow, E2E test executor through the
// guarded hook, detached by default) → workflow_wait loop → workflow_inspect → workflow_show (WP28:
// a CLI-command tool). No model or agent CLI.
//
//   node test/e2e/cases/packed-mcp-host.mjs <installed-package-root> <consumer-project>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [packageRootArg, consumerArg] = process.argv.slice(2);
if (!packageRootArg || !consumerArg)
	throw new Error(
		"usage: packed-mcp-host.mjs <installed-package-root> <consumer-project>",
	);
await realpath(packageRootArg);
const consumer = await realpath(resolve(consumerArg));
const fixtures = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);
const bin = join(consumer, "node_modules", ".bin", "agent-workflow-mcp");
const effectLog = join(consumer, "e2e-mcp-effects.jsonl");

// The same executor module and workflow bundle as packed-cli-run (copied when absent).
const executorModule = join(consumer, "e2e-executor.mjs");
const bundle = join(consumer, ".agent-workflow", "workflows", "e2e-review");
if (!(await exists(executorModule)))
	await cp(join(fixtures, "e2e-executor.mjs"), executorModule);
if (!(await exists(bundle))) {
	await mkdir(dirname(bundle), { recursive: true });
	await cp(join(fixtures, "e2e-review"), bundle, { recursive: true });
}

const child = spawn(bin, ["--host", "codex"], {
	cwd: consumer,
	env: {
		...process.env,
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: executorModule,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		AW_E2E_EFFECT_LOG: effectLog,
		AW_E2E_EXECUTOR_ID: "test-e2e",
		AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
	},
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
const exited = new Promise((resolveExit) =>
	child.once("exit", (code) => resolveExit(code)),
);
const lines = [];
const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const index = buffer.indexOf("\n");
		if (index === -1) break;
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		lines.push(line);
		const message = JSON.parse(line);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	}
});
let nextId = 0;
function request(method, params) {
	nextId += 1;
	const id = nextId;
	return new Promise((resolveRequest, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${method} timed out; stderr: ${stderr}`)),
			120_000,
		);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolveRequest(message);
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
	});
}
async function call(name, args) {
	const response = await request("tools/call", { name, arguments: args });
	assert.equal(response.error, undefined, JSON.stringify(response.error));
	return response.result;
}

let supervisorPid;
try {
	const init = await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "aw-e2e", version: "0.0.0" },
	});
	assert.equal(init.result.serverInfo.name, "agent-workflow");
	assert.match(init.result.instructions, /workflow_wait/);
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);
	const tools = (await request("tools/list")).result.tools.map(
		(tool) => tool.name,
	);
	assert.deepEqual(tools, [
		"workflow_list",
		"workflow_run",
		"workflow_dynamic",
		"workflow_status",
		"workflow_wait",
		"workflow_stop",
		"workflow_inspect",
		"workflow_logs",
		"workflow_validate",
		"workflow_check",
		"workflow_resume",
		"workflow_show",
		"workflow_roles",
		"workflow_agents",
		"workflow_notices",
		"workflow_doctor",
		"workflow_prune",
		"workflow_profile",
		"workflow_supervise",
		"workflow_approve",
		// WP32: auto workflow selection with consent.
		"workflow_auto",
		// WP43b: open the local dashboard (URL elicitation or terminal instructions; never a token).
		"workflow_dashboard",
	]);

	const listed = await call("workflow_list", { query: "e2e-review" });
	assert.equal(listed.isError, false);
	assert.deepEqual(
		listed.structuredContent.data.workflows.map((row) => row.name),
		["e2e-review"],
	);

	const launched = await call("workflow_run", {
		workflow: "e2e-review",
		task: "Review the e2e fixture over MCP",
		executor: "test-e2e",
	});
	assert.equal(launched.isError, false, launched.content[0].text);
	const launch = launched.structuredContent.data;
	assert.equal(launch.status, "running");
	assert.equal(launch.executor.id, "test-e2e");
	assert.equal(launch.permissionMode.mode, "free");
	assert.equal(typeof launch.detached?.pid, "number", "detached by default");
	supervisorPid = launch.detached.pid;
	assert.match(launched.content[0].text, /call workflow_wait/);

	let waited;
	let calls = 0;
	do {
		calls += 1;
		assert.ok(calls <= 20, "the run settles within 20 bounded waits");
		waited = await call("workflow_wait", { runId: launch.runId });
	} while (waited.structuredContent.data.stillRunning);
	assert.equal(
		waited.structuredContent.outcome,
		"completed",
		waited.content[0].text,
	);
	assert.equal(waited.structuredContent.data.terminal, true);
	assert.equal(waited.structuredContent.data.actionRequired, false);

	const inspected = await call("workflow_inspect", { runId: launch.runId });
	assert.equal(inspected.isError, false);
	assert.equal(inspected.structuredContent.data.run.status, "completed");
	assert.equal(inspected.structuredContent.data.run.executor, "test-e2e");
	const submits = (await readFile(effectLog, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter(
			(entry) =>
				entry.type === "submit" && entry.attemptKey.includes(launch.runId),
		);
	assert.equal(submits.length, 4, "triage, two reviewers, report");

	// WP28: the CLI commands are tools too (read-only show of the finished run).
	const shown = await call("workflow_show", { ref: launch.runId });
	assert.equal(shown.isError, false, shown.content[0].text);
	assert.equal(shown.structuredContent.data.kind, "run");
	assert.equal(shown.structuredContent.data.run.status, "completed");
	assert.equal(
		shown.structuredContent.data.run.tasks.length,
		inspected.structuredContent.data.run.tasks.length,
	);
	await waitForSupervisorDone(launch.detached.logPath, launch.runId);

	child.stdin.end();
	assert.equal(await exited, 0, stderr);
	for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
	console.log(
		`packed MCP host: ${launch.runId} completed through agent-workflow-mcp (${calls} wait call(s), ${inspected.structuredContent.data.run.tasks.length} tasks)`,
	);
} finally {
	if (child.exitCode === null) child.kill("SIGKILL");
	if (supervisorPid)
		try {
			process.kill(supervisorPid, "SIGKILL");
		} catch {}
}

async function waitForSupervisorDone(logPath, id) {
	const deadline = Date.now() + 60_000;
	for (;;) {
		let text = "";
		try {
			text = await readFile(logPath, "utf8");
		} catch {}
		if (text.includes(`done: ${id}`)) return;
		assert.ok(Date.now() < deadline, `detached supervisor for ${id}: ${text}`);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
