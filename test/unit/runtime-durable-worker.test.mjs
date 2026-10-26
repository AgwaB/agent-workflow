// New in agent-workflow (WP2a-2): the executor seam end to end through real durable worker
// processes — fencing trio (revoke before consume, kill after consume, effect without consume),
// happy path with a released V2 barrier, fresh-process rediscovery and its refusals, and
// resubmission of the same attempt. The executor is the SDK fake wrapped by
// test/fixtures/runtime/fake-executor-module.mjs, which logs effects to a file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createDurableLaunchBarrierV2,
	durableWorkerPath,
	getSubagentStatus,
	readRunEvents,
	readRunRecord,
	reconcileSubagentRun,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	runSubagent,
	runtimeWorkerPath,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
	waitForSubagent,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let root;
let counter = 0;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-durable-worker-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

function fresh(label) {
	counter += 1;
	const dir = join(root, `${label}-${counter}`);
	return {
		cwd: dir,
		effectLog: join(root, `${label}-${counter}.effects.jsonl`),
		barrierDir: join(root, `${label}-${counter}.barrier`),
	};
}

async function mkdirp(path) {
	await (await import("node:fs/promises")).mkdir(path, { recursive: true });
}

function attemptDir(cwd, run) {
	return join(
		cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
}

async function waitTerminal(cwd, run, timeoutMs = 20_000) {
	const waited = await waitForSubagent({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs,
		pollIntervalMs: 25,
	});
	assert.equal(waited.status, "completed", JSON.stringify(waited));
	return waited.snapshot;
}

async function waitForTerminalEvents(cwd, run, status, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const events = await readRunEvents({ cwd, runId: run.runId }, Infinity);
		if (
			events.some(
				(event) =>
					event.type === `attempt.${status}` &&
					event.attemptId === run.attemptId,
			) &&
			events.some((event) => event.type === `run.${status}`)
		)
			return events;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`no terminal ${status} events for ${run.runId}`);
}

async function waitFor(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("condition not reached");
}

async function result(cwd, run) {
	return JSON.parse(
		await readFile(join(attemptDir(cwd, run), "result.json"), "utf8"),
	);
}

async function barrier(dir) {
	return await createDurableLaunchBarrierV2({
		directory: dir,
		subjectSha256: sha256(`subject:${dir}`),
		timeoutMs: 20_000,
		pollIntervalMs: 5,
	});
}

async function release(descriptor) {
	const ready = await waitForDurableLaunchBarrierV2Ready(descriptor);
	const resolution = await resolveDurableLaunchBarrierV2Release(
		descriptor,
		ready,
		sha256(`release:${ready.readySha256}`),
	);
	assert.equal(resolution.outcome, "released");
	const ack = await waitForDurableLaunchBarrierV2Ack(
		descriptor,
		resolution.decision,
	);
	return { ready, ack };
}

test("runtime workers are shipped as scripts next to the compiled runtime", async () => {
	for (const worker of ["durable-worker", "terminal-finalizer"])
		assert.ok((await stat(runtimeWorkerPath(worker))).isFile(), worker);
	assert.equal(durableWorkerPath(), runtimeWorkerPath("durable-worker"));
});

