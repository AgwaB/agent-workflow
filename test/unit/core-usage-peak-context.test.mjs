// agent-workflow 2026-11-08 (context-quality backlog R1): the runtime's UsageSummary carries the
// largest prompt one usage event reported (peakContext); task records keep it per attempt and as
// the aggregate maximum, never summed into a total.
import assert from "node:assert/strict";
import test from "node:test";

import { summarizeUsage } from "../../dist/runtime/index.js";
import { recordTerminalTaskObservability } from "../../dist/core/task-observability.js";

const event = (input, cached, extra = {}) => ({
	type: "usage",
	input,
	output: 10,
	cached,
	cost: null,
	source: "unknown",
	...extra,
});

test("peakContext is the largest input + cached + cacheWrite of one event; null when a part is unknown", () => {
	assert.equal(
		summarizeUsage([
			event(100, 50),
			event(300, 1000, { cacheWrite: 20 }),
			event(5, 5),
		]).peakContext,
		1320,
	);
	assert.equal(
		summarizeUsage([event(100, 50), event(300, null)]).peakContext,
		null,
	);
	assert.equal(
		summarizeUsage([event(100, 50, { cacheWrite: null })]).peakContext,
		null,
	);
	assert.equal(summarizeUsage([event(7, 0)]).events, 1);
});

function task() {
	return {
		taskId: "task-1",
		specId: "stage.main",
		runtime: { approvalMode: "never", model: "m" },
		status: "completed",
	};
}

const snapshot = (attemptId, usage) => ({
	runId: "run-1",
	attemptId,
	status: "completed",
	metadata: { usage },
});

test("attempt records keep peakContextTokens/usageEvents; the aggregate keeps the maximum, totals are untouched", () => {
	const t = task();
	recordTerminalTaskObservability({
		task: t,
		snapshot: snapshot("a1", {
			input: 100,
			output: 10,
			cached: 400,
			cacheWrite: 0,
			total: 510,
			cost: null,
			source: "unknown",
			events: 3,
			peakContext: 450,
		}),
	});
	recordTerminalTaskObservability({
		task: t,
		snapshot: snapshot("a2", {
			input: 50,
			output: 5,
			cached: 900,
			cacheWrite: 0,
			total: 955,
			cost: null,
			source: "unknown",
			events: 2,
			peakContext: 920,
		}),
	});
	assert.deepEqual(
		t.usage.attempts.map((a) => [
			a.workerAttemptId,
			a.peakContextTokens,
			a.usageEvents,
		]),
		[
			["a1", 450, 3],
			["a2", 920, 2],
		],
	);
	assert.equal(t.usage.aggregate.peakContextTokens, 920);
	// Sums are unchanged by the peak fields.
	assert.equal(t.usage.aggregate.inputTokens, 150);
	assert.equal(t.usage.aggregate.cacheReadInputTokens, 1300);
	assert.equal(
		t.usage.peakContextTokens,
		undefined,
		"not a summed metric on the usage record itself",
	);

	// An attempt with unknown peak makes the aggregate unknown; an attempt without the field is ignored.
	recordTerminalTaskObservability({
		task: t,
		snapshot: snapshot("a3", {
			input: 1,
			output: 1,
			cached: null,
			cacheWrite: 0,
			total: null,
			cost: null,
			source: "unknown",
			events: 1,
			peakContext: null,
		}),
	});
	assert.equal(t.usage.aggregate.peakContextTokens, null);
	const legacy = task();
	recordTerminalTaskObservability({
		task: legacy,
		snapshot: snapshot("old", {
			input: 1,
			output: 1,
			cached: 0,
			cost: null,
			source: "unknown",
			events: 1,
		}),
	});
	assert.equal(legacy.usage.attempts[0].peakContextTokens, undefined);
	assert.equal(legacy.usage.aggregate.peakContextTokens, undefined);
});
