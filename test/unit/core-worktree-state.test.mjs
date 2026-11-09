// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP39b, live bundle 5 O7): managed worktrees and the project's run/attempt
// state. The dirty-checkout snapshot never copies `.agent-workflow/` (run and attempt state of this
// and other tasks) into a worktree, even when the project does not git-ignore it. Real git in a
// temporary repository; no agent CLI, no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
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
	const state = join(stateDir(cwd), ".agent-workflow");
	mkdirSync(join(state, "worker-runs", "workflow_other", "task-9"), {
		recursive: true,
	});
	writeFileSync(
		join(state, "worker-runs", "workflow_other", "task-9", "run.json"),
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

const { pruneWorkflowRuns, formatWorkflowPruneSummary } = await import(
	"../../dist/core/run-retention.js"
);

/** A terminal run whose tasks ran in managed worktrees (created with the real helper). */
async function runWithWorktrees(cwd, runId, taskIds) {
	const runDir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
	mkdirSync(runDir, { recursive: true });
	const tasks = [];
	for (const taskId of taskIds) {
		const task = {
			taskId,
			specId: taskId,
			displayName: taskId,
			status: "completed",
			statusDetail: "completed",
			runtime: {},
			files: {
				systemPrompt: "",
				taskPrompt: "",
				output: "",
				stderr: "",
				result: "",
			},
			cwd,
			worktree: {
				enabled: false,
				path: null,
				branch: null,
				baseCwd: null,
				warning: null,
			},
		};
		await ensureManagedWorktree(cwd, { runId }, task, {
			cwd,
			safety: { requiresWorktree: true },
		});
		tasks.push(task);
	}
	const at = new Date(Date.now() - 60_000).toISOString();
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({
			runId,
			name: "wt",
			type: "workflow",
			createdAt: at,
			updatedAt: at,
			tasks,
		}),
	);
	return tasks;
}

test("prune: managed worktrees are listed in the dry run and removed with --yes; unmerged branches stay", async () => {
	const cwd = await repo();
	writeFileSync(join(cwd, ".gitignore"), ".agent-workflow/\n");
	git(cwd, ["add", ".gitignore"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "--no-verify", "-m", "ignore"]);
	const [dirty, committed] = await runWithWorktrees(cwd, "workflow_wtprune", [
		"task-1",
		"task-2",
	]);
	writeFileSync(join(dirty.cwd, "NOTES.md"), "uncommitted result\n");
	writeFileSync(join(committed.cwd, "RESULT.md"), "committed result\n");
	git(committed.cwd, ["add", "RESULT.md"]);
	git(committed.cwd, [
		"commit",
		"-q",
		"--no-gpg-sign",
		"--no-verify",
		"-m",
		"result",
	]);

	const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
	assert.equal(preview.dryRun, true);
	const [planned] = preview.runs;
	assert.deepEqual(
		planned.worktrees.map(({ path, branch, dirty: d, commits }) => ({
			path,
			branch,
			dirty: d,
			commits,
		})),
		[
			{
				path: relative(cwd, dirty.cwd),
				branch: "agent-workflow/workflow_wtprune-task-1",
				dirty: true,
				commits: 0,
			},
			{
				path: relative(cwd, committed.cwd),
				branch: "agent-workflow/workflow_wtprune-task-2",
				dirty: false,
				commits: 1,
			},
		],
	);
	const text = formatWorkflowPruneSummary(preview);
	assert.ok(
		text.includes(
			`Worktree: ${relative(cwd, dirty.cwd)} (branch agent-workflow/workflow_wtprune-task-1; uncommitted changes)`,
		),
		text,
	);
	assert.match(
		text,
		/1 commit\(s\) not in the checkout's HEAD; the branch is kept/,
	);
	// The dry run changes nothing.
	assert.ok(existsSync(join(dirty.cwd, "NOTES.md")));

	const done = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(done.runs[0].deleted, true, JSON.stringify(done));
	assert.deepEqual(
		done.runs[0].worktrees.map((w) => [w.removed, w.branchDeleted]),
		[
			[true, true],
			[true, false],
		],
	);
	assert.equal(existsSync(dirty.cwd), false);
	assert.equal(existsSync(committed.cwd), false);
	const listed = git(cwd, ["worktree", "list", "--porcelain"]);
	assert.doesNotMatch(listed, /workflow_wtprune/);
	const branches = git(cwd, ["branch", "--list", "agent-workflow/*"]);
	assert.doesNotMatch(branches, /workflow_wtprune-task-1/);
	assert.match(
		branches,
		/workflow_wtprune-task-2/,
		"unmerged result branch kept",
	);
	assert.match(formatWorkflowPruneSummary(done), /removed, branch kept/);
});

