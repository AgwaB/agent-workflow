// New in agent-workflow (WP29 item 1, parity row 43): the Pi host approves dynamic controllers with
// `approval: "ask"` through `ctx.ui.confirm`, as pi-workflow's `dynamicUiFromContext` did: attached
// and awaited runs of a session with a dialog UI ask "Run dynamic workflow controller?" with the
// approval scope, pi-workflow's 5-minute timeout and an abort signal; yes runs the controller, no
// rejects it for this run (`dynamic_approval_rejected`, no re-prompt), and print/JSON mode keeps
// `dynamic_ui_unavailable` with a message naming the approve commands. The controller is a local
// helper and the earlier stage runs on the workflow executor fixture: no model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	APPROVAL_TITLE,
	approvalEvents,
	approvalProject,
	controllerTask,
} from "../helpers/dynamic-approval-fixture.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const store = await import("../../dist/core/store.js");

let root;
let counter = 0;
const unregister = [];
const instances = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp29-pi-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const pi of instances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	return approvalProject(root, `p${counter}`, (descriptor) =>
		unregister.push(core.registerWorkflowExecutor(descriptor)),
	);
}

function install(env) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	instances.push(pi);
	return pi;
}

/** A Pi context whose confirm dialog answers `answer` and records every question. */
function dialogCtx(cwd, answer, options = {}) {
	const ctx = fakeCtx(cwd, options);
	ctx.confirms = [];
	ctx.ui.confirm = async (title, message, dialog) => {
		ctx.confirms.push({ title, message, dialog });
		return answer;
	};
	return ctx;
}

async function awaitedRun(pi, ctx, executor, task) {
	return pi.tools
		.get("aw_run")
		.execute(
			"r",
			{ workflow: "wf.json", task, executor, awaitTerminal: true },
			undefined,
			undefined,
			ctx,
		);
}

test("Pi confirm yes: the awaited run asks once, runs the controller and records the Pi decision", async () => {
	const { cwd, env, executor, controllerRuns } = await project();
	const pi = install(env);
	const ctx = dialogCtx(cwd, true);
	const result = await awaitedRun(pi, ctx, executor, "approve in pi");
	assert.equal(result.details.outcome, "completed", result.content[0].text);
	assert.equal(ctx.confirms.length, 1);
	const [question] = ctx.confirms;
	assert.equal(question.title, APPROVAL_TITLE);
	assert.match(question.message, /adaptive\.controller/);
	assert.match(question.message, /Approval request digest:/);
	assert.equal(
		question.dialog.timeout,
		300_000,
		"pi-workflow's 5-minute bound",
	);
	assert.ok(question.dialog.signal instanceof AbortSignal);
	assert.equal(await controllerRuns(), 1);
	const resolved = (await approvalEvents(cwd, result.details.runId)).find(
		(event) => event.type === "approval.resolved",
	);
	assert.equal(resolved.payload.approved, true);
	assert.deepEqual(resolved.payload.decidedBy, { host: "pi", via: "prompt" });
});

test("Pi confirm no: the controller is rejected for this run and resume does not ask again", async () => {
	const { cwd, env, executor, controllerRuns } = await project();
	const pi = install(env);
	const ctx = dialogCtx(cwd, false);
	const result = await awaitedRun(pi, ctx, executor, "reject in pi");
	assert.equal(result.details.outcome, "blocked", result.content[0].text);
	const run = await store.readRunRecord(cwd, result.details.runId);
	assert.equal(controllerTask(run).statusDetail, "dynamic_approval_rejected");
	assert.match(controllerTask(run).lastMessage, /will not re-prompt/);
	assert.equal(await controllerRuns(), 0);
	assert.equal(ctx.confirms.length, 1);
	// Not resumable: a rejection is final for this run (pi-workflow semantics).
	await assert.rejects(
		api.resumeAction(
			{ cwd, env, host: "pi", dynamicUi: { confirm: ctx.ui.confirm } },
			{
				runId: run.runId,
			},
		),
		/non-resumable blocked task/,
	);
	assert.equal(ctx.confirms.length, 1);
});

test("Pi without a dialog UI (json mode): blocked as dynamic_ui_unavailable with the approve commands", async () => {
	const { cwd, env, executor, controllerRuns } = await project();
	const pi = install(env);
	const ctx = dialogCtx(cwd, true, { hasUI: false });
	const result = await awaitedRun(pi, ctx, executor, "no ui");
	assert.equal(result.details.outcome, "blocked", result.content[0].text);
	assert.equal(ctx.confirms.length, 0, "never asked without a UI");
	const run = await store.readRunRecord(cwd, result.details.runId);
	assert.equal(controllerTask(run).statusDetail, "dynamic_ui_unavailable");
	assert.match(
		controllerTask(run).lastMessage,
		new RegExp(`/aw approve ${run.runId}`),
	);
	assert.match(controllerTask(run).lastMessage, /agent-workflow approve/);
	assert.match(controllerTask(run).lastMessage, /workflow_approve/);
	assert.equal(await controllerRuns(), 0);
});

test("Pi /aw resume with a dialog UI asks the open approval and continues the blocked run", async () => {
	const { cwd, env, executor, controllerRuns, submits } = await project();
	const pi = install(env);
	const headless = dialogCtx(cwd, true, { hasUI: false });
	const blocked = await awaitedRun(pi, headless, executor, "resume in pi");
	assert.equal(blocked.details.outcome, "blocked");
	const runId = blocked.details.runId;
	assert.equal(submits(), 1);
	const ctx = dialogCtx(cwd, true);
	await pi.commands.get("aw").handler(`resume ${runId}`, ctx);
	await pi.commands.get("aw").handler(`wait ${runId} 30s`, ctx);
	assert.equal(
		ctx.confirms.length,
		1,
		JSON.stringify(ctx.notes, null, 1).slice(0, 3000),
	);
	assert.equal((await store.readRunRecord(cwd, runId)).status, "completed");
	assert.equal(await controllerRuns(), 1);
	assert.equal(submits(), 1, "the completed prep stage is not relaunched");
});
