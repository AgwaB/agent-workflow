// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/orchestrate/reconcile.ts. MIT, same author. Changes: tmux ownership (terminatePrivateTmuxServer, launch identities) removed; when the owner process is gone and no terminal result exists, a non-interrupted attempt with a persisted executor descriptor is reconciled through executor.reconcile(attemptKey) — found (adopt when the executor is not sessionBound, else needs_decision), absent (failed/not_started), unknown (failed/needs_decision, B3) — instead of being marked stale; the runtime never relaunches. WP2b: every terminal result written here is preceded by output.log and the control mailbox close (terminal-last-write).
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
	appendRunEvent,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	readRunRecord,
	RESULT_SCHEMA_VERSION,
	type ResultEnvelope,
	type RunAttemptRecord,
	type RunRef,
	type RunRecord,
	runPaths,
} from "../artifacts/index.js";
import { resolveRunRef } from "./run-ref.js";
import {
	inspectProcessGroup,
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.js";
import { isTerminalStatus, UNKNOWN_BACKEND } from "./status.js";
import type { ExecRef } from "../../sdk/contract.js";
import { type ExecutorRegistry, loadExecutor } from "../../sdk/descriptor.js";
import type { ResultExecutorMetadata } from "../artifacts/result.js";
import {
	buildExecutionReport,
	observeAttempt,
	reconcileSafely,
} from "./execute.js";
import { closeControlMailbox } from "./control.js";
import { readAttemptExecutorRecord } from "./executor-record.js";

export interface ReconcileSubagentRunOptions extends RunRef {
	staleAfterMs?: number;
	/** In-process executor modules checked before importing a persisted descriptor's module. */
	registry?: ExecutorRegistry;
	/**
	 * How long reconcile observes an adopted ExecRef (executor `found`, not sessionBound) before
	 * leaving the attempt running for a later reconcile. 0 disables adoption (records
	 * needs_decision instead). Default 5000 ms.
	 */
	adoptTimeoutMs?: number;
	/** Refuse every mutation unless this is still the selected attempt. */
	expectedAttemptId?: string;
}

export interface ReconcileSubagentRunResult {
	status:
		| "not-found"
		| "already-terminal"
		| "running"
		| "superseded"
		| "cleanup-blocked"
		| "committed-result"
		| "marked-stale"
		| "marked-cancelled"
		/** WP2a-2: executor reconcile found the attempt and the runtime observed it to the end. */
		| "adopted-result"
		/** WP2a-2: executor reconcile proved the attempt never launched (failed/not_started). */
		| "marked-not-started"
		/** WP2a-2: executor reconcile could not decide; failed/needs_decision, ask a person (B3). */
		| "marked-needs-decision";
	runId: string;
	record: RunRecord | null;
	superseded?: {
		expectedAttemptId: string;
		currentAttemptId: string | null;
	};
	/** WP2a-2: what `executor.reconcile(attemptKey)` said for an orphaned attempt. */
	executorReconcile?: {
		outcome: "found" | "absent" | "unknown" | "error";
		reason?: string;
		ref?: ExecRef;
		adopted?: boolean;
	};
	cleanupBlocked?: {
		reason:
			| "terminal-record-active-attempt"
			| "terminal-attempt-ownership"
			| "missing-active-attempt"
			| "inactive-attempt-ownership"
			| "terminal-result-ownership"
			| "stale-attempt-ownership";
		attemptIds: string[];
	};
}

function cleanupBlockedResult(
	runId: string,
	record: RunRecord,
	reason: NonNullable<ReconcileSubagentRunResult["cleanupBlocked"]>["reason"],
	attemptIds: readonly string[],
): ReconcileSubagentRunResult {
	return {
		status: "cleanup-blocked",
		runId,
		record,
		cleanupBlocked: {
			reason,
			attemptIds: [...new Set(attemptIds)],
		},
	};
}

export async function cleanupInactiveAttemptOwnership(
	options: ReconcileSubagentRunOptions,
	activeAttemptId: string,
): Promise<boolean> {
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null || record.activeAttemptId !== activeAttemptId)
		return false;
	let safe = true;
	for (const attempt of record.attempts) {
		if (attempt.attemptId === activeAttemptId) continue;
		safe = (await terminateAttemptOwnership(attempt)) && safe;
	}
	const current = await readRunRecord(ref);
	return safe && current?.activeAttemptId === activeAttemptId;
}

