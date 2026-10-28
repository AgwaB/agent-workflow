// New in agent-workflow (WP19 round 5, review finding 2): queue termination is durable, not tied
// to the bounded in-memory maps. Round 4 marked only the receipts still held in its 64/256-entry
// maps at `session_shutdown`: with 257 published queued deliveries the evicted one stayed
// "queue alive", another live process deferred to it (also with unreadable history, where it
// deferred unconditionally) and its tracker never retried. Now `session_shutdown` writes a
// queue-end tombstone per (session, queue lifetime); a receipt whose lifetime has one reads as
// "queue ended" (reconcile against the history, or a bounded resend without it); a delivery
// deferred to another live owner is `deferred` and the tracker retries it on later ticks.
// Based on the reviewer's probe /tmp/aw-wp19r5-additional.test.mjs ("eviction of healthy durable
// receipts"). Synthetic runs, fake Pi objects; the "other live process" is the test runner's
// parent pid, as in the round-4 tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	feedback,
	readReceipt,
	syntheticRun,
	tempProject,
	writeReceipt,
} from "../helpers/pi-delivery-fixtures.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const deliver = (pi, ctx, run) =>
	feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });

/** From now on the receipt's sender is another live Pi process on this host. */
async function asOtherLiveProcess(cwd, run, extra = {}) {
	const receipt = await readReceipt(cwd, run);
	await writeReceipt(cwd, run, {
		...receipt,
		token: "other-process-token",
		pid: process.ppid, // alive: the test runner
		processId: "another-live-pi-process",
		host: hostname(),
		...extra,
	});
	return receipt;
}

for (const readable of [true, false])
	test(`queue end (${readable ? "readable" : "unreadable"} history): 257 published queued deliveries, shutdown, another live process → all 257 resent, none suppressed`, async (t) => {
		const cwd = await tempProject(t);
		const writerCtx = fakeCtx(cwd, {
			sessionId: "A",
			...(readable ? { history: [] } : {}),
		});
		const writerPi = fakePi(); // queued only: nothing reaches the history
		const runs = [];
		for (let i = 0; i < 257; i += 1) {
			const run = await syntheticRun(cwd, "A", "command");
			assert.equal(await deliver(writerPi, writerCtx, run), "delivered");
			runs.push(run);
		}
		assert.ok(feedback.feedbackDeliveryStateSizesForTests().enqueued <= 256);
		await feedback.endFeedbackQueueLifetime(writerCtx, "new");
		for (const run of runs) {
			const before = await asOtherLiveProcess(cwd, run);
			assert.equal(before.state, "sent");
		}
		feedback.resetFeedbackDeliveryStateForTests();
		const history = [];
		const readerPi = fakePi(readable ? { history } : {});
		const readerCtx = fakeCtx(cwd, {
			sessionId: "A",
			...(readable ? { history } : {}),
		});
		const outcomes = {};
		for (const run of runs) {
			const outcome = await deliver(readerPi, readerCtx, run);
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
		}
		assert.deepEqual(
			outcomes,
			{ delivered: 257 },
			"round 4: the evicted receipt stayed 'queue alive' (1 suppressed)",
		);
		for (const run of runs)
			assert.equal(
				await deliver(readerPi, readerCtx, run),
				"already-delivered",
				readable ? "confirmed by the history" : "the two-attempt budget",
			);
		assert.equal(readerPi.messages.length, 257);
	});

/**
 * A delivery queued by another live process (its receipt names queue lifetime L, not ended, and
 * that process's in-memory entry is gone), and a reader tracker in the same session.
 */
