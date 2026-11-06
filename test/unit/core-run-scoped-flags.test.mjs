import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-01: experimental flags that change what a run does are decided at launch and
// recorded as run.experimentalFlags, so the run behaves the same whichever process drives it later
// (live finding: the waiting CLI took over a detached run without the launch environment). Runs
// created before the record keep reading the environment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const flags = await import("../../dist/core/experimental-speed-flags.js");
const access = await import("../../dist/core/artifact-access.js");
const sessions = await import("../../dist/core/owned-session-release.js");

const {
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	PER_ITEM_DISPATCH_ENV,
	RUN_SCOPED_EXPERIMENTAL_FLAGS,
	runExperimentalFlagEnabled,
	runScopedExperimentalFlagsAtLaunch,
} = flags;

test("the run-scoped flags are the ones that change what a run does", () => {
	assert.deepEqual(
		[...RUN_SCOPED_EXPERIMENTAL_FLAGS].sort(),
		[
			EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
			EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
			EXPERIMENTAL_TOOL_DEDUP_ENV,
			PER_ITEM_DISPATCH_ENV,
		].sort(),
	);
	assert.equal(
		RUN_SCOPED_EXPERIMENTAL_FLAGS.includes(EXPERIMENTAL_LAUNCH_RAMP_ENV),
		false,
	);
	assert.deepEqual(
		runScopedExperimentalFlagsAtLaunch({
			[EXPERIMENTAL_TOOL_DEDUP_ENV]: "1",
			[PER_ITEM_DISPATCH_ENV]: "no",
			[EXPERIMENTAL_LAUNCH_RAMP_ENV]: "1",
		}),
		[EXPERIMENTAL_TOOL_DEDUP_ENV],
	);
});

test("a recorded decision wins over the driving process's environment; older runs read it", () => {
	const env = { [EXPERIMENTAL_SAME_SESSION_REPAIR_ENV]: "1" };
	assert.equal(
		runExperimentalFlagEnabled(
			{ experimentalFlags: [] },
			EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
			env,
		),
		false,
	);
	assert.equal(
		runExperimentalFlagEnabled(
			{ experimentalFlags: [EXPERIMENTAL_SAME_SESSION_REPAIR_ENV] },
			EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
			{},
		),
		true,
	);
	assert.equal(
		runExperimentalFlagEnabled({}, EXPERIMENTAL_SAME_SESSION_REPAIR_ENV, env),
		true,
	);
	assert.equal(
		runExperimentalFlagEnabled(
			undefined,
			EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
			{},
		),
		false,
	);
	const graph = { artifactGraph: { enabled: true } };
	assert.equal(
		sessions.workflowTaskKeepsSession(graph, env, { experimentalFlags: [] }),
		false,
	);
	assert.equal(sessions.workflowTaskKeepsSession(graph, env), true);
	assert.deepEqual(access.artifactAccessReadDedup({}), {});
	assert.deepEqual(access.artifactAccessReadDedup({ experimentalFlags: [] }), {
		readDedup: false,
	});
	assert.deepEqual(
		access.artifactAccessReadDedup({
			experimentalFlags: [EXPERIMENTAL_TOOL_DEDUP_ENV],
		}),
		{ readDedup: true },
	);
});

let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-run-flags-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "codex",
				effectLog: join(root, "effects.jsonl"),
				probe: { installed: true, cliVersion: "1.0.0", auth: "ok" },
			}),
		),
	);
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	delete process.env[EXPERIMENTAL_TOOL_DEDUP_ENV];
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("a launch records its flags, and the worker's artifact server gets the recorded dedup decision", async () => {
	for (const [value, expected] of [
		["1", [EXPERIMENTAL_TOOL_DEDUP_ENV]],
		[undefined, []],
	]) {
		const cwd = join(root, `p${expected.length}`);
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".agent-workflow/agents/reader.md"),
			"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
		);
		await writeFile(
			join(cwd, "wf.json"),
			JSON.stringify({
				schemaVersion: 1,
				name: "flags",
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [{ id: "work", type: "single", prompt: "Work." }],
				},
			}),
		);
		if (value === undefined) delete process.env[EXPERIMENTAL_TOOL_DEDUP_ENV];
		else process.env[EXPERIMENTAL_TOOL_DEDUP_ENV] = value;
		const started = await engine.runWorkflowSpec(join(cwd, "wf.json"), cwd, {
			task: "flags",
			executor: "codex",
		});
		// The decision is fixed now; the environment may change while the run continues.
		delete process.env[EXPERIMENTAL_TOOL_DEDUP_ENV];
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		assert.deepEqual(run.experimentalFlags, expected);
		const task = run.tasks.find((candidate) => candidate.stageId === "work");
		const config = JSON.parse(
			readFileSync(
				join(
					stateDir(cwd),
					".agent-workflow/workflows",
					run.runId,
					"tasks",
					task.taskId,
					"artifact-access.json",
				),
				"utf8",
			),
		);
		assert.equal(config.readDedup, expected.length > 0);
	}
});