function safeArtifactPath(attempt: RunAttemptRecord): string | null {
	if (attempt.resultPath === undefined || attempt.artifactCwd === undefined)
		return null;
	if (
		isAbsolute(attempt.resultPath) ||
		attempt.resultPath.split("/").includes("..")
	)
		return null;
	return resolve(attempt.artifactCwd, attempt.resultPath.split("/").join(sep));
}

async function readAttemptResult(
	attempt: RunAttemptRecord,
	runId: string,
): Promise<ResultEnvelope | null> {
	const path = safeArtifactPath(attempt);
	if (path === null) return null;
	try {
		const result = JSON.parse(
			await readFile(path, "utf8"),
		) as Partial<ResultEnvelope>;
		if (
			result.schemaVersion !== RESULT_SCHEMA_VERSION ||
			result.runId !== runId ||
			result.attemptId !== attempt.attemptId ||
			typeof result.cwd !== "string" ||
			typeof result.backend !== "string" ||
			typeof result.status !== "string" ||
			typeof result.startedAt !== "string"
		)
			return null;
		return result as ResultEnvelope;
	} catch {
		return null;
	}
}

function processErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

interface OwnedProcessIdentitySet {
	identities: ProcessIdentity[];
	incomplete: boolean;
}

function ownedProcessIdentities(
	attempt: RunAttemptRecord,
): OwnedProcessIdentitySet {
	const candidates = [
		{
			pid: attempt.process?.workerPid,
			processGroupId: attempt.process?.workerProcessGroupId,
			birthIdentity: attempt.process?.workerProcessBirthIdentity,
		},
		{
			pid: attempt.process?.pid,
			processGroupId: attempt.process?.processGroupId,
			birthIdentity: attempt.process?.processBirthIdentity,
		},
	];
	const identities = new Map<string, ProcessIdentity>();
	const identityKeysByPid = new Map<number, string>();
	let incomplete = false;
	for (const candidate of candidates) {
		const values = [
			candidate.pid,
			candidate.processGroupId,
			candidate.birthIdentity,
		];
		if (values.every((value) => value === undefined)) continue;
		if (
			typeof candidate.pid !== "number" ||
			!Number.isSafeInteger(candidate.pid) ||
			candidate.pid <= 0 ||
			typeof candidate.processGroupId !== "number" ||
			!Number.isSafeInteger(candidate.processGroupId) ||
			candidate.processGroupId <= 0 ||
			typeof candidate.birthIdentity !== "string" ||
			candidate.birthIdentity.length === 0
		) {
			incomplete = true;
			continue;
		}
		const key = `${candidate.pid}:${candidate.processGroupId}:${candidate.birthIdentity}`;
		const priorKey = identityKeysByPid.get(candidate.pid);
		if (priorKey !== undefined && priorKey !== key) incomplete = true;
		identityKeysByPid.set(candidate.pid, key);
		identities.set(key, {
			pid: candidate.pid,
			processGroupId: candidate.processGroupId,
			birthIdentity: candidate.birthIdentity,
		});
	}
	return { identities: [...identities.values()], incomplete };
}

