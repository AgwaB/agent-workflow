#!/usr/bin/env node
// Load the recorded executor and fail closed on a missing module or identity/version mismatch.
// Launch authority enforces READY, decision, ACK, binding, abort checks, and execution authorization.
// Missing or mismatched environment-value channels fail closed before effects.
// Before release, failure or revoke discards the pristine workspace, writes output.log,
// closes the control mailbox, writes the terminal result, then starts ownership finalization.
// Install signal handlers before loading runtime modules; allow at most one heartbeat in flight.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowExecutor } from "../../sdk/contract.js";
import type { ResultEnvelope, RunRecord } from "../artifacts/index.js";
import type { FailureKind, Status } from "../core/constants.js";
import type { DurableWorkerPayload } from "../durable-worker-payload.js";
import { takeEnvChannel } from "../orchestrate/env-values.js";
import type { RuntimeRunInput } from "../orchestrate/request.js";
import type { PreparedSubagentExecution } from "../orchestrate/run.js";
import type { ProcessIdentity } from "../process-identity.js";
import type { DurableWorkerBindingPayload } from "./durable-worker-binding.js";

// D1 (WP2c): take the env values off process.env before anything else runs, so no child, log or
// diagnostic inherits them; they are merged into the request after the payload is verified.
const envChannel = takeEnvChannel(process.env);

// Primitive signal handling before the runtime modules load: a stop that lands while the runtime
// is still starting is remembered and replayed once the real cancellation path exists, instead of
// killing the worker before it can record anything. WP2b: the runtime modules are imported
// dynamically below, after these handlers. The WP2a-2 port had turned them into static imports,
// which ESM evaluates before the first statement, so a SIGTERM during module loading (slow under
// load) killed the worker by default and left the attempt `running` with no terminal result.
let earlySignal: NodeJS.Signals | undefined;
const rememberEarlySignal = (signal: NodeJS.Signals) => {
	earlySignal ??= signal;
};
process.on("SIGINT", () => rememberEarlySignal("SIGINT"));
process.on("SIGTERM", () => rememberEarlySignal("SIGTERM"));

const payloadPath = process.argv[2];
if (!payloadPath) {
	console.error("durable worker missing payload path");
	process.exit(2);
}

const [
	{ loadExecutor },
	{ ActivityHeartbeat },
	{ isSdkError },
	{
		createAttemptArtifactStore,
		readRunRecord,
		recordAttemptHeartbeat,
		refreshTerminalAttemptResultIfCurrent,
		updateAttemptWorkerProcess,
	},
	{ DEFAULT_RUNS_DIR, isFailureKind, isResolvedBackend },
	{ createDurableLaunchAuthority },
	{ isDurableLaunchBarrierError, isDurableLaunchBarrierRevokedError },
	payloadModule,
	{ closeControlMailbox },
	{ restoreEnvValues },
	{ isExecutionNotStartedError },
	{
		discardPreparedExecutionWorkspace,
		prepareSubagentExecution,
		runPreparedSubagentExecution,
	},
	{ UNKNOWN_BACKEND },
	{ captureProcessIdentity },
	{
		executionInputAfterDurableLaunch,
		isDurableWorkerGuardError,
		prepareDurableWorkerBinding,
	},
] = await Promise.all([
	import("../../sdk/descriptor.js"),
	import("../telemetry/task-activity.js"),
	import("../../sdk/errors.js"),
	import("../artifacts/index.js"),
	import("../core/constants.js"),
	import("../durable-authority.js"),
	import("../durable-launch-barrier.js"),
	import("../durable-worker-payload.js"),
	import("../orchestrate/control.js"),
	import("../orchestrate/env-values.js"),
	import("../orchestrate/execute.js"),
	import("../orchestrate/run.js"),
	import("../orchestrate/status.js"),
	import("../process-identity.js"),
	import("./durable-worker-binding.js"),
]);

// Assertion functions need an explicitly typed binding.
const assertDurableWorkerPayloadShape: typeof payloadModule.assertDurableWorkerPayloadShape =
	payloadModule.assertDurableWorkerPayloadShape;
const { resolveDurableWorkerPayload } = payloadModule;

const executionAbort = new AbortController();

function requestCancel(signal: NodeJS.Signals): void {
	executionAbort.abort(
		Object.assign(new Error(`durable worker received ${signal}`), {
			failureKind: "user_cancelled" as const,
		}),
	);
	process.exitCode = 130;
}

