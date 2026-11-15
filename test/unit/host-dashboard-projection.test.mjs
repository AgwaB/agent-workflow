// WP43: pure projections; synthetic host records cover facts omitted by a pretty mockup.
import assert from "node:assert/strict";
import test from "node:test";
import {
	projectRun,
	projectRunSummary,
	projectNeedsYou,
} from "../../dist/hosts/dashboard/projection.js";
import { redactDashboardData } from "../../dist/hosts/dashboard/source.js";
import { hostTextRedactor } from "../../dist/hosts/redaction.js";

const AT = "2026-10-29T08:10:00.000Z";
function data() {
	const tasks = [
		{
			taskId: "task-1",
			specId: "review.item",
			stageId: "review",
			kind: "foreach",
			agent: "scout",
			status: "completed",
			statusDetail: "foreach_materialized",
			runtime: {},
			files: {},
		},
		{
			taskId: "task-2",
			specId: "review.a",
			stageId: "review",
			kind: "foreach",
			agent: "scout",
			status: "pending",
			statusDetail: "retry_backoff",
			dependsOn: ["plan.main"],
			foreachGenerated: { placeholderSpecId: "review.item" },
			runtime: { executor: "codex", model: "gpt-test", effort: "low" },
			startedAt: AT,
			files: { output: "task/output.log" },
			launchRetry: {
				attempts: 2,
				maxAttempts: 4,
				reason: "rate limit",
				nextEligibleAt: "2026-10-29T08:16:40.000Z",
			},
			usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
			worktree: { enabled: true, path: ".worktrees/a", branch: "aw/a" },
		},
		{
			taskId: "task-3",
			specId: "adaptive.a",
			stageId: "adaptive",
			kind: "single",
			agent: "reader",
			status: "blocked",
			statusDetail: "executor_needs_decision",
			dynamicGenerated: { controllerSpecId: "adaptive.controller" },
			runtime: { executor: "claude" },
			files: {},
			completedAt: AT,
		},
	];
	const run = {
		runId: "workflow_example",
		name: "review",
		type: "artifact-graph",
		status: "running",
		createdAt: AT,
		updatedAt: AT,
		executor: "claude",
		executors: ["claude", "codex"],
		permissionMode: "safe",
		taskSummary: {
			total: 3,
			completed: 1,
			pending: 1,
			blocked: 1,
			failed: 0,
			running: 0,
			skipped: 0,
			interrupted: 0,
		},
		reportArtifacts: [],
		live: true,
		tasks: tasks.map(({ taskId, specId, status, statusDetail }) => ({
			taskId,
			specId,
			status,
			statusDetail,
		})),
	};
	const shown = {
		kind: "run",
		// The workflow description is not the user's task; `task` comes from the host API's runtimeTask.
		run: { ...run, description: "Bundled review workflow", tasks },
		taskLogIds: ["task-2"],
		runtimeTask: "Review the checkout",
	};
	return { run, shown };
}

