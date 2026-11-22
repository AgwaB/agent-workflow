// test-tier: integration
// `agent-workflow rehearse` (src/core/rehearsal.ts, rehearsal-executor.ts): the real engine with a synthetic
// worker. Rehearses every bundled workflow and scaffold to completion, checks determinism, isolation (R3),
// loop forcing (R5) and catches the lab defects of R6 in small specs. No model, no network.
import assert from "node:assert/strict";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	processesUsingRoot,
	setRehearsalRemoveForTests,
} from "../../dist/core/rehearsal-settle.js";
import { workflowExecutorRegistration } from "../../dist/core/executor-registry.js";
import {
	REHEARSAL_EXECUTOR_ID,
	rehearseWorkflow,
} from "../../dist/core/rehearsal.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLED = [
	"deep-research",
	"deep-review",
	"impact-review",
	"spec-review",
];
const SCAFFOLDS = readdirSync(join(root, "skills/workflow-guide/scaffolds"), {
	withFileTypes: true,
})
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

let base;
let counter = 0;

before(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "aw-rehearsal-")));
});
after(async () => {
	await rm(base, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

async function project() {
	counter += 1;
	const cwd = join(base, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow"), { recursive: true });
	return cwd;
}

/** Write a spec and its schemas into the project; returns the spec path. */
async function writeSpec(cwd, name, spec, schemas = {}) {
	await mkdir(join(cwd, "s"), { recursive: true });
	for (const [file, schema] of Object.entries(schemas))
		await writeFile(join(cwd, "s", file), JSON.stringify(schema));
	const path = join(cwd, `${name}.json`);
	await writeFile(path, JSON.stringify(spec));
	return path;
}

const DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };
const ITEMS_SCHEMA = {
	type: "object",
	required: ["schema", "digest", "items"],
	additionalProperties: false,
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		items: {
			type: "array",
			items: {
				type: "object",
				required: ["id"],
				properties: { id: { type: "string" } },
			},
		},
	},
};
const REVIEW_SCHEMA = {
	type: "object",
	required: ["schema", "digest", "passed", "blockingFailures"],
	additionalProperties: false,
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		passed: { type: "boolean" },
		blockingFailures: { type: "integer", minimum: 0, maximum: 9 },
		failures: { type: "array", maxItems: 5, items: { type: "string" } },
	},
};

function stageOf(report, id) {
	const stage = report.stages.find((entry) => entry.stage === id);
	assert.ok(stage, `no stage ${id} in ${report.stages.map((s) => s.stage)}`);
	return stage;
}

for (const name of BUNDLED) {
	test(`bundled workflow ${name} rehearses to the end with no wiring finding`, async () => {
		const cwd = await project();
		const { report } = await rehearseWorkflow(cwd, { workflow: name });
		assert.deepEqual(report.findings, []);
		assert.equal(report.ok, true);
		assert.ok(report.stages.length >= 3);
		// A helper may gate on content that synthetic output cannot satisfy; nothing else may fail.
		for (const stage of report.stages) {
			assert.deepEqual(stage.failures, [], stage.stage);
			assert.deepEqual(stage.helperErrors, [], stage.stage);
		}
		if (report.status === "failed")
			assert.ok(report.stages.some((stage) => stage.gates.length > 0));
		else assert.equal(report.finalReportRendered, true);
		// No state is left in the project: run state lives in the temporary root.
		assert.deepEqual(await readdir(join(cwd, ".agent-workflow")), []);
	});
}

for (const name of SCAFFOLDS) {
	test(`scaffold ${name} rehearses to the end with no wiring finding`, async () => {
		const cwd = await project();
		const spec = join(
			root,
			"skills/workflow-guide/scaffolds",
			name,
			"spec.json",
		);
		const { report } = await rehearseWorkflow(cwd, { workflow: spec });
		assert.deepEqual(report.findings, []);
		assert.equal(report.ok, true);
		for (const stage of report.stages) {
			assert.deepEqual(stage.failures, [], stage.stage);
			assert.deepEqual(stage.helperErrors, [], stage.stage);
		}
		if (report.status === "completed")
			assert.equal(report.finalReportRendered, true);
		else assert.ok(report.stages.some((stage) => stage.gates.length > 0));
	});
}

test("foreach stages get --items N items (default 2) and the report counts them", async () => {
	const cwd = await project();
	const spec = {
		schemaVersion: 1,
		name: "fan",
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{
					id: "plan",
					type: "single",
					prompt: "Plan the items.",
					output: { controlSchema: "./s/items.schema.json" },
				},
				{
					id: "work",
					type: "foreach",
					from: { source: "plan", path: "$.items" },
					each: { itemIdentityPath: "$.id", prompt: "Do one item." },
				},
			],
		},
	};
	const path = await writeSpec(cwd, "fan", spec, {
		"items.schema.json": ITEMS_SCHEMA,
	});
	const byDefault = (await rehearseWorkflow(cwd, { workflow: path })).report;
	assert.equal(byDefault.ok, true, byDefault.findings.join("\n"));
	assert.equal(stageOf(byDefault, "work").items, 2);
	const five = (await rehearseWorkflow(cwd, { workflow: path, items: 5 }))
		.report;
	assert.equal(stageOf(five, "work").items, 5);
	const none = (await rehearseWorkflow(cwd, { workflow: path, items: 0 }))
		.report;
	assert.equal(stageOf(none, "work").items, 0);
});

