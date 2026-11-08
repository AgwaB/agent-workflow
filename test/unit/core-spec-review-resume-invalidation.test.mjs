// agent-workflow 2026-11-08: spec-review's partial consumers (candidate-findings, partition-findings,
// final) declare invalidateOnDependencyResume, so a resume that reruns a failed source also reruns
// the completed stages built from it, as deep-review and deep-research do.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { dependencyResumeInvalidationPlanForTests } from "../../dist/core/engine.js";
import { parseWorkflow } from "../../dist/core/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const specPath = join(root, "workflows", "spec-review", "spec.json");
const rawSpec = JSON.parse(await readFile(specPath, "utf8"));

async function compiledSpecReview(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-spec-review-resume-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	return compileWorkflow(parseWorkflow(structuredClone(rawSpec)), {
		cwd,
		specPath,
		task: "resume invalidation check",
	});
}

test("spec-review partial consumers are the three stages that invalidate on resume", () => {
	const partial = rawSpec.artifactGraph.stages
		.filter(
			(stage) => stage.sourcePolicy === "partial" && stage.type !== "foreach",
		)
		.map((stage) => stage.id);
	assert.deepEqual(partial, [
		"candidate-findings",
		"partition-findings",
		"final",
	]);
});

test("resuming a failed report reruns the final render built without it", async (t) => {
	const compiled = await compiledSpecReview(t);
	const run = (compiledFlow) => ({
		runId: "run-spec-review-resume",
		status: "failed",
		tasks: compiledFlow.tasks.map((task, index) => ({
			taskId: `task-${index + 1}`,
			specId: task.id,
			status: task.id === "report.main" ? "failed" : "completed",
			dependsOn: task.dependsOn ?? [],
			...(task.artifactGraph ? { artifactGraph: task.artifactGraph } : {}),
		})),
	});
	const specOf = (record, ids) =>
		ids.map((id) => record.tasks.find((task) => task.taskId === id).specId);

	const current = run(compiled);
	const plan = dependencyResumeInvalidationPlanForTests(current, compiled);
	assert.ok(plan);
	assert.deepEqual(specOf(current, plan.sourceTaskIds), ["report.main"]);
	assert.deepEqual(specOf(current, plan.invalidatedTaskIds), ["final.main"]);

	const withoutFlags = structuredClone(compiled);
	for (const task of withoutFlags.tasks)
		delete task.artifactGraph?.inputPolicy?.invalidateOnDependencyResume;
	assert.equal(
		dependencyResumeInvalidationPlanForTests(run(withoutFlags), withoutFlags),
		undefined,
	);
});