// Keep handling repeated signals: escalation re-sends SIGTERM, and a `once`
// handler would let the second delivery kill the worker before it records a
// terminal result. A signal remembered during startup is replayed now.
process.on("SIGINT", () => requestCancel("SIGINT"));
process.on("SIGTERM", () => requestCancel("SIGTERM"));
if (earlySignal !== undefined) requestCancel(earlySignal);

interface LocatedPayload {
	cwd: string;
	runId: string;
	attemptId: string;
	runsDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The payload lives at `<runsDir>/<runId>/attempts/<attemptId>/worker.json`
 * and the worker is spawned with the run's cwd, so the run/attempt reference
 * can be recovered from the path alone when the payload itself is unreadable.
 * Returns undefined when the path does not have that shape.
 */
async function referenceFromPayloadPath(
	path: string,
): Promise<LocatedPayload | undefined> {
	const attemptDir = dirname(path);
	const attemptsDir = dirname(attemptDir);
	const runDir = dirname(attemptsDir);
	const runsDir = dirname(runDir);
	if (basename(attemptsDir) !== "attempts") return undefined;
	const runId = basename(runDir);
	const attemptId = basename(attemptDir);
	const safe = /^[A-Za-z0-9._-]+$/u;
	if (!safe.test(runId) || !safe.test(attemptId)) return undefined;
	// The registry stores the logical cwd (it may be a symlinked spelling of
	// process.cwd()); use it so the terminal commit matches the record.
	let record: unknown;
	try {
		record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
	} catch {
		record = undefined;
	}
	const recordFields = isRecord(record) ? record : {};
	const cwd =
		typeof recordFields.cwd === "string" && recordFields.cwd.length > 0
			? recordFields.cwd
			: process.cwd();
	const runsDirRelative =
		typeof recordFields.runsDir === "string" && recordFields.runsDir.length > 0
			? recordFields.runsDir
			: relative(cwd, runsDir);
	if (runsDirRelative.startsWith("..") || isAbsolute(runsDirRelative))
		return undefined;
	return { cwd, runId, attemptId, runsDir: runsDirRelative };
}

const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);

function spawnTerminalFinalizer(options: {
	ref: { cwd: string; runId: string; runsDir?: string };
	attemptId: string;
	status: Status;
	worker: ProcessIdentity;
	cwd: string;
}): void {
	const finalizerPath = fileURLToPath(
		new URL("./terminal-finalizer.js", import.meta.url),
	);
	const finalizerPayload = Buffer.from(
		JSON.stringify({
			ref: options.ref,
			attemptId: options.attemptId,
			status: options.status,
			worker: options.worker,
		}),
	).toString("base64url");
	const finalizer = spawn(process.execPath, [finalizerPath, finalizerPayload], {
		cwd: options.cwd,
		detached: true,
		stdio: "ignore",
		env: {
			PATH: "/usr/bin:/bin",
			LC_ALL: "C",
			LANG: "C",
		},
	});
	finalizer.unref();
}

/**
 * The launcher has already recorded the attempt as running. If the payload
 * cannot be resolved (missing, truncated, or tampered prompt sidecar, or a
 * malformed reference) the attempt must still end in a terminal state, so
 * write a guard failure from the plain fields of the raw payload and hand the
 * commit to the finalizer exactly like a normal failure.
 */
