import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	assertPromptSchemaDiagnosticsAllowRun,
	workflowPromptSchemaDiagnostics,
} from "../../dist/core/prompt-schema-diagnostics.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";
import { parseWorkflowOutput } from "../../dist/core/workflow-output-artifacts.js";

// `validate` authoring-rule checks of the workflow-guide skill: profileRole, unsupported
// placeholders, prompts that forbid tools on a stage with sources, unbounded foreach sources and
// loop `until` paths missing from the final child's control schema.

const DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };

function schema(properties, extra = {}) {
	return {
		type: "object",
		required: Object.keys(properties),
		properties,
		...extra,
	};
}

// Writes a bundle (spec.json plus schema files), loads and compiles it. Resolves to the warnings;
// rejects with the validation error when loading fails.
async function validate(stages, files = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "agent-workflow-authoring-rules-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			await mkdir(dirname(join(cwd, name)), { recursive: true });
			await writeFile(join(cwd, name), JSON.stringify(content));
		}
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: DEFAULTS,
				artifactGraph: { stages },
			}),
		);
		const loaded = await loadWorkflowSpec(specPath, cwd);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		});
		return compiled;
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}

const matching = (compiled, pattern) =>
	compiled.warnings.filter((warning) => pattern.test(warning));

const single = (id, extra = {}) => ({
	id,
	type: "single",
	prompt: "Check the target.",
	profileRole: "research-execution",
	...extra,
});

test("a model stage without profileRole warns, with it it does not", async () => {
	const missing = await validate([single("main", { profileRole: undefined })]);
	const [warning] = matching(missing, /has no profileRole/);
	assert.match(warning, /stage "main" \(single\)/);
	assert.match(warning, /planning, research-execution, synthesis/);
	assert.equal(
		matching(await validate([single("main")]), /profileRole/).length,
		0,
	);
});

test("profileRole is checked on loop children, onExhausted, dag children and each model stage type", async () => {
	const valid = await validate(
		[
			single("plan", { output: { controlSchema: "./schemas/plan.json" } }),
			{
				id: "refine",
				type: "loop",
				maxRounds: 2,
				until: { stage: "review", path: "$.passed", equals: true },
				stages: [
					{ id: "draft", type: "single", prompt: "Draft." },
					{
						id: "review",
						type: "single",
						prompt: "Review.",
						output: { controlSchema: "./schemas/review.json" },
					},
				],
				onExhausted: { id: "give-up", type: "single", prompt: "Stop." },
			},
			{
				id: "fanout",
				type: "dag",
				stages: [{ id: "inner", type: "single", prompt: "Inner." }],
			},
			{
				id: "fe",
				type: "foreach",
				from: { source: "plan", path: "$.items" },
				maxItems: 5,
				each: { prompt: "Do ${item}." },
				after: ["plan"],
			},
			{
				id: "helper",
				after: ["plan"],
				support: { uses: "./helper.mjs" },
			},
		],
		{
			"schemas/plan.json": schema({
				items: { type: "array", maxItems: 3, items: { type: "string" } },
			}),
			"schemas/review.json": schema({ passed: { type: "boolean" } }),
		},
	);
	const warned = matching(valid, /has no profileRole/).map(
		(warning) => /stage "([^"]+)"/.exec(warning)[1],
	);
	assert.deepEqual(warned.sort(), [
		"draft",
		"fe",
		"give-up",
		"inner",
		"review",
	]);
});

