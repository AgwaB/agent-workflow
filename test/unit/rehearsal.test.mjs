// test-tier: integration
// `agent-workflow rehearse` (src/core/rehearsal.ts, rehearsal-executor.ts): the real engine with a synthetic
// worker. Rehearses every bundled workflow and scaffold to completion, checks determinism, isolation (R3),
// loop forcing (R5) and catches the lab defects of R6 in small specs. No model, no network.
import assert from "node:assert/strict";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
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
	setRehearsalPsCommandForTests,
	setRehearsalPsForTests,
	setRehearsalRemoveForTests,
	waitForRootProcesses,
} from "../../dist/core/rehearsal-settle.js";
import { workflowExecutorRegistration } from "../../dist/core/executor-registry.js";
import {
	REHEARSAL_EXECUTOR_ID,
	rehearseWorkflow,
	setRehearsalSettleWaitForTests,
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
		if (report.status === "content-gates")
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

/** A project with an `a` model stage, a support helper `g` that returns `control`, and a consumer `c` of `g`. */
async function gateProject(name, control, extraStages = []) {
	const cwd = await project();
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, "helpers", "gate.mjs"),
		`export default async function () { return ${JSON.stringify(control)}; }\n`,
	);
	const path = await writeSpec(cwd, name, {
		schemaVersion: 1,
		name,
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{ id: "a", type: "single", prompt: "Do a." },
				{ id: "g", from: "a", support: { uses: "./helpers/gate.mjs" } },
				{ id: "c", type: "reduce", from: ["g"], prompt: "Do c." },
				...extraStages,
			],
		},
	});
	return { cwd, path };
}

test("wiring OK: a sound workflow is completed, ok, with no gates", async () => {
	const { cwd, path } = await gateProject("sound", {
		schema: "g-v1",
		digest: "fine",
		status: "passed",
	});
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true);
	assert.equal(report.status, "completed");
	assert.equal(report.runStatus, "completed");
	assert.deepEqual(report.skippedAfterGates, []);
	assert.equal(report.stages.flatMap((stage) => stage.gates).length, 0);
});

for (const declared of ["failed", "blocked"]) {
	test(`content-gates: a helper declaring ${declared} is ok, names the gate and its reason, and lists skipped stages`, async () => {
		const { cwd, path } = await gateProject(`gate-${declared}`, {
			schema: "g-v1",
			digest: "3 of 20 tickets classified; 17 missing",
			status: declared,
		});
		const { report } = await rehearseWorkflow(cwd, { workflow: path });
		assert.equal(report.ok, true, report.findings.join("\n"));
		assert.equal(report.status, "content-gates");
		assert.equal(report.runStatus, declared);
		assert.deepEqual(report.findings, []);
		assert.deepEqual(report.skippedAfterGates, ["c"]);
		const [gate] = stageOf(report, "g").gates;
		assert.equal(gate.task, "g.main");
		assert.equal(gate.status, declared);
		assert.match(gate.reasons.join(), /17 missing/u);
	});
}

/** A project whose helper `g` (wired from `a`) runs `body`, a function body over `{ sources }`. */
async function sourceLookupProject(name, body) {
	const cwd = await project();
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, "helpers", "lookup.mjs"),
		`export default async function ({ sources }) { ${body} }\n`,
	);
	const path = await writeSpec(cwd, name, {
		schemaVersion: 1,
		name,
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{ id: "a", type: "single", prompt: "Do a." },
				{ id: "g", from: "a", support: { uses: "./helpers/lookup.mjs" } },
				{ id: "c", type: "reduce", from: ["g"], prompt: "Do c." },
			],
		},
	});
	return { cwd, path };
}

for (const declared of ["failed", "blocked"]) {
	test(`wiring: a helper that looks up an undeclared source and declares ${declared} is a finding, not a content gate`, async () => {
		const { cwd, path } = await sourceLookupProject(
			`wrong-source-${declared}`,
			`const row = sources.extract; if (!row) return { schema: "g-v1", status: "${declared}", digest: "source extract is missing" }; return { schema: "g-v1", status: "passed", digest: "ok" };`,
		);
		const { report } = await rehearseWorkflow(cwd, { workflow: path });
		assert.equal(report.ok, false);
		assert.notEqual(report.status, "content-gates");
		assert.match(
			report.findings.join("\n"),
			/stage g: helper g\.main asked for source "extract", which is not one of its sources \(a\)/u,
		);
	});
}