function signalOwnedProcess(
	identity: ProcessIdentity,
	signal: NodeJS.Signals,
): void {
	const target =
		process.platform === "win32" || identity.pid !== identity.processGroupId
			? identity.pid
			: -identity.processGroupId;
	try {
		process.kill(target, signal);
	} catch (error) {
		// ESRCH: already gone. EPERM (macOS, zombie-only group): not proof the
		// process survived; the liveness checks that follow decide whether
		// cleanup is drained or blocked.
		const code = processErrorCode(error);
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

async function ownerProcessAlive(attempt: RunAttemptRecord): Promise<boolean> {
	const { identities } = ownedProcessIdentities(attempt);
	const ownerPid = attempt.process?.workerPid ?? attempt.process?.pid;
	const owner = identities.find((identity) => identity.pid === ownerPid);
	return (
		owner !== undefined && (await verifyProcessIdentity(owner)) === "alive"
	);
}

async function terminateOwnedProcesses(
	attempt: RunAttemptRecord,
): Promise<boolean> {
	const identitySet = ownedProcessIdentities(attempt);
	const { identities } = identitySet;
	if (identities.length === 0) return !identitySet.incomplete;
	const verifiedIdentities = identities;
	const authorizedGroups = new Set<number>();
	const recordedLeaderGroups = new Set(
		verifiedIdentities
			.filter((identity) => identity.pid === identity.processGroupId)
			.map((identity) => identity.processGroupId),
	);

	async function inspectIdentities(): Promise<{
		alive: ProcessIdentity[];
		unsafe: boolean;
	}> {
		const alive: ProcessIdentity[] = [];
		let unsafe = false;
		for (const identity of verifiedIdentities) {
			const status = await verifyProcessIdentity(identity);
			if (status === "mismatch" || status === "unknown") unsafe = true;
			if (status === "alive") {
				alive.push(identity);
				if (
					process.platform !== "win32" &&
					identity.pid === identity.processGroupId
				)
					authorizedGroups.add(identity.processGroupId);
			}
		}
		return { alive, unsafe };
	}

	function groupsDrained(): boolean | undefined {
		let unknown = false;
		for (const processGroupId of recordedLeaderGroups) {
			const status = inspectProcessGroup(processGroupId);
			if (status === "alive") return false;
			if (status === "unknown") unknown = true;
		}
		return unknown ? undefined : true;
	}

	function signalAuthorizedGroups(signal: NodeJS.Signals): void {
		for (const processGroupId of authorizedGroups) {
			try {
				process.kill(-processGroupId, signal);
			} catch (error) {
				// EPERM (macOS, zombie-only group) is not proof the group survived;
				// the liveness loop that follows decides whether cleanup is blocked.
				const code = processErrorCode(error);
				if (code !== "ESRCH" && code !== "EPERM") throw error;
			}
		}
	}

	let unsafe = identitySet.incomplete;
	const initiallyInspected = await inspectIdentities();
	unsafe ||= initiallyInspected.unsafe;
	for (const identity of initiallyInspected.alive)
		signalOwnedProcess(identity, "SIGTERM");
	for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
		const inspected = await inspectIdentities();
		unsafe ||= inspected.unsafe;
		const drained = groupsDrained();
		if (inspected.alive.length === 0 && drained === true) return !unsafe;
		if (drained === undefined) unsafe = true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	const beforeKill = await inspectIdentities();
	unsafe ||= beforeKill.unsafe;
	for (const identity of beforeKill.alive)
		signalOwnedProcess(identity, "SIGKILL");
	signalAuthorizedGroups("SIGKILL");
	for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
		const inspected = await inspectIdentities();
		unsafe ||= inspected.unsafe;
		const drained = groupsDrained();
		if (inspected.alive.length === 0 && drained === true) return !unsafe;
		if (drained === undefined) unsafe = true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	const remaining = await inspectIdentities();
	return (
		remaining.alive.length === 0 &&
		groupsDrained() === true &&
		!unsafe &&
		!remaining.unsafe
	);
}

function heartbeatFresh(
	attempt: RunAttemptRecord,
	staleAfterMs: number,
): boolean {
	if (attempt.heartbeatAt === undefined) return false;
	const time = Date.parse(attempt.heartbeatAt);
	return Number.isFinite(time) && Date.now() - time <= staleAfterMs;
}

async function terminateAttemptOwnership(
	attempt: RunAttemptRecord,
): Promise<boolean> {
	return await terminateOwnedProcesses(attempt);
}

function activeAttempt(record: RunRecord): RunAttemptRecord | undefined {
	if (record.activeAttemptId !== null)
		return record.attempts.find(
			(attempt) => attempt.attemptId === record.activeAttemptId,
		);
	if (record.latestAttemptId !== null)
		return record.attempts.find(
			(attempt) => attempt.attemptId === record.latestAttemptId,
		);
	return record.attempts.at(-1);
}

export async function reconcileSubagentRun(
	options: ReconcileSubagentRunOptions,
): Promise<ReconcileSubagentRunResult> {
	const staleAfterMs = options.staleAfterMs ?? 30_000;
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null)
		return { status: "not-found", runId: options.runId, record: null };
	if (options.expectedAttemptId !== undefined) {
		const currentAttemptId = record.activeAttemptId ?? record.latestAttemptId;
		if (currentAttemptId !== options.expectedAttemptId)
			return {
				status: "superseded",
				runId: options.runId,
				record,
				superseded: {
					expectedAttemptId: options.expectedAttemptId,
					currentAttemptId,
				},
			};
	}
	if (isTerminalStatus(record.status)) {
		if (record.activeAttemptId !== null) {
			const inconsistentActiveAttempt = record.attempts.find(
				(attempt) => attempt.attemptId === record.activeAttemptId,
			);
			const ownerPid =
				inconsistentActiveAttempt?.process?.workerPid ??
				inconsistentActiveAttempt?.process?.pid;
			if (
				inconsistentActiveAttempt !== undefined &&
				((await ownerProcessAlive(inconsistentActiveAttempt)) ||
					(ownerPid === undefined &&
						heartbeatFresh(inconsistentActiveAttempt, staleAfterMs)))
			)
				return { status: "running", runId: options.runId, record };
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-record-active-attempt",
				[record.activeAttemptId],
			);
		}
		let terminalSafe = true;
		const blockedAttemptIds: string[] = [];
		for (const terminalAttempt of record.attempts)
			if (!(await terminateAttemptOwnership(terminalAttempt))) {
				terminalSafe = false;
				blockedAttemptIds.push(terminalAttempt.attemptId);
			}
		if (!terminalSafe)
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-attempt-ownership",
				blockedAttemptIds,
			);
		return { status: "already-terminal", runId: options.runId, record };
	}

	const attempt = activeAttempt(record);
	if (attempt === undefined)
		return cleanupBlockedResult(
			options.runId,
			record,
			"missing-active-attempt",
			record.activeAttemptId !== null
				? [record.activeAttemptId]
				: record.latestAttemptId !== null
					? [record.latestAttemptId]
					: [],
		);
	let inactiveSafe = true;
	const blockedInactiveAttemptIds: string[] = [];
	for (const inactiveAttempt of record.attempts) {
		if (inactiveAttempt.attemptId === attempt.attemptId) continue;
		if (!(await terminateAttemptOwnership(inactiveAttempt))) {
			inactiveSafe = false;
			blockedInactiveAttemptIds.push(inactiveAttempt.attemptId);
		}
	}
	if (!inactiveSafe)
		return cleanupBlockedResult(
			options.runId,
			record,
			"inactive-attempt-ownership",
			blockedInactiveAttemptIds,
		);

	const result = await readAttemptResult(attempt, options.runId);
	if (
		result !== null &&
		result.attemptId === attempt.attemptId &&
		isTerminalStatus(result.status)
	) {
		if (await ownerProcessAlive(attempt))
			return { status: "running", runId: options.runId, record };
		if (!(await terminateAttemptOwnership(attempt)))
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-result-ownership",
				[attempt.attemptId],
			);
		const committed = await commitAttemptResultIfActive(ref, result);
		await appendRunEvent(ref, {
			type: "reconcile.completed",
			attemptId: attempt.attemptId,
			status: result.status,
			message: committed.committed
				? "committed terminal attempt result"
				: "terminal attempt result was stale",
		}).catch(() => undefined);
		return {
			status: committed.committed ? "committed-result" : "running",
			runId: options.runId,
			record: committed.record,
		};
	}

	const ownerPid = attempt.process?.workerPid ?? attempt.process?.pid;
	if (
		(await ownerProcessAlive(attempt)) ||
		(ownerPid === undefined && heartbeatFresh(attempt, staleAfterMs))
	)
		return { status: "running", runId: options.runId, record };

	if (!(await terminateAttemptOwnership(attempt)))
		return cleanupBlockedResult(
			options.runId,
			record,
			"stale-attempt-ownership",
			[attempt.attemptId],
		);

	const interrupted = record.interrupt !== undefined;
	const cleanupStatus =
		attempt.workspace?.mode === "worktree" ? "kept" : "not-needed";
	const completedAt = new Date();
	const artifactCwd = attempt.artifactCwd ?? record.cwd;
	if (!interrupted) {
		const viaExecutor = await reconcileThroughExecutor({
			options,
			ref,
			record,
			attempt,
			artifactCwd,
			result,
			cleanupStatus,
		});
		if (viaExecutor !== undefined) return viaExecutor;
	}
	const store = await createAttemptArtifactStore({
		...ref,
		cwd: artifactCwd,
		attemptId: attempt.attemptId,
	});
	const stderr = await store.writeTextArtifact(
		"stderr",
		interrupted
			? "interrupted attempt exited without a result; marked cancelled\n"
			: "active attempt is stale/orphaned\n",
	);
	// WP2b terminal-last-write: output.log present and the control mailbox closed (every request
	// acked) before the terminal result.
	const output = await store.ensureTextArtifact("output");
	await closeControlMailbox(store.attemptDir).catch(() => undefined);
	const terminalResult = await store.writeResult({
		backend: attempt.backend ?? record.backend ?? UNKNOWN_BACKEND,
		status: interrupted ? "cancelled" : "failed",
		failureKind: interrupted ? "user_cancelled" : "stale",
		cwd: artifactCwd,
		startedAt: attempt.startedAt,
		completedAt,
		workspace: {
			...(attempt.workspace ?? {
				mode: "shared",
				cwd: artifactCwd,
				worktreePath: null,
			}),
			worktreeCleanupStatus: cleanupStatus,
		},
		sandbox: result?.sandbox ?? { enabled: false },
		exitCode: null,
		signal: interrupted ? (record.interrupt?.signal ?? null) : null,
		artifacts: [...(result?.artifacts ?? []), stderr, output],
		...(attempt.tmux === undefined ? {} : { tmux: attempt.tmux }),
		metadata: result?.metadata ?? { contextLengthExceeded: false },
	});
	const committed = await commitAttemptResultIfActive(ref, terminalResult);
	if (!committed.committed)
		return {
			status: "running",
			runId: options.runId,
			record: committed.record,
		};
	const updated = committed.record;
	await appendRunEvent(ref, {
		type: interrupted ? "reconcile.completed" : "reconcile.failed",
		attemptId: attempt.attemptId,
		status: interrupted ? "cancelled" : "failed",
		message: interrupted
			? "interrupted attempt exited without a result; marked cancelled"
			: "active attempt is stale/orphaned",
		data: interrupted
			? { failureKind: "user_cancelled", interrupt: record.interrupt }
			: { failureKind: "stale" },
	}).catch(() => undefined);
	return {
		status: interrupted ? "marked-cancelled" : "marked-stale",
		runId: options.runId,
		record: updated,
	};
}

