// New in agent-workflow (live bundle 6): the `prune` dry run must agree with `--yes` about a run
// whose managed worktree prune would keep (switched to a user branch, not identified, …). Before the
// fix the preview listed such a run under "Runs that would be deleted" and counted its bytes, while
// `--yes` kept it ("protected: worktree removal failed: …"). Temporary git repositories only; no agent
// CLI, no model call.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	git,
	managedPath,
	repo,
	workflow,
} from "../helpers/wp42-retention-fixtures.mjs";

const retention = await import("../../dist/core/run-retention.js");
const worktree = await import("../../dist/core/worktree.js");
const { pruneWorkflowRuns, formatWorkflowPruneSummary } = retention;

async function managedWorktree(cwd) {
	const task = {
		taskId: "task-1",
		specId: "w",
		status: "completed",
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
	};
	await worktree.ensureManagedWorktree(
		cwd,
		{ runId: "workflow_probe", tasks: [task] },
		task,
		{ cwd, safety: { requiresWorktree: true } },
	);
	await workflow(cwd, task.worktree);
	return task.worktree;
}

test("live6: the dry run marks a run protected when prune would keep its worktree, as --yes does", async () => {
	const cwd = await repo();
	const record = await managedWorktree(cwd);
	git(record.path, ["switch", "-q", "-c", "user-work"]);
	await writeFile(join(record.path, "UNCOMMITTED.txt"), "user data\n");

	const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
	const run = preview.runs[0];
	assert.ok(run, JSON.stringify(preview));
	assert.equal(run.protected, true, JSON.stringify(run));
	assert.match(run.error ?? "", /user-work/);
	assert.equal(preview.totalBytes, 0, JSON.stringify(preview));
	assert.match(
		formatWorkflowPruneSummary(preview),
		/workflow_probe .* — protected: worktree kept: /u,
	);

	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.equal(done.runs[0]?.protected, true);
	assert.ok(existsSync(join(managedPath(cwd), "UNCOMMITTED.txt")));
});

test("live6 control: the dry run of an unchanged managed worktree still lists the run for deletion", async () => {
	const cwd = await repo();
	await managedWorktree(cwd);
	const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
	assert.equal(preview.runs[0]?.protected, false, JSON.stringify(preview));
	assert.equal(preview.runs[0]?.error, undefined);
	assert.ok(preview.totalBytes > 0);
	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, true, JSON.stringify(done));
});
