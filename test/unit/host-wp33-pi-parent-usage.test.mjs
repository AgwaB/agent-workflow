import { stateDir } from "../helpers/state-dir.mjs";
// The Pi host records owning-session assistant usage while a run is active and
// counts the first settled wrap-up once. Persist numbers and hashes, never message
// content; status and inspect show totals. Fixture executor only.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
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
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp33-usage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp33-usage-")));
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

async function project(stepDelayMs = 1_500) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp33-usage-${counter}`;
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

function install(env) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	instances.push({ pi });
	return {
		pi,
		tool: (name) => pi.tools.get(name),
		messageEnd: async (message, ctx) => {
			for (const handler of pi.handlers.get("message_end") ?? [])
				await handler({ type: "message_end", message }, ctx);
		},
	};
}

let stamp = 1_000;
function assistant(input, output, cost) {
	stamp += 1;
	return {
		role: "assistant",
		content: [{ type: "text", text: `Here is the key ${SECRET}` }],
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input,
			output,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: input + output + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: stamp,
	};
}

const usageFile = (cwd, runId) =>
	join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		runId,
		"parent-usage.json",
	);

test("records the owning session's assistant usage while the run is active, shown by status and inspect", async () => {
	// Long enough that the messages below are counted while the run is still active.
	const { cwd, env, executor } = await project(5_000);
	const { tool, messageEnd } = install(env);
	const ctx = fakeCtx(cwd);
	const launched = await tool("aw_run").execute(
		"r",
		{ workflow: "wf.json", task: "usage", executor },
		undefined,
		undefined,
		ctx,
	);
	const runId = launched.details.runId;
	await messageEnd(assistant(100, 20, 0.001), ctx);
	await messageEnd(assistant(200, 30, 0.002), ctx);
	// Not counted: a user message, an assistant message without usage, another session's message.
	await messageEnd({ role: "user", content: "hi", timestamp: 1 }, ctx);
	await messageEnd({ role: "assistant", content: [], timestamp: 2 }, ctx);
	await messageEnd(
		assistant(5_000, 5_000, 1),
		fakeCtx(cwd, { sessionId: "session-b" }),
	);
	const text = await readFile(usageFile(cwd, runId), "utf8");
	const record = JSON.parse(text);
	assert.equal(record.schema, "workflow-parent-usage-v1");
	assert.equal(record.source, "parent-session");
	assert.equal(record.sessionId, "session-a");
	assert.equal(record.inputTokens, 300);
	assert.equal(record.outputTokens, 50);
	assert.equal(record.cacheReadInputTokens, 20);
	assert.equal(record.totalTokens, 370);
	assert.ok(Math.abs(record.costUsd - 0.003) < 1e-9);
	assert.equal(record.assistantMessages, 2);
	assert.equal(record.completedAt, undefined);
	// Never message content (or anything secret).
	assert.doesNotMatch(text, /sk-ant|Here is the key/);

	const status = await api.statusAction({ cwd, env }, { runId });
	assert.match(
		status.text,
		/Parent session usage: 370 tokens \(in 300, out 50, cache read\/write 20\/0\), \$0\.0030, 2 assistant messages \(counting\)/,
	);
	assert.equal(status.data.run.parentUsage.totalTokens, 370);
	assert.equal(status.data.run.parentUsage.messageIds, undefined);
	assert.equal(status.data.run.parentUsage.sessionId, undefined);
	const inspect = await api.inspectAction({ cwd, env }, { runId });
	assert.match(inspect.text, /Parent session usage: 370 tokens/);
	assert.equal(inspect.data.parentUsage.assistantMessages, 2);

	// The run settles: the next message is the wrap-up (counted once), later ones are not.
	// WP39b: under load the detached supervisor can need longer than the default 30 s; and the
	// tracker now reads the settled state from the run record (the index is debounced), which
	// this status call also reads, so the next message is the wrap-up.
	await eventually(
		async () =>
			(await api.statusAction({ cwd, env }, { runId })).data.run.status ===
			"completed",
		"run completion",
		120_000,
	);
	await messageEnd(assistant(7, 3, 0), ctx);
	await messageEnd(assistant(1_000, 1_000, 0), ctx);
	const done = JSON.parse(await readFile(usageFile(cwd, runId), "utf8"));
	assert.equal(done.assistantMessages, 3);
	assert.equal(done.inputTokens, 307);
	assert.ok(done.completedAt);
	assert.doesNotMatch(
		(await api.statusAction({ cwd, env }, { runId })).text,
		/\(counting\)/,
	);
});

test("a run without host usage shows no parent-usage line; a CLI launch records nothing", async () => {
	const { cwd, env, executor } = await project(100);
	const launched = await api.runWorkflowAction(
		{ cwd, env },
		{ workflow: "wf.json", task: "cli", executor },
	);
	const { messageEnd } = install(env);
	await messageEnd(assistant(100, 20, 0.001), fakeCtx(cwd));
	await assert.rejects(readFile(usageFile(cwd, launched.data.runId)));
	const status = await api.statusAction(
		{ cwd, env },
		{ runId: launched.data.runId },
	);
	assert.doesNotMatch(status.text, /Parent session usage/);
	assert.equal(status.data.run.parentUsage, undefined);
});

test("print mode (no UI) still records the parent usage under the session id", async () => {
	const { cwd, env, executor } = await project();
	const { tool, messageEnd } = install(env);
	const ctx = fakeCtx(cwd, { hasUI: false });
	const launched = await tool("aw_run").execute(
		"r",
		{ workflow: "wf.json", task: "print usage", executor },
		undefined,
		undefined,
		ctx,
	);
	await messageEnd(assistant(11, 1, 0), ctx);
	const record = JSON.parse(
		await readFile(usageFile(cwd, launched.details.runId), "utf8"),
	);
	assert.equal(record.inputTokens, 11);
	assert.equal(record.sessionId, "session-a");
});
