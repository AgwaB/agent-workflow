// New in agent-workflow (WP39b, live bundle 5 O16): the auto classifier's one-shot requests leave
// `.agent-workflow/workflows/auto-router-runs/run_*`. They are pruned with the run rules (terminal
// only, `--keep`, `--older-than`, dry run without `--yes`), the directory never makes prune
// uncertain about the workflow runs next to it, and it never shows up as a run. Synthetic records;
// no agent CLI, no model call.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { pruneWorkflowRuns, formatWorkflowPruneSummary } = await import(
	"../../dist/core/run-retention.js"
);
const api = await import("../../dist/hosts/api.js");

const roots = [];
after(async () => {
	for (const root of roots)
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const daysAgo = (days) =>
	new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

function workflowRun(cwd, runId, updatedAt) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			name: "wf",
			type: "workflow",
			createdAt: updatedAt,
			updatedAt,
			tasks: [
				{
					taskId: "task-1",
					specId: "a",
					displayName: "a",
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
				},
			],
		}),
	);
}

function classifierRun(cwd, runId, status, updatedAt) {
	const dir = join(
		cwd,
		".agent-workflow",
		"workflows",
		"auto-router-runs",
		runId,
	);
	mkdirSync(join(dir, "attempts", `attempt_${runId}`), { recursive: true });
	writeFileSync(
		join(dir, "run.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId,
			mode: "single",
			status,
			backend: "codex",
			cwd,
			runsDir: ".agent-workflow/workflows/auto-router-runs",
			startedAt: updatedAt,
			updatedAt,
			attempts: [],
			correlationId: "workflow-auto-compare-v1",
		}),
	);
	writeFileSync(
		join(dir, "attempts", `attempt_${runId}`, "output.log"),
		'{"status":"no-fit"}\n',
	);
}

// WP42 (finding 3): prune deletes only runtime-generated run ids (`run_<base36 ms>_<6 hex>`).
const RUN_OLD = "run_mvsa0001_0a0b0c";
const RUN_NEW = "run_mvsa0002_1a1b1c";
const RUN_LIVE = "run_mvsa0003_2a2b2c";

test("prune: classifier request runs follow the run rules and never block workflow-run pruning or appear as runs", async () => {
	const cwd = realpathSync(await mkdtemp(join(tmpdir(), "aw-wp39b-router-")));
	roots.push(cwd);
	workflowRun(cwd, "workflow_old", daysAgo(10));
	const routerRoot = join(
		cwd,
		".agent-workflow",
		"workflows",
		"auto-router-runs",
	);
	classifierRun(cwd, RUN_OLD, "completed", daysAgo(9));
	classifierRun(cwd, RUN_NEW, "failed", daysAgo(0));
	classifierRun(cwd, RUN_LIVE, "running", daysAgo(8));
	mkdirSync(join(routerRoot, ".locks"), { recursive: true });

	// Listings never show the classifier directory or its runs.
	const status = await api.statusAction({ cwd, env: process.env }, {});
	assert.doesNotMatch(status.text, /auto-router-runs|run_mvsa/);

	const preview = await pruneWorkflowRuns(cwd, { keep: 0, olderThanDays: 1 });
	assert.equal(preview.dryRun, true);
	const [planned] = preview.runs;
	assert.equal(planned.runId, "workflow_old");
	assert.equal(planned.protected, false, planned.error);
	assert.deepEqual(
		preview.autoRouterRuns.map(({ runId, status: s }) => [runId, s]),
		[[RUN_OLD, "completed"]],
		"terminal and older than the filter only",
	);
	assert.match(
		formatWorkflowPruneSummary(preview),
		new RegExp(
			`Classifier requests that would be deleted:\\n- ${RUN_OLD} completed`,
		),
	);
	assert.ok(existsSync(join(routerRoot, RUN_OLD)), "a dry run deletes nothing");

	const done = await pruneWorkflowRuns(cwd, {
		keep: 0,
		olderThanDays: 1,
		yes: true,
	});
	assert.equal(done.runs[0].deleted, true, JSON.stringify(done));
	assert.equal(done.autoRouterRuns[0].deleted, true);
	assert.equal(existsSync(join(routerRoot, RUN_OLD)), false);
	assert.ok(existsSync(join(routerRoot, RUN_NEW)), "newer than the filter");
	assert.ok(existsSync(join(routerRoot, RUN_LIVE)), "not terminal");
	assert.ok(existsSync(join(routerRoot, ".locks")));

	// --keep counts classifier requests separately (newest first).
	const kept = await pruneWorkflowRuns(cwd, { keep: 1, yes: true });
	assert.deepEqual(kept.autoRouterRuns, []);
	assert.ok(existsSync(join(routerRoot, RUN_NEW)));
});