const DEFAULT_ADOPT_TIMEOUT_MS = 5_000;

/**
 * WP2a-2: the owner process is gone and no terminal result exists. When the attempt has a
 * persisted executor descriptor, ask the executor (B3) instead of guessing "stale":
 * - `found`: adopt the ExecRef and observe it here if the executor is not `sessionBound`
 *   (bounded by `adoptTimeoutMs`; an unfinished window leaves the attempt running); otherwise
 *   record failed/needs_decision with the ref.
 * - `absent`: failed/not_started (proven never launched).
 * - `unknown`, a reconcile error, or an unloadable descriptor: failed/needs_decision.
 * The runtime never relaunches. Returns undefined for attempts without a descriptor.
 */
async function reconcileThroughExecutor(context: {
	options: ReconcileSubagentRunOptions;
	ref: RunRef;
	record: RunRecord;
	attempt: RunAttemptRecord;
	artifactCwd: string;
	result: ResultEnvelope | null;
	cleanupStatus: "kept" | "not-needed";
}): Promise<ReconcileSubagentRunResult | undefined> {
	const { options, ref, record, attempt, artifactCwd, result } = context;
	const attemptDir = join(
		runPaths({ ...ref, cwd: artifactCwd }).runDir,
		"attempts",
		attempt.attemptId,
	);
	const persisted = await readAttemptExecutorRecord(
		attemptDir,
		options.runId,
		attempt.attemptId,
	);
	if (persisted === undefined) return undefined;
	let outcome: NonNullable<ReconcileSubagentRunResult["executorReconcile"]>;
	let executor: Awaited<ReturnType<typeof loadExecutor>> | undefined;
	if ("invalid" in persisted)
		outcome = { outcome: "error", reason: persisted.invalid };
	else {
		try {
			executor = await loadExecutor(persisted.descriptor, {
				registry: options.registry,
			});
			const reconciled = await reconcileSafely(executor, persisted.attemptKey);
			outcome = {
				outcome: reconciled.outcome,
				...(reconciled.reason === undefined
					? {}
					: { reason: reconciled.reason }),
				...(reconciled.ref === undefined ? {} : { ref: reconciled.ref }),
			};
		} catch (error) {
			outcome = {
				outcome: "error",
				reason: `executor could not be loaded from its descriptor: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	await appendRunEvent(ref, {
		type: "reconcile.executor_outcome",
		attemptId: attempt.attemptId,
		status: attempt.status,
		message: `executor reconcile: ${outcome.outcome}`,
		data: { ...outcome },
	}).catch(() => undefined);

	const store = await createAttemptArtifactStore({
		...ref,
		cwd: artifactCwd,
		attemptId: attempt.attemptId,
	});
	const meta: ResultExecutorMetadata = {
		id:
			persisted && !("invalid" in persisted)
				? persisted.descriptor.id
				: (attempt.backend ?? UNKNOWN_BACKEND),
		...(executor === undefined ? {} : { version: executor.version }),
		...(persisted && !("invalid" in persisted)
			? { attemptKey: persisted.attemptKey }
			: {}),
		reconcile: outcome.outcome,
		...(outcome.reason === undefined
			? {}
			: { reconcileReason: outcome.reason }),
		...(outcome.ref === undefined ? {} : { ref: { ...outcome.ref } }),
	};
	const adoptTimeoutMs = options.adoptTimeoutMs ?? DEFAULT_ADOPT_TIMEOUT_MS;
	const startedAt = attempt.startedAt;
	const workspace = {
		...(attempt.workspace ?? {
			mode: "shared" as const,
			cwd: artifactCwd,
			worktreePath: null,
		}),
		worktreeCleanupStatus: context.cleanupStatus,
	};
	if (
		outcome.outcome === "found" &&
		outcome.ref !== undefined &&
		executor !== undefined &&
		!("invalid" in persisted) &&
		adoptTimeoutMs > 0 &&
		executor.capabilities().sessionBound === false
	) {
		// Observation restarts the event log: the adopted stream is the record from here on.
		await store.writeTextArtifact("exec-events", "");
		const observed = await observeAttempt({
			executor,
			ref: outcome.ref,
			store,
			stopSignal: AbortSignal.timeout(adoptTimeoutMs),
			grace: 0,
			approvalPolicy: persisted.approvalPolicy,
			readOnly: persisted.readOnly,
			meta,
			unauthorized: () => undefined,
			cancelOnStop: false,
		});
		if (observed.abandoned === true)
			return {
				status: "running",
				runId: options.runId,
				record,
				executorReconcile: { ...outcome, adopted: true },
			};
		meta.authority = "released";
		const report = await buildExecutionReport(
			store,
			meta,
			["adopted by reconcile after the worker process exited"],
			observed,
		);
		const stderr = await store.writeTextArtifact(
			"stderr",
			`${report.message}\n`,
		);
		const output = await store.writeTextArtifact("output", report.outputText);
		await closeControlMailbox(store.attemptDir).catch(() => undefined);
		const adoptedResult = await store.writeResult({
			backend: attempt.backend ?? record.backend ?? meta.id,
			status: report.status,
			failureKind: report.failureKind,
			cwd: artifactCwd,
			startedAt,
			completedAt: new Date(),
			workspace,
			sandbox: result?.sandbox ?? { enabled: false },
			exitCode: null,
			signal: null,
			artifacts: [stderr, output, ...report.artifacts],
			metadata: {
				contextLengthExceeded: false,
				...(report.outputPartial ? { outputPartial: true } : {}),
				...(report.usage === undefined ? {} : { usage: report.usage }),
				...(report.sessionId === undefined
					? {}
					: { sessionId: report.sessionId }),
				executor: report.executor,
			},
		});
		const committed = await commitAttemptResultIfActive(ref, adoptedResult);
		if (!committed.committed)
			return {
				status: "running",
				runId: options.runId,
				record: committed.record,
			};
		await appendRunEvent(ref, {
			type: "reconcile.completed",
			attemptId: attempt.attemptId,
			status: adoptedResult.status,
			message: "adopted executor attempt reached a terminal event",
			data: {
				failureKind: adoptedResult.failureKind,
				executorReconcile: "found",
			},
		}).catch(() => undefined);
		return {
			status: "adopted-result",
			runId: options.runId,
			record: committed.record,
			executorReconcile: { ...outcome, adopted: true },
		};
	}

	const notStarted = outcome.outcome === "absent";
	const failureKind = notStarted ? "not_started" : "needs_decision";
	const message = notStarted
		? "worker exited without a result; the executor reports the attempt never launched (not_started)"
		: outcome.outcome === "found"
			? `worker exited without a result; the executor still holds the attempt (${outcome.ref?.handle ?? "?"}) but cannot be observed from here; needs an owner decision (B3)`
			: `worker exited without a result; the executor cannot tell whether the attempt launched (${outcome.outcome}${outcome.reason === undefined ? "" : `: ${outcome.reason}`}); needs an owner decision, no automatic retry (B3)`;
	const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
	const output = await store.ensureTextArtifact("output");
	await closeControlMailbox(store.attemptDir).catch(() => undefined);
	const terminalResult = await store.writeResult({
		backend: attempt.backend ?? record.backend ?? meta.id,
		status: "failed",
		failureKind,
		cwd: artifactCwd,
		startedAt,
		completedAt: new Date(),
		workspace,
		sandbox: result?.sandbox ?? { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [...(result?.artifacts ?? []), stderr, output],
		metadata: {
			...(result?.metadata ?? { contextLengthExceeded: false }),
			executor: meta,
		},
	});
	const committed = await commitAttemptResultIfActive(ref, terminalResult);
	if (!committed.committed)
		return {
			status: "running",
			runId: options.runId,
			record: committed.record,
		};
	await appendRunEvent(ref, {
		type: "reconcile.failed",
		attemptId: attempt.attemptId,
		status: "failed",
		message,
		data: { failureKind, executorReconcile: outcome.outcome },
	}).catch(() => undefined);
	return {
		status: notStarted ? "marked-not-started" : "marked-needs-decision",
		runId: options.runId,
		record: committed.record,
		executorReconcile: outcome,
	};
}
