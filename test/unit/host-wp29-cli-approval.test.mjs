// New in agent-workflow (WP29 item 2, parity row 43): the `agent-workflow` CLI asks to approve a
// dynamic controller with `approval: "ask"` on a terminal (simulated here with `isTTY` and a scripted
// prompt): `y` runs it, `n` rejects it for this run, no answer leaves it blocked and resumable
// (`dynamic_approval_timeout`). Without a terminal the run blocks as `dynamic_ui_unavailable` and the
// output names `agent-workflow approve`. The controller is a local helper and the earlier stage runs
// on the workflow executor fixture: no model or agent-CLI calls.
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

const cli = await import("../../dist/hosts/cli/index.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp29-cli-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	return approvalProject(root, `p${counter}`, (descriptor) =>
		unregister.push(core.registerWorkflowExecutor(descriptor)),
	);
}

/** One in-process CLI call; `answers` script the terminal prompt (undefined: no terminal). */
async function runCli(p, argv, answers) {
	const out = [];
	const err = [];
	const prompts = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd: p.cwd,
		env: p.env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: answers !== undefined,
		waitSliceMs: 2_000,
		...(answers === undefined
			? {}
			: {
					prompt: async (question, options) => {
						prompts.push({ question, options });
						return answers.shift() ?? "";
					},
				}),
	});
	return { code, out: out.join(""), err: err.join(""), prompts };
}

function runIdOf(text) {
	return /Run: (workflow_\S+)/.exec(text)?.[1];
}

test("CLI terminal: y approves the controller; the run completes and records the CLI decision", async () => {
	const p = await project();
	const result = await runCli(
		p,
		["run", "wf.json", "approve", "--executor", p.executor],
		["y"],
	);
	assert.equal(result.code, 0, result.out + result.err);
	assert.equal(result.prompts.length, 1);
	assert.equal(result.prompts[0].question, `${APPROVAL_TITLE} [y/n] `);
	assert.ok(result.prompts[0].options.signal instanceof AbortSignal);
	assert.match(
		result.err,
		/requests approval to run dynamic controller adaptive\.controller/,
	);
	assert.equal(await p.controllerRuns(), 1);
	const runId = runIdOf(result.out);
	const resolved = (await approvalEvents(p.cwd, runId)).find(
		(event) => event.type === "approval.resolved",
	);
	assert.deepEqual(resolved.payload.decidedBy, { host: "cli", via: "prompt" });
});

test("CLI terminal: n rejects the controller for this run", async () => {
	const p = await project();
	const result = await runCli(
		p,
		["run", "wf.json", "reject", "--executor", p.executor],
		["n"],
	);
	assert.equal(result.code, 1);
	const run = await store.readRunRecord(p.cwd, runIdOf(result.out));
	assert.equal(run.status, "blocked");
	assert.equal(controllerTask(run).statusDetail, "dynamic_approval_rejected");
	assert.equal(await p.controllerRuns(), 0);
});

test("CLI terminal: no answer leaves the approval open (blocked, resumable, asked again on resume)", async () => {
	const p = await project();
	const first = await runCli(
		p,
		["run", "wf.json", "later", "--executor", p.executor],
		[""],
	);
	assert.equal(first.code, 1);
	const runId = runIdOf(first.out);
	const run = await store.readRunRecord(p.cwd, runId);
	assert.equal(controllerTask(run).statusDetail, "dynamic_approval_timeout");
	assert.match(controllerTask(run).lastMessage, /agent-workflow approve/);
	const resumed = await runCli(p, ["resume", runId], ["yes"]);
	assert.equal(resumed.code, 0, resumed.out + resumed.err);
	assert.equal(resumed.prompts.length, 1);
	assert.equal((await store.readRunRecord(p.cwd, runId)).status, "completed");
	assert.equal(p.submits(), 1, "the completed prep stage is not relaunched");
});

test("CLI without a terminal: blocked as dynamic_ui_unavailable; the output names agent-workflow approve", async () => {
	const p = await project();
	const result = await runCli(p, [
		"run",
		"wf.json",
		"headless",
		"--executor",
		p.executor,
	]);
	assert.equal(result.code, 1);
	const runId = runIdOf(result.out);
	const run = await store.readRunRecord(p.cwd, runId);
	assert.equal(controllerTask(run).statusDetail, "dynamic_ui_unavailable");
	assert.match(result.out, new RegExp(`agent-workflow approve ${runId}`));
	assert.equal(await p.controllerRuns(), 0);
});
