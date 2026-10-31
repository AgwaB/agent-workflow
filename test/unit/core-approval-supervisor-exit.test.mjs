// 2026-10-31: a run that blocks on a dynamic-controller approval is answered right after the block
// notice, while its supervisor may still hold the run lease as it shuts down (seconds on a busy
// machine). Recording the decision and resuming the run wait for that supervisor (bounded) instead
// of failing at once with "another supervisor …; try again"; a live lease is never taken.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	approvalEvents,
	approvalProject,
	controllerTask,
} from "../helpers/dynamic-approval-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const approvals = await import("../../dist/core/dynamic-approval.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-approval-exit-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	store.setSupervisorExitLeaseWaitForTests(undefined);
	engine.setResumeAfterStopLeaseWaitForTests(undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A run blocked on its controller approval (no approval UI), its supervisor gone. */
async function blockedRun() {
	counter += 1;
	const p = await approvalProject(root, `p${counter}`, (descriptor) =>
		unregister.push(core.registerWorkflowExecutor(descriptor)),
	);
	const started = await engine.runWorkflowSpec(join(p.cwd, "wf.json"), p.cwd, {
		task: "approve after exit",
		executor: p.executor,
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "blocked");
	const [pending] = await approvals.pendingDynamicApprovals(p.cwd, run);
	assert.ok(pending, "an approval is pending");
	await waitForLeaseFree(p.cwd, run.runId);
	return { ...p, runId: run.runId, requestId: pending.requestId };
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

/**
 * Hold the run lease for `ms` (a live owner, like the blocked run's supervisor shutting down). The
 * run's own supervisor may still take the lease for a last write, so acquiring retries until free.
 */
async function holdLease(cwd, runId, ms) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		let acquired;
		const ready = new Promise((resolve) => {
			acquired = resolve;
		});
		const held = store.withRunLease(cwd, runId, async () => {
			acquired(true);
			await new Promise((resolve) => setTimeout(resolve, ms));
			return true;
		});
		if ((await Promise.race([ready, held])) === true) return held;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`could not take the lease of ${runId}`);
}

const resolvedCount = async (cwd, runId) =>
	(await approvalEvents(cwd, runId)).filter(
		(event) => event.type === "approval.resolved",
	).length;

test("an approval answered while the blocked run's supervisor still holds the lease waits for it", async () => {
	store.setSupervisorExitLeaseWaitForTests({ timeoutMs: 10_000, pollMs: 50 });
	const { cwd, runId, requestId } = await blockedRun();
	const held = holdLease(cwd, runId, 800);
	const startedAt = Date.now();
	const recorded = await approvals.recordDynamicApprovalDecision(cwd, runId, {
		requestId,
		approved: false,
		decidedBy: { host: "cli", via: "approve" },
	});
	const waited = Date.now() - startedAt;
	assert.equal(await held, true, "the lease holder finished its own work");
	assert.ok(waited >= 500, `the decision waited ${waited} ms for the lease`);
	assert.equal(recorded.approval.requestId, requestId);
	assert.equal(await resolvedCount(cwd, runId), 1);
	const run = await store.readRunRecord(cwd, runId);
	assert.equal(controllerTask(run).statusDetail, "dynamic_approval_rejected");
});

test("the wait is bounded: a lease held past it is refused, nothing is recorded", async () => {
	store.setSupervisorExitLeaseWaitForTests({ timeoutMs: 300, pollMs: 50 });
	const { cwd, runId, requestId } = await blockedRun();
	const held = holdLease(cwd, runId, 2_000);
	const startedAt = Date.now();
	await assert.rejects(
		approvals.recordDynamicApprovalDecision(cwd, runId, {
			requestId,
			approved: true,
			decidedBy: { host: "cli", via: "approve" },
		}),
		/another supervisor is driving the run; try again in a few seconds/u,
	);
	assert.ok(Date.now() - startedAt < 1_500, "refused at the bound");
	assert.equal(await held, true, "the live lease was never taken");
	assert.equal(await resolvedCount(cwd, runId), 0);
});

test("resume of a run blocked on an approval waits for its exiting supervisor (other blocked runs do not: core-wp37)", async () => {
	engine.setResumeAfterStopLeaseWaitForTests({ timeoutMs: 10_000, pollMs: 50 });
	const { cwd, runId } = await blockedRun();
	const held = holdLease(cwd, runId, 800);
	const startedAt = Date.now();
	// No approval UI: resume asks nothing and the run stays blocked on the approval, but it got
	// the lease instead of "another supervisor may be active".
	const resumed = await engine.resumeRun(cwd, runId);
	const waited = Date.now() - startedAt;
	assert.equal(await held, true);
	assert.ok(waited >= 500, `resume waited ${waited} ms for the lease`);
	assert.equal(resumed.run.status, "blocked");
	assert.equal(await resolvedCount(cwd, runId), 0);
});

test("resume right after the approval was recorded waits for the supervisor's last lease too (approve → resume)", async () => {
	engine.setResumeAfterStopLeaseWaitForTests({ timeoutMs: 10_000, pollMs: 50 });
	const { cwd, runId, requestId, controllerRuns } = await blockedRun();
	await approvals.recordDynamicApprovalDecision(cwd, runId, {
		requestId,
		approved: true,
		decidedBy: { host: "cli", via: "approve" },
	});
	// Answered, not resumed: the run is still blocked on that approval (nothing pending now).
	const answered = await store.readRunRecord(cwd, runId);
	assert.deepEqual(await approvals.pendingDynamicApprovals(cwd, answered), []);
	assert.equal(approvals.runBlockedOnDynamicApproval(answered), true);
	const held = holdLease(cwd, runId, 800);
	const startedAt = Date.now();
	await engine.resumeRun(cwd, runId);
	assert.ok(Date.now() - startedAt >= 500, "resume waited for the lease");
	assert.equal(await held, true);
	assert.equal(
		(await engine.waitForRun(cwd, runId, 60_000)).status,
		"completed",
	);
	assert.equal(await controllerRuns(), 1);
});

test("an approve and a reject sent at once record exactly one decision; the other is told nothing is waiting", async () => {
	store.setSupervisorExitLeaseWaitForTests({ timeoutMs: 10_000, pollMs: 50 });
	const { cwd, runId, requestId } = await blockedRun();
	const decide = (approved) =>
		approvals
			.recordDynamicApprovalDecision(cwd, runId, {
				requestId,
				approved,
				decidedBy: { host: "cli", via: "approve" },
			})
			.then(
				() => "recorded",
				(error) => error.message,
			);
	const outcomes = await Promise.all([
		decide(true),
		decide(false),
		decide(true),
	]);
	assert.equal(outcomes.filter((outcome) => outcome === "recorded").length, 1);
	for (const outcome of outcomes.filter((entry) => entry !== "recorded"))
		assert.match(outcome, /has no dynamic controller approval waiting/);
	assert.equal(await resolvedCount(cwd, runId), 1);
});

test("a request id prefix shorter than 8 characters says so (not 'no pending approval')", async () => {
	const { cwd, runId, requestId } = await blockedRun();
	await assert.rejects(
		approvals.recordDynamicApprovalDecision(cwd, runId, {
			requestId: requestId.slice(0, 4),
			approved: true,
			decidedBy: { host: "cli", via: "approve" },
		}),
		/is too short: use at least 8 characters of it/,
	);
	assert.equal(await resolvedCount(cwd, runId), 0);
});
