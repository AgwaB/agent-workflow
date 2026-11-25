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
	settleRunWork,
	setSupervisorTickForTests,
} from "../../dist/core/engine.js";
import {
	isTerminalWorkflowStatus,
	readRunRecord,
	setRunLeaseTestHooksForTests,
} from "../../dist/core/store.js";
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

test("isolation (R3): engine work still in flight when the run ends never writes into the user's home", async () => {
	// A supervisor tick is an async chain that outlives the run it watches. Hold one between its read of
	// the run and its scheduling step until the run is terminal and the rehearsal is done with it: before
	// the fix the rehearsal restored the environment first, so the tick then resolved its project state
	// from the user's home and created `projects/<id>` there.
	const cwd = await project();
	const outer = await mkdtemp(join(base, "outer-"));
	const saved = {
		home: process.env.AGENT_WORKFLOW_HOME,
		index: process.env.AGENT_WORKFLOW_RUN_INDEX_DIR,
	};
	process.env.AGENT_WORKFLOW_HOME = outer;
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(outer, "run-index");
	const before = await readdir(outer);
	const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
	let heldRun;
	setSupervisorTickForTests({
		pollIntervalMs: 5,
		hook: async (_phase, runId) => {
			if (heldRun !== undefined) return;
			heldRun = runId;
			for (let i = 0; i < 1000; i += 1) {
				const run = await readRunRecord(cwd, runId).catch(() => undefined);
				if (run === undefined || isTerminalWorkflowStatus(run.status)) break;
				await sleep(10);
			}
			// Released once the user's environment is back (the unfixed order), or after a bounded hold.
			for (
				let i = 0;
				i < 200 && process.env.AGENT_WORKFLOW_HOME !== outer;
				i += 1
			)
				await sleep(10);
		},
	});
	try {
		await rehearseWorkflow(cwd, {
			workflow: join(
				root,
				"skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
			),
		});
		assert.ok(heldRun !== undefined, "a supervisor tick reached the hook");
		await settleRunWork(cwd, heldRun); // the held tick finishes; under the user's environment now
		assert.deepEqual(await readdir(outer), before);
	} finally {
		setSupervisorTickForTests(undefined);
		for (const [name, value] of [
			["AGENT_WORKFLOW_HOME", saved.home],
			["AGENT_WORKFLOW_RUN_INDEX_DIR", saved.index],
		]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

/** A dynamic parent whose controller only awaits one child workflow (a `ctx.workflow` descendant run). */
async function nestedProject() {
	const cwd = await project();
	const stage = {
		id: "main",
		type: "single",
		prompt: "Do the work.",
	};
	const spec = (stages) => ({
		schemaVersion: 1,
		name: "nested-demo",
		defaults: DEFAULTS,
		artifactGraph: { stages },
	});
	await mkdir(join(cwd, "child"), { recursive: true });
	await writeFile(
		join(cwd, "child", "spec.json"),
		JSON.stringify(spec([stage])),
	);
	await writeFile(
		join(cwd, "controller.mjs"),
		"export default async ctx => { const child = await ctx.workflow('child', 'child'); return { control: { digest: 'done', child: child.status } }; };\n",
	);
	const path = join(cwd, "parent.json");
	await writeFile(
		path,
		JSON.stringify(
			spec([
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: {
						uses: "./controller.mjs",
						workflows: { child: { uses: "./child/spec.json" } },
					},
				},
			]),
		),
	);
	return { cwd, path };
}

/**
 * Hold the first supervisor tick of a run that satisfies `pick` (a descendant run; the parent's own tick is
 * covered by the R3 test above, since a parent's watch starts only after its controller returned) until the
 * user's environment is back (the unfixed order) or a bounded time passes, then report what the outer home holds.
 */
async function lateTickProbe({ pick }) {
	const { cwd, path } = await nestedProject();
	const outer = await mkdtemp(join(base, "outer-"));
	const saved = {
		home: process.env.AGENT_WORKFLOW_HOME,
		index: process.env.AGENT_WORKFLOW_RUN_INDEX_DIR,
	};
	process.env.AGENT_WORKFLOW_HOME = outer;
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(outer, "run-index");
	const before = await readdir(outer);
	const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
	let held;
	setSupervisorTickForTests({
		pollIntervalMs: 8,
		hook: async (_phase, runId) => {
			if (held !== undefined) return;
			const run = await readRunRecord(cwd, runId).catch(() => undefined);
			if (run === undefined || !pick(run)) return;
			held = runId;
			for (
				let i = 0;
				i < 150 && process.env.AGENT_WORKFLOW_HOME !== outer;
				i += 1
			)
				await sleep(10);
		},
	});
	try {
		const { report } = await rehearseWorkflow(cwd, { workflow: path });
		await sleep(800);
		return { held, report, before, after: await readdir(outer) };
	} finally {
		setSupervisorTickForTests(undefined);
		for (const [name, value] of [
			["AGENT_WORKFLOW_HOME", saved.home],
			["AGENT_WORKFLOW_RUN_INDEX_DIR", saved.index],
		]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("isolation (R4): a descendant run's supervisor tick held past the rehearsal never writes into the user's home", async () => {
	const probe = await lateTickProbe({
		pick: (run) => run.parentRunId !== undefined,
	});
	assert.ok(
		probe.held !== undefined,
		"a child supervisor tick reached the hook",
	);
	assert.equal(
		probe.report.status,
		"completed",
		probe.report.findings.join("\n"),
	);
	assert.deepEqual(probe.after, probe.before);
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

test("code-decided loops rehearse real controls, without model loop forcing", async () => {
	const cwd = await project();
	const spec = loopSpec();
	const loop = spec.artifactGraph.stages[0];
	loop.progressPath = "$.blockingFailures";
	delete loop.onExhausted;
	loop.stages[1] = {
		id: "review",
		support: { uses: "./review.mjs" },
		output: { controlSchema: "./s/review.schema.json" },
	};
	const path = await writeSpec(cwd, "loop-code", spec, {
		"review.schema.json": REVIEW_SCHEMA,
	});
	await writeFile(
		join(path, "..", "review.mjs"),
		`export default ({ context }) => ({ passed: context.loop.round === 2, blockingFailures: 3 - context.loop.round });`,
	);
	for (const mode of ["pass", "exhaust"]) {
		const { report } = await rehearseWorkflow(cwd, {
			workflow: path,
			loop: mode,
		});
		assert.equal(report.ok, true, report.findings.join("\n"));
		assert.deepEqual(
			report.loops.map(({ status, rounds, forced }) => [
				status,
				rounds,
				forced,
			]),
			[["completed", 2, []]],
		);
	}
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
	test(`wiring: a helper that looks up an undeclared source and declares ${declared} is an advisory warning, not a finding`, async () => {
		const { cwd, path } = await sourceLookupProject(
			`wrong-source-${declared}`,
			`const row = sources.extract; if (!row) return { schema: "g-v1", status: "${declared}", digest: "source extract is missing" }; return { schema: "g-v1", status: "passed", digest: "ok" };`,
		);
		const { report } = await rehearseWorkflow(cwd, { workflow: path });
		// The static scan is advisory (R4-1/R4-2): it prints as a warning and never fails the rehearsal.
		assert.equal(report.ok, true, report.findings.join("\n"));
		assert.deepEqual(report.findings, []);
		assert.match(
			report.warnings.join("\n"),
			/stage "g" support helper "\.\/helpers\/lookup\.mjs" looks up source "extract", which is not one of its sources \(a\)/u,
		);
	});
}

test("wiring: a probe with `in` or a bracket lookup of an undeclared source is a warning too", async () => {
	const { cwd, path } = await sourceLookupProject(
		"wrong-source-in",
		'if (!("extract" in sources)) return { schema: "g-v1", status: "blocked", digest: "nothing" }; return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true, report.findings.join("\n"));
	assert.match(report.warnings.join("\n"), /looks up source "extract"/u);
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

test("sources is the engine's plain object: structuredClone, spread, JSON, keys and property writes all work", async () => {
	const { cwd, path } = await sourceLookupProject(
		"ordinary-sources",
		'const whole = structuredClone(sources); const copy = structuredClone({ ...sources }); const text = JSON.stringify({ ...sources }); sources.derived = { n: 1 }; if (Object.getPrototypeOf(sources) !== Object.prototype || Object.keys(whole).join() !== "a" || !Object.hasOwn(copy, "a") || !text.includes("a") || !sources.hasOwnProperty("a") || sources.derived.n !== 1 || String(sources) !== "[object Object]") throw new Error("sources is not ordinary"); return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const { report } = await rehearseWorkflow(cwd, { workflow: path });
	assert.equal(report.ok, true, report.findings.join("\n"));
	assert.equal(report.status, "completed");
	assert.deepEqual(report.findings, []);
});

test("R3-1: a helper that only assigns a property of sources is no finding; a failed hasOwn check on a wrong name is", async () => {
	const written = await sourceLookupProject(
		"assign-only",
		'sources.derived = { n: 1 }; return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const ok = await rehearseWorkflow(written.cwd, { workflow: written.path });
	assert.equal(ok.report.ok, true, ok.report.findings.join("\n"));
	assert.equal(ok.report.status, "completed");
	const hasOwn = await sourceLookupProject(
		"has-own-wrong",
		'if (!Object.hasOwn(sources, "wrongName")) return { schema: "g-v1", status: "blocked", digest: "missing" }; return { schema: "g-v1", status: "passed", digest: "ok" };',
	);
	const bad = await rehearseWorkflow(hasOwn.cwd, { workflow: hasOwn.path });
	assert.equal(bad.report.ok, true, bad.report.findings.join("\n"));
	assert.match(bad.report.warnings.join("\n"), /looks up source "wrongName"/u);
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
	await removeKeptRoot(result.leftover);
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

/**
 * Remove a root a test rehearsal kept on purpose. Its durable worker or terminal finalizer may still be writing
 * (the hooked `ps` let the rehearsal return without waiting), so wait for them with the real `ps` first and retry
 * the removal: a plain rm raced them (ENOTEMPTY, 2 of ~5 runs).
 */
async function removeKeptRoot(root) {
	if (typeof root !== "string") return;
	setRehearsalPsForTests(undefined);
	await waitForRootProcesses(root, 10_000);
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
}

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
			await removeKeptRoot(result.leftover);
		}
	});
}

test("N4: a rehearsal that throws after keeping its temporary root reports the kept path on the error", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	setRehearsalPsForTests(async () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
	setRehearsalSettleWaitForTests(100);
	const controller = new AbortController();
	controller.abort();
	let error;
	try {
		await rehearseWorkflow(cwd, { workflow: path, signal: controller.signal });
	} catch (caught) {
		error = caught;
	} finally {
		setRehearsalPsForTests(undefined);
		setRehearsalSettleWaitForTests(undefined);
	}
	assert.ok(error instanceof Error, "the cancelled rehearsal threw");
	try {
		assert.match(error.retainedRoot, /aw-rehearse-/u);
		assert.ok(existsSync(error.retainedRoot), "the reported path exists");
		assert.ok(
			error.message.includes(error.retainedRoot),
			`the message names the kept path: ${error.message}`,
		);
	} finally {
		await removeKeptRoot(error.retainedRoot);
	}
});

test("N4: a frozen abort reason is not mutated; the thrown error wraps it with cause, reason and the kept path", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	setRehearsalPsForTests(async () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
	setRehearsalSettleWaitForTests(100);
	const reason = Object.freeze(new Error("cancelled by host"));
	let error;
	try {
		await rehearseWorkflow(cwd, {
			workflow: path,
			signal: AbortSignal.abort(reason),
		});
	} catch (caught) {
		error = caught;
	} finally {
		setRehearsalPsForTests(undefined);
		setRehearsalSettleWaitForTests(undefined);
	}
	try {
		assert.ok(error instanceof Error, "an error was thrown");
		assert.notEqual(error, reason, "a fresh error, not the caller's");
		assert.equal(error.cause, reason);
		assert.match(error.message, /cancelled by host/u);
		assert.match(error.retainedRoot, /aw-rehearse-/u);
		assert.ok(error.message.includes(error.retainedRoot));
		assert.ok(existsSync(error.retainedRoot), "the reported path exists");
		assert.equal(
			reason.message,
			"cancelled by host",
			"the reason is untouched",
		);
		assert.equal(Object.hasOwn(reason, "retainedRoot"), false);
	} finally {
		await removeKeptRoot(error?.retainedRoot);
	}
});

test("R3-2: a rehearsal waiting in the queue rejects promptly on its own abort and never runs its body", async () => {
	const a = await project();
	const aPath = await writeSpec(a, "one", ONE_STAGE);
	const b = await project();
	const mark = join(b, "ran.txt");
	await mkdir(join(b, "helpers"), { recursive: true });
	await writeFile(
		join(b, "helpers", "mark.mjs"),
		`import { writeFileSync } from "node:fs"; export default async function () { writeFileSync(${JSON.stringify(mark)}, "ran"); return { schema: "g-v1", status: "passed", digest: "ok" }; }\n`,
	);
	const bPath = await writeSpec(b, "marked", {
		schemaVersion: 1,
		name: "marked",
		defaults: DEFAULTS,
		artifactGraph: {
			stages: [
				{ id: "a", type: "single", prompt: "Do a." },
				{ id: "g", from: "a", support: { uses: "./helpers/mark.mjs" } },
			],
		},
	});
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let held;
	const holding = new Promise((resolve) => {
		held = resolve;
	});
	setRehearsalPsForTests(async () => {
		held();
		await gate;
		return "";
	});
	setRehearsalSettleWaitForTests(20_000);
	let first;
	try {
		// A is held at its final process scan; B queues behind it and is cancelled while queued.
		first = rehearseWorkflow(a, { workflow: aPath });
		await holding;
		const controller = new AbortController();
		const second = rehearseWorkflow(b, {
			workflow: bPath,
			keep: true,
			signal: controller.signal,
		});
		controller.abort(new Error("cancelled while queued"));
		const outcome = await Promise.race([
			second.then(
				() => "resolved",
				(error) => error,
			),
			new Promise((resolve) => setTimeout(() => resolve("pending"), 1500)),
		]);
		assert.notEqual(outcome, "pending", "B rejected without waiting for A");
		assert.match(String(outcome?.message), /cancelled while queued/u);
		assert.equal(outcome?.retainedRoot, undefined, "B never created a root");
		// A pre-aborted signal behind a busy queue is the same.
		const early = AbortSignal.abort(new Error("already aborted"));
		const third = await Promise.race([
			rehearseWorkflow(b, { workflow: bPath, signal: early }).then(
				() => "resolved",
				(error) => error,
			),
			new Promise((resolve) => setTimeout(() => resolve("pending"), 1500)),
		]);
		assert.notEqual(third, "pending");
		assert.match(String(third?.message), /already aborted/u);
		release();
		await first;
		// A later call runs after the skipped ones: B's helper never executed.
		const later = await rehearseWorkflow(a, { workflow: aPath });
		assert.equal(later.report.ok, true, later.report.findings.join("\n"));
		assert.equal(
			existsSync(mark),
			false,
			"the cancelled rehearsal's body did not run",
		);
	} finally {
		release();
		await first?.catch(() => undefined);
		setRehearsalPsForTests(undefined);
		setRehearsalSettleWaitForTests(undefined);
	}
});

test("R3-3: the exception path never calls a root safe to delete when the last scan was busy or unknown", async () => {
	for (const [label, ps, expected] of [
		[
			"busy",
			async (root) => `  4242 node ${root}/home/worker.mjs\n`,
			/a worker process was still using it/u,
		],
		[
			"unknown",
			async () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
			/could not be checked/u,
		],
	]) {
		const cwd = await project();
		const path = await writeSpec(cwd, "one", ONE_STAGE);
		setRehearsalPsForTests(ps);
		setRehearsalSettleWaitForTests(100);
		const controller = new AbortController();
		controller.abort();
		let error;
		try {
			await rehearseWorkflow(cwd, {
				workflow: path,
				signal: controller.signal,
			});
		} catch (caught) {
			error = caught;
		} finally {
			setRehearsalPsForTests(undefined);
			setRehearsalSettleWaitForTests(undefined);
		}
		try {
			assert.ok(error instanceof Error, label);
			assert.ok(error.message.includes(error.retainedRoot), label);
			assert.match(error.message, expected, label);
			assert.match(
				error.message,
				/wait for workers to exit before removing it/u,
			);
			assert.doesNotMatch(error.message, /safe to delete by hand/u, label);
		} finally {
			await removeKeptRoot(error?.retainedRoot);
		}
	}
});

test("R3-3 (R4): the retained-root note is appended even when the original message already names a file under the root", async () => {
	const cwd = await project();
	const path = await writeSpec(cwd, "one", ONE_STAGE);
	setRehearsalPsForTests(async () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
	setRehearsalSettleWaitForTests(100);
	setRunLeaseTestHooksForTests({
		onBeforeAtomicRename: ({ file }) => {
			if (file.endsWith("run.json"))
				throw Object.assign(new Error(`I/O error writing ${file}`), {
					code: "EIO",
				});
		},
	});
	let error;
	try {
		await rehearseWorkflow(cwd, { workflow: path });
	} catch (caught) {
		error = caught;
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		setRehearsalPsForTests(undefined);
		setRehearsalSettleWaitForTests(undefined);
	}
	try {
		assert.ok(error instanceof Error);
		assert.equal(error.code, "EIO");
		assert.ok(existsSync(error.retainedRoot));
		assert.match(error.cause.message, /^I\/O error writing /u);
		assert.ok(
			error.cause.message.includes(error.retainedRoot),
			"the original message names a file under the root",
		);
		assert.match(error.message, /Temporary state kept at /u);
		assert.match(error.message, /wait for workers to exit before removing it/u);
		assert.doesNotMatch(error.message, /safe to delete by hand/u);
	} finally {
		await removeKeptRoot(error?.retainedRoot);
	}
});

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
