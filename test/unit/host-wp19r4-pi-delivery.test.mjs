// New in agent-workflow (WP19 round 4, review F1 residual, F3, F4): Pi completion delivery.
// F1 residual: a `sent` receipt of another *live* Pi process is not unconditional proof. With
//   readable history lacking the message it is left to its owner only while the owner's queue
//   lifetime is confirmed alive (receipt names it, not marked ended, sent within the confirmation
//   window); round 3 left it to any live owner forever.
// F3: with unreadable history, orphaned `pending` reservations (sent, but the `sent` publication
//   failed) bypassed the two-send cap: three restarts sent three times. Every reservation now
//   counts: at most 2 enqueue attempts per epoch.
// F4: confirmed and closed-session entries stayed in process memory forever. The confirmation
//   watch is now separate and bounded in time and size; a session's entries are dropped when its
//   queue lifetime ends (after their receipts were published) and the dedup map is capped, with
//   durable receipts (which name the queue lifetime) and the history as the source of truth.
// Based on the reviewer's probe /tmp/aw-wp19r4-verified.test.mjs. Synthetic runs, fake Pi objects.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");
const { readRunRecord } = await import("../../dist/core/store.js");
const STATE_KEY = Symbol.for("agent-workflow.pi-feedback.process-state.v1");
const state = () => globalThis[STATE_KEY];
const memory = () => ({
	enqueued: state()?.enqueued?.size ?? 0,
	watch: state()?.watch?.size ?? 0,
});
const DAY = 24 * 60 * 60 * 1000;

let counter = 0;
async function project(t) {
	feedback.resetFeedbackDeliveryStateForTests();
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r4-delivery-")),
	);
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	return cwd;
}
async function synthetic(cwd, sessionId = "A", launchedBy = "command") {
	counter += 1;
	const runId = `workflow_wp19r4d_${counter}`;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	const run = {
		runId,
		status: "completed",
		name: "wp19r4 delivery",
		createdAt: at,
		updatedAt: at,
		tasks: [],
		taskSummary: {
			total: 0,
			completed: 0,
			failed: 0,
			interrupted: 0,
			pending: 0,
			running: 0,
			blocked: 0,
			skipped: 0,
		},
	};
	await fs.writeFile(join(dir, "run.json"), JSON.stringify(run));
	await feedback.bindFeedbackAudience(cwd, runId, sessionId, launchedBy);
	// The record as the tracker reads it (the epoch hashes the normalized record).
	return readRunRecord(cwd, runId);
}
const receiptFile = (cwd, run) =>
	feedback.feedbackReceiptPath(cwd, run.runId, feedback.feedbackEpoch(run));
const readReceipt = async (cwd, run) =>
	JSON.parse(await fs.readFile(receiptFile(cwd, run), "utf8"));
const shutdown = (tracker, reason, ctx) =>
	typeof tracker.shutdown === "function"
		? tracker.shutdown({ type: "session_shutdown", reason }, ctx)
		: tracker.stop();

// ---------------------------------------------------------------------------------------------
// F1 residual: another live process's `sent` receipt.

async function foreignSent(cwd, run, extra) {
	await fs.mkdir(join(receiptFile(cwd, run), ".."), { recursive: true });
	await fs.writeFile(
		receiptFile(cwd, run),
		JSON.stringify({
			schema: "agent-workflow-pi-feedback-receipt-v1",
			runId: run.runId,
			sessionId: "A",
			epoch: feedback.feedbackEpoch(run),
			status: run.status,
			state: "sent",
			token: "foreign-token",
			pid: process.ppid, // alive: the test runner
			processId: "another-live-pi-process",
			host: hostname(),
			attempts: 1,
			reservedAt: new Date().toISOString(),
			sentAt: new Date().toISOString(),
			...extra,
		}),
	);
}

