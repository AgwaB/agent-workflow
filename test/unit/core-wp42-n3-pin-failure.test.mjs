// New in agent-workflow (WP42 review round 2, N3): a classifier request whose pin cannot be
// established is refused (no classifier call), because an unpinned result could be pruned before it
// is consumed. Only a proven non-prunable layout (the auto-router directory is not a chain of real
// directories, which prune refuses to touch) runs without a pin.
// Temporary directories only; no agent CLI, no model call.
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	classifier,
	classifierId,
	json,
	ROUTER_RUNS,
	temp,
} from "../helpers/wp42-retention-fixtures.mjs";

const retention = await import("../../dist/core/run-retention.js");
const pins = await import("../../dist/core/auto-router-runs.js");
const router = await import("../../dist/core/workflow-router.js");
const runtime = await import("../../dist/core/runtime-port.js");
const core = await import("../../dist/core/index.js");
const fixture = await import("../helpers/workflow-executor-fixture.mjs");

async function classifierProject() {
	const cwd = await temp();
	await json(join(cwd, "workflows", "review", "spec.json"), {
		schemaVersion: 1,
		name: "review",
		description: "Review source code.",
		defaults: { agent: "unit", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "review", type: "single", prompt: "Review." }],
		},
	});
	const agent = join(cwd, ".agent-workflow", "agents", "unit.md");
	await mkdir(dirname(agent), { recursive: true });
	await writeFile(
		agent,
		"---\nname: unit\ndescription: unit\ntools: read\nreadOnly: true\n---\nRead.\n",
	);
	const unregister = core.registerWorkflowExecutor(
		fixture.workflowFixtureDescriptor({
			id: "wp42-n3-fixture",
			effectLog: join(cwd, "effect.log"),
		}),
	);
	return {
		cwd,
		unregister,
		request: {
			cwd,
			task: "Review this project.",
			executor: "wp42-n3-fixture",
			transmissionPolicy: "allowed",
			availableAgentNames: ["unit"],
		},
	};
}

/** A runtime stub that publishes a terminal classifier result into `dir`, then prunes. */
function publishingRuntime(cwd, dir, observed) {
	return {
		async runSubagent(options) {
			observed.submits += 1;
			const runId = classifierId();
			const now = new Date().toISOString();
			await classifier(dir, runId, { cwd, updatedAt: now });
			const output = join(
				dir,
				runId,
				"attempts",
				"attempt_fixture",
				"output.log",
			);
			await mkdir(dirname(output), { recursive: true });
			await writeFile(output, fixture.autoComparisonText(options.task, true));
			observed.prune = await retention.pruneWorkflowRuns(cwd, {
				keep: 0,
				yes: true,
			});
			return {
				runId,
				attemptId: "attempt_fixture",
				status: "completed",
				artifacts: [{ type: "output", path: output }],
			};
		},
	};
}

test("N3: a readable but unwritable .pins refuses the comparison before any classifier call", {
	// Permission bits do not stop root (a container run): the refusal cannot be provoked there.
	skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false,
}, async () => {
	const { cwd, unregister, request } = await classifierProject();
	const pinDir = join(cwd, ROUTER_RUNS, ".pins");
	await mkdir(pinDir, { recursive: true });
	await chmod(pinDir, 0o555);
	const observed = { submits: 0 };
	runtime.setTaskRuntimeApiForTests(
		publishingRuntime(cwd, join(cwd, ROUTER_RUNS), observed),
	);
	try {
		await assert.rejects(pins.acquireAutoRouterPin(cwd));
		const result = await router.recommendWorkflowAuto(request);
		assert.equal(observed.submits, 0);
		assert.equal(result.status, "routing-unavailable", JSON.stringify(result));
		assert.match(result.reason ?? "", /could not be pinned/u);
		assert.match(result.reason ?? "", /no classifier was called/u);
		assert.deepEqual(await readdir(pinDir), []);
	} finally {
		await chmod(pinDir, 0o755);
		runtime.setTaskRuntimeApiForTests(undefined);
		unregister();
	}
});

test("N3: a symlinked auto-router-runs (never pruned) runs unpinned and its result is kept", async () => {
	const { cwd, unregister, request } = await classifierProject();
	const outside = await temp();
	await mkdir(join(cwd, ".agent-workflow", "workflows"), { recursive: true });
	await symlink(outside, join(cwd, ROUTER_RUNS));
	assert.equal(await pins.acquireAutoRouterPin(cwd), undefined);
	const observed = { submits: 0 };
	runtime.setTaskRuntimeApiForTests(publishingRuntime(cwd, outside, observed));
	try {
		await router.recommendWorkflowAuto(request);
		assert.equal(observed.submits, 1);
		assert.equal(
			observed.prune.autoRouterRuns.some((run) => run.deleted),
			false,
			JSON.stringify(observed.prune),
		);
		assert.ok(
			observed.prune.autoRouterPreserved.some((entry) =>
				/unsafe directory/u.test(entry.reason),
			),
		);
		assert.equal(
			(await readdir(outside)).filter((n) => n.startsWith("run_")).length,
			1,
		);
	} finally {
		runtime.setTaskRuntimeApiForTests(undefined);
		unregister();
	}
});

test("N3 control: the normal layout pins the request, keeps its result during it and releases the pin", async () => {
	const { cwd, unregister, request } = await classifierProject();
	const observed = { submits: 0 };
	runtime.setTaskRuntimeApiForTests(
		publishingRuntime(cwd, join(cwd, ROUTER_RUNS), observed),
	);
	try {
		const result = await router.recommendWorkflowAuto(request);
		assert.equal(observed.submits, 1);
		assert.notEqual(
			result.status,
			"routing-unavailable",
			JSON.stringify(result),
		);
		assert.equal(
			observed.prune.autoRouterRuns.some((run) => run.deleted),
			false,
		);
		assert.deepEqual(await readdir(join(cwd, ROUTER_RUNS, ".pins")), []);
	} finally {
		runtime.setTaskRuntimeApiForTests(undefined);
		unregister();
	}
});