async function failUnresolvedPayload(
	raw: unknown,
	error: unknown,
): Promise<never> {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	// Prefer the payload's own plain fields; fall back to the reference encoded
	// in the payload path when the payload is unreadable or malformed.
	// The path-derived reference wins whenever it exists: it is where the
	// launcher put this payload. Raw fields are used only when they are safe
	// and the path gives no answer.
	const fromPath = await referenceFromPayloadPath(payloadPath as string);
	const rawFields = isRecord(raw) ? raw : {};
	const rawInput = isRecord(rawFields.input) ? rawFields.input : {};
	const safeId = /^[A-Za-z0-9._-]+$/u;
	const rawId = (value: unknown) =>
		typeof value === "string" && safeId.test(value) ? value : undefined;
	const cwd =
		fromPath?.cwd ??
		(typeof rawFields.cwd === "string" && rawFields.cwd.length > 0
			? rawFields.cwd
			: undefined);
	const runId = fromPath?.runId ?? rawId(rawFields.runId);
	const attemptId = fromPath?.attemptId ?? rawId(rawFields.attemptId);
	if (cwd === undefined || runId === undefined || attemptId === undefined) {
		process.exit(1);
	}
	const runsDir =
		fromPath?.runsDir ??
		(typeof rawInput.runsDir === "string" && rawInput.runsDir.length > 0
			? rawInput.runsDir
			: undefined);
	// Never replace the canonical artifacts of an attempt that is no longer
	// current (already terminal, superseded, or cancelled before this worker
	// started): the registry is authoritative and a later finalizer would only
	// find contradictory state.
	const record: RunRecord | null = await readRunRecord({
		cwd,
		runId,
		runsDir,
	}).catch(() => null);
	const attempt = record?.attempts?.find(
		(candidate) => candidate.attemptId === attemptId,
	);
	if (
		attempt !== undefined &&
		(TERMINAL_STATUSES.has(attempt.status) ||
			record?.activeAttemptId !== attemptId)
	) {
		console.error(
			`durable worker attempt ${attemptId} is no longer active (${attempt.status}); exiting without writing artifacts`,
		);
		process.exit(1);
	}
	try {
		const worker = await captureProcessIdentity(process.pid);
		const store = await createAttemptArtifactStore({
			cwd,
			runId,
			attemptId,
			runsDir,
		});
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		// WP2b terminal-last-write: every attempt artifact exists (and every control request is
		// acked) before result.json turns terminal.
		const output = await store.ensureTextArtifact("output");
		await closeControlMailbox(store.attemptDir).catch(() => undefined);
		const status = executionAbort.signal.aborted ? "cancelled" : "failed";
		const backend = isResolvedBackend(rawFields.backend)
			? rawFields.backend
			: UNKNOWN_BACKEND;
		const startedAt =
			typeof rawFields.startedAt === "string" &&
			Number.isFinite(Date.parse(rawFields.startedAt))
				? rawFields.startedAt
				: new Date().toISOString();
		await store.writeResult({
			backend,
			status,
			failureKind: executionAbort.signal.aborted
				? "user_cancelled"
				: "guard_failure",
			cwd,
			startedAt,
			completedAt: new Date().toISOString(),
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: Boolean(rawInput.sandbox) },
			exitCode: null,
			signal: null,
			artifacts: [store.refFor("worker"), stderr, output],
			correlationId:
				typeof rawInput.correlationId === "string"
					? rawInput.correlationId
					: undefined,
			metadata: { contextLengthExceeded: false },
		});
		spawnTerminalFinalizer({
			ref: { cwd, runId, runsDir },
			attemptId,
			status,
			worker,
			cwd,
		});
	} catch (writeError) {
		console.error(
			writeError instanceof Error
				? (writeError.stack ?? writeError.message)
				: String(writeError),
		);
	}
	process.exit(1);
}

let payloadBytes: Buffer;
try {
	payloadBytes = await readFile(payloadPath);
} catch (error) {
	await failUnresolvedPayload(
		undefined,
		new Error(
			`durable worker payload could not be read: ${error instanceof Error ? error.message : String(error)}`,
		),
	);
}
// The launch digest covers the payload file exactly as written. Prompt
// sidecars are bound through the size/SHA-256 references inside it and are
// verified before use, so resolving them here does not weaken the digest.
const launchPayloadSha256 = createHash("sha256")
	.update(payloadBytes!)
	.digest("hex");