async function deferredSetup(t, readable) {
	const cwd = await tempProject(t);
	const writerCtx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const run = await syntheticRun(cwd, "A", "command");
	assert.equal(await deliver(fakePi(), writerCtx, run), "delivered");
	const { queueLifetime } = await asOtherLiveProcess(cwd, run);
	assert.equal(typeof queueLifetime, "string");
	const history = [];
	const readerPi = fakePi(readable ? { history } : {});
	const readerCtx = fakeCtx(cwd, {
		sessionId: "A",
		...(readable ? { history } : {}),
	});
	let clock = Date.now();
	const tracker = new feedback.PiRunFeedback(readerPi, {
		pollMs: 1000,
		now: () => clock,
	});
	t.after(() => tracker.stop());
	await tracker.restore(readerCtx);
	assert.equal(readerPi.messages.length, 0, "deferred to the live owner");
	assert.equal(tracker.isPolling(), true, "a retry stays scheduled");
	assert.deepEqual(tracker.trackedRunIds(), [run.runId]);
	await tracker.tick();
	assert.equal(readerPi.messages.length, 0, "still deferred");
	return {
		cwd,
		run,
		writerCtx,
		queueLifetime,
		readerPi,
		tracker,
		advance: (ms) => {
			clock += ms;
		},
	};
}

for (const readable of [true, false]) {
	test(`deferred (${readable ? "readable" : "unreadable"} history): the owner's queue ends later (tombstone only) → a later tick resends it`, async (t) => {
		const env = await deferredSetup(t, readable);
		await feedback.endFeedbackQueueLifetime(env.writerCtx, "resume");
		const receipt = await readReceipt(env.cwd, env.run);
		assert.equal(receipt.queueEndedAt, undefined, "only the tombstone says so");
		await env.tracker.tick();
		assert.equal(env.readerPi.messages.length, 1, "recovered on a later tick");
		assert.deepEqual(env.tracker.trackedRunIds(), []);
		assert.equal(
			env.readerPi.messages[0].options.triggerTurn,
			false,
			"a catch-up delivery never starts a turn",
		);
		await env.tracker.tick();
		assert.equal(env.readerPi.messages.length, 1);
	});

	test(`deferred (${readable ? "readable" : "unreadable"} history): no queue end, the owner's window passes → a later tick resends it`, async (t) => {
		const env = await deferredSetup(t, readable);
		env.advance(11 * 60_000);
		await env.tracker.tick();
		assert.equal(env.readerPi.messages.length, 1, "recovered on a later tick");
		assert.deepEqual(env.tracker.trackedRunIds(), []);
	});
}

test("queue-end tombstones: one per ended lifetime, pruned by age; a lifetime with no deliveries writes none", async (t) => {
	const cwd = await tempProject(t);
	const dir = join(cwd, ".agent-workflow", feedback.FEEDBACK_QUEUE_ENDS_DIR);
	const list = async () =>
		(await fs.readdir(dir).catch(() => [])).filter((name) =>
			name.endsWith(".json"),
		);
	await feedback.endFeedbackQueueLifetime(
		fakeCtx(cwd, { sessionId: "idle" }),
		"quit",
	);
	assert.deepEqual(await list(), []);
	const now = Date.now();
	const first = fakeCtx(cwd, { sessionId: "A" });
	await deliver(fakePi(), first, await syntheticRun(cwd, "A", "command"));
	await feedback.endFeedbackQueueLifetime(first, "new", now);
	const [tombstone] = await list();
	const value = JSON.parse(await fs.readFile(join(dir, tombstone), "utf8"));
	assert.equal(value.sessionId, "A");
	assert.equal(`${value.queueLifetime}.json`, tombstone);
	await feedback.endFeedbackQueueLifetime(first, "reload", now);
	assert.equal((await list()).length, 1, "reload ends nothing");
	const second = fakeCtx(cwd, { sessionId: "B" });
	await deliver(fakePi(), second, await syntheticRun(cwd, "B", "command"));
	await feedback.endFeedbackQueueLifetime(second, "fork", now + 60 * 60_000);
	const after = await list();
	assert.equal(after.length, 1, "the hour-old tombstone was pruned");
	assert.notEqual(after[0], tombstone);
	assert.equal(
		feedback.feedbackQueueEndPath(cwd, "../escape"),
		undefined,
		"a receipt's lifetime never becomes an arbitrary path",
	);
});
