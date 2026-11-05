// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) test/checks/reconcile.mjs. MIT, same author. Changes: tmux-specific cases converted to process-identity cases or dropped (tmux ownership is not ported); the orphaned headless-Pi child case and the Pi tool "reconcile" action are dropped (see runtime-port record); the parent-death launch uses the fake executor fixture; runs dir ".agent-workflow/runs"; plus WP2a-2 executor outcomes (absent → not_started, unknown/unloadable → needs_decision, found → adopt or needs_decision).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	beginRunRecord,
	captureProcessIdentity,
	createAttemptArtifactStore,
	getSubagentStatus,
	readRunRecord,
	recordInterruptRequest,
	reconcileSubagentRun,
	runPaths,
	updateAttemptWorkerProcess,
	verifyProcessIdentity,
	waitForSubagent,
	writeAttemptExecutorRecord,
} from "../../dist/runtime/index.js";
import { defaultApprovalPolicy } from "../../dist/sdk/index.js";
import { setProcessIdentityInspectorForTests } from "../../dist/runtime/process-identity.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";
import {
	killLiveChild,
	killTrackedProcess,
	trackProcess,
} from "../helpers/process-cleanup.mjs";

const execFileAsync = promisify(execFile);
const runtimeUrl = new URL("../../dist/runtime/index.js", import.meta.url).href;
const fixtureUrl = new URL(
	"../fixtures/runtime/fake-executor-module.mjs",
	import.meta.url,
).href;
let tempRoot;
const cleanup = [];

before(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "aw-reconcile-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(tempRoot, "run-index");
});
after(async () => {
	// Only processes this file started and that are still the same processes (pids are reused).
	for (const entry of cleanup)
		if (typeof entry === "number")
			await killTrackedProcess(entry, { group: true });
		else killLiveChild(entry, { group: true });
	await rm(tempRoot, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function spawnOwned(command, args) {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	cleanup.push(child);
	return child;
}

async function createRunningAttempt(cwd, runId, attemptId, options = {}) {
	await mkdir(cwd, { recursive: true });
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const startedAt =
		options.startedAt ?? new Date(Date.now() - 60_000).toISOString();
	let resultPath = options.resultPath;
	if (resultPath === undefined) {
		const result = await store.writeResult({
			backend: options.backend ?? "fixture",
			status: "running",
			failureKind: null,
			cwd,
			startedAt,
			completedAt: null,
			workspace: { mode: "shared", cwd, worktreePath: null },
			sandbox: { enabled: false },
			exitCode: null,
			signal: null,
			artifacts: [],
			metadata: { contextLengthExceeded: false },
		});
		resultPath = result.artifacts.find(
			(artifact) => artifact.type === "result",
		)?.path;
	}
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: options.backend ?? "fixture",
		startedAt,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: options.backend ?? "fixture",
				startedAt,
				artifactCwd: cwd,
				resultPath,
				process: options.process,
				heartbeatAt: options.heartbeatAt,
				workspace: options.workspace,
			},
		],
	});
	if (options.executor !== undefined)
		await writeAttemptExecutorRecord(store.attemptDir, {
			descriptor: options.executor,
			attemptKey: options.attemptKey ?? `${runId}:${attemptId}`,
			readOnly: false,
			approvalPolicy: defaultApprovalPolicy(),
			executionPlanSha256: "",
		});
	return store;
}

const stale = () => new Date(Date.now() - 60_000).toISOString();

