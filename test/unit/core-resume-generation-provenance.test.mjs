// Live bundle 5 (WP39), C1: `agent-workflow stop` during deep-review's reviewers, then
// `agent-workflow resume`: both interrupted reviewer tasks failed at once with "launch-bootstrap
// provenance is malformed" and the run finished without their findings. Resume applied a dependency
// invalidation (the reviewers feed `dedup-findings`, which declares `invalidateOnDependencyResume`):
// the reviewers became generation 1, but each kept the launch-bootstrap history of its generation-0
// launch, and a history must name one task identity (taskId, specId, generation). The first fix
// (provenance only) moved the failure to "workflow launch authority history is malformed" in the
// retry run; the launch authority history has the same owner rule. The fix starts new histories when
// the generation changes. Pure record-level test: no executor, no model call.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "../../dist/core/launch-bootstrap-provenance.js";
import {
	createWorkflowLaunchAuthority,
	issueWorkflowLaunchAuthority,
} from "../../dist/core/launch-authority.js";
import {
	applyDependencyResumeInvalidationForTests,
	dependencyResumeInvalidationPlanForTests,
} from "../../dist/core/engine.js";
import { makeSubagentLaunchFixture } from "../helpers/unit-test-support.mjs";

const BACKEND = "agent-workflow/runtime";

