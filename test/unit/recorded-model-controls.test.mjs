// agent-workflow 2026-11-10 (context-quality X5): the support-replay fixtures hold real model outputs (worker controls)
// from recorded runs of every bundled workflow. A schema change that would reject what models actually wrote should
// show here, not after the next live run: every recorded model-stage control is validated against the current
// bundle's control schema for its stage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../../dist/core/json-schema.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNS = join(ROOT, "test", "fixtures", "support-replay", "runs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Owner-approved reader contract migration. Keep the historical model output
// unchanged for support replay, but pin the exact recording and the complete
// expected rejection. All other recordings still have to validate normally.
const HISTORICAL_FINAL_AUDIT =
	"research-deep-research-tiered-verification-opt-in-88c698/task-12/final-audit.main";
const HISTORICAL_FINAL_AUDIT_HASH =
	"3a0e48be6721762e5dd2e7d6f8c8c0f40d2f50f1b3aff991900a1b238ce99424";
const HISTORICAL_FINAL_AUDIT_ISSUES = [
	{ path: "$.synthesis.conclusion", message: "required property is missing" },
	{ path: "$.synthesis.keyPoints", message: "required property is missing" },
	{
		path: "$.synthesis.bottomLine",
		message: "additional property is not allowed",
	},
];

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

test("recorded model-stage controls validate against current schemas apart from the pinned migration", () => {
	const failures = [];
	const unmatched = [];
	let checked = 0;
	let historicalChecked = 0;
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
			const raw = readFileSync(path);
			const result = validateJsonSchema(
				JSON.parse(raw.toString("utf8")),
				schema,
			);
			checked += 1;
			if (
				`${fixture}/${task.taskId}/${task.specId}` === HISTORICAL_FINAL_AUDIT
			) {
				assert.equal(
					createHash("sha256").update(raw).digest("hex"),
					HISTORICAL_FINAL_AUDIT_HASH,
				);
				assert.deepEqual(result.issues, HISTORICAL_FINAL_AUDIT_ISSUES);
				historicalChecked += 1;
				continue;
			}
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
	assert.equal(
		historicalChecked,
		1,
		"the historical reader control was validated",
	);
	assert.deepEqual(
		failures,
		[],
		"recorded model outputs that the current schemas reject (a schema change that real outputs would fail)",
	);
});
