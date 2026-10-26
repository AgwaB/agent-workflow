// New in agent-workflow (WP1b regression): task usage records read the runtime UsageSummary that an
// executor attempt stores as result.json `metadata.usage` ({input, output, cached, cost, source,
// events}, the summed SDK UsageEvents). `cached` (cache-read input tokens) and `cost` (USD) were
// dropped, because the aliases only knew Pi's own usage object (`cacheRead`, `cost.total`), so
// cache-read tokens and cost vanished from task and run usage for every executor. Found by the
// WP1b replay (run usage totals cacheReadInputTokens / costUsd did not match the recordings).
import assert from "node:assert/strict";
import { test } from "node:test";

const observability = await import("../../dist/core/task-observability.js");

test("runtime UsageSummary cached/cost map to cacheReadInputTokens/costUsd", () => {
	assert.deepEqual(
		observability.normalizedUsageValues({
			input: 12485,
			output: 2481,
			cached: 91264,
			cost: 0.0589064,
			source: "estimated",
			events: 1,
		}),
		{
			inputTokens: 12485,
			outputTokens: 2481,
			cacheReadInputTokens: 91264,
			costUsd: 0.0589064,
		},
	);
	// Unknown stays unknown (null), distinct from 0.
	assert.deepEqual(
		observability.normalizedUsageValues({
			input: 10,
			output: 5,
			cached: null,
			cost: null,
			source: "unknown",
			events: 1,
		}),
		{
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: null,
			costUsd: null,
		},
	);
});

test("Pi usage objects keep their precedence over the bare aliases", () => {
	// Pi: cost is an object ({total, ...}); cacheRead is the cache-read count.
	assert.deepEqual(
		observability.normalizedUsageValues({
			input: 100,
			output: 20,
			cacheRead: 7,
			cost: { input: 0.1, output: 0.2, total: 0.3 },
		}),
		{
			inputTokens: 100,
			outputTokens: 20,
			cacheReadInputTokens: 7,
			costUsd: 0.3,
		},
	);
});
