// New in agent-workflow (WP42, WP39b review finding 2, major): a managed worktree is removed only when it is physically
// inside the run's worktrees directory, registered by this repository's `git worktree list` and checked
// out on the recorded managed branch; metadata alone never deletes a branch.
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

test("F2: a symlinked worktrees/ parent never leads prune to an outside worktree", async () => {
	const cwd = await repo();
	const outside = await temp();
	const realTree = join(outside, "task-1");
	git(cwd, ["worktree", "add", "-q", "-b", managedBranch, realTree, "HEAD"]);
	await writeFile(join(realTree, "UNCOMMITTED.txt"), "user work\n");
	await workflow(cwd, {
		enabled: true,
		path: managedPath(cwd),
		branch: managedBranch,
		baseCwd: cwd,
		warning: null,
	});
	await symlink(outside, dirname(managedPath(cwd)));
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(summary.runs[0]?.deleted, false, JSON.stringify(summary));
	assert.notEqual(summary.runs[0]?.worktrees?.[0]?.removed, true);
	assert.ok(summary.runs[0]?.worktrees?.[0]?.error);
	assert.ok(existsSync(join(realTree, "UNCOMMITTED.txt")));
	assert.ok(branchExists(cwd, managedBranch));
});

test("F2: a worktree of another repository named by baseCwd metadata is kept", async () => {
	const cwd = await repo();
	const other = await repo();
	await mkdir(dirname(managedPath(cwd)), { recursive: true });
	git(other, [
		"worktree",
		"add",
		"-q",
		"-b",
		managedBranch,
		managedPath(cwd),
		"HEAD",
	]);
	await writeFile(
		join(managedPath(cwd), "UNCOMMITTED.txt"),
		"other repo work\n",
	);
	await workflow(cwd, {
		enabled: true,
		path: managedPath(cwd),
		branch: managedBranch,
		baseCwd: other,
		warning: null,
	});
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(summary.runs[0]?.deleted, false, JSON.stringify(summary));
	assert.match(summary.runs[0]?.worktrees?.[0]?.error ?? "", /not registered/);
	assert.ok(existsSync(join(managedPath(cwd), "UNCOMMITTED.txt")));
	assert.ok(branchExists(other, managedBranch));
});

test("F2: a worktree at the managed path on another branch than the recorded one is kept", async () => {
	const cwd = await repo();
	await mkdir(dirname(managedPath(cwd)), { recursive: true });
	git(cwd, [
		"worktree",
		"add",
		"-q",
		"-b",
		"user-work",
		managedPath(cwd),
		"HEAD",
	]);
	await writeFile(join(managedPath(cwd), "UNCOMMITTED.txt"), "user work\n");
	await workflow(cwd, {
		enabled: true,
		path: managedPath(cwd),
		branch: managedBranch,
		baseCwd: cwd,
		warning: null,
	});
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(summary.runs[0]?.deleted, false, JSON.stringify(summary));
	assert.ok(summary.runs[0]?.worktrees?.[0]?.error);
	assert.ok(existsSync(join(managedPath(cwd), "UNCOMMITTED.txt")));
	assert.ok(branchExists(cwd, "user-work"));
});

test("F2: metadata naming a missing worktree never deletes an unrelated user branch", async () => {
	const cwd = await repo();
	git(cwd, ["branch", "my-user-branch"]);
	await workflow(cwd, {
		enabled: true,
		path: managedPath(cwd),
		branch: "my-user-branch",
		baseCwd: cwd,
		warning: null,
	});
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.notEqual(summary.runs[0]?.worktrees?.[0]?.branchDeleted, true);
	assert.ok(branchExists(cwd, "my-user-branch"));
});
