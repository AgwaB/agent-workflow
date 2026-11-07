import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP42 review round 2, N1, major): a recorded worktree path spelled through
// an alias of the project root (macOS `/tmp` → `/private/tmp`, a symlinked project parent) is mapped
// onto the canonical project root and identified like any other managed worktree; an enabled record
// that cannot be mapped keeps its run; and a run directory that contains any registered git worktree
// prune has not removed itself is kept rather than recursively removed.
// Temporary directories only; no agent CLI, no model call.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	branchExists,
	git,
	managedBranch,
	managedPath,
	repo,
	temp,
	workflow,
} from "../helpers/wp42-retention-fixtures.mjs";

const retention = await import("../../dist/core/run-retention.js");
const worktree = await import("../../dist/core/worktree.js");
const { pruneWorkflowRuns } = retention;

/** A non-canonical spelling of `cwd`: macOS `/var`/`/tmp` without `/private`, else a symlink. */
async function aliasOf(cwd) {
	if (cwd.startsWith("/private/")) {
		const alias = cwd.slice("/private".length);
		if ((await realpath(alias).catch(() => "")) === cwd) return alias;
	}
	const parent = await temp();
	const alias = join(parent, "project");
	await symlink(cwd, alias);
	return alias;
}

async function symlinkedProject(cwd) {
	const parent = await temp();
	const alias = join(parent, "project");
	await symlink(cwd, alias);
	return alias;
}

const registered = (cwd) => git(cwd, ["worktree", "list", "--porcelain"]);

async function realHelperWorktree(alias) {
	const task = {
		taskId: "task-1",
		specId: "w",
		status: "completed",
		cwd: alias,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
	};
	await worktree.ensureManagedWorktree(
		alias,
		{ runId: "workflow_probe", tasks: [task] },
		task,
		{ cwd: alias, safety: { requiresWorktree: true } },
	);
	assert.equal(task.worktree.path, managedPath(alias));
	await workflow(alias, task.worktree);
	return task.worktree;
}

test("N1: a real managed worktree recorded through a /tmp-style alias and switched to user work is kept", async () => {
	const cwd = await repo();
	const alias = await aliasOf(cwd);
	const record = await realHelperWorktree(alias);
	git(record.path, ["switch", "-q", "-c", "user-work"]);
	await writeFile(join(record.path, "UNCOMMITTED.txt"), "user data\n");
	const preview = await pruneWorkflowRuns(alias, { keep: 0 });
	assert.equal(preview.runs[0]?.worktrees?.length, 1, JSON.stringify(preview));
	assert.ok(preview.runs[0].worktrees[0].error);
	const done = await pruneWorkflowRuns(alias, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.match(done.runs[0]?.worktrees?.[0]?.error ?? "", /user-work/);
	assert.ok(existsSync(join(managedPath(cwd), "UNCOMMITTED.txt")));
	assert.match(registered(cwd), /user-work/);
});

test("N1: a symlink-spelled project path on a user branch keeps the worktree and its run", async () => {
	const cwd = await repo();
	const alias = await symlinkedProject(cwd);
	git(cwd, [
		"worktree",
		"add",
		"-q",
		"-b",
		managedBranch,
		managedPath(alias),
		"HEAD",
	]);
	await workflow(alias, {
		enabled: true,
		path: managedPath(alias),
		branch: managedBranch,
		baseCwd: alias,
		warning: null,
	});
	git(managedPath(cwd), ["switch", "-q", "-c", "user-work"]);
	await writeFile(join(managedPath(cwd), "UNCOMMITTED.txt"), "valuable work\n");
	const done = await pruneWorkflowRuns(alias, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.ok(done.runs[0]?.worktrees?.[0]?.error);
	assert.ok(existsSync(join(managedPath(cwd), "UNCOMMITTED.txt")));
	assert.match(registered(cwd), /workflow_probe/);
	assert.ok(branchExists(cwd, "user-work"));
});

test("N1 control: an unchanged managed worktree recorded through an alias is removed without a stale registration", async () => {
	for (const spell of [aliasOf, symlinkedProject]) {
		const cwd = await repo();
		const alias = await spell(cwd);
		await realHelperWorktree(alias);
		const done = await pruneWorkflowRuns(alias, { keep: 0, yes: true });
		assert.equal(done.runs[0]?.deleted, true, JSON.stringify(done));
		assert.equal(done.runs[0]?.worktrees?.[0]?.removed, true);
		assert.equal(done.runs[0]?.worktrees?.[0]?.branchDeleted, true);
		assert.equal(existsSync(managedPath(cwd)), false);
		assert.doesNotMatch(registered(cwd), /workflow_probe/);
		assert.equal(branchExists(cwd, managedBranch), false);
	}
});

test("N1: an enabled worktree record whose project root cannot be resolved keeps the run", async () => {
	const cwd = await repo();
	const gone = join(await temp(), "moved-away");
	await workflow(cwd, {
		enabled: true,
		path: managedPath(gone),
		branch: managedBranch,
		baseCwd: gone,
		warning: null,
	});
	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.ok(done.runs[0]?.worktrees?.[0]?.error);
	assert.ok(
		existsSync(
			join(stateDir(cwd), ".agent-workflow", "workflows", "workflow_probe"),
		),
	);
});

test("N1: a registered git worktree inside the run directory that no record names keeps the run", async () => {
	const cwd = await repo();
	const runDir = await workflow(cwd, {
		enabled: false,
		path: null,
		branch: null,
		baseCwd: null,
		warning: null,
	});
	const foreign = join(runDir, "scratch", "tree");
	await mkdir(dirname(foreign), { recursive: true });
	git(cwd, ["worktree", "add", "-q", "-b", "user-work", foreign, "HEAD"]);
	await writeFile(join(foreign, "UNCOMMITTED.txt"), "valuable work\n");
	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.match(done.runs[0]?.error ?? "", /registered git worktree/);
	assert.ok(existsSync(join(foreign, "UNCOMMITTED.txt")));
	assert.match(registered(cwd), /user-work/);
});

test("N1 control: a run without worktrees in a git repository and outside one is still removed", async () => {
	for (const cwd of [await repo(), await temp()]) {
		await workflow(cwd, {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		});
		const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		assert.equal(done.runs[0]?.deleted, true, JSON.stringify(done));
	}
});
