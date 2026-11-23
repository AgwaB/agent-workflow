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
