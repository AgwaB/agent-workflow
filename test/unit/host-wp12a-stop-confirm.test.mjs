// New in agent-workflow (WP12a, live bundle 3 open problem 10): the host `stop` retries only
// confirm a stop it already requested. Root cause of the host-cli "stop" flake: under load the
// first stopRun could not confirm within its 1.5 s bound (the detached supervisor held the run
// lease), the host retried stopRun, and by then the supervisor had applied the stop and cleared
// the stop intent — stopRun refused the interrupted run ("stop requires a non-terminal run") and
// the CLI exited 1 although the stop had succeeded. confirmRunStop accepts that terminal run.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-stop-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	// Durable workers/finalizers may still be closing files: retry like host-cli.test.mjs.
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("confirmRunStop accepts a run the supervisor already stopped; stopRun refuses it", async () => {
	const cwd = join(root, "p");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const specPath = join(cwd, "wf.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "wp12a-stop",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "wf-wp12a-stop",
				effectLog: join(root, "effects.jsonl"),
				stepDelayMs: 2_000,
			}),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "long task",
		executor: "wf-wp12a-stop",
	});
	const stopped = await engine.stopRun(cwd, started.runId);
	assert.equal(stopped.run.status, "interrupted");
	assert.ok(stopped.interruptedTaskIds.length > 0);

	// What the host retry sees after the supervisor applied the stop and cleared the intent.
	await assert.rejects(
		engine.stopRun(cwd, started.runId),
		/stop requires a non-terminal run/,
	);
	const confirmed = await engine.confirmRunStop(cwd, started.runId);
	assert.equal(confirmed.run.status, "interrupted");
	assert.deepEqual(confirmed.interruptedTaskIds, stopped.interruptedTaskIds);
});