test("wiring: a probe with `in` or a bracket lookup of an undeclared source is reported too", async () => {
	const { cwd, path } = await sourceLookupProject(
		"wrong-source-in",
		'if (!("extract" in sources)) return { schema: "g-v1", status: "blocked", digest: "nothing" }; return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, false);
	assert.match(report.findings.join("\n"), /asked for source "extract"/u);
});

test("content gate stays green: declared source looked up correctly, helper rejects the data", async () => {
	const { cwd, path } = await sourceLookupProject(
		"right-source",
		'const row = sources.a; return { schema: "g-v1", status: row ? "blocked" : "passed", digest: "0 of 20 classified" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true, report.findings.join("\n"));
	assert.equal(report.status, "content-gates");
	assert.deepEqual(report.findings, []);
});

test("sources stay an ordinary object for helpers (keys, spread, JSON, inherited methods, plain prototype)", async () => {
	const { cwd, path } = await sourceLookupProject(
		"ordinary-sources",
		'const copy = structuredClone({ ...sources }); const text = JSON.stringify({ ...sources }); if (Object.keys(sources).join() !== "a" || !Object.hasOwn(copy, "a") || !text.includes("a") || !sources.hasOwnProperty("a") || String(sources) !== "[object Object]") throw new Error("sources is not ordinary"); return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true, report.findings.join("\n"));
	assert.equal(report.status, "completed");
});

test("N3: sources has the plain-object prototype and passes the sdk plain-object check, still recording misses", async () => {
	const { isPlainObject } = await import("../../dist/sdk/json.js");
	const { probeSupportSources } = await import(
		"../../dist/core/support-source-probe.js"
	);
	const probe = probeSupportSources({ a: { x: 1 } }, ["a"]);
	assert.equal(Object.getPrototypeOf(probe.sources), Object.prototype);
	assert.equal(isPlainObject(probe.sources), true);
	assert.deepEqual({ ...probe.sources }, { a: { x: 1 } });
	assert.equal(probe.sources.nope, undefined);
	assert.equal("nope2" in probe.sources, false);
	assert.equal(Object.hasOwn(probe.sources, "nope3"), false);
	assert.deepEqual(probe.misses(), ["nope", "nope2", "nope3"]);
	const { cwd, path } = await sourceLookupProject(
		"plain-check",
		'const proto = Object.getPrototypeOf(sources); if (proto !== Object.prototype) throw new Error("sources is not a plain object"); return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true, report.findings.join("\n"));
});

test("wiring problems: a real finding next to a gate is still a finding (not content-gates)", async () => {
	const { cwd, path } = await gateProject(
		"gate-and-wiring",
		{ schema: "g-v1", digest: "rejected", status: "failed" },
		[
			{
				id: "r",
				type: "reduce",
				from: ["a"],
				inputPolicy: {
					requiredReads: [
						{ source: "a", artifact: "control", path: "$.nothere" },
					],
					enforcement: "fail",
				},
				prompt: "Do r.",
			},
		],
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, false);
	assert.notEqual(report.status, "content-gates");
	assert.match(
		report.findings.join("\n"),
		/required read a\.control \$\.nothere does not resolve/u,
	);
	assert.equal(stageOf(report, "g").gates.length, 1);
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

test("a failing `ps` is not read as quiet: the wait keeps polling to the deadline and says unknown", async () => {
	let calls = 0;
	setRehearsalPsForTests(async () => {
		calls += 1;
		throw Object.assign(new Error("fork: Resource temporarily unavailable"), {
			code: "EAGAIN",
		});
	});
	try {
		assert.equal(
			await waitForRootProcesses("/tmp/aw-root", 300, 20),
			"unknown",
		);
		assert.ok(calls > 3, `polled ${calls} times`);
		// A scan that recovers is believed: the root has no process.
		let failures = 2;
		setRehearsalPsForTests(async () => {
			if (failures-- > 0) throw new Error("transient");
			return "  1 /sbin/launchd\n";
		});
		assert.equal(await waitForRootProcesses("/tmp/aw-root", 2000, 10), "quiet");
		assert.equal(failures, -1);
		// A process naming the root is waited for even after a failed scan.
		let step = 0;
		setRehearsalPsForTests(async () => {
			step += 1;
			if (step === 1) throw new Error("transient");
			return step < 4 ? "  42 node /tmp/aw-root/worker.mjs\n" : "";
		});
		assert.equal(await waitForRootProcesses("/tmp/aw-root", 2000, 10), "quiet");
		assert.equal(step, 4);
	} finally {
		setRehearsalPsForTests(undefined);
	}
});

test("a process still using the root at the deadline is busy, even if later scans fail", async () => {
	let step = 0;
	setRehearsalPsForTests(async () => {
		step += 1;
		if (step > 2) throw new Error("transient");
		return "  42 node /tmp/aw-root/worker.mjs\n";
	});
	try {
		assert.equal(await waitForRootProcesses("/tmp/aw-root", 200, 20), "busy");
	} finally {
		setRehearsalPsForTests(undefined);
	}
});

test("a missing `ps` (ENOENT) is unknown at once: nothing can be said about the root", async () => {
	let calls = 0;
	setRehearsalPsForTests(async () => {
		calls += 1;
		throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" });
	});
	try {
		const started = Date.now();
		assert.equal(
			await waitForRootProcesses("/tmp/aw-root", 5000, 20),
			"unknown",
		);
		assert.equal(calls, 1);
		assert.ok(Date.now() - started < 1000);
	} finally {
		setRehearsalPsForTests(undefined);
	}
});

test("each `ps` call is bounded by the deadline: a hung ps cannot hold the wait past it", async () => {
	setRehearsalPsForTests(() => new Promise(() => {}));
	try {
		const started = Date.now();
		assert.equal(
			await waitForRootProcesses("/tmp/aw-root", 300, 20),
			"unknown",
		);
		assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
	} finally {
		setRehearsalPsForTests(undefined);
	}
});

test("M6: the `ps` child the wait itself started ends with the wait, not when it would have finished", async () => {
	const script = join(base, "slow-ps.mjs");
	const pidFile = join(base, "slow-ps.pid");
	await writeFile(
		script,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 3000);\n`,
	);
	setRehearsalPsCommandForTests(process.execPath, [script]);
	try {
		assert.equal(
			await waitForRootProcesses("/tmp/aw-root", 400, 20),
			"unknown",
		);
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(pid > 0);
		const waited = Date.now();
		let alive = true;
		while (alive && Date.now() - waited < 1000) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 20));
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, "the scanner child was ended with the wait");
		assert.ok(Date.now() - waited < 600, "ended within a small margin");
	} finally {
		setRehearsalPsCommandForTests(undefined);
	}
});

/** Rehearse with a hooked `ps` and a spy on the removal; returns what the rehearsal left. */
async function rehearseWithPs(ps) {
	const cwd = await project();
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	const removed = [];
	setRehearsalPsForTests(ps);
	setRehearsalRemoveForTests((root) => {
		removed.push(root);
		rmSync(root, { recursive: true, force: true });
	});
	setRehearsalSettleWaitForTests(300);
	try {
		const result = await rehearseWorkflow(cwd, { workflow: path });
		return { result, removed };
	} finally {
		setRehearsalPsForTests(undefined);
		setRehearsalRemoveForTests(undefined);
		setRehearsalSettleWaitForTests(undefined);
	}
}

for (const [label, ps] of [
	[
		"ps failing until the deadline",
		async () => {
			throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
		},
	],
	[
		"ps unavailable",
		async () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
	],
	["ps hanging", () => new Promise(() => {})],
	[
		"a writer still alive at the deadline",
		async (root) => `  4242 node ${root}/home/worker.mjs\n`,
	],
]) {
	test(`settle: ${label} keeps the temporary root and reports it as left behind`, async () => {
		const { result, removed } = await rehearseWithPs(ps);
		try {
			assert.equal(result.report.ok, true, result.report.findings.join("\n"));
			assert.deepEqual(removed, [], "the root was not removed");
			assert.match(result.leftover, /aw-rehearse-/u);
			assert.ok(existsSync(result.leftover), "the reported path exists");
		} finally {
			if (result.leftover !== undefined)
				await rm(result.leftover, { recursive: true, force: true });
		}
	});
}

test("settle: a quiet root is still removed (no regression of the eventual-quiet path)", async () => {
	let calls = 0;
	const { result, removed } = await rehearseWithPs(async (root) => {
		calls += 1;
		return calls < 3 ? `  4242 node ${root}/home/worker.mjs\n` : "";
	});
	assert.equal(result.leftover, undefined);
	assert.equal(removed.length, 1);
	assert.equal(existsSync(removed[0]), false);
});
