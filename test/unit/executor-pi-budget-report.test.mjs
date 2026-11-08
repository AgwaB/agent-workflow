// agent-workflow 2026-11-08: Pi's tool-result budget state reaches the engine. The adapter reports
// its context-hook state as `toolResultBudget` on the terminal event; the runtime copies it into the
// attempt result metadata; the engine's task telemetry reads it from there (before: every attempt was
// recorded as "unavailable" even when Pi had evicted results).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordTerminalTaskObservability } from "../../dist/core/task-observability.js";
import {
	readPiToolResultBudgetReport,
	withToolResultBudget,
} from "../../dist/executors/pi/executor.js";
import {
	buildExecutionReport,
	summarizeUsage,
} from "../../dist/runtime/index.js";
import { validateExecEvent } from "../../dist/sdk/index.js";

const state = {
	schemaVersion: 1,
	maxTotalChars: 40_000,
	toolResults: 4,
	retainedChars: 36_061,
	evictedCount: 3,
	evictedChars: 108_183,
	evictableCount: 0,
	forcedEvictionApplied: false,
};
const report = { enabled: true, ...state };
delete report.schemaVersion;

test("the SDK accepts a well-formed budget report on terminal events and rejects a malformed one", () => {
	assert.deepEqual(
		validateExecEvent({
			type: "completed",
			finalText: "ok",
			toolResultBudget: report,
		}),
		[],
	);
	assert.deepEqual(
		validateExecEvent({
			type: "failed",
			class: "permanent",
			message: "x",
			raw: null,
			toolResultBudget: report,
		}),
		[],
	);
	assert.deepEqual(
		validateExecEvent({ type: "completed", finalText: "ok" }),
		[],
	);
	assert.match(
		validateExecEvent({
			type: "completed",
			finalText: "ok",
			toolResultBudget: { ...report, evictedCount: -1 },
		}).join("; "),
		/evictedCount must be a non-negative number/u,
	);
	assert.match(
		validateExecEvent({
			type: "completed",
			finalText: "ok",
			toolResultBudget: { maxTotalChars: 10 },
		}).join("; "),
		/enabled must be a boolean/u,
	);
	assert.match(
		validateExecEvent({
			type: "completed",
			finalText: "ok",
			toolResultBudget: "yes",
		}).join("; "),
		/must be an object/u,
	);
});

test("Pi reads its state file into the terminal event; absent or foreign files add nothing", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-budget-report-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	assert.equal(await readPiToolResultBudgetReport(dir), undefined);
	await writeFile(
		join(dir, "tool-result-budget.json"),
		JSON.stringify({ foreign: true }),
	);
	assert.equal(await readPiToolResultBudgetReport(dir), undefined);
	await writeFile(join(dir, "tool-result-budget.json"), JSON.stringify(state));
	const read = await readPiToolResultBudgetReport(dir);
	assert.deepEqual(read, report);
	const completed = { type: "completed", finalText: "done" };
	assert.deepEqual(withToolResultBudget(completed, read), {
		...completed,
		toolResultBudget: report,
	});
	assert.equal(withToolResultBudget(completed, undefined), completed);
	const usage = {
		type: "usage",
		input: 1,
		output: 1,
		cached: 0,
		cost: null,
		source: "unknown",
	};
	assert.equal(
		withToolResultBudget(usage, read),
		usage,
		"non-terminal events are untouched",
	);
	assert.deepEqual(
		validateExecEvent(withToolResultBudget(completed, read)),
		[],
	);
});

test("the runtime report carries the budget and the engine telemetry reads it as reported", async () => {
	const store = {
		attemptDir: "/nonexistent",
		appendTextArtifact: async (name) => ({ name, path: `${name}.jsonl` }),
	};
	const outcome = {
		status: "completed",
		failureKind: null,
		message: "",
		finalText: "done",
		usage: summarizeUsage([
			{
				type: "usage",
				input: 10,
				output: 2,
				cached: 5,
				cost: null,
				source: "unknown",
			},
		]),
		toolResultBudget: report,
	};
	const built = await buildExecutionReport(
		store,
		{ ref: undefined },
		[],
		outcome,
	);
	assert.deepEqual(built.toolResultBudget, report);

	// What run.ts/reconcile.ts write into result metadata, read back by the engine telemetry.
	const task = {
		taskId: "task-1",
		specId: "dynamic.read-docs",
		runtime: { approvalMode: "never" },
		status: "completed",
		dynamicGenerated: { controllerSpecId: "c", opId: "o", requestHash: "h" },
	};
	recordTerminalTaskObservability({
		task,
		snapshot: {
			runId: "run-1",
			attemptId: "attempt-1",
			status: "completed",
			metadata: {
				usage: built.usage,
				toolResultBudget: built.toolResultBudget,
			},
		},
	});
	const attempt = task.toolResultBudget.attempts[0];
	assert.equal(attempt.reported, true);
	assert.equal(attempt.unavailable, undefined);
	assert.equal(attempt.evictedCount, 3);
	assert.equal(attempt.evictedChars, 108_183);
	assert.equal(attempt.retainedChars, 36_061);
	assert.equal(task.toolResultBudget.aggregate.reportingAttempts, 1);
	assert.equal(task.toolResultBudget.aggregate.unavailableAttempts, 0);
	assert.equal(task.toolResultBudget.aggregate.observedEvictedCount, 3);
});
