import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP16): the `logs` host action (`logsAction`, `agent-workflow logs`,
// `/aw logs`): a bounded tail of task output, stderr and the latest attempt's executor events, with
// shared redaction (credential assignments, bearer tokens, home paths, values of sensitive host env
// variables). Runs use the workflow executor fixture (no model or agent-CLI calls).
import assert from "node:assert/strict";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const cli = await import("../../dist/hosts/cli/index.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp16-logs",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};
const ENV_SECRET = "envsecretvalue-0123456789";
// A macOS home path, built at run time (tracked files must not contain one literally).
const HOME_PATH = ["", "Users", "someone", "private", "file.txt"].join("/");
const HOME_PREFIX = ["", "Users", "someone"].join("/");

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp16-logs-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function completedRun() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp16-logs-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		MY_SERVICE_API_TOKEN: ENV_SECRET,
	};
	const ctx = { cwd, env };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "logs task",
		executor: id,
	});
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	assert.equal(waited.data.status, "completed");
	return { cwd, env, ctx, runId: launched.data.runId };
}

async function attemptDir(cwd, runId) {
	const taskRoot = join(
		stateDir(cwd),
		".agent-workflow",
		"workflow-subagents",
		runId,
		"task-1",
	);
	const [backendRun] = (await readdir(taskRoot)).filter((name) =>
		name.startsWith("run_"),
	);
	const attempts = join(taskRoot, backendRun, "attempts");
	const [attempt] = (await readdir(attempts)).filter((name) =>
		name.startsWith("attempt_"),
	);
	return join(attempts, attempt);
}

test("logs: output, stderr and executor events of every started task, bounded per stream", async () => {
	const { ctx, runId } = await completedRun();
	const logs = await api.logsAction(ctx, { runId });
	assert.equal(logs.action, "logs");
	assert.equal(logs.outcome, "success");
	assert.equal(logs.data.runId, runId);
	assert.equal(logs.data.status, "completed");
	assert.equal(logs.data.lines, api.LOGS_DEFAULT_LINES);
	assert.deepEqual(logs.data.streams, ["output", "stderr", "events"]);
	assert.equal(logs.data.tasks.length, 1);
	const [task] = logs.data.tasks;
	assert.equal(task.taskId, "task-1");
	assert.deepEqual(
		task.streams.map((stream) => stream.kind),
		["output", "stderr", "events"],
	);
	const events = task.streams.find((stream) => stream.kind === "events");
	assert.match(events.path, /exec-events\.jsonl$/);
	assert.ok(events.lines.some((line) => line.includes('"type":"completed"')));
	assert.match(logs.text, /^Logs: wp16-logs \(completed\)\nRun: workflow_/);
	assert.match(logs.text, /== a\.main \(task-1\): completed/);
	assert.match(logs.text, /-- events: .*exec-events\.jsonl/);

	const onlyEvents = await api.logsAction(ctx, {
		runId,
		task: "a.main",
		stream: "events",
		lines: 2,
	});
	assert.deepEqual(onlyEvents.data.streams, ["events"]);
	assert.equal(onlyEvents.data.tasks[0].streams.length, 1);
	assert.equal(onlyEvents.data.tasks[0].streams[0].lines.length, 2);
	assert.equal(onlyEvents.data.tasks[0].streams[0].truncated, true);
});

