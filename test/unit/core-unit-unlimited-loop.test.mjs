import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWorkflow } from "../../dist/core/schema.js";
import { setTaskTerminal, writeJsonAtomic } from "../../dist/core/store.js";
import {
	loopChildSourceIdentity,
	sourceNameForTask,
} from "../../dist/core/workflow-source-alias.js";
import {
	captureWorkerPrompts,
	completeTask,
	compileWorkflow,
	createLoopRun,
	createWorkflowRunRecord,
	loopWorkflowSpec,
	makeProject,
	readRunRecord,
	scheduleRun,
	setTaskRuntimeApiForTests,
	taskBySpec,
	writeAgent,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../helpers/unit-test-support.mjs";

test("loop requires an explicit positive count or null, preserving null through compilation", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		for (const value of [undefined, 0, -1, 1.5, "unlimited", false]) {
			assert.throws(
				() => parseWorkflow(loopWorkflowSpec({ maxRounds: value })),
				/maxRounds/,
			);
		}
		const spec = parseWorkflow(loopWorkflowSpec({ maxRounds: null }));
		const { compiled } = await createLoopRun(cwd, spec);
		assert.equal(
			compiled.stages.find((stage) => stage.id === "fix-loop").maxRounds,
			null,
		);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function finishRound(cwd, runId, round, done = false) {
	const current = await readRunRecord(cwd, runId);
	const tag = `r${String(round).padStart(2, "0")}`;
	await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.implement`), {
		changed: true,
	});
	await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.check`), {
		status: done ? "pass" : "fail",
		verdict: done ? "ACCEPT" : "REJECT",
		blockingFailures: ["same unfinished case"],
	});
	await writeRunRecord(cwd, current);
	await scheduleRun(cwd, runId);
	return readRunRecord(cwd, runId);
}