test("process birth identity does not depend on the caller locale or timezone", async () => {
	const identity = await captureProcessIdentity(process.pid);
	const original = {
		LC_ALL: process.env.LC_ALL,
		LANG: process.env.LANG,
		TZ: process.env.TZ,
	};
	process.env.LC_ALL = "ko_KR.UTF-8";
	process.env.LANG = "ko_KR.UTF-8";
	process.env.TZ = "Asia/Seoul";
	try {
		assert.equal(await verifyProcessIdentity(identity), "alive");
	} finally {
		for (const [name, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("a detached durable worker finalizes after its launcher exits; cwd-less lookups use the locator", async () => {
	const parentDeathCwd = join(tempRoot, "parent-death");
	await mkdir(parentDeathCwd, { recursive: true });
	const launcher = `
		const { runSubagent } = await import(process.env.RUNTIME_URL);
		const { fixtureDescriptor } = await import(process.env.FIXTURE_URL);
		const run = await runSubagent({ cwd: process.env.RUN_CWD, executor: fixtureDescriptor({ effectLog: process.env.EFFECT_LOG }), task: "Provider-free parent-death check.", async: true });
		console.log(JSON.stringify({ runId: run.runId, attemptId: run.attemptId }));
	`;
	const launched = await execFileAsync(
		process.execPath,
		["--input-type=module", "-e", launcher],
		{
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			env: {
				...process.env,
				RUNTIME_URL: runtimeUrl,
				FIXTURE_URL: fixtureUrl,
				RUN_CWD: parentDeathCwd,
				EFFECT_LOG: join(tempRoot, "parent-death.jsonl"),
				AGENT_WORKFLOW_HEARTBEAT_MS: "50",
			},
		},
	);
	const ref = JSON.parse(launched.stdout.trim());
	const waited = await waitForSubagent({
		cwd: parentDeathCwd,
		...ref,
		timeoutMs: 15_000,
		pollIntervalMs: 100,
	});
	assert.equal(waited.status, "completed");
	assert.equal(waited.snapshot?.status, "completed");
	const locatorWaited = await waitForSubagent({
		...ref,
		timeoutMs: 1_000,
		pollIntervalMs: 50,
	});
	assert.equal(locatorWaited.status, "completed");
	assert.equal(locatorWaited.snapshot?.runId, ref.runId);
	const status = await getSubagentStatus({ cwd: parentDeathCwd, ...ref });
	assert.equal(typeof status?.attempts?.[0]?.workerPid, "number");
	assert.equal((await getSubagentStatus(ref))?.runId, ref.runId);
	await access(
		join(
			parentDeathCwd,
			".agent-workflow/runs",
			ref.runId,
			"attempts",
			ref.attemptId,
			"worker.log",
		),
	);
});

test("stale attempts without an executor record are marked stale (worktree kept)", async () => {
	const staleCwd = join(tempRoot, "stale");
	await createRunningAttempt(staleCwd, "run_reconcile_stale", "attempt_stale", {
		heartbeatAt: stale(),
	});
	const reconciled = await reconcileSubagentRun({
		cwd: staleCwd,
		runId: "run_reconcile_stale",
		staleAfterMs: 1,
	});
	assert.equal(reconciled.status, "marked-stale");
	assert.equal(reconciled.record?.status, "failed");
	assert.equal(reconciled.record?.failureKind, "stale");
	assert.equal(
		reconciled.record?.attempts[0]?.workspace?.worktreeCleanupStatus,
		"not-needed",
	);
	assert.equal(reconciled.executorReconcile, undefined);

	const worktreeCwd = join(tempRoot, "stale-worktree");
	await createRunningAttempt(
		worktreeCwd,
		"run_reconcile_worktree",
		"attempt_worktree",
		{
			heartbeatAt: stale(),
			workspace: {
				mode: "worktree",
				cwd: worktreeCwd,
				worktreePath: join(tempRoot, "retained-worktree"),
				worktreeCleanupStatus: "execution-owned",
			},
		},
	);
	const worktree = await reconcileSubagentRun({
		cwd: worktreeCwd,
		runId: "run_reconcile_worktree",
		staleAfterMs: 1,
	});
	assert.equal(worktree.status, "marked-stale");
	assert.equal(
		worktree.record?.attempts[0]?.workspace?.worktreeCleanupStatus,
		"kept",
	);
	assert.equal(typeof worktree.record?.attempts[0]?.resultPath, "string");
});

test("executor outcomes: absent → not_started; unknown → needs_decision; unloadable → needs_decision", async () => {
	const absentCwd = join(tempRoot, "executor-absent");
	const absentLog = join(tempRoot, "absent.jsonl");
	await createRunningAttempt(
		absentCwd,
		"run_exec_absent",
		"attempt_exec_absent",
		{
			heartbeatAt: stale(),
			executor: fixtureDescriptor({ effectLog: absentLog }),
		},
	);
	const absent = await reconcileSubagentRun({
		cwd: absentCwd,
		runId: "run_exec_absent",
		staleAfterMs: 1,
	});
	assert.equal(absent.status, "marked-not-started", JSON.stringify(absent));
	assert.equal(absent.executorReconcile.outcome, "absent");
	assert.equal(absent.record?.status, "failed");
	assert.equal(absent.record?.failureKind, "not_started");
	assert.deepEqual(
		readEffectLog(absentLog).map((entry) => [entry.type, entry.result]),
		[["reconcile", { absent: true }]],
		"reconcile asked; nothing was submitted",
	);

	const unknownCwd = join(tempRoot, "executor-unknown");
	const unknownLog = join(tempRoot, "unknown.jsonl");
	await writeFile(
		unknownLog,
		`${JSON.stringify({ type: "consume", attemptKey: "k-unknown", outcome: "released" })}\n`,
	);
	await createRunningAttempt(
		unknownCwd,
		"run_exec_unknown",
		"attempt_exec_unknown",
		{
			heartbeatAt: stale(),
			executor: fixtureDescriptor({ effectLog: unknownLog }),
			attemptKey: "k-unknown",
		},
	);
	// The worker logged why it stopped (then a stack): the owner decision shows that line.
	const unknownStore = await createAttemptArtifactStore({
		cwd: unknownCwd,
		runId: "run_exec_unknown",
		attemptId: "attempt_exec_unknown",
	});
	await writeFile(
		join(unknownStore.attemptDir, "worker.log"),
		"Error: inactive attempt ownership could not be drained\n    at commitOwnedTerminalResult (run.js:1:1)\n    at async main (worker.js:2:2)\n",
	);
	const unknown = await reconcileSubagentRun({
		cwd: unknownCwd,
		runId: "run_exec_unknown",
		staleAfterMs: 1,
	});
	assert.equal(unknown.status, "marked-needs-decision");
	assert.equal(unknown.record?.failureKind, "needs_decision");
	const unknownResult = JSON.parse(
		await readFile(join(unknownStore.attemptDir, "result.json"), "utf8"),
	);
	assert.match(
		unknownResult.metadata.executor.workerExit,
		/; its last log line: Error: inactive attempt ownership could not be drained$/u,
	);
	assert.match(
		await readFile(join(unknownStore.attemptDir, "stderr.log"), "utf8"),
		/\nworker: .*; its last log line: Error: inactive attempt ownership could not be drained\n/u,
	);

	const missingCwd = join(tempRoot, "executor-missing");
	await createRunningAttempt(
		missingCwd,
		"run_exec_missing",
		"attempt_exec_missing",
		{
			heartbeatAt: stale(),
			executor: fixtureDescriptor(
				{ effectLog: unknownLog },
				{ module: "/nonexistent/executor.mjs" },
			),
		},
	);
	const missing = await reconcileSubagentRun({
		cwd: missingCwd,
		runId: "run_exec_missing",
		staleAfterMs: 1,
	});
	assert.equal(missing.status, "marked-needs-decision");
	assert.equal(missing.executorReconcile.outcome, "error");
	assert.match(missing.executorReconcile.reason, /could not be loaded/u);
});

test("executor outcome found: adopt and observe when not sessionBound; otherwise needs_decision", async () => {
	const seed = (log, attemptKey) =>
		writeFile(
			log,
			[
				{ type: "consume", attemptKey, outcome: "released" },
				{ type: "effect", attemptKey, authorized: true },
				{
					type: "ref",
					attemptKey,
					ref: { executorId: "fixture", attemptKey, handle: "h-adopt" },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")
				.concat("\n"),
		);
	const adoptCwd = join(tempRoot, "executor-adopt");
	const adoptLog = join(tempRoot, "adopt.jsonl");
	await seed(adoptLog, "k-adopt");
	const store = await createRunningAttempt(
		adoptCwd,
		"run_exec_adopt",
		"attempt_exec_adopt",
		{
			heartbeatAt: stale(),
			executor: fixtureDescriptor({ effectLog: adoptLog, reconcile: "found" }),
			attemptKey: "k-adopt",
		},
	);
	const adopted = await reconcileSubagentRun({
		cwd: adoptCwd,
		runId: "run_exec_adopt",
		staleAfterMs: 1,
	});
	assert.equal(adopted.status, "adopted-result", JSON.stringify(adopted));
	assert.equal(adopted.executorReconcile.adopted, true);
	assert.equal(adopted.record?.status, "completed");
	const result = JSON.parse(
		await readFile(join(store.attemptDir, "result.json"), "utf8"),
	);
	assert.equal(result.metadata.executor.reconcile, "found");
	assert.equal(result.metadata.executor.ref.handle, "h-adopt");
	assert.equal(result.metadata.usage.cost, null);
	assert.equal(
		await readFile(join(store.attemptDir, "output.log"), "utf8"),
		"fixture final answer",
	);
	assert.equal(
		readEffectLog(adoptLog).filter((entry) => entry.type === "submit").length,
		0,
		"adoption observes; it never submits again",
	);

	const boundCwd = join(tempRoot, "executor-bound");
	const boundLog = join(tempRoot, "bound.jsonl");
	await seed(boundLog, "k-bound");
	await createRunningAttempt(boundCwd, "run_exec_bound", "attempt_exec_bound", {
		heartbeatAt: stale(),
		executor: fixtureDescriptor({
			effectLog: boundLog,
			reconcile: "found",
			sessionBound: true,
		}),
		attemptKey: "k-bound",
	});
	const bound = await reconcileSubagentRun({
		cwd: boundCwd,
		runId: "run_exec_bound",
		staleAfterMs: 1,
	});
	assert.equal(bound.status, "marked-needs-decision");
	assert.equal(bound.executorReconcile.outcome, "found");
	assert.equal(bound.record?.failureKind, "needs_decision");
	assert.equal(
		readEffectLog(boundLog).some((entry) => entry.type === "adopt-observe"),
		false,
	);
});

test("interrupted attempts are marked cancelled; live workers and fresh heartbeats keep running", async () => {
	const interruptedCwd = join(tempRoot, "interrupted");
	await createRunningAttempt(
		interruptedCwd,
		"run_reconcile_interrupted",
		"attempt_interrupted",
		{
			heartbeatAt: stale(),
			executor: fixtureDescriptor({
				effectLog: join(tempRoot, "interrupted.jsonl"),
			}),
		},
	);
	await recordInterruptRequest(
		{ cwd: interruptedCwd, runId: "run_reconcile_interrupted" },
		"SIGINT",
		"test cancellation",
	);
	const interrupted = await reconcileSubagentRun({
		cwd: interruptedCwd,
		runId: "run_reconcile_interrupted",
		staleAfterMs: 1,
	});
	assert.equal(interrupted.status, "marked-cancelled");
	assert.equal(interrupted.record?.status, "cancelled");
	assert.equal(interrupted.record?.failureKind, "user_cancelled");
	assert.equal(
		await pathExists(join(tempRoot, "interrupted.jsonl")),
		false,
		"an interrupt is not an executor question",
	);

	const liveCwd = join(tempRoot, "live-worker");
	const liveIdentity = await captureProcessIdentity(process.pid);
	await createRunningAttempt(liveCwd, "run_reconcile_live", "attempt_live", {
		process: {
			pid: liveIdentity.pid,
			processGroupId: liveIdentity.processGroupId,
			processBirthIdentity: liveIdentity.birthIdentity,
			workerPid: liveIdentity.pid,
			workerProcessGroupId: liveIdentity.processGroupId,
			workerProcessBirthIdentity: liveIdentity.birthIdentity,
		},
		heartbeatAt: stale(),
	});
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: liveCwd,
				runId: "run_reconcile_live",
				staleAfterMs: 1,
			})
		).status,
		"running",
	);

	const heartbeatCwd = join(tempRoot, "fresh-heartbeat");
	await createRunningAttempt(
		heartbeatCwd,
		"run_reconcile_heartbeat",
		"attempt_heartbeat",
		{ heartbeatAt: new Date().toISOString() },
	);
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: heartbeatCwd,
				runId: "run_reconcile_heartbeat",
				staleAfterMs: 30_000,
			})
		).status,
		"running",
	);

	const foreignCwd = join(tempRoot, "foreign-result");
	const foreignStore = await createAttemptArtifactStore({
		cwd: foreignCwd,
		runId: "run_reconcile_foreign_result",
		attemptId: "attempt_foreign_result",
	});
	const foreign = await foreignStore.writeResult({
		backend: "fixture",
		status: "completed",
		failureKind: null,
		cwd: foreignCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: { mode: "shared", cwd: foreignCwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	const foreignPath = foreign.artifacts.find(
		(artifact) => artifact.type === "result",
	)?.path;
	await writeFile(
		join(foreignCwd, foreignPath),
		`${JSON.stringify({ ...foreign, runId: "run_other" })}\n`,
	);
	await createRunningAttempt(
		foreignCwd,
		"run_reconcile_foreign_result",
		"attempt_foreign_result",
		{
			process: {
				pid: liveIdentity.pid,
				processGroupId: liveIdentity.processGroupId,
				processBirthIdentity: liveIdentity.birthIdentity,
			},
			resultPath: foreignPath,
		},
	);
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: foreignCwd,
				runId: "run_reconcile_foreign_result",
				staleAfterMs: 1,
			})
		).status,
		"running",
		"foreign result identity must not drive terminal reconciliation",
	);
});

