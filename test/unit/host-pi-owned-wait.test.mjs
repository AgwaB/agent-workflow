// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// Completion belongs to the owning session. Its awaited tool result prevents a
// duplicate completion message; other sessions cannot take that presentation.
// Tool-result receipts are confirmed by session history; missing history after a
// restart permits redelivery. Use the workflow executor fixture.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp33-owned-wait",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp33-owned-wait-")));
	slots.setWorkerLaunchControlsForTests({
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

async function project(stepDelayMs = 300) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp33-wait-${counter}`;
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
	return { cwd, env, executor: id };
}

function install(env, history) {
	const pi = fakePi(history ? { history } : {});
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	instances.push({ pi });
	return {
		pi,
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

async function receipts(cwd, runId) {
	const dir = join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		runId,
		"pi-feedback-receipts",
	);
	const names = (await readdir(dir).catch(() => [])).filter((name) =>
		name.endsWith(".json"),
	);
	return Promise.all(
		names.map(async (name) =>
			JSON.parse(await readFile(join(dir, name), "utf8")),
		),
	);
}

async function launchByTool(tool, ctx, executor, task) {
	const launched = await tool("aw_run").execute(
		"r",
		{ workflow: "wf.json", task, executor },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(launched.details.status, "running", launched.content[0].text);
	return launched.details.runId;
}

test("aw_wait in the owning session presents the result: no completion message follows", async () => {
	const { cwd, env, executor } = await project();
	const { tool, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const runId = await launchByTool(tool, ctx, executor, "owned wait");
	assert.deepEqual(tracker.trackedRunIds(), [runId]);
	const waited = await tool("aw_wait").execute(
		"w",
		{ runId, timeoutMs: 120_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(waited.details.terminal, true, waited.content[0].text);
	assert.match(waited.details.feedbackEpoch, /^[0-9a-f]{64}$/);
	assert.equal(waited.details.completionAlreadyDelivered, undefined);
	assert.deepEqual(tracker.trackedRunIds(), [], "presented: no longer tracked");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(completionMessages(pi, runId).length, 0, "not delivered again");
	const [receipt] = await receipts(cwd, runId);
	assert.equal(receipt.state, "sent");
	assert.equal(receipt.channel, "tool-result");
	assert.equal(receipt.presentedBy, "aw_wait");
	assert.equal(receipt.epoch, waited.details.feedbackEpoch);
});

test("a /aw run launch waited by the agent is presented by aw_wait too", async () => {
	const { cwd, env, executor } = await project();
	const { tool, command, pi } = install(env);
	const ctx = fakeCtx(cwd);
	await command.handler(
		`run wf.json "command launch" --executor ${executor}`,
		ctx,
	);
	const runId = (await api.statusAction({ cwd, env })).data.runs[0].runId;
	const waited = await tool("aw_wait").execute(
		"w",
		{ runId: runId.slice(0, 18), timeoutMs: 120_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(waited.details.terminal, true, waited.content[0].text);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(completionMessages(pi, runId).length, 0);
});

test("another session cannot wait on (take) the presentation of a run it does not own", async () => {
	const { cwd, env, executor } = await project(1_000);
	const owner = install(env);
	const runId = await launchByTool(
		owner.tool,
		fakeCtx(cwd),
		executor,
		"foreign",
	);
	const other = install(env);
	await assert.rejects(
		other
			.tool("aw_wait")
			.execute(
				"w",
				{ runId },
				undefined,
				undefined,
				fakeCtx(cwd, { sessionId: "session-b" }),
			),
		/owned by another Pi session/,
	);
	// A context without a session id is not the owner either.
	await assert.rejects(
		other
			.tool("aw_wait")
			.execute(
				"w",
				{ runId },
				undefined,
				undefined,
				fakeCtx(cwd, { sessionId: null }),
			),
		/owned by another Pi session/,
	);
	// The owner still gets its completion message.
	await eventually(
		() => completionMessages(owner.pi, runId).length === 1,
		"owner delivery",
	);
	assert.equal(completionMessages(other.pi, runId).length, 0);
});

test("a run no session owns (CLI launch) can be waited on; nothing is recorded", async () => {
	const { cwd, env, executor } = await project(100);
	const launched = await api.runWorkflowAction(
		{ cwd, env },
		{ workflow: "wf.json", task: "cli launch", executor },
	);
	const { tool, pi } = install(env);
	const waited = await tool("aw_wait").execute(
		"w",
		{ runId: launched.data.runId, timeoutMs: 120_000 },
		undefined,
		undefined,
		fakeCtx(cwd),
	);
	assert.equal(waited.details.terminal, true);
	assert.equal(waited.details.feedbackEpoch, undefined);
	assert.deepEqual(await receipts(cwd, launched.data.runId), []);
	assert.equal(pi.messages.length, 0);
});

test("a wait that times out leaves delivery to the tracker (exactly one message)", async () => {
	const { cwd, env, executor } = await project(1_500);
	const { tool, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const runId = await launchByTool(tool, ctx, executor, "timeout");
	const waited = await tool("aw_wait").execute(
		"w",
		{ runId, timeoutMs: 1_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(waited.details.stillRunning, true);
	assert.equal(waited.details.feedbackEpoch, undefined);
	assert.deepEqual(tracker.trackedRunIds(), [runId]);
	await eventually(
		() => completionMessages(pi, runId).length === 1,
		"delivery",
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(completionMessages(pi, runId).length, 1);
});

test("aw_wait after the message was delivered says so and sends nothing more", async () => {
	const { cwd, env, executor } = await project(100);
	const { tool, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const runId = await launchByTool(tool, ctx, executor, "late wait");
	await eventually(
		() => completionMessages(pi, runId).length === 1,
		"delivery",
	);
	const waited = await tool("aw_wait").execute(
		"w",
		{ runId, timeoutMs: 60_000 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(waited.details.completionAlreadyDelivered, true);
	assert.match(waited.content[0].text, /already delivered to this session/);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(completionMessages(pi, runId).length, 1);
});

test("aw_run awaitTerminal on an existing (tracked) run presents it once", async () => {
	const { cwd, env, executor } = await project(400);
	const { tool, tracker, pi } = install(env);
	const ctx = fakeCtx(cwd);
	const runId = await launchByTool(tool, ctx, executor, "dup await");
	const again = await tool("aw_run").execute(
		"r2",
		{ workflow: "wf.json", task: "dup await", executor, awaitTerminal: true },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(again.details.runId, runId);
	assert.equal(
		again.details.launch.outcome ?? again.details.launch.duplicateOf,
		runId,
	);
	assert.equal(again.details.terminal, true, again.content[0].text);
	assert.match(again.details.feedbackEpoch, /^[0-9a-f]{64}$/);
	assert.deepEqual(tracker.trackedRunIds(), []);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(completionMessages(pi, runId).length, 0);
});

test("restart: a history holding the tool result confirms it; a history without it gets the message once", async () => {
	for (const persisted of [true, false]) {
		const { cwd, env, executor } = await project(100);
		const history = [];
		const first = install(env, history);
		const ctx = fakeCtx(cwd, { history });
		const runId = await launchByTool(
			first.tool,
			ctx,
			executor,
			`restart ${persisted}`,
		);
		const waited = await first
			.tool("aw_wait")
			.execute("w", { runId, timeoutMs: 60_000 }, undefined, undefined, ctx);
		assert.ok(waited.details.feedbackEpoch);
		if (persisted)
			history.push({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "aw_wait",
					details: waited.details,
				},
			});
		// Pi restarts (new process, new session runtime) and the session is resumed.
		for (const handler of first.pi.handlers.get("session_shutdown") ?? [])
			await handler({ reason: "quit" }, ctx);
		feedback.resetFeedbackDeliveryStateForTests();
		const second = install(env, history);
		const resumed = fakeCtx(cwd, { history });
		for (const handler of second.pi.handlers.get("session_start") ?? [])
			handler({ reason: "resume" }, resumed);
		await ext.unfinishedNoticeSettledForTests(second.pi);
		// 2026-11-10: wait for the catch-up delivery itself, then a quiet window for a duplicate (the fixed 200 ms
		// had to cover both).
		if (!persisted)
			await eventually(
				() => completionMessages(second.pi, runId).length >= 1,
				"the catch-up delivery",
			);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(
			completionMessages(second.pi, runId).length,
			persisted ? 0 : 1,
			persisted ? "confirmed by the tool result" : "at least once",
		);
	}
});
