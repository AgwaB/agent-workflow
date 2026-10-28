// New in agent-workflow (WP28, owner decision Q9): Pi long waits. `aw_run`/`aw_dynamic` accept
// `awaitTerminal` + `timeoutMs` and `aw_wait` / `/aw wait <run> [timeout]` wait until the run is
// terminal (or needs action) or the timeout passes, with pi-workflow's bounds (tools: default
// 30 min, max 4 h; the command: default 60 s). Cancelling cancels only the wait. An awaited result is
// not delivered again; a wait that ends first leaves the run tracked for delivery. MCP keeps its
// 45 s cap (host API default). Runs use the workflow executor fixture (no model or agent-CLI calls).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp28-pi-waits",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp28-pi-waits-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const { pi } of instances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project(stepDelayMs = 200) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp28-wait-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				stepDelayMs,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, executor: id, ctx: { cwd, env } };
}

/** The extension over a recording wrapper of the real host API (stubs replace single actions). */
function install(env, stubs = {}) {
	const calls = [];
	const wrapped = {};
	for (const [name, value] of Object.entries(api)) {
		if (typeof value !== "function") continue;
		wrapped[name] = (...args) => {
			if (/Action$/.test(name)) calls.push({ name, request: args[1] });
			return (stubs[name] ?? value)(...args);
		};
	}
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({
		api: wrapped,
		env,
		feedbackPollMs: 50,
	})(pi);
	instances.push({ pi });
	return {
		pi,
		calls,
		tracker: ext.piRunFeedbackForTests(pi),
		tool: (name) => pi.tools.get(name),
		command: pi.commands.get("aw"),
	};
}

const completionMessages = (pi, runId) =>
	pi.messages.filter(
		(entry) =>
			entry.message.customType === "agent-workflow-completion" &&
			entry.message.details?.runId === runId,
	);

test("host API: long waits default to 30 min and cap at 4 h; the 45 s bound stays the default", async () => {
	assert.equal(api.HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS, 1_800_000);
	assert.equal(api.HOST_LONG_WAIT_MAX_TIMEOUT_MS, 14_400_000);
	assert.equal(api.boundedWaitTimeout(undefined, true), 1_800_000);
	assert.equal(api.boundedWaitTimeout(90_000, true), 90_000);
	assert.equal(api.boundedWaitTimeout(20_000_000, true), 14_400_000);
	assert.equal(api.boundedWaitTimeout(10, true), 1_000);
	// MCP/CLI: unchanged.
	assert.equal(api.boundedWaitTimeout(undefined), 45_000);
	assert.equal(api.boundedWaitTimeout(90_000), 45_000);

	const { ctx, executor } = await project(150);
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "host api long wait",
		executor,
	});
	const waited = await api.waitAction(ctx, {
		runId: launched.data.runId,
		longWait: true,
		timeoutMs: 90_000,
	});
	assert.equal(waited.data.terminal, true, waited.text);
	assert.equal(waited.data.timeoutMs, 90_000);
});

