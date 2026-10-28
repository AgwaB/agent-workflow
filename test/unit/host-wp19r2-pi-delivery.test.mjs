// New in agent-workflow (WP19 round 2, re-review N2 and N3): Pi completion delivery.
// N2: `pi.sendMessage()` returning is not durable: while Pi streams it only queues the message in
// memory. A receipt is `sent` (enqueued by this process) until Pi's session history shows the
// message (`confirmed`). Within one process and tracker generation an epoch is never sent twice;
// after a restart (or a new tracker generation) a sent-but-unconfirmed receipt is resolved against
// the session history (not found = sent again); without readable history it is sent again, at
// most once more. The tracker confirms sent messages on later ticks.
// N3: a concurrent delivery of the same epoch while the first one publishes its receipt does not
// send a second message (in-process ownership through the final receipt transition).
// Synthetic run records and fake Pi objects only; no executor, model or agent-CLI calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");

function defer() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

/** A Pi restart as far as this module's in-memory delivery state goes. */
function restartProcess() {
	feedback.resetFeedbackDeliveryStateForTests?.();
}

let counter = 0;
async function synthetic(t, status = "completed") {
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r2-delivery-")),
	);
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	counter += 1;
	const runId = `workflow_wp19r2_${counter}`;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	const run = {
		runId,
		status,
		name: "wp19r2 delivery",
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
	await feedback.bindFeedbackAudience(cwd, runId, "A", "command");
	return { cwd, runId, run };
}

/** State of the run's only receipt (the store may normalize the record, so not by epoch). */
async function receiptState(cwd, run) {
	const dir = join(
		cwd,
		".agent-workflow",
		"workflows",
		run.runId,
		feedback.FEEDBACK_RECEIPTS_DIR,
	);
	const names = (await fs.readdir(dir)).filter((name) =>
		name.endsWith(".json"),
	);
	assert.equal(names.length, 1, names.join(", "));
	return JSON.parse(await fs.readFile(join(dir, names[0]), "utf8")).state;
}

/** A Pi whose sendMessage only queues (returns void, nothing reaches the history yet). */
function queuingPi() {
	const pi = {
		queued: 0,
		sendMessage() {
			pi.queued += 1;
		},
	};
	return pi;
}

test("N2: a queued send lost with Pi's queue is resent exactly once after a restart (empty readable history)", async (t) => {
	const { cwd, run } = await synthetic(t);
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const pi = queuingPi();
	const options = { triggerTurn: false, scope: "generation-1" };
	assert.equal(
		await feedback.deliverCompletion(pi, ctx, run, options),
		"delivered",
	);
	// Same process, same generation: queued once, never resent.
	assert.equal(
		await feedback.deliverCompletion(pi, ctx, run, options),
		"already-delivered",
	);
	assert.equal(pi.queued, 1);
	// Pi crashes before persisting its queued message; the restart sees an empty history.
	restartProcess();
	pi.queued = 0;
	const after = await feedback.deliverCompletion(pi, ctx, run, {
		triggerTurn: false,
		scope: "generation-2",
	});
	assert.equal(pi.queued, 1, `restart outcome ${after}: resends`);
	assert.equal(after, "delivered");
	// And not a third time in the new process.
	await feedback.deliverCompletion(pi, ctx, run, {
		triggerTurn: false,
		scope: "generation-2",
	});
	assert.equal(pi.queued, 1);
});

test("N2: tracker restarts resolve a sent receipt against the session history; later ticks confirm", async (t) => {
	const { cwd, run } = await synthetic(t);
	const history = [];
	const ctx = fakeCtx(cwd, { sessionId: "A", history });
	// Catch-up while Pi streams: queued, not in the history.
	const pi1 = queuingPi();
	const first = new feedback.PiRunFeedback(pi1, { pollMs: 20 });
	await first.restore(ctx);
	assert.equal(pi1.queued, 1);
	assert.equal(await receiptState(cwd, run), "sent");
	assert.equal(first.isPolling(), true, "watches for the confirmation");
	first.stop();
	// Restart: the queue was lost, the history is empty → exactly one resend.
	restartProcess();
	const pi2 = fakePi({ history });
	const second = new feedback.PiRunFeedback(pi2, { pollMs: 20 });
	await second.restore(ctx);
	assert.equal(pi2.messages.length, 1);
	// That one reached the history: a later tick confirms it and polling stops.
	await second.tick();
	assert.equal(await receiptState(cwd, run), "confirmed");
	assert.equal(second.isPolling(), false);
	second.stop();
	// Another restart: confirmed, nothing more.
	restartProcess();
	const pi3 = fakePi({ history });
	const third = new feedback.PiRunFeedback(pi3, { pollMs: 20 });
	await third.restore(ctx);
	assert.equal(pi3.messages.length, 0);
	third.stop();
});

test("N2: without readable history a sent receipt is resent after a restart, at most once more", async (t) => {
	const { cwd, run } = await synthetic(t);
	const ctx = fakeCtx(cwd, { sessionId: "A" });
	const pi = queuingPi();
	await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });
	restartProcess();
	await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });
	assert.equal(pi.queued, 2, "at least once: resent after the restart");
	restartProcess();
	await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });
	assert.equal(pi.queued, 2, "bounded: not resent on every restart");
});

test("N3: a concurrent delivery while the first publishes its receipt sends nothing", async (t) => {
	const { cwd, run } = await synthetic(t);
	// Pi queues while streaming: the readable history does not show the message yet.
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const pi = fakePi();
	const atAck = defer();
	const resumeAck = defer();
	const realRename = fs.rename;
	let paused = false;
	fs.rename = async (from, to) => {
		if (
			!paused &&
			String(to).includes(feedback.FEEDBACK_RECEIPTS_DIR) &&
			String(to).endsWith(".json")
		) {
			const value = JSON.parse(await fs.readFile(from, "utf8"));
			if (value.state === "delivered" || value.state === "sent") {
				paused = true;
				atAck.resolve();
				await resumeAck.promise;
			}
		}
		return realRename(from, to);
	};
	syncBuiltinESMExports();
	try {
		const first = feedback.deliverCompletion(pi, ctx, run, {
			triggerTurn: false,
		});
		await atAck.promise;
		const second = await feedback.deliverCompletion(pi, ctx, run, {
			triggerTurn: false,
		});
		resumeAck.resolve();
		assert.equal(await first, "delivered");
		assert.equal(pi.messages.length, 1, `second delivery: ${second}`);
		assert.notEqual(second, "delivered");
		const third = await feedback.deliverCompletion(pi, ctx, run, {
			triggerTurn: false,
		});
		assert.equal(third, "already-delivered");
		assert.equal(pi.messages.length, 1);
	} finally {
		resumeAck.resolve();
		fs.rename = realRename;
		syncBuiltinESMExports();
	}
});