test("status, show and inspect name a worktree task's worktree path and branch", async () => {
	const cwd = await repo();
	writeFileSync(join(cwd, ".gitignore"), ".agent-workflow/\n");
	git(cwd, ["add", ".gitignore"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "--no-verify", "-m", "ignore"]);
	await runWithWorktrees(cwd, "workflow_wtshow", ["task-1"]);
	const format = await import("../../dist/core/engine-format.js");
	const store = await import("../../dist/core/store.js");
	const run = await store.readRunRecord(cwd, "workflow_wtshow");
	const expected = `Worktree: ${run.tasks[0].worktree.path} (branch agent-workflow/workflow_wtshow-task-1)`;
	for (const text of [
		format.formatHumanRunStatus(run),
		format.formatHumanRunDetails(run),
		format.formatHumanRunOutcome(run),
	])
		assert.ok(text.includes(expected), text);
	const api = await import("../../dist/hosts/api.js");
	const inspected = await api.inspectAction(
		{ cwd, env: process.env, host: "cli" },
		{ runId: "workflow_wtshow" },
	);
	assert.match(inspected.text, /- task-1: completed\//u);
	assert.ok(
		inspected.text.includes(
			`    worktree: ${run.tasks[0].worktree.path} (branch agent-workflow/workflow_wtshow-task-1)`,
		),
		inspected.text,
	);
});

test("runtime: shared mode with workspace.path runs in that directory; the state root stays cwd", async () => {
	const { resolveWorkspace } = await import(
		"../../dist/runtime/workspace/worktree.js"
	);
	const cwd = await repo();
	const elsewhere = join(cwd, "sub");
	mkdirSync(elsewhere);
	assert.deepEqual(
		await resolveWorkspace({
			cwd,
			input: { workspace: { mode: "shared", path: elsewhere } },
		}),
		{ mode: "shared", baseCwd: cwd, cwd: elsewhere, worktreePath: null },
	);
	assert.deepEqual(
		await resolveWorkspace({ cwd, input: { workspace: "shared" } }),
		{ mode: "shared", baseCwd: cwd, cwd, worktreePath: null },
	);
	await assert.rejects(
		resolveWorkspace({
			cwd,
			input: { workspace: { mode: "shared", path: join(cwd, "missing") } },
		}),
		/not an existing directory/,
	);
	// Nothing was created.
	assert.equal(git(cwd, ["worktree", "list"]).trim().split("\n").length, 1);
});

test("a worktree task runs in its worktree; its attempt state is written under the project's .agent-workflow/ (real runtime, fixture executor)", async () => {
	const { workflowFixtureDescriptor, readFixtureLog } = await import(
		"../helpers/workflow-executor-fixture.mjs"
	);
	const core = await import("../../dist/core/index.js");
	const api = await import("../../dist/hosts/api.js");
	const slots = await import("../../dist/core/launch-slots.js");
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	const cwd = await repo();
	mkdirSync(join(cwd, "workflows", "wt-write"), { recursive: true });
	mkdirSync(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".agent-workflow", "agents", "writer.md"),
		"---\nname: writer\ndescription: writes notes\ntools: read, write\nreadOnly: false\n---\nYou write notes.\n",
	);
	writeFileSync(
		join(cwd, "workflows", "wt-write", "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wt-write",
			description: "writes in a worktree",
			defaults: {
				agent: "writer",
				readOnly: false,
				tools: ["read", "write"],
				worktreePolicy: "on",
			},
			artifactGraph: {
				stages: [{ id: "w", type: "single", prompt: "Write notes." }],
			},
		}),
	);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "--no-verify", "-m", "spec"]);
	const effectLog = join(cwd, "..", `${basename(cwd)}-effects.jsonl`);
	roots.push(effectLog);
	const unregister = core.registerWorkflowExecutor(
		workflowFixtureDescriptor({ id: "wt-fixture", effectLog }),
	);
	try {
		const env = {
			...process.env,
			AGENT_WORKFLOW_HOME: join(cwd, "..", `${basename(cwd)}-home`),
		};
		roots.push(env.AGENT_WORKFLOW_HOME);
		const launched = await api.runWorkflowAction(
			{ cwd, env },
			{
				workflow: "wt-write",
				task: "Write notes.",
				executor: "wt-fixture",
				detach: true,
			},
		);
		const runId = launched.data.runId;
		assert.ok(runId, launched.text);
		let waited;
		do
			waited = await api.waitAction({ cwd, env }, { runId, timeoutMs: 10_000 });
		while (waited.data.stillRunning);
		assert.equal(waited.data.status, "completed", waited.text);
		const store = await import("../../dist/core/store.js");
		const run = await store.readRunRecord(cwd, runId);
		const [task] = run.tasks;
		assert.equal(task.worktree.enabled, true);
		const submit = readFixtureLog(effectLog).find(
			(entry) => entry.type === "submit",
		);
		assert.equal(
			submit.cwd,
			task.worktree.path,
			"the worker runs in the worktree",
		);
		assert.ok(
			submit.artifactsDir.startsWith(
				join(
					stateDir(cwd),
					".agent-workflow",
					"worker-runs",
					runId,
					task.taskId,
				),
			),
			submit.artifactsDir,
		);
		// (The committed agent file under .agent-workflow/agents/ is part of HEAD.)
		assert.equal(
			existsSync(join(task.worktree.path, ".agent-workflow", "worker-runs")),
			false,
			"no attempt state inside the worktree",
		);
		assert.equal(
			existsSync(join(task.worktree.path, ".agent-workflow", "workflows")),
			false,
		);
	} finally {
		unregister();
	}
});
