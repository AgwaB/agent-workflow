// New in agent-workflow (WP19 round 3, review R2 and R3): Pi completion delivery is suppressed per
// OS process, and readable session history is authoritative for every other attempt.
// R2: a `confirmed` receipt must not overrule readable history that lacks the message. Pi 1.1's
// `getEntries()` is in-memory: a message whose append to the session file failed is "seen", the
// receipt becomes `confirmed`, and after a restart the durable history lacks it. Before the fix the
// restart returned `already-delivered` (zero resends); now it resends exactly once.
// R3: an extension reload (or tracker stop/restore) in the same process keeps Pi's queue of
// pending custom messages. Before the fix the new tracker generation (or the re-imported module)
// sent the queued completion a second time; now this process never resends an epoch it enqueued.
// Based on the reviewer's probes /tmp/aw-wp19r3-{extra,followup,pi-history}.test.mjs. Synthetic run
// records and fake Pi objects; the real-`SessionManager` case uses Pi 1.1's session manager (no
// CLI, no model) when it is importable, from `@earendil-works/pi-coding-agent` or the path in
// AGENT_WORKFLOW_PI_SESSION_MANAGER (its dist/core/session-manager.js).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");

async function loadSessionManager() {
	const override = process.env.AGENT_WORKFLOW_PI_SESSION_MANAGER;
	try {
		const mod = override
			? await import(pathToFileURL(override).href)
			: await import(["@earendil-works", "pi-coding-agent"].join("/"));
		return typeof mod.SessionManager?.create === "function"
			? mod.SessionManager
			: undefined;
	} catch {
		return undefined;
	}
}
const SessionManager = await loadSessionManager();

let counter = 0;
async function synthetic(t, sessionId = "A") {
	feedback.resetFeedbackDeliveryStateForTests();
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r3-delivery-")),
	);
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	counter += 1;
	const runId = `workflow_wp19r3_${counter}`;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	const run = {
		runId,
		status: "completed",
		name: "wp19r3 delivery",
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
	await feedback.bindFeedbackAudience(cwd, runId, sessionId, "command");
	return { cwd, runId, run };
}

async function receipt(cwd, run) {
	return JSON.parse(
		await fs.readFile(
			feedback.feedbackReceiptPath(cwd, run.runId, feedback.feedbackEpoch(run)),
			"utf8",
		),
	);
}

test("R2: a confirmed receipt does not overrule readable history without the message (one resend after restart)", async (t) => {
	const { cwd, run } = await synthetic(t);
	// Pi's in-memory history shows the message; its append to the session file failed.
	const memory = [];
	const pi = fakePi({ history: memory });
	const ctx = fakeCtx(cwd, { sessionId: "A", history: memory });
	assert.equal(
		await feedback.deliverCompletion(pi, ctx, run, { triggerTurn: false }),
		"delivered",
	);
	await feedback.confirmSentDeliveries(ctx);
	assert.equal((await receipt(cwd, run)).state, "confirmed");
	// Restart: the durable history (re-read from the session file) lacks the message.
	feedback.resetFeedbackDeliveryStateForTests();
	const durable = [];
	const restartedPi = fakePi({ history: durable });
	const restarted = fakeCtx(cwd, { sessionId: "A", history: durable });
	assert.equal(
		await feedback.deliverCompletion(restartedPi, restarted, run, {
			triggerTurn: false,
		}),
		"delivered",
	);
	assert.equal(restartedPi.messages.length, 1, "exactly one resend");
	// And then it is present: no more sends, in this process or after another restart.
	await feedback.deliverCompletion(restartedPi, restarted, run, {
		triggerTurn: false,
	});
	feedback.resetFeedbackDeliveryStateForTests();
	await feedback.deliverCompletion(restartedPi, restarted, run, {
		triggerTurn: false,
	});
	assert.equal(restartedPi.messages.length, 1);
	const after = await receipt(cwd, run);
	assert.equal(after.state, "confirmed");
	assert.equal(typeof after.processId, "string", "sender identity recorded");
});

