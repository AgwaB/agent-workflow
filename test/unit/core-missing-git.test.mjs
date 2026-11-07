// New in agent-workflow (WP42 review round 3, N4, major): when git cannot list registrations (the
// executable is missing, or the project is not a git repository), prune must not infer "no
// registered worktree". A git checkout found on disk inside the run directory (a worktree's `.git`
// file or a repository's `.git` directory) keeps the run; a run without one is still removed.
// Temporary directories only; no agent CLI, no model call.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	git,
	repo,
	temp,
	workflow,
} from "../helpers/wp42-retention-fixtures.mjs";

const { pruneWorkflowRuns } = await import("../../dist/core/run-retention.js");

const NO_WORKTREE = {
	enabled: false,
	path: null,
	branch: null,
	baseCwd: null,
	warning: null,
};

/** Run `fn` with a PATH that has no `git` (an empty directory). */
async function withoutGit(fn) {
	const empty = await temp();
	const previous = process.env.PATH;
	process.env.PATH = empty;
	try {
		return await fn();
	} finally {
		process.env.PATH = previous;
	}
}

test("N4: git missing — an unrecorded registered worktree inside the run directory keeps the run", async () => {
	const cwd = await repo();
	const runDir = await workflow(cwd, NO_WORKTREE);
	const foreign = join(runDir, "scratch", "tree");
	await mkdir(dirname(foreign), { recursive: true });
	git(cwd, ["worktree", "add", "-q", "-b", "user-work", foreign, "HEAD"]);
	await writeFile(join(foreign, "UNCOMMITTED.txt"), "valuable work\n");
	const done = await withoutGit(() =>
		pruneWorkflowRuns(cwd, { keep: 0, yes: true }),
	);
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.match(done.runs[0]?.error ?? "", /git is not available/);
	assert.match(done.runs[0]?.error ?? "", /cannot be ruled out/);
	assert.ok(existsSync(join(foreign, "UNCOMMITTED.txt")));
	assert.match(git(cwd, ["worktree", "list", "--porcelain"]), /user-work/);
});

test("N4: not a git repository — a git checkout inside the run directory keeps the run", async () => {
	const cwd = await temp();
	const runDir = await workflow(cwd, NO_WORKTREE);
	const nested = join(runDir, "scratch", "clone");
	await mkdir(nested, { recursive: true });
	git(nested, ["init", "-q"]);
	await writeFile(join(nested, "WORK.txt"), "work\n");
	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.match(done.runs[0]?.error ?? "", /not a git repository/);
	assert.ok(existsSync(join(nested, "WORK.txt")));
});

test("N4 control: git missing — a run without any git checkout is still removed", async () => {
	for (const cwd of [await repo(), await temp()]) {
		await workflow(cwd, NO_WORKTREE);
		const done = await withoutGit(() =>
			pruneWorkflowRuns(cwd, { keep: 0, yes: true }),
		);
		assert.equal(done.runs[0]?.deleted, true, JSON.stringify(done));
	}
});

test("N4 round 4: a checkout below the scan depth limit keeps the run (git missing, and outside a git repository)", async () => {
	const deep = (runDir) =>
		join(
			runDir,
			"level-1",
			"level-2",
			"level-3",
			"level-4",
			"level-5",
			"level-6",
			"user-tree",
		);
	const cwd = await repo();
	const runDir = await workflow(cwd, NO_WORKTREE);
	const tree = deep(runDir);
	await mkdir(dirname(tree), { recursive: true });
	git(cwd, ["worktree", "add", "-q", "-b", "user-work", tree, "HEAD"]);
	await writeFile(join(tree, "UNCOMMITTED.txt"), "valuable work\n");
	const done = await withoutGit(() =>
		pruneWorkflowRuns(cwd, { keep: 0, yes: true }),
	);
	assert.equal(done.runs[0]?.deleted, false, JSON.stringify(done));
	assert.ok(existsSync(join(tree, "UNCOMMITTED.txt")));

	const plain = await temp();
	const plainRun = await workflow(plain, NO_WORKTREE);
	const clone = deep(plainRun);
	await mkdir(clone, { recursive: true });
	git(clone, ["init", "-q"]);
	await writeFile(join(clone, "WORK.txt"), "work\n");
	const plainDone = await pruneWorkflowRuns(plain, { keep: 0, yes: true });
	assert.equal(plainDone.runs[0]?.deleted, false, JSON.stringify(plainDone));
	assert.ok(existsSync(join(clone, "WORK.txt")));
});
