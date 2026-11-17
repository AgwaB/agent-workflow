// A failed source is listed in both sourceStatusSummary and reportContext of the partition; the
// report must show each partial source once (recorded run workflow_mwibvq2c_a062a2 printed each twice).
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const render = (
	await import(
		pathToFileURL(
			join(
				process.cwd(),
				"workflows",
				"deep-review",
				"helpers",
				"render-review-report.mjs",
			),
		).href
	)
).default;

test("a partial source present in both partition summaries is rendered once", async () => {
	const failure = {
		specId: "devil-advocate",
		taskId: "task-1",
		source: "devil-advocate.finding-009",
		displayName: "devil-advocate.finding-009",
		status: "failed",
	};
	const output = await render({
		sources: {
			"partition-verdicts.main": {
				sourceStatusSummary: { partialFailures: [failure] },
				reportContext: { partialFailures: [{ ...failure }] },
				partitions: { keep: [], weaken: [], drop: [], needsHuman: [] },
			},
			report: { summary: "s", verdict: "PARTIAL_REVIEW" },
		},
	});
	const lines = output.markdown
		.split("\n")
		.filter((line) => line.startsWith("- Partial source:"));
	assert.deepEqual(lines, [
		"- Partial source: devil-advocate.finding-009 (failed)",
	]);
});