test("projection preserves retry countdown, foreach/dynamic items, runtime and absent cost", () => {
	const { run, shown } = data();
	const result = projectRun(run, shown);
	assert.equal(result.live, true);
	assert.deepEqual(result.executors, ["claude", "codex"]);
	assert.equal(result.task, "Review the checkout");
	// 2026-11-03 (owner: four "deep-review" rows looked the same): summaries carry the task on
	// one line, bounded.
	assert.equal(result.taskPreview, "Review the checkout");
	const long = projectRunSummary(run, {
		...shown,
		runtimeTask: `  Review\n\n the   checkout ${"x".repeat(300)}`,
	}).taskPreview;
	assert.equal(long.length, 140);
	assert.match(long, /^Review the checkout x+…$/);
	assert.equal(
		projectRunSummary(run, { ...shown, runtimeTask: undefined }).taskPreview,
		undefined,
	);
	assert.equal(
		projectRun(run, { ...shown, runtimeTask: undefined }).task,
		undefined,
		"no task text when the host API has none (never the description)",
	);
	assert.equal(result.permissionMode, "safe");
	assert.equal(result.tasks[0].placeholder, true);
	assert.equal(result.tasks[0].generated, false);
	const retry = result.tasks[1];
	assert.deepEqual(retry.retry, {
		attempt: 2,
		maxAttempts: 4,
		reason: "rate limit",
		nextRetryAt: "2026-10-29T08:16:40.000Z",
	});
	assert.equal(retry.generated, true);
	assert.equal(retry.placeholder, false);
	assert.equal(retry.executor, "codex");
	assert.equal(retry.model, "gpt-test");
	assert.equal(retry.effort, "low");
	assert.deepEqual(retry.dependsOn, ["plan.main"]);
	assert.deepEqual(retry.worktree, { path: ".worktrees/a", branch: "aw/a" });
	assert.equal(retry.usage.costUsd, null);
	assert.equal(result.usage.costUsd, null);
	assert.equal(result.usage.tasksReporting, 1);
	assert.equal(result.tasks[2].usage, null);
	assert.equal(result.tasks[2].generated, true);
	assert.deepEqual(
		result.tasks.map((task) => task.hasLogs),
		[false, true, false],
	);
	assert.deepEqual(result.needsYou, [
		{
			kind: "decision",
			taskId: "task-3",
			title: "adaptive needs a decision",
			since: AT,
		},
	]);
	assert.equal("files" in retry, false);
	assert.equal("record" in result, false);
});

test("failed/blocked runs need attention even without approvals; live is not inferred from status", () => {
	const { run, shown } = data();
	for (const status of ["failed", "blocked"]) {
		run.status = status;
		run.tasks = [];
		delete run.live;
		assert.equal(projectRunSummary(run, shown).live, false);
		assert.equal(projectNeedsYou(run)[0].kind, "failed");
	}
});

// 2026-11-13 (owner): "Needs you" lists what the host reminders list. An interrupted run is one of
// them unless the user stopped it; a child run never is.
test("an interrupted run needs you unless the user stopped it", () => {
	const { run } = data();
	run.status = "interrupted";
	const stopped = (statusDetail, extra = {}) => {
		run.tasks = [
			{
				taskId: "task-1",
				specId: "a",
				status: "completed",
				statusDetail: "completed",
			},
			{ taskId: "task-2", specId: "b", status: "interrupted", statusDetail },
		];
		Object.assign(run, extra);
		return projectNeedsYou(run);
	};
	assert.deepEqual(stopped("driver_lost", { statusDetail: "driver_lost" }), [
		{
			kind: "stopped",
			title: "Stopped, host closed",
			taskId: "task-2",
			since: run.updatedAt,
		},
	]);
	delete run.statusDetail;
	assert.equal(stopped("cancelled")[0].title, "Stopped unexpectedly");
	assert.deepEqual(stopped("workflow_stopped"), []);
	assert.deepEqual(
		stopped("driver_lost", { parentRunId: "workflow_parent" }),
		[],
	);
});

test("a verdict-gated failure is an outcome, not a need: verdictGate is carried and Needs you stays empty", () => {
	const { run, shown } = data();
	run.status = "failed";
	run.tasks = [];
	run.verdict = "INCONCLUSIVE";
	run.verdictGate = true;
	run.reportArtifacts = [{ path: "tasks/task-8/final-report.md" }];
	const summary = projectRunSummary(run, shown);
	assert.equal(summary.verdictGate, true);
	assert.equal(summary.verdict, "INCONCLUSIVE");
	assert.equal(summary.reportAvailable, true);
	assert.deepEqual(summary.needsYou, []);
	delete run.verdictGate;
	assert.equal(projectRunSummary(run, shown).needsYou[0].kind, "failed");
});