/** The fixture's launched task plus a downstream task that invalidates on dependency resume. */
function stoppedRun(cwd) {
	const fixture = makeSubagentLaunchFixture(cwd, "wp39-generation");
	const upstream = fixture.task;
	const downstreamSpecId = "dedup.main";
	const downstream = {
		...structuredClone(upstream),
		taskId: "task-2",
		specId: downstreamSpecId,
		displayName: downstreamSpecId,
		dependsOn: [upstream.specId],
		artifactGraph: { inputPolicy: { invalidateOnDependencyResume: true } },
		status: "interrupted",
		statusDetail: "workflow_stopped",
	};
	fixture.run.tasks.push(downstream);
	const compiled = {
		tasks: [
			{ id: upstream.specId },
			{
				id: downstreamSpecId,
				dependsOn: [upstream.specId],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
		],
	};
	return { ...fixture, upstream, downstream, compiled };
}

test("a task launched before stop relaunches after a generation-bumping resume (live bundle 5)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-wp39-generation-"));
	try {
		const fixture = stoppedRun(cwd);
		const { run, upstream, compiledTask, compiled } = fixture;
		// First launch (generation 0): its provenance is recorded on the task.
		const first = await createLaunchBootstrapProvenance(
			cwd,
			run,
			upstream,
			compiledTask,
			BACKEND,
		);
		recordLaunchBootstrapProvenance(upstream, first);
		issueWorkflowLaunchAuthority(
			upstream,
			createWorkflowLaunchAuthority(run, upstream, BACKEND, first),
		);
		assert.equal(first.task.generation, undefined);
		// `stop` interrupted it.
		upstream.status = "interrupted";
		upstream.statusDetail = "workflow_stopped";

		// `resume`: the downstream task invalidates on dependency resume → a generation-1 plan.
		const plan = dependencyResumeInvalidationPlanForTests(run, compiled);
		assert.ok(plan, "resume plans a dependency invalidation");
		assert.ok(plan.sourceTaskIds.includes(upstream.taskId));
		applyDependencyResumeInvalidationForTests(run, compiled, plan);
		assert.equal(upstream.generation, plan.generation);
		assert.equal(upstream.status, "pending");

		// The relaunch records its provenance (before the fix: "launch-bootstrap provenance is
		// malformed", because the generation-0 record names another task identity).
		const relaunch = await createLaunchBootstrapProvenance(
			cwd,
			run,
			upstream,
			compiledTask,
			BACKEND,
		);
		assert.equal(relaunch.task.generation, plan.generation);
		assert.doesNotThrow(() =>
			recordLaunchBootstrapProvenance(upstream, relaunch),
		);
		assert.deepEqual(
			upstream.launchBootstrap.records.map((record) => record.identitySha256),
			[relaunch.identitySha256],
		);
		// …and its launch authority (before the fix, once the provenance part was fixed: "workflow
		// launch authority history is malformed").
		const grant = createWorkflowLaunchAuthority(
			run,
			upstream,
			BACKEND,
			relaunch,
		);
		assert.equal(grant.task.generation, plan.generation);
		assert.doesNotThrow(() => issueWorkflowLaunchAuthority(upstream, grant));
		assert.deepEqual(
			upstream.launchAuthority.records.map(
				(record) => record.grant.identitySha256,
			),
			[grant.identitySha256],
		);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a resume that keeps the generation keeps the launch-bootstrap history", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aw-wp39-generation-"));
	try {
		const fixture = stoppedRun(cwd);
		const { run, upstream, compiledTask, compiled } = fixture;
		const first = await createLaunchBootstrapProvenance(
			cwd,
			run,
			upstream,
			compiledTask,
			BACKEND,
		);
		recordLaunchBootstrapProvenance(upstream, first);
		issueWorkflowLaunchAuthority(
			upstream,
			createWorkflowLaunchAuthority(run, upstream, BACKEND, first),
		);
		upstream.status = "interrupted";
		const plan = dependencyResumeInvalidationPlanForTests(run, compiled);
		assert.ok(plan);
		// Re-applying a journal whose generation the task already has (idempotent recovery) keeps
		// the history of that generation.
		upstream.generation = plan.generation;
		const kept = structuredClone(upstream.launchBootstrap);
		const keptAuthority = structuredClone(upstream.launchAuthority);
		applyDependencyResumeInvalidationForTests(run, compiled, plan);
		assert.deepEqual(upstream.launchBootstrap, kept);
		assert.deepEqual(upstream.launchAuthority, keptAuthority);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

// End to end on the workflow executor fixture (no model, no agent CLI): stage `a` is running when
// the run is stopped; `b` invalidates on dependency resume, so `resume` bumps `a` to generation 1.
// Before the fix `a` failed at once (`launch_failed`, "launch-bootstrap provenance is malformed").
test("stop during a running task, then resume with a dependency invalidation: the task relaunches and the run completes", async () => {
	const core = await import("../../dist/core/index.js");
	const engine = await import("../../dist/core/engine.js");
	const store = await import("../../dist/core/store.js");
	const slots = await import("../../dist/core/launch-slots.js");
	const { workflowFixtureDescriptor, readFixtureLog } = await import(
		"../helpers/workflow-executor-fixture.mjs"
	);
	const { mkdir, realpath, writeFile, rm } = await import("node:fs/promises");
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	const cwd = await realpath(mkdtempSync(join(tmpdir(), "aw-wp39-e2e-")));
	const id = "wp39-resume-generation";
	const effectLog = join(cwd, "effects.jsonl");
	const undo = core.registerWorkflowExecutor(
		workflowFixtureDescriptor({ id, effectLog, stepDelayMs: 1_500 }),
	);
	try {
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".agent-workflow", "agents", "reader.md"),
			"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
		);
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				name: "wp39-resume-generation",
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [
						{ id: "a", type: "single", prompt: "Collect facts." },
						{
							id: "b",
							type: "single",
							after: ["a"],
							prompt: "Summarize.",
							inputPolicy: { invalidateOnDependencyResume: true },
						},
					],
				},
			}),
		);
		const started = await engine.runWorkflowSpec(specPath, cwd, {
			task: "slow",
			executor: id,
		});
		const deadline = Date.now() + 30_000;
		for (;;) {
			const run = await store.readRunRecord(cwd, started.runId);
			const a = run.tasks.find((task) => task.specId === "a.main");
			if (a?.status === "running" && a.launchBootstrap?.records.length) break;
			assert.ok(Date.now() < deadline, "task a never started");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const stopped = await engine.stopRun(cwd, started.runId);
		assert.equal(stopped.run.status, "interrupted");
		engine.setResumeAfterStopLeaseWaitForTests({
			timeoutMs: 20_000,
			pollMs: 50,
		});
		const resumed = await engine.resumeRun(cwd, started.runId);
		assert.ok(resumed.resetTaskIds.length >= 1);
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		const a = run.tasks.find((task) => task.specId === "a.main");
		assert.equal(
			a.status,
			"completed",
			`${a.statusDetail}: ${a.lastMessage ?? ""}`,
		);
		assert.equal(a.generation, 1);
		assert.equal(run.status, "completed");
		const submits = readFixtureLog(effectLog).filter(
			(entry) => entry.type === "submit",
		);
		assert.ok(submits.length >= 3, `submits: ${submits.length}`);
	} finally {
		engine.setResumeAfterStopLeaseWaitForTests(undefined);
		slots.setSubagentLaunchControlsForTests({});
		undo();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
