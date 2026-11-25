// test-tier: integration

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { generatePatternFiles } from "../../dist/core/authoring-patterns.js";
import { loadWorkflowSpec, parseWorkflow } from "../../dist/core/schema.js";
import { readArtifactGraphControl } from "../../dist/core/artifact-graph-runtime.js";
import {
	captureWorkerPrompts,
	completeTask,
	compileWorkflow,
	createWorkflowRunRecord,
	readRunRecord,
	resumeRun,
	scheduleRun,
	setTaskRuntimeApiForTests,
	taskBySpec,
	writeAgent,
	writeRunRecord,
	writeStaticRunArtifacts,
	loopWorkflowSpec,
	makeProject,
} from "../helpers/unit-test-support.mjs";

const check = {
	id: "check",
	support: { uses: "./check.mjs" },
	output: { controlSchema: "./check.json" },
};
const specWith = (child = check) =>
	loopWorkflowSpec({
		until: { stage: "check", path: "$.exitCode", equals: 0 },
		stages: [{ id: "write", type: "single", prompt: "Write." }, child],
	});

test("loop accepts a support child, but still rejects containers, foreach and dynamic", () => {
	assert.deepEqual(
		parseWorkflow(specWith()).artifactGraph.stages[0].stages[1],
		check,
	);
	for (const type of ["loop", "dag", "foreach", "dynamic"]) {
		assert.throws(
			() => parseWorkflow(specWith({ id: "check", type })),
			/loop child stages must/,
		);
	}
	assert.throws(
		() => parseWorkflow(specWith({ ...check, from: ["write"] })),
		/must not declare from\/after/,
	);
	assert.throws(
		() => parseWorkflow(specWith({ ...check, output: undefined })),
		/controlSchema/,
	);
});