test("unlimited loop continues past finite defaults with unchanged progress and completes only on until", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(
			cwd,
			loopWorkflowSpec({ maxRounds: null }),
		);
		await scheduleRun(cwd, run.runId);
		for (let round = 1; round <= 6; round += 1) {
			const current = await finishRound(cwd, run.runId, round);
			assert.equal(current.loopResults?.length ?? 0, 0);
			assert.ok(
				taskBySpec(
					current,
					`fix-loop.r${String(round + 1).padStart(2, "0")}.implement`,
				),
			);
		}
		const current = await finishRound(cwd, run.runId, 7, true);
		assert.equal(current.loopResults[0].status, "completed");
		assert.equal(current.loopResults[0].roundsUsed, 7);
		assert.equal(
			current.tasks.some((task) => task.specId.includes(".r08.")),
			false,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("explicit progressPath still opts unlimited loops into no-progress stopping", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(
			cwd,
			loopWorkflowSpec({ maxRounds: null, progressPath: "$.blockingFailures" }),
		);
		await scheduleRun(cwd, run.runId);
		await finishRound(cwd, run.runId, 1);
		const current = await finishRound(cwd, run.runId, 2);
		assert.equal(current.loopResults[0].status, "stopped_no_progress");
		assert.equal(current.loopResults[0].roundsUsed, 2);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("unlimited loop materializes round 100 from structured round 99 state with unique identities", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(
			cwd,
			loopWorkflowSpec({ maxRounds: null }),
		);
		await scheduleRun(cwd, run.runId);
		const current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["same"],
		});
		// Seed a durable later-round state without performing 99 unrelated worker runs.
		const compiledPath = join(
			stateDir(cwd),
			".agent-workflow",
			"workflows",
			run.runId,
			"compiled.json",
		);
		const promote = (value) =>
			JSON.parse(JSON.stringify(value).replaceAll(".r01.", ".r99."));
		const compiled = promote(JSON.parse(readFileSync(compiledPath, "utf8")));
		for (const task of compiled.tasks)
			if (task.loopChild) {
				task.loopChild.round = 99;
				task.loopChild.roundTag = "r99";
			}
		const promotedRun = promote(current);
		for (const state of promotedRun.loopStates ?? []) state.round = 99;
		await writeJsonAtomic(compiledPath, compiled);
		await writeRunRecord(cwd, promotedRun);
		await scheduleRun(cwd, run.runId);
		const after = await readRunRecord(cwd, run.runId);
		assert.ok(taskBySpec(after, "fix-loop.r100.implement"));
		assert.ok(taskBySpec(after, "fix-loop.r100.check"));
		assert.equal(
			new Set(after.tasks.map((task) => task.taskId)).size,
			after.tasks.length,
		);
		const final = await finishRound(cwd, run.runId, 100, true);
		assert.equal(final.loopResults[0].roundsUsed, 100);
		assert.equal(final.loopResults[0].status, "completed");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("unlimited loop stops on execution failure and allows downstream partial cleanup", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "cleanup.mjs"),
			'export default () => ({schema:"cleanup-v1",digest:"cleaned",cleaned:true});',
		);
		const spec = loopWorkflowSpec({ maxRounds: null });
		spec.artifactGraph.stages.push({
			id: "cleanup",
			from: ["fix-loop"],
			sourcePolicy: "partial",
			support: { uses: "./cleanup.mjs" },
		});
		const specPath = join(cwd, "workflows", "loop.json");
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Fail worker and perform cleanup",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const current = await readRunRecord(cwd, run.runId);
		setTaskTerminal(
			taskBySpec(current, "fix-loop.r01.implement"),
			"failed",
			"simulated_backend_failure",
		);
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);
		const after = await scheduleRun(cwd, run.runId);
		assert.equal(after.loopResults[0].status, "failed");
		assert.equal(after.loopResults[0].roundsUsed, 1);
		assert.match(
			after.loopResults[0].summary,
			/child did not complete successfully/,
		);
		assert.doesNotMatch(after.loopResults[0].summary, /progress metric/);
		assert.equal(taskBySpec(after, "fix-loop.loop").status, "failed");
		assert.equal(
			after.tasks.some((task) => task.specId.includes(".r02.")),
			false,
		);
		assert.equal(
			after.tasks.find((task) => task.stageId === "cleanup").status,
			"completed",
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

function loopWithConsumerSpec(loop, consumer = {}) {
	const spec = loopWorkflowSpec(loop);
	spec.artifactGraph.stages.push({
		id: "publish",
		type: "single",
		from: ["fix-loop"],
		prompt: "Publish the final loop output.",
		inputPolicy: { requiredReads: ["fix-loop.implement.analysis"] },
		...consumer,
	});
	return spec;
}

async function startLoopWithConsumer(cwd, spec) {
	const specPath = join(cwd, "workflows", "loop.json");
	mkdirSync(join(cwd, "workflows"), { recursive: true });
	writeFileSync(specPath, JSON.stringify(spec));
	const compiled = await compileWorkflow(spec, {
		cwd,
		specPath,
		task: "Loop then publish",
	});
	const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await writeRunRecord(cwd, run);
	await scheduleRun(cwd, run.runId);
	return run.runId;
}

async function finishLoopRound(cwd, runId, round, check) {
	const current = await readRunRecord(cwd, runId);
	const tag = `r${String(round).padStart(2, "0")}`;
	await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.implement`), {
		changed: true,
	});
	await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.check`), check);
	await writeRunRecord(cwd, current);
	await scheduleRun(cwd, runId);
	return readRunRecord(cwd, runId);
}

const PASS = { status: "pass", verdict: "ACCEPT", blockingFailures: [] };
const FAIL = (...failures) => ({
	status: "fail",
	verdict: "REJECT",
	blockingFailures: failures,
});

async function failImplement(cwd, runId, round) {
	const current = await readRunRecord(cwd, runId);
	const tag = `r${String(round).padStart(2, "0")}`;
	setTaskTerminal(
		taskBySpec(current, `fix-loop.${tag}.implement`),
		"failed",
		"simulated_backend_failure",
	);
	await writeRunRecord(cwd, current);
	await scheduleRun(cwd, runId);
	return scheduleRun(cwd, runId);
}

