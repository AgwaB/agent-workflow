// New in agent-workflow (WP42, WP39b review finding 3, major): only positively identified classifier records (runtime
// schema, the router's correlation id, its runs directory and a runtime-generated run id) are deleted;
// anything else in auto-router-runs is kept and reported.
// Temporary directories only; no agent CLI, no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	at,
	branchExists,
	classifier,
	classifierId,
	git,
	json,
	managedBranch,
	managedPath,
	repo,
	ROUTER_RUNS,
	temp,
	workflow,
} from "../helpers/wp42-retention-fixtures.mjs";

const retention = await import("../../dist/core/run-retention.js");
const { pruneWorkflowRuns, formatWorkflowPruneSummary } = retention;

test("F3: unidentified records in auto-router-runs are kept and reported in the dry run", async () => {
	const cwd = await temp();
	const router = join(cwd, ROUTER_RUNS);
	const foreign = classifierId();
	await json(join(router, foreign, "run.json"), {
		runId: foreign,
		status: "completed",
		updatedAt: at,
		kind: "user-owned-not-a-classifier",
	});
	await writeFile(join(router, foreign, "valuable.txt"), "user data\n");
	// Classifier-shaped, but not a runtime-generated id.
	await classifier(router, "run_user_backup");
	// Another correlation (not the router's comparison call).
	const other = classifierId();
	await classifier(router, other, { correlationId: "someone-else" });
	// Recorded for another runs directory.
	const moved = classifierId();
	await classifier(router, moved, { runsDir: ".agent-workflow/runs" });
	// The router's own record is still pruned.
	const own = classifierId();
	await classifier(router, own);

	const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
	assert.deepEqual(
		preview.autoRouterRuns.map((run) => run.runId),
		[own],
	);
	assert.deepEqual(
		preview.autoRouterPreserved.map((item) => item.name).sort(),
		[foreign, "run_user_backup", other, moved].sort(),
	);
	assert.match(
		formatWorkflowPruneSummary(preview),
		/Kept in auto-router-runs \(not identified as classifier requests\):/,
	);
	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.autoRouterRuns[0]?.deleted, true, JSON.stringify(done));
	assert.equal(existsSync(join(router, own)), false);
	for (const name of [foreign, "run_user_backup", other, moved])
		assert.ok(existsSync(join(router, name, "valuable.txt")), name);
});