test("happy path: barrier release → events → completed result with usage (cost null kept)", async () => {
	const { cwd, effectLog, barrierDir } = fresh("happy");
	await mkdirp(cwd);
	const descriptor = await barrier(barrierDir);
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "Do the fixture thing.",
		systemPrompt: "Be a fixture.",
		model: "fixture-model",
		effort: "low",
		tools: ["read"],
		readOnly: true,
		async: true,
		durableLaunchBarrier: descriptor,
	});
	assert.equal(run.status, "running");
	assert.equal(run.backend, "fixture");
	const { ready, ack } = await release(descriptor);
	const executorRecord = JSON.parse(
		await readFile(join(attemptDir(cwd, run), "executor.json"), "utf8"),
	);
	assert.equal(
		ready.executionPlanSha256,
		executorRecord.executionPlanSha256,
		"READY reports the plan digest the worker prepared before submit",
	);
	assert.equal(
		ready.launchPayloadSha256,
		sha256(await readFile(join(attemptDir(cwd, run), "worker.json"))),
		"READY binds the exact worker.json bytes",
	);
	assert.equal(ack.runId, run.runId);
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "completed", JSON.stringify(snapshot));
	assert.equal(snapshot.failureKind, null);
	const final = await result(cwd, run);
	assert.deepEqual(final.metadata.usage, {
		input: 12,
		output: 8,
		cached: null,
		cost: null,
		source: "unknown",
		events: 2,
	});
	assert.equal(final.metadata.model, "fixture-model");
	assert.equal(final.metadata.sessionId, "fixture-session");
	assert.equal(final.metadata.executor.authority, "released");
	assert.equal(final.metadata.executor.termination, "confirmed");
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
		"fixture final answer",
		"completed output is the final text, not the streamed deltas",
	);
	const execEvents = (
		await readFile(join(attemptDir(cwd, run), "exec-events.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		execEvents.map((event) => event.type),
		[
			"started",
			"message_delta",
			"usage",
			"message_delta",
			"usage",
			"completed",
		],
	);
	const effects = readEffectLog(effectLog);
	const consume = effects.find((entry) => entry.type === "consume");
	assert.equal(consume.outcome, "released");
	assert.equal(
		consume.bindingSchema,
		"pi-subagent-durable-worker-binding-v2",
		"the adapter sees the installed worker binding after release",
	);
	const submit = effects.find((entry) => entry.type === "submit");
	assert.equal(submit.prompt, "Do the fixture thing.");
	assert.equal(submit.artifactsDir, attemptDir(cwd, run));
	assert.deepEqual(
		effects.filter((entry) => entry.type === "effect"),
		[
			{
				type: "effect",
				attemptKey: `${run.runId}:${run.attemptId}`,
				authorized: true,
				pid: effects.find((entry) => entry.type === "effect").pid,
				at: effects.find((entry) => entry.type === "effect").at,
			},
		],
	);
	assert.notEqual(effects[0].pid, process.pid, "the effect ran in the worker");
	const authorityRecord = JSON.parse(
		await readFile(join(attemptDir(cwd, run), "authority.json"), "utf8"),
	);
	assert.equal(authorityRecord.phase, "released");
	assert.equal(authorityRecord.grantId, ack.decisionSha256);
	await waitForTerminalEvents(cwd, run, "completed");
	const record = await readRunRecord({ cwd, runId: run.runId });
	assert.equal(record.activeAttemptId, null);
	assert.equal(record.status, "completed");

	// Resubmitting the same attempt: a second worker for the terminal attempt exits without
	// touching it, and the executor sees no second submit or effect.
	const resultBefore = await readFile(
		join(attemptDir(cwd, run), "result.json"),
		"utf8",
	);
	const again = spawn(
		process.execPath,
		[durableWorkerPath(), join(attemptDir(cwd, run), "worker.json")],
		{ cwd, stdio: "ignore", detached: process.platform !== "win32" },
	);
	const [code] = await once(again, "exit");
	assert.equal(code, 1);
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "result.json"), "utf8"),
		resultBefore,
	);
	assert.equal(
		readEffectLog(effectLog).filter((entry) => entry.type === "submit").length,
		1,
	);
});

