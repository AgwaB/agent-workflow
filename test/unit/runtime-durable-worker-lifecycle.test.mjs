// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) test/checks/durable-worker-payload.mjs sections 5b–7 and test/checks/lifecycle.mjs. MIT, same author. Changes: workers are the compiled dist/runtime/workers/*.js; payloads carry an ExecutorDescriptor (the fake executor fixture) instead of backend "headless"/"inline", so the model-backed sections 6–7 run provider-free; runs dir ".agent-workflow/runs"; env names AGENT_WORKFLOW_*; the stubborn headless-Pi interrupt case is dropped (see runtime-port record).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	appendRunEvent,
	beginRunRecord,
	captureProcessIdentity,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	DURABLE_WORKER_TASK_FILE,
	discardSubagentExecution,
	finishAttemptFromResult,
	getSubagentStatus,
	interruptSubagent,
	prepareSubagentExecution,
	readRunEvents,
	readRunRecord,
	recordAttemptHeartbeat,
	runtimeWorkerPath,
	startAsyncSubagentRun,
	updateAttemptProcess,
	upsertRunAttempt,
	verifyProcessIdentity,
	waitForSubagent,
	writeDurableWorkerPayload,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const workerScript = runtimeWorkerPath("durable-worker");
const finalizerPath = runtimeWorkerPath("terminal-finalizer");
let root;
let cwd;
let effectLog;
let executor;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-worker-lifecycle-"));
	cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	effectLog = join(root, "effects.jsonl");
	executor = fixtureDescriptor({ effectLog });
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function pidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPayloadWorker(options) {
	const result = await waitForSubagent(options);
	assert.equal(result.status, "completed", JSON.stringify(result));
	// waitForSubagent promises a terminal result, not completion of the
	// detached finalizer's event writes. Do not remove its fixture early.
	const status = result.snapshot.status;
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	while (Date.now() < deadline) {
		const events = await readRunEvents(options, Infinity);
		if (
			events.some(
				(event) =>
					event.type === `attempt.${status}` &&
					event.attemptId === options.attemptId,
			) &&
			events.some((event) => event.type === `run.${status}`)
		)
			return result;
		await new Promise((resolveSleep) =>
			setTimeout(resolveSleep, options.pollIntervalMs ?? 50),
		);
	}
	assert.fail(
		`timed out waiting for terminal event publication: ${options.runId}/${options.attemptId}`,
	);
}

/** The launcher's record sequence (startAsyncSubagentRun) without spawning the worker. */
async function stageRunningAttempt({
	runId,
	attemptId,
	payloadText,
	input,
	payloadExecutor = executor,
}) {
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const payloadPath = store.pathFor("worker");
	let bytes;
	if (payloadText !== undefined) {
		await writeFile(payloadPath, payloadText);
		bytes = Buffer.byteLength(payloadText);
	} else {
		bytes = (
			await writeDurableWorkerPayload({
				payloadPath,
				input,
				cwd,
				backend: payloadExecutor.id,
				executor: payloadExecutor,
				runId,
				attemptId,
				startedAt: startedAt.toISOString(),
			})
		).bytes;
	}
	const running = await store.writeResult({
		backend: "fixture",
		status: "running",
		failureKind: null,
		cwd,
		startedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [store.refFor("worker", bytes)],
		metadata: { contextLengthExceeded: false },
	});
	await upsertRunAttempt({
		cwd,
		runId,
		attemptId,
		status: "running",
		backend: "fixture",
		startedAt,
		artifactCwd: cwd,
		resultPath: running.artifacts.find((artifact) => artifact.type === "result")
			?.path,
		createOnly: true,
		requireNoActive: true,
		activate: true,
	});
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: "fixture",
		startedAt,
		dependency: "unclassified",
		activeAttemptId: attemptId,
		attempts: [],
	});
	return { store, payloadPath };
}

function spawnWorker(payloadPath, extraArgs = []) {
	const worker = spawn(
		process.execPath,
		[workerScript, payloadPath, ...extraArgs],
		{
			cwd,
			detached: process.platform !== "win32",
			stdio: "ignore",
		},
	);
	return worker;
}

