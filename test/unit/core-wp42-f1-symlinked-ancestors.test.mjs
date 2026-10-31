// New in agent-workflow (WP42, WP39b review finding 1, major): auto-router pruning never follows a symlinked ancestor of
// `.agent-workflow/workflows/auto-router-runs` (it fails closed) and rechecks the chain right before
// deletion.
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

for (const ancestor of [".agent-workflow", "workflows", "auto-router-runs"])
	test(`F1: prune fails closed on a symlinked ${ancestor} ancestor of the classifier requests`, async () => {
		const cwd = await temp();
		const outside = await temp();
		let router;
		if (ancestor === ".agent-workflow") {
			await symlink(outside, join(cwd, ".agent-workflow"));
			router = join(outside, "workflows", "auto-router-runs");
		} else if (ancestor === "workflows") {
			await mkdir(join(cwd, ".agent-workflow"));
			await symlink(outside, join(cwd, ".agent-workflow", "workflows"));
			router = join(outside, "auto-router-runs");
		} else {
			await mkdir(join(cwd, ".agent-workflow", "workflows"), {
				recursive: true,
			});
			await symlink(outside, join(cwd, ROUTER_RUNS));
			router = outside;
		}
		const id = classifierId();
		await classifier(router, id);
		const preview = await pruneWorkflowRuns(cwd, { keep: 0 });
		assert.equal(
			preview.autoRouterRuns.length,
			0,
			"nothing outside is offered for deletion",
		);
		const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		assert.equal(
			summary.autoRouterRuns.some((run) => run.deleted),
			false,
			JSON.stringify(summary),
		);
		assert.ok(
			existsSync(join(router, id, "valuable.txt")),
			"external data kept",
		);
		if (ancestor !== "auto-router-runs")
			assert.match(summary.error ?? "", /unsafe retention root/);
	});

test("F1: a classifier directory swapped for a symlink after selection is not deleted (recheck before deletion)", async () => {
	const cwd = await temp();
	const outside = await temp();
	const router = join(cwd, ROUTER_RUNS);
	const id = classifierId();
	await classifier(router, id);
	retention.setWorkflowPruneBeforeClassifierDeleteForTests(async () => {
		await rm(join(outside, "moved"), {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rename(router, join(outside, "moved"));
		await symlink(join(outside, "moved"), router);
	});
	try {
		const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		assert.equal(
			summary.autoRouterRuns[0]?.deleted,
			false,
			JSON.stringify(summary),
		);
		assert.ok(summary.autoRouterRuns[0]?.error);
		assert.ok(existsSync(join(outside, "moved", id, "valuable.txt")));
	} finally {
		retention.setWorkflowPruneBeforeClassifierDeleteForTests(undefined);
	}
});
