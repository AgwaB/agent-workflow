// Ported (WP38b) from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-launch-cancellation.test.mjs
// (MIT, same author): the `auto …` cases against WP32 `/aw auto` (host API `autoAction`) in a fake
// Pi session. The four "cancellation fences first dispatch while durable stop publication is
// delayed" cases are ported at the core level (core-workflow-launch-cancellation.test.mjs).
//
// Changed mechanisms (agent-workflow `/aw run|dynamic|auto` return once the run started, so there
// is no "Starting …" loader to press Escape on during the launch):
// - "Escape | session invalidation before publication reaches the engine dispatch boundary" → the
//   last cancellation point before the launch: Escape on the final confirmation ("Confirm selected
//   workflow launch", Pi's confirm resolves false) or the session ending while it is open
//   (`session_shutdown`; then the stale dialog answers yes). Nothing is published or dispatched.
// - "Escape after run publication uses exact-run stop semantics" → `/aw stop <run>` once the auto
//   launch returned: that run is interrupted, another run of the project continues.
// - "cancellation during directory preparation removes the unpublished root" → Escape on the
//   comparison loader (WP38b, the earliest cancellation after consent): the in-flight classifier
//   request is aborted (the executor's cancel) and nothing is prepared or started.
// - pi-workflow's named witness was a support helper writing a marker and its dynamic witness a
//   fake subagent API; here the fixture executor's effect log shows every workflow-task submit.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import {
	api,
	autoProject,
	core,
	fakeLoaders,
	piAutoSession,
	runCount,
	runIds,
	settle,
	shadowExecutors,
	store,
	submits,
} from "../helpers/pi-auto-harness.mjs";
import { eventually } from "../helpers/pi-host-fake.mjs";

const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const sessions = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp38b-auto-cancel-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.shutdown();
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

const LABEL = {
	"named-workflow": "bound-support",
	"direct-dynamic": "Dynamic workflow",
};

async function setup(selectedKind, { stepDelayMs } = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const env = await autoProject(cwd, join(root, `home${counter}`), [
		["bound-support", "Use for a bounded local support witness."],
		["other-review", "Use for an unrelated lint-style review."],
	]);
	const log = join(root, `effects-${counter}.jsonl`);
	unregister.push(
		...shadowExecutors(log, {
			recommend: LABEL[selectedKind],
			...(stepDelayMs === undefined ? {} : { stepDelayMs }),
		}),
	);
	return { cwd, env, log };
}

function session(cwd, env, options) {
	const created = piAutoSession(cwd, env, options);
	sessions.push(created);
	return created;
}

const FINAL = "Confirm selected workflow launch";

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	for (const cancellation of ["Escape", "session invalidation"]) {
		test(`auto ${selectedKind} ${cancellation} before publication reaches the engine dispatch boundary`, async () => {
			const { cwd, env, log } = await setup(selectedKind);
			const pi = session(cwd, env, {
				async confirm(title, _message, current) {
					if (title !== FINAL) return true;
					if (cancellation === "Escape") return false;
					// The session ends while the final confirmation is open; the stale dialog
					// then answers yes. The ended session's selection must start nothing.
					await current.shutdown();
					return true;
				},
			});
			await pi.command(`auto "Cancel ${selectedKind} before dispatch."`);
			assert.deepEqual(
				pi.confirms.map(({ title }) => title),
				["Send this task to pi to compare workflows?", FINAL],
			);
			const [shown] = pi.ctx.selects;
			assert.match(
				shown.options[0],
				new RegExp(`^1\\. ${LABEL[selectedKind]} · recommended`),
			);
			const calls = submits(log);
			assert.equal(calls.classifier.length, 1);
			assert.equal(calls.workflow.length, 0);
			assert.equal(await runCount(cwd), 0);
			const notes = pi.ctx.notes.map(({ message }) => message).join("\n");
			assert.match(
				notes,
				/Auto selection cancelled\. No workflow has been started\./,
			);
			assert.doesNotMatch(notes, /Selected:|Workflow started|Run: workflow_/);
		});
	}
}

