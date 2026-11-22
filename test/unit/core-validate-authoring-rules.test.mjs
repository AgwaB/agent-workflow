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
	const helper = await validate(
		[
			{
				id: "plan",
				support: { uses: "./helper.mjs" },
				output: { controlSchema: "./schemas/plan.json" },
			},
			stages()[1],
		],
		{ "schemas/plan.json": planSchema() },
	);
	assert.equal(matching(helper, /has no maxItems/).length, 0);
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
