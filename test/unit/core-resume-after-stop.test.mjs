// test-tier: integration
// New in agent-workflow (WP37 item 2, parity §3.2 "resume right after stop"): an attached
// (in-process) supervisor can still hold the run's supervisor lease for a moment after `stop` has
// interrupted the run. `resume` then waits a bounded time for the lease instead of refusing at once,
// and refuses with an actionable message (run id, "try again in a few seconds") when the lease is not
// released in time. It never takes a live lease (B3): the lease here is held by a live owner.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp37-resume-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	engine.setResumeAfterStopLeaseWaitForTests(undefined);
	for (const undo of unregister.splice(0)) undo();
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function project(config = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const specPath = join(cwd, "spec.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: `wp37-resume-${counter}`,
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const id = `wp37-resume-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
				...config,
			}),
		),
	);
	return { cwd, specPath, id };
}

/** A run interrupted by `stop` whose own supervisor has let go of the lease. */
async function stoppedRun() {
	const { cwd, specPath, id } = await project({ stepDelayMs: 1_500 });
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "slow",
		executor: id,
	});
	const stopped = await engine.stopRun(cwd, started.runId);
	assert.equal(stopped.run.status, "interrupted");
	await waitForLeaseFree(cwd, started.runId);
	return { cwd, runId: started.runId };
}

async function waitForLeaseFree(cwd, runId) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if ((await store.withRunLease(cwd, runId, async () => true)) === true)
			return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`lease of ${runId} was never released`);
}

/** Holds the run lease (a live owner, like the stopped supervisor shutting down) for `ms`. */
/** Holds the run lease until `release()` (2026-11-10: not for a fixed time); `held` resolves true after it. */
async function holdLease(cwd, runId) {
	let acquired;
	const ready = new Promise((resolve) => {
		acquired = resolve;
	});
	let release;
	const released = new Promise((resolve) => {
		release = resolve;
	});
	const held = store.withRunLease(cwd, runId, async () => {
		acquired(true);
		await released;
		return true;
	});
	assert.equal(await Promise.race([ready, held]), true);
	return { held, release };
}

test("resume right after stop waits for the stopped supervisor's lease, then resumes", async () => {
	// The holder lets go once resume is waiting for it (the deadline only guards a hang).
	let polls = 0;
	let lease;
	engine.setResumeAfterStopLeaseWaitForTests({
		timeoutMs: 60_000,
		pollMs: 50,
		onPoll: () => {
			polls += 1;
			lease?.release();
		},
	});
	const { cwd, runId } = await stoppedRun();
	lease = await holdLease(cwd, runId);
	const resumed = await engine.resumeRun(cwd, runId);
	assert.equal(
		await lease.held,
		true,
		"the lease holder finished its own work",
	);
	assert.ok(polls >= 1, "resume waited for the lease");
	assert.ok(resumed.resetTaskIds.length >= 1);
	assert.notEqual(resumed.run.status, "interrupted");
	const run = await engine.waitForRun(cwd, runId, 60_000);
	assert.equal(run.status, "completed");
});

test("resume after stop refuses with an actionable message when the lease is not released in time", async () => {
	let polls = 0;
	engine.setResumeAfterStopLeaseWaitForTests({
		timeoutMs: 300,
		pollMs: 50,
		onPoll: () => {
			polls += 1;
		},
	});
	const { cwd, runId } = await stoppedRun();
	const lease = await holdLease(cwd, runId);
	await assert.rejects(engine.resumeRun(cwd, runId), (error) => {
		assert.equal(
			error.message,
			`Cannot resume ${runId} yet: the previous supervisor is still shutting down; try again in a few seconds`,
		);
		return true;
	});
	assert.ok(polls >= 1, "resume waited for the lease before it refused");
	// The live lease was never taken: its holder finishes normally, and the run is unchanged.
	lease.release();
	assert.equal(await lease.held, true);
	const run = await store.readRunRecord(cwd, runId);
	assert.equal(run.status, "interrupted");
	// Once the lease is free, the same resume goes through.
	const resumed = await engine.resumeRun(cwd, runId);
	assert.ok(resumed.resetTaskIds.length >= 1);
	assert.equal(
		(await engine.waitForRun(cwd, runId, 60_000)).status,
		"completed",
	);
});

test("a held lease on a run that was not stopped is refused at once (no wait)", async () => {
	let polls = 0;
	engine.setResumeAfterStopLeaseWaitForTests({
		timeoutMs: 5_000,
		pollMs: 50,
		onPoll: () => {
			polls += 1;
		},
	});
	const { cwd, specPath, id } = await project({ mode: "crash-after-consume" });
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "crash after consume",
		executor: id,
	});
	const blocked = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(blocked.status, "blocked");
	await waitForLeaseFree(cwd, started.runId);
	const lease = await holdLease(cwd, started.runId);
	await assert.rejects(
		engine.resumeRun(cwd, started.runId),
		/Could not acquire supervisor lease for .*; another supervisor may be active/u,
	);
	// 2026-11-10: counted, not timed (was "< 1.5 s").
	assert.equal(polls, 0, "refused without waiting for the lease");
	lease.release();
	assert.equal(await lease.held, true);
});

// agent-workflow 2026-11-04 (live: a stopped blocked run stayed blocked under "Needs you"): stop
// abandons a blocked run — its blocked task is interrupted and the run leaves the blocked state.
test("stop abandons a blocked run: the blocked task is interrupted and the run is no longer blocked", async () => {
	const { cwd, specPath, id } = await project({ mode: "crash-after-consume" });
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "crash after consume, then stop",
		executor: id,
	});
	const blocked = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(blocked.status, "blocked");
	const blockedTaskIds = blocked.tasks
		.filter((task) => task.status === "blocked")
		.map((task) => task.taskId);
	assert.ok(blockedTaskIds.length > 0);
	await waitForLeaseFree(cwd, started.runId);
	const stopped = await engine.stopRun(cwd, started.runId);
	assert.deepEqual(
		stopped.interruptedTaskIds.sort(),
		[...blockedTaskIds].sort(),
	);
	const run = await store.readRunRecord(cwd, started.runId);
	assert.equal(run.status, "interrupted");
	for (const taskId of blockedTaskIds) {
		const task = run.tasks.find((candidate) => candidate.taskId === taskId);
		assert.deepEqual(
			[task.status, task.statusDetail],
			["interrupted", "workflow_stopped"],
		);
	}
});
