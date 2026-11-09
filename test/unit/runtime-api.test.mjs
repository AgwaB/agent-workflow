// test-tier: integration
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as runtime from "../../dist/runtime/index.js";
import { fixtureDescriptor } from "../fixtures/runtime/fake-executor-module.mjs";

const {
	createAttemptArtifactStore,
	getWorkerLogs,
	getWorkerStatus,
	interruptWorker,
	readAnswerPreview,
	reconcileWorkerRun,
	recordWorkerChildEvent,
	runParallelWorkerTasks,
	runWorker,
	startAsyncParallelWorkerRuns,
	startAsyncWorkerRun,
	WorkerValidationError,
	waitForWorker,
} = runtime;

let root;
let counter = 0;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-api-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function makeCwd() {
	counter += 1;
	const cwd = join(root, `cwd-${counter}`);
	await mkdir(cwd, { recursive: true });
	return cwd;
}

const failing = (effectLog) =>
	fixtureDescriptor({
		effectLog,
		script: [
			{ type: "started", sessionId: null },
			{
				type: "failed",
				class: "permanent",
				message: "scripted failure",
				raw: null,
			},
		],
	});

test("runtime API surface: the WorkerApi names WP4 calls, plus the barrier functions", () => {
	for (const name of [
		"runWorker",
		"getWorkerStatus",
		"getWorkerLogs",
		"waitForWorker",
		"interruptWorker",
		"reconcileWorkerRun",
		"recordWorkerChildEvent",
		"pruneWorkerRuns",
		"formatPruneWorkerRunsSummary",
		"createDurableLaunchBarrierV2",
		"durableLaunchBarrierDigest",
		"resolveDurableLaunchBarrierV2Release",
		"revokeDurableLaunchBarrierV2",
		"waitForDurableLaunchBarrierV2Ready",
		"waitForDurableLaunchBarrierV2Ack",
		"readDurableLaunchBarrierV2State",
		"assertDurableLaunchBarrierV2ExecutionAuthorized",
		"isDurableLaunchBarrierError",
		"isDurableLaunchBarrierRevokedError",
	])
		assert.equal(typeof runtime[name], "function", name);
	assert.equal(typeof runtime.DurableLaunchBarrierError, "function");
	assert.equal(typeof runtime.DurableLaunchBarrierRevokedError, "function");
	const barrierError = new runtime.DurableLaunchBarrierError("blocked");
	assert.equal(runtime.isDurableLaunchBarrierError(barrierError), true);
	assert.equal(barrierError.failureKind, "guard_failure");
	assert.equal(
		runtime.supportsExplicitExtensionIsolation,
		undefined,
		"Pi-only capability probe is gone",
	);
});

