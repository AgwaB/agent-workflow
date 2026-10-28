// New in agent-workflow (WP29 item 4, parity row 43): a run blocked on a dynamic-controller approval
// is approved later from any host. A detached run (its supervisor has no UI) blocks with the approve
// commands; a fresh `agent-workflow approve <run> --yes` process records the decision on the run
// (`approval.resolved`, `decidedBy: {host: "cli", via: "approve"}`) and resumes it: the controller
// runs and the completed earlier stage is not relaunched (B3/fencing unchanged). Without a terminal
// `approve` needs --yes; on a terminal it asks y/n (n rejects). Pi: `/aw approve` asks through
// ctx.ui.confirm. Runs use the guarded test-executor hook (the real bin in fresh processes) or the
// workflow executor fixture in process; the controller is a local helper: no model or agent-CLI
// calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	approvalEvents,
	approvalProject,
	CONTROLLER,
	controllerTask,
} from "../helpers/dynamic-approval-fixture.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

const BIN = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const HOOK_MODULE = fileURLToPath(
	new URL("../helpers/host-test-executor.mjs", import.meta.url),
);

let root;
let counter = 0;
const unregister = [];
const instances = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp29-later-")));
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

/** The real bin in a fresh process with the guarded test-executor hook (executor `p.executor`). */
function bin(p, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			cwd: p.cwd,
			env: {
				...p.env,
				AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
				AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
				AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
				AW_HOST_TEST_EFFECT_LOG: join(p.cwd, "effects.jsonl"),
				AW_HOST_TEST_EXECUTOR_ID: p.executor,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
	});
}

async function eventually(check, what, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	assert.fail(`timed out waiting for ${what}`);
}

test("detached run blocked on approval → approved later by a fresh CLI process → completes without relaunching", async () => {
	const p = await project();
	const launched = await bin(p, [
		"run",
		"wf.json",
		"approve me later",
		"--executor",
		p.executor,
		"--detach",
		"--json",
	]);
	assert.equal(launched.code, 0, launched.stderr);
	const { runId, detached } = JSON.parse(launched.stdout).data;
	await eventually(
		() =>
			existsSync(detached.logPath) &&
			readFileSync(detached.logPath, "utf8").includes(`done: ${runId} blocked`),
		"the detached supervisor to block on the approval",
	);
	const waited = await bin(p, ["wait", runId, "--json"]);
	assert.equal(waited.code, 1);
	const blocked = JSON.parse(waited.stdout).data;
	assert.equal(blocked.actionRequired, true);
	assert.equal(blocked.pendingApprovals[0].controllerSpecId, CONTROLLER);
	const text = await bin(p, ["status", runId]);
	assert.match(
		text.stdout,
		new RegExp(
			`Approve: agent-workflow approve ${runId} --request [0-9a-f]{12}`,
		),
	);
	assert.equal(p.submits(), 1);

	// Without a terminal, approve needs an explicit --yes.
	const refused = await bin(p, ["approve", runId]);
	assert.equal(refused.code, 2, refused.stdout + refused.stderr);
	assert.match(refused.stderr, /--yes/);

	const approved = await bin(p, ["approve", runId, "--yes", "--json"]);
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);
	const result = JSON.parse(approved.stdout);
	assert.equal(result.action, "approve");
	assert.equal(result.outcome, "completed");
	assert.equal(result.data.decision, "approved");
	const run = await store.readRunRecord(p.cwd, runId);
	assert.equal(run.status, "completed");
	assert.equal(controllerTask(run).statusDetail, "dynamic_completed");
	assert.equal(await p.controllerRuns(), 1);
	assert.equal(p.submits(), 1, "the completed prep stage is not relaunched");
	const resolved = (await approvalEvents(p.cwd, runId)).filter(
		(event) => event.type === "approval.resolved",
	);
	assert.equal(resolved.length, 1);
	assert.deepEqual(resolved[0].payload.decidedBy, {
		host: "cli",
		via: "approve",
	});
	assert.equal(resolved[0].payload.approvalScope.controllerSpecId, CONTROLLER);
});

/** One in-process CLI call; `answers` script the terminal prompt (undefined: no terminal). */
async function runCli(p, argv, answers) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd: p.cwd,
		env: p.env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: answers !== undefined,
		waitSliceMs: 2_000,
		...(answers === undefined
			? {}
			: { prompt: async () => answers.shift() ?? "" }),
	});
	return { code, out: out.join(""), err: err.join("") };
}

async function blockedRun(p) {
	const launched = await runCli(p, [
		"run",
		"wf.json",
		`blocked ${counter}`,
		"--executor",
		p.executor,
	]);
	const runId = /Run: (workflow_\S+)/.exec(launched.out)[1];
	assert.equal(
		controllerTask(await store.readRunRecord(p.cwd, runId)).statusDetail,
		"dynamic_ui_unavailable",
	);
	return runId;
}

