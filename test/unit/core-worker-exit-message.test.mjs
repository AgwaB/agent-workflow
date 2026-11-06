// 2026-10-31: a durable worker that ends without a result leaves its task blocked for an owner
// decision. The message now says why the worker stopped (its last log line, or that it left none),
// so the cause is visible in status/inspect and in a failing test, not only in worker.log.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");
const runtime = await import("../../dist/runtime/api.js");
const taskArtifacts = await import("../../dist/core/task-artifacts.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-worker-exit-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("a worker killed mid-run: the blocked task says the worker left no log line", {
	skip: process.platform === "win32" ? "process groups are POSIX-only" : false,
}, async () => {
	const cwd = join(root, "killed");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "worker-exit",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Slow work." }],
			},
		}),
	);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "wf-worker-exit",
				effectLog: join(cwd, "fx.jsonl"),
				stepDelayMs: 3_000,
			}),
		),
	);
	const started = await engine.runWorkflowSpec(join(cwd, "wf.json"), cwd, {
		task: "worker exit",
		executor: "wf-worker-exit",
	});
	// The task's durable worker, once it is recorded.
	let workerPid;
	const deadline = Date.now() + 30_000;
	while (workerPid === undefined && Date.now() < deadline) {
		const run = await store.readRunRecord(cwd, started.runId);
		const task = run.tasks[0];
		if (task.backendTaskId?.startsWith("run_")) {
			const status = await runtime
				.getSubagentStatus({
					cwd: taskArtifacts.workflowTaskStateCwd(cwd, task),
					runsDir: taskArtifacts.subagentRunsDir(run, task),
					runId: task.backendTaskId,
				})
				.catch(() => undefined);
			workerPid = status?.attempts?.[0]?.workerPid;
		}
		if (workerPid === undefined)
			await new Promise((done) => setTimeout(done, 50));
	}
	assert.equal(typeof workerPid, "number", "the worker was recorded");
	// The worker is alive (just read from its record): kill its group directly.
	process.kill(-workerPid, "SIGKILL");
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "blocked", JSON.stringify(run.tasks[0]));
	const [task] = run.tasks;
	assert.equal(task.statusDetail, core.EXECUTOR_NEEDS_DECISION_STATUS_DETAIL);
	assert.match(
		task.lastMessage,
		/owner decision is required .*; worker: worker pid \d+ is gone; its log is empty/,
	);
});