test("api: validation, status, logs, wait, child events, legacy status, interrupt/reconcile on missing runs", async () => {
	const effectLog = join(root, "api.jsonl");
	await assert.rejects(
		() => runWorker({ executor: fixtureDescriptor({ effectLog }) }),
		(error) =>
			error instanceof WorkerValidationError &&
			error.failureKind === "validation" &&
			/requires a non-empty task/u.test(error.message),
	);
	await assert.rejects(
		() => runWorker({ task: "x" }),
		(error) =>
			error instanceof WorkerValidationError && /executor/u.test(error.message),
	);
	const cwd = await makeCwd();
	const runId = "run_api_check";
	const attemptId = "attempt_api_check";
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const output = await store.writeTextArtifact("output", "api-ok\n");
	const result = await store.writeResult({
		executorId: "fixture",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: new Date("2026-01-01T00:00:01.000Z"),
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [output],
		metadata: { contextLengthExceeded: false },
	});
	await recordWorkerChildEvent({
		cwd,
		runId,
		event: "failed",
		childRunId: "run_child_api",
		childTaskId: "task-4",
		failureKind: "executor_permanent",
		message: "child failed",
	});
	const usageEvent = await recordWorkerChildEvent({
		cwd,
		runId,
		event: "completed",
		childRunId: "run_child_api_usage",
		childTaskId: "task-5",
		usage: { totalTokens: 1234, costUsd: 0.05 },
	});
	assert.deepEqual(usageEvent.data?.usage, {
		totalTokens: 1234,
		costUsd: 0.05,
	});
	const status = await getWorkerStatus({ cwd, runId, attemptId });
	assert.equal(status?.status, "completed");
	assert.equal(
		status?.resultPath,
		result.artifacts.find((artifact) => artifact.type === "result")?.path,
	);
	assert.equal(status?.childSummary?.failed, 1);
	assert.equal(
		status?.childSummary?.latestFailure?.childRunId,
		"run_child_api",
	);
	assert.equal(
		(await getWorkerLogs({ cwd, runId, attemptId }))?.logText.output,
		"api-ok\n",
	);
	const waited = await waitForWorker({
		cwd,
		runId,
		attemptId,
		timeoutMs: 100,
		pollIntervalMs: 10,
	});
	assert.equal(waited.snapshot?.status, "completed");
	assert.equal(
		(await interruptWorker({ cwd, runId: "run_missing_api_check" })).status,
		"not-found",
	);
	assert.equal(
		(await reconcileWorkerRun({ cwd, runId: "run_missing_api_check" })).status,
		"not-found",
	);

	const legacyDir = join(cwd, ".agent-workflow/runs/run_api_legacy/task-1");
	await mkdir(legacyDir, { recursive: true });
	const legacyOutput = ".agent-workflow/runs/run_api_legacy/task-1/output.log";
	const legacyResult = ".agent-workflow/runs/run_api_legacy/task-1/result.json";
	await writeFile(join(cwd, legacyOutput), "legacy-ok\n");
	await writeFile(
		join(cwd, legacyResult),
		`${JSON.stringify({
			schemaVersion: 1,
			runId: "run_api_legacy",
			taskId: "task-1",
			executorId: "fixture",
			status: "completed",
			failureKind: null,
			cwd,
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:00:01.000Z",
			durationMs: 1000,
			workspace: { mode: "shared", cwd, worktreePath: null },
			sandbox: { enabled: false },
			exitCode: 0,
			signal: null,
			artifacts: [
				{ type: "output", path: legacyOutput },
				{ type: "result", path: legacyResult },
			],
		})}\n`,
	);
	const legacyStatus = await getWorkerStatus({
		cwd,
		runId: "run_api_legacy",
		taskId: "task-1",
	});
	assert.equal(legacyStatus?.attemptId, "task-1");
	assert.equal(legacyStatus?.metadata.contextLengthExceeded, false);
});