test("CLI approve on a terminal: the question shows the scope; n rejects, nothing pending afterwards", async () => {
	const p = await project();
	const runId = await blockedRun(p);
	const blank = await runCli(p, ["approve", runId], [""]);
	assert.equal(blank.code, 1);
	assert.match(blank.out, /Nothing recorded/);
	const rejected = await runCli(p, ["approve", runId], ["n"]);
	assert.equal(rejected.code, 0, rejected.out + rejected.err);
	assert.match(rejected.err, /requests approval to run dynamic controller/);
	assert.match(
		rejected.out,
		/Rejected dynamic controller adaptive\.controller/,
	);
	assert.equal(
		controllerTask(await store.readRunRecord(p.cwd, runId)).statusDetail,
		"dynamic_approval_rejected",
	);
	const again = await runCli(p, ["approve", runId, "--yes"]);
	assert.equal(again.code, 2);
	assert.match(again.err, /no dynamic controller approval waiting/);
	assert.equal(await p.controllerRuns(), 0);
});

test("CLI approve --reject --yes rejects; an unknown request id is a usage error", async () => {
	const p = await project();
	const runId = await blockedRun(p);
	const unknown = await runCli(p, [
		"approve",
		runId,
		"--request",
		"deadbeefdeadbeef",
		"--yes",
	]);
	assert.equal(unknown.code, 2);
	assert.match(
		unknown.err,
		/no pending approval with request id deadbeefdeadbeef/,
	);
	const rejected = await runCli(p, [
		"approve",
		runId,
		"--reject",
		"--yes",
		"--json",
	]);
	assert.equal(rejected.code, 0);
	assert.equal(JSON.parse(rejected.out).data.decision, "rejected");
});

test("Pi /aw approve asks through ctx.ui.confirm and continues the run; no dialog UI needs --yes", async () => {
	const p = await project();
	const runId = await blockedRun(p);
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env: p.env, feedbackPollMs: 50 })(pi);
	instances.push(pi);
	const headless = fakeCtx(p.cwd, { hasUI: false });
	const writes = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	try {
		await pi.commands.get("aw").handler(`approve ${runId}`, headless);
	} finally {
		process.stderr.write = original;
		process.exitCode = 0;
	}
	assert.match(writes.join(""), /--yes/);
	const ctx = fakeCtx(p.cwd);
	const confirms = [];
	ctx.ui.confirm = async (title, message) => {
		confirms.push({ title, message });
		return true;
	};
	await pi.commands.get("aw").handler(`approve ${runId}`, ctx);
	assert.equal(confirms.length, 1);
	assert.equal(confirms[0].title, "Run dynamic workflow controller?");
	assert.match(confirms[0].message, /adaptive\.controller/);
	await eventually(
		async () =>
			(await store.readRunRecord(p.cwd, runId)).status === "completed",
		"the approved run to complete",
	);
	const resolved = (await approvalEvents(p.cwd, runId)).find(
		(event) => event.type === "approval.resolved",
	);
	assert.deepEqual(resolved.payload.decidedBy, { host: "pi", via: "approve" });
	assert.equal(p.submits(), 1);
	assert.ok(
		ctx.notes.some((note) => /Approved dynamic controller/.test(note.message)),
	);
});

// WP39b (live bundle 5, O10): a run that settles inside the approve call (foreground `/aw approve`,
// board `a`) got no completion message: tracking started only for running/pending results. Now a
// settled result is tracked too and the message is delivered exactly once.
test("Pi /aw approve: a run that settles inside the approve call gets exactly one completion message", async () => {
	const p = await project();
	const runId = await blockedRun(p);
	const history = [];
	const pi = fakePi({ history });
	ext.createAgentWorkflowPiExtension({ env: p.env, feedbackPollMs: 50 })(pi);
	instances.push(pi);
	const ctx = fakeCtx(p.cwd, { history });
	ctx.ui.confirm = async () => true;
	await pi.commands.get("aw").handler(`approve ${runId}`, ctx);
	assert.equal(
		(await store.readRunRecord(p.cwd, runId)).status,
		"completed",
		"settled inside the approve call",
	);
	const completions = () =>
		pi.messages.filter(
			(entry) =>
				entry.message.customType === "agent-workflow-completion" &&
				entry.message.details?.runId === runId,
		);
	await eventually(
		async () => completions().length > 0,
		"the completion message",
		10_000,
	);
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
	assert.equal(completions().length, 1, "exactly once");
	// The same settled state again (board `a` after the command): still once.
	await pi.commands.get("aw").handler(`status ${runId}`, ctx);
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
	assert.equal(completions().length, 1);
});