test("a late worker update never replaces execution metadata", async () => {
	const cwd = join(tempRoot, "worker-metadata-race");
	const executionIdentity = await captureProcessIdentity(process.pid);
	const probe = spawnOwned("/bin/sleep", ["30"]);
	const workerIdentity = await captureProcessIdentity(probe.pid);
	await createRunningAttempt(
		cwd,
		"run_worker_metadata_race",
		"attempt_worker_metadata_race",
		{
			process: {
				pid: executionIdentity.pid,
				processGroupId: executionIdentity.processGroupId,
				processBirthIdentity: executionIdentity.birthIdentity,
				command: "executor child",
			},
		},
	);
	await updateAttemptWorkerProcess({
		cwd,
		runId: "run_worker_metadata_race",
		attemptId: "attempt_worker_metadata_race",
		process: {
			workerPid: workerIdentity.pid,
			workerProcessGroupId: workerIdentity.processGroupId,
			workerProcessBirthIdentity: workerIdentity.birthIdentity,
			command: "durable worker",
		},
	});
	const recorded = (
		await readRunRecord({ cwd, runId: "run_worker_metadata_race" })
	)?.attempts[0]?.process;
	assert.equal(recorded?.pid, executionIdentity.pid);
	assert.equal(recorded?.processGroupId, executionIdentity.processGroupId);
	assert.equal(recorded?.processBirthIdentity, executionIdentity.birthIdentity);
	assert.equal(recorded?.command, "executor child");
	assert.equal(recorded?.workerPid, workerIdentity.pid);
});

