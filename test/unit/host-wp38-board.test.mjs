// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f): test/unit/unit-core-runtime.test.mjs "workflow task
// list orders problem tasks before completed tasks" and "workflow task selection follows task id
// after problem reordering changes", and test/unit/surface-regressions.test.mjs "board preserves
// selected run identity on refresh/re-sort" (WP38). MIT, same author. Changes: pi-workflow's
// `WorkflowView` over the run store → the WP34 `/aw` board (`AwBoard`, src/hosts/pi/board.ts) over a
// fake host-API source (`listRuns`, `runDetail`, `taskLogs`); a state change is a source change plus
// a board refresh (`r`) instead of mutating the view's run and calling `clampStageAndTask()`; the
// row of an invalid-output task shows its status detail (the board has no "invalid output" label).
import assert from "node:assert/strict";
import test from "node:test";

import { eventually } from "../helpers/pi-host-fake.mjs";

const { AwBoard } = await import("../../dist/hosts/pi/board.js");

const T0 = "2026-10-28T10:00:00.000Z";
const DOWN = "\u001b[B";
const ENTER = "\r";

function summarize(tasks) {
	const counts = {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: tasks.length,
	};
	for (const task of tasks) counts[task.status] += 1;
	return counts;
}

function task(taskId, status, statusDetail = status) {
	return {
		taskId,
		specId: taskId,
		displayName: `${taskId} task`,
		agent: "reader",
		stageId: "work",
		status,
		statusDetail,
		runtime: { approvalMode: "never" },
		files: {},
	};
}

/** One run per entry of `runs` ({runId, updatedAt, tasks}); mutate the entries, then refresh. */
function source(runs) {
	const summaryOf = (run) => ({
		runId: run.runId,
		name: run.runId,
		type: "artifact-graph",
		status: "running",
		createdAt: T0,
		updatedAt: run.updatedAt,
		taskSummary: summarize(run.tasks),
	});
	return {
		async listRuns() {
			return runs
				.map(summaryOf)
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		},
		async runDetail(runId) {
			const run = runs.find((entry) => entry.runId === runId);
			const summary = summaryOf(run);
			return {
				run: {
					...summary,
					reportArtifacts: [],
					tasks: run.tasks.map((entry) => ({
						taskId: entry.taskId,
						specId: entry.specId,
						status: entry.status,
						statusDetail: entry.statusDetail,
					})),
				},
				record: { ...summary, tasks: run.tasks.map((entry) => ({ ...entry })) },
			};
		},
		async taskLogs(_runId, taskId) {
			return { taskId, specId: taskId, status: "running", streams: [] };
		},
	};
}

async function board(runs) {
	const view = new AwBoard(source(runs), { requestRender() {} }, {}, () => {}, {
		refreshMs: 0,
		now: () => Date.parse(T0) + 65_000,
	});
	await view.start();
	return { view, text: () => view.render(120).join("\n") };
}

async function refresh(view) {
	view.message = "";
	view.handleInput("r");
	await eventually(() => view.message === "refreshed", "refreshed");
}

test("workflow task list orders problem tasks before completed tasks", async () => {
	const runs = [
		{
			runId: "workflow_order",
			updatedAt: T0,
			tasks: [
				task("done", "completed"),
				task("blocked", "blocked"),
				task("failed", "failed", "workflow_output_invalid"),
				task("running", "running"),
			],
		},
	];
	const b = await board(runs);
	b.view.handleInput(ENTER); // stages
	b.view.handleInput(ENTER); // tasks of "work"
	assert.equal(b.view.mode, "tasks");
	const rendered = b.text();
	const failedIndex = rendered.indexOf("failed task");
	const blockedIndex = rendered.indexOf("blocked task");
	const runningIndex = rendered.indexOf("running task");
	const doneIndex = rendered.indexOf("done task");
	assert.ok(failedIndex >= 0, "failed task rendered");
	assert.ok(blockedIndex > failedIndex, "blocked task follows failed task");
	assert.ok(runningIndex > blockedIndex, "running task follows blocked task");
	assert.ok(doneIndex > runningIndex, "completed task follows running task");
	assert.match(rendered, /work tasks/);
});

test("workflow task selection follows task id after problem reordering changes", async () => {
	const runs = [
		{
			runId: "workflow_select",
			updatedAt: T0,
			tasks: [
				task("failed", "failed"),
				task("blocked", "blocked"),
				task("running", "running"),
				task("done", "completed"),
			],
		},
	];
	const b = await board(runs);
	b.view.handleInput(ENTER);
	b.view.handleInput(ENTER);
	b.view.handleInput(DOWN);
	assert.equal(b.view.currentTask().taskId, "blocked");
	assert.match(b.text(), /› \S+ blocked task/);

	Object.assign(runs[0].tasks[0], {
		status: "completed",
		statusDetail: "completed",
	});
	await refresh(b.view);
	const rendered = b.text();
	assert.equal(b.view.currentTask().taskId, "blocked");
	assert.match(rendered, /› \S+ blocked task/);
	assert.ok(
		rendered.indexOf("blocked task") < rendered.indexOf("failed task"),
		"blocked task remains selected after failed task moves down",
	);
});

test("board preserves selected run identity on refresh/re-sort", async () => {
	const runs = [
		{
			runId: "workflow_first",
			updatedAt: "2026-01-01T00:00:00.000Z",
			tasks: [task("a", "running")],
		},
		{
			runId: "workflow_second",
			updatedAt: "2026-01-02T00:00:00.000Z",
			tasks: [task("b", "running")],
		},
	];
	const b = await board(runs);
	const selected = b.view.selectedRunSummary().runId;
	const other = runs.find((run) => run.runId !== selected);
	other.updatedAt = "2099-01-01T00:00:00.000Z";
	await refresh(b.view);
	assert.equal(b.view.selectedRunSummary().runId, selected);
	assert.equal(b.view.detail.run.runId, selected);
});
