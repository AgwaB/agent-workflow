// agent-workflow 2026-11-10 (context-quality X5): the support-replay fixtures hold real model outputs (worker controls)
// from recorded runs of every bundled workflow. A schema change that would reject what models actually wrote should
// show here, not after the next live run: every recorded model-stage control is validated against the current
// bundle's control schema for its stage.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../../dist/core/json-schema.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNS = join(ROOT, "test", "fixtures", "support-replay", "runs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function stagesOf(spec) {
	const stages = new Map();
	const walk = (list) => {
		for (const stage of list ?? []) {
			stages.set(stage.id, stage);
			walk(stage.stages);
			walk(stage.children);
		}
	};
	walk(spec.artifactGraph?.stages);
	return stages;
}

function specFor(run) {
	const bundle = join(ROOT, "workflows", run.bundle);
	const file = readdirSync(bundle)
		.filter((name) => name === "spec.json" || name.endsWith(".spec.json"))
		.find((name) => readJson(join(bundle, name)).name === run.name);
	return file ? { bundle, spec: readJson(join(bundle, file)) } : undefined;
}

test("every recorded model-stage control passes the current control schema of its stage", () => {
	const failures = [];
	const unmatched = [];
	let checked = 0;
	for (const fixture of readdirSync(RUNS).sort()) {
		const run = readJson(join(RUNS, fixture, "run.json"));
		const found = specFor(run);
		if (!found) {
			unmatched.push(`${fixture} (${run.name})`);
			continue;
		}
		const stages = stagesOf(found.spec);
		for (const task of run.tasks) {
			const stage = stages.get(task.stageId);
			if (!stage || stage.support || !stage.output?.controlSchema) continue;
			const path = join(RUNS, fixture, "tasks", task.taskId, "control.json");
			if (!existsSync(path)) continue;
			const schema = readJson(join(found.bundle, stage.output.controlSchema));
			const result = validateJsonSchema(readJson(path), schema);
			checked += 1;
			if (!result.valid)
				failures.push(
					`${fixture} ${task.specId}: ${result.issues
						.slice(0, 2)
						.map((issue) => `${issue.path} ${issue.message}`)
						.join("; ")}`,
				);
		}
	}
	assert.deepEqual(unmatched, [], "every fixture names a bundled spec");
	assert.ok(checked >= 390, `only ${checked} recorded controls checked`);
	assert.deepEqual(
		failures,
		[],
		"recorded model outputs that the current schemas reject (a schema change that real outputs would fail)",
	);
});