test("R2: Pi 1.1 SessionManager — failed append → confirmed → restart with intact file resends once", {
	skip: SessionManager ? false : "Pi's SessionManager is not importable",
}, async (t) => {
	const { cwd, runId, run } = await synthetic(t, "placeholder");
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const sessionFile = sm.getSessionFile();
	const sessionId = sm.getSessionId();
	// Re-bind the audience to the real session id.
	await fs.rm(
		join(
			cwd,
			".agent-workflow",
			"workflows",
			runId,
			"pi-feedback-audience.json",
		),
	);
	await feedback.bindFeedbackAudience(cwd, runId, sessionId, "command");
	const ctx = fakeCtx(cwd, { sessionId });
	ctx.sessionManager = sm;
	// Deterministic append failure; the durable session stays intact in a backup.
	await fs.rename(sessionFile, `${sessionFile}.backup`);
	await fs.mkdir(sessionFile);
	let sends = 0;
	let errors = 0;
	const piFor = (manager) => ({
		sendMessage(message) {
			sends += 1;
			(async () => {
				manager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
			})().catch(() => {
				errors += 1;
			});
		},
	});
	assert.equal(
		await feedback.deliverCompletion(piFor(sm), ctx, run, {
			triggerTurn: false,
		}),
		"delivered",
	);
	await new Promise((done) => setImmediate(done));
	assert.equal(sends, 1);
	assert.equal(errors, 1, "the append to the session file failed");
	const epoch = feedback.feedbackEpoch(run);
	assert.equal(feedback.sessionHasCompletion(ctx, runId, epoch), true);
	await feedback.confirmSentDeliveries(ctx);
	assert.equal((await receipt(cwd, run)).state, "confirmed");
	// Restart after the filesystem recovered: the durable history lacks the message.
	await fs.rmdir(sessionFile);
	await fs.rename(`${sessionFile}.backup`, sessionFile);
	const restarted = SessionManager.open(sessionFile);
	ctx.sessionManager = restarted;
	assert.equal(restarted.getSessionId(), sessionId);
	assert.equal(feedback.sessionHasCompletion(ctx, runId, epoch), false);
	feedback.resetFeedbackDeliveryStateForTests();
	const outcome = await feedback.deliverCompletion(piFor(restarted), ctx, run, {
		triggerTurn: false,
	});
	await new Promise((done) => setImmediate(done));
	assert.equal(outcome, "delivered");
	assert.equal(sends, 2, "exactly one resend");
	assert.equal(errors, 1);
	// Persisted this time: another restart finds it and sends nothing.
	ctx.sessionManager = SessionManager.open(sessionFile);
	feedback.resetFeedbackDeliveryStateForTests();
	assert.equal(
		await feedback.deliverCompletion(piFor(ctx.sessionManager), ctx, run, {
			triggerTurn: false,
		}),
		"already-delivered",
	);
	assert.equal(sends, 2);
});

test("R3: tracker stop/restore in the same process with Pi's queue surviving sends nothing extra", async (t) => {
	const { cwd } = await synthetic(t);
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const pi = fakePi(); // queues: nothing reaches the history while Pi streams
	const tracker = new feedback.PiRunFeedback(pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	await tracker.restore(ctx);
	assert.equal(pi.messages.length, 1);
	tracker.stop();
	await tracker.restore(ctx);
	assert.equal(pi.messages.length, 1, "zero extra sends after stop/restore");
	tracker.stop();
});

test("R3: an extension reload (module re-imported, Pi's queue kept) sends nothing extra", async (t) => {
	const { cwd } = await synthetic(t);
	const ctx = fakeCtx(cwd, { sessionId: "A", history: [] });
	const pi = fakePi();
	const first = new feedback.PiRunFeedback(pi, { pollMs: 1000 });
	t.after(() => first.stop());
	await first.restore(ctx);
	assert.equal(pi.messages.length, 1);
	first.stop(); // session_shutdown of the reload
	// The reload re-imports the extension module; the OS process and Pi's queue stay.
	const reloaded = await import(
		`../../dist/hosts/pi/feedback.js?reload=${Date.now()}`
	);
	assert.notEqual(reloaded.PiRunFeedback, feedback.PiRunFeedback);
	const second = new reloaded.PiRunFeedback(pi, { pollMs: 1000 });
	t.after(() => second.stop());
	await second.restore(ctx);
	assert.equal(pi.messages.length, 1, "zero extra sends after the reload");
	second.stop();
	// A real restart (new OS process) with the queue lost still resends once.
	reloaded.resetFeedbackDeliveryStateForTests();
	const third = new feedback.PiRunFeedback(pi, { pollMs: 1000 });
	t.after(() => third.stop());
	await third.restore(ctx);
	assert.equal(pi.messages.length, 2);
	third.stop();
});
