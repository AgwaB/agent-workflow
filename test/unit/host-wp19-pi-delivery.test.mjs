// New in agent-workflow (WP19, stage-2 reviews #5 and #6): Pi completion delivery.
// #5: a crash between the reservation and `sendMessage` (a pending receipt left by a dead
// process) does not suppress the message forever: the restart delivers exactly one. An empty
// receipt file is not proof of delivery. A crash after sending but before the acknowledgement is
// resolved against Pi's session history (no second message).
// #6: when the current session switches from A to B during a delivery, B gets nothing and A's
// delivery stays pending (A's next delivery sends it once).
// Runs use the workflow executor fixture (no model or agent-CLI calls); fake Pi objects only.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const DEAD_PID = 2 ** 22 + 9_876;

const SPEC = {
	schemaVersion: 1,
	name: "wp19-delivery",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-delivery-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A settled run whose completion audience is `sessionId`. */
async function settledRun(sessionId) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp19-delivery-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const ctx = { cwd, env };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "delivery task",
		executor: id,
	});
	const runId = launched.data.runId;
	await feedback.bindFeedbackAudience(cwd, runId, sessionId, "command");
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	const run = (await api.showAction(ctx, { ref: runId })).data.run;
	return { cwd, env, runId, run };
}

const completions = (pi) =>
	pi.messages.filter(
		(entry) => entry.message.customType === feedback.AW_COMPLETION_MESSAGE_TYPE,
	);

function receiptsDir(cwd, runId) {
	return join(
		cwd,
		".agent-workflow",
		"workflows",
		runId,
		feedback.FEEDBACK_RECEIPTS_DIR,
	);
}

/** A Pi restart: a new extension instance whose session_start catches up. */
async function restart(env, ctx) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	for (const handler of pi.handlers.get("session_start"))
		await handler({ type: "session_start" }, ctx);
	await ext.unfinishedNoticeSettledForTests(pi);
	for (const handler of pi.handlers.get("session_shutdown") ?? [])
		await handler({}, ctx);
	return pi;
}

test("review #5: crash after the reservation, before send → the restart delivers exactly one message", async () => {
	const { cwd, env, runId, run } = await settledRun("session-a");
	const epoch = feedback.feedbackEpoch(run);
	await mkdir(receiptsDir(cwd, runId), { recursive: true });
	// The receipt a crashed process left: reserved, never sent.
	await writeFile(
		feedback.feedbackReceiptPath(cwd, runId, epoch),
		JSON.stringify({
			schema: "agent-workflow-pi-feedback-receipt-v1",
			runId,
			sessionId: "session-a",
			epoch,
			status: run.status,
			state: "pending",
			token: "crashed",
			pid: DEAD_PID,
			reservedAt: new Date().toISOString(),
			deliveredAt: new Date().toISOString(),
		}),
	);
	const history = [];
	const ctx = fakeCtx(cwd, { sessionId: "session-a" });
	ctx.sessionManager.getEntries = () => history;
	const first = await restart(env, ctx);
	assert.equal(completions(first).length, 1, "the crashed delivery is resent");
	const [sent] = completions(first);
	assert.equal(sent.message.details.runId, runId);
	history.push({
		type: "custom_message",
		customType: sent.message.customType,
		details: sent.message.details,
	});
	// Another restart: the session history holds it, nothing more (WP19 round 2: `confirmed`).
	const second = await restart(env, ctx);
	assert.equal(completions(second).length, 0);
	const receipt = JSON.parse(
		await readFile(feedback.feedbackReceiptPath(cwd, runId, epoch), "utf8"),
	);
	assert.equal(receipt.state, "confirmed");
});

test("review #5: crash after send, before the acknowledgement → resolved from session history, no duplicate", async () => {
	const { cwd, env, runId, run } = await settledRun("session-a");
	const epoch = feedback.feedbackEpoch(run);
	await mkdir(receiptsDir(cwd, runId), { recursive: true });
	await writeFile(
		feedback.feedbackReceiptPath(cwd, runId, epoch),
		JSON.stringify({
			schema: "agent-workflow-pi-feedback-receipt-v1",
			runId,
			sessionId: "session-a",
			epoch,
			status: run.status,
			state: "pending",
			token: "crashed",
			pid: DEAD_PID,
			reservedAt: new Date().toISOString(),
		}),
	);
	const ctx = fakeCtx(cwd, { sessionId: "session-a" });
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom_message",
			customType: feedback.AW_COMPLETION_MESSAGE_TYPE,
			details: { runId, feedbackEpoch: epoch },
		},
	];
	const pi = await restart(env, ctx);
	assert.equal(completions(pi).length, 0);
	const receipt = JSON.parse(
		await readFile(feedback.feedbackReceiptPath(cwd, runId, epoch), "utf8"),
	);
	assert.equal(receipt.state, "confirmed");
});

test("review #5: an empty receipt file is not proof of delivery", async () => {
	const { cwd, runId, run } = await settledRun("session-a");
	const epoch = feedback.feedbackEpoch(run);
	await mkdir(receiptsDir(cwd, runId), { recursive: true });
	await writeFile(feedback.feedbackReceiptPath(cwd, runId, epoch), "");
	const pi = fakePi();
	const outcome = await feedback.deliverCompletion(
		pi,
		fakeCtx(cwd, { sessionId: "session-a" }),
		run,
		{ triggerTurn: false },
	);
	assert.equal(outcome, "delivered");
	assert.equal(completions(pi).length, 1);
});

test("review #6: a session switch A → B during delivery sends nothing to B; A's delivery stays pending", async () => {
	const { cwd, runId, run } = await settledRun("session-a");
	const pi = fakePi();
	// The current session is A when the delivery starts and B from then on.
	let calls = 0;
	const ctx = fakeCtx(cwd, { sessionId: "session-a" });
	ctx.sessionManager = {
		getSessionId: () => {
			calls += 1;
			return calls <= 1 ? "session-a" : "session-b";
		},
	};
	const outcome = await feedback.deliverCompletion(pi, ctx, run, {
		triggerTurn: false,
	});
	assert.equal(completions(pi).length, 0, "B received A's completion");
	assert.notEqual(outcome, "delivered");
	const left = readdirSync(receiptsDir(cwd, runId)).filter((name) =>
		name.endsWith(".json"),
	);
	for (const name of left) {
		const receipt = JSON.parse(
			await readFile(join(receiptsDir(cwd, runId), name), "utf8"),
		);
		assert.ok(
			!["delivered", "sent", "confirmed"].includes(receipt.state),
			receipt.state,
		);
	}
	// Back in session A: delivered once.
	const again = await feedback.deliverCompletion(
		pi,
		fakeCtx(cwd, { sessionId: "session-a" }),
		run,
		{ triggerTurn: false },
	);
	assert.equal(again, "delivered");
	assert.equal(completions(pi).length, 1);
});

test("review #6: the tracker's fence (session generation) stops an in-flight delivery", async () => {
	const { cwd, run } = await settledRun("session-a");
	const pi = fakePi();
	const outcome = await feedback.deliverCompletion(
		pi,
		fakeCtx(cwd, { sessionId: "session-a" }),
		run,
		{ triggerTurn: false, fence: () => false },
	);
	assert.equal(outcome, "session-changed");
	assert.equal(completions(pi).length, 0);
});