test("F1 residual: a live owner's `sent` receipt is reconciled when its queue lifetime is not confirmed alive", async (t) => {
	const cwd = await project(t);
	const old = new Date(Date.now() - 11 * 60_000).toISOString();
	for (const [label, extra] of [
		["no queue lifetime recorded (round-3 receipt)", {}],
		[
			"owner marked its queue ended",
			{ queueLifetime: "q1", queueEndedAt: new Date().toISOString() },
		],
		[
			"sent longer ago than the confirmation window",
			{ queueLifetime: "q1", sentAt: old },
		],
	]) {
		feedback.resetFeedbackDeliveryStateForTests();
		const run = await synthetic(cwd);
		await foreignSent(cwd, run, extra);
		const history = [];
		const pi = fakePi({ history });
		const ctx = fakeCtx(cwd, { sessionId: "A", history });
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false }),
			"delivered",
			label,
		);
		assert.equal(pi.messages.length, 1, label);
		await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });
		assert.equal(pi.messages.length, 1, `${label}: then present, not again`);
	}
});

test("F1 residual: a live owner whose queue lifetime is alive keeps it; unreadable history defers to the owner", async (t) => {
	const cwd = await project(t);
	const alive = await synthetic(cwd);
	await foreignSent(cwd, alive, { queueLifetime: "q1" });
	const pi = fakePi({ history: [] });
	assert.equal(
		await feedback.deliverCompletion(
			pi,
			fakeCtx(cwd, { sessionId: "A", history: [] }),
			alive,
			{ triggerTurn: false },
		),
		"already-delivered",
	);
	const unreadable = await synthetic(cwd);
	await foreignSent(cwd, unreadable, {});
	assert.equal(
		await feedback.deliverCompletion(
			pi,
			fakeCtx(cwd, { sessionId: "A" }),
			unreadable,
			{
				triggerTurn: false,
			},
		),
		"already-delivered",
	);
	assert.equal(pi.messages.length, 0);
});

// ---------------------------------------------------------------------------------------------
// F3: orphaned pending reservations count against the unreadable-history budget.

test("F3: three restarts with a failed `sent` publication and unreadable history send at most twice", async (t) => {
	const cwd = await project(t);
	const run = await synthetic(cwd);
	const ctx = fakeCtx(cwd, { sessionId: "A" }); // no getEntries: history unreadable
	const pi = fakePi();
	const realRename = fs.rename;
	fs.rename = async (from, to) => {
		if (
			String(to).includes(feedback.FEEDBACK_RECEIPTS_DIR) &&
			String(to).endsWith(".json")
		) {
			const next = JSON.parse(await fs.readFile(from, "utf8"));
			if (next.state === "sent")
				throw new Error("simulated crash: acknowledgement lost");
		}
		return realRename(from, to);
	};
	syncBuiltinESMExports();
	try {
		const outcomes = [];
		for (let restart = 0; restart < 3; restart += 1) {
			feedback.resetFeedbackDeliveryStateForTests();
			outcomes.push(
				await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false }),
			);
		}
		assert.ok(pi.messages.length <= 2, `${pi.messages.length} sends`);
		assert.equal(pi.messages.length, 2, "at least once, bounded");
		assert.deepEqual(outcomes, ["delivered", "delivered", "already-delivered"]);
		const after = await readReceipt(cwd, run);
		assert.equal(after.state, "pending");
		assert.equal(after.attempts, 2);
	} finally {
		fs.rename = realRename;
		syncBuiltinESMExports();
	}
});

test("F3: readable history still resends an orphaned pending reservation that never reached it", async (t) => {
	const cwd = await project(t);
	const run = await synthetic(cwd);
	const history = [];
	const pi = fakePi(); // queued only: nothing reaches the history
	const realRename = fs.rename;
	fs.rename = async (from, to) => {
		if (
			String(to).includes(feedback.FEEDBACK_RECEIPTS_DIR) &&
			String(to).endsWith(".json")
		) {
			const next = JSON.parse(await fs.readFile(from, "utf8"));
			if (next.state === "sent")
				throw new Error("simulated crash: acknowledgement lost");
		}
		return realRename(from, to);
	};
	syncBuiltinESMExports();
	try {
		for (let restart = 0; restart < 3; restart += 1) {
			feedback.resetFeedbackDeliveryStateForTests();
			await feedback.deliverCompletion(
				pi,
				fakeCtx(cwd, { sessionId: "A", history }),
				run,
				{
					triggerTurn: false,
				},
			);
		}
		assert.equal(pi.messages.length, 3, "the history decides, not the budget");
	} finally {
		fs.rename = realRename;
		syncBuiltinESMExports();
	}
});

