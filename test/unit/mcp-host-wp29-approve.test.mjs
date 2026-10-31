// New in agent-workflow (WP29 item 3, parity row 43): dynamic-controller approval over the host MCP
// server. The server can ask its user only during a tool call, so it never approves while it drives
// a run: workflow_wait/workflow_status show the open approval (the question and its requestId) and
// name workflow_approve; workflow_approve asks through elicitation before anything is recorded
// (approve + accept → the run continues; approve + decline → rejected for the run, pi-workflow's
// "no"; cancel/error → nothing recorded; reject + accept → rejected) and is refused on clients
// without elicitation with the terminal command. Through the fake MCP client against an in-process
// server; the controller is a local helper and the earlier stage runs on the workflow executor
// fixture: no model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	APPROVAL_TITLE,
	approvalEvents,
	approvalProject,
	CONTROLLER,
	controllerTask,
} from "../helpers/dynamic-approval-fixture.mjs";
import { inProcessHostServer, waitLoop } from "../helpers/mcp-host-client.mjs";

const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const clients = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp29-mcp-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const client of clients.splice(0))
		await client.close().catch(() => undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	return approvalProject(root, `p${counter}`, (descriptor) =>
		unregister.push(core.registerWorkflowExecutor(descriptor)),
	);
}

/** A client; with `answer`, it supports elicitation and answers every dialog with `answer()`. */
async function connect(p, answer) {
	const requests = [];
	const client = await inProcessHostServer({
		root: p.cwd,
		env: p.env,
		host: "generic",
		...(answer
			? {
					onRequest: async (message) => {
						requests.push(message);
						return answer();
					},
				}
			: {}),
	});
	clients.push(client);
	const init = await client.initialize(
		"2025-06-18",
		answer ? { elicitation: {} } : {},
	);
	assert.equal(init.error, undefined, JSON.stringify(init));
	return { client, requests };
}

const text = (result) => result.content[0].text;

/** Launch over MCP (kept in the server process) and wait until the run blocks on the approval. */
async function blockedRun(p, client) {
	const launched = await client.call("workflow_run", {
		workflow: "wf.json",
		task: `approve over mcp ${counter}`,
		executor: p.executor,
		detach: false,
	});
	const runId = launched.structuredContent.data.runId;
	const waited = (await waitLoop(client, runId)).at(-1);
	return { runId, waited };
}

test("workflow_wait and workflow_status show the pending approval and the tool to answer it", async () => {
	const p = await project();
	const { client } = await connect(p);
	const { runId, waited } = await blockedRun(p, client);
	const data = waited.structuredContent.data;
	assert.equal(data.actionRequired, true);
	assert.equal(data.pendingApprovals.length, 1);
	const [pending] = data.pendingApprovals;
	assert.equal(pending.controllerSpecId, CONTROLLER);
	assert.equal(pending.title, APPROVAL_TITLE);
	assert.match(pending.message, /requests approval to run dynamic controller/);
	assert.match(pending.requestId, /^[0-9a-f]{64}$/);
	assert.match(
		text(waited),
		/Awaiting approval: dynamic controller adaptive\.controller/,
	);
	assert.match(text(waited), /workflow_approve \{"runId":/);
	assert.match(waited.structuredContent.next, /call workflow_approve/);
	const status = await client.call("workflow_status", { runId });
	assert.deepEqual(
		status.structuredContent.data.run.pendingApprovals,
		data.pendingApprovals,
	);
	assert.match(status.structuredContent.next, /workflow_approve/);
});

test("workflow_approve without elicitation is refused with the terminal command; nothing recorded", async () => {
	const p = await project();
	const { client } = await connect(p);
	const { runId, waited } = await blockedRun(p, client);
	const { requestId } = waited.structuredContent.data.pendingApprovals[0];
	const result = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "approve",
	});
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.outcome, "refused");
	assert.equal(result.structuredContent.data.confirmation, "unsupported");
	assert.match(
		text(result),
		new RegExp(`agent-workflow approve ${runId} --request ${requestId}`),
	);
	assert.equal(
		(await approvalEvents(p.cwd, runId)).filter(
			(event) => event.type === "approval.resolved",
		).length,
		0,
	);
});

