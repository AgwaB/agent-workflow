// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/orchestrate/async.ts. MIT, same author. Changes: inline-runner hooks (hostPiPackageRoot / PI_PACKAGE_ROOT_ENV) removed; backend resolution replaced by the run's ExecutorDescriptor (per-task override allowed, validated before any spawn); the payload carries the descriptor and the input with an explicit attemptKey; the worker is dist/runtime/workers/durable-worker.js; both binding env names (AGENT_WORKFLOW_ and legacy PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON) are stripped from the worker env. WP2c: env / mcpServers[].env values are not written to worker.json (only their keys); they reach the worker through its spawn environment (orchestrate/env-values.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExecutorDescriptor } from "../../sdk/descriptor.js";
import {
	appendRunEvent,
	beginRunRecord,
	createAttemptArtifactStore,
	createAttemptId,
	createRunId,
	upsertRunAttempt,
	updateAttemptWorkerProcess,
	type ResultEnvelope,
} from "../artifacts/index.js";
import type { ExecutionMode } from "../core/constants.js";
import { writeDurableWorkerPayload } from "../durable-worker-payload.js";
import { captureProcessIdentity } from "../process-identity.js";
import { DURABLE_WORKER_BINDING_ENV } from "../workers/durable-worker-binding.js";
import { defaultAttemptKey, type RuntimeRunInput } from "./request.js";
import {
	MAX_PARALLEL_TASKS,
	mergeTaskInput,
	SubagentToolAuthorityError,
	type ParallelRunResult,
} from "./run.js";
import { executionMode, parallelConcurrency } from "./run-options.js";
import { writeRunLocator } from "./run-ref.js";
import { readRunResult, waitForRun } from "./status.js";
import { DURABLE_WORKER_REQUEST_ENV, splitEnvValues } from "./env-values.js";

export interface StartAsyncSubagentRunOptions {
	input: RuntimeRunInput;
	cwd: string;
	signal?: AbortSignal;
	runId?: string;
	attemptId?: string;
	onComplete?: (
		result: ResultEnvelope,
		mode: ExecutionMode,
	) => number | Promise<number>;
}

function sandboxEnabled(input: RuntimeRunInput): boolean {
	return Boolean(input.sandbox);
}

function armCompletionMonitor(
	options: StartAsyncSubagentRunOptions & {
		runId: string;
		attemptId: string;
		mode: ExecutionMode;
		store: Awaited<ReturnType<typeof createAttemptArtifactStore>>;
	},
): void {
	if (options.onComplete === undefined || options.input.onComplete !== "notify")
		return;
	void (async () => {
		const waited = await waitForRun({
			cwd: options.cwd,
			runsDir: options.input.runsDir,
			runId: options.runId,
			attemptId: options.attemptId,
			// Observation includes worker startup and terminal artifact/cleanup writes.
			// Keep the existing one-day observer allowance separate from execution.
			timeoutMs: (options.input.timeoutMs ?? 0) + 86_400_000,
			pollIntervalMs: 500,
		});
		if (waited.status !== "completed") return;
		const result = await readRunResult({
			cwd: options.cwd,
			runsDir: options.input.runsDir,
			runId: options.runId,
			attemptId: options.attemptId,
		});
		if (result === null) return;
		const updatesSent = await options.onComplete!(result, options.mode);
		await options.store.writeResult({
			...result,
			completion: {
				onComplete: options.input.onComplete ?? null,
				notified: true,
				updatesSent,
			},
		});
	})().catch(() => undefined);
}

/** Compiled durable worker script (`dist/runtime/workers/durable-worker.js`). */
export function durableWorkerPath(): string {
	return fileURLToPath(
		new URL("../workers/durable-worker.js", import.meta.url),
	);
}

export async function startAsyncParallelSubagentRuns(
	input: RuntimeRunInput,
	cwd: string,
	signal?: AbortSignal,
	onComplete?: StartAsyncSubagentRunOptions["onComplete"],
): Promise<ParallelRunResult> {
	if (!input.tasks || input.tasks.length === 0)
		throw new SubagentToolAuthorityError(
			"parallel mode requires a non-empty tasks array.",
		);
	if (input.tasks.length > MAX_PARALLEL_TASKS)
		throw new SubagentToolAuthorityError(
			`too many parallel tasks (${input.tasks.length}); max is ${MAX_PARALLEL_TASKS}.`,
		);
	for (const [index, task] of input.tasks.entries()) {
		if (task.task === undefined)
			throw new SubagentToolAuthorityError(
				`parallel tasks[${index}] requires a non-empty task.`,
			);
	}

	const taskPlans = input.tasks.map((task, index) => {
		const taskInput = {
			...mergeTaskInput(input, task),
			asyncDependency: input.asyncDependency,
		};
		const problems = validateExecutorDescriptor(taskInput.executor);
		if (problems.length > 0)
			throw new SubagentToolAuthorityError(
				`parallel tasks[${index}] executor is invalid: ${problems.join("; ")}`,
			);
		return { index, taskInput };
	});
	const concurrency = Math.min(parallelConcurrency(input), taskPlans.length);
	const results: ResultEnvelope[] = new Array(taskPlans.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			const plan = taskPlans[index];
			if (plan === undefined) return;
			results[plan.index] = await startAsyncSubagentRun({
				input: plan.taskInput,
				cwd: plan.taskInput.cwd ?? cwd,
				signal,
				onComplete,
			});
		}
	}

	const workers = await Promise.allSettled(
		Array.from({ length: concurrency }, () => worker()),
	);
	const rejected = workers.find(
		(workerResult): workerResult is PromiseRejectedResult =>
			workerResult.status === "rejected",
	);
	if (rejected !== undefined) {
		const startedResults = results.filter(
			(result): result is ResultEnvelope => result !== undefined,
		);
		if (
			startedResults.length > 0 &&
			rejected.reason &&
			typeof rejected.reason === "object"
		) {
			Object.assign(rejected.reason, {
				startedRunIds: startedResults.map((result) => result.runId),
				startedResults,
			});
		}
		throw rejected.reason;
	}
	const completedResults = results.filter(
		(result): result is ResultEnvelope => result !== undefined,
	);
	return {
		mode: "parallel",
		runIds: completedResults.map((result) => result.runId),
		results: completedResults,
		concurrency,
		totalTasks: input.tasks.length,
		startedCount: completedResults.length,
		skippedCount: 0,
		failFastTriggered: false,
	};
}

