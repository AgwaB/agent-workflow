import assert from "node:assert/strict";
import test from "node:test";
import * as h from "../helpers/unit-test-support.mjs";
import { refreshRunFromWorkerArtifacts } from "../../dist/core/task-runner.js";
import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import { setTaskTerminal } from "../../dist/core/store.js";

const AT = "2026-11-01T10:00:00.000Z";
const ACTIVITY = { kind: "read", label: "Reading src/core/store.ts", at: AT };

test("supervisor refresh copies the exact attempt's activity, preserves heartbeat text, and clears it", async (t) => {
	const cwd = h.makeProject();
	t.after(() => setTaskRuntimeApiForTests(undefined));
	h.writeAgent(cwd, "unit-scout", "read");
	const spec = {
		schemaVersion: 1,
		name: "activity",
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Read a file" }],
		},
	};
	const compiled = await h.compileWorkflow(spec, {
		cwd,
		task: "Fixture only",
		specPath: `${cwd}/spec.json`,
	});
	const { run } = await h.createWorkflowRunRecord(
		cwd,
		compiled,
		`${cwd}/spec.json`,
	);
	const task = run.tasks[0];
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = new Date().toISOString();
	task.workerHandle = {
		cwd,
		runsDir: ".agent-workflow/runs",
		runId: "child-run",
		attemptId: "exact-attempt",
		display: "child-run/exact-attempt",
	};
	let status = "running";
	let activity = { ...ACTIVITY, extra: "not allowlisted" };
	setTaskRuntimeApiForTests({
		reconcileWorkerRun: async () => ({}),
		getWorkerStatus: async () => ({
			runId: "child-run",
			attemptId: "exact-attempt",
			executorId: "fixture",
			status,
			failureKind: status === "running" ? null : "user_cancelled",
			startedAt: task.startedAt,
			completedAt: status === "running" ? null : new Date().toISOString(),
			logs: [],
			attempts: [
				{ attemptId: "exact-attempt", status, heartbeatAt: AT, activity },
				{
					attemptId: "other-attempt",
					status: "running",
					activity: { ...ACTIVITY, label: "Reading wrong.ts" },
				},
			],
		}),
	});
	await h.writeRunRecord(cwd, run);
	await refreshRunFromWorkerArtifacts(cwd, run);
	assert.deepEqual(task.activity, ACTIVITY);
	assert.equal(task.lastMessage, `executor heartbeat ${AT}`);
	assert.deepEqual(
		(await h.readRunRecord(cwd, run.runId)).tasks[0].activity,
		ACTIVITY,
	);
	activity = { ...ACTIVITY, kind: "invalid" };
	await refreshRunFromWorkerArtifacts(cwd, run);
	assert.equal(task.activity, undefined);
	activity = ACTIVITY;
	await refreshRunFromWorkerArtifacts(cwd, run);
	assert.deepEqual(task.activity, ACTIVITY);
	status = "cancelled";
	await refreshRunFromWorkerArtifacts(cwd, run);
	assert.equal(task.status, "interrupted");
	assert.equal("activity" in task, false);
	assert.equal(
		"activity" in (await h.readRunRecord(cwd, run.runId)).tasks[0],
		false,
	);
});

test("terminal transitions clear activity immediately, including timeout/cancel paths", () => {
	for (const status of [
		"completed",
		"failed",
		"interrupted",
		"blocked",
		"skipped",
	]) {
		const task = { status: "running", activity: ACTIVITY };
		setTaskTerminal(task, status, status);
		assert.equal("activity" in task, false);
	}
});