const ON_EXHAUSTED = {
	id: "loop-summary",
	type: "reduce",
	prompt: "Summarize remaining failures.",
};

test("bounded loop retries after a failed round and completes when a later round meets until", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWorkflowSpec({ maxRounds: 3, onExhausted: ON_EXHAUSTED }),
		);
		let current = await failImplement(cwd, runId, 1);
		assert.equal(current.loopResults?.length ?? 0, 0);
		assert.ok(taskBySpec(current, "fix-loop.r02.implement"));
		current = await finishLoopRound(cwd, runId, 2, PASS);
		current = await scheduleRun(cwd, runId);
		assert.equal(current.loopResults[0].status, "completed");
		assert.equal(current.loopResults[0].roundsUsed, 2);
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
		assert.equal(
			current.tasks.some((task) => task.specId.includes("onExhausted")),
			false,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a run whose bounded loop recovered in a later round completes with degradation, not failed", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWithConsumerSpec({ maxRounds: 3 }),
		);
		let current = await failImplement(cwd, runId, 1);
		assert.equal(taskBySpec(current, "fix-loop.r01.check").status, "skipped");
		current = await finishLoopRound(cwd, runId, 2, PASS);
		current = await scheduleRun(cwd, runId);
		assert.equal(current.loopResults[0].status, "completed");
		await completeTask(cwd, taskBySpec(current, "publish.main"), {});
		await writeRunRecord(cwd, current);
		current = await scheduleRun(cwd, runId);
		assert.equal(taskBySpec(current, "publish.main").status, "completed");
		assert.equal(current.status, "completed");
		assert.equal(current.taskSummary.failed, 1);
		assert.equal(current.taskSummary.skipped, 1);
		assert.match(
			current.degradation.summary,
			/final rendered, 1\/\d+ tasks failed/,
		);
		// A completed run is not resumable (engine.ts resumeRun), so superseded tasks are never rerun.
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("bounded loop whose child fails in the last round ends failed and skips onExhausted", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWorkflowSpec({ maxRounds: 2, onExhausted: ON_EXHAUSTED }),
		);
		let current = await failImplement(cwd, runId, 1);
		assert.equal(current.loopResults?.length ?? 0, 0);
		current = await failImplement(cwd, runId, 2);
		assert.equal(current.loopResults[0].status, "failed");
		assert.equal(current.loopResults[0].roundsUsed, 2);
		assert.match(
			current.loopResults[0].summary,
			/child did not complete successfully/,
		);
		const loop = taskBySpec(current, "fix-loop.loop");
		assert.equal(loop.status, "failed");
		assert.equal(loop.statusDetail, "loop_failed");
		assert.equal(
			current.tasks.some((task) => task.specId.includes("onExhausted")),
			false,
		);
		assert.equal(
			current.tasks.some((task) => task.specId.includes(".r03.")),
			false,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a partial consumer of a bounded loop that failed in its last round gets the failed loop as an ordinary source", async () => {
	const cwd = makeProject();
	const prompts = captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWithConsumerSpec(
				{ maxRounds: 1 },
				{ sourcePolicy: "partial", inputPolicy: undefined },
			),
		);
		const current = await failImplement(cwd, runId, 1);
		assert.equal(current.loopResults[0].status, "failed");
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "failed");
		assert.deepEqual(taskBySpec(current, "publish.main").dependsOn, [
			"fix-loop.loop",
		]);
		assert.notEqual(taskBySpec(current, "publish.main").status, "skipped");
		const prompt = prompts.find((text) => text.includes("Publish the final"));
		assert.ok(prompt, "partial consumer ran");
		// A failed loop is not swapped for its last round, so no Loop Results block (as for unlimited loops).
		assert.doesNotMatch(prompt, /# Loop Results/);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("bounded loop with a failed child in the round that triggers no-progress ends failed", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = loopWorkflowSpec({ maxRounds: 5, onExhausted: ON_EXHAUSTED });
		// The check still runs after a failed implement, so both rounds expose a progress metric.
		spec.artifactGraph.stages[0].stages[1].sourcePolicy = "partial";
		const runId = await startLoopWithConsumer(cwd, spec);
		await finishLoopRound(cwd, runId, 1, FAIL("same"));
		let current = await readRunRecord(cwd, runId);
		setTaskTerminal(
			taskBySpec(current, "fix-loop.r02.implement"),
			"failed",
			"simulated_backend_failure",
		);
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, runId);
		current = await readRunRecord(cwd, runId);
		await completeTask(
			cwd,
			taskBySpec(current, "fix-loop.r02.check"),
			FAIL("same"),
		);
		await writeRunRecord(cwd, current);
		current = await scheduleRun(cwd, runId);
		assert.equal(current.loopResults[0].status, "failed");
		assert.equal(current.loopResults[0].roundsUsed, 2);
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "failed");
		assert.equal(
			current.tasks.some((task) => task.specId.includes("onExhausted")),
			false,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("bounded loop whose last round fully completed with until false is still exhausted and runs onExhausted", async () => {
	const cwd = makeProject();
	captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWorkflowSpec({
				maxRounds: 2,
				progressPath: undefined,
				onExhausted: ON_EXHAUSTED,
			}),
		);
		await finishLoopRound(cwd, runId, 1, FAIL("a", "b"));
		let current = await finishLoopRound(cwd, runId, 2, FAIL("a"));
		const summary = taskBySpec(current, "fix-loop.onExhausted.loop-summary");
		assert.ok(summary);
		await completeTask(cwd, summary, { summary: "follow-up needed" });
		await writeRunRecord(cwd, current);
		current = await scheduleRun(cwd, runId);
		assert.equal(current.loopResults[0].status, "exhausted");
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

function readConsumerManifest(cwd, run, specId) {
	const task = taskBySpec(run, specId);
	return JSON.parse(
		readFileSync(
			join(stateDir(cwd), dirname(task.files.result), "source-manifest.json"),
			"utf8",
		),
	);
}

test("consumer of a completed loop receives the final round outputs under round-independent names and the loop status", async () => {
	const cwd = makeProject();
	const prompts = captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWithConsumerSpec({ maxRounds: 5 }),
		);
		await finishLoopRound(cwd, runId, 1, {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a", "b"],
		});
		let current = await finishLoopRound(cwd, runId, 2, {
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: [],
		});
		current = await scheduleRun(cwd, runId);
		const loop = taskBySpec(current, "fix-loop.loop");
		assert.equal(loop.status, "completed");
		const publish = taskBySpec(current, "publish.main");
		assert.deepEqual(publish.dependsOn, [
			"fix-loop.r02.implement",
			"fix-loop.r02.check",
		]);
		assert.notEqual(publish.status, "pending");

		const manifest = readConsumerManifest(cwd, current, "publish.main");
		assert.deepEqual(
			manifest.sources.map((source) => [source.source, source.specId]),
			[
				["fix-loop.implement", "fix-loop.r02.implement"],
				["fix-loop.check", "fix-loop.r02.check"],
			],
		);
		const prompt = prompts.find((text) => text.includes("Publish the final"));
		assert.ok(prompt, "consumer prompt was launched");
		assert.match(prompt, /# Loop Results/);
		assert.match(prompt, /loop=fix-loop status=completed roundsUsed=2/);
		assert.match(prompt, /rubricMet=true/);
		assert.match(
			prompt,
			/Required reads before final output:\n- fix-loop\.implement\.analysis/,
		);
		assert.doesNotMatch(prompt, /fix-loop\.r01\./);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("consumer of an exhausted loop sees the last round and an exhausted status", async () => {
	const cwd = makeProject();
	const prompts = captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const runId = await startLoopWithConsumer(
			cwd,
			loopWithConsumerSpec({ maxRounds: 2, progressPath: undefined }),
		);
		const fail = (failures) => ({
			status: "fail",
			verdict: "REJECT",
			blockingFailures: failures,
		});
		await finishLoopRound(cwd, runId, 1, fail(["a", "b"]));
		await finishLoopRound(cwd, runId, 2, fail(["a"]));
		const current = await scheduleRun(cwd, runId);
		assert.equal(current.loopResults[0].status, "exhausted");
		const manifest = readConsumerManifest(cwd, current, "publish.main");
		assert.deepEqual(
			manifest.sources.map((source) => source.specId),
			["fix-loop.r02.implement", "fix-loop.r02.check"],
		);
		const prompt = prompts.find((text) => text.includes("Publish the final"));
		assert.match(prompt, /loop=fix-loop status=exhausted roundsUsed=2/);
		assert.match(prompt, /rubricMet=false/);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a consumer with after on a loop stays ordering-only and receives no loop sources", async () => {
	const cwd = makeProject();
	const prompts = captureWorkerPrompts();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = loopWithConsumerSpec(
			{ maxRounds: 5 },
			{ from: undefined, after: ["fix-loop"], inputPolicy: undefined },
		);
		const runId = await startLoopWithConsumer(cwd, spec);
		const current = await finishLoopRound(cwd, runId, 1, {
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: [],
		});
		await scheduleRun(cwd, runId);
		const after = await readRunRecord(cwd, runId);
		assert.deepEqual(taskBySpec(after, "publish.main").dependsOn, [
			"fix-loop.loop",
		]);
		const prompt = prompts.find((text) => text.includes("Publish the final"));
		assert.ok(prompt);
		// A failed loop is not swapped for its last round, so no Loop Results block (as for unlimited loops).
		assert.doesNotMatch(prompt, /# Loop Results/);
		assert.equal(current.loopResults[0].status, "completed");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a failed loop is an ordinary failed source: require-success skips, partial still runs", async () => {
	for (const [policy, expected] of [
		["require-success", "skipped"],
		["partial", "completed"],
	]) {
		const cwd = makeProject();
		captureWorkerPrompts();
		try {
			writeAgent(cwd, "unit-scout", "read");
			mkdirSync(join(cwd, "workflows"), { recursive: true });
			writeFileSync(
				join(cwd, "workflows", "cleanup.mjs"),
				'export default () => ({schema:"cleanup-v1",digest:"cleaned"});',
			);
			const spec = loopWorkflowSpec({ maxRounds: null });
			spec.artifactGraph.stages.push({
				id: "cleanup",
				from: ["fix-loop"],
				sourcePolicy: policy,
				support: { uses: "./cleanup.mjs" },
			});
			const runId = await startLoopWithConsumer(cwd, spec);
			const current = await readRunRecord(cwd, runId);
			setTaskTerminal(
				taskBySpec(current, "fix-loop.r01.implement"),
				"failed",
				"simulated_backend_failure",
			);
			await writeRunRecord(cwd, current);
			await scheduleRun(cwd, runId);
			const after = await scheduleRun(cwd, runId);
			assert.equal(taskBySpec(after, "fix-loop.loop").status, "failed");
			assert.deepEqual(taskBySpec(after, "cleanup.main").dependsOn, [
				"fix-loop.loop",
			]);
			assert.equal(taskBySpec(after, "cleanup.main").status, expected);
		} finally {
			setTaskRuntimeApiForTests(undefined);
			rmSync(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	}
});

test("loop child source names are round-independent only for consumers outside the loop", () => {
	const child = {
		specId: "fix-loop.r100.check",
		stageId: "fix-loop.r100.check",
	};
	assert.deepEqual(loopChildSourceIdentity(child), {
		loopId: "fix-loop",
		alias: "fix-loop.check",
	});
	assert.equal(
		sourceNameForTask(child, new Set(), { consumerSpecId: "publish.main" }),
		"fix-loop.check",
	);
	// Inside the loop, the onExhausted helper still sees every round under distinct names.
	assert.equal(
		sourceNameForTask(child, new Set(), {
			consumerSpecId: "fix-loop.onExhausted.summary",
		}),
		"fix-loop.r100.check",
	);
	assert.equal(sourceNameForTask(child, new Set()), "fix-loop.r100.check");
	assert.equal(
		loopChildSourceIdentity({ specId: "plain.main", stageId: "plain" }),
		undefined,
	);
});