let rawPayload: unknown;
try {
	rawPayload = JSON.parse(payloadBytes!.toString("utf8"));
} catch (error) {
	await failUnresolvedPayload(
		undefined,
		new Error(
			`durable worker payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		),
	);
}
let payload: DurableWorkerPayload & { input: Record<string, unknown> };
try {
	assertDurableWorkerPayloadShape(rawPayload);
	if (rawPayload.executor === undefined)
		throw new Error(
			"durable worker payload has no executor descriptor; the runtime does not substitute one",
		);
	payload = (await resolveDurableWorkerPayload(
		rawPayload,
		payloadPath,
	)) as DurableWorkerPayload & { input: Record<string, unknown> };
	payload = {
		...payload,
		input: restoreEnvValues(payload.input, envChannel),
	};
	// The payload must describe exactly the attempt directory it was read
	// from: ids, cwd, and the effective runs directory all bind to the path,
	// so a tampered envelope cannot redirect bookkeeping elsewhere.
	const located = await referenceFromPayloadPath(payloadPath);
	if (located === undefined)
		throw new Error(
			`durable worker payload location ${payloadPath} is not an attempt directory`,
		);
	if (
		located.runId !== payload.runId ||
		located.attemptId !== payload.attemptId
	)
		throw new Error(
			`durable worker payload ids (${payload.runId}/${payload.attemptId}) do not match the payload location ${payloadPath}`,
		);
	const physical = async (path: string) => {
		try {
			return await realpath(path);
		} catch {
			return resolve(path);
		}
	};
	const payloadCwd = await physical(payload.cwd);
	const locatedCwd = await physical(located.cwd);
	if (payloadCwd !== locatedCwd)
		throw new Error(
			`durable worker payload cwd (${payloadCwd}) does not match the run's cwd (${locatedCwd})`,
		);
	const payloadRunsDir = await physical(
		resolve(
			payload.cwd,
			typeof payload.input.runsDir === "string"
				? payload.input.runsDir
				: DEFAULT_RUNS_DIR,
		),
	);
	const locatedRunsDir = await physical(resolve(located.cwd, located.runsDir));
	if (payloadRunsDir !== locatedRunsDir)
		throw new Error(
			`durable worker payload runsDir (${payloadRunsDir}) does not match the payload location (${locatedRunsDir})`,
		);
} catch (error) {
	await failUnresolvedPayload(rawPayload, error);
}
const { cwd, runId, attemptId } = payload!;
// SAFETY: the launcher validated this input (validateRuntimeRunInput) before writing
// worker.json; the shape check above covers the envelope, and with a barrier the exact bytes are
// bound by launchPayloadSha256 in READY.
const input = payload!.input as unknown as Omit<RuntimeRunInput, "executor">;
const executorDescriptor = payload!.executor!;
const heartbeatMs = Math.max(
	50,
	Number.parseInt(process.env.AGENT_WORKFLOW_HEARTBEAT_MS ?? "5000", 10) ||
		5000,
);
const runRef = { cwd, runId, runsDir: input?.runsDir };
const workerProcessGroupId =
	process.platform === "win32" ? undefined : process.pid;
let terminalWritePromise: Promise<ResultEnvelope | undefined> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let preparedExecution: PreparedSubagentExecution | undefined;
let terminalResult: ResultEnvelope | undefined;

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function maybeDelayTerminalWriteForTests(): Promise<void> {
	const delayMs = Number.parseInt(
		process.env.AGENT_WORKFLOW_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS ?? "0",
		10,
	);
	if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
}

async function readExistingAttempt() {
	const record = await readRunRecord(runRef).catch(() => null);
	return record?.attempts?.find(
		(candidate) => candidate.attemptId === attemptId,
	);
}

async function writeTerminalResultOnce(options: {
	status: Status;
	failureKind: FailureKind;
	message: string;
	signal?: string | null;
	exitCode?: number | null;
}): Promise<ResultEnvelope | undefined> {
	const { status, failureKind, message } = options;
	if (heartbeat !== undefined) clearInterval(heartbeat);
	try {
		const existingAttempt = await readExistingAttempt();
		const existingAttemptTerminal = TERMINAL_STATUSES.has(
			existingAttempt?.status ?? "",
		);
		const shouldBackfillDuplicateResult =
			existingAttemptTerminal &&
			existingAttempt?.status === status &&
			(existingAttempt.failureKind ?? null) === failureKind;
		if (existingAttemptTerminal && !shouldBackfillDuplicateResult)
			return undefined;
		await maybeDelayTerminalWriteForTests();
		const store = await createAttemptArtifactStore({
			cwd,
			runId,
			attemptId,
			runsDir: input?.runsDir,
		});
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		// WP2b terminal-last-write: output.log exists (empty: nothing ran) and the control mailbox
		// is closed (every request acked) before the terminal result.
		const output = await store.ensureTextArtifact("output");
		await closeControlMailbox(store.attemptDir).catch(() => undefined);
		const worker = store.refFor("worker");
		const preparedWorkspace = preparedExecution?.workspaceResult;
		const retainedWorkspace =
			preparedWorkspace?.mode === "worktree"
				? {
						...preparedWorkspace,
						worktreeCleanupStatus:
							preparedExecution?.ownership?.cleanupStatus ?? "kept",
					}
				: (preparedWorkspace ?? { mode: "shared" as const, cwd });
		const result = await store.writeResult({
			backend: payload!.backend,
			status,
			failureKind,
			cwd,
			startedAt: payload!.startedAt ?? new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: retainedWorkspace,
			sandbox: { enabled: Boolean(input?.sandbox) },
			exitCode: options.exitCode ?? null,
			signal: options.signal ?? null,
			artifacts: [worker, stderr, output],
			correlationId: input?.correlationId,
			metadata: {
				contextLengthExceeded: false,
				executor: {
					id: executorDescriptor.id,
					version: executorDescriptor.version,
					...(preparedExecution === undefined
						? {}
						: { attemptKey: preparedExecution.request.attemptKey }),
				},
			},
		});
		if (shouldBackfillDuplicateResult) {
			await refreshTerminalAttemptResultIfCurrent(runRef, result).catch(
				() => undefined,
			);
			return undefined;
		}
		return result;
	} catch (writeError) {
		console.error(
			writeError instanceof Error
				? (writeError.stack ?? writeError.message)
				: String(writeError),
		);
		return undefined;
	}
}

function writeTerminalResult(
	options: Parameters<typeof writeTerminalResultOnce>[0],
): Promise<ResultEnvelope | undefined> {
	terminalWritePromise ??= writeTerminalResultOnce(options);
	return terminalWritePromise;
}

async function maybeDelayStartForTests(): Promise<void> {
	const delayMs = Number.parseInt(
		process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS ?? "0",
		10,
	);
	if (!Number.isFinite(delayMs) || delayMs <= 0) return;
	await Promise.race([
		sleep(delayMs),
		new Promise((resolveAbort) =>
			executionAbort.signal.addEventListener("abort", resolveAbort, {
				once: true,
			}),
		),
	]);
}

function failureKindFromError(error: unknown): FailureKind {
	const kind =
		typeof error === "object" && error !== null && "failureKind" in error
			? (error as { failureKind?: unknown }).failureKind
			: undefined;
	return isFailureKind(kind) ? kind : "internal";
}

function cancelledError(message: string): Error {
	return Object.assign(new Error(message), {
		failureKind: "user_cancelled" as const,
	});
}

const workerIdentity = await captureProcessIdentity(process.pid);
const workerProcessMetadata = {
	command: "agent-workflow durable-worker",
	workerPid: workerIdentity.pid,
	workerProcessGroupId: workerIdentity.processGroupId,
	workerProcessBirthIdentity: workerIdentity.birthIdentity,
};
// Ownership bookkeeping runs before the guarded execution block. The registry
// returns the record unchanged when this attempt is no longer active or is
// already terminal; that is lost ownership, and the worker must exit without
// touching the attempt's artifacts. Any other failure still ends the attempt
// through the terminal path.
try {
	const workerRecord = await updateAttemptWorkerProcess({
		...runRef,
		attemptId,
		process: workerProcessMetadata,
	});
	const persistedWorker = workerRecord.attempts.find(
		(candidate) => candidate.attemptId === attemptId,
	);
	if (
		workerRecord.activeAttemptId !== attemptId ||
		persistedWorker === undefined ||
		TERMINAL_STATUSES.has(persistedWorker.status)
	) {
		console.error(
			`durable worker attempt ${attemptId} is no longer active; exiting without writing artifacts`,
		);
		process.exit(1);
	}
	if (
		persistedWorker.process?.workerPid !== workerIdentity.pid ||
		persistedWorker.process.workerProcessGroupId !==
			workerIdentity.processGroupId ||
		persistedWorker.process.workerProcessBirthIdentity !==
			workerIdentity.birthIdentity
	)
		throw new Error(
			"durable worker ownership metadata was not committed to the active attempt",
		);
} catch (error) {
	await failUnresolvedPayload(rawPayload, error);
}
// WP2b: at most one heartbeat in flight. setInterval kept firing while a heartbeat waited for the
// run lock, so under load heartbeats piled up on the lock and starved the attempt's own registry
// mutations (prepare, running, terminal) until they failed ELOCKED.
let lastHeartbeatAt = Date.now();
const activityHeartbeat = new ActivityHeartbeat((activity) => {
	lastHeartbeatAt = Date.now();
	return recordAttemptHeartbeat({ ...runRef, attemptId, activity });
});
heartbeat = setInterval(
	() => {
		const now = Date.now();
		void activityHeartbeat.tick(now, now - lastHeartbeatAt >= heartbeatMs);
	},
	Math.min(heartbeatMs, 1000),
);
heartbeat.unref?.();
try {
	await maybeDelayStartForTests();
	if (executionAbort.signal.aborted)
		throw cancelledError("durable worker was cancelled before execution");
	// Rediscovery (R#15): the adapter object never crosses the process boundary.
	// A missing module, id mismatch or incompatible version is refused here,
	// before any barrier READY or effect, and never substituted.
	let executor: WorkflowExecutor;
	try {
		executor = await loadExecutor(executorDescriptor);
	} catch (error) {
		throw Object.assign(
			new Error(
				`executor ${executorDescriptor.id}@${executorDescriptor.version} could not be reloaded from ${executorDescriptor.module}: ${error instanceof Error ? error.message : String(error)}`,
			),
			{
				failureKind: "guard_failure" as const,
				code: isSdkError(error) ? error.code : undefined,
			},
		);
	}
	const barrier = input?.durableLaunchBarrier;
	const executionInput = barrier
		? executionInputAfterDurableLaunch(input)
		: { ...input, async: false, onComplete: undefined };
	preparedExecution = await prepareSubagentExecution({
		input: {
			...(executionInput as Omit<RuntimeRunInput, "executor">),
			executor: executorDescriptor,
		},
		cwd,
		runId,
		attemptId,
		resumeExistingAttempt: true,
		startedAt: payload!.startedAt,
	});
	const prepared = preparedExecution;
	// SAFETY: DurableWorkerBindingPayload is a structural subset (runId, attemptId, cwd, input)
	// of the payload validated above; the binding re-checks every field it reads.
	const bindingPayload = payload! as unknown as DurableWorkerBindingPayload;
	if (barrier)
		// Preflight before the barrier, as before: a malformed binding fails
		// with guard_failure while the workspace is still discardable.
		prepareDurableWorkerBinding({
			payload: bindingPayload,
			launchPayloadSha256,
			executionPlanSha256: prepared.executionPlanSha256,
			executionCwd: prepared.workspace.cwd,
		});
	terminalResult = await runPreparedSubagentExecution(prepared, {
		onActivity: (activity) => activityHeartbeat.update(activity),
		signal: executionAbort.signal,
		deferTerminalCommit: true,
		executor,
		createAuthority: (stopSignal) =>
			createDurableLaunchAuthority({
				attemptKey: prepared.request.attemptKey,
				runId,
				attemptId,
				attemptDir: prepared.attemptDir,
				payload: bindingPayload,
				launchPayloadSha256,
				executionPlanSha256: prepared.executionPlanSha256,
				executionCwd: prepared.workspace.cwd,
				workerProcessGroupId,
				signal: stopSignal,
			}),
	});
} catch (error) {
	if (
		typeof error === "object" &&
		error !== null &&
		(error as { terminalBlocked?: unknown }).terminalBlocked === true
	) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} else {
		// Before release, discard only the pristine workspace. Leave registry updates
		// to the terminal result and finalizer.
		if (preparedExecution?.ownership?.state === "prepared")
			await discardPreparedExecutionWorkspace(preparedExecution).catch(
				() => undefined,
			);
		const message = error instanceof Error ? error.message : String(error);
		const userCancelled = executionAbort.signal.aborted;
		const revoked = !userCancelled && isDurableLaunchBarrierRevokedError(error);
		const status: Status = isExecutionNotStartedError(error)
			? error.status
			: userCancelled || revoked
				? "cancelled"
				: "failed";
		const failureKind: FailureKind = isExecutionNotStartedError(error)
			? error.failureKind
			: userCancelled
				? "user_cancelled"
				: revoked
					? "revoked"
					: isDurableWorkerGuardError(error) ||
							isDurableLaunchBarrierError(error)
						? "guard_failure"
						: failureKindFromError(error);
		terminalResult = await writeTerminalResult({
			status,
			failureKind,
			message,
			exitCode: null,
		});
		process.exitCode = 1;
	}
} finally {
	if (heartbeat !== undefined) clearInterval(heartbeat);
	await activityHeartbeat.drain();
}
if (terminalResult !== undefined) {
	spawnTerminalFinalizer({
		ref: runRef,
		attemptId,
		status: terminalResult.status,
		worker: workerIdentity,
		cwd,
	});
}
// The executor may hold handles (timers, sockets) after its terminal event;
// the attempt is recorded, so the worker ends here.
process.exit(process.exitCode ?? 0);
