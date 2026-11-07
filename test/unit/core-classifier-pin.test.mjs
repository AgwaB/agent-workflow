import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP42, WP39b review finding 5, minor): a classifier request is pinned from launch until its
// output is consumed; prune honors the pin and rechecks terminal status and identity right before
// deleting.
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

test("prune keeps a terminal classifier result until its active caller has consumed it", async () => {
	const { setTaskRuntimeApiForTests } = await import(
		"../../dist/core/runtime-port.js"
	);
	const { recommendWorkflowAuto } = await import(
		"../../dist/core/workflow-router.js"
	);
	const { autoComparisonText, workflowFixtureDescriptor } = await import(
		"../helpers/workflow-executor-fixture.mjs"
	);
	const { registerWorkflowExecutor } = await import("../../dist/core/index.js");
	const cwd = await temp();
	const unregister = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: "wp42-stub",
			effectLog: join(cwd, "unused.log"),
		}),
	);
	const agent = join(cwd, ".agent-workflow", "agents", "unit.md");
	await mkdir(dirname(agent), { recursive: true });
	await writeFile(
		agent,
		"---\nname: unit\ndescription: unit\ntools: read\nreadOnly: true\n---\nRead only.\n",
	);
	await json(join(cwd, "workflows", "review", "spec.json"), {
		schemaVersion: 1,
		name: "review",
		description: "Read-only review",
		defaults: { agent: "unit", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "review", type: "single", prompt: "Review." }],
		},
	});
	const runId = classifierId();
	const router = join(stateDir(cwd), ROUTER_RUNS);
	let during;
	setTaskRuntimeApiForTests({
		async runWorker(options) {
			const attemptId = "attempt_consuming";
			const now = new Date().toISOString();
			await classifier(router, runId, {
				cwd,
				startedAt: now,
				updatedAt: now,
				completedAt: now,
			});
			const output = join(router, runId, "attempts", attemptId, "output.log");
			await mkdir(dirname(output), { recursive: true });
			await writeFile(output, autoComparisonText(options.task, true));
			// Terminal publication done; prune before the caller reads the output.
			during = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
			return {
				runId,
				attemptId,
				status: "completed",
				artifacts: [{ type: "output", path: output }],
			};
		},
	});
	try {
		const result = await recommendWorkflowAuto({
			cwd,
			task: "Review this project.",
			executor: "wp42-stub",
			transmissionPolicy: "allowed",
			availableAgentNames: ["unit"],
		});
		assert.equal(
			during.autoRouterRuns.some((run) => run.deleted),
			false,
			JSON.stringify(during),
		);
		assert.notEqual(
			result.status,
			"routing-unavailable",
			JSON.stringify(result),
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		unregister();
	}
	// The pin ends with the request: the next prune removes the result.
	const later = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(later.autoRouterRuns[0]?.deleted, true, JSON.stringify(later));
	assert.equal(existsSync(join(router, runId)), false);
});

test("a classifier record that is no longer terminal at deletion time is kept (recheck)", async () => {
	const cwd = await temp();
	const router = join(stateDir(cwd), ROUTER_RUNS);
	const id = classifierId();
	await classifier(router, id);
	retention.setWorkflowPruneBeforeClassifierDeleteForTests(async () => {
		const file = join(router, id, "run.json");
		const record = JSON.parse(await readFile(file, "utf8"));
		record.status = "running";
		await writeFile(file, JSON.stringify(record));
	});
	try {
		const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		assert.equal(
			summary.autoRouterRuns[0]?.deleted,
			false,
			JSON.stringify(summary),
		);
		assert.ok(existsSync(join(router, id, "valuable.txt")));
	} finally {
		retention.setWorkflowPruneBeforeClassifierDeleteForTests(undefined);
	}
});

test("a pin left by a dead process does not keep classifier results forever (control)", async () => {
	const cwd = await temp();
	const router = join(stateDir(cwd), ROUTER_RUNS);
	const id = classifierId();
	await classifier(router, id);
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	await json(join(router, ".pins", `${dead}-deadbeef.json`), {
		schema: "agent-workflow-auto-router-pin-v1",
		pid: dead,
		createdAt: "2020-01-01T00:00:00.000Z",
	});
	const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(
		summary.autoRouterRuns[0]?.deleted,
		true,
		JSON.stringify(summary),
	);
});
