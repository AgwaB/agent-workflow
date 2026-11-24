import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";

// A control schema with a required array of `minItems >= 1` makes the model produce items from input it
// may not have. The Workflow Output Protocol then carries the do-not-invent / inputIntegrity sentence
// that the repair attempt sends today, unless the author's prompt already mentions `inputIntegrity`.

const DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };

const schema = (list, required = ["schema", "digest", "items"]) => ({
	type: "object",
	required,
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		items: { type: "array", maxItems: 5, items: { type: "string" }, ...list },
	},
});

async function promptFor(controlSchema, prompt = "List the items.") {
	const cwd = await mkdtemp(join(tmpdir(), "aw-no-invent-"));
	try {
		await writeFile(join(cwd, "control.json"), JSON.stringify(controlSchema));
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
							prompt,
							profileRole: "planning",
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
		return compiled.tasks[0].compiledPrompt;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const COUNT = (text) => text.split("Do not invent items").length - 1;

test("a required list with minItems >= 1 adds one do-not-invent sentence naming the list and the exit", async () => {
	const prompt = await promptFor(schema({ minItems: 1 }));
	assert.equal(COUNT(prompt), 1);
	assert.match(prompt, /`items` must contain at least one item/);
	assert.match(prompt, /control\.inputIntegrity \{"status":"blocked"/);
	assert.match(prompt, /"reason":"inconsistent_input"/);
});

test("the sentence names every such list once and sits in the output protocol", async () => {
	const two = schema({ minItems: 2 });
	two.required.push("more");
	two.properties.more = {
		type: "array",
		minItems: 1,
		items: { type: "string" },
	};
	const prompt = await promptFor(two);
	assert.equal(COUNT(prompt), 1);
	assert.match(prompt, /`items`, `more` must contain at least one item/);
	assert.ok(
		prompt.indexOf("Do not invent items") >
			prompt.indexOf("# Workflow Output Protocol"),
	);
});

test("an author prompt that already mentions inputIntegrity gets no second sentence", async () => {
	const prompt = await promptFor(
		schema({ minItems: 1 }),
		'List the items. Do not invent items: report inputIntegrity {"status":"blocked"} when there are none.',
	);
	assert.equal(COUNT(prompt), 1);
	assert.doesNotMatch(prompt, /must contain at least one item/);
});

test("no sentence for minItems 0, an absent bound, an optional list or a non-array property", async () => {
	for (const controlSchema of [
		schema({ minItems: 0 }),
		schema({}),
		schema({ minItems: 1 }, ["schema", "digest"]),
		{
			type: "object",
			required: ["schema", "digest", "items"],
			properties: {
				schema: { type: "string" },
				digest: { type: "string" },
				items: { type: "string", minLength: 1 },
			},
		},
	]) {
		assert.doesNotMatch(await promptFor(controlSchema), /Do not invent/);
	}
});
