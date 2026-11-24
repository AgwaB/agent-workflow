import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { generatePatternFiles } from "../../dist/core/authoring-patterns.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";

// A control schema with a required array of `minItems >= 1` that a `foreach` stage fans out over makes the
// model produce tasks from input it may not have. The Workflow Output Protocol then carries the
// do-not-invent / inputIntegrity sentence that the repair attempt sends today, unless the author's prompt
// already mentions `inputIntegrity`. A list that no foreach reads (evidence rows) does not get it.

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

// `readers`: the `from.path` of each foreach stage after `main` that reads it (a string or a list; none = no foreach).
async function promptFor(
	controlSchema,
	prompt = "List the items.",
	readers = "$.items",
) {
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
						...[readers ?? []].flat().map((path, index) => ({
							id: `work${index}`,
							type: "foreach",
							from: { source: "main", path },
							each: { prompt: "Do ${item}." },
						})),
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

test("a required list with minItems >= 1 that a foreach reads adds one do-not-invent sentence naming the list and the exit", async () => {
	const prompt = await promptFor(schema({ minItems: 1 }));
	assert.equal(COUNT(prompt), 1);
	assert.match(prompt, /`items` must contain at least one item/);
	assert.match(prompt, /control\.inputIntegrity \{"status":"blocked"/);
	assert.match(prompt, /"reason":"inconsistent_input"/);
});

test("the sentence names every such list a foreach reads once and sits in the output protocol", async () => {
	const two = schema({ minItems: 2 });
	two.required.push("more");
	two.properties.more = {
		type: "array",
		minItems: 1,
		items: { type: "string" },
	};
	const prompt = await promptFor(two, "List the items.", [
		"$.items",
		"$.more[*]",
	]);
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

test("a list that no foreach reads gets no sentence, a list read by a foreach does", async () => {
	const list = schema({ minItems: 1 });
	assert.match(
		await promptFor(list, "List.", "$.items"),
		/Do not invent items/,
	);
	assert.match(
		await promptFor(list, "List.", "$.items[*].id"),
		/Do not invent items/,
	);
	assert.doesNotMatch(await promptFor(list, "List.", null), /Do not invent/);
	// a foreach over another key of the stage does not make this list an inventory
	assert.doesNotMatch(
		await promptFor(list, "List.", "$.digest"),
		/Do not invent/,
	);
});

test("a foreach that reads another stage does not count for this stage's list", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-no-invent-"));
	try {
		await writeFile(
			join(cwd, "control.json"),
			JSON.stringify(schema({ minItems: 1 })),
		);
		const specPath = join(cwd, "spec.json");
		const stage = (id, extra = {}) => ({
			id,
			type: "single",
			prompt: "List.",
			profileRole: "planning",
			output: { controlSchema: "./control.json" },
			...extra,
		});
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: DEFAULTS,
				artifactGraph: {
					stages: [
						stage("one"),
						stage("two", { after: [] }),
						{
							id: "work",
							type: "foreach",
							from: { source: "two", path: "$.items" },
							after: ["one", "two"],
							each: { prompt: "Do ${item}." },
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
		const byId = new Map(compiled.tasks.map((t) => [t.id ?? t.specId, t]));
		const one = compiled.tasks.find((t) => /\bone\b/.test(t.specId ?? t.id));
		const two = compiled.tasks.find((t) => /\btwo\b/.test(t.specId ?? t.id));
		assert.ok(one && two && byId.size > 0);
		assert.doesNotMatch(one.compiledPrompt, /Do not invent/);
		assert.match(two.compiledPrompt, /Do not invent items/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the foreach-reduce and classify-count patterns keep their one do-not-invent sentence (the author's own)", async () => {
	for (const [pattern, stageId] of [
		["foreach-reduce", "plan"],
		["classify-count", "load"],
	]) {
		const cwd = await mkdtemp(join(tmpdir(), "aw-no-invent-"));
		try {
			for (const file of generatePatternFiles(pattern, "p")) {
				if (file.location === "agents") continue;
				const target = join(cwd, ...file.path.split("/"));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.content);
			}
			const loaded = await loadWorkflowSpec(join(cwd, "spec.json"), cwd);
			const compiled = await compileWorkflow(loaded.spec, {
				cwd,
				specPath: loaded.specPath,
			});
			const task = compiled.tasks.find((t) =>
				String(t.specId ?? t.id).startsWith(stageId),
			);
			assert.ok(task, `${pattern}: ${stageId} task`);
			assert.equal(COUNT(task.compiledPrompt), 1, pattern);
			assert.match(task.compiledPrompt, /inputIntegrity/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});