test("the same spec and options give a byte-identical report (R2)", async () => {
	const cwd = await project();
	const a = (await rehearseWorkflow(cwd, { workflow: "deep-review", items: 3 }))
		.report;
	const b = (await rehearseWorkflow(cwd, { workflow: "deep-review", items: 3 }))
		.report;
	assert.equal(JSON.stringify(a), JSON.stringify(b));
	const spec = join(
		root,
		"skills/workflow-guide/scaffolds/foreach-reduce/spec.json",
	);
	const c = (await rehearseWorkflow(cwd, { workflow: spec })).report;
	const d = (await rehearseWorkflow(cwd, { workflow: spec })).report;
	assert.equal(JSON.stringify(c), JSON.stringify(d));
});

test("isolation (R3): nothing lands in the user's home or the project; --keep keeps only the temporary root", async () => {
	const cwd = await project();
	const home = process.env.AGENT_WORKFLOW_HOME;
	const before = await readdir(home).catch(() => []);
	const savedHome = process.env.AGENT_WORKFLOW_HOME;
	const savedIndex = process.env.AGENT_WORKFLOW_RUN_INDEX_DIR;
	const spec = join(
		root,
		"skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
	);
	const plain = await rehearseWorkflow(cwd, { workflow: spec });
	assert.equal(plain.stateRoot, undefined);
	assert.deepEqual(await readdir(home).catch(() => []), before);
	assert.deepEqual(await readdir(join(cwd, ".agent-workflow")), []);
	assert.equal(process.env.AGENT_WORKFLOW_HOME, savedHome);
	assert.equal(process.env.AGENT_WORKFLOW_RUN_INDEX_DIR, savedIndex);
	// The synthetic executor is not left registered: no real run can select it.
	assert.equal(workflowExecutorRegistration(REHEARSAL_EXECUTOR_ID), undefined);

	const kept = await rehearseWorkflow(cwd, { workflow: spec, keep: true });
	try {
		assert.ok(kept.stateRoot && existsSync(kept.stateRoot));
		assert.ok(existsSync(join(kept.stateRoot, "home", "projects")));
		assert.deepEqual(await readdir(home).catch(() => []), before);
	} finally {
		await rm(kept.stateRoot, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	}
});

function loopSpec(extra = {}) {
	return {
		schemaVersion: 1,
		name: "loop-demo",
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{
					id: "refine",
					type: "loop",
					maxRounds: 3,
					progressPath: "$.blockingFailures",
					until: { stage: "review", path: "$.passed", equals: true },
					onExhausted: {
						id: "give-up",
						type: "reduce",
						prompt: "Summarize what still fails.",
					},
					stages: [
						{ id: "draft", type: "single", prompt: "Write the draft." },
						{
							id: "review",
							type: "single",
							prompt: "Review the draft.",
							output: { controlSchema: "./s/review.schema.json" },
						},
					],
					...extra,
				},
				{
					id: "publish",
					type: "reduce",
					from: ["refine"],
					inputPolicy: {
						requiredReads: ["refine.review.control"],
						enforcement: "fail",
					},
					prompt: "Publish the final round.",
				},
			],
		},
	};
}

test("loops (R5): until passes on round 1 by default; --loop exhaust runs every round and onExhausted", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "loop", loopSpec(), {
		"review.schema.json": REVIEW_SCHEMA,
	});
	const pass = (await rehearseWorkflow(cwd, { workflow: path })).report;
	assert.equal(pass.ok, true, pass.findings.join("\n"));
	assert.equal(pass.status, "completed");
	assert.deepEqual(
		pass.loops.map(({ loop, status, rounds, maxRounds }) => [
			loop,
			status,
			rounds,
			maxRounds,
		]),
		[["refine", "completed", 1, 3]],
	);
	assert.equal(
		pass.stages.some((stage) => stage.stage === "refine.onExhausted"),
		false,
	);

	const exhaust = (
		await rehearseWorkflow(cwd, { workflow: path, loop: "exhaust" })
	).report;
	assert.equal(exhaust.ok, true, exhaust.findings.join("\n"));
	assert.deepEqual(
		exhaust.loops.map(({ loop, status, rounds }) => [loop, status, rounds]),
		[["refine", "exhausted", 3]],
	);
	assert.ok(
		exhaust.stages.some((stage) => stage.stage === "refine.onExhausted"),
	);
	assert.equal(exhaust.finalReportRendered, true);
});