test("output repair, elapsed zero, reported cost zero and rollup are retained without inventing usage", () => {
	const { run, shown } = data();
	const task = shown.run.tasks[1];
	delete task.launchRetry;
	task.outputRetry = { attempts: 3, maxAttempts: 3, reason: "invalid JSON" };
	task.elapsedMs = 0;
	task.usage.costUsd = 0;
	assert.equal(projectRun(run, shown).tasks[1].retry.attempt, 3);
	assert.equal(projectRun(run, shown).tasks[1].elapsedMs, 0);
	assert.equal(projectRun(run, shown).usage.costUsd, 0);
	shown.run.usage = {
		tasksReporting: 1,
		taskCount: 3,
		inputTokens: 200,
		cacheReadInputTokens: 100,
		costUsd: null,
	};
	assert.deepEqual(projectRun(run, shown).usage, {
		tasksReporting: 1,
		taskCount: 3,
		input: 200,
		cacheRead: 100,
		costUsd: null,
	});
	delete shown.run.usage;
	delete task.usage;
	assert.equal(projectRun(run, shown).usage, null);
});

test("a task on the executor's default model shows the model its usage reported", () => {
	// 2026-11-03: the inspector said "No model" for Claude tasks launched without a model.
	const { run, shown } = data();
	const task = shown.run.tasks[2];
	assert.equal(projectRun(run, shown).tasks[2].model, undefined);
	assert.equal("reportedModel" in projectRun(run, shown).tasks[2], false);
	task.usage = { inputTokens: 1, outputTokens: 1, model: "claude-sonnet-5-5" };
	assert.equal(projectRun(run, shown).tasks[2].model, "claude-sonnet-5-5");
	// A model the run asked for still wins over the reported one.
	task.runtime.model = "opus";
	assert.equal(projectRun(run, shown).tasks[2].model, "opus");
	assert.equal(
		projectRun(run, shown).tasks[2].reportedModel,
		"claude-sonnet-5-5",
	);
	delete task.usage;
	assert.equal(projectRun(run, shown).tasks[2].model, "opus");
	assert.equal("reportedModel" in projectRun(run, shown).tasks[2], false);
});

test("reportedModel allowlists recorded usage only, not configuration or arbitrary metadata", () => {
	const { run, shown } = data();
	const task = shown.run.tasks[1];
	shown.run.configuration = {
		schema: "agent-workflow-configuration-v1",
		capture: {
			key: "private-key",
			identity: { physicalSpecPath: "/private/source" },
		},
		slots: {
			read: {
				executor: { source: "project-default", value: "codex" },
				model: { source: "project-default", value: "configured-plan" },
				effort: { source: "unresolved" },
			},
		},
		shadowed: [],
	};
	task.usage = {
		inputTokens: 1,
		model: "executor-report",
		providerVerified: true,
		privatePath: "/private/usage",
		secret: "never-forward",
	};
	const projected = projectRun(run, shown);
	assert.equal(projected.tasks[1].model, "gpt-test");
	assert.equal(projected.tasks[1].reportedModel, "executor-report");
	assert.equal(
		projected.configuration.slots.read.model.value,
		"configured-plan",
	);
	assert.doesNotMatch(
		JSON.stringify(projected),
		/physicalSpecPath|private-key|private\/usage|providerVerified|never-forward/,
	);
	for (const model of [undefined, null, "", {}, 123]) {
		task.usage.model = model;
		assert.equal("reportedModel" in projectRun(run, shown).tasks[1], false);
	}
});

test("log availability uses host-verified files, not merely planned paths", () => {
	const { run, shown } = data();
	shown.taskLogIds = [];
	assert.equal(projectRun(run, shown).tasks[1].hasLogs, false);
});

test("structured text redaction preserves JSON types, quotes and newlines", () => {
	const secret = "test-secret-abcdefghijklmnop";
	const result = redactDashboardData(
		{
			text: `a \"quote\"\n${secret}`,
			cost: null,
			tasks: [{ message: `api_key=${secret}` }],
		},
		hostTextRedactor({ SERVICE_TOKEN: secret }),
	);
	assert.equal(JSON.stringify(result).includes(secret), false);
	assert.match(result.text, /a "quote"\n/);
	assert.equal(result.cost, null);
});

