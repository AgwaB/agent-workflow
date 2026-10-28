// New in agent-workflow (WP19 round 5, review finding 1): process state left on `globalThis` by
// another version of the Pi feedback module may cause at most one duplicate, never a loss.
// Round 4 adopted round-3 state (`Symbol.for("…process-state.v1")`) on a hot `/reload` upgrade:
// its entries carry no queue lifetime and suppressed the epoch in every queue, so a completion the
// round-3 module had queued was lost after `/new` → `/resume` (zero messages in the resumed
// history). Now the state is versioned (key `…v2` + `schema`): other state is never reused for
// suppression, an entry without a concrete lifetime never counts as enqueued, and the history
// reconciles what the older module enqueued.
// Based on the reviewer's probe /tmp/aw-wp19r5-additional.test.mjs ("upgrade /reload from
// da62e79"). The fake-runtime test always runs; the real-runtime twin uses Pi 1.1's actual
// `AgentSessionRuntime`/`AgentSession` queue/`SessionManager` (no model) and runs only with
// AGENT_WORKFLOW_PI_CODING_AGENT_DIR set to the `@earendil-works/pi-coding-agent` package root.
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";

import {
	AW,
	completions,
	FakePiRuntime,
	feedback,
	loadPiRuntime,
	realPiSetup,
	receiptFile,
	STATE_KEY_V1,
	STATE_KEY_V2,
	shutdownHandler,
	syntheticRun,
	tempProject,
	writeReceipt,
} from "../helpers/pi-delivery-fixtures.mjs";

const piRuntime = await loadPiRuntime();
const REAL_SKIP = piRuntime
	? false
	: "set AGENT_WORKFLOW_PI_CODING_AGENT_DIR to Pi's @earendil-works/pi-coding-agent package root";

/**
 * What the round-3 module (da62e79) of this process did: enqueue the completion with Pi, publish
 * a `sent` receipt without a queue lifetime and keep an entry without a lifetime in its
 * process-wide state (round-3 shape: no `schema`, `watch` or `lifetimes`).
 */
