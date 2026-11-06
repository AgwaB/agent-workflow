import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP19 round 4, review F1): completion suppression follows Pi's queue
// lifetime, not the OS process lifetime. Round 3 suppressed an epoch for the whole process once it
// was enqueued, so an ordinary `/new` → `/resume` (Pi 1.1's `AgentSessionRuntime.teardownCurrent`
// aborts and disposes the session runtime; its follow-up queue is never drained) lost a
// tool-launched completion: zero messages in the resumed session's history until a restart. Now:
// `reload` keeps the suppression (Pi keeps the `AgentSession` and its queue); `new`/`resume`/`fork`
// /`quit` and any runtime with another `sessionManager` object reconcile against the history.
// Based on the reviewer's probes /tmp/aw-wp19r4-session-replace.test.mjs and
// /tmp/aw-wp19r4-verified.test.mjs (cleared queue).
//
// The fake-runtime tests always run. The real-runtime twins use Pi 1.1's actual
// `AgentSessionRuntime` (`newSession()`, `switchSession()`), `AgentSession` queue methods and
// `SessionManager`, never a model (the agent's stream function throws), and run only when
// AGENT_WORKFLOW_PI_CODING_AGENT_DIR names the `@earendil-works/pi-coding-agent` package root
// (they import its internal dist/core modules). Active-turn settlement is simulated.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { fakeCtx } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");
const AW = feedback.AW_COMPLETION_MESSAGE_TYPE;

async function loadPiRuntime() {
	const root = process.env.AGENT_WORKFLOW_PI_CODING_AGENT_DIR;
	if (!root) return undefined;
	const load = (file) =>
		import(pathToFileURL(join(root, "dist", "core", file)).href);
	const { SessionManager } = await load("session-manager.js");
	const { AgentSession } = await load("agent-session.js");
	const { AgentSessionRuntime } = await load("agent-session-runtime.js");
	let agentModule;
	try {
		agentModule = await import(
			pathToFileURL(
				join(
					root,
					"node_modules",
					"@earendil-works",
					"pi-agent-core",
					"dist",
					"agent.js",
				),
			).href
		);
	} catch {
		const require = createRequire(join(root, "package.json"));
		agentModule = await import(
			pathToFileURL(require.resolve("@earendil-works/pi-agent-core")).href
		);
	}
	return {
		SessionManager,
		AgentSession,
		AgentSessionRuntime,
		Agent: agentModule.Agent,
	};
}
const piRuntime = await loadPiRuntime();
const REAL_SKIP = piRuntime
	? false
	: "set AGENT_WORKFLOW_PI_CODING_AGENT_DIR to Pi's @earendil-works/pi-coding-agent package root";

let counter = 0;
async function tempProject(t) {
	feedback.resetFeedbackDeliveryStateForTests();
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r4-lifetime-")),
	);
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	return cwd;
}