test("workflow_approve accept: the user confirms in a dialog; the run continues and completes", async () => {
	const p = await project();
	const { client, requests } = await connect(p, () => ({ action: "accept" }));
	const { runId, waited } = await blockedRun(p, client);
	assert.equal(requests.length, 0, "never asked while driving the run");
	const { requestId } = waited.structuredContent.data.pendingApprovals[0];
	const result = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "approve",
		detach: false,
	});
	assert.equal(result.isError, false, text(result));
	assert.equal(result.structuredContent.data.decision, "approved");
	assert.equal(requests.length, 1);
	assert.match(
		requests[0].params.message,
		new RegExp(`^${APPROVAL_TITLE.replace("?", "\\?")}\\n\\n`),
	);
	assert.match(requests[0].params.message, /Approval request digest:/);
	const final = (await waitLoop(client, runId)).at(-1);
	assert.equal(final.structuredContent.outcome, "completed", text(final));
	assert.equal(await p.controllerRuns(), 1);
	assert.equal(p.submits(), 1, "the completed prep stage is not relaunched");
	const resolved = (await approvalEvents(p.cwd, runId)).find(
		(event) => event.type === "approval.resolved",
	);
	assert.equal(resolved.payload.approved, true);
	assert.deepEqual(resolved.payload.decidedBy, {
		host: "generic",
		via: "approve",
	});
});

test("workflow_approve decline rejects the controller for the run; cancel and errors record nothing", async () => {
	const p = await project();
	let answer = { action: "cancel" };
	const { client } = await connect(p, () => answer);
	const { runId, waited } = await blockedRun(p, client);
	const { requestId } = waited.structuredContent.data.pendingApprovals[0];
	for (const reply of [
		{ action: "cancel" },
		{ error: { code: -32603, message: "no UI" } },
	]) {
		answer = reply;
		const result = await client.call("workflow_approve", {
			runId,
			requestId,
			decision: "approve",
		});
		assert.equal(result.structuredContent.outcome, "refused");
		assert.equal(result.structuredContent.data.decision, "unanswered");
		assert.match(text(result), /Nothing recorded/);
	}
	// A rejection the user does not confirm changes nothing either.
	answer = { action: "decline" };
	const kept = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "reject",
	});
	assert.equal(kept.structuredContent.data.decision, "unanswered");
	assert.equal(
		(await approvalEvents(p.cwd, runId)).filter(
			(event) => event.type === "approval.resolved",
		).length,
		0,
	);
	// Declining the approval question is pi-workflow's "no": rejected for this run.
	const declined = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "approve",
	});
	assert.equal(
		declined.structuredContent.data?.decision,
		"rejected",
		text(declined),
	);
	const run = await store.readRunRecord(p.cwd, runId);
	assert.equal(run.status, "blocked");
	assert.equal(controllerTask(run).statusDetail, "dynamic_approval_rejected");
	assert.equal(await p.controllerRuns(), 0);
	// Nothing is pending any more.
	const again = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "approve",
	});
	assert.equal(again.isError, true);
	assert.match(text(again), /no dynamic controller approval waiting/);
});

test("workflow_approve reject + accept rejects the controller", async () => {
	const p = await project();
	const { client, requests } = await connect(p, () => ({ action: "accept" }));
	const { runId, waited } = await blockedRun(p, client);
	const { requestId } = waited.structuredContent.data.pendingApprovals[0];
	const result = await client.call("workflow_approve", {
		runId,
		requestId,
		decision: "reject",
	});
	assert.equal(
		result.structuredContent.data?.decision,
		"rejected",
		text(result),
	);
	assert.match(
		requests[0].params.message,
		/^Reject dynamic workflow controller\?/,
	);
	const resolved = (await approvalEvents(p.cwd, runId)).find(
		(event) => event.type === "approval.resolved",
	);
	assert.equal(resolved.payload.approved, false);
	assert.equal(
		controllerTask(await store.readRunRecord(p.cwd, runId)).statusDetail,
		"dynamic_approval_rejected",
	);
});
