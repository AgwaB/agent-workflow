// Regression: an interrupt that finds no live process (`unsupported`) is acknowledged only when
// the exact attempt reaches a terminal state; otherwise it still fails. Found as an intermittent
// failure of the WP4c-1 "stop during stage 1" smoke test after WP2b made interrupt skip dead
// cached targets: the revoked worker was already exiting, so there was nothing to signal.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import { interruptWorkerTask } from "../../dist/core/task-cancellation.js";

const handle = {
	runId: "run_test_1",
	attemptId: "attempt_test_1",
	cwd: "/tmp/aw-cancel-test",
	runsDir: ".agent-workflow/runs",
};
const task = { taskId: "task-1", specId: "s1", workerHandle: handle };

function fakeApi({ interrupt, statuses, reconcile }) {
	let polls = 0;
	return {
		...(reconcile ? { reconcileWorkerRun: reconcile } : {}),
		async interruptWorker() {
			return interrupt;
		},
		async getWorkerStatus() {
			const status = statuses[Math.min(polls, statuses.length - 1)];
			polls += 1;
			return {
				runId: handle.runId,
				attempts: [{ attemptId: handle.attemptId, status }],
			};
		},
	};
}

afterEach(() => setTaskRuntimeApiForTests(undefined));

test("stop reconciles only the exact attempt before reading its status", async () => {
	const statuses = ["running"];
	let reconciles = 0;
	setTaskRuntimeApiForTests(
		fakeApi({
			interrupt: {
				status: "interrupt-requested",
				runId: handle.runId,
				interruptedAttempts: [handle.attemptId],
				unsupportedAttempts: [],
			},
			statuses,
			async reconcile(options) {
				assert.deepEqual(options, {
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
					expectedAttemptId: handle.attemptId,
				});
				reconciles += 1;
				statuses[0] = "cancelled";
				return { status: "committed-result" };
			},
		}),
	);
	const ack = await interruptWorkerTask(task, "workflow stopped");
	assert.equal(ack.status, "cancelled");
	assert.equal(reconciles, 1);
});

test("stop does not ignore reconciliation failure", async () => {
	setTaskRuntimeApiForTests(
		fakeApi({
			interrupt: {
				status: "interrupt-requested",
				runId: handle.runId,
				interruptedAttempts: [handle.attemptId],
				unsupportedAttempts: [],
			},
			statuses: ["running"],
			async reconcile() {
				throw new Error("ownership inspection failed");
			},
		}),
	);
	await assert.rejects(
		interruptWorkerTask(task, "workflow stopped"),
		/ownership inspection failed/u,
	);
});

test("unsupported interrupt is acknowledged once the exact attempt is terminal", async () => {
	setTaskRuntimeApiForTests(
		fakeApi({
			interrupt: {
				status: "unsupported",
				runId: handle.runId,
				interruptedAttempts: [],
				unsupportedAttempts: [handle.attemptId],
			},
			statuses: ["running", "cancelled"],
		}),
	);
	const ack = await interruptWorkerTask(task, "workflow stopped");
	assert.equal(ack.status, "cancelled");
	assert.equal(ack.interruptStatus, "unsupported");
});

test("unsupported interrupt for a different attempt is rejected", async () => {
	setTaskRuntimeApiForTests(
		fakeApi({
			interrupt: {
				status: "unsupported",
				runId: handle.runId,
				interruptedAttempts: [],
				unsupportedAttempts: ["attempt_other"],
			},
			statuses: ["cancelled"],
		}),
	);
	await assert.rejects(
		interruptWorkerTask(task, "workflow stopped"),
		/different attempt/u,
	);
});

test("unsupported interrupt whose attempt never terminates still fails", async () => {
	setTaskRuntimeApiForTests(
		fakeApi({
			interrupt: {
				status: "unsupported",
				runId: handle.runId,
				interruptedAttempts: [],
				unsupportedAttempts: [handle.attemptId],
			},
			statuses: ["running"],
			// Neither a reconcile label nor a different terminal attempt proves this stop.
			reconcile: async () => ({
				status: "committed-result",
				record: {
					attempts: [{ attemptId: "attempt_other", status: "cancelled" }],
				},
			}),
		}),
	);
	await assert.rejects(
		interruptWorkerTask(task, "workflow stopped"),
		/not acknowledged.*unsupported/u,
	);
});