test("a support child uses the same closed-schema until checks", async () => {
	const cwd = makeProject();
	try {
		const dir = join(cwd, "workflows", "support-loop");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "spec.json");
		writeFileSync(path, JSON.stringify(specWith()));
		writeFileSync(join(dir, "check.mjs"), "export default () => ({});");
		const schema = {
			type: "object",
			additionalProperties: false,
			properties: { schema: { type: "string" }, digest: { type: "string" } },
		};
		writeFileSync(join(dir, "check.json"), JSON.stringify(schema));
		await assert.rejects(
			loadWorkflowSpec(path, cwd),
			/until path.*exitCode.*only end exhausted/,
		);
		schema.properties.exitCode = { type: "integer" };
		writeFileSync(join(dir, "check.json"), JSON.stringify(schema));
		assert.ok(await loadWorkflowSpec(path, cwd));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

async function start(
	cwd,
	{
		helper,
		maxRounds = 3,
		until,
		first = false,
		onExhausted,
		progressPath,
		generatedReport = false,
		entry,
	} = {},
) {
	writeAgent(cwd, "unit-scout", "read");
	const spec = specWith();
	const loop = spec.artifactGraph.stages[0];
	Object.assign(loop, { maxRounds, onExhausted, progressPath });
	if (until) loop.until = until;
	if (first)
		loop.stages.unshift({ id: "prepare", support: { uses: "./prepare.mjs" } });
	spec.artifactGraph.stages.push({
		id: "report",
		from: ["fix-loop"],
		support: { uses: "./report.mjs" },
	});
	if (entry) {
		Object.assign(loop, entry);
		spec.artifactGraph.stages.unshift(
			{ id: "data", support: { uses: "./seed.mjs" } },
			{ id: "order", type: "single", after: [], prompt: "Order only." },
			{ id: "direct", after: ["order"], support: { uses: "./prepare.mjs" } },
		);
	}
	if (generatedReport)
		spec.artifactGraph.stages.push({
			id: "strict",
			from: ["fix-loop"],
			sourcePolicy: "require-success",
			support: { uses: "./never.mjs" },
		});
	const dir = join(cwd, "workflows");
	mkdirSync(dir, { recursive: true });
	const specPath = join(dir, "loop.json");
	writeFileSync(specPath, JSON.stringify(spec));
	writeFileSync(
		join(dir, "check.json"),
		JSON.stringify({
			type: "object",
			properties: { exitCode: { type: "integer" } },
		}),
	);
	writeFileSync(join(dir, "check.mjs"), helper);
	if (entry)
		writeFileSync(
			join(dir, "seed.mjs"),
			`export default () => ({ seed: true });`,
		);
	writeFileSync(
		join(dir, "prepare.mjs"),
		`export default ({ sources, context }) => ({ keys: Object.keys(sources), rows: context.sourceStatuses });`,
	);
	writeFileSync(
		join(dir, "report.mjs"),
		`export default async ({ sources, context }) => ({ sources, rows: context.sourceStatuses, history: await context.readLoopHistory("fix-loop", "check") });`,
	);
	if (generatedReport) {
		const stage = spec.artifactGraph.stages.find((row) => row.id === "report");
		stage.sourcePolicy = "partial";
		stage.support.options = { tester: "check" };
		writeFileSync(
			join(dir, "never.mjs"),
			'export default () => { throw Error("unexpected dispatch") };',
		);
		const render = generatePatternFiles("fix-loop", "evidence").find(
			(file) => file.path === "helpers/report-fix.mjs",
		);
		writeFileSync(join(dir, "render.mjs"), render.content);
		writeFileSync(
			join(dir, "report.mjs"),
			`import render from "./render.mjs";
			export default async (input) => ({ ...await render(input), keys: Object.keys(input.sources), history: await input.context.readLoopHistory("fix-loop", "check"), foreign: await input.context.readLoopHistory("other", "check") });`,
		);
	}
	const compiled = await compileWorkflow(parseWorkflow(spec), {
		cwd,
		specPath,
	});
	const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await writeRunRecord(cwd, run);
	await scheduleRun(cwd, run.runId);
	return run.runId;
}

async function finishWrite(cwd, runId, round) {
	const run = await readRunRecord(cwd, runId);
	const tag = String(round).padStart(2, "0");
	await completeTask(cwd, taskBySpec(run, `fix-loop.r${tag}.write`), {
		changed: true,
	});
	await writeRunRecord(cwd, run);
	return scheduleRun(cwd, runId);
}

const roundCheck = `export default ({ sources, context }) => ({ exitCode: context.loop.round === 2 ? 0 : 1, keys: Object.keys(sources), rows: context.sourceStatuses });`;

for (const from of [undefined, ["data"]]) {
	test(`first loop child waits for after but reads ${from ? "only from" : "no data"}`, async () => {
		const cwd = makeProject();
		captureWorkerPrompts();
		try {
			const runId = await start(cwd, {
				helper: roundCheck,
				first: true,
				entry: { after: ["order"], from },
			});
			const before = await readRunRecord(cwd, runId);
			assert.equal(taskBySpec(before, "order.main").status, "running");
			assert.ok(!before.tasks.some((task) => task.loopChild));
			await completeTask(cwd, taskBySpec(before, "order.main"));
			await writeRunRecord(cwd, before);
			const run = await scheduleRun(cwd, runId);
			const read = (id) => readArtifactGraphControl(cwd, taskBySpec(run, id));
			const prepare = await read("fix-loop.r01.prepare");
			assert.deepEqual(prepare.keys, from ?? []);
			assert.deepEqual(
				prepare.rows.map((row) => row.source),
				from ?? [],
			);
			const direct = await read("direct.main");
			assert.deepEqual(direct.keys, ["order"]);
			assert.deepEqual(
				direct.rows.map((row) => row.source),
				["order"],
			);
		} finally {
			setTaskRuntimeApiForTests(undefined);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

test("support runs in each round and a downstream helper sees final aliases and earlier history after scheduler reload", async () => {
	const cwd = makeProject();
	let prompts = captureWorkerPrompts();
	try {
		const runId = await start(cwd, { helper: roundCheck, first: true });
		await finishWrite(cwd, runId, 1);

		// A fresh scheduler invocation reads the materialized round from disk.
		prompts = captureWorkerPrompts();
		const run = await finishWrite(cwd, runId, 2);
		assert.equal(prompts.length, 0);
		assert.equal(run.status, "completed");
		assert.equal(run.loopResults[0].roundsUsed, 2);
		assert.equal(run.loopResults[0].finalCheck.exitCode, 0);
		const read = (id) => readArtifactGraphControl(cwd, taskBySpec(run, id));
		const first = await read("fix-loop.r01.check");
		assert.equal(first.exitCode, 1);
		assert.deepEqual(first.keys, [
			"fix-loop.r01.prepare",
			"fix-loop.r01.write",
		]);
		assert.deepEqual(first.rows[0].loop, {
			loopId: "fix-loop",
			status: "running",
			roundsUsed: 1,
			round: 1,
		});
		const prepare = await read("fix-loop.r02.prepare");
		assert.deepEqual(prepare.keys, [
			"fix-loop.r01.prepare",
			"fix-loop.r01.write",
			"fix-loop.r01.check",
		]);
		assert.deepEqual(prepare.rows[2].loop, {
			loopId: "fix-loop",
			status: "running",
			roundsUsed: 2,
			round: 1,
		});
		const report = await read("report.main");
		assert.equal(report.sources["fix-loop.check"].exitCode, 0);
		assert.deepEqual(report.rows.at(-1).loop, {
			loopId: "fix-loop",
			status: "completed",
			roundsUsed: 2,
		});
		assert.equal(report.history[0].control.exitCode, 1);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed fix-loop partial report keeps real round evidence without publishing controls", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		const runId = await start(cwd, {
			maxRounds: 2,
			generatedReport: true,
			helper: `export default ({ context }) => context.loop.round === 1
				? { exitCode: 1, outcome: "red", failed: 1, roundFiles: ["src/a.js"] }
				: { exitCode: 5, status: "blocked" };`,
		});
		await finishWrite(cwd, runId, 1);
		const run = await finishWrite(cwd, runId, 2);
		assert.equal(run.status, "failed");
		assert.equal(taskBySpec(run, "strict.main").status, "skipped");
		const result = await readArtifactGraphControl(
			cwd,
			taskBySpec(run, "report.main"),
		);
		assert.equal(result.loopStatus, "failed");
		assert.equal(result.rounds, 2);
		assert.equal(result.status, "unverified");
		assert.deepEqual(
			result.rows.map(({ files, tests }) => [files, tests]),
			[
				[["src/a.js"], "red, exit 1, 1 failing"],
				[[], "not verified"],
			],
		);
		assert.deepEqual(result.keys, []);
		assert.deepEqual(result.foreign, []);
		assert.deepEqual(result.history[1], { round: 2, status: "blocked" });
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

for (const status of ["failed", "blocked"]) {
	test(`a declared-${status} support result retries, and fails the loop if last`, async () => {
		for (const retry of [true, false]) {
			const cwd = makeProject();
			captureWorkerPrompts();
			try {
				const helper = `export default ({ context }) => context.loop.round === 1 ? { exitCode: 1, status: "${status}" } : { exitCode: 0 };`;
				const runId = await start(cwd, { helper, maxRounds: retry ? 2 : 1 });
				let run = await finishWrite(cwd, runId, 1);
				const task = taskBySpec(run, "fix-loop.r01.check");
				assert.equal(task.statusDetail, `support_declared_${status}`);
				assert.equal(
					(await readArtifactGraphControl(cwd, task)).status,
					status,
				);
				if (retry) run = await finishWrite(cwd, runId, 2);
				assert.equal(run.status, retry ? "completed" : "failed");
				assert.equal(run.loopResults[0].status, retry ? "completed" : "failed");
				if (retry && status === "blocked") {
					assert.equal(run.taskSummary.blocked, 1);
					assert.match(
						run.degradation?.summary ?? "",
						/1 recovered loop block/,
					);
				}
			} finally {
				setTaskRuntimeApiForTests(undefined);
				rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
}

test("nonzero support controls exhaust, invoking onExhausted with the real check output", async () => {
	const cwd = makeProject();
	const prompts = captureWorkerPrompts();
	try {
		const runId = await start(cwd, {
			helper: `export default () => ({ exitCode: 2 });`,
			maxRounds: 2,
			onExhausted: { id: "summary", type: "reduce", prompt: "Summarize." },
		});
		await finishWrite(cwd, runId, 1);
		assert.match(
			prompts.at(-1),
			/Latest check structured output:\n.*"exitCode":2/,
		);
		const run = await finishWrite(cwd, runId, 2);
		assert.match(prompts.at(-1), /Loop Exhaustion Context[\s\S]*"exitCode":2/);
		await completeTask(
			cwd,
			taskBySpec(run, "fix-loop.onExhausted.summary"),
			{},
		);
		await writeRunRecord(cwd, run);
		const final = await scheduleRun(cwd, runId);
		assert.equal(final.loopResults[0].status, "exhausted");
		assert.equal(final.status, "completed");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("support output can stop a loop for no progress", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		const runId = await start(cwd, {
			helper: `export default () => ({ exitCode: 2 });`,
			progressPath: "$.exitCode",
		});
		await finishWrite(cwd, runId, 1);
		const run = await finishWrite(cwd, runId, 2);
		assert.equal(run.loopResults[0].status, "stopped_no_progress");
		assert.equal(run.loopResults[0].roundsUsed, 2);
		assert.equal(run.status, "completed");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an absent-path until does not turn a failed support child into success; public resume still rejects loop ownership", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		const runId = await start(cwd, {
			helper: `export default () => ({ exitCode: 2, status: "failed" });`,
			until: { stage: "check", path: "$.exitCode", exists: false },
			maxRounds: 1,
		});
		const run = await finishWrite(cwd, runId, 1);
		assert.equal(run.loopResults[0].status, "failed");
		await assert.rejects(
			resumeRun(cwd, runId),
			/resume does not support loop workflows/,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
