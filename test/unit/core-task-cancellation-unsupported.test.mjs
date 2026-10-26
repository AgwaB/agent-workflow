// Regression: an interrupt that finds no live process (`unsupported`) is acknowledged only when
// the exact attempt reaches a terminal state; otherwise it still fails. Found as an intermittent
// failure of the WP4c-1 "stop during stage 1" smoke test after WP2b made interrupt skip dead
// cached targets: the revoked worker was already exiting, so there was nothing to signal.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import { interruptSubagentTask } from "../../dist/core/task-cancellation.js";

const handle = {
	engine: "agent-workflow",
	backend: "runtime",
	runId: "run_test_1",
	attemptId: "attempt_test_1",
	cwd: "/tmp/aw-cancel-test",
	runsDir: ".agent-workflow/runs",
};
const task = { taskId: "task-1", specId: "s1", backendHandle: handle };

function fakeApi({ interrupt, statuses }) {
	let polls = 0;
	return {
		async interruptSubagent() {
			return interrupt;
		},
		async getSubagentStatus() {
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
	const ack = await interruptSubagentTask(task, "workflow stopped");
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
		interruptSubagentTask(task, "workflow stopped"),
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
		}),
	);
	await assert.rejects(
		interruptSubagentTask(task, "workflow stopped"),
		/not acknowledged.*unsupported/u,
	);
});