// ---------------------------------------------------------------------------------------------
// F4: bounded process memory.

test("F4: 40 confirmed closed-session entries are reclaimed", async (t) => {
	const cwd = await project(t);
	for (let i = 0; i < 40; i += 1) {
		const sessionId = `session-${i}`;
		const history = [];
		const run = await synthetic(cwd, sessionId);
		const ctx = fakeCtx(cwd, { sessionId, history });
		const tracker = new feedback.PiRunFeedback(fakePi({ history }));
		await tracker.track(ctx, run.runId, "command");
		await shutdown(tracker, "new", ctx);
	}
	assert.deepEqual(memory(), { enqueued: 0, watch: 0 });
	assert.equal(state().inFlight.size, 0);
	assert.equal(state().receiptQueues.size, 0);
});

test("F4: 40 unconfirmable closed-session entries are reclaimed at shutdown, receipts published", async (t) => {
	const cwd = await project(t);
	const runs = [];
	for (let i = 0; i < 40; i += 1) {
		const sessionId = `session-${i}`;
		const run = await synthetic(cwd, sessionId);
		const ctx = fakeCtx(cwd, { sessionId }); // unreadable history: never confirmed
		const tracker = new feedback.PiRunFeedback(fakePi());
		await tracker.track(ctx, run.runId, "command");
		await shutdown(tracker, i % 2 ? "resume" : "quit", ctx);
		runs.push({ run, sessionId });
	}
	assert.deepEqual(memory(), { enqueued: 0, watch: 0 });
	for (const { run } of runs) {
		const receipt = await readReceipt(cwd, run);
		assert.equal(receipt.state, "sent");
		assert.equal(typeof receipt.queueEndedAt, "string");
	}
	// No duplicates after eviction: the durable receipt bounds unreadable-history resends.
	const { run, sessionId } = runs[0];
	const pi = fakePi();
	for (let i = 0; i < 3; i += 1)
		await feedback.deliverCompletion(pi, fakeCtx(cwd, { sessionId }), run, {
			triggerTurn: false,
		});
	assert.equal(
		pi.messages.length,
		1,
		"one bounded resend into the resumed session, no more",
	);
});

test("F4: the confirmation window reclaims the watch of 40 sessions; live queues still dedupe", async (t) => {
	const cwd = await project(t);
	const sessions = [];
	for (let i = 0; i < 40; i += 1) {
		const sessionId = `session-${i}`;
		const run = await synthetic(cwd, sessionId);
		const ctx = fakeCtx(cwd, { sessionId, history: [] }); // queued, never in history
		const pi = fakePi();
		const tracker = new feedback.PiRunFeedback(pi);
		await tracker.track(ctx, run.runId, "command");
		tracker.stop();
		sessions.push({ run, ctx, pi });
	}
	assert.equal(memory().watch, 40);
	await feedback.confirmSentDeliveries(
		fakeCtx(cwd, { sessionId: "unrelated", history: [] }),
		Date.now() + 30 * DAY,
	);
	assert.equal(memory().watch, 0, "watch reclaimed after the window");
	for (const { run, ctx, pi } of sessions)
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false }),
			"already-delivered",
		);
	for (const { ctx } of sessions)
		await feedback.endFeedbackQueueLifetime(ctx, "new");
	assert.deepEqual(memory(), { enqueued: 0, watch: 0 });
});

test("F4: the dedup map is capped; evicted epochs of a live queue are still not resent", async (t) => {
	const cwd = await project(t);
	const ctx = fakeCtx(cwd, { sessionId: "A" }); // one live queue, unreadable history
	const pi = fakePi();
	const runs = [];
	for (let i = 0; i < 300; i += 1) {
		const run = await synthetic(cwd, "A");
		await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });
		runs.push(run);
	}
	assert.equal(pi.messages.length, 300);
	assert.ok(memory().enqueued <= 256, `enqueued ${memory().enqueued}`);
	assert.ok(memory().watch <= 64, `watch ${memory().watch}`);
	for (const run of runs)
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false }),
			"already-delivered",
		);
	assert.equal(pi.messages.length, 300, "zero duplicates after eviction");
	await feedback.endFeedbackQueueLifetime(ctx, "quit");
});