async function round3Enqueue(pi, cwd, run, sessionId) {
	const epoch = feedback.feedbackEpoch(run);
	const at = new Date().toISOString();
	pi.sendMessage(
		{
			customType: AW,
			content: "round-3 completion",
			display: true,
			details: { runId: run.runId, feedbackEpoch: epoch },
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	const token = "round3-token";
	const processId = "round3-process-id";
	await writeReceipt(cwd, run, {
		schema: "agent-workflow-pi-feedback-receipt-v1",
		runId: run.runId,
		sessionId,
		epoch,
		status: run.status,
		state: "sent",
		token,
		pid: process.pid,
		processId,
		host: hostname(),
		attempts: 1,
		reservedAt: at,
		sentAt: at,
	});
	delete globalThis[STATE_KEY_V2];
	globalThis[STATE_KEY_V1] = {
		processId,
		inFlight: new Map(),
		enqueued: new Map([
			[
				receiptFile(cwd, run),
				{ token, runId: run.runId, epoch, sessionId, sentAtMs: Date.now() },
			],
		]),
		receiptQueues: new Map(),
	};
}

/** The `/reload` upgrade: Pi re-imports the extension module and keeps the runtime and queue. */
const reloadedModule = () =>
	import(`../../dist/hosts/pi/feedback.js?r5upgrade=${Math.random()}`);

function cleanup(t) {
	t.after(() => {
		delete globalThis[STATE_KEY_V1];
		feedback.resetFeedbackDeliveryStateForTests();
	});
}

test("upgrade (fake runtime): round-3 state, reload with the queue retained, /new, /resume → exactly one completion in history", async (t) => {
	const cwd = await tempProject(t);
	cleanup(t);
	const runtime = new FakePiRuntime(cwd);
	const a = runtime.session.id;
	const run = await syntheticRun(cwd, a, "tool");
	runtime.session.streaming = true;
	await round3Enqueue(runtime.pi, cwd, run, a);
	assert.equal(runtime.session.queue.length, 1, "queued while A streams");
	const reloaded = await reloadedModule();
	const tracker = new reloaded.PiRunFeedback(runtime.pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	runtime.handlers.push(shutdownHandler(tracker));
	await tracker.restore(runtime.ctx()); // reload: the queue is retained
	assert.ok(runtime.sends <= 2, "at most one duplicate from older state");
	await runtime.newSession();
	await tracker.restore(runtime.ctx());
	await runtime.switchSession(a);
	await tracker.restore(runtime.ctx());
	assert.equal(
		runtime.count(a, run.runId),
		1,
		"exactly one completion in A's history (round 4: 0, lost)",
	);
	// Never again: same runtime, another /resume, a restart.
	await tracker.restore(runtime.ctx());
	await runtime.switchSession(a);
	await tracker.restore(runtime.ctx());
	reloaded.resetFeedbackDeliveryStateForTests();
	await tracker.restore(runtime.ctx());
	assert.equal(runtime.count(a, run.runId), 1);
	tracker.stop();
});

test("upgrade (fake runtime): round-3 state, reload, queue drained → one or two messages, never zero", async (t) => {
	const cwd = await tempProject(t);
	cleanup(t);
	const runtime = new FakePiRuntime(cwd);
	const a = runtime.session.id;
	const run = await syntheticRun(cwd, a, "tool");
	runtime.session.streaming = true;
	await round3Enqueue(runtime.pi, cwd, run, a);
	const reloaded = await reloadedModule();
	const tracker = new reloaded.PiRunFeedback(runtime.pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	runtime.handlers.push(shutdownHandler(tracker));
	await tracker.restore(runtime.ctx());
	runtime.settle();
	await tracker.restore(runtime.ctx());
	await tracker.restore(runtime.ctx());
	const count = runtime.count(a, run.runId);
	assert.ok(count >= 1 && count <= 2, `${count} messages`);
	tracker.stop();
});

test("a process state with another schema under the current key is never reused for suppression", async (t) => {
	const cwd = await tempProject(t);
	cleanup(t);
	const runtime = new FakePiRuntime(cwd);
	const a = runtime.session.id;
	const run = await syntheticRun(cwd, a, "command");
	const lifetimes = new WeakMap([[runtime.session.sessionManager, "q-old"]]);
	globalThis[STATE_KEY_V2] = {
		schema: 1,
		processId: "mismatched-schema",
		inFlight: new Map(),
		enqueued: new Map([
			[
				receiptFile(cwd, run),
				{
					token: "t",
					runId: run.runId,
					epoch: feedback.feedbackEpoch(run),
					sessionId: a,
					sentAtMs: Date.now(),
					lifetime: "q-old",
				},
			],
		]),
		watch: new Map(),
		receiptQueues: new Map(),
		lifetimes,
	};
	assert.equal(
		await feedback.deliverCompletion(runtime.pi, runtime.ctx(), run, {
			triggerTurn: false,
		}),
		"delivered",
		"reconciled against the history (absent → sent)",
	);
	assert.equal(globalThis[STATE_KEY_V2].schema, 2);
	assert.equal(runtime.count(a, run.runId), 1);
});

test("upgrade (real Pi 1.1 AgentSessionRuntime): round-3 state, reload with the queue retained, newSession(), switchSession(A) → exactly one completion", {
	skip: REAL_SKIP,
}, async (t) => {
	const env = await realPiSetup(t, piRuntime);
	cleanup(t);
	await round3Enqueue(env.pi, env.cwd, env.run, env.sm.getSessionId());
	assert.equal(env.initial.agent.hasQueuedMessages(), true);
	const reloaded = await reloadedModule();
	const tracker = new reloaded.PiRunFeedback(env.pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	env.listeners.push(shutdownHandler(tracker));
	await tracker.restore(env.ctxFor()); // reload: same runtime, queue retained
	assert.ok(env.sends() <= 2, "at most one duplicate from older state");
	const originalFile = env.sm.getSessionFile();
	await env.runtime.newSession();
	await tracker.restore(env.ctxFor());
	await env.runtime.switchSession(originalFile);
	await tracker.restore(env.ctxFor());
	assert.deepEqual(env.shutdowns, ["new", "resume"]);
	assert.equal(
		completions(env.runtime.session.sessionManager.getEntries(), env.run.runId),
		1,
		"exactly one completion in the resumed history (round 4: 0, lost)",
	);
	const sends = env.sends();
	await tracker.restore(env.ctxFor());
	assert.equal(env.sends(), sends, "never again");
	tracker.stop();
});