test("api: onComplete notify fires once for a failed async run; async parallel runs reach terminal", async () => {
	const cwd = await makeCwd();
	const effectLog = join(root, "notify.jsonl");
	let completionCalls = 0;
	const failedStart = await startAsyncWorkerRun({
		cwd,
		input: { executor: failing(effectLog), task: "fail", onComplete: "notify" },
		onComplete(result, mode) {
			completionCalls += 1;
			assert.equal(mode, "single");
			assert.equal(result.status, "failed");
			return 1;
		},
	});
	const failedWait = await waitForWorker({
		cwd,
		runId: failedStart.runId,
		attemptId: failedStart.attemptId,
		timeoutMs: 10_000,
		pollIntervalMs: 50,
	});
	assert.equal(failedWait.snapshot?.status, "failed");
	assert.equal(failedWait.snapshot?.failureKind, "executor_permanent");
	let failedStatus;
	for (let index = 0; index < 60; index += 1) {
		failedStatus = await getWorkerStatus({
			cwd,
			runId: failedStart.runId,
			attemptId: failedStart.attemptId,
		});
		if (failedStatus?.completion?.notified) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(failedStatus?.completion?.notified, true);
	assert.equal(failedStatus?.completion?.updatesSent, 1);
	assert.equal(completionCalls, 1);

	const asyncParallel = await runWorker({
		cwd,
		executor: fixtureDescriptor({ effectLog: join(root, "parallel.jsonl") }),
		async: true,
		timeoutMs: 10_000,
		correlationId: "corr_api_async_parallel",
		tasks: [{ task: "async A" }, { task: "async B" }],
	});
	assert.equal(asyncParallel.mode, "parallel");
	assert.equal(new Set(asyncParallel.runIds).size, 2);
	assert.deepEqual(
		asyncParallel.results.map((item) => item.status),
		["running", "running"],
	);
	for (const item of asyncParallel.results) {
		const waitedParallel = await waitForWorker({
			cwd,
			runId: item.runId,
			attemptId: item.attemptId,
			timeoutMs: 30_000,
			pollIntervalMs: 100,
		});
		assert.equal(waitedParallel.snapshot?.status, "completed");
	}
});

test("answer preview reads the executor output: completed is final, failed is partial", async () => {
	const cwd = await makeCwd();
	const completed = await runWorker({
		cwd,
		executor: fixtureDescriptor({ effectLog: join(root, "preview.jsonl") }),
		task: "short",
	});
	assert.deepEqual(await readAnswerPreview(completed), {
		text: "fixture final answer",
		partial: false,
		truncated: false,
	});
	const failed = await runWorker({
		cwd,
		executor: fixtureDescriptor({
			effectLog: join(root, "preview-failed.jsonl"),
			script: [
				{ type: "started", sessionId: null },
				{ type: "message_delta", text: "x".repeat(3000) },
				{ type: "failed", class: "transient", message: "flaky", raw: null },
			],
		}),
		task: "long",
	});
	assert.equal(failed.failureKind, "transient");
	const preview = await readAnswerPreview(failed);
	assert.equal(preview.partial, true);
	assert.equal(preview.truncated, true);
	assert.equal(preview.text.length, 2048);
	assert.equal(
		await readAnswerPreview(failed, 10).then((value) => value.text),
		"x".repeat(10),
	);
});

test("fail-fast: parallel failures, fail-fast skipping, sibling cancel, parent abort", async () => {
	const cwd = await makeCwd();
	const effectLog = join(root, "fail-fast.jsonl");
	const common = {
		executor: failing(effectLog),
		parentSessionId: "session-fail-fast",
		correlationId: "corr-fail-fast",
	};
	const noFailFast = await runParallelWorkerTasks(
		{
			...common,
			concurrency: 2,
			tasks: [{ task: "bad A" }, { task: "bad B" }],
		},
		cwd,
	);
	assert.equal(noFailFast.totalTasks, 2);
	assert.equal(noFailFast.startedCount, 2);
	assert.equal(noFailFast.skippedCount, 0);
	assert.equal(noFailFast.failFastTriggered, false);
	assert.deepEqual(
		noFailFast.results.map((result) => result.status),
		["failed", "failed"],
	);
	assert.equal(new Set(noFailFast.runIds).size, 2);
	const firstFailure = noFailFast.results[0];
	const firstDir = join(cwd, ".agent-workflow/runs", firstFailure.runId);
	const firstRecord = JSON.parse(
		await readFile(join(firstDir, "run.json"), "utf8"),
	);
	assert.equal(firstRecord.parentSessionId, "session-fail-fast");
	assert.equal(firstRecord.correlationId, "corr-fail-fast");
	const firstEvents = (await readFile(join(firstDir, "events.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(firstEvents.some((event) => event.type === "attempt.started"));
	assert.ok(firstEvents.some((event) => event.type === "run.failed"));
	const locator = JSON.parse(
		await readFile(
			join(
				process.env.AGENT_WORKFLOW_RUN_INDEX_DIR,
				`${firstFailure.runId}.json`,
			),
			"utf8",
		),
	);
	assert.equal(locator.parentSessionId, "session-fail-fast");
	assert.equal(locator.correlationId, "corr-fail-fast");

	const failFast = await runParallelWorkerTasks(
		{
			...common,
			concurrency: 1,
			failFast: true,
			tasks: [{ task: "bad first" }, { task: "must be skipped" }],
		},
		cwd,
	);
	assert.equal(failFast.startedCount, 1);
	assert.equal(failFast.skippedCount, 1);
	assert.equal(failFast.failFastTriggered, true);
	assert.equal(failFast.results.length, 1);
	assert.equal(failFast.results[0]?.status, "failed");

	const cancelSiblings = await runParallelWorkerTasks(
		{
			...common,
			concurrency: 1,
			cancelSiblingsOnFailure: true,
			tasks: [{ task: "bad first" }, { task: "must be skipped" }],
		},
		cwd,
	);
	assert.equal(cancelSiblings.failFastTriggered, true);
	assert.equal(cancelSiblings.skippedCount, 1);

	const aborted = new AbortController();
	aborted.abort();
	const parentAbort = await runParallelWorkerTasks(
		{
			executor: failing(effectLog),
			failFast: true,
			tasks: [{ task: "parent aborted before start" }],
		},
		cwd,
		aborted.signal,
	);
	assert.equal(parentAbort.results[0]?.status, "cancelled");
	assert.equal(parentAbort.results[0]?.failureKind, "abort");
	assert.equal(parentAbort.failFastTriggered, false);
});

test("fail-fast: async parallel prevalidates every executor and accounts for spawned siblings", async () => {
	const asyncCwd = await makeCwd();
	const executor = fixtureDescriptor({
		effectLog: join(root, "async-parallel.jsonl"),
	});
	await assert.rejects(
		() =>
			startAsyncParallelWorkerRuns(
				{
					executor,
					async: true,
					tasks: [
						{ task: "would spawn" },
						{
							task: "invalid executor",
							executor: { ...executor, module: "./relative.mjs" },
						},
					],
				},
				asyncCwd,
			),
		/parallel tasks\[1\] executor is invalid/u,
	);
	const entries = await readdir(join(asyncCwd, ".agent-workflow/runs"), {
		withFileTypes: true,
	}).catch(() => []);
	assert.equal(
		entries.length,
		0,
		"prevalidation fails before spawning earlier siblings",
	);

	const badCwd = join(asyncCwd, "not-a-directory");
	await writeFile(badCwd, "file blocks cwd directory creation");
	let partialError;
	try {
		await startAsyncParallelWorkerRuns(
			{
				executor,
				async: true,
				concurrency: 2,
				tasks: [
					{ task: "spawn then fail later" },
					{ task: "bad cwd", cwd: badCwd },
					{ task: "spawned sibling must be accounted" },
				],
			},
			asyncCwd,
		);
	} catch (error) {
		partialError = error;
	}
	assert.ok(partialError, "mid-launch async failure should reject");
	assert.ok(partialError.startedRunIds?.length >= 1);
	assert.equal(
		partialError.startedResults?.length,
		partialError.startedRunIds?.length,
	);
	const partialEntries = await readdir(join(asyncCwd, ".agent-workflow/runs"), {
		withFileTypes: true,
	}).catch(() => []);
	assert.equal(
		partialEntries.filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith("."),
		).length,
		partialError.startedRunIds?.length,
	);
	for (const runId of partialError.startedRunIds)
		await waitForWorker({
			cwd: asyncCwd,
			runId,
			timeoutMs: 20_000,
			pollIntervalMs: 50,
		});
});

test("parent session id reaches run.json for a sync run", async () => {
	const cwd = await makeCwd();
	const result = await runWorker({
		cwd,
		executor: fixtureDescriptor({ effectLog: join(root, "parent.jsonl") }),
		task: "Reply exactly: parent-session-ok",
		parentSessionId: "session_e2e_999",
	});
	const record = JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow/runs", result.runId, "run.json"),
			"utf8",
		),
	);
	assert.equal(record.parentSessionId, "session_e2e_999");
	assert.equal(result.metadata.parentSessionId, "session_e2e_999");
});