test("5b: a terminal result alone does not permit cleanup; the finalizer publishes events", async () => {
	const ref = {
		cwd: join(root, "publication-barrier"),
		runId: "run_payload_publication",
		attemptId: "attempt_payload_publication",
	};
	const store = await createAttemptArtifactStore(ref);
	const startedAt = new Date();
	const result = await store.writeResult({
		backend: "fixture",
		status: "failed",
		failureKind: "executor_permanent",
		cwd: ref.cwd,
		startedAt,
		completedAt: new Date(),
		workspace: { mode: "shared", cwd: ref.cwd },
		sandbox: { enabled: false },
		exitCode: 1,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await beginRunRecord({
		...ref,
		mode: "single",
		backend: "fixture",
		startedAt,
		attempts: [
			{
				attemptId: ref.attemptId,
				status: "failed",
				backend: "fixture",
				startedAt: startedAt.toISOString(),
				completedAt: new Date().toISOString(),
				artifactCwd: ref.cwd,
				resultPath: result.artifacts.find(
					(artifact) => artifact.type === "result",
				).path,
			},
		],
	});
	assert.equal(
		(await waitForSubagent({ ...ref, timeoutMs: 5000 })).status,
		"completed",
	);
	assert.equal((await readRunEvents(ref)).length, 0);
	await assert.rejects(
		waitForPayloadWorker({ ...ref, timeoutMs: 1000, pollIntervalMs: 10 }),
		/terminal event publication/u,
		"a terminal result alone must not permit fixture cleanup",
	);
	const worker = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{
			detached: process.platform !== "win32",
			stdio: "ignore",
		},
	);
	const workerExit = once(worker, "exit");
	let identity;
	try {
		identity = await captureProcessIdentity(worker.pid);
	} finally {
		worker.kill("SIGTERM");
		await workerExit;
	}
	const finalizer = spawn(
		process.execPath,
		[
			finalizerPath,
			Buffer.from(
				JSON.stringify({
					ref,
					attemptId: ref.attemptId,
					status: "failed",
					worker: identity,
				}),
			).toString("base64url"),
		],
		{ cwd: ref.cwd, stdio: "ignore" },
	);
	const finalizerExit = once(finalizer, "exit");
	assert.equal(
		(
			await waitForPayloadWorker({
				...ref,
				timeoutMs: 10_000,
				pollIntervalMs: 10,
			})
		).status,
		"completed",
	);
	await rm(ref.cwd, { recursive: true });
	assert.deepEqual(await finalizerExit, [0, null]);
	await assert.rejects(stat(ref.cwd), /ENOENT/u);
});

test("5b: a worker whose prompt sidecar is missing still terminalizes with guard_failure", async () => {
	const runId = "run_payload_broken_sidecar";
	const attemptId = "attempt_payload_broken";
	const { store, payloadPath } = await stageRunningAttempt({
		runId,
		attemptId,
		input: {
			task: "This prompt will go missing.",
			onComplete: "detach",
			sandbox: false,
		},
	});
	await rm(join(store.attemptDir, "task.md"));
	spawnWorker(payloadPath).unref();
	const wait = await waitForPayloadWorker({
		cwd,
		runId,
		attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 100,
	});
	assert.equal(wait.snapshot?.status, "failed");
	assert.equal(wait.snapshot?.failureKind, "guard_failure");
	const record = await readRunRecord({ cwd, runId });
	assert.equal(record?.status, "failed");
	assert.equal(record?.activeAttemptId, null);
	assert.match(
		await readFile(join(store.attemptDir, "stderr.log"), "utf8"),
		/task\.md|ENOENT|sidecar|reference/iu,
	);
});

test("5c: a payload that is not valid JSON terminalizes from the payload path", async () => {
	const runId = "run_payload_invalid_json";
	const attemptId = "attempt_payload_invalid_json";
	const { store, payloadPath } = await stageRunningAttempt({
		runId,
		attemptId,
		payloadText: "{",
	});
	spawnWorker(payloadPath).unref();
	const wait = await waitForPayloadWorker({
		cwd,
		runId,
		attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 100,
	});
	assert.equal(wait.snapshot?.status, "failed");
	assert.equal(wait.snapshot?.failureKind, "guard_failure");
	assert.equal((await readRunRecord({ cwd, runId }))?.activeAttemptId, null);
	assert.match(
		await readFile(join(store.attemptDir, "stderr.log"), "utf8"),
		/not valid JSON/u,
	);
});

test("5d: non-envelopes, mislocated or redirected payloads, and executor problems terminalize with guard_failure", async () => {
	const foreignCwd = join(root, "foreign-project");
	await mkdir(foreignCwd, { recursive: true });
	const envelope = (runId, attemptId, overrides = {}) =>
		JSON.stringify({
			input: { task: "x" },
			cwd,
			backend: "fixture",
			executor,
			runId,
			attemptId,
			startedAt: new Date().toISOString(),
			...overrides,
		});
	for (const [label, payloadText] of [
		["empty-object", "{}\n"],
		["id-mismatch", envelope("run_somewhere_else", "attempt_elsewhere")],
		[
			"bad-fields",
			JSON.stringify({
				input: { task: "x" },
				cwd: "",
				backend: "bogus value",
				runId: "",
				attemptId: "",
				startedAt: "yesterday",
			}),
		],
		[
			"wrong-cwd",
			(runId, attemptId) => envelope(runId, attemptId, { cwd: foreignCwd }),
		],
		[
			"escaping-runs-dir",
			(runId, attemptId) =>
				envelope(runId, attemptId, {
					input: { task: "x", runsDir: "../outside" },
				}),
		],
		[
			"coordinated-cwd",
			(runId, attemptId) =>
				envelope(runId, attemptId, {
					cwd: root,
					input: { task: "x", runsDir: "project/.agent-workflow/runs" },
				}),
		],
		// WP2a-2: the runtime never substitutes an executor.
		[
			"no-executor",
			(runId, attemptId) => envelope(runId, attemptId, { executor: undefined }),
		],
		[
			"executor-backend-mismatch",
			(runId, attemptId) => envelope(runId, attemptId, { backend: "other" }),
		],
		[
			"relative-executor-module",
			(runId, attemptId) =>
				envelope(runId, attemptId, {
					executor: { ...executor, module: "./x.mjs" },
				}),
		],
	]) {
		const runId = `run_payload_shape_${label}`;
		const attemptId = `attempt_payload_shape_${label}`;
		const text =
			typeof payloadText === "function"
				? payloadText(runId, attemptId)
				: payloadText;
		const { payloadPath } = await stageRunningAttempt({
			runId,
			attemptId,
			payloadText: text,
		});
		spawnWorker(payloadPath).unref();
		const wait = await waitForPayloadWorker({
			cwd,
			runId,
			attemptId,
			timeoutMs: 60_000,
			pollIntervalMs: 100,
		});
		assert.equal(wait.snapshot?.status, "failed", label);
		assert.equal(wait.snapshot?.failureKind, "guard_failure", label);
		const record = await readRunRecord({ cwd, runId });
		assert.equal(record?.activeAttemptId, null, label);
		assert.equal(
			record?.cwd,
			cwd,
			`${label}: the record keeps the run's own cwd`,
		);
		assert.equal(
			record?.runsDir,
			".agent-workflow/runs",
			`${label}: the record keeps its runs dir`,
		);
	}
	await assert.rejects(stat(join(foreignCwd, ".agent-workflow")), /ENOENT/u);
	await assert.rejects(stat(join(root, "outside")), /ENOENT/u);
	assert.deepEqual(
		readEffectLog(effectLog),
		[],
		"no shape failure reached the executor",
	);
});

test("5e: a worker for an already-terminal attempt exits without touching its artifacts", async () => {
	const runId = "run_payload_stale_attempt";
	const attemptId = "attempt_payload_stale";
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const payloadPath = store.pathFor("worker");
	await writeDurableWorkerPayload({
		payloadPath,
		input: { task: "never runs", onComplete: "detach", sandbox: false },
		cwd,
		backend: "fixture",
		executor,
		runId,
		attemptId,
		startedAt: startedAt.toISOString(),
	});
	const staleResult = await store.writeResult({
		backend: "fixture",
		status: "cancelled",
		failureKind: "user_cancelled",
		cwd,
		startedAt,
		completedAt: new Date(),
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: "fixture",
		startedAt,
		attempts: [],
	});
	await upsertRunAttempt({
		cwd,
		runId,
		attemptId,
		status: "cancelled",
		backend: "fixture",
		failureKind: "user_cancelled",
		startedAt,
		completedAt: new Date(),
		artifactCwd: cwd,
		resultPath: staleResult.artifacts.find(
			(artifact) => artifact.type === "result",
		)?.path,
		activate: true,
		onlyIfActive: false,
	});
	const resultPath = join(store.attemptDir, "result.json");
	const resultBefore = await readFile(resultPath, "utf8");
	const recordBefore = JSON.stringify(await readRunRecord({ cwd, runId }));
	const worker = spawnWorker(payloadPath);
	const [code] = await once(worker, "exit");
	assert.equal(code, 1, "worker exits without executing");
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
	assert.equal(await readFile(resultPath, "utf8"), resultBefore);
	assert.equal(
		JSON.stringify(await readRunRecord({ cwd, runId })),
		recordBefore,
	);
	assert.equal(
		(
			await readFile(join(store.attemptDir, "stderr.log"), "utf8").catch(
				() => "",
			)
		).includes("guard_failure"),
		false,
	);
});

test("6–7: a detached worker launches from the reference payload and from a legacy inline payload", async () => {
	const launched = await startAsyncSubagentRun({
		cwd,
		input: {
			executor,
			task: "Reply with the single word done.",
			onComplete: "detach",
			sandbox: false,
		},
	});
	const wait = await waitForPayloadWorker({
		cwd,
		runId: launched.runId,
		attemptId: launched.attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 50,
	});
	assert.equal(
		wait.snapshot?.status,
		"completed",
		JSON.stringify(wait.snapshot),
	);
	const workerRef = launched.artifacts.find(
		(artifact) => artifact.type === "worker",
	);
	const workerPath = join(cwd, workerRef.path);
	const livePayload = JSON.parse(await readFile(workerPath, "utf8"));
	assert.equal(livePayload.input.task, undefined);
	assert.equal(livePayload.input.taskRef.path, DURABLE_WORKER_TASK_FILE);
	assert.deepEqual(livePayload.executor, executor);
	assert.equal(
		livePayload.input.attemptKey,
		`${launched.runId}:${launched.attemptId}`,
	);
	assert.equal((await stat(workerPath)).size, workerRef.bytes);
	assert.equal(
		await readFile(join(workerPath, "..", DURABLE_WORKER_TASK_FILE), "utf8"),
		"Reply with the single word done.",
	);

	const runId = "run_legacy_inline_payload";
	const attemptId = "attempt_legacy_inline";
	const text = `${JSON.stringify(
		{
			input: {
				task: "Reply with the single word legacy.",
				onComplete: "detach",
				sandbox: false,
			},
			cwd,
			backend: "fixture",
			executor,
			runId,
			attemptId,
			startedAt: new Date().toISOString(),
		},
		null,
		2,
	)}\n`;
	const { store, payloadPath } = await stageRunningAttempt({
		runId,
		attemptId,
		payloadText: text,
	});
	spawnWorker(payloadPath, ["ownership-legacy-check"]).unref();
	const legacyWait = await waitForPayloadWorker({
		cwd,
		runId,
		attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 100,
	});
	assert.equal(
		legacyWait.snapshot?.status,
		"completed",
		JSON.stringify(legacyWait.snapshot),
	);
	assert.equal(
		await readFile(join(store.attemptDir, "output.log"), "utf8"),
		"fixture final answer",
	);
	const stored = JSON.parse(await readFile(payloadPath, "utf8"));
	assert.equal(
		stored.input.task,
		"Reply with the single word legacy.",
		"inline payload must stay inline",
	);
	assert.equal(stored.input.taskRef, undefined);
	const submits = readEffectLog(effectLog).filter(
		(entry) => entry.type === "submit",
	);
	assert.ok(
		submits.some(
			(entry) => entry.prompt === "Reply with the single word legacy.",
		),
	);
	assert.ok(
		submits.some((entry) => entry.attemptKey === `${runId}:${attemptId}`),
		"default attemptKey",
	);
});

test("lifecycle: late heartbeat/process updates and late results never mutate a terminal attempt", async () => {
	const runId = "run_lifecycle_terminal";
	const attemptId = "attempt_lifecycle_terminal";
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const result = await store.writeResult({
		backend: "fixture",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:02.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult({ cwd, runId }, result);
	await recordAttemptHeartbeat({ cwd, runId, attemptId });
	await updateAttemptProcess({
		cwd,
		runId,
		attemptId,
		process: { pid: 99999999, command: "late-heartbeat" },
	});
	const terminalRecord = await readRunRecord({ cwd, runId });
	assert.equal(terminalRecord?.status, "completed");
	assert.equal(terminalRecord?.completedAt, "2026-01-01T00:00:02.000Z");
	assert.equal(terminalRecord?.attempts[0]?.process?.command, undefined);
	const lateCancel = await store.writeResult({
		...result,
		status: "cancelled",
		failureKind: "user_cancelled",
		completedAt: "2026-01-01T00:00:03.000Z",
		signal: "SIGINT",
	});
	assert.equal(
		(await commitAttemptResultIfActive({ cwd, runId }, lateCancel)).committed,
		false,
	);
	assert.equal((await readRunRecord({ cwd, runId }))?.status, "completed");
});

test("lifecycle: a successor cannot reserve while another attempt is active; a stale discard spares it", async () => {
	const runId = "run_stale_prepared";
	const a = await prepareSubagentExecution({
		cwd,
		runId,
		attemptId: "attempt_prepared_a",
		input: { executor, task: "must not execute" },
	});
	await assert.rejects(
		prepareSubagentExecution({
			cwd,
			runId,
			attemptId: "attempt_prepared_b",
			input: { executor, task: "successor" },
		}),
		/already has active attempt/u,
	);
	await upsertRunAttempt({
		cwd,
		runId,
		attemptId: a.attemptId,
		status: "cancelled",
		backend: "fixture",
		failureKind: "user_cancelled",
		completedAt: new Date(),
		activate: true,
		onlyIfActive: true,
	});
	const b = await prepareSubagentExecution({
		cwd,
		runId,
		attemptId: "attempt_prepared_b",
		input: { executor, task: "successor" },
	});
	await discardSubagentExecution(a);
	assert.equal(
		(await readRunRecord({ cwd, runId }))?.activeAttemptId,
		b.attemptId,
	);
	await discardSubagentExecution(b);
});

test("lifecycle: the terminal finalizer publishes once and never against a successor", async () => {
	const finalizerWorker = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	const identity = await captureProcessIdentity(finalizerWorker.pid);
	process.kill(-identity.processGroupId, "SIGKILL");
	await new Promise((resolveExit) => finalizerWorker.once("exit", resolveExit));
	const runFinalizer = async (payload) => {
		const child = spawn(
			process.execPath,
			[
				finalizerPath,
				Buffer.from(JSON.stringify(payload)).toString("base64url"),
			],
			{ cwd, stdio: "ignore" },
		);
		const [code] = await once(child, "exit");
		return code;
	};
	for (const terminalCase of [
		{ status: "completed", failureKind: null },
		{ status: "failed", failureKind: "executor_permanent" },
		{ status: "cancelled", failureKind: "user_cancelled" },
	]) {
		const runId = `run_finalizer_${terminalCase.status}`;
		const attemptId = `attempt_finalizer_${terminalCase.status}`;
		const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
		const finalizerResult = await store.writeResult({
			backend: "fixture",
			status: terminalCase.status,
			failureKind: terminalCase.failureKind,
			cwd,
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: { mode: "shared", cwd, worktreePath: null },
			sandbox: { enabled: false },
			exitCode: terminalCase.status === "completed" ? 0 : null,
			signal: terminalCase.status === "cancelled" ? "SIGTERM" : null,
			artifacts: [],
			metadata: { contextLengthExceeded: false },
		});
		await beginRunRecord({
			cwd,
			runId,
			mode: "single",
			backend: "fixture",
			activeAttemptId: attemptId,
			attempts: [
				{
					attemptId,
					status: "running",
					backend: "fixture",
					startedAt: new Date().toISOString(),
					artifactCwd: cwd,
					resultPath: finalizerResult.artifacts.find(
						(artifact) => artifact.type === "result",
					)?.path,
					process: {
						workerPid: identity.pid,
						workerProcessGroupId: identity.processGroupId,
						workerProcessBirthIdentity: identity.birthIdentity,
					},
				},
			],
		});
		assert.equal(
			await runFinalizer({
				ref: { cwd, runId },
				attemptId,
				status: terminalCase.status,
				worker: identity,
			}),
			0,
		);
		const events = await readRunEvents({ cwd, runId });
		assert.equal(
			events.filter((event) => event.type === `attempt.${terminalCase.status}`)
				.length,
			1,
		);
		assert.equal(
			events.filter((event) => event.type === `run.${terminalCase.status}`)
				.length,
			1,
		);
	}
	const delayedRunId = "run_delayed_finalizer_successor";
	await beginRunRecord({
		cwd,
		runId: delayedRunId,
		mode: "single",
		backend: "fixture",
		attempts: [
			{
				attemptId: "attempt_successor",
				status: "completed",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			},
		],
	});
	assert.equal(
		await runFinalizer({
			ref: { cwd, runId: delayedRunId },
			attemptId: "attempt_stale_finalizer",
			status: "failed",
			worker: identity,
		}),
		0,
	);
	const delayedEvents = await readRunEvents({ cwd, runId: delayedRunId });
	assert.equal(
		delayedEvents.some(
			(event) => event.attemptId === "attempt_stale_finalizer",
		),
		false,
	);
	assert.equal(
		delayedEvents.some((event) => event.type === "run.failed"),
		false,
	);
	const activeRunId = "run_stale_finalizer_active_successor";
	await beginRunRecord({
		cwd,
		runId: activeRunId,
		mode: "single",
		backend: "fixture",
		activeAttemptId: "attempt_active_successor",
		attempts: [
			{
				attemptId: "attempt_active_successor",
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
			},
		],
	});
	assert.equal(
		await runFinalizer({
			ref: { cwd, runId: activeRunId },
			attemptId: "attempt_stale_finalizer",
			status: "failed",
			worker: identity,
		}),
		0,
	);
	const afterActive = await readRunRecord({ cwd, runId: activeRunId });
	assert.equal(afterActive?.status, "running");
	assert.equal(afterActive?.activeAttemptId, "attempt_active_successor");
	assert.equal(afterActive?.attempts[0]?.failureKind ?? null, null);
});

test("lifecycle: child event summary survives a torn line; event cache is copy-on-read; bogus status is null", async () => {
	const runId = "run_lifecycle_events";
	const attemptId = "attempt_lifecycle_events";
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const result = await store.writeResult({
		backend: "fixture",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult({ cwd, runId }, result);
	await appendRunEvent(
		{ cwd, runId },
		{
			type: "child.failed",
			status: "failed",
			message: "temporary",
			data: { childRunId: "run_child", failureKind: "executor_permanent" },
		},
	);
	await appendFile(
		join(cwd, ".agent-workflow/runs", runId, "events.jsonl"),
		"{not-json}\n",
	);
	await appendRunEvent(
		{ cwd, runId },
		{
			type: "child.completed",
			status: "completed",
			message: "recovered",
			data: { childRunId: "run_child" },
		},
	);
	const status = await getSubagentStatus({ cwd, runId, attemptId });
	assert.equal(status?.childSummary?.total, 1);
	assert.equal(status?.childSummary?.failed, 0);
	assert.equal(status?.childSummary?.completed, 1);
	assert.equal(status?.childSummary?.latestFailure, null);
	const cached = await readRunEvents({ cwd, runId }, Infinity);
	cached.length = 0;
	const again = await readRunEvents({ cwd, runId }, Infinity);
	assert.ok(again.length > 0);
	again[0].type = "run.failed";
	assert.notEqual(
		(await readRunEvents({ cwd, runId }, Infinity))[0]?.type,
		"run.failed",
	);
	const waited = await waitForSubagent({
		cwd,
		runId,
		attemptId,
		timeoutMs: 100,
		pollIntervalMs: 10,
	});
	assert.equal(waited.outcome, "terminal");
	assert.equal(waited.snapshot?.durationMs, 1000);
	const bogusDir = join(
		cwd,
		".agent-workflow/runs/run_bogus_status/attempts/attempt_bogus",
	);
	await mkdir(bogusDir, { recursive: true });
	await writeFile(
		join(bogusDir, "result.json"),
		`${JSON.stringify({ runId: "run_bogus_status", attemptId: "attempt_bogus", backend: "fixture", status: "done", cwd })}\n`,
	);
	assert.equal(
		await getSubagentStatus({
			cwd,
			runId: "run_bogus_status",
			attemptId: "attempt_bogus",
		}),
		null,
	);
});

test("lifecycle: terminal publication waits for the worker to exit; a delayed worker is interruptible", async () => {
	const asyncFalse = await startAsyncSubagentRun({
		cwd,
		input: { executor, task: "quick", sandbox: false, onComplete: "detach" },
	});
	assert.equal(asyncFalse.sandbox.enabled, false);
	await waitForPayloadWorker({
		cwd,
		runId: asyncFalse.runId,
		attemptId: asyncFalse.attemptId,
		timeoutMs: 10_000,
	});
	const worker = (await readRunRecord({ cwd, runId: asyncFalse.runId }))
		?.attempts[0]?.process;
	assert.equal(
		await verifyProcessIdentity({
			pid: worker.workerPid,
			processGroupId: worker.workerProcessGroupId,
			birthIdentity: worker.workerProcessBirthIdentity,
		}),
		"dead",
		"terminal publication must wait for the durable worker to exit",
	);

	const previousDelay =
		process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS;
	const previousTerminalDelay =
		process.env.AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS;
	const previousHeartbeat = process.env.AGENT_WORKFLOW_HEARTBEAT_MS;
	process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS = "3000";
	process.env.AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS = "250";
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
	try {
		const before = readEffectLog(effectLog).length;
		const interruptible = await startAsyncSubagentRun({
			cwd,
			input: {
				executor,
				task: "This delayed worker should be interrupted.",
				onComplete: "detach",
			},
		});
		// WP2b: interrupt once the worker runs JavaScript (its own registry write moves
		// heartbeatAt past the launcher's). A fixed 250 ms raced node's own startup under load: a
		// SIGTERM delivered before the worker's first statement kills it by default, and nothing
		// writes a terminal result until a later reconcile.
		const launched = (await readRunRecord({ cwd, runId: interruptible.runId }))
			?.attempts[0]?.heartbeatAt;
		const startedBy = Date.now() + 20_000;
		while (
			Date.now() < startedBy &&
			(await readRunRecord({ cwd, runId: interruptible.runId }))?.attempts[0]
				?.heartbeatAt === launched
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		const interrupted = await interruptSubagent({
			cwd,
			runId: interruptible.runId,
			attemptId: interruptible.attemptId,
			reason: "lifecycle test cancellation",
			escalateAfterMs: 10,
			killAfterMs: 3000,
		});
		assert.equal(interrupted.status, "interrupt-requested");
		assert.equal(interrupted.signal, "SIGTERM");
		const wait = await waitForSubagent({
			cwd,
			runId: interruptible.runId,
			attemptId: interruptible.attemptId,
			timeoutMs: 5000,
			pollIntervalMs: 50,
		});
		assert.equal(wait.snapshot?.status, "cancelled");
		assert.equal(wait.snapshot?.failureKind, "user_cancelled");
		const events = await readRunEvents(
			{ cwd, runId: interruptible.runId },
			Infinity,
		);
		assert.equal(
			events.some((event) => event.type === "attempt.stale_result_ignored"),
			false,
		);
		assert.equal(
			readEffectLog(effectLog).length,
			before,
			"cancelled before the executor was touched",
		);
	} finally {
		if (previousDelay === undefined)
			delete process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS;
		else
			process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS = previousDelay;
		if (previousTerminalDelay === undefined)
			delete process.env.AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS;
		else
			process.env.AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS =
				previousTerminalDelay;
		if (previousHeartbeat === undefined)
			delete process.env.AGENT_WORKFLOW_HEARTBEAT_MS;
		else process.env.AGENT_WORKFLOW_HEARTBEAT_MS = previousHeartbeat;
	}
});

test("lifecycle: interrupt reports unsupported on EPERM and never signals a dead cached target", async () => {
	const epermTarget = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	const epermIdentity = await captureProcessIdentity(epermTarget.pid);
	const epermRunId = "run_interrupt_eperm_target";
	const epermAttemptId = "attempt_interrupt_eperm_target";
	await beginRunRecord({
		cwd,
		runId: epermRunId,
		mode: "single",
		backend: "fixture",
		activeAttemptId: epermAttemptId,
		attempts: [
			{
				attemptId: epermAttemptId,
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				process: {
					pid: epermIdentity.pid,
					processGroupId: epermIdentity.processGroupId,
					processBirthIdentity: epermIdentity.birthIdentity,
				},
			},
		],
	});
	const realKill = process.kill;
	process.kill = function epermKill(pid, signal) {
		if (
			typeof pid === "number" &&
			(pid === epermIdentity.pid || pid === -epermIdentity.processGroupId) &&
			signal !== 0 &&
			signal !== undefined
		)
			throw Object.assign(new Error("kill EPERM"), {
				code: "EPERM",
				errno: -1,
				syscall: "kill",
			});
		return realKill.call(process, pid, signal);
	};
	let epermInterrupt;
	try {
		epermInterrupt = await interruptSubagent({
			cwd,
			runId: epermRunId,
			reason: "eperm",
		});
	} finally {
		process.kill = realKill;
	}
	assert.equal(
		epermInterrupt.status,
		"unsupported",
		JSON.stringify(epermInterrupt),
	);
	assert.deepEqual(epermInterrupt.unsupportedAttempts, [epermAttemptId]);
	assert.equal(pidAlive(epermTarget.pid), true);
	realKill.call(process, epermTarget.pid, "SIGKILL");

	const shortTarget = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	const shortIdentity = await captureProcessIdentity(shortTarget.pid);
	const shortRunId = "run_interrupt_short_target";
	const shortAttemptId = "attempt_interrupt_short_target";
	await beginRunRecord({
		cwd,
		runId: shortRunId,
		mode: "single",
		backend: "fixture",
		activeAttemptId: shortAttemptId,
		attempts: [
			{
				attemptId: shortAttemptId,
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				process: {
					pid: shortIdentity.pid,
					processGroupId: shortIdentity.processGroupId,
					processBirthIdentity: shortIdentity.birthIdentity,
				},
			},
		],
	});
	const postExitSignals = [];
	try {
		const interrupted = await interruptSubagent({
			cwd,
			runId: shortRunId,
			attemptId: shortAttemptId,
			reason: "short target escalation revalidation",
		});
		assert.equal(interrupted.status, "interrupt-requested");
		process.kill = function trackedProcessKill(pid, signal) {
			if (
				pid === -shortIdentity.processGroupId &&
				(signal === "SIGTERM" || signal === "SIGKILL")
			)
				postExitSignals.push(signal);
			return realKill.call(process, pid, signal);
		};
		for (let index = 0; index < 100 && pidAlive(shortTarget.pid); index += 1)
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
		assert.equal(pidAlive(shortTarget.pid), false);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 3_200));
		assert.deepEqual(
			postExitSignals,
			[],
			"escalation must not signal a cached target after its identity is dead",
		);
	} finally {
		process.kill = realKill;
		if (pidAlive(shortTarget.pid)) {
			try {
				realKill(-shortTarget.pid, "SIGKILL");
			} catch {
				// already exited
			}
		}
	}
});
