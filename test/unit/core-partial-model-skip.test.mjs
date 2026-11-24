// test-tier: integration
// agent-workflow 2026-11-23 (owner decision "모델 단계만 건너뛰기"): a `sourcePolicy: "partial"` MODEL stage whose every
// source is terminal and none completed is skipped instead of launching a worker on nothing (measured: a foreach-reduce
// report reduce ran on "no items available" after the inventory failed). A source that completed — even with an empty
// list — still lets it run, and a support (code) stage keeps running so bundled finals still write their report.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const format = await import("../../dist/core/engine-format.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-partial-skip-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const FAIL = [{ class: "permanent", message: "the model refused" }];
const stageOf = (run, stage) =>
	run.tasks.filter((task) => task.stageId === stage);
const one = (run, stage) => {
	const found = stageOf(run, stage);
	assert.equal(found.length, 1, `one task of stage ${stage}`);
	return found[0];
};
const states = (run) =>
	JSON.stringify(
		run.tasks.map((task) => [task.specId, task.status, task.statusDetail]),
	);

async function scenario(name, stages, config = {}, helpers = {}) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou report.\n",
	);
	for (const [file, body] of Object.entries(helpers))
		await writeFile(join(cwd, "helpers", file), body);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: name,
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: { stages },
		}),
	);
	const effectLog = join(root, `${name}-effects.jsonl`);
	const id = `wf-partial-skip-${name}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog, ...config }),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	const run = await engine.waitForRun(cwd, started.runId, 90_000);
	return { cwd, run, effectLog };
}

const submits = (effectLog) =>
	readFixtureLog(effectLog).filter((entry) => entry.type === "submit").length;

const foreachReduce = (reduceExtra = {}) => [
	{ id: "plan", type: "single", prompt: "Plan the items." },
	{
		id: "work",
		type: "foreach",
		from: { source: "plan", path: "$.items" },
		each: { prompt: "Work ${item}." },
	},
	{
		id: "report",
		type: "reduce",
		from: ["plan", "work"],
		sourcePolicy: "partial",
		prompt: "Report.",
		...reduceExtra,
	},
];

test("foreach-reduce: the inventory fails, the foreach is skipped and the partial model reduce is skipped without a launch", async () => {
	const { cwd, run, effectLog } = await scenario("shape", foreachReduce(), {
		failures: { "*": FAIL },
	});
	assert.equal(one(run, "plan").status, "failed", states(run));
	assert.equal(stageOf(run, "work")[0].status, "skipped", states(run));
	const report = one(run, "report");
	assert.equal(report.status, "skipped", states(run));
	assert.equal(report.statusDetail, "skipped_every_input_failed");
	assert.equal(
		report.lastMessage,
		"skipped: every input failed (plan failed, work skipped)",
	);
	assert.equal(submits(effectLog) >= 1, true);
	assert.equal(
		readFixtureLog(effectLog).some((entry) =>
			JSON.stringify(entry).includes("report.main"),
		),
		false,
		"the report reduce never reached the executor",
	);
	assert.equal(run.status, "failed");

	// status / show / raw print the plain reason.
	const status = await engine.formatRunStatus(cwd, run.runId);
	const details = await engine.formatRunDetails(cwd, run.runId);
	for (const text of [status, details]) {
		assert.match(
			text,
			/Skipped:\n {2}• work\.item — its input plan\.main failed\n {2}• report\.main — every input failed \(plan failed, work skipped\)/u,
		);
	}
	assert.match(
		format.formatRun(run, "full"),
		/\[skipped\/skipped_every_input_failed\][\s\S]*?\n\s+last=skipped: every input failed \(plan failed, work skipped\)/u,
	);
});

test("a downstream stage of the skipped partial model stage behaves as for any skipped source", async () => {
	const { run } = await scenario(
		"downstream",
		[
			...foreachReduce(),
			{ id: "polish", type: "single", from: "report", prompt: "Polish." },
		],
		{ failures: { "*": FAIL } },
	);
	assert.equal(one(run, "report").status, "skipped", states(run));
	const polish = one(run, "polish");
	assert.equal(polish.status, "skipped", states(run));
	assert.equal(polish.statusDetail, "skipped_after_dependency_failure");
});

test("one source completed and one failed: the partial reduce still runs", async () => {
	// task ids are positional: task-1 = good, task-2 = bad, task-3 = report
	const { run } = await scenario(
		"one-completed",
		[
			{ id: "good", type: "single", after: [], prompt: "Good." },
			{ id: "bad", type: "single", after: [], prompt: "Bad." },
			{
				id: "report",
				type: "reduce",
				from: ["good", "bad"],
				sourcePolicy: "partial",
				prompt: "Report.",
			},
		],
		{ failures: { "task-2": FAIL } },
	);
	assert.equal(one(run, "good").status, "completed", states(run));
	assert.equal(one(run, "bad").status, "failed", states(run));
	assert.equal(one(run, "report").status, "completed", states(run));
});

test("a completed source with an empty list still lets the partial reduce run", async () => {
	const { run, effectLog } = await scenario("empty-list", foreachReduce(), {
		controlSequence: {
			"task-1": [{ schema: "plan-v1", digest: "none", items: [] }],
		},
	});
	assert.equal(one(run, "plan").status, "completed", states(run));
	assert.equal(
		stageOf(run, "work")[0].statusDetail,
		"foreach_empty",
		states(run),
	);
	assert.equal(one(run, "report").status, "completed", states(run));
	assert.equal(submits(effectLog), 2);
});

test("a partial SUPPORT stage after all-failed sources still runs", async () => {
	const { run } = await scenario(
		"support",
		[
			...foreachReduce(),
			{
				id: "final",
				from: ["plan", "work", "report"],
				sourcePolicy: "partial",
				support: { uses: "./helpers/render.mjs" },
			},
		],
		{ failures: { "*": FAIL } },
		{
			"render.mjs": `export default async function render({ context }) {
	return { schema: "render-v1", digest: "could not finish", statuses: context.sourceStatuses.map((s) => [s.stageId, s.status]) };
}
`,
		},
	);
	assert.equal(one(run, "report").status, "skipped", states(run));
	assert.equal(one(run, "final").status, "completed", states(run));
});

test("a partial model stage behind a terminal barrier is skipped once every source is terminal", async () => {
	const { run } = await scenario(
		"barrier",
		foreachReduce({ inputPolicy: { terminalBarrier: "all-sources" } }),
		{ failures: { "*": FAIL } },
	);
	assert.equal(one(run, "report").status, "skipped", states(run));
	assert.equal(
		one(run, "report").lastMessage,
		"skipped: every input failed (plan failed, work skipped)",
	);
});

// ---- what counts as a source (review findings M1-M3 on 5e51343) ----

const taskIdsSubmitted = (effectLog) =>
	readFixtureLog(effectLog)
		.filter((entry) => entry.type === "submit")
		.map((entry) => entry.attemptKey.split(":")[2]);

test("M1a: `after` is ordering only, so a partial reduce whose only `from` source failed is skipped", async () => {
	// task ids are positional: task-1 = good, task-2 = bad, task-3 = report
	const { run, effectLog } = await scenario(
		"after-is-order",
		[
			{ id: "good", type: "single", after: [], prompt: "Good." },
			{ id: "bad", type: "single", after: [], prompt: "Bad." },
			{
				id: "report",
				type: "reduce",
				from: "bad",
				after: "good",
				sourcePolicy: "partial",
				prompt: "Report.",
			},
		],
		{ failures: { "task-2": FAIL } },
	);
	assert.equal(one(run, "good").status, "completed", states(run));
	assert.equal(one(run, "bad").status, "failed", states(run));
	const report = one(run, "report");
	assert.equal(report.status, "skipped", states(run));
	assert.equal(report.statusDetail, "skipped_every_input_failed");
	assert.equal(report.lastMessage, "skipped: every input failed (bad failed)");
	assert.deepEqual(taskIdsSubmitted(effectLog).sort(), ["task-1", "task-2"]);
});

test("M1b: a partial stage with no `from` and only a failed `after` has no data source and runs", async () => {
	const { run, effectLog } = await scenario(
		"after-only",
		[
			{ id: "bad", type: "single", after: [], prompt: "Bad." },
			{
				id: "solo",
				type: "single",
				after: "bad",
				sourcePolicy: "partial",
				prompt: "Solo.",
			},
		],
		{ failures: { "task-1": FAIL } },
	);
	assert.equal(one(run, "bad").status, "failed", states(run));
	assert.equal(one(run, "solo").status, "completed", states(run));
	assert.deepEqual(taskIdsSubmitted(effectLog).sort(), ["task-1", "task-2"]);
});

test("M1a/M1b: a completed `from` source still lets the stage run whatever `after` did", async () => {
	const { run } = await scenario(
		"from-good-after-bad",
		[
			{ id: "good", type: "single", after: [], prompt: "Good." },
			{ id: "bad", type: "single", after: [], prompt: "Bad." },
			{
				id: "report",
				type: "reduce",
				from: "good",
				after: "bad",
				sourcePolicy: "partial",
				prompt: "Report.",
			},
		],
		{ failures: { "task-2": FAIL } },
	);
	assert.equal(one(run, "report").status, "completed", states(run));
});

test("M1d: the implicitly chained previous stage is a data source, so a partial model stage with no from/after is skipped when it failed", async () => {
	const { run, effectLog } = await scenario(
		"implicit-chain",
		[
			{ id: "bad", type: "single", prompt: "Bad." },
			{ id: "solo", type: "single", sourcePolicy: "partial", prompt: "Solo." },
			{ id: "last", type: "single", sourcePolicy: "partial", prompt: "Last." },
		],
		{ failures: { "task-1": FAIL } },
	);
	assert.equal(one(run, "bad").status, "failed", states(run));
	const solo = one(run, "solo");
	assert.equal(solo.status, "skipped", states(run));
	assert.equal(solo.statusDetail, "skipped_every_input_failed");
	assert.equal(solo.lastMessage, "skipped: every input failed (bad failed)");
	// The skipped stage is itself the next stage's implicit source: terminal, none completed.
	assert.equal(one(run, "last").status, "skipped", states(run));
	assert.deepEqual(taskIdsSubmitted(effectLog), ["task-1"]);
});

test("M1d: an implicit previous source that completed lets the partial stage run", async () => {
	const { run } = await scenario(
		"implicit-chain-ok",
		[
			{ id: "good", type: "single", prompt: "Good." },
			{ id: "solo", type: "single", sourcePolicy: "partial", prompt: "Solo." },
		],
		{},
	);
	assert.equal(one(run, "solo").status, "completed", states(run));
});

test("M1c: a streaming foreach whose generated items all failed leaves the partial reducer skipped", async () => {
	const stages = [
		{
			id: "plan",
			type: "single",
			prompt: "Plan the items.",
			output: { partial: { paths: ["$.items"] } },
		},
		{
			id: "work",
			type: "foreach",
			from: {
				source: "plan",
				path: "$.items",
				streaming: { enabled: true, minChunk: 1 },
			},
			each: { prompt: "Work ${item}." },
		},
		{
			id: "report",
			type: "reduce",
			from: "work",
			sourcePolicy: "partial",
			prompt: "Report.",
		},
	];
	const { run, effectLog } = await scenario("streaming", stages, {
		controlSequence: {
			"task-1": [
				{
					schema: "plan-v1",
					digest: "two",
					items: [
						{ id: "a", text: "A" },
						{ id: "b", text: "B" },
					],
				},
			],
		},
		failures: { "*": FAIL, "task-1": [] },
	});
	assert.equal(one(run, "plan").status, "completed", states(run));
	const items = run.tasks.filter(
		(task) => task.stageId === "work" && task.foreachGenerated,
	);
	assert.equal(items.length, 2, states(run));
	for (const item of items) assert.equal(item.status, "failed", states(run));
	const report = one(run, "report");
	assert.equal(report.status, "skipped", states(run));
	assert.equal(report.statusDetail, "skipped_every_input_failed");
	assert.equal(submits(effectLog), 3, "plan and the two items; no reducer");
});

test("N1: an OPEN streaming foreach keeps the partial reducer waiting after its first item failed", async () => {
	const { markDagDependentsSkipped } = await import(
		"../../dist/core/engine-run-graph.js"
	);
	const streaming = { enabled: true, minChunk: 1 };
	const flow = {
		tasks: [
			{ id: "p1.main", stageId: "p1" },
			{ id: "p2.main", stageId: "p2" },
			{
				id: "work.item",
				stageId: "work",
				kind: "foreach",
				dependsOn: ["p1.main", "p2.main"],
				foreach: { from: { stage: "p1", streaming } },
			},
			{
				id: "work.item-001",
				stageId: "work",
				dependsOn: ["work.item"],
				foreachGenerated: { placeholderSpecId: "work.item" },
			},
			{
				id: "report.main",
				stageId: "report",
				dependsOn: ["work.item", "work.item-001"],
			},
		],
		stages: [{ id: "report", sourcePolicy: "partial" }],
	};
	const build = (placeholder, second) => ({
		tasks: [
			{ taskId: "t1", specId: "p1.main", status: "completed" },
			{ taskId: "t2", specId: "p2.main", status: "running" },
			{
				taskId: "t3",
				specId: "work.item",
				kind: "foreach",
				status: placeholder,
			},
			{
				taskId: "t4",
				specId: "work.item-001",
				status: "failed",
				foreachGenerated: { placeholderSpecId: "work.item" },
			},
			...(second
				? [
						{
							taskId: "t5",
							specId: "work.item-002",
							status: second,
							foreachGenerated: { placeholderSpecId: "work.item" },
						},
					]
				: []),
			{ taskId: "t9", specId: "report.main", status: "pending" },
		],
	});

	// Still open: producer 2 is running, the placeholder is pending. Nothing is decided yet.
	const open = build("pending");
	assert.equal(markDagDependentsSkipped(open, flow), false);
	assert.equal(open.tasks.at(-1).status, "pending");

	// Membership final (placeholder completed) and every generated item failed: skipped.
	const closed = build("completed");
	assert.equal(markDagDependentsSkipped(closed, flow), true);
	assert.equal(closed.tasks.at(-1).status, "skipped");
	assert.equal(closed.tasks.at(-1).statusDetail, "skipped_every_input_failed");

	// Membership final and a later item completed: the reducer runs.
	const later = build("completed", "completed");
	assert.equal(markDagDependentsSkipped(later, flow), false);
	assert.equal(later.tasks.at(-1).status, "pending");
});

test("N5: the decision checks cheap conditions first and builds the whole-graph index only for a streaming placeholder", async () => {
	const { partialModelStageNoInputReason } = await import(
		"../../dist/core/engine-run-graph.js"
	);
	let builds = 0;
	const index = () => {
		builds += 1;
		return new Map();
	};
	const flow = { tasks: [], stages: [] };
	const run = (specId, status, kind = "single") => ({
		specId,
		status,
		kind,
		stageId: specId,
	});
	const by = (...records) => new Map(records.map((r) => [r.specId, r]));
	// No data source, a source that is not terminal, and a completed plain source: no index.
	assert.equal(
		partialModelStageNoInputReason(
			{ id: "r", dependsOn: [] },
			by(),
			flow,
			index,
		),
		undefined,
	);
	assert.equal(
		partialModelStageNoInputReason(
			{ id: "r", dependsOn: ["a"] },
			by(run("a", "running")),
			flow,
			index,
		),
		undefined,
	);
	assert.equal(
		partialModelStageNoInputReason(
			{ id: "r", dependsOn: ["a"] },
			by(run("a", "completed")),
			flow,
			index,
		),
		undefined,
	);
	// Every source failed and none is a foreach placeholder: decided without the index.
	assert.match(
		partialModelStageNoInputReason(
			{ id: "r", dependsOn: ["a"] },
			by(run("a", "failed")),
			flow,
			index,
		),
		/every input failed/u,
	);
	assert.equal(builds, 0, "no whole-graph index was built");
	// A foreach placeholder source does need it.
	partialModelStageNoInputReason(
		{ id: "r", dependsOn: ["w"] },
		by(run("w", "failed", "foreach")),
		flow,
		index,
	);
	assert.equal(builds, 1);
});

test("N5b: pass-start propagation and policy lookups stay linear in the number of dependents", async () => {
	const { markDagDependentsSkipped } = await import(
		"../../dist/core/engine-run-graph.js"
	);
	const streaming = { enabled: true, minChunk: 1 };
	const measure = (count) => {
		let idReads = 0;
		const counted = (task) =>
			Object.defineProperty({ ...task }, "id", {
				get() {
					idReads += 1;
					return task.id;
				},
				enumerable: true,
			});
		const tasks = [
			counted({
				id: "p.main",
				stageId: "p",
			}),
			counted({
				id: "work.item",
				stageId: "work",
				kind: "foreach",
				dependsOn: ["p.main"],
				foreach: { from: { stage: "p", streaming } },
			}),
			counted({
				id: "work.item-001",
				stageId: "work",
				dependsOn: ["work.item"],
				foreachGenerated: { placeholderSpecId: "work.item" },
			}),
		];
		const stages = [];
		const records = [
			{ taskId: "t1", specId: "p.main", status: "completed" },
			{
				taskId: "t2",
				specId: "work.item",
				kind: "foreach",
				status: "completed",
			},
			{
				taskId: "t3",
				specId: "work.item-001",
				status: "failed",
				foreachGenerated: { placeholderSpecId: "work.item" },
			},
		];
		for (let index = 0; index < count; index += 1) {
			tasks.push(
				counted({
					id: `d${index}.main`,
					stageId: `d${index}`,
					dependsOn: ["work.item", "work.item-001"],
				}),
			);
			stages.push(
				Object.defineProperty({ sourcePolicy: "partial" }, "id", {
					get() {
						idReads += 1;
						return `d${index}`;
					},
					enumerable: true,
				}),
			);
			records.push({
				taskId: `t${index + 10}`,
				specId: `d${index}.main`,
				status: "pending",
			});
		}
		const run = { tasks: records };
		assert.equal(markDagDependentsSkipped(run, { tasks, stages }), true);
		assert.ok(
			records.slice(3).every((record) => record.status === "skipped"),
			"every partial dependent was skipped",
		);
		return idReads;
	};
	const small = measure(64);
	const large = measure(256);
	assert.ok(small <= 64 * 12, `64 dependents read ids ${small} times`);
	assert.ok(large <= 256 * 12, `256 dependents read ids ${large} times`);
});

for (const declared of ["failed", "blocked"]) {
	for (const barrier of [false, true]) {
		test(`M2: a support source that declares ${declared} inline leaves its partial model consumer skipped${barrier ? " (terminal barrier)" : ""}`, async () => {
			const { run, effectLog } = await scenario(
				`support-${declared}${barrier ? "-barrier" : ""}`,
				[
					{
						id: "gate",
						support: { uses: "./helpers/gate.mjs" },
					},
					{
						id: "use",
						type: "single",
						from: "gate",
						sourcePolicy: "partial",
						prompt: "Use the gate.",
						...(barrier
							? { inputPolicy: { terminalBarrier: "all-sources" } }
							: {}),
					},
				],
				{},
				{
					"gate.mjs": `export default async function gate() {
	return { schema: "gate-v1", digest: "declined", status: "${declared}" };
}
`,
				},
			);
			assert.equal(one(run, "gate").status, declared, states(run));
			const use = one(run, "use");
			assert.equal(use.status, "skipped", states(run));
			assert.equal(use.statusDetail, "skipped_every_input_failed");
			assert.equal(submits(effectLog), 0, "no model task was submitted");
		});
	}
}

const dynamicStages = (dynamic) => [
	{ id: "plan", type: "single", prompt: "Plan." },
	{
		id: "adaptive",
		type: "dynamic",
		from: "plan",
		sourcePolicy: "partial",
		dynamic: { uses: "./helpers/controller.mjs", ...dynamic },
	},
];
const stoppingController = {
	"controller.mjs": `export default async function controller(ctx) {
	const failed = Object.keys(ctx.sources).length === 0;
	return {
		control: {
			schema: "dynamic-controller-result-v1",
			digest: "handled",
			status: "stopped",
			decisions: [{ round: 0, decisionId: "decide-r0", status: "stop" }],
			generatedTasks: [],
			stateIndexes: [],
			blockers: [failed ? "input failed; generated no work" : "input present"],
			omissions: [],
			caveats: [],
		},
		analysis: "stopped",
		refs: [],
	};
}
`,
};

test("M3: a helper-driven dynamic controller (no model) runs on a failed source and decides itself", async () => {
	const { run, effectLog } = await scenario(
		"dynamic-helper",
		dynamicStages({}),
		{ failures: { "task-1": FAIL } },
		stoppingController,
	);
	assert.equal(one(run, "plan").status, "failed", states(run));
	const controller = one(run, "adaptive");
	assert.equal(controller.status, "completed", states(run));
	assert.equal(controller.statusDetail, "dynamic_stopped");
	assert.equal(submits(effectLog), 1, "only the plan was submitted");
});

test("M3: a model-driven dynamic controller (decision loop) keeps the every-input-failed skip", async () => {
	const { run } = await scenario(
		"dynamic-model",
		dynamicStages({
			decisionLoop: {
				planner: { agent: "reader", tools: ["read"] },
				workerDefaults: { agent: "reader", tools: ["read"] },
				allowedAgents: ["reader"],
				allowedTools: ["read"],
				maxDecisionRounds: 1,
				maxActionsPerRound: 1,
				repair: { maxAttempts: 1 },
				stopPolicy: { maxStalls: 1 },
			},
		}),
		{ failures: { "task-1": FAIL } },
		stoppingController,
	);
	const controller = one(run, "adaptive");
	assert.equal(controller.status, "skipped", states(run));
	assert.equal(controller.statusDetail, "skipped_every_input_failed");
});
