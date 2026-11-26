import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generatePatternFiles } from "../../dist/core/authoring-patterns.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	applyDependencyResumeInvalidationForTests,
	dependencyResumableBlocksForTests,
	dependencyResumeInvalidationPlanForTests,
} from "../../dist/core/engine.js";
import { parseWorkflow } from "../../dist/core/schema.js";
import { resetTaskForResume } from "../../dist/core/store.js";
import renderImpactReport from "../../workflows/impact-review/helpers/render-impact-report.mjs";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
const single = (id, extra = {}) => ({
	id,
	type: "single",
	profileRole: "synthesis",
	prompt: "Summarize.",
	after: [],
	...extra,
});
const compile = (stages) =>
	compileWorkflow(
		parseWorkflow({
			schemaVersion: 1,
			defaults: { agent: "scout" },
			artifactGraph: { stages },
		}),
		{ cwd },
	);
const warnings = (compiled) =>
	compiled.warnings.filter((w) => w.includes("invalidateOnDependencyResume"));
const flag = { inputPolicy: { invalidateOnDependencyResume: true } };

function runWithFailure(compiled, source) {
	return {
		runId: "test-resume",
		tasks: compiled.tasks.map((task) => ({
			taskId: task.id,
			specId: task.id,
			dependsOn: task.dependsOn,
			status: task.id === source ? "failed" : "completed",
			artifactGraph: task.artifactGraph,
		})),
	};
}

test("resume keeps a completed partial consumer's old output unless it opts in", async () => {
	const stages = [
		single("ok"),
		single("bad"),
		single("summary", { from: ["ok", "bad"], sourcePolicy: "partial" }),
	];
	const compiled = await compile(stages);
	const run = runWithFailure(compiled, "bad.main");
	assert.equal(
		dependencyResumeInvalidationPlanForTests(run, compiled),
		undefined,
	);
	assert.deepEqual(
		run.tasks
			.filter((task) => resetTaskForResume(task))
			.map((task) => task.specId),
		["bad.main"],
	);
	assert.equal(run.tasks.at(-1).status, "completed");
	const fixed = await compile([
		stages[0],
		stages[1],
		{ ...stages[2], ...flag },
	]);
	const fixedRun = runWithFailure(fixed, "bad.main");
	const plan = dependencyResumeInvalidationPlanForTests(fixedRun, fixed);
	assert.ok(plan);
	assert.deepEqual(plan.invalidatedTaskIds, ["summary.main"]);
	assert.deepEqual(
		applyDependencyResumeInvalidationForTests(fixedRun, fixed, plan),
		["bad.main", "summary.main"],
	);
	assert.match(warnings(compiled).join("\n"), /stage "summary".*stale/);
	assert.deepEqual(warnings(fixed), []);
});

test("impact-review final declares blocked with an incomplete dependency and resumes even without its flag", async () => {
	const specPath = fileURLToPath(
		new URL("../../workflows/impact-review/spec.json", import.meta.url),
	);
	const raw = JSON.parse(await readFile(specPath, "utf8"));
	const dag = raw.artifactGraph.stages.find((stage) => stage.type === "dag");
	const final = dag.stages.find((stage) => stage.id === "final");
	delete final.inputPolicy.invalidateOnDependencyResume;
	const compiled = await compileWorkflow(parseWorkflow(raw), { cwd, specPath });
	const failed = `${dag.id}.impact-synthesis.main`;
	const run = runWithFailure(compiled, failed);
	const result = await renderImpactReport({
		sources: {},
		context: {
			sourceStatuses: final.from.map((stageId) => ({
				source: stageId,
				stageId,
				specId: `${dag.id}.${stageId}.main`,
				taskId: stageId,
				status: stageId === "impact-synthesis" ? "failed" : "completed",
			})),
		},
	});
	assert.equal(result.status, "blocked");
	const row = run.tasks.find((task) => task.specId === `${dag.id}.final.main`);
	assert.ok(row);
	Object.assign(row, {
		status: "blocked",
		statusDetail: "support_declared_blocked",
	});
	assert.equal(
		dependencyResumeInvalidationPlanForTests(run, compiled),
		undefined,
	);
	const blocks = dependencyResumableBlocksForTests(run, compiled);
	assert.ok(blocks.has(row.taskId));
	assert.equal(resetTaskForResume(row, blocks), true);
});

test("nested DAG output feeding a stable-identity foreach warns; only real sources count", async () => {
	const stages = [
		single("ok"),
		single("bad"),
		{
			id: "container",
			type: "dag",
			after: [],
			sourcePolicy: "partial",
			outputFrom: "inner",
			stages: [
				single("a"),
				single("b"),
				single("inner", { from: ["a", "b"], ...flag }),
			],
		},
		{
			id: "fan",
			type: "foreach",
			profileRole: "research-execution",
			from: { source: "container", path: "$.items" },
			each: { itemIdentityPath: "$.id", prompt: "Read ${item}." },
		},
		single("order-only", { after: ["bad"], sourcePolicy: "partial" }),
		single("one-source", { from: "bad", sourcePolicy: "partial" }),
	];
	assert.deepEqual(
		warnings(await compile(stages)).map((warning) => warning.split(".")[0]),
		['foreach stage "fan" reads partial consumer "container'],
	);
	assert.deepEqual(
		warnings(
			await compile(
				stages.map((stage) =>
					stage.id === "fan" ? { ...stage, ...flag } : stage,
				),
			),
		),
		[],
	);
	const withLoop = [
		...stages.slice(0, 3).map((stage) =>
			stage.id === "container"
				? {
						...stage,
						stages: stage.stages.map(({ inputPolicy, ...child }) => child),
					}
				: stage,
		),
		{
			id: "iterate",
			type: "loop",
			after: [],
			maxRounds: 1,
			until: { stage: "check", path: "$.approved", equals: true },
			stages: [
				{ id: "first", type: "single", prompt: "Draft." },
				{ id: "check", type: "single", prompt: "Set approved." },
			],
		},
	];
	assert.deepEqual(warnings(await compile(withLoop)), []);
});

// Keep these opt-ins next to the generated partial consumers; `new` must produce specs
// that can be resumed, not merely suppress the advisory at validation time.
test("inventory and adaptive-depth patterns opt in to partial resume invalidation", () => {
	for (const [pattern, required] of [
		["inventory-foreach", ["report"]],
		["adaptive-depth", ["challenge", "report"]],
	]) {
		const { artifactGraph } = JSON.parse(
			generatePatternFiles(pattern, "resume")[0].content,
		);
		for (const id of required) {
			const stage = artifactGraph.stages.find((stage) => stage.id === id);
			assert.equal(
				stage?.inputPolicy?.invalidateOnDependencyResume,
				true,
				`${pattern}: ${id}`,
			);
		}
	}
});
