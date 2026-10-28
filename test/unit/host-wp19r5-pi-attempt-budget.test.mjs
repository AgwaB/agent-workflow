// New in agent-workflow (WP19 round 5, review finding 3, pre-existing): a failed recovery reset the
// two-attempt budget of unreadable-history deliveries. `dropReservation()` deleted the whole
// receipt, including the earlier attempts: send, restart, recovery send throws, retry, restart,
// send gave three successful sends. Now a dropped reservation restores the receipt it replaced
// (its attempt history) and refunds only its own, provably unsent attempt.
// Based on the reviewer's probe /tmp/aw-wp19r5-additional.test.mjs ("unreadable-history send
// budget resets"). Synthetic runs, fake Pi objects.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

import {
	feedback,
	readReceipt,
	receiptFile,
	syntheticRun,
	tempProject,
} from "../helpers/pi-delivery-fixtures.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const deliver = (pi, ctx, run) =>
	feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });

test("unreadable history: send, restart, recovery throws, retry, restart, send → at most 2 successful sends", async (t) => {
	const cwd = await tempProject(t);
	const run = await syntheticRun(cwd, "A", "command");
	const ctx = fakeCtx(cwd, { sessionId: "A" }); // no getEntries: history unreadable
	const pi = fakePi();
	assert.equal(await deliver(pi, ctx, run), "delivered"); // successful send #1
	feedback.resetFeedbackDeliveryStateForTests(); // restart
	pi.sendFailures = 1;
	await assert.rejects(deliver(pi, ctx, run), /sendMessage failed/);
	const kept = await readReceipt(cwd, run);
	assert.equal(kept.state, "sent", "the earlier receipt is restored");
	assert.equal(kept.attempts, 1, "only the unsent attempt was refunded");
	assert.equal(await deliver(pi, ctx, run), "delivered"); // retry: successful send #2
	feedback.resetFeedbackDeliveryStateForTests(); // restart
	assert.equal(await deliver(pi, ctx, run), "already-delivered");
	assert.equal(
		pi.messages.length,
		2,
		"at most 2 successful sends (round 4: 3)",
	);
	assert.equal((await readReceipt(cwd, run)).attempts, 2);
});

test("a first reservation whose send throws is removed (refunded); the retry sends once", async (t) => {
	const cwd = await tempProject(t);
	const run = await syntheticRun(cwd, "A", "command");
	const ctx = fakeCtx(cwd, { sessionId: "A" });
	const pi = fakePi();
	pi.sendFailures = 1;
	await assert.rejects(deliver(pi, ctx, run), /sendMessage failed/);
	await assert.rejects(fs.readFile(receiptFile(cwd, run), "utf8"), {
		code: "ENOENT",
	});
	assert.equal(await deliver(pi, ctx, run), "delivered");
	assert.equal((await readReceipt(cwd, run)).attempts, 1);
	assert.equal(pi.messages.length, 1);
});
