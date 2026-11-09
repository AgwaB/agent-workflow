// agent-workflow 2026-11-08 (context-quality R3 follow-up): Codex reports usage per turn, and a turn of
// many requests summed into one event is not a context size (a 17-request final-audit turn recorded
// "peak" 777,556 tokens against a 272k window; its largest request was 66,687). Each
// thread/tokenUsage/updated also carries `last` (the request just made), so the turn's largest
// last.inputTokens is the peak context.
import assert from "node:assert/strict";
import test from "node:test";

import { CodexTurnNormalizer } from "../../dist/executors/codex/normalize.js";
import { summarizeUsage } from "../../dist/runtime/index.js";
import { validateExecEvent } from "../../dist/sdk/index.js";

// Request prompts of that recorded turn (last.inputTokens), cached share and outputs simplified.
const REQUESTS = [
	15088, 16037, 20677, 25165, 29905, 33430, 36522, 39604, 42696, 45783, 48878,
	51961, 55040, 58119, 61194, 64273, 66497, 66687,
];

function turnEvents(requests) {
	const normalizer = new CodexTurnNormalizer({});
	const total = {
		totalTokens: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
	};
	for (const input of requests) {
		const last = {
			totalTokens: input + 100,
			inputTokens: input,
			cachedInputTokens: input - 1000,
			outputTokens: 100,
		};
		for (const key of Object.keys(total)) total[key] += last[key];
		normalizer.push("thread/tokenUsage/updated", {
			turnId: "turn-1",
			tokenUsage: { total: { ...total }, last },
		});
	}
	return normalizer.finish({ id: "turn-1", status: "completed" });
}

test("Codex: the usage event carries the turn's largest request as peakContext", () => {
	const usage = turnEvents(REQUESTS).find((event) => event.type === "usage");
	assert.deepEqual(validateExecEvent(usage), []);
	assert.equal(usage.peakContext, 66687);
	// The token totals stay the turn's sums.
	assert.equal(
		usage.input + usage.cached,
		REQUESTS.reduce((sum, n) => sum + n, 0),
	);
});

test("summarizeUsage takes an event's peakContext over its summed input side", () => {
	const summary = summarizeUsage(turnEvents(REQUESTS));
	assert.equal(summary.peakContext, 66687);
	assert.equal(summary.input + summary.cached, 777556);
	// An event without peakContext (one request per event) keeps the summed definition.
	const single = summarizeUsage([
		{
			type: "usage",
			input: 10,
			cached: 90,
			output: 5,
			cost: null,
			source: "unknown",
		},
	]);
	assert.equal(single.peakContext, 100);
	assert.equal(
		summarizeUsage([
			{
				type: "usage",
				input: 10,
				cached: 90,
				output: 5,
				cost: null,
				source: "unknown",
				peakContext: null,
			},
		]).peakContext,
		null,
	);
});

test("validateExecEvent: peakContext must be a non-negative integer or null when present", () => {
	const base = {
		type: "usage",
		input: 1,
		output: 1,
		cached: 0,
		cost: null,
		source: "unknown",
	};
	assert.deepEqual(validateExecEvent({ ...base, peakContext: 5 }), []);
	assert.deepEqual(validateExecEvent({ ...base, peakContext: null }), []);
	assert.ok(validateExecEvent({ ...base, peakContext: -1 }).length > 0);
});
