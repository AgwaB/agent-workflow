// New in agent-workflow (WP42, WP39b review finding 4, minor): with its worktree missing, the managed branch is deleted
// only when `git merge-base --is-ancestor <tip> HEAD` holds, whatever its upstream says.
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

async function missingManagedWorktree(cwd, commit) {
	git(cwd, [
		"worktree",
		"add",
		"-q",
		"-b",
		managedBranch,
		managedPath(cwd),
		"HEAD",
	]);
	if (commit) {
		await writeFile(join(managedPath(cwd), "RESULT.md"), "unmerged commit\n");
		git(managedPath(cwd), ["add", "RESULT.md"]);
		git(managedPath(cwd), [
			"commit",
			"-q",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			"result",
		]);
	}
	git(cwd, ["worktree", "remove", "--force", managedPath(cwd)]);
	await workflow(cwd, {
		enabled: true,
		path: managedPath(cwd),
		branch: managedBranch,
		baseCwd: cwd,
		warning: null,
	});
}

test("F4: a missing worktree's branch with commits outside HEAD is kept even when its upstream contains them", async () => {
	const cwd = await repo();
	await missingManagedWorktree(cwd, true);
	git(cwd, ["branch", "upstream-fixture", managedBranch]);
	git(cwd, [
		"branch",
		"-q",
		"--set-upstream-to=upstream-fixture",
		managedBranch,
	]);
	const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
	assert.equal(
		preview.runs[0]?.worktrees?.[0]?.commits,
		1,
		JSON.stringify(preview),
	);
	assert.equal(preview.runs[0]?.worktrees?.[0]?.missing, true);
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.notEqual(summary.runs[0]?.worktrees?.[0]?.branchDeleted, true);
	assert.ok(branchExists(cwd, managedBranch));
});

test("F4: a missing worktree's merged managed branch is deleted with the run (control)", async () => {
	const cwd = await repo();
	await missingManagedWorktree(cwd, false);
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(summary.runs[0]?.deleted, true, JSON.stringify(summary));
	assert.equal(summary.runs[0]?.worktrees?.[0]?.branchDeleted, true);
	assert.equal(branchExists(cwd, managedBranch), false);
});
