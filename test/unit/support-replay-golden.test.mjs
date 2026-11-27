// Support-step regression net (2026-11-04, before refactoring): every recorded live run under
// test/fixtures/support-replay/ is replayed through the current bundle helpers and must give the
// committed golden controls. For intentional changes, set AGENT_WORKFLOW_WRITE_REGRESSION=1
// on this file via test/run-unit.mjs with a test-name pattern, then review the golden diff.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
	firstDifference,
	goldenPath,
	replayFixture,
	runLabels,
} from "../helpers/support-replay.mjs";

const labels = runLabels();

test("support-replay fixtures cover every bundled workflow", () => {
	for (const workflow of [
		"spec-review",
		"deep-review",
		"impact-review",
		"deep-research",
	])
		assert.ok(
			labels.some((label) => label.includes(`-${workflow}-`)),
			`no recorded ${workflow} run`,
		);
});

for (const label of labels)
	test(`support replay equals the golden output: ${label}`, async () => {
		const actual = await replayFixture(label);
		if (process.env.AGENT_WORKFLOW_WRITE_REGRESSION === "1") {
			writeFileSync(goldenPath(label), `${JSON.stringify(actual, null, 1)}\n`);
			return;
		}
		assert.ok(
			existsSync(goldenPath(label)),
			`missing golden ${goldenPath(label)}`,
		);
		const expected = JSON.parse(readFileSync(goldenPath(label), "utf8"));
		const diff = firstDifference(actual, expected);
		assert.equal(
			diff,
			null,
			diff
				? `${label} differs at ${diff.path}\n  actual:   ${JSON.stringify(diff.actual)?.slice(0, 400)}\n  expected: ${JSON.stringify(diff.expected)?.slice(0, 400)}\n(intended? set AGENT_WORKFLOW_WRITE_REGRESSION=1 and re-run this case)`
				: "",
		);
	});
