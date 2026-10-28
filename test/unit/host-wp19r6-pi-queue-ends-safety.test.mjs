// New in agent-workflow (WP19 round 6, stage-2 re-review): the Pi queue-end tombstone directory
// is written and pruned only when it is physically `<cwd>/.agent-workflow/pi-feedback-queue-ends`
// (no symlinked ancestor), and pruning removes only positively identified tombstones and writer
// temp files — never another `.json`. Deferred catch-up deliveries share the five-message
// catch-up cap with immediate ones.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const feedback = await import("../../dist/hosts/pi/feedback.js");
const { readRunRecord } = await import("../../dist/core/store.js");
const { fakeCtx, fakePi } = await import("../helpers/pi-host-fake.mjs");

const QUEUE_END_SCHEMA = "agent-workflow-pi-feedback-queue-end-v1";
let counter = 0;

async function temp(t, prefix = "aw-wp19r6-") {
	feedback.resetFeedbackDeliveryStateForTests();
	const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
	t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}

async function runAt(cwd, sessionId = "A") {
	const runId = `workflow_r6_${process.pid}_${++counter}`;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	await fs.writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			status: "completed",
			name: "r6 test",
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
		}),
	);
	await feedback.bindFeedbackAudience(cwd, runId, sessionId, "tool");
	return readRunRecord(cwd, runId);
}

const deliver = (pi, ctx, run) =>
	feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false });

test("a symlinked queue-ends directory: shutdown deletes nothing outside", async (t) => {
	const cwd = await temp(t);
	const outside = await temp(t, "aw-wp19r6-outside-");
	const sentinel = join(outside, "valuable.json");
	await fs.writeFile(sentinel, JSON.stringify({ important: "keep me" }));
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const run = await runAt(cwd);
	await deliver(fakePi(), ctx, run);
	await fs.symlink(
		outside,
		join(cwd, ".agent-workflow", "pi-feedback-queue-ends"),
	);
	await feedback.endFeedbackQueueLifetime(ctx, "quit");
	assert.equal(
		await fs.readFile(sentinel, "utf8"),
		JSON.stringify({ important: "keep me" }),
	);
	assert.deepEqual(await fs.readdir(outside), ["valuable.json"]);
});

test("a symlinked .agent-workflow ancestor: tombstones never prune outside JSON", async (t) => {
	const cwd = await temp(t);
	const outside = await temp(t, "aw-wp19r6-outside-state-");
	await fs.symlink(outside, join(cwd, ".agent-workflow"));
	const dir = join(outside, "pi-feedback-queue-ends");
	await fs.mkdir(dir);
	const sentinel = join(dir, "unrelated.json");
	await fs.writeFile(sentinel, '{"important":true}');
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const run = await runAt(cwd);
	await deliver(fakePi(), ctx, run);
	await feedback.endFeedbackQueueLifetime(ctx, "new");
	assert.equal(await fs.readFile(sentinel, "utf8"), '{"important":true}');
});

test("pruning removes only positively identified tombstones, never other JSON", async (t) => {
	const cwd = await temp(t);
	const dir = join(cwd, ".agent-workflow", "pi-feedback-queue-ends");
	await fs.mkdir(dir, { recursive: true });
	const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	// Unrelated files a user (or another tool) put there, including an old, tombstone-named one
	// with foreign content and an unparseable one.
	await fs.writeFile(join(dir, "notes.json"), '{"endedAt":"2000-01-01"}');
	await fs.writeFile(join(dir, "foreign.json"), "not json");
	await fs.writeFile(
		join(dir, "otherlifetime.json"),
		JSON.stringify({ schema: "someone-else", endedAt: longAgo }),
	);
	// A real, expired tombstone of ours.
	await fs.writeFile(
		join(dir, "expiredlifetime.json"),
		JSON.stringify({
			schema: QUEUE_END_SCHEMA,
			queueLifetime: "expiredlifetime",
			endedAt: longAgo,
		}),
	);
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const run = await runAt(cwd);
	await deliver(fakePi(), ctx, run);
	await feedback.endFeedbackQueueLifetime(ctx, "quit");
	const names = (await fs.readdir(dir)).sort();
	assert.ok(names.includes("notes.json"), names.join(","));
	assert.ok(names.includes("foreign.json"), names.join(","));
	assert.ok(names.includes("otherlifetime.json"), names.join(","));
	assert.ok(
		!names.includes("expiredlifetime.json"),
		`expired tombstone kept: ${names.join(",")}`,
	);
	// This shutdown's own tombstone was written.
	assert.ok(
		names.some(
			(name) =>
				!["notes.json", "foreign.json", "otherlifetime.json"].includes(name),
		),
		names.join(","),
	);
});

test("deferred catch-up deliveries share the five-message catch-up cap", async (t) => {
	const cwd = await temp(t);
	const writerCtx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const writer = fakePi();
	for (let i = 0; i < 6; i += 1) {
		const run = await runAt(cwd);
		assert.equal(await deliver(writer, writerCtx, run), "delivered");
		const file = feedback.feedbackReceiptPath(
			cwd,
			run.runId,
			feedback.feedbackEpoch(run),
		);
		const receipt = JSON.parse(await fs.readFile(file, "utf8"));
		// Sent by another live Pi process into its (still alive) queue.
		await fs.writeFile(
			file,
			JSON.stringify({
				...receipt,
				pid: process.ppid,
				processId: "other-owner",
				host: hostname(),
			}),
		);
	}
	feedback.resetFeedbackDeliveryStateForTests();
	const history = [];
	const pi = fakePi({ history });
	const ctx = fakeCtx(cwd, { sessionId: "A", history });
	let clock = Date.now();
	const tracker = new feedback.PiRunFeedback(pi, { now: () => clock });
	t.after(() => tracker.stop());
	await tracker.restore(ctx);
	assert.equal(pi.messages.length, 0);
	clock += 11 * 60_000;
	await tracker.tick();
	assert.ok(
		pi.messages.length <= 5,
		`sent ${pi.messages.length} catch-up messages, limit 5`,
	);
	assert.ok(pi.messages.length >= 1);
	for (const message of pi.messages)
		assert.notEqual(message.options?.triggerTurn, true);
});