test("activity is running-only, bounded, validated and strictly allowlisted", () => {
	const { run, shown } = data();
	const task = shown.run.tasks[1];
	task.status = "running";
	task.activity = {
		kind: "read",
		label: "Reading src/core/store.ts",
		at: AT,
		input: "never expose",
		output: "never expose",
	};
	assert.deepEqual(projectRun(run, shown).tasks[1].activity, {
		kind: "read",
		label: "Reading src/core/store.ts",
		at: AT,
	});
	task.activity.label = "Reading \u0000\n" + "a".repeat(200);
	const bounded = projectRun(run, shown).tasks[1].activity;
	assert.equal(bounded.label.length, 120);
	assert.doesNotMatch(bounded.label, /[\u0000-\u001f]/);
	for (const kind of ["invalid", null, {}, "__proto__"]) {
		task.activity.kind = kind;
		assert.equal(projectRun(run, shown).tasks[1].activity, undefined);
	}
	task.activity.kind = "read";
	for (const at of [null, "invalid", "2026-11-01T00:00:00Z\n<script>"]) {
		task.activity.at = at;
		assert.equal(projectRun(run, shown).tasks[1].activity, undefined);
	}
	task.activity.at = AT;
	for (const status of [
		"pending",
		"completed",
		"failed",
		"interrupted",
		"blocked",
		"skipped",
	]) {
		task.status = status;
		assert.equal("activity" in projectRun(run, shown).tasks[1], false);
	}
});

test("run summaries count agents, not placeholders, helpers or engine controllers", () => {
	const { run, shown } = data();
	shown.run.tasks.push({
		taskId: "task-s",
		specId: "prep.main",
		stageId: "prep",
		kind: "support",
		status: "completed",
		statusDetail: "support",
		runtime: {},
		files: {},
	});
	for (const kind of ["dynamic", "loop"])
		shown.run.tasks.push({
			...shown.run.tasks.at(-1),
			taskId: `task-${kind}`,
			kind,
		});
	const summary = projectRunSummary(run, shown);
	const agents = shown.run.tasks.filter(
		(task) =>
			!["support", "dynamic", "loop"].includes(task.kind) &&
			!(
				task.kind === "foreach" &&
				!task.foreachGenerated &&
				!task.dynamicGenerated
			),
	);
	assert.equal(summary.agentSummary.total, agents.length);
	assert.ok(summary.agentSummary.total < shown.run.tasks.length);
	assert.equal(
		summary.agentSummary.completed,
		agents.filter((task) => task.status === "completed").length,
	);
	assert.equal(
		projectRunSummary(run).agentSummary,
		undefined,
		"no shown record, no agent count",
	);
	shown.run.tasks = shown.run.tasks.filter((task) =>
		["support", "dynamic", "loop"].includes(task.kind),
	);
	assert.deepEqual(
		projectRunSummary(run, shown).agentSummary,
		{ completed: 0, total: 0 },
		"a controller-only run must not fall back to counting tasks as agents",
	);
});

// 2026-11-12 (owner): the overview needs per-run cost, agent reporting counts and active time in
// the run list, so the browser never fetches every run's detail.
const MINUTE = 60_000;
function ranTasks() {
	const { run, shown } = data();
	const at = (minutes) =>
		new Date(Date.parse(AT) + minutes * MINUTE).toISOString();
	shown.run.tasks = [
		{
			taskId: "t1",
			specId: "triage.main",
			stageId: "triage",
			kind: "single",
			status: "completed",
			statusDetail: "completed",
			startedAt: at(0),
			completedAt: at(2),
			usage: { costUsd: 0.1 },
		},
		// Two parallel reviewers overlap: 2–6 and 3–5 count once.
		{
			taskId: "t2",
			specId: "reviewers.a",
			stageId: "reviewers",
			kind: "foreach",
			foreachGenerated: { placeholderSpecId: "reviewers.item" },
			status: "completed",
			statusDetail: "completed",
			startedAt: at(2),
			completedAt: at(6),
			usage: { costUsd: 0.2 },
		},
		{
			taskId: "t3",
			specId: "reviewers.b",
			stageId: "reviewers",
			kind: "foreach",
			foreachGenerated: { placeholderSpecId: "reviewers.item" },
			status: "completed",
			statusDetail: "completed",
			startedAt: at(3),
			completedAt: at(5),
		},
		// A code step: never reports cost, so it is not in the agent ratio.
		{
			taskId: "t4",
			specId: "dedup.main",
			stageId: "dedup",
			kind: "support",
			status: "completed",
			statusDetail: "completed",
			startedAt: at(6),
			completedAt: at(6.5),
		},
		// Then the run sat for 50 minutes before its last step.
		{
			taskId: "t5",
			specId: "report.main",
			stageId: "report",
			kind: "single",
			status: "failed",
			statusDetail: "failed",
			startedAt: at(60),
			completedAt: at(61),
		},
	];
	shown.run.usage = undefined;
	return { run, shown, at };
}