test("fencing (a): engine revokes before consume → no effect, terminal cancelled", async () => {
	const { cwd, effectLog, barrierDir } = fresh("revoke");
	await mkdirp(cwd);
	const descriptor = await barrier(barrierDir);
	const revoked = await revokeDurableLaunchBarrierV2(descriptor, {
		cancellationId: "stop-before-launch",
		reasonSha256: sha256("workflow stopped"),
	});
	assert.equal(revoked.outcome, "revoked");
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "must never run",
		async: true,
		durableLaunchBarrier: descriptor,
	});
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "cancelled", JSON.stringify(snapshot));
	// WP2c: an engine revoke is "revoked", not a user interrupt.
	assert.equal(snapshot.failureKind, "revoked");
	const effects = readEffectLog(effectLog);
	assert.deepEqual(
		effects.map((entry) => [entry.type, entry.outcome]),
		[
			["submit", undefined],
			["consume", "revoked"],
		],
		"the adapter consumed, saw revoked, and produced no effect",
	);
	assert.match(
		await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
		/revoked/u,
	);
	const authorityRecord = JSON.parse(
		await readFile(join(attemptDir(cwd, run), "authority.json"), "utf8"),
	);
	assert.equal(authorityRecord.phase, "revoked");
});

test("fencing (b): worker killed after consume → reconcile asks the executor → unknown → needs decision, no relaunch", async () => {
	const { cwd, effectLog, barrierDir } = fresh("killed");
	await mkdirp(cwd);
	const descriptor = await barrier(barrierDir);
	// Keep heartbeats out of the kill window so the test stays about executor reconcile. (Since
	// WP2c a lock left by a SIGKILLed holder is stolen; see runtime-dir-lock-owner.test.mjs.)
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "600000";
	let run;
	try {
		run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog, mode: "hang-after-effect" }),
			task: "effect then hang",
			async: true,
			durableLaunchBarrier: descriptor,
		});
	} finally {
		process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
	}
	await release(descriptor);
	await waitFor(() =>
		readEffectLog(effectLog).some((entry) => entry.type === "effect"),
	);
	const status = await getSubagentStatus({ cwd, runId: run.runId });
	const workerPid = status.attempts[0].workerPid;
	assert.equal(typeof workerPid, "number");
	process.kill(
		process.platform === "win32" ? workerPid : -workerPid,
		"SIGKILL",
	);
	await waitFor(() => {
		try {
			process.kill(workerPid, 0);
			return false;
		} catch {
			return true;
		}
	});
	const reconciled = await reconcileSubagentRun({
		cwd,
		runId: run.runId,
		staleAfterMs: 1,
	});
	assert.equal(
		reconciled.status,
		"marked-needs-decision",
		JSON.stringify(reconciled),
	);
	assert.equal(reconciled.executorReconcile.outcome, "unknown");
	assert.equal(reconciled.record.status, "failed");
	assert.equal(reconciled.record.failureKind, "needs_decision");
	const final = await result(cwd, run);
	assert.equal(final.failureKind, "needs_decision");
	assert.equal(final.metadata.executor.reconcile, "unknown");
	assert.match(
		await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
		/owner decision/u,
	);
	const events = await readRunEvents({ cwd, runId: run.runId }, Infinity);
	assert.ok(
		events.some((event) => event.type === "reconcile.executor_outcome"),
	);
	// Reconciling again is stable and never relaunches.
	const second = await reconcileSubagentRun({
		cwd,
		runId: run.runId,
		staleAfterMs: 1,
	});
	assert.equal(second.status, "already-terminal");
	const effects = readEffectLog(effectLog);
	assert.equal(effects.filter((entry) => entry.type === "submit").length, 1);
	assert.equal(effects.filter((entry) => entry.type === "effect").length, 1);
	assert.equal(
		effects.filter((entry) => entry.type === "reconcile").length,
		1,
		"the executor was asked exactly once",
	);
});

