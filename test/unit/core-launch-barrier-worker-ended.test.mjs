// New in agent-workflow (WP1b regression): an executor that refuses the request before it consumes
// the execution authority ends the durable worker without READY. The engine must stop waiting for
// READY as soon as the provisional worker's attempt is terminal and report the executor's refusal,
// instead of waiting for the durable launch barrier timeout (30-120 s) and reporting "durable launch
// barrier timed out". Found by the WP1b replay (spec-review: a replay miss is such a refusal).
// Real engine → core task backend → runtime durable worker → refusing fixture executor.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { refusingFixtureDescriptor } from "../helpers/refusing-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-barrier-ended-")));
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true });
});

test("an executor refusal before consume fails the launch promptly with the refusal, not a barrier timeout", async () => {
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	const cwd = join(root, "refuse");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read.\n",
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		`${JSON.stringify({
			schemaVersion: 1,
			name: "barrier-worker-ended",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "only", type: "single", prompt: "Do it." }],
			},
		})}\n`,
	);
	unregister.push(
		core.registerWorkflowExecutor(
			refusingFixtureDescriptor({ message: "no such recorded prompt (WP1b)" }),
		),
	);
	const startedAt = Date.now();
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "refuse",
		executor: "wf-refuse",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	const elapsedMs = Date.now() - startedAt;
	assert.equal(run.status, "failed");
	const task = run.tasks.find((item) => item.stageId === "only");
	assert.equal(task.status, "failed");
	assert.equal(task.statusDetail, "launch_failed");
	assert.match(
		task.lastMessage,
		/ended \(failed\/validation\) before the durable launch barrier READY: executor refused the attempt before launch: no such recorded prompt \(WP1b\)/u,
	);
	assert.doesNotMatch(task.lastMessage, /timed out/u);
	// The barrier was revoked (nothing was released) and the engine did not wait for its timeout,
	// whose lower bound is 30 s.
	const barrier = task.durableLaunchBarrier.records.at(-1);
	assert.equal(barrier.phase, "cancellation_acknowledged");
	assert.equal(barrier.releaseWinner, false);
	assert.equal(task.launchAuthority.records.at(-1).state.phase, "registered");
	assert.ok(elapsedMs < 20_000, `took ${elapsedMs} ms`);
});
