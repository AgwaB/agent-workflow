// agent-workflow 2026-11-08 (context-quality backlog X3): deep-research stages read their sources
// with sourcePolicy "partial", so they can finish while a source has failed. A resume reruns the
// failed source; without invalidateOnDependencyResume the completed consumers kept results built
// from the old inputs. Every partial consumer now declares it, as deep-review's do.
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
const specPath = join(root, "workflows", "deep-research", "spec.json");
const rawSpec = JSON.parse(await readFile(specPath, "utf8"));

const PARTIAL_CONSUMERS = [
	"normalize-input-packet",
	"normalize-claims",
	"sanitize-claims",
	"check-web-quotes",
	"audit-claims",
	"final-audit-packet",
	"final-audit",
	"translation-check",
	"final",
];

async function compiledResearch(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-research-resume-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	return compileWorkflow(parseWorkflow(structuredClone(rawSpec)), {
		cwd,
		specPath,
		task: "resume invalidation check",
	});
}

test("every non-foreach deep-research partial consumer invalidates on dependency resume", async (t) => {
	const partial = rawSpec.artifactGraph.stages
		.filter(
			(stage) => stage.sourcePolicy === "partial" && stage.type !== "foreach",
		)
		.map((stage) => stage.id);
	assert.deepEqual(partial, PARTIAL_CONSUMERS);
	const compiled = await compiledResearch(t);
	for (const stageId of PARTIAL_CONSUMERS) {
		const task = compiled.tasks.find((row) => row.id === `${stageId}.main`);
		assert.ok(task, stageId);
		assert.equal(
			task.artifactGraph?.inputPolicy?.invalidateOnDependencyResume,
			true,
			stageId,
		);
	}
});

test("resuming a failed audit packet reruns the synthesis and render built from it", async (t) => {
	const compiled = await compiledResearch(t);
	const run = (compiledFlow) => ({
		runId: "run-research-resume",
		status: "failed",
		tasks: compiledFlow.tasks.map((task, index) => ({
			taskId: `task-${index + 1}`,
			specId: task.id,
			status: task.id === "final-audit-packet.main" ? "failed" : "completed",
			dependsOn: task.dependsOn ?? [],
			...(task.artifactGraph ? { artifactGraph: task.artifactGraph } : {}),
		})),
	});
	const specOf = (record, ids) =>
		ids.map((id) => record.tasks.find((task) => task.taskId === id).specId);

	const current = run(compiled);
	const plan = dependencyResumeInvalidationPlanForTests(current, compiled);
	assert.ok(plan);
	assert.deepEqual(specOf(current, plan.sourceTaskIds), [
		"final-audit-packet.main",
	]);
	assert.deepEqual(specOf(current, plan.invalidatedTaskIds).sort(), [
		"final-audit.main",
		"final.main",
		"retranslate.item",
		"translation-check.main",
	]);

	// Without the declarations the completed synthesis and render would be kept as they are.
	const withoutFlags = structuredClone(compiled);
	for (const task of withoutFlags.tasks)
		delete task.artifactGraph?.inputPolicy?.invalidateOnDependencyResume;
	assert.equal(
		dependencyResumeInvalidationPlanForTests(run(withoutFlags), withoutFlags),
		undefined,
	);
});
