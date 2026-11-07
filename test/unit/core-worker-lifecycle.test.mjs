import assert from "node:assert/strict";
import test from "node:test";

import { markFailFastCancellations } from "../../dist/core/engine-run-graph.js";
import { awaitWorkerOperation } from "../../dist/core/launch-operations.js";
import {
	cleanupWorkerRun,
	interruptWorkerTask,
} from "../../dist/core/task-cancellation.js";
import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";

function workerHandle() {
	return {
		runId: "child-run",
		attemptId: "child-attempt",
		cwd: "/tmp/project",
		runsDir: ".agent-workflow/runs",
		display: "child-run/child-attempt",
	};
}

function runningTask(overrides = {}) {
	return {
		taskId: "task-running",
		specId: "running",
		status: "running",
		statusDetail: "running",
		workerHandle: workerHandle(),
		...overrides,
	};
}

test("WB-004 bounds a never-settling worker operation with context", async () => {
	const startedAt = Date.now();
	await assert.rejects(
		awaitWorkerOperation(() => new Promise(() => {}), {
			operation: "test-poll",
			context: "workflow run-a task task-a",
			timeoutMs: 25,
		}),
		/error|timed out after 25ms \(workflow run-a task task-a\)/,
	);
	assert.ok(Date.now() - startedAt < 500);
});

test("WB-004 surfaces interrupt rejection and preserves recoverable worker state", async (t) => {
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const task = runningTask();
	setTaskRuntimeApiForTests({
		interruptWorker: async () => {
			throw new Error("interrupt unavailable");
		},
	});
	await assert.rejects(
		interruptWorkerTask(task, "unit cancellation"),
		/interrupt unavailable/,
	);
	assert.equal(task.status, "running");
	assert.equal(task.workerHandle.runId, "child-run");
});

test("WB-004 rejects unsupported and mismatched exact-attempt interruption results", async (t) => {
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const task = runningTask();
	setTaskRuntimeApiForTests({
		interruptWorker: async () => ({
			status: "unsupported",
			runId: "child-run",
			interruptedAttempts: [],
			unsupportedAttempts: ["child-attempt"],
			record: null,
		}),
	});
	await assert.rejects(
		interruptWorkerTask(task, "unsupported cancellation"),
		/not acknowledged.*unsupported/,
	);
	assert.equal(task.status, "running");
	assert.equal(task.workerHandle.attemptId, "child-attempt");

	setTaskRuntimeApiForTests({
		interruptWorker: async () => ({
			status: "interrupt-requested",
			runId: "child-run",
			interruptedAttempts: ["other-attempt"],
			unsupportedAttempts: [],
			record: null,
		}),
	});
	await assert.rejects(
		interruptWorkerTask(task, "mismatched cancellation"),
		/acknowledged a different attempt/,
	);

	setTaskRuntimeApiForTests({
		interruptWorker: async () => ({
			status: "already-terminal",
			runId: "other-run",
			interruptedAttempts: [],
			unsupportedAttempts: [],
			record: {
				attempts: [{ attemptId: "child-attempt", status: "cancelled" }],
			},
		}),
	});
	await assert.rejects(
		interruptWorkerTask(task, "wrong run cancellation"),
		/result run other-run does not match child-run/,
	);
});

test("WB-004 waits for the exact interrupted attempt to become terminal", async (t) => {
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const task = runningTask();
	let statusCalls = 0;
	setTaskRuntimeApiForTests({
		interruptWorker: async () => ({
			status: "interrupt-requested",
			runId: "child-run",
			interruptedAttempts: ["child-attempt"],
			unsupportedAttempts: [],
			record: {
				attempts: [{ attemptId: "child-attempt", status: "running" }],
			},
		}),
		getWorkerStatus: async () => {
			statusCalls += 1;
			return {
				runId: "child-run",
				attemptId: "child-attempt",
				executorId: "headless",
				status: statusCalls < 2 ? "running" : "cancelled",
				failureKind: statusCalls < 2 ? null : "user_cancelled",
				startedAt: new Date().toISOString(),
				completedAt: statusCalls < 2 ? null : new Date().toISOString(),
				logs: [],
				attempts: [
					{
						attemptId: "child-attempt",
						status: statusCalls < 2 ? "running" : "cancelled",
					},
				],
			};
		},
	});
	const acknowledgement = await interruptWorkerTask(
		task,
		"delayed exact cancellation",
	);
	assert.equal(acknowledgement.attemptId, "child-attempt");
	assert.equal(acknowledgement.status, "cancelled");
	assert.equal(statusCalls, 2);
});

test("WB-004 cleanup records cancellation failure and later acknowledgement", async (t) => {
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const task = runningTask();
	const run = { runId: "workflow-run", tasks: [task] };
	setTaskRuntimeApiForTests({
		interruptWorker: async () => {
			throw new Error("worker still alive");
		},
	});
	await assert.rejects(
		cleanupWorkerRun("/tmp/project", run),
		/cancellations failed/,
	);
	assert.equal(task.status, "running");
	assert.equal(task.statusDetail, "cancellation_failed");
	assert.match(task.lastMessage, /worker still alive/);
	assert.equal(task.workerHandle.runId, "child-run");

	setTaskRuntimeApiForTests({
		interruptWorker: async () => ({
			status: "already-terminal",
			runId: "child-run",
			interruptedAttempts: [],
			unsupportedAttempts: [],
			record: {
				attempts: [{ attemptId: "child-attempt", status: "cancelled" }],
			},
		}),
	});
	await cleanupWorkerRun("/tmp/project", run);
	assert.equal(task.status, "running");
	assert.equal(task.statusDetail, "cancellation_acknowledged");
});

test("WB-004 fail-fast keeps running workers nonterminal until cancellation acknowledgement", () => {
	const failed = {
		taskId: "task-failed",
		specId: "failed",
		status: "failed",
		statusDetail: "failed",
	};
	const running = runningTask();
	const pending = {
		taskId: "task-pending",
		specId: "pending",
		status: "pending",
		statusDetail: "pending",
	};
	const run = { tasks: [failed, running, pending] };
	const compiled = {
		failurePolicy: {
			failFast: true,
			cancelSiblingsOnFailure: true,
			cancelDescendantsOnParentFailure: false,
		},
		tasks: [{ id: "failed" }, { id: "running" }, { id: "pending" }],
	};
	const summary = markFailFastCancellations(run, compiled);
	assert.deepEqual(summary.interruptedTaskIds, ["task-running"]);
	assert.equal(running.status, "running");
	assert.equal(running.statusDetail, "cancellation_pending");
	assert.equal(running.workerHandle.runId, "child-run");
	assert.equal(pending.status, "interrupted");
	assert.equal(pending.statusDetail, "fail_fast_cancelled");
});
