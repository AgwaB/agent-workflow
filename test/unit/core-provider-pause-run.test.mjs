// test-tier: integration
// Provider pause, whole runs: workflows run through the real engine → task runner → durable worker
// → fixture executor scripted to fail with provider overload (test/helpers/workflow-executor-fixture.mjs
// `failures`). The pause timing is shortened (test hook) so a run needs seconds, not minutes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const pause = await import("../../dist/core/provider-pause.js");

const OVERLOAD = {
	class: "transient",
	message: "HTTP 503 The model is overloaded.",
};
const KEY = "ovl";
let root;
const unregister = [];
const restoreEnv = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-pause-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	for (const undo of restoreEnv.splice(0)) undo();
	pause.setProviderPauseTimingForTests(undefined);
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function setEnv(name, value) {
	const previous = process.env[name];
	process.env[name] = value;
	restoreEnv.push(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

async function scenario(name, { cap, failures, tasks = 3 }) {
	setEnv(pause.PROVIDER_PAUSE_MAX_MINUTES_ENV, cap);
	// 1 "minute" = 1 s here, so the 120-minute default cap is two real minutes and cap=3 is 3 s.
	pause.setProviderPauseTimingForTests({
		baseWaitMs: 1500,
		maxWaitMs: 6000,
		minLeaseMs: 500,
		failureWindowMs: 120_000,
		minuteMs: 1000,
	});
	await pause.removeProviderPauseStateForTests();
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read and report.\n",
	);
	const effectLog = join(root, `${name}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id: `wf-${name}`, effectLog, failures }),
		),
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: `pause-${name}`,
			defaults: {
				agent: "reader",
				readOnly: true,
				tools: ["read"],
				model: `${KEY}/model-1`,
			},
			artifactGraph: {
				stages: Array.from({ length: tasks }, (_, i) => ({
					id: `s${i + 1}`,
					type: "single",
					prompt: `Work ${i + 1}.`,
				})),
			},
		}),
	);
	return { cwd, specPath, effectLog, executor: `wf-${name}` };
}

const stateFile = () =>
	join(process.env.AGENT_WORKFLOW_HOME, "provider-pause.json");

/** Samples the persisted pause state while a run is in flight (the state is gone once closed). */
function sampleState() {
	const seen = [];
	const timer = setInterval(() => {
		try {
			const state = JSON.parse(readFileSync(stateFile(), "utf8"))[KEY];
			if (state) seen.push({ at: Date.now(), ...state });
		} catch {
			// not written yet / being replaced
		}
	}, 20);
	return { seen, stop: () => clearInterval(timer) };
}

test("overload opens the pause, the probe succeeds, everything resumes and the run completes", async () => {
	const { cwd, specPath, effectLog, executor } = await scenario("complete", {
		cap: "120",
		// every task's first attempt hits the overload
		failures: { "*": [OVERLOAD] },
	});
	const sampler = sampleState();
	let run;
	try {
		const started = await engine.runWorkflowSpec(specPath, cwd, {
			task: "overloaded provider",
			executor,
		});
		run = await engine.waitForRun(cwd, started.runId, 120_000);
	} finally {
		sampler.stop();
	}
	assert.equal(
		run.status,
		"completed",
		JSON.stringify(run.tasks.map((t) => [t.status, t.lastMessage])),
	);
	// Three failures: two spent a retry attempt (before the pause), the third opened it and was
	// refunded. A refund still moves `attempts` (new attempt identity) but raises the budget with it.
	const refunds = run.tasks.map((task) => task.providerPauseRefunds ?? 0);
	const spent = run.tasks.map(
		(task, i) => (task.launchRetry?.attempts ?? 0) - refunds[i],
	);
	assert.equal(
		spent.reduce((a, b) => a + b, 0),
		2,
		JSON.stringify(spent),
	);
	assert.equal(
		refunds.reduce((a, b) => a + b, 0),
		1,
		JSON.stringify(refunds),
	);
	for (const task of run.tasks)
		assert.equal(
			task.launchRetry.maxAttempts - task.launchRetry.attempts,
			5 - (task.launchRetry.attempts - (task.providerPauseRefunds ?? 0)),
		);
	assert.equal(run.providerPause[KEY].opens, 1);
	assert.ok(run.providerPause[KEY].pausedMs >= 500, "paused time is recorded");
	assert.equal(run.providerPause[KEY].pausedSince, undefined, "resumed");
	assert.equal(run.providerPause[KEY].capReached, undefined);
	assert.deepEqual(
		JSON.parse(readFileSync(stateFile(), "utf8")),
		{},
		"probe success closed the pause",
	);
	// The refunded task did not relaunch before the pause ended.
	const opened = sampler.seen.find((state) => state.openUntilMs !== undefined);
	assert.ok(opened, "the pause was observed open");
	const refundedTask = run.tasks.find(
		(task) => (task.providerPauseRefunds ?? 0) > 0,
	);
	const submits = readFixtureLog(effectLog).filter(
		(entry) =>
			entry.type === "submit" &&
			entry.attemptKey.includes(`:${refundedTask.taskId}:`),
	);
	assert.equal(submits.length, 2);
	assert.ok(
		submits[1].at >= opened.openUntilMs,
		`relaunch at ${submits[1].at} before openUntil ${opened.openUntilMs}`,
	);
	// 3 tasks × 2 submits: nothing else was launched.
	assert.equal(
		readFixtureLog(effectLog).filter((e) => e.type === "submit").length,
		6,
	);
});

test("cap reached: the run stops waiting and tasks fail by the old exhaustion", async () => {
	const { cwd, specPath, executor } = await scenario("capped", {
		cap: "3",
		failures: { "*": Array.from({ length: 12 }, () => OVERLOAD) },
	});
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "always overloaded",
		executor,
	});
	const run = await engine.waitForRun(cwd, started.runId, 180_000);
	assert.equal(run.status, "failed");
	assert.equal(run.providerPause[KEY].capReached, true);
	assert.ok(
		run.providerPause[KEY].pausedMs >= 3000,
		"the whole allowance was paused",
	);
	// Fail-fast skips the siblings of the first task to give up; that task used all its retries.
	const failed = run.tasks.filter((task) => task.status === "failed");
	assert.ok(failed.length >= 1);
	for (const task of failed) {
		assert.match(task.launchRetry.reason, /_exhausted$/);
		assert.equal(
			task.launchRetry.attempts - (task.providerPauseRefunds ?? 0),
			6,
			"5 retries counted as today",
		);
	}
});

test("off switch: with the cap at 0 the same overload exhausts tasks exactly as before", async () => {
	const { cwd, specPath, executor } = await scenario("off", {
		cap: "0",
		failures: { "*": Array.from({ length: 12 }, () => OVERLOAD) },
	});
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "always overloaded",
		executor,
	});
	const run = await engine.waitForRun(cwd, started.runId, 180_000);
	assert.equal(run.status, "failed");
	assert.equal(run.providerPause, undefined);
	assert.equal(existsSync(stateFile()), false);
	const failed = run.tasks.filter((task) => task.status === "failed");
	assert.ok(failed.length >= 1);
	for (const task of failed) {
		assert.equal(task.providerPauseRefunds, undefined);
		assert.match(task.launchRetry.reason, /_exhausted$/);
		assert.equal(task.launchRetry.attempts, 6);
	}
});

test("a mid-stream failure (not overload) is retried as before and never opens the pause", async () => {
	const { cwd, specPath, executor } = await scenario("socket", {
		cap: "120",
		failures: {
			"*": [
				{
					class: "transient",
					message: "socket hang up (ECONNRESET) mid-stream",
				},
			],
		},
	});
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "flaky stream",
		executor,
	});
	const run = await engine.waitForRun(cwd, started.runId, 120_000);
	assert.equal(run.status, "completed");
	assert.deepEqual(
		run.tasks.map((task) => task.launchRetry?.attempts),
		[1, 1, 1],
		"each failure spent its attempt",
	);
	assert.equal(run.providerPause, undefined);
	assert.equal(existsSync(stateFile()), false);
});