export async function startAsyncSubagentRun(
	options: StartAsyncSubagentRunOptions,
): Promise<ResultEnvelope> {
	const input = options.input;
	const backend = input.executor.id;
	const startedAt = new Date();
	const runId = options.runId ?? createRunId(startedAt);
	const attemptId = options.attemptId ?? createAttemptId(startedAt);
	const mode = executionMode(input);
	if (mode === "parallel") {
		throw new SubagentToolAuthorityError(
			"startAsyncSubagentRun handles one run; use startAsyncParallelSubagentRuns for parallel inputs.",
		);
	}
	const dependency = input.asyncDependency ?? "unclassified";
	const store = await createAttemptArtifactStore({
		cwd: options.cwd,
		runId,
		attemptId,
		runsDir: input.runsDir,
	});
	const payloadPath = store.pathFor("worker");
	const { executor, ...payloadInput } = input;
	// D1: env values never reach disk; worker.json keeps the keys, the worker gets the values
	// through its spawn environment.
	const { persisted: persistedInput, channel: envChannel } = splitEnvValues(
		payloadInput as Record<string, unknown>,
	);
	const payload = await writeDurableWorkerPayload({
		payloadPath,
		input: {
			...persistedInput,
			attemptKey: input.attemptKey ?? defaultAttemptKey(runId, attemptId),
		},
		cwd: options.cwd,
		backend,
		executor,
		runId,
		attemptId,
		startedAt: startedAt.toISOString(),
	});
	const workerRef = store.refFor("worker", payload.bytes);

	const running = await store.writeResult({
		backend,
		status: "running",
		failureKind: null,
		cwd: options.cwd,
		startedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd: options.cwd },
		sandbox: { enabled: sandboxEnabled(input) },
		exitCode: null,
		signal: null,
		artifacts: [workerRef],
		correlationId: input.correlationId,
		metadata: { contextLengthExceeded: false },
	});

	await upsertRunAttempt({
		cwd: options.cwd,
		runsDir: input.runsDir,
		runId,
		attemptId,
		status: "running",
		backend,
		startedAt,
		artifactCwd: options.cwd,
		resultPath: running.artifacts.find((artifact) => artifact.type === "result")
			?.path,
		createOnly: true,
		requireNoActive: true,
		activate: true,
	});
	await beginRunRecord({
		cwd: options.cwd,
		runsDir: input.runsDir,
		runId,
		mode,
		backend,
		startedAt,
		dependency,
		correlationId: input.correlationId,
		parentSessionId: input.parentSessionId,
		activeAttemptId: attemptId,
		attempts: [],
	});
	await writeRunLocator({
		cwd: options.cwd,
		runsDir: input.runsDir,
		runId,
		parentSessionId: input.parentSessionId,
		correlationId: input.correlationId,
	}).catch(() => undefined);
	await appendRunEvent(
		{ cwd: options.cwd, runsDir: input.runsDir, runId },
		{
			type: "run.started",
			status: "running",
			message: `${mode} durable async run started`,
			data: { dependency, attemptId },
		},
	);

	const workerLogFd = openSync(join(store.attemptDir, "worker.log"), "a");
	const workerEnv = { ...process.env };
	delete workerEnv[DURABLE_WORKER_BINDING_ENV];
	delete workerEnv[DURABLE_WORKER_REQUEST_ENV];
	if (envChannel !== undefined)
		workerEnv[DURABLE_WORKER_REQUEST_ENV] = JSON.stringify(envChannel);
	let child;
	try {
		child = spawn(
			process.execPath,
			[
				durableWorkerPath(),
				payloadPath,
				`ownership-${randomBytes(16).toString("hex")}`,
			],
			{
				cwd: options.cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", workerLogFd, workerLogFd],
				env: workerEnv,
			},
		);
	} finally {
		closeSync(workerLogFd);
	}
	if (child.pid !== undefined) {
		try {
			const identity = await captureProcessIdentity(child.pid);
			const processMetadata = {
				command: process.execPath,
				workerPid: identity.pid,
				workerProcessGroupId: identity.processGroupId,
				workerProcessBirthIdentity: identity.birthIdentity,
			};
			const updated = await updateAttemptWorkerProcess({
				cwd: options.cwd,
				runsDir: input.runsDir,
				runId,
				attemptId,
				process: processMetadata,
			});
			const persisted = updated.attempts.find(
				(attempt) => attempt.attemptId === attemptId,
			);
			if (
				updated.activeAttemptId !== attemptId ||
				persisted?.process?.workerPid !== identity.pid ||
				persisted.process.workerProcessGroupId !== identity.processGroupId ||
				persisted.process.workerProcessBirthIdentity !== identity.birthIdentity
			)
				throw new Error(
					"durable worker ownership metadata was not committed to the active attempt",
				);
		} catch (error) {
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already exited */
			}
			await new Promise<void>((resolveClose) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolveClose();
					return;
				}
				child.once("close", () => resolveClose());
			});
			throw error;
		}
	}
	child.unref();

	armCompletionMonitor({ ...options, runId, attemptId, mode, store });
	return running;
}