test("aw_run awaitTerminal: one call returns the terminal result; it is not delivered again", async () => {
	const { cwd, env, executor } = await project(150);
	const { tool, calls, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const updates = [];
	const result = await tool("aw_run").execute(
		"r",
		{ workflow: "wf.json", task: "await it", executor, awaitTerminal: true },
		new AbortController().signal,
		(update) => updates.push(update),
		ctx,
	);
	assert.equal(result.details.terminal, true, result.content[0].text);
	assert.equal(result.details.outcome, "completed");
	assert.equal(result.details.stillRunning, false);
	assert.equal(result.details.timeoutMs, 1_800_000, "30 min default");
	const runId = result.details.runId;
	assert.equal(result.details.launch.runId, runId);
	assert.equal(result.details.launch.status, "running");
	const wait = calls.find((call) => call.name === "waitAction");
	assert.equal(wait.request.longWait, true);
	assert.equal(wait.request.timeoutMs, undefined);
	assert.ok(updates.length > 0, "progress through onUpdate");
	// The text is the wait result (the same as a later aw_wait).
	const direct = await api.waitAction(
		{ cwd, env, host: "pi" },
		{ runId, timeoutMs: 1_000 },
	);
	assert.equal(result.content[0].text, direct.text);
	// The tool result was the delivery: no tracking, no follow-up message.
	assert.deepEqual(tracker.trackedRunIds(), []);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(completionMessages(pi, runId).length, 0);
});

test("aw_run awaitTerminal with a short timeout returns stillRunning and tracks the run for delivery", async () => {
	const { cwd, env, executor } = await project(1_500);
	const { tool, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const result = await tool("aw_run").execute(
		"r",
		{
			workflow: "wf.json",
			task: "await briefly",
			executor,
			awaitTerminal: true,
			timeoutMs: 1_000,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.details.stillRunning, true, result.content[0].text);
	assert.equal(result.details.timeoutMs, 1_000);
	const runId = result.details.runId;
	assert.deepEqual(tracker.trackedRunIds(), [runId]);
	await eventually(
		() => completionMessages(pi, runId).length === 1,
		"completion delivery after the wait ended first",
	);
});

test("cancelling aw_wait or an awaited launch cancels only the wait", async () => {
	const { cwd, env, executor, ctx: apiCtx } = await project(1_000);
	const { tool, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	await assert.rejects(
		tool("aw_run").execute(
			"r",
			{
				workflow: "wf.json",
				task: "cancel wait",
				executor,
				awaitTerminal: true,
			},
			controller.signal,
			undefined,
			ctx,
		),
	);
	const runId = (await api.statusAction(apiCtx)).data.runs[0].runId;
	assert.deepEqual(tracker.trackedRunIds(), [runId], "tracked after a cancel");
	assert.equal(
		(await api.statusAction(apiCtx, { runId })).data.run.status,
		"running",
	);

	const second = new AbortController();
	setTimeout(() => second.abort(), 200);
	await assert.rejects(
		tool("aw_wait").execute("w", { runId }, second.signal, undefined, ctx),
	);
	assert.equal(
		(await api.statusAction(apiCtx, { runId })).data.run.status,
		"running",
	);

	const done = await tool("aw_wait").execute(
		"w2",
		{ runId, timeoutMs: 120_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(done.details.terminal, true, done.content[0].text);
	assert.equal(done.details.outcome, "completed");
	await eventually(
		() => completionMessages(pi, runId).length === 1,
		"the cancelled awaited launch still reports back",
	);
});

test("aw_dynamic awaitTerminal waits for the launched run; parameter rules follow pi-workflow", async () => {
	const { cwd, env, executor, ctx: apiCtx } = await project(100);
	const finished = await api.runWorkflowAction(apiCtx, {
		workflow: "wf.json",
		task: "finished before",
		executor,
	});
	await api.waitAction(apiCtx, {
		runId: finished.data.runId,
		longWait: true,
		timeoutMs: 60_000,
	});
	const { tool, calls } = install(env, {
		runDynamicAction: async () => ({
			action: "dynamic",
			ok: true,
			outcome: "running",
			data: {
				mode: "direct-dynamic",
				runId: finished.data.runId,
				status: "running",
			},
			text: "Dynamic workflow started",
		}),
	});
	const ctx = fakeCtx(cwd);
	const dynamic = tool("aw_dynamic");
	assert.ok(dynamic.parameters.properties.awaitTerminal);
	assert.equal(dynamic.parameters.properties.timeoutMs.maximum, 14_400_000);
	const result = await dynamic.execute(
		"d",
		{ task: "dynamic await", awaitTerminal: true, timeoutMs: 5_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.details.terminal, true);
	assert.equal(result.details.launch.mode, "direct-dynamic");
	const wait = calls.filter((call) => call.name === "waitAction").at(-1);
	assert.deepEqual(
		{ ...wait.request, signal: undefined },
		{
			runId: finished.data.runId,
			longWait: true,
			timeoutMs: 5_000,
			signal: undefined,
		},
	);

	for (const [name, params, pattern] of [
		[
			"aw_dynamic",
			{ task: "t", awaitTerminal: true, detach: true },
			/mutually exclusive/,
		],
		[
			"aw_run",
			{ workflow: "wf.json", task: "t", timeoutMs: 5_000 },
			/requires awaitTerminal=true/,
		],
		[
			"aw_run",
			{ workflow: "wf.json", task: "t", awaitTerminal: "yes" },
			/awaitTerminal must be a boolean/,
		],
		[
			"aw_run",
			{
				workflow: "wf.json",
				task: "t",
				awaitTerminal: true,
				timeoutMs: 20_000_000,
			},
			/timeoutMs must be an integer from 1000 to 14400000/,
		],
		[
			"aw_wait",
			{ runId: "workflow_x", timeoutMs: 500 },
			/timeoutMs must be an integer/,
		],
	])
		await assert.rejects(
			tool(name).execute("bad", params, undefined, undefined, ctx),
			pattern,
		);
});

test("/aw wait <run> [timeout]: until terminal or the timeout; default 60 s, max 4 h", async () => {
	const { cwd, env, executor, ctx: apiCtx } = await project(150);
	const { command, calls } = install(env);
	const ctx = fakeCtx(cwd);
	const launched = await api.runWorkflowAction(apiCtx, {
		workflow: "wf.json",
		task: "command wait",
		executor,
	});
	const runId = launched.data.runId;
	await command.handler(`wait ${runId} 2m`, ctx);
	await command.handler(`wait ${runId}`, ctx);
	await command.handler(`wait ${runId} --timeout 90s`, ctx);
	await command.handler(`wait ${runId} 30000`, ctx);
	const waits = calls
		.filter((call) => call.name === "waitAction")
		.map((call) => call.request);
	assert.deepEqual(waits, [
		{ runId, longWait: true, timeoutMs: 120_000 },
		{ runId, longWait: true, timeoutMs: 60_000 },
		{ runId, longWait: true, timeoutMs: 90_000 },
		{ runId, longWait: true, timeoutMs: 30_000 },
	]);
	assert.equal(
		(await api.statusAction(apiCtx, { runId })).data.run.status,
		"completed",
	);
	const before = ctx.notes.length;
	await command.handler(`wait ${runId} 5h`, ctx);
	await command.handler(`wait ${runId} 1m --timeout 2m`, ctx);
	const errors = ctx.notes.slice(before);
	assert.equal(errors.length, 2);
	assert.equal(errors[0].type, "error");
	assert.match(errors[0].message, /at most 14400000ms/);
	assert.match(errors[1].message, /one timeout, not both/);
});