test("inconsistent records and unverifiable ownership block terminal reconciliation", async () => {
	const danglingRef = {
		cwd: join(tempRoot, "dangling-active"),
		runId: "run_reconcile_dangling_active",
	};
	await beginRunRecord({
		...danglingRef,
		mode: "single",
		backend: "fixture",
		activeAttemptId: "attempt_present",
		attempts: [
			{
				attemptId: "attempt_present",
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
			},
		],
	});
	const dangling = await readRunRecord(danglingRef);
	await writeFile(
		runPaths(danglingRef).runJsonPath,
		`${JSON.stringify({ ...dangling, activeAttemptId: "attempt_missing" })}\n`,
	);
	assert.deepEqual(
		(await reconcileSubagentRun({ ...danglingRef, staleAfterMs: 1 }))
			.cleanupBlocked,
		{
			reason: "missing-active-attempt",
			attemptIds: ["attempt_missing"],
		},
	);

	const terminalActiveRef = {
		cwd: join(tempRoot, "terminal-active-unsafe"),
		runId: "run_terminal_active_unsafe",
	};
	await beginRunRecord({
		...terminalActiveRef,
		mode: "single",
		backend: "fixture",
		activeAttemptId: "attempt_terminal_active",
		attempts: [
			{
				attemptId: "attempt_terminal_active",
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
				process: { pid: process.pid },
			},
		],
	});
	const terminalActive = await readRunRecord(terminalActiveRef);
	await writeFile(
		runPaths(terminalActiveRef).runJsonPath,
		`${JSON.stringify({ ...terminalActive, status: "completed" })}\n`,
	);
	assert.deepEqual(
		(await reconcileSubagentRun({ ...terminalActiveRef, staleAfterMs: 30_000 }))
			.cleanupBlocked,
		{
			reason: "terminal-record-active-attempt",
			attemptIds: ["attempt_terminal_active"],
		},
	);

	const terminalOwnershipCwd = join(tempRoot, "terminal-ownership-unsafe");
	await beginRunRecord({
		cwd: terminalOwnershipCwd,
		runId: "run_terminal_ownership_unsafe",
		mode: "single",
		backend: "fixture",
		attempts: [
			{
				attemptId: "attempt_terminal_ownership",
				status: "completed",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				process: { pid: process.pid },
			},
		],
	});
	assert.deepEqual(
		(
			await reconcileSubagentRun({
				cwd: terminalOwnershipCwd,
				runId: "run_terminal_ownership_unsafe",
				staleAfterMs: 1,
			})
		).cleanupBlocked,
		{
			reason: "terminal-attempt-ownership",
			attemptIds: ["attempt_terminal_ownership"],
		},
	);

	const liveIdentity = await captureProcessIdentity(process.pid);
	const inactiveCwd = join(tempRoot, "inactive-ownership-unsafe");
	await beginRunRecord({
		cwd: inactiveCwd,
		runId: "run_inactive_ownership_unsafe",
		mode: "single",
		backend: "fixture",
		activeAttemptId: "attempt_active_safe",
		attempts: [
			{
				attemptId: "attempt_inactive_unsafe",
				status: "running",
				backend: "fixture",
				startedAt: new Date(Date.now() - 1_000).toISOString(),
				process: { pid: process.pid },
			},
			{
				attemptId: "attempt_active_safe",
				status: "running",
				backend: "fixture",
				startedAt: new Date().toISOString(),
				process: {
					pid: liveIdentity.pid,
					processGroupId: liveIdentity.processGroupId,
					processBirthIdentity: liveIdentity.birthIdentity,
				},
			},
		],
	});
	assert.deepEqual(
		(
			await reconcileSubagentRun({
				cwd: inactiveCwd,
				runId: "run_inactive_ownership_unsafe",
				staleAfterMs: 1,
			})
		).cleanupBlocked,
		{
			reason: "inactive-attempt-ownership",
			attemptIds: ["attempt_inactive_unsafe"],
		},
	);

	const terminalResultCwd = join(tempRoot, "terminal-result-unsafe");
	const terminalStore = await createAttemptArtifactStore({
		cwd: terminalResultCwd,
		runId: "run_terminal_result_unsafe",
		attemptId: "attempt_terminal_result_unsafe",
	});
	const terminalEnvelope = await terminalStore.writeResult({
		backend: "fixture",
		status: "completed",
		failureKind: null,
		cwd: terminalResultCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: { mode: "shared", cwd: terminalResultCwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await createRunningAttempt(
		terminalResultCwd,
		"run_terminal_result_unsafe",
		"attempt_terminal_result_unsafe",
		{
			process: { pid: process.pid },
			resultPath: terminalEnvelope.artifacts.find(
				(artifact) => artifact.type === "result",
			)?.path,
		},
	);
	assert.deepEqual(
		(
			await reconcileSubagentRun({
				cwd: terminalResultCwd,
				runId: "run_terminal_result_unsafe",
				staleAfterMs: 1,
			})
		).cleanupBlocked,
		{
			reason: "terminal-result-ownership",
			attemptIds: ["attempt_terminal_result_unsafe"],
		},
	);

	const unrelatedCwd = join(tempRoot, "unrelated-process");
	const unrelated = spawnOwned("/bin/sleep", ["30"]);
	const unrelatedIdentity = await captureProcessIdentity(unrelated.pid);
	await createRunningAttempt(
		unrelatedCwd,
		"run_reconcile_unrelated",
		"attempt_unrelated",
		{
			heartbeatAt: stale(),
			process: {
				workerPid: unrelatedIdentity.pid,
				workerProcessGroupId: unrelatedIdentity.processGroupId,
				workerProcessBirthIdentity: `${unrelatedIdentity.birthIdentity}-mismatch`,
			},
		},
	);
	const unrelatedReconcile = await reconcileSubagentRun({
		cwd: unrelatedCwd,
		runId: "run_reconcile_unrelated",
		staleAfterMs: 1,
	});
	assert.equal(unrelatedReconcile.status, "cleanup-blocked");
	assert.deepEqual(unrelatedReconcile.cleanupBlocked, {
		reason: "stale-attempt-ownership",
		attemptIds: ["attempt_unrelated"],
	});
	assert.equal(
		pidAlive(unrelated.pid),
		true,
		"ownership mismatch must not signal an unrelated process",
	);
});

test("cleanup terminates verified owned processes, never unverified ones", async () => {
	const partialCwd = join(tempRoot, "partial-verified-cleanup");
	const partialSideEffect = join(partialCwd, "late-side-effect");
	await mkdir(partialCwd, { recursive: true });
	const child = spawnOwned(process.execPath, [
		"--input-type=module",
		"-e",
		`import { writeFileSync } from "node:fs"; await new Promise((resolve) => setTimeout(resolve, 750)); writeFileSync(${JSON.stringify(partialSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10_000));`,
		"owned-execution-child",
	]);
	const unrelated = spawnOwned("/bin/sleep", ["30"]);
	const childIdentity = await captureProcessIdentity(child.pid);
	const unrelatedIdentity = await captureProcessIdentity(unrelated.pid);
	await createRunningAttempt(
		partialCwd,
		"run_reconcile_partial_cleanup",
		"attempt_partial_cleanup",
		{
			process: {
				pid: childIdentity.pid,
				processGroupId: childIdentity.processGroupId,
				processBirthIdentity: childIdentity.birthIdentity,
				workerPid: unrelatedIdentity.pid,
				workerProcessGroupId: unrelatedIdentity.processGroupId,
				workerProcessBirthIdentity: `${unrelatedIdentity.birthIdentity}-mismatch`,
			},
			heartbeatAt: stale(),
		},
	);
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: partialCwd,
				runId: "run_reconcile_partial_cleanup",
				staleAfterMs: 1,
			})
		).status,
		"cleanup-blocked",
	);
	assert.equal(
		pidAlive(child.pid),
		false,
		"a separately verified execution child must still be terminated",
	);
	assert.equal(pidAlive(unrelated.pid), true);
	await sleep(900);
	assert.equal(await pathExists(partialSideEffect), false);

	const incompleteCwd = join(tempRoot, "incomplete-identity-cleanup");
	const incompleteSideEffect = join(incompleteCwd, "late-side-effect");
	await mkdir(incompleteCwd, { recursive: true });
	const incompleteChild = spawnOwned(process.execPath, [
		"--input-type=module",
		"-e",
		`import { writeFileSync } from "node:fs"; await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(incompleteSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));`,
		"complete-owned-child",
	]);
	const incompleteUnrelated = spawnOwned("/bin/sleep", ["30"]);
	const incompleteIdentity = await captureProcessIdentity(incompleteChild.pid);
	await createRunningAttempt(
		incompleteCwd,
		"run_reconcile_incomplete_cleanup",
		"attempt_incomplete_cleanup",
		{
			process: {
				pid: incompleteIdentity.pid,
				processGroupId: incompleteIdentity.processGroupId,
				processBirthIdentity: incompleteIdentity.birthIdentity,
				workerPid: incompleteUnrelated.pid,
			},
			heartbeatAt: stale(),
		},
	);
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: incompleteCwd,
				runId: "run_reconcile_incomplete_cleanup",
				staleAfterMs: 1,
			})
		).status,
		"cleanup-blocked",
	);
	assert.equal(pidAlive(incompleteChild.pid), false);
	assert.equal(pidAlive(incompleteUnrelated.pid), true);
	await sleep(3_100);
	assert.equal(await pathExists(incompleteSideEffect), false);

	const terminalAllCwd = join(tempRoot, "terminal-all-attempts");
	const older = spawnOwned("/bin/sleep", ["30"]);
	const olderIdentity = await captureProcessIdentity(older.pid);
	await beginRunRecord({
		cwd: terminalAllCwd,
		runId: "run_terminal_all_attempts",
		mode: "single",
		backend: "fixture",
		attempts: [
			{
				attemptId: "attempt_older_running",
				status: "running",
				backend: "fixture",
				startedAt: "2026-01-01T00:00:00.000Z",
				process: {
					pid: olderIdentity.pid,
					processGroupId: olderIdentity.processGroupId,
					processBirthIdentity: olderIdentity.birthIdentity,
				},
			},
			{
				attemptId: "attempt_latest_terminal",
				status: "completed",
				backend: "fixture",
				failureKind: null,
				startedAt: "2026-01-01T00:00:01.000Z",
				completedAt: "2026-01-01T00:00:02.000Z",
			},
		],
	});
	assert.equal(
		(
			await reconcileSubagentRun({
				cwd: terminalAllCwd,
				runId: "run_terminal_all_attempts",
				staleAfterMs: 1,
			})
		).status,
		"already-terminal",
	);
	assert.equal(
		pidAlive(older.pid),
		false,
		"terminal reconciliation must clean ownership from every attempt",
	);
});

