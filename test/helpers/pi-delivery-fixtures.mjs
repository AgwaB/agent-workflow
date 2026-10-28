// New in agent-workflow (WP19 round 5): shared fixtures of the Pi completion-delivery tests:
// synthetic settled runs, receipt paths, a fake Pi session runtime with Pi 1.1's queue semantics
// and (opt-in) Pi 1.1's real `AgentSessionRuntime`/`AgentSession` queue/`SessionManager` without a
// model. Extracted from test/unit/host-wp19r4-pi-queue-lifetime.test.mjs.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fakeCtx } from "./pi-host-fake.mjs";

export const feedback = await import("../../dist/hosts/pi/feedback.js");
const { readRunRecord } = await import("../../dist/core/store.js");
export const AW = feedback.AW_COMPLETION_MESSAGE_TYPE;

/** The `globalThis` keys of the process state: round 3/4 (`v1`) and round 5 (`v2`). */
export const STATE_KEY_V1 = Symbol.for(
	"agent-workflow.pi-feedback.process-state.v1",
);
export const STATE_KEY_V2 = Symbol.for(
	"agent-workflow.pi-feedback.process-state.v2",
);

let counter = 0;
export async function tempProject(t, prefix = "aw-wp19r5-") {
	feedback.resetFeedbackDeliveryStateForTests();
	const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	return cwd;
}

/** A settled synthetic run bound to `sessionId`, as the tracker reads it. */
export async function syntheticRun(cwd, sessionId, launchedBy = "tool") {
	counter += 1;
	const runId = `workflow_wp19r5_${process.pid}_${counter}`;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	const run = {
		runId,
		status: "completed",
		name: "wp19r5 delivery",
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
	return readRunRecord(cwd, runId);
}

export const receiptFile = (cwd, run) =>
	feedback.feedbackReceiptPath(cwd, run.runId, feedback.feedbackEpoch(run));
export const readReceipt = async (cwd, run) =>
	JSON.parse(await fs.readFile(receiptFile(cwd, run), "utf8"));
export async function writeReceipt(cwd, run, receipt) {
	await fs.mkdir(join(receiptFile(cwd, run), ".."), { recursive: true });
	await fs.writeFile(receiptFile(cwd, run), JSON.stringify(receipt));
}

export const completions = (entries, runId) =>
	entries.filter(
		(entry) =>
			entry?.type === "custom_message" &&
			entry.customType === AW &&
			entry.details?.runId === runId,
	).length;

/** `session_shutdown` as the extension handles it. */
export function shutdownHandler(tracker) {
	return (event, ctx) => tracker.shutdown(event, ctx);
}

/**
 * A fake Pi session runtime with Pi 1.1's queue semantics: while the agent streams, a
 * `triggerTurn` message is queued in the session runtime; `/reload` keeps the runtime and its
 * queue; `/new` and `/resume` emit `session_shutdown`, then dispose the runtime (its queue is
 * dropped) and open a fresh one with a new `sessionManager` object. The history of a session id is
 * durable across runtimes.
 */
export class FakePiRuntime {
	constructor(cwd) {
		this.cwd = cwd;
		this.store = new Map();
		this.handlers = [];
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
		for (const handler of this.handlers) await handler(event, this.ctx());
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
	settle() {
		const session = this.session;
		session.streaming = false;
		for (const entry of session.queue.splice(0)) this.append(session, entry);
	}
	count(id, runId) {
		return completions(this.store.get(id) ?? [], runId);
	}
}

/** Pi 1.1's runtime modules from AGENT_WORKFLOW_PI_CODING_AGENT_DIR, or undefined. */
export async function loadPiRuntime() {
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

/**
 * Pi 1.1's real session runtime (queue, abort, dispose, `newSession`/`switchSession`) around a
 * persisted SessionManager; the agent streams (a `triggerTurn` message is queued). No prompt is
 * ever called and the stream function is a fail-fast guard, not a model.
 */
export async function realPiSetup(t, piRuntime) {
	const { SessionManager, AgentSession, AgentSessionRuntime, Agent } =
		piRuntime;
	const cwd = await tempProject(t, "aw-wp19r5-real-");
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const run = await syntheticRun(cwd, sm.getSessionId(), "tool");
	const shutdowns = [];
	const listeners = [];
	function makeSession(manager) {
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
	initial._isAgentRunActive = true;
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
