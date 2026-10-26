// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/wb-016-scheduler-performance.test.mjs. MIT, same author. Changes: imports from dist/core/; 1 engine.ts/subagent-backend.ts source test dropped (WP4c).
import assert from "node:assert/strict";
import test from "node:test";

import {
	POLL_INTERVAL_MS,
	schedulerPollDelayMs,
} from "../../dist/core/engine-wait.js";

function task(status, nextEligibleAt) {
	return {
		taskId: `${status}-${nextEligibleAt ?? "none"}`,
		specId: "main",
		status,
		launchRetry: nextEligibleAt ? { nextEligibleAt } : undefined,
	};
}

test("WB-016 scheduler wakes at earliest pending retry deadline within fixed bounds", () => {
	const now = Date.parse("2026-07-10T02:00:00.000Z");
	const run = {
		tasks: [
			task("pending", new Date(now + 475).toISOString()),
			task("pending", new Date(now + 150).toISOString()),
			task("running", new Date(now + 25).toISOString()),
			task("pending", "not-a-date"),
		],
	};
	const before = structuredClone(run);
	assert.equal(POLL_INTERVAL_MS, 1_000);
	assert.equal(schedulerPollDelayMs(run, 5_000, now), 150);
	assert.equal(schedulerPollDelayMs(run, 100, now), 100);
	assert.deepEqual(run, before);
});

test("WB-016 scheduler retains fixed poll for absent, expired, or non-pending deadlines", () => {
	const now = Date.parse("2026-07-10T02:00:00.000Z");
	assert.equal(
		schedulerPollDelayMs(
			{
				tasks: [
					task("pending", new Date(now - 1).toISOString()),
					task("completed", new Date(now + 10).toISOString()),
				],
			},
			10_000,
			now,
		),
		1_000,
	);
	assert.equal(schedulerPollDelayMs({ tasks: [] }, 250, now), 250);
	assert.equal(
		schedulerPollDelayMs(
			{ tasks: [task("pending", new Date(now + 1).toISOString())] },
			10_000,
			now,
		),
		1,
	);
});

// Dropped here (deferred to WP4c): "WB-016 wait loop uses deadline selector while
// refresh remains single-write coalesced" reads src/engine.ts and src/subagent-backend.ts.