// ---- R6: the lab defects, as small specs ----

test("R6 empty from:[<loop>] consumer: the consumer receives the loop's last round, and a consumer that gets nothing is flagged", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "loop", loopSpec(), {
		"review.schema.json": REVIEW_SCHEMA,
	});
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	const publish = stageOf(report, "publish");
	assert.deepEqual(publish.sourcesReceived, {
		withSources: 1,
		withoutSources: 0,
	});
	assert.deepEqual(publish.requiredReads, [
		{ read: "refine.review.control", satisfied: true },
	]);
	// The pre-fix engine gave this stage an empty manifest (see REHEARSE.md "red checks"): the same report
	// shape with withoutSources 1 is what raises this finding.
});

test("R6 a source-less consumer is flagged: a stage naming sources whose tasks receive none", async () => {
	const { buildRehearsalReport } = await import("../../dist/core/rehearsal.js");
	const run = {
		runId: "r",
		status: "completed",
		tasks: [
			{
				taskId: "t1",
				specId: "final.main",
				stageId: "final",
				kind: "reduce",
				status: "completed",
				statusDetail: "completed",
			},
		],
	};
	const report = buildRehearsalReport({
		workflow: "w",
		options: { items: 2, loop: "pass" },
		run,
		effects: [
			{ type: "submit", taskId: "t1", specId: "final.main", sources: [] },
		],
		declared: new Map([["final", ["loop"]]]),
		warnings: [],
		normalize: (text) => text,
	});
	assert.equal(report.ok, false);
	assert.match(
		report.findings.join("\n"),
		/stage final names sources \(loop\) but 1 of its task received none/u,
	);
});

test("R6 requiredReads source outside from: validate rejects it and rehearse reports the invalid spec", async () => {
	const cwd = await project();
	const stage = (id, extra = {}) => ({
		id,
		type: "single",
		prompt: `Do ${id}.`,
		output: { controlSchema: "./s/items.schema.json" },
		...extra,
	});
	const path = await writeSpec(
		cwd,
		"scope",
		{
			schemaVersion: 1,
			name: "scope",
			defaults: DEFAULTS,
			artifactGraph: {
				stages: [
					stage("a"),
					stage("b"),
					stage("c", {
						type: "reduce",
						from: ["a"],
						inputPolicy: { requiredReads: ["b.control"], enforcement: "fail" },
					}),
				],
			},
		},
		{ "items.schema.json": ITEMS_SCHEMA },
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.status, "invalid-spec");
	assert.equal(report.ok, false);
	assert.match(
		report.findings.join("\n"),
		/"b" is not one of this stage's sources/u,
	);
});

test("R6 closed control schema without schema/digest: rehearse reports the invalid spec", async () => {
	const cwd = await project();
	const path = await writeSpec(
		cwd,
		"closed",
		{
			schemaVersion: 1,
			name: "closed",
			defaults: DEFAULTS,
			artifactGraph: {
				stages: [
					{
						id: "a",
						type: "single",
						prompt: "Do a.",
						output: { controlSchema: "./s/closed.schema.json" },
					},
				],
			},
		},
		{
			"closed.schema.json": {
				type: "object",
				required: ["x"],
				additionalProperties: false,
				properties: { x: { type: "string" } },
			},
		},
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.status, "invalid-spec");
	assert.match(
		report.findings.join("\n"),
		/every stage control carries "schema", "digest"/u,
	);
});

test("R6 unresolvable requiredReads path: the synthetic worker's real read fails and the report names it", async () => {
	const cwd = await project();
	const spec = (withSchema) => ({
		schemaVersion: 1,
		name: "path",
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{
					id: "a",
					type: "single",
					prompt: "Do a.",
					...(withSchema
						? { output: { controlSchema: "./s/items.schema.json" } }
						: {}),
				},
				{
					id: "c",
					type: "reduce",
					from: ["a"],
					inputPolicy: {
						requiredReads: [
							{ source: "a", artifact: "control", path: "$.nothere" },
						],
						enforcement: "fail",
					},
					prompt: "Do c.",
				},
			],
		},
	});
	for (const withSchema of [true, false]) {
		const path = await writeSpec(cwd, `path${withSchema}`, spec(withSchema), {
			"items.schema.json": ITEMS_SCHEMA,
		});
		const { report } = await rehearseWorkflow(cwd, { workflow: path });
		assert.equal(report.ok, false);
		const stage = stageOf(report, "c");
		assert.equal(stage.requiredReads.length, 1);
		assert.equal(stage.requiredReads[0].satisfied, false);
		assert.match(
			stage.requiredReads[0].message,
			/path did not resolve: \$\.nothere/u,
		);
		assert.match(
			report.findings.join("\n"),
			/required read a\.control \$\.nothere does not resolve/u,
		);
	}
});