test("fencing (c): an adapter that launches without consuming → guard_failure, cancel(owned), effect logged unauthorized", async () => {
	const { cwd, effectLog } = fresh("unfenced");
	await mkdirp(cwd);
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({
			effectLog,
			mode: "skip-consume",
			stepDelayMs: 50,
		}),
		task: "misbehave",
		async: true,
	});
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "failed", JSON.stringify(snapshot));
	assert.equal(snapshot.failureKind, "guard_failure");
	const final = await result(cwd, run);
	assert.match(
		final.metadata.executor.fenceViolation,
		/while the execution authority was unconsumed/u,
	);
	assert.equal(final.metadata.executor.authority, "unconsumed");
	assert.equal(final.metadata.executor.cancelResult, "cancelled");
	const effects = readEffectLog(effectLog);
	assert.equal(
		effects.some((entry) => entry.type === "consume"),
		false,
	);
	assert.deepEqual(
		effects
			.filter((entry) => entry.type === "effect")
			.map((entry) => entry.authorized),
		[false],
	);
	assert.deepEqual(
		effects
			.filter((entry) => entry.type === "cancel")
			.map((entry) => entry.scope),
		["owned"],
	);
	assert.match(
		await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
		/fence violation/u,
	);
	await waitForTerminalEvents(cwd, run, "failed");
});

for (const [label, overrides, config, pattern] of [
	[
		"wrong id",
		{ id: "fixture" },
		{ id: "impostor" },
		/built executor impostor, expected fixture/u,
	],
	[
		"version mismatch",
		{ version: "0.1.0" },
		{ version: "0.2.0" },
		/not compatible with recorded 0\.1\.0/u,
	],
	[
		"missing module",
		{ module: "/nonexistent/agent-workflow-missing-executor.mjs" },
		{},
		/cannot load executor module/u,
	],
]) {
	test(`fresh-process rediscovery refuses a ${label} before any effect`, async () => {
		const { cwd, effectLog } = fresh(
			`rediscovery-${label.replace(/ /gu, "-")}`,
		);
		await mkdirp(cwd);
		const descriptor = fixtureDescriptor({ effectLog, ...config }, overrides);
		const run = await runSubagent({
			cwd,
			executor: descriptor,
			task: "never",
			async: true,
		});
		const snapshot = await waitTerminal(cwd, run);
		assert.equal(snapshot.status, "failed", JSON.stringify(snapshot));
		assert.equal(snapshot.failureKind, "guard_failure");
		assert.match(
			await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
			pattern,
		);
		assert.deepEqual(
			readEffectLog(effectLog),
			[],
			"no submit, consume or effect",
		);
		await waitForTerminalEvents(cwd, run, "failed");
	});
}

test("interrupt: SIGTERM mid-run → cancel(owned) → terminal cancelled/user_cancelled with partial output", async () => {
	const { cwd, effectLog } = fresh("interrupt");
	await mkdirp(cwd);
	const { interruptSubagent } = await import("../../dist/runtime/index.js");
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog, stepDelayMs: 1000 }),
		task: "slow",
		async: true,
	});
	await waitFor(async () => {
		try {
			return (
				await readFile(join(attemptDir(cwd, run), "exec-events.jsonl"), "utf8")
			).includes("message_delta");
		} catch {
			return false;
		}
	});
	const interrupted = await interruptSubagent({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		reason: "test cancellation",
		escalateAfterMs: 5_000,
		killAfterMs: 10_000,
	});
	assert.equal(
		interrupted.status,
		"interrupt-requested",
		JSON.stringify(interrupted),
	);
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "cancelled", JSON.stringify(snapshot));
	assert.equal(snapshot.failureKind, "user_cancelled");
	const final = await result(cwd, run);
	assert.equal(final.metadata.outputPartial, true);
	assert.equal(final.metadata.executor.cancelResult, "cancelled");
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
		"fixture ",
	);
	const events = await waitForTerminalEvents(cwd, run, "cancelled");
	assert.equal(
		events.some((event) => event.type === "attempt.stale_result_ignored"),
		false,
	);
	assert.deepEqual(
		readEffectLog(effectLog)
			.filter((entry) => entry.type === "cancel")
			.map((entry) => entry.scope),
		["owned"],
	);
});