test("logs: line, line-length and total bounds; secrets are redacted", async () => {
	const { ctx, runId, cwd } = await completedRun();
	const run = (await api.statusAction(ctx, { runId })).data.run;
	assert.equal(run.tasks.length, 1);
	const attempt = await attemptDir(cwd, runId);
	const lines = [];
	for (let index = 0; index < 1_000; index += 1)
		lines.push(`line ${index} ${"x".repeat(index % 3 === 0 ? 900 : 10)}`);
	lines.push(
		"api_key=sk-livesecret123456 password: hunter2hunter2",
		"Authorization: Bearer abc.def.ghi",
		`token from env ${ENV_SECRET} and ${HOME_PATH}`,
	);
	await appendFile(join(attempt, "stderr.log"), `${lines.join("\n")}\n`);

	const tail = await api.logsAction(ctx, {
		runId,
		stream: "stderr",
		lines: 5,
	});
	const stderr = tail.data.tasks[0].streams[0];
	assert.equal(stderr.kind, "stderr");
	assert.match(stderr.path, /attempts\/.*stderr\.log$/);
	assert.equal(stderr.lines.length, 5);
	assert.equal(stderr.truncated, true);
	for (const secret of [
		"sk-livesecret123456",
		"hunter2hunter2",
		"abc.def.ghi",
		ENV_SECRET,
		HOME_PREFIX,
	])
		assert.doesNotMatch(tail.text, new RegExp(secret.replace(/\./g, "\\.")));
	assert.match(tail.text, /api_key=REDACTED/);
	assert.match(tail.text, /Bearer REDACTED|Authorization: REDACTED/);
	assert.match(tail.text, /\[REDACTED:MY_SERVICE_API_TOKEN\]/);

	const long = await api.logsAction(ctx, {
		runId,
		stream: "stderr",
		lines: 400,
	});
	const kept = long.data.tasks[0].streams[0].lines;
	assert.ok(kept.length <= 400);
	for (const line of kept) assert.ok(line.length <= 400 + 40, line.length);
	assert.ok(kept.some((line) => /… \[\d+ more chars\]$/.test(line)));
	assert.equal(long.data.truncated, true, "400 long lines exceed 48 000 chars");
	assert.ok(long.text.length <= 48_000 + 200, String(long.text.length));
	assert.match(long.text, /\[output cut at 48000 characters\]$/);

	await assert.rejects(
		api.logsAction(ctx, { runId, lines: 401 }),
		/logs lines must be an integer from 1 to 400/,
	);
	await assert.rejects(
		api.logsAction(ctx, { runId, stream: "bogus" }),
		/logs stream must be one of output, stderr, events, all/,
	);
	await assert.rejects(
		api.logsAction(ctx, { runId, task: "nope" }),
		/task nope not found/,
	);
	await assert.rejects(
		api.logsAction(
			{ cwd, env: { ...ctx.env, AGENT_WORKFLOW_ROLE: "worker" } },
			{ runId },
		),
		/not allowed when AGENT_WORKFLOW_ROLE=worker/,
	);
});

test("CLI logs and /aw logs call the same handler", async () => {
	const { cwd, env, runId } = await completedRun();
	const out = [];
	const err = [];
	const io = {
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	};
	assert.equal(
		await cli.runAgentWorkflowCli(
			["logs", runId, "--stream", "events", "--lines", "3", "--json"],
			io,
		),
		0,
		err.join(""),
	);
	const json = JSON.parse(out.join(""));
	assert.equal(json.action, "logs");
	assert.equal(json.data.tasks[0].streams[0].lines.length, 3);
	out.length = 0;
	assert.equal(
		await cli.runAgentWorkflowCli(["logs", runId, "--stream", "bogus"], io),
		2,
	);
	assert.equal(await cli.runAgentWorkflowCli(["logs"], io), 2);
	out.length = 0;
	assert.equal(await cli.runAgentWorkflowCli(["help", "logs"], io), 0);
	assert.match(out.join(""), /Usage: agent-workflow logs <run-id-or-prefix>/);

	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env })(pi);
	const ctx = fakeCtx(cwd);
	await pi.commands
		.get("aw")
		.handler(`logs ${runId} --stream events --lines 3`, ctx);
	const note = ctx.notes.at(-1);
	assert.equal(note.type, "info");
	assert.match(note.message, /^Logs: wp16-logs \(completed\)/);
	assert.match(note.message, /-- events: /);
	await pi.commands.get("aw").handler("help logs", ctx);
	assert.match(ctx.notes.at(-1).message, /Usage: \/aw logs <run-id-or-prefix>/);
	await pi.commands.get("aw").handler("help", ctx);
	assert.match(ctx.notes.at(-1).message, /\/aw logs <run>/);
});