test("a dead group leader with a live group blocks; EPERM on a live group surfaces as cleanup-blocked", async () => {
	const deadLeaderCwd = join(tempRoot, "dead-group-leader");
	const pidPath = join(deadLeaderCwd, "child.pid");
	const sideEffect = join(deadLeaderCwd, "late-side-effect");
	await mkdir(deadLeaderCwd, { recursive: true });
	const leader = spawnOwned("/bin/bash", [
		"-c",
		`${JSON.stringify(process.execPath)} --input-type=module -e 'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(sideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));' ignored-sigterm-child & echo $! > ${JSON.stringify(pidPath)}; wait`,
	]);
	const leaderIdentity = await captureProcessIdentity(leader.pid);
	// `echo $! > file` creates the file before it writes the pid: wait for the number itself
	// (an empty read was pid 0, "not alive", on a loaded machine).
	let childPid = 0;
	for (let index = 0; index < 1000 && !(childPid > 0); index += 1) {
		if (await pathExists(pidPath))
			childPid = Number((await readFile(pidPath, "utf8")).trim());
		if (!(childPid > 0)) await sleep(10);
	}
	trackProcess(childPid);
	cleanup.push(childPid);
	assert.equal(pidAlive(childPid), true);
	await sleep(100);
	await createRunningAttempt(
		deadLeaderCwd,
		"run_reconcile_dead_group_leader",
		"attempt_dead_group_leader",
		{
			process: {
				pid: leaderIdentity.pid,
				processGroupId: leaderIdentity.processGroupId,
				processBirthIdentity: leaderIdentity.birthIdentity,
			},
			heartbeatAt: stale(),
		},
	);
	process.kill(leader.pid, "SIGKILL");
	for (let index = 0; index < 100 && pidAlive(leader.pid); index += 1)
		await sleep(10);
	const deadLeader = await reconcileSubagentRun({
		cwd: deadLeaderCwd,
		runId: "run_reconcile_dead_group_leader",
		staleAfterMs: 1,
	});
	assert.equal(deadLeader.status, "cleanup-blocked");
	assert.equal(pidAlive(childPid), true);
	assert.equal(deadLeader.record?.status, "running");
	process.kill(-leaderIdentity.processGroupId, "SIGKILL");
	for (let index = 0; index < 100 && pidAlive(childPid); index += 1)
		await sleep(10);
	await sleep(900);
	assert.equal(await pathExists(sideEffect), false);

	const epermCwd = join(tempRoot, "eperm-group");
	const epermProcess = spawnOwned("/bin/sleep", ["30"]);
	const epermIdentity = await captureProcessIdentity(epermProcess.pid);
	const epermStore = await createAttemptArtifactStore({
		cwd: epermCwd,
		runId: "run_reconcile_eperm",
		attemptId: "attempt_eperm",
	});
	const epermEnvelope = await epermStore.writeResult({
		backend: "fixture",
		status: "completed",
		failureKind: null,
		cwd: epermCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: { mode: "shared", cwd: epermCwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	const epermWorker = spawnOwned("/bin/sleep", ["30"]);
	const epermWorkerIdentity = await captureProcessIdentity(epermWorker.pid);
	epermWorker.kill("SIGKILL");
	for (let index = 0; index < 100 && pidAlive(epermWorker.pid); index += 1)
		await sleep(10);
	await createRunningAttempt(epermCwd, "run_reconcile_eperm", "attempt_eperm", {
		heartbeatAt: stale(),
		process: {
			pid: epermIdentity.pid,
			processGroupId: epermIdentity.processGroupId,
			processBirthIdentity: epermIdentity.birthIdentity,
			workerPid: epermWorkerIdentity.pid,
			workerProcessGroupId: epermWorkerIdentity.processGroupId,
			workerProcessBirthIdentity: epermWorkerIdentity.birthIdentity,
			command: "executor child",
		},
		resultPath: epermEnvelope.artifacts.find(
			(artifact) => artifact.type === "result",
		)?.path,
	});
	const realKill = process.kill;
	let groupSignals = 0;
	process.kill = function epermGroupKill(pid, signal) {
		if (
			typeof pid === "number" &&
			pid < 0 &&
			signal !== 0 &&
			signal !== undefined
		) {
			groupSignals += 1;
			throw Object.assign(new Error("kill EPERM"), {
				code: "EPERM",
				errno: -1,
				syscall: "kill",
			});
		}
		return realKill.call(process, pid, signal);
	};
	let eperm;
	try {
		eperm = await reconcileSubagentRun({
			cwd: epermCwd,
			runId: "run_reconcile_eperm",
			staleAfterMs: 1,
		});
	} finally {
		process.kill = realKill;
	}
	assert.ok(groupSignals >= 1);
	assert.equal(eperm.status, "cleanup-blocked", JSON.stringify(eperm));
	assert.equal(pidAlive(epermProcess.pid), true);
	realKill.call(process, epermProcess.pid, "SIGKILL");
	for (let index = 0; index < 100 && pidAlive(epermProcess.pid); index += 1)
		await sleep(10);
	const epermAfter = await reconcileSubagentRun({
		cwd: epermCwd,
		runId: "run_reconcile_eperm",
		staleAfterMs: 1,
	});
	assert.ok(
		["committed-result", "already-terminal"].includes(epermAfter.status),
		JSON.stringify(epermAfter),
	);
});

// The worker writes result.json last, then exits quietly. Reconcile can read "running" just
// before that write, and observe the owner as dead just after it. The terminal result, not an
// executor that cannot rediscover an in-process session, must decide the attempt's outcome.
for (const status of ["completed", "failed", "cancelled"]) {
	test(`worker exit race: preserve a ${status} result written during owner inspection`, async (t) => {
		const cwd = join(tempRoot, `exit-race-${status}`);
		const runId = `run_exit_race_${status}`;
		const attemptId = `attempt_exit_race_${status}`;
		const effectLog = join(tempRoot, `exit-race-${status}.jsonl`);
		const effects = [{ type: "effect", attemptKey: `${runId}:${attemptId}` }];
		await writeFile(effectLog, `${JSON.stringify(effects[0])}\n`);
		const child = spawnOwned(process.execPath, [
			"-e",
			"setInterval(() => {}, 1000)",
		]);
		const identity = await captureProcessIdentity(child.pid);
		const store = await createRunningAttempt(cwd, runId, attemptId, {
			executor: fixtureDescriptor({ effectLog, reconcile: "unknown" }),
			process: {
				workerPid: identity.pid,
				workerProcessGroupId: identity.processGroupId,
				workerProcessBirthIdentity: identity.birthIdentity,
			},
		});
		const running = JSON.parse(
			await readFile(join(store.attemptDir, "result.json"), "utf8"),
		);
		let terminal;
		let injected = false;
		t.after(() => setProcessIdentityInspectorForTests(undefined));
		setProcessIdentityInspectorForTests(async (pid, inspect) => {
			if (pid === identity.pid && !injected) {
				injected = true;
				// This callback is reached only after reconcile's first result read.
				await store.writeTextArtifact("output", "finished before exit\n");
				terminal = await store.writeResult({
					...running,
					status,
					failureKind:
						status === "completed"
							? null
							: status === "failed"
								? "internal"
								: "user_cancelled",
					completedAt: new Date(),
				});
				const closed = new Promise((resolve) => child.once("close", resolve));
				child.kill("SIGKILL");
				await closed;
			}
			return inspect(pid);
		});
		const reconciled = await reconcileSubagentRun({ cwd, runId });
		assert.equal(injected, true);
		assert.equal(reconciled.status, "committed-result");
		assert.equal(reconciled.record.status, status);
		assert.equal(reconciled.executorReconcile, undefined);
		assert.deepEqual(
			JSON.parse(await readFile(join(store.attemptDir, "result.json"), "utf8")),
			terminal,
		);
		assert.deepEqual(
			readEffectLog(effectLog),
			effects,
			"no reconcile or second submit is needed",
		);
	});
}