test("a dynamic stage and its present decisionLoop profiles need a profileRole", async () => {
	const files = { "helper.mjs": {} };
	const stage = (extra) => ({
		id: "dyn",
		type: "dynamic",
		dynamic: {
			uses: "./helper.mjs",
			mode: "graph-splice",
			decisionLoop: {
				planner: { agent: "scout", profileRole: "planning" },
				verifier: { agent: "scout" },
			},
		},
		...extra,
	});
	const warnings = (await validate([stage({})], files)).warnings;
	assert.ok(
		warnings.some((w) => /stage "dyn" \(dynamic\) has no profileRole/.test(w)),
	);
	assert.ok(
		warnings.some((w) =>
			/stage "dyn" dynamic\.decisionLoop\.verifier has no profileRole/.test(w),
		),
	);
	assert.ok(!warnings.some((w) => /decisionLoop\.planner/.test(w)));
	const ok = await validate(
		[
			{
				...stage({ profileRole: "planning" }),
				dynamic: {
					uses: "./helper.mjs",
					mode: "graph-splice",
					decisionLoop: {
						planner: { agent: "scout", profileRole: "planning" },
					},
				},
			},
		],
		files,
	);
	assert.equal(matching(ok, /profileRole/).length, 0);
});

test("unsupported ${...} placeholders in prompts warn; ${item} in foreach each.prompt does not", async () => {
	const input = await validate([
		single("main", { prompt: "Research ${input.topic} and ${ topic } now." }),
	]);
	const [warning] = matching(input, /does not substitute/);
	assert.match(warning, /stage "main" prompt/);
	assert.match(warning, /\$\{input\.topic\}, \$\{ topic \}/);
	assert.match(warning, /Workflow Input/);

	const itemInSingle = await validate([
		single("main", { prompt: "Check ${item}." }),
	]);
	assert.equal(matching(itemInSingle, /does not substitute/).length, 1);

	const files = {
		"schemas/plan.json": schema({
			items: { type: "array", maxItems: 3, items: { type: "string" } },
		}),
	};
	const stages = (eachPrompt) => [
		single("plan", { output: { controlSchema: "./schemas/plan.json" } }),
		{
			id: "fe",
			type: "foreach",
			profileRole: "verification",
			from: { source: "plan", path: "$.items" },
			each: { prompt: eachPrompt },
		},
	];
	const clean = await validate(stages("Check ${item} carefully."), files);
	assert.equal(matching(clean, /does not substitute/).length, 0);
	const mixed = await validate(
		stages("Check ${item} for ${input.focus}."),
		files,
	);
	const [mixedWarning] = matching(mixed, /does not substitute/);
	assert.match(
		mixedWarning,
		/stage "fe" each\.prompt contains \$\{input\.focus\}/,
	);
	assert.doesNotMatch(mixedWarning, /contains \$\{item\}/);
	// Review 2026-11-22: only the exact `${item}` is substituted; `${ item }` stays literal.
	const spaced = await validate(stages("Check ${ item }."), files);
	assert.match(
		matching(spaced, /does not substitute/)[0] ?? "",
		/each\.prompt contains \$\{ item \}/,
	);
});

test("a prompt that forbids tools on a stage with sources warns", async () => {
	const stages = (prompt, extra = {}, first = {}) => [
		single("collect", first),
		single("merge", { from: ["collect"], prompt, ...extra }),
	];
	for (const phrase of [
		"Do not use any tools.",
		"Never call tools; answer from the text.",
		"Work without tools.",
		"There are no tools for this stage.",
		"Do not call workflow_artifact.",
	]) {
		const compiled = await validate(stages(`Merge. ${phrase}`));
		const [warning] = matching(compiled, /forbids tool use/);
		assert.ok(warning, `expected a warning for: ${phrase}`);
		assert.match(warning, /stage "merge" reads sources \(from: collect\)/);
		assert.match(warning, /workflow_artifact/);
	}
	// Narrowing phrases, stages without sources, and artifactAccess none are fine.
	for (const prompt of [
		"Merge. Do not use tools other than workflow_artifact.",
		"Merge. Do not use tools to modify files.",
		"Merge. Never call workflow_artifact with maxChars and no path.",
		"Merge. Do not use any tool that writes.",
	]) {
		assert.equal(
			matching(await validate(stages(prompt)), /forbids tool use/).length,
			0,
			prompt,
		);
	}
	const noSources = await validate([
		single("solo", { prompt: "Answer. Do not use any tools.", after: [] }),
	]);
	assert.equal(matching(noSources, /forbids tool use/).length, 0);
	const inline = await validate(
		stages("Merge. Do not use any tools.", {
			inputPolicy: { artifactAccess: "none" },
			tools: [],
		}),
	);
	assert.equal(matching(inline, /forbids tool use/).length, 0);
});

