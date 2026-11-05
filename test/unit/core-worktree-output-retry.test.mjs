// Managed-worktree output retries start from the base checkout and reuse the task worktree.
// Preparing a retry from inside that worktree risks removing the cwd before git runs.
// Temporary git repository only; no agent CLI or model calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { repo } from "../helpers/wp42-retention-fixtures.mjs";

const worktree = await import("../../dist/core/worktree.js");
const runtime = await import("../../dist/core/artifact-graph-runtime.js");

test("an output retry of a worktree task reuses its worktree instead of failing with git ENOENT", async () => {
	const cwd = await repo();
	const task = {
		taskId: "task-1",
		specId: "w",
		status: "running",
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		files: {
			output:
				".agent-workflow/workflows/workflow_probe/tasks/task-1/output.log",
			result:
				".agent-workflow/workflows/workflow_probe/tasks/task-1/result.json",
		},
		outputRetry: {
			attempts: 1,
			maxAttempts: 2,
			reason: "workflow_output_invalid",
			message: "control JSON schema failed",
		},
	};
	const run = { runId: "workflow_probe", tasks: [task] };
	const compiled = {
		id: "w",
		cwd,
		safety: { requiresWorktree: true },
		compiledPrompt: "Review the code.",
	};

	await worktree.ensureManagedWorktree(cwd, run, task, compiled);
	const first = task.worktree.path;
	assert.equal(task.cwd, first);
	assert.ok(existsSync(first));

	const retry = await runtime.prepareArtifactGraphRetryTask(
		cwd,
		task,
		compiled,
	);
	assert.equal(retry.cwd, cwd, "the retry starts from the base checkout");
	assert.match(retry.compiledPrompt, /Workflow Output Retry Instructions/);

	await worktree.ensureManagedWorktree(cwd, run, task, retry);
	assert.equal(task.cwd, first);
	assert.equal(task.worktree.path, first);
	assert.equal(task.worktree.baseCwd, cwd);
	assert.match(task.worktree.warning, /reusing existing managed worktree/);
	assert.ok(existsSync(first));
});

test("a retry of a task without a managed worktree keeps its cwd", async () => {
	const cwd = await repo();
	const task = {
		taskId: "task-2",
		specId: "w",
		status: "running",
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		files: { output: "missing.log", result: "missing.json" },
		outputRetry: { attempts: 1, maxAttempts: 2, message: "invalid" },
	};
	const retry = await runtime.prepareArtifactGraphRetryTask(cwd, task, {
		id: "w",
		cwd: "/elsewhere",
		safety: { requiresWorktree: false },
		compiledPrompt: "x",
	});
	assert.equal(retry.cwd, cwd);
});
