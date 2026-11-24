import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";

// The Workflow Output Protocol names the `control.schema` value a control schema pins by `const` or a
// one-value `enum`, so the author need not repeat it in the prompt.

const DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };

async function promptFor(schemaFile, stage = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-pinned-schema-"));
	try {
		await writeFile(join(cwd, "control.json"), JSON.stringify(schemaFile));
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: DEFAULTS,
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Check the target.",
							profileRole: "research-execution",
							output: { controlSchema: "./control.json" },
							...stage,
						},
					],
				},
			}),
		);
		const loaded = await loadWorkflowSpec(specPath, cwd);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		});
		return compiled.tasks[0].compiledPrompt;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const body = (schemaProperty) => ({
	type: "object",
	required: ["schema", "digest"],
	properties: { schema: schemaProperty, digest: { type: "string" } },
});

test("a const control.schema is named in the output protocol", async () => {
	const prompt = await promptFor(body({ const: "review-result-v2" }));
	assert.match(prompt, /`control\.schema` to exactly "review-result-v2"/);
	assert.doesNotMatch(prompt, /required by the stage prompt/);
});

test("a one-value enum is named; a two-value enum or a free string keeps the generic line", async () => {
	assert.match(
		await promptFor(body({ enum: ["review-result-v3"] })),
		/`control\.schema` to exactly "review-result-v3"/,
	);
	for (const property of [
		{ enum: ["a-v1", "b-v1"] },
		{ type: "string" },
		{ const: 3 },
	]) {
		const prompt = await promptFor(body(property));
		assert.match(prompt, /required by the stage prompt or example/);
		assert.doesNotMatch(prompt, /to exactly "/);
	}
});

test("a foreach stage's each.prompt carries the pinned value too", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-pinned-schema-"));
	try {
		await writeFile(
			join(cwd, "control.json"),
			JSON.stringify(body({ const: "item-result-v1" })),
		);
		await writeFile(
			join(cwd, "plan.json"),
			JSON.stringify({
				type: "object",
				required: ["schema", "digest", "items"],
				properties: {
					schema: { type: "string" },
					digest: { type: "string" },
					items: {
						type: "array",
						minItems: 0,
						maxItems: 3,
						items: { type: "string" },
					},
				},
			}),
		);
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: DEFAULTS,
				artifactGraph: {
					stages: [
						{
							id: "plan",
							type: "single",
							prompt: "Plan.",
							profileRole: "planning",
							output: { controlSchema: "./plan.json" },
						},
						{
							id: "each",
							type: "foreach",
							from: { source: "plan", path: "$.items" },
							profileRole: "research-execution",
							each: { prompt: "Work ${item}." },
							output: { controlSchema: "./control.json" },
						},
					],
				},
			}),
		);
		const loaded = await loadWorkflowSpec(specPath, cwd);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		});
		const item = compiled.tasks.find((task) => task.specId === "each.item");
		assert.match(
			item.compiledPrompt,
			/`control\.schema` to exactly "item-result-v1"/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a stage without a control schema keeps the default-schema line", async () => {
	const prompt = await promptFor(body({ const: "x-v1" }), {
		output: undefined,
	});
	assert.match(prompt, /Use schema `stage-control-v1`/);
});