test("uncancelled auto named launch still executes its first support action", async () => {
	const { cwd, env, log } = await setup("named-workflow");
	const pi = session(cwd, env);
	await pi.command('auto "Run the bounded support control."');
	assert.equal(submits(log).classifier.length, 1);
	const [runId] = await runIds(cwd);
	assert.ok(runId, JSON.stringify(pi.ctx.notes));
	await settle(cwd, env, runId);
	const run = await store.readRunRecord(cwd, runId);
	assert.equal(run.name, "bound-support");
	assert.equal(run.status, "completed");
	assert.equal(
		submits(log).workflow.length,
		1,
		"the first stage was dispatched",
	);
	assert.ok(
		pi.ctx.notes.some(({ message }) =>
			/Selected: bound-support \(recommended\)/.test(message),
		),
		JSON.stringify(pi.ctx.notes),
	);
});

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	test(`auto ${selectedKind} Escape after run publication uses exact-run stop semantics`, async () => {
		const { cwd, env, log } = await setup(selectedKind, { stepDelayMs: 1_500 });
		const pi = session(cwd, env);
		// Another run of the project that the stop must not touch.
		await pi.command('run other-review "An unrelated run."');
		const [other] = await runIds(cwd);
		assert.ok(other, JSON.stringify(pi.ctx.notes));
		await pi.command('auto "Cancel after the run is created."');
		const runId = (await runIds(cwd)).find((id) => id !== other);
		assert.ok(runId, JSON.stringify(pi.ctx.notes));
		const created = await store.readRunRecord(cwd, runId);
		assert.equal(created.launch.routingMode, "auto-confirmed");
		assert.equal(created.launch.requestKind, selectedKind);
		await pi.command(`stop ${runId}`);
		await eventually(
			async () =>
				(await store.readRunRecord(cwd, runId)).status === "interrupted",
			"the auto-launched run is interrupted",
		);
		assert.notEqual(
			(await store.readRunRecord(cwd, other)).status,
			"interrupted",
			"the stop is exact-run",
		);
		await settle(cwd, env, other);
		assert.equal((await store.readRunRecord(cwd, other)).status, "completed");
		assert.equal(submits(log).classifier.length, 1);
	});
}

test("uncancelled auto dynamic launch reaches its first controller provider action", async () => {
	const { cwd, env, log } = await setup("direct-dynamic");
	const pi = session(cwd, env);
	await pi.command('auto "Run the dynamic dispatch control."');
	const [runId] = await runIds(cwd);
	assert.ok(runId, JSON.stringify(pi.ctx.notes));
	try {
		const run = await store.readRunRecord(cwd, runId);
		assert.equal(run.launch.requestKind, "direct-dynamic");
		await eventually(
			() => submits(log).workflow.length > 0,
			"the dynamic controller's first provider action",
		);
		// The fixture's answer is no controller decision: a dispatch-positive control, not a
		// successful dynamic workflow (as in pi-workflow).
	} finally {
		await api.stopAction({ cwd, env }, { runId }).catch(() => undefined);
	}
});

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	test(`auto ${selectedKind} cancellation during directory preparation removes the unpublished root`, async () => {
		// A slow classifier keeps the comparison in flight behind the loader.
		const { cwd, env, log } = await setup(selectedKind, { stepDelayMs: 1_000 });
		const loaders = fakeLoaders();
		const pi = session(cwd, env, {
			ctx: { mode: "tui", custom: true },
			foregroundLoader: loaders.factory,
		});
		const running = pi.command(
			`auto "Cancel ${selectedKind} during the comparison."`,
		);
		await eventually(
			() =>
				loaders.created.length === 1 && submits(log).classifier.length === 1,
			"the comparison loader with the classifier request in flight",
		);
		assert.match(loaders.created[0].label, /^Comparing workflow candidates/);
		loaders.created[0].cancel();
		await running;
		await eventually(
			() => submits(log).cancels.length > 0,
			"the in-flight classifier request is cancelled",
		);
		const [cancel] = submits(log).cancels;
		assert.equal(cancel.attemptKey, submits(log).classifier[0].attemptKey);
		assert.equal(
			pi.ctx.selects.length,
			0,
			"no choice after a cancelled comparison",
		);
		assert.deepEqual(
			pi.confirms.map(({ title }) => title),
			["Send this task to pi to compare workflows?"],
		);
		assert.equal(submits(log).workflow.length, 0);
		assert.equal(await runCount(cwd), 0);
		assert.match(
			pi.ctx.notes.at(-1).message,
			/Comparison cancelled; its request was aborted .* No workflow has been started\./,
		);
	});
}