test("a helper that throws is reported with its message, not as a bare failed run", async () => {
	const cwd = await project();
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, "helpers", "boom.mjs"),
		'export default async function () { throw new Error("helper exploded on purpose"); }\n',
	);
	const path = await writeSpec(cwd, "boom", {
		schemaVersion: 1,
		name: "boom",
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{ id: "a", type: "single", prompt: "Do a." },
				{
					id: "b",
					from: "a",
					support: { uses: "./helpers/boom.mjs" },
				},
			],
		},
	});
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, false);
	assert.match(report.findings.join("\n"), /helper exploded on purpose/u);
});

test("a spec that does not load is reported as invalid, not thrown", async () => {
	const cwd = await project();
	const { report } = await rehearseWorkflow(cwd, {
		workflow: "no-such-workflow",
	});
	assert.equal(report.status, "invalid-spec");
	assert.equal(report.ok, false);
	assert.ok(report.validationIssues.length > 0);
});

test("option problems throw before anything runs", async () => {
	const cwd = await project();
	await assert.rejects(
		rehearseWorkflow(cwd, { workflow: "" }),
		/workflow name/u,
	);
	await assert.rejects(
		rehearseWorkflow(cwd, { workflow: "x", items: -1 }),
		/--items/u,
	);
	await assert.rejects(
		rehearseWorkflow(cwd, { workflow: "x", loop: "maybe" }),
		/--loop/u,
	);
});

const ONE_STAGE = {
	schemaVersion: 1,
	name: "one",
	defaults: DEFAULTS,
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Summarize." }],
	},
};

/**
 * Deterministic slow-down: the durable worker's detached terminal finalizer starts 3s late (a worker
 * hook wraps its spawn in `sleep 3; exec`). The engine can already see the run end by then.
 */
async function withLateFinalizer(dir, body) {
	const hook = join(dir, "late-finalizer.mjs");
	await writeFile(
		hook,
		`import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const realSpawn = cp.spawn;
if (String(process.argv[1]).endsWith("durable-worker.js")) {
	cp.spawn = (command, args, options) =>
		Array.isArray(args) && String(args[0]).endsWith("terminal-finalizer.js")
			? realSpawn("/bin/sh", ["-c", 'sleep 3; exec "$0" "$@"', command, ...args], options)
			: realSpawn(command, args, options);
	syncBuiltinESMExports();
}
`,
	);
	const saved = { options: process.env.NODE_OPTIONS, tmp: process.env.TMPDIR };
	process.env.NODE_OPTIONS = `${saved.options ?? ""} --import=${hook}`.trim();
	try {
		return await body();
	} finally {
		for (const [name, value] of [
			["NODE_OPTIONS", saved.options],
			["TMPDIR", saved.tmp],
		]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("a late durable finalizer is awaited: no process or file is left under the temporary root", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await project();
	const scratch = realpathSync(await mkdtemp(join(base, "tmp-")));
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	const result = await withLateFinalizer(scratch, async () => {
		process.env.TMPDIR = scratch;
		return await rehearseWorkflow(cwd, { workflow: path });
	});
	assert.equal(result.report.ok, true, result.report.findings.join("\n"));
	assert.equal(result.leftover, undefined);
	assert.deepEqual(await processesUsingRoot(scratch), []);
	// Only the hook file is in the scratch directory: the rehearsal root is gone and stays gone.
	await new Promise((resolve) => setTimeout(resolve, 4000));
	assert.deepEqual(readdirSync(scratch), ["late-finalizer.mjs"]);
});

test("a temporary root that cannot be removed is reported as leftover, not thrown", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	setRehearsalRemoveForTests(() => {
		throw Object.assign(new Error("ENOTEMPTY: directory not empty"), {
			code: "ENOTEMPTY",
		});
	});
	let result;
	try {
		result = await rehearseWorkflow(cwd, { workflow: path });
	} finally {
		setRehearsalRemoveForTests(undefined);
	}
	assert.equal(result.report.ok, true);
	assert.match(result.leftover, /aw-rehearse-/u);
	assert.ok(existsSync(result.leftover));
	await rm(result.leftover, { recursive: true, force: true });
});