async function syntheticRun(cwd, sessionId, launchedBy = "tool") {
	counter += 1;
	const runId = `workflow_wp19r4_${counter}`;
	const dir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	const run = {
		runId,
		status: "completed",
		name: "wp19r4 lifetime",
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
	return run;
}

const completions = (entries, runId) =>
	entries.filter(
		(entry) =>
			entry?.type === "custom_message" &&
			entry.customType === AW &&
			entry.details?.runId === runId,
	).length;

/** WP19 round 4: `session_shutdown` as the extension handles it (round 3 only stopped). */
function shutdownHandler(tracker) {
	return (event, ctx) =>
		typeof tracker.shutdown === "function"
			? tracker.shutdown(event, ctx)
			: tracker.stop();
}

/**
 * A fake Pi session runtime with Pi 1.1's queue semantics: while the agent streams, a
 * `triggerTurn` message is queued in the session runtime; `/reload` keeps the runtime and its
 * queue; `/new`, `/resume` (and `/fork`) emit `session_shutdown`, then dispose the runtime (its
 * queue is dropped) and open a fresh one with a new `sessionManager` object. The history of a
 * session id is durable across runtimes.
 */
class FakePiRuntime {
	constructor(cwd, { shutdownEvents = true } = {}) {
		this.cwd = cwd;
		this.store = new Map();
		this.handlers = [];
		this.shutdownEvents = shutdownEvents;
		this.sends = 0;
		this.session = this.open(`session-${randomBytes(4).toString("hex")}`);
		const runtime = this;
		this.pi = {
			sendMessage(message, options) {
				runtime.sends += 1;
				const entry = {
					type: "custom_message",
					customType: message.customType,
					details: message.details,
				};
				const session = runtime.session;
				if (session.streaming && options?.triggerTurn)
					session.queue.push(entry);
				else runtime.append(session, entry);
			},
		};
	}
	open(id) {
		const durable = this.store.get(id) ?? [];
		this.store.set(id, durable);
		const history = [...durable];
		return {
			id,
			durable,
			history,
			queue: [],
			streaming: false,
			sessionManager: {
				getSessionId: () => id,
				getEntries: () => [...history],
			},
		};
	}
	append(session, entry) {
		session.history.push(entry);
		session.durable.push(entry);
	}
	ctx() {
		const ctx = fakeCtx(this.cwd, { sessionId: this.session.id });
		ctx.sessionManager = this.session.sessionManager;
		return ctx;
	}
	async shutdown(reason) {
		const event = { type: "session_shutdown", reason };
		for (const handler of this.handlers)
			await handler(this.shutdownEvents ? event : {}, this.ctx());
	}
	async replace(reason, id) {
		await this.shutdown(reason);
		this.session.streaming = false; // abort; the follow-up queue is never drained
		this.session = this.open(id);
	}
	newSession() {
		return this.replace("new", `session-${randomBytes(4).toString("hex")}`);
	}
	switchSession(id) {
		return this.replace("resume", id);
	}
	reload() {
		return this.shutdown("reload"); // same runtime, same queue
	}
	settle() {
		const session = this.session;
		session.streaming = false;
		for (const entry of session.queue.splice(0)) this.append(session, entry);
	}
	count(id, runId) {
		return completions(this.store.get(id) ?? [], runId);
	}
}

for (const shutdownEvents of [true, false])
	test(`F1 (fake runtime${shutdownEvents ? "" : ", no shutdown reason"}): queued in A, /new, /resume A → exactly one message in A`, async (t) => {
		const cwd = await tempProject(t);
		const runtime = new FakePiRuntime(cwd, { shutdownEvents });
		const a = runtime.session.id;
		const run = await syntheticRun(cwd, a, "tool");
		const tracker = new feedback.PiRunFeedback(runtime.pi, { pollMs: 1000 });
		t.after(() => tracker.stop());
		runtime.handlers.push(shutdownHandler(tracker));
		runtime.session.streaming = true;
		await tracker.track(runtime.ctx(), run.runId, "tool");
		assert.equal(runtime.sends, 1);
		assert.equal(runtime.session.queue.length, 1, "queued while A streams");
		await runtime.newSession();
		await tracker.restore(runtime.ctx());
		assert.equal(runtime.sends, 1, "B is not the audience");
		await runtime.switchSession(a);
		assert.equal(
			runtime.count(a, run.runId),
			0,
			"the queue of A's first runtime was dropped",
		);
		await tracker.restore(runtime.ctx());
		assert.equal(
			runtime.count(a, run.runId),
			1,
			"exactly one message in A's history",
		);
		assert.equal(runtime.sends, 2);
		// And never again: in this runtime, after another /resume, or after a restart.
		await tracker.restore(runtime.ctx());
		await runtime.switchSession(a);
		await tracker.restore(runtime.ctx());
		feedback.resetFeedbackDeliveryStateForTests();
		await tracker.restore(runtime.ctx());
		assert.equal(runtime.count(a, run.runId), 1);
		assert.equal(runtime.sends, 2);
		tracker.stop();
	});

test("F1 (fake runtime): /reload with the queue retained sends nothing extra (also after a module re-import)", async (t) => {
	const cwd = await tempProject(t);
	const runtime = new FakePiRuntime(cwd);
	const a = runtime.session.id;
	const run = await syntheticRun(cwd, a, "tool");
	const first = new feedback.PiRunFeedback(runtime.pi, { pollMs: 1000 });
	t.after(() => first.stop());
	runtime.handlers.push(shutdownHandler(first));
	runtime.session.streaming = true;
	await first.track(runtime.ctx(), run.runId, "tool");
	assert.equal(runtime.sends, 1);
	await runtime.reload();
	runtime.handlers.length = 0;
	// The reload re-imports the extension module; the runtime and its queue stay.
	const reloaded = await import(
		`../../dist/hosts/pi/feedback.js?r4reload=${Date.now()}`
	);
	const second = new reloaded.PiRunFeedback(runtime.pi, { pollMs: 1000 });
	t.after(() => second.stop());
	runtime.handlers.push(shutdownHandler(second));
	await second.restore(runtime.ctx());
	assert.equal(runtime.sends, 1, "zero duplicates after the reload");
	runtime.settle(); // the queued follow-up is processed and persisted
	await second.restore(runtime.ctx());
	assert.equal(runtime.count(a, run.runId), 1);
	assert.equal(runtime.sends, 1);
	second.stop();
});

// ---------------------------------------------------------------------------------------------
// Real Pi 1.1 runtime twins (opt-in).

async function realSetup(t) {
	const { SessionManager, AgentSession, AgentSessionRuntime, Agent } =
		piRuntime;
	const cwd = await tempProject(t);
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const run = await syntheticRun(cwd, sm.getSessionId(), "tool");
	const shutdowns = [];
	const listeners = [];
	function makeSession(manager) {
		// Real queue, abort, dispose and runtime-replacement methods. No prompt is ever called and
		// the stream function is a fail-fast guard, not a model.
		const session = Object.create(AgentSession.prototype);
		session.sessionManager = manager;
		session._isAgentRunActive = false;
		session.agent = new Agent({
			streamFn() {
				throw new Error("MODEL CALL FORBIDDEN");
			},
		});
		session._pendingCustomMessages = [];
		session._pendingNextTurnMessages = [];
		session._steeringMessages = [];
		session._followUpMessages = [];
		session._deferredSettledActions = [];
		session._bashAbortControllers = new Set();
		session._eventListeners = [];
		session._emit = () => {};
		session._emitQueueUpdate = () => {};
		session._refreshFinalizedContext = () => {};
		session._extensionRunner = {
			hasHandlers: (event) => event === "session_shutdown",
			async emit(event) {
				if (event.type !== "session_shutdown") return;
				shutdowns.push(event.reason);
				for (const listener of listeners) await listener(event, ctxFor());
			},
			invalidate() {},
		};
		const abort = session.agent.abort.bind(session.agent);
		session.agent.abort = () => {
			abort();
			if (session._isAgentRunActive)
				queueMicrotask(() => session._emitAgentSettled());
		};
		return session;
	}
	const initial = makeSession(sm);
	initial._isAgentRunActive = true; // the agent streams: a triggerTurn message is queued
	const services = { cwd, agentDir: join(cwd, "agent") };
	const runtime = new AgentSessionRuntime(
		initial,
		services,
		async ({ sessionManager }) => ({
			session: makeSession(sessionManager),
			services,
		}),
	);
	let sends = 0;
	const pi = {
		sendMessage(message, options) {
			sends += 1;
			return runtime.session.sendCustomMessage(message, options);
		},
	};
	function ctxFor() {
		const ctx = fakeCtx(cwd, { sessionId: runtime.session.sessionId });
		ctx.sessionManager = runtime.session.sessionManager;
		return ctx;
	}
	return {
		cwd,
		sm,
		run,
		initial,
		runtime,
		pi,
		ctxFor,
		shutdowns,
		listeners,
		sends: () => sends,
	};
}

for (const shutdownEvents of [true, false])
	test(`F1 (real Pi 1.1 AgentSessionRuntime${shutdownEvents ? "" : ", tracker stop only"}): queued in A, newSession(), switchSession(A) → exactly one message`, {
		skip: REAL_SKIP,
	}, async (t) => {
		const env = await realSetup(t);
		const tracker = new feedback.PiRunFeedback(env.pi, { pollMs: 1000 });
		t.after(() => tracker.stop());
		env.listeners.push(
			shutdownEvents ? shutdownHandler(tracker) : () => tracker.stop(),
		);
		await tracker.track(env.ctxFor(), env.run.runId, "tool");
		assert.equal(env.sends(), 1);
		assert.equal(env.initial.agent.hasQueuedMessages(), true);
		const originalFile = env.sm.getSessionFile();
		await env.runtime.newSession();
		assert.notEqual(env.runtime.session.sessionId, env.sm.getSessionId());
		await tracker.restore(env.ctxFor());
		assert.equal(env.sends(), 1);
		assert.equal(
			env.initial.agent.hasQueuedMessages(),
			true,
			"left on the disposed runtime",
		);
		await env.runtime.switchSession(originalFile);
		assert.equal(env.runtime.session.sessionId, env.sm.getSessionId());
		await tracker.restore(env.ctxFor());
		assert.deepEqual(env.shutdowns, ["new", "resume"]);
		assert.equal(env.sends(), 2, "one resend into the resumed session");
		const entries = env.runtime.session.sessionManager.getEntries();
		assert.equal(
			completions(entries, env.run.runId),
			1,
			"exactly one message in A's history",
		);
		await tracker.restore(env.ctxFor());
		assert.equal(env.sends(), 2);
		tracker.stop();
	});

test("F1 (real Pi 1.1 queue): reload with the queue retained → zero duplicates, one message once the turn ends", {
	skip: REAL_SKIP,
}, async (t) => {
	const env = await realSetup(t);
	const tracker = new feedback.PiRunFeedback(env.pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	env.listeners.push(shutdownHandler(tracker));
	await tracker.track(env.ctxFor(), env.run.runId, "tool");
	assert.equal(env.sends(), 1);
	// AgentSession.reload(): session_shutdown "reload", same AgentSession, queue and sessionManager.
	await env.initial._extensionRunner.emit({
		type: "session_shutdown",
		reason: "reload",
	});
	assert.deepEqual(env.shutdowns, ["reload"]);
	env.listeners.length = 0;
	const reloaded = await import(
		`../../dist/hosts/pi/feedback.js?r4realreload=${Date.now()}`
	);
	const second = new reloaded.PiRunFeedback(env.pi, { pollMs: 1000 });
	t.after(() => second.stop());
	await second.restore(env.ctxFor());
	assert.equal(env.sends(), 1, "zero duplicates");
	assert.equal(env.initial.agent.hasQueuedMessages(), true);
	// Simulated turn end: Pi drains the follow-up queue into the session.
	for (const message of env.initial.agent.followUpQueue.drain())
		env.sm.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	env.initial._isAgentRunActive = false;
	await second.restore(env.ctxFor());
	assert.equal(completions(env.sm.getEntries(), env.run.runId), 1);
	assert.equal(env.sends(), 1);
	second.stop();
});

test("F1 (real Pi 1.1 queue): a cleared queue is recovered when the session is reopened in the same process", {
	skip: REAL_SKIP,
}, async (t) => {
	const { SessionManager } = piRuntime;
	const env = await realSetup(t);
	const tracker = new feedback.PiRunFeedback(env.pi, { pollMs: 1000 });
	t.after(() => tracker.stop());
	await tracker.track(env.ctxFor(), env.run.runId, "tool");
	assert.equal(env.sends(), 1);
	assert.equal(env.initial.agent.peekQueuedMessages()[0].customType, AW);
	// TUI Escape/dequeue: Pi's clearQueue() drops the queued custom message.
	env.initial.clearQueue();
	assert.equal(env.initial.agent.hasQueuedMessages(), false);
	tracker.stop();
	env.initial._isAgentRunActive = false;
	// A /resume-equivalent reopen of the intact file (a new SessionManager, same process).
	env.initial.sessionManager = SessionManager.open(env.sm.getSessionFile());
	await tracker.restore(env.ctxFor());
	assert.equal(env.sends(), 2);
	assert.equal(
		completions(env.initial.sessionManager.getEntries(), env.run.runId),
		1,
	);
	tracker.stop();
});
