// New in agent-workflow (WP39b, live bundle 5 O7): managed worktrees and the project's run/attempt
// state. The dirty-checkout snapshot never copies `.agent-workflow/` (run and attempt state of this
// and other tasks) into a worktree, even when the project does not git-ignore it. Real git in a
// temporary repository; no agent CLI, no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { ensureManagedWorktree } = await import("../../dist/core/worktree.js");

const roots = [];
after(async () => {
	for (const root of roots)
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function git(cwd, args) {
	const result = spawnSync(
		"git",
		[
			"-c",
			"user.name=aw-test",
			"-c",
			"user.email=aw-test@example.invalid",
			...args,
		],
		{ cwd, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

async function repo() {
	const cwd = realpathSync(await mkdtemp(join(tmpdir(), "aw-wp39b-wt-")));
	roots.push(cwd);
	writeFileSync(join(cwd, "README.md"), "# fixture\n");
	git(cwd, ["init", "-q"]);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "--no-verify", "-m", "fixture"]);
	return cwd;
}

test("the dirty snapshot never copies .agent-workflow/ state into a worktree, even when not git-ignored", async () => {
	const cwd = await repo();
	// Untracked, not ignored: another task's attempt state, notify receipts, a run dir, user work.
	const state = join(cwd, ".agent-workflow");
	mkdirSync(join(state, "workflow-subagents", "workflow_other", "task-9"), {
		recursive: true,
	});
	writeFileSync(
		join(state, "workflow-subagents", "workflow_other", "task-9", "run.json"),
		"{}\n",
	);
	mkdirSync(join(state, "notify-check"), { recursive: true });
	writeFileSync(join(state, "notify-check", "baseline.json"), "{}\n");
	mkdirSync(join(state, "workflows", "workflow_wt"), { recursive: true });
	writeFileSync(join(cwd, "NOTES.md"), "user work\n");
	const run = { runId: "workflow_wt" };
	const task = {
		taskId: "task-1",
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
	};
	await ensureManagedWorktree(cwd, run, task, {
		cwd,
		safety: { requiresWorktree: true },
	});
	assert.equal(task.worktree.enabled, true);
	const worktree = task.worktree.path;
	assert.ok(existsSync(join(worktree, "NOTES.md")), "user work is copied");
	assert.equal(
		existsSync(join(worktree, ".agent-workflow")),
		false,
		"no run/attempt state in the worktree",
	);
	assert.equal(
		task.worktree.snapshot.untrackedFiles.includes("NOTES.md"),
		true,
	);
	assert.ok(
		task.worktree.snapshot.untrackedFiles.every(
			(file) => !file.startsWith(".agent-workflow/"),
		),
	);
});