test("a loop child after the first reads the round's earlier children, so forbidding tools warns", async () => {
	const loop = (reviewPrompt) => [
		{
			id: "refine",
			type: "loop",
			maxRounds: 2,
			until: { stage: "review", path: "$.passed", equals: true },
			stages: [
				single("draft"),
				single("review", {
					prompt: reviewPrompt,
					output: { controlSchema: "./schemas/review.json" },
				}),
			],
		},
	];
	const files = {
		"schemas/review.json": schema({ passed: { type: "boolean" } }),
	};
	const bad = await validate(
		loop('Review. Use no tools. "passed": true'),
		files,
	);
	assert.equal(
		matching(bad, /stage "review" reads the earlier children/).length,
		1,
	);
	const ok = await validate(loop('Review. "passed": true'), files);
	assert.equal(matching(ok, /forbids tool use/).length, 0);
});

const planSchema = (itemsExtra = {}) =>
	schema({
		items: { type: "array", items: { type: "string" }, ...itemsExtra },
	});

test("a foreach source array without maxItems warns; a schema cap or stage maxItems silences it", async () => {
	const stages = (extra = {}, source = {}) => [
		single("plan", {
			output: { controlSchema: "./schemas/plan.json" },
			...source,
		}),
		{
			id: "fe",
			type: "foreach",
			profileRole: "verification",
			from: { source: "plan", path: "$.items" },
			each: { prompt: "Check ${item}." },
			...extra,
		},
	];
	const open = await validate(stages(), { "schemas/plan.json": planSchema() });
	const [warning] = matching(open, /has no maxItems/);
	assert.match(
		warning,
		/foreach stage "fe" fans out over "\$\.items" from "plan"/,
	);
	assert.match(warning, /plan's control schema \(\.\/schemas\/plan\.json\)/);

	const capped = await validate(stages(), {
		"schemas/plan.json": planSchema({ maxItems: 8 }),
	});
	assert.equal(matching(capped, /has no maxItems/).length, 0);
	const stageCap = await validate(stages({ maxItems: 8 }), {
		"schemas/plan.json": planSchema(),
	});
	assert.equal(matching(stageCap, /has no maxItems/).length, 0);

	// A support helper bounds its array in code; the spec cannot show it.
});

test("a foreach source array without minItems warns once; minItems (even 0) or a helper silences it", async () => {
	const stages = (source = {}) => [
		single("plan", {
			output: { controlSchema: "./schemas/plan.json" },
			...source,
		}),
		{
			id: "fe",
			type: "foreach",
			profileRole: "verification",
			from: { source: "plan", path: "$.items" },
			each: { prompt: "Check ${item}." },
		},
	];
	const open = await validate(stages(), {
		"schemas/plan.json": planSchema({ maxItems: 8 }),
	});
	const [warning] = matching(open, /has no minItems/);
	assert.match(
		warning,
		/foreach stage "fe" fans out over "\$\.items" from model stage "plan"/,
	);
	assert.match(warning, /empty answer completes with 0 tasks/);
	assert.match(warning, /minItems: 1/);
	assert.equal(matching(open, /has no minItems/).length, 1);
	assert.equal(matching(open, /has no maxItems/).length, 0);

	// Both gaps give both warnings, each once.
	const both = await validate(stages(), { "schemas/plan.json": planSchema() });
	assert.equal(matching(both, /has no maxItems/).length, 1);
	assert.equal(matching(both, /has no minItems/).length, 1);

	for (const minItems of [0, 1]) {
		const ok = await validate(stages(), {
			"schemas/plan.json": planSchema({ minItems, maxItems: 8 }),
		});
		assert.equal(matching(ok, /has no minItems/).length, 0);
	}
	const helper = await validate(
		[
			{
				id: "plan",
				support: { uses: "./helper.mjs" },
				output: { controlSchema: "./schemas/plan.json" },
			},
			stages()[1],
		],
		{ "schemas/plan.json": planSchema({ maxItems: 8 }) },
	);
	assert.equal(matching(helper, /has no minItems/).length, 0);
});

test("array bounds proven through allOf count; unprovable leaf combinators and hyphenated paths are handled", async () => {
	const stages = (path = "$.items") => [
		single("plan", {
			output: { controlSchema: "./schemas/plan.json" },
		}),
		{
			id: "fe",
			type: "foreach",
			profileRole: "verification",
			from: { source: "plan", path },
			each: { prompt: "Check ${item}." },
		},
	];
	const withItems = (items, key = "items") =>
		schema({ [key]: { type: "array", items: { type: "string" }, ...items } });
	const run = (items, path, key) =>
		validate(stages(path), { "schemas/plan.json": withItems(items, key) });

	// False positive: a lower/upper bound proven through allOf is present.
	const proven = await run({ allOf: [{ minItems: 1 }, { maxItems: 8 }] });
	assert.equal(matching(proven, /has no minItems/).length, 0);
	assert.equal(matching(proven, /has no maxItems/).length, 0);
	const nested = await run({ allOf: [{ allOf: [{ minItems: 1 }] }] });
	assert.equal(matching(nested, /has no minItems/).length, 0);
	// An allOf that proves nothing is still absent.
	const absent = await run({ allOf: [{ description: "x" }] });
	assert.equal(matching(absent, /has no minItems/).length, 1);
	assert.equal(matching(absent, /has no maxItems/).length, 1);

	// Leaf combinators that cannot be proven give no warning either way.
	for (const extra of [
		{ anyOf: [{ minItems: 1 }, { maxItems: 3 }] },
		{ oneOf: [{ minItems: 1 }, { minItems: 2 }] },
		{ allOf: [{ anyOf: [{ minItems: 1 }] }] },
		// Constraints the scan does not evaluate: a finite domain decides what [] and the size are.
		{ allOf: [{ enum: [["one"], ["two"]] }] },
		{ enum: [["one"], ["two"]] },
		{ const: ["one"] },
		{ allOf: [{ const: ["one", "two"] }] },
		{ allOf: [{ oneOf: [{ minItems: 1 }, { minItems: 2 }] }] },
	]) {
		const unknown = await run(extra);
		assert.equal(matching(unknown, /has no minItems/).length, 0);
		assert.equal(matching(unknown, /has no maxItems/).length, 0);
	}

	// False negative: a hyphenated key reads at runtime, so the scan sees the same array.
	const hyphen = await run({}, "$.work-items", "work-items");
	assert.equal(matching(hyphen, /has no minItems/).length, 1);
	assert.equal(matching(hyphen, /has no maxItems/).length, 1);
	const hyphenOk = await run(
		{ minItems: 0, maxItems: 4 },
		"$.work-items",
		"work-items",
	);
	assert.equal(matching(hyphenOk, /has no minItems/).length, 0);
	assert.equal(matching(hyphenOk, /has no maxItems/).length, 0);
	const hyphenProven = await run(
		{ allOf: [{ minItems: 1, maxItems: 4 }] },
		"$.work-items",
		"work-items",
	);
	assert.equal(matching(hyphenProven, /has no minItems/).length, 0);
});

test("m3: a const/enum on an ANCESTOR of the foreach array makes the array bounds unknown, other path checks stay", async () => {
	const stages = (path) => [
		single("plan", { output: { controlSchema: "./schemas/plan.json" } }),
		{
			id: "fe",
			type: "foreach",
			profileRole: "verification",
			from: { source: "plan", path },
			each: { prompt: "Check ${item}." },
		},
	];
	const items = { type: "array", items: { type: "string" } };
	const batchSchemas = {
		const: schema({
			batch: {
				type: "object",
				const: { items: ["one"] },
				properties: { items },
			},
		}),
		enum: schema({
			batch: {
				type: "object",
				enum: [{ items: ["one"] }, { items: ["two"] }],
				properties: { items },
			},
		}),
		deeper: schema({
			rows: {
				type: "array",
				items: {
					type: "object",
					const: { items: ["one"] },
					properties: { items },
				},
			},
		}),
	};
	for (const [name, path] of [
		["const", "$.batch.items"],
		["enum", "$.batch.items"],
		["deeper", "$.rows[*].items"],
	]) {
		const compiled = await validate(stages(path), {
			"schemas/plan.json": batchSchemas[name],
		});
		assert.equal(matching(compiled, /has no minItems/).length, 0, name);
		assert.equal(matching(compiled, /has no maxItems/).length, 0, name);
	}
	// The same shape without the ancestor constraint still warns (the array is not exempt by position).
	const plain = await validate(stages("$.batch.items"), {
		"schemas/plan.json": schema({
			batch: { type: "object", properties: { items } },
		}),
	});
	assert.equal(matching(plain, /has no minItems/).length, 1);
	assert.equal(matching(plain, /has no maxItems/).length, 1);
	// An ancestor constraint does not hide an undeclared loop `until` path (the lookup is still "missing").
	const { lookupControlSchemaPath } = await import(
		"../../dist/core/control-schema-path.js"
	);
	const missing = lookupControlSchemaPath(
		batchSchemas.const,
		"$.batch.nothere",
	);
	assert.equal(missing.status, "missing");
	assert.equal(missing.property, "nothere");
});

test("minItems: 1 on the source array makes an empty model answer an output-validation failure", () => {
	const controlJsonSchema = schema({
		items: { type: "array", items: { type: "string" }, minItems: 1 },
	});
	const output = (items) =>
		`<control>${JSON.stringify({ schema: "s", digest: "d", items })}</control>\n<analysis>x</analysis>\n<refs>[]</refs>`;
	const empty = parseWorkflowOutput(output([]), { controlJsonSchema });
	assert.equal(empty.valid, false);
	assert.match(
		empty.issues.map((issue) => issue.message).join("\n"),
		/array length must be >= 1/,
	);
	const filled = parseWorkflowOutput(output(["a"]), { controlJsonSchema });
	assert.equal(filled.valid, true, JSON.stringify(filled.issues));
});

test("an array that feeds no foreach is not asked for minItems", async () => {
	const compiled = await validate(
		[
			single("review", {
				output: { controlSchema: "./schemas/plan.json" },
			}),
		],
		{ "schemas/plan.json": planSchema({ maxItems: 8 }) },
	);
	assert.equal(matching(compiled, /minItems/).length, 0);
});

test("a foreach inside a dag is checked against its sibling source", async () => {
	const compiled = await validate(
		[
			{
				id: "box",
				type: "dag",
				stages: [
					single("plan", { output: { controlSchema: "./schemas/plan.json" } }),
					{
						id: "fe",
						type: "foreach",
						profileRole: "verification",
						from: { source: "plan", path: "$.items" },
						each: { prompt: "Check ${item}." },
					},
				],
			},
		],
		{ "schemas/plan.json": planSchema() },
	);
	assert.equal(
		matching(compiled, /foreach stage "fe".*has no maxItems/).length,
		1,
	);
});

const loopStages = (until, reviewSchema) => [
	{
		id: "refine",
		type: "loop",
		maxRounds: 3,
		until,
		stages: [
			single("draft"),
			single("review", {
				output: { controlSchema: "./schemas/review.json" },
				prompt: 'Review. {"schema":"x","digest":"x","passed":true}',
			}),
		],
	},
];
const reviewFiles = (extra) => ({
	"schemas/review.json": schema(
		{
			schema: { type: "string" },
			digest: { type: "string" },
			passed: { type: "boolean" },
		},
		extra,
	),
});

test("a loop until path missing from a closed final-child schema is an error", async () => {
	const until = { stage: "review", path: "$.approved", equals: true };
	await assert.rejects(
		validate(loopStages(until), reviewFiles({ additionalProperties: false })),
		(error) => {
			assert.equal(error.issues.length, 1);
			assert.equal(error.issues[0].path, "refine.until");
			assert.match(error.message, /loop "refine" until path "\$\.approved"/);
			assert.match(error.message, /final child "review"/);
			assert.match(error.message, /additionalProperties: false/);
			assert.match(error.message, /Add it to that schema's properties/);
			return true;
		},
	);
	await assert.rejects(
		validate(
			loopStages({
				all: [
					{ stage: "review", path: "$.passed", equals: true },
					{ any: [{ stage: "review", path: "$.nested.ok", equals: true }] },
				],
			}),
			reviewFiles({ additionalProperties: false }),
		),
		/until path "\$\.nested\.ok"/,
	);
});

test("a loop until path that the schema declares, or that wants the field absent, is accepted", async () => {
	const closed = reviewFiles({ additionalProperties: false });
	// Review 2026-11-22: an `any` can still pass through its declared branch, so no error.
	const anyBranch = await validate(
		loopStages({
			any: [
				{ stage: "review", path: "$.passed", equals: true },
				{ stage: "review", path: "$.typo", equals: true },
			],
		}),
		closed,
	);
	assert.ok(Array.isArray(anyBranch.warnings ?? []));
	const ok = await validate(
		loopStages({ stage: "review", path: "$.passed", equals: true }),
		closed,
	);
	assert.equal(matching(ok, /until path/).length, 0);
	const absent = await validate(
		loopStages({ stage: "review", path: "$.blockers", exists: false }),
		closed,
	);
	assert.equal(matching(absent, /until path/).length, 0);
});

test("a loop until path missing from an open schema warns; a final child without a schema is not judged", async () => {
	const open = await validate(
		loopStages({ stage: "review", path: "$.approved", equals: true }),
		reviewFiles(),
	);
	const [warning] = matching(open, /until path/);
	assert.match(warning, /loop stage "refine" until path "\$\.approved"/);
	assert.match(warning, /nothing makes the model emit it/);
	assert.match(warning, /Add "approved"/);

	// No control schema on the final child: nothing to check the path against, so no finding.
	const noSchema = await validate([
		{
			id: "refine",
			type: "loop",
			maxRounds: 2,
			until: { stage: "review", path: "$.passed", equals: true },
			stages: [single("draft"), single("review")],
		},
	]);
	assert.equal(matching(noSchema, /until path/).length, 0);
});

test("a loop until key that the final child's prompt does not show as a JSON key warns", async () => {
	const until = { stage: "review", path: "$.passed", equals: true };
	const withPrompt = (prompt, extra = {}) => [
		{
			id: "refine",
			type: "loop",
			maxRounds: 3,
			until,
			stages: [
				single("draft"),
				single("review", {
					output: { controlSchema: "./schemas/review.json" },
					prompt,
					...extra,
				}),
			],
		},
	];
	const silent = await validate(withPrompt("Review the draft."), reviewFiles());
	const [warning] = matching(silent, /until reads "passed"/);
	assert.ok(warning, silent.warnings.join("\n"));
	assert.match(warning, /loop stage "refine"/);
	assert.match(warning, /final child "review"/);
	assert.match(warning, /"passed":/);
	for (const prompt of [
		'Review. {"schema":"x","digest":"x","passed":true}',
		'Review. Put it in {"passed" : false}.',
	]) {
		const shown = await validate(withPrompt(prompt), reviewFiles());
		assert.equal(matching(shown, /until reads/).length, 0, prompt);
	}
	// A nested path asks for its last key.
	const nested = await validate(
		[
			{
				...withPrompt('Review. {"verdict":{"ok":true}}')[0],
				until: { stage: "review", path: "$.verdict.ok", equals: true },
			},
		],
		{
			"schemas/review.json": schema({
				verdict: schema({ ok: { type: "boolean" } }),
			}),
		},
	);
	assert.equal(matching(nested, /until reads/).length, 0);
});

test("the until-key warning skips exists:false leaves and a path the schema lacks (its own warning)", async () => {
	const loop = (until, finalChild, extra = {}) => [
		{
			id: "refine",
			type: "loop",
			maxRounds: 3,
			until,
			stages: [single("draft"), finalChild],
			...extra,
		},
	];
	const review = (extra = {}) =>
		single("review", {
			output: { controlSchema: "./schemas/review.json" },
			prompt: "Review the draft.",
			...extra,
		});
	const absent = await validate(
		loop({ stage: "review", path: "$.passed", exists: false }, review()),
		reviewFiles(),
	);
	assert.equal(matching(absent, /until reads/).length, 0);
	const undeclared = await validate(
		loop({ stage: "review", path: "$.approved", equals: true }, review()),
		reviewFiles(),
	);
	assert.equal(matching(undeclared, /until reads/).length, 0);
	assert.equal(matching(undeclared, /until path/).length, 1);
});

test("a readOnly stage whose prompt forbids running commands warns; narrowed or effect wording does not", async () => {
	for (const phrase of [
		"Do not run commands.",
		"Never execute any shell commands.",
		"You must not use the shell.",
		"Run no commands: answer from the text.",
		"Avoid running bash commands.",
		"Do not use any command line tools.",
	]) {
		const compiled = await validate([
			single("main", { prompt: `Audit. ${phrase}` }),
		]);
		const [warning] = matching(compiled, /forbids running commands/);
		assert.ok(warning, `expected a warning for: ${phrase}`);
		assert.match(warning, /stage "main" is readOnly/);
		assert.match(warning, /Codex reads files through shell commands/);
		assert.match(warning, /do not modify files/);
	}
	for (const prompt of [
		"Audit. Do not run commands that modify files.",
		"Audit. Do not run commands other than git log and cat.",
		"Audit. Never execute shell commands to write or build anything.",
		"Audit. Do not run any command which changes the checkout.",
		"Audit. Do not run tests, builds or installs; do not modify files.",
		"Audit. Do not use tools other than read.",
		"Audit. Running commands that write is forbidden.",
	]) {
		const compiled = await validate([single("main", { prompt })]);
		assert.equal(
			matching(compiled, /forbids running commands/).length,
			0,
			prompt,
		);
	}
});

test("the command-forbidding warning needs readOnly: a stage-level readOnly:false or an each prompt decides", async () => {
	const prompt = "Audit. Do not run commands.";
	const writer = await validate([single("main", { prompt, readOnly: false })]);
	assert.equal(matching(writer, /forbids running commands/).length, 0);
	const files = {
		"schemas/plan.json": schema({
			items: {
				type: "array",
				minItems: 1,
				maxItems: 3,
				items: { type: "string" },
			},
		}),
	};
	const foreach = await validate(
		[
			single("plan", { output: { controlSchema: "./schemas/plan.json" } }),
			{
				id: "fe",
				type: "foreach",
				profileRole: "verification",
				from: { source: "plan", path: "$.items" },
				each: { prompt: "Check ${item}. Do not execute commands." },
			},
		],
		files,
	);
	const [warning] = matching(foreach, /forbids running commands/);
	assert.match(warning, /stage "fe" is readOnly/);
});

const verifyStage = (files, options = {}, extra = {}) => ({
	id: "verify",
	from: ["write"],
	support: { uses: "./verify.mjs", options: { files, ...options } },
	...extra,
});

test("a write-verify helper whose file path is missing from the writer prompt warns, naming stage, path and writer", async () => {
	const compiled = await validate(
		[
			single("write", { prompt: "Create OUTPUT.md with a heading." }),
			verifyStage([
				{ path: "OUTPUT.md", markers: ["# Output"] },
				{ path: "docs/NOTES.md" },
				{ path: "extra/report.md" },
			]),
		],
		{ "verify.mjs": {} },
	);
	const found = matching(compiled, /does not name that path/);
	assert.equal(found.length, 2, found.join("\n"));
	assert.match(found[0], /stage "verify" checks "docs\/NOTES\.md"/);
	assert.match(found[0], /writer "write"/);
	assert.match(found[1], /"extra\/report\.md"/);
});

test("the writer is options.writer or write; a named path, an unknown writer or another helper shape does not warn", async () => {
	const named = await validate(
		[
			single("author", { prompt: "Write docs/NOTES.md and OUTPUT.md." }),
			single("write", { prompt: "Unrelated." }),
			verifyStage(
				[{ path: "docs/NOTES.md" }, { path: "OUTPUT.md" }],
				{ writer: "author" },
				{ from: ["author"] },
			),
		],
		{ "verify.mjs": {} },
	);
	assert.equal(matching(named, /does not name that path/).length, 0);
	const wrongWriter = await validate(
		[
			single("author", { prompt: "Write docs/NOTES.md." }),
			verifyStage([{ path: "docs/NOTES.md" }], {}, { from: ["author"] }),
		],
		{ "verify.mjs": {} },
	);
	assert.equal(
		matching(wrongWriter, /does not name that path/).length,
		0,
		"no stage called write: nothing to compare",
	);
	const otherShape = await validate(
		[
			single("write", { prompt: "Write something." }),
			{
				id: "check",
				from: ["write"],
				support: {
					uses: "./verify.mjs",
					options: { files: ["a.md"], limit: 3 },
				},
			},
			{
				id: "check2",
				from: ["write"],
				support: { uses: "./verify.mjs", options: { threshold: 2 } },
			},
		],
		{ "verify.mjs": {} },
	);
	assert.equal(matching(otherShape, /does not name that path/).length, 0);
});

test("new authoring-rule warnings are advisory: classified, not strict-blocking", async () => {
	const compiled = await validate([
		single("main", { prompt: "Use ${input.x}.", profileRole: undefined }),
	]);
	const diagnostics = workflowPromptSchemaDiagnostics(compiled);
	const codes = diagnostics.map((diagnostic) => diagnostic.code).sort();
	assert.deepEqual(codes, [
		"prompt.placeholder_unsupported",
		"workflow.profile_role_missing",
	]);
	assert.ok(diagnostics.every((diagnostic) => !diagnostic.strictBlocking));
	assert.ok(diagnostics.every((diagnostic) => diagnostic.stageId === "main"));
	assert.doesNotThrow(() =>
		assertPromptSchemaDiagnosticsAllowRun(diagnostics, {
			AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA: "1",
		}),
	);
});

test("a top-level stage with neither from nor after warns that it reads the previous stage implicitly", async () => {
	const implicit = await validate([
		single("a"),
		single("b"),
		single("c", { from: ["b"] }),
		single("d", { after: [] }),
		single("e", { after: ["a"] }),
	]);
	const found = matching(implicit, /neither from nor after/);
	assert.equal(found.length, 1, found.join("\n"));
	assert.match(found[0], /stage "b" has neither from nor after/);
	assert.doesNotMatch(found[0], /"[acde]"/);
	assert.match(found[0], /from: \[\.\.\.\]/);
	assert.match(found[0], /after: \[\]/);
});

test("a linear spec gets one implicit-chain warning naming every chained stage, not one per stage", async () => {
	const linear = await validate([
		single("a"),
		single("b"),
		single("c"),
		single("d"),
	]);
	const found = matching(linear, /neither from nor after/);
	assert.equal(found.length, 1, found.join("\n"));
	assert.match(found[0], /stages "b", "c", "d" have neither from nor after/);
	assert.doesNotMatch(found[0], /"a"/);
});

test("the first stage, explicit from/after and children of a dag or loop do not warn about an implicit chain", async () => {
	const compiled = await validate(
		[
			single("a"),
			single("b", { after: [] }),
			{
				id: "fan",
				type: "dag",
				after: ["b"],
				outputFrom: "y",
				stages: [single("x"), single("y")],
			},
			{
				id: "refine",
				type: "loop",
				after: ["fan"],
				maxRounds: 2,
				until: { stage: "z", path: "$.ok", equals: true },
				stages: [
					single("w"),
					single("z", { output: { controlSchema: "./z.json" } }),
				],
			},
		],
		{ "z.json": schema({ ok: { type: "boolean" } }) },
	);
	assert.equal(matching(compiled, /neither from nor after/).length, 0);
});