test("run summaries carry cost with an agent-only reporting ratio: code steps are not in the denominator", () => {
	const { run, shown } = ranTasks();
	const summary = projectRunSummary(run, shown);
	// Four agents (triage, two reviewers, report); the code step is left out; two reported cost.
	assert.deepEqual(summary.cost, {
		costUsd: 0.30000000000000004,
		agentsReporting: 2,
		agentTotal: 4,
	});
	assert.equal(projectRun(run, shown).cost.agentTotal, 4);
	// The run's own rollup, when the engine wrote one, is the total the run view shows.
	shown.run.usage = { tasksReporting: 2, taskCount: 5, costUsd: 0.31 };
	assert.equal(projectRunSummary(run, shown).cost.costUsd, 0.31);
});

test("unknown cost is null, never zero; a reported zero stays zero", () => {
	const { run, shown } = ranTasks();
	for (const task of shown.run.tasks) delete task.usage;
	assert.deepEqual(projectRunSummary(run, shown).cost, {
		costUsd: null,
		agentsReporting: 0,
		agentTotal: 4,
	});
	shown.run.tasks[0].usage = { costUsd: 0 };
	assert.deepEqual(projectRunSummary(run, shown).cost, {
		costUsd: 0,
		agentsReporting: 1,
		agentTotal: 4,
	});
	// No agent detail (a status-only summary) has no aggregate at all.
	assert.equal("cost" in projectRunSummary(run), false);
	assert.equal("activeMs" in projectRunSummary(run), false);
});

test("active time is the union of task intervals: overlap counts once and idle waiting not at all", () => {
	const { run, shown } = ranTasks();
	// 0–2, 2–6 (with 3–5 inside), 6–6.5 and 60–61: 6.5 + 1 minutes, not the hour between created and updated.
	assert.equal(projectRunSummary(run, shown).activeMs, 7.5 * MINUTE);
});

test("active time counts a running task until now, and a task with no completion by its elapsed time", () => {
	const { run, shown, at } = ranTasks();
	shown.run.tasks = [
		{
			taskId: "a",
			specId: "a.main",
			stageId: "a",
			kind: "single",
			status: "completed",
			statusDetail: "completed",
			startedAt: at(0),
			completedAt: at(1),
		},
		{
			taskId: "b",
			specId: "b.main",
			stageId: "b",
			kind: "single",
			status: "running",
			statusDetail: "running",
			startedAt: at(10),
		},
		{
			taskId: "c",
			specId: "c.main",
			stageId: "c",
			kind: "single",
			status: "interrupted",
			statusDetail: "interrupted",
			startedAt: at(20),
			elapsedMs: 30_000,
		},
		// Waiting for a retry: a launch claim stamped its start, but it is not running.
		{
			taskId: "e",
			specId: "e.main",
			stageId: "e",
			kind: "single",
			status: "pending",
			statusDetail: "retry_backoff",
			startedAt: at(12),
		},
		// Never started: nothing to count (an interrupted task that had not begun).
		{
			taskId: "d",
			specId: "d.main",
			stageId: "d",
			kind: "single",
			status: "interrupted",
			statusDetail: "interrupted",
			completedAt: at(30),
		},
	];
	assert.equal(
		projectRunSummary(run, shown, false, Date.parse(at(13))).activeMs,
		(1 + 3 + 0.5) * MINUTE,
	);
	shown.run.tasks = [];
	assert.equal(projectRunSummary(run, shown).activeMs, 0);
});
