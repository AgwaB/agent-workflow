// New in agent-workflow (WP12a, live bundle 3 open problem 10): an owner-process identity check
// that fails transiently (the Darwin helper timing out under load returns `unknown`) must not be
// read as "the durable worker is gone". Before the fix reconcile then SIGTERMed the healthy worker
// on its next (successful) inspection and asked the executor, which could only answer `unknown` →
// needs_decision: runs turned `blocked` under load (host-cli "foreground run", replay acceptance).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	beginRunRecord,
	captureProcessIdentity,
	createAttemptArtifactStore,
	reconcileWorkerRun,
	writeAttemptExecutorRecord,
} from "../../dist/runtime/index.js";
import { setProcessIdentityInspectorForTests } from "../../dist/runtime/process-identity.js";
import { defaultApprovalPolicy } from "../../dist/sdk/index.js";
import { fixtureDescriptor } from "../fixtures/runtime/fake-executor-module.mjs";
import { killLiveChild } from "../helpers/process-cleanup.mjs";

let tempRoot;
const children = [];

before(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "aw-wp12a-reconcile-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(tempRoot, "run-index");
});
after(async () => {
	setProcessIdentityInspectorForTests(undefined);
	// Only children Node has not seen exit: an exited child's pid may be another process now.
	for (const child of children) killLiveChild(child, { group: true });
	await rm(tempRoot, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function runningAttemptOwnedBy(
	cwd,
	runId,
	attemptId,
	identity,
	effectLog,
) {
	await mkdir(cwd, { recursive: true });
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const startedAt = new Date(Date.now() - 60_000).toISOString();
	const result = await store.writeResult({
		executorId: "fixture",
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
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		executorId: "fixture",
		startedAt,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				executorId: "fixture",
				startedAt,
				artifactCwd: cwd,
				resultPath: result.artifacts.find((a) => a.type === "result")?.path,
				process: {
					pid: identity.pid,
					processGroupId: identity.processGroupId,
					processBirthIdentity: identity.birthIdentity,
					workerPid: identity.pid,
					workerProcessGroupId: identity.processGroupId,
					workerProcessBirthIdentity: identity.birthIdentity,
				},
				// A stale heartbeat: only the process check can keep the attempt alive.
				heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
			},
		],
	});
	await writeAttemptExecutorRecord(store.attemptDir, {
		descriptor: fixtureDescriptor({ effectLog }),
		attemptKey: `${runId}:${attemptId}`,
		readOnly: false,
		approvalPolicy: defaultApprovalPolicy(),
		executionPlanSha256: "",
	});
}

test("a transient unknown owner identity keeps a live worker running; it is never killed or questioned", async () => {
	const worker = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	children.push(worker);
	const identity = await captureProcessIdentity(worker.pid);
	const cwd = join(tempRoot, "transient");
	const effectLog = join(tempRoot, "transient-effects.jsonl");
	await runningAttemptOwnedBy(
		cwd,
		"run_wp12a_transient",
		"attempt_1",
		identity,
		effectLog,
	);
	let unknownLeft = 1;
	setProcessIdentityInspectorForTests(async (pid, inspect) => {
		if (pid === worker.pid && unknownLeft > 0) {
			unknownLeft -= 1;
			return { state: "unknown", reason: "helper timed out (simulated load)" };
		}
		return inspect(pid);
	});
	try {
		const result = await reconcileWorkerRun({
			cwd,
			runId: "run_wp12a_transient",
			staleAfterMs: 1,
		});
		assert.equal(result.status, "running");
	} finally {
		setProcessIdentityInspectorForTests(undefined);
	}
	assert.equal(alive(worker.pid), true, "the healthy worker was killed");
	await assert.rejects(
		access(effectLog),
		"the executor was asked to reconcile",
	);
});

test("a persistently unknown owner is kept running (unknown is not dead); a dead owner is still reconciled", async () => {
	const worker = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	children.push(worker);
	const identity = await captureProcessIdentity(worker.pid);
	const cwd = join(tempRoot, "persistent");
	const effectLog = join(tempRoot, "persistent-effects.jsonl");
	await runningAttemptOwnedBy(
		cwd,
		"run_wp12a_persistent",
		"attempt_1",
		identity,
		effectLog,
	);
	setProcessIdentityInspectorForTests(async (pid, inspect) =>
		pid === worker.pid
			? { state: "unknown", reason: "helper timed out (simulated load)" }
			: inspect(pid),
	);
	try {
		const result = await reconcileWorkerRun({
			cwd,
			runId: "run_wp12a_persistent",
			staleAfterMs: 1,
		});
		assert.equal(result.status, "running");
	} finally {
		setProcessIdentityInspectorForTests(undefined);
	}
	assert.equal(alive(worker.pid), true);

	process.kill(-worker.pid, "SIGKILL");
	await new Promise((resolveExit) => worker.once("exit", resolveExit));
	const reconciled = await reconcileWorkerRun({
		cwd,
		runId: "run_wp12a_persistent",
		staleAfterMs: 1,
	});
	assert.notEqual(reconciled.status, "running");
	await access(effectLog);
});
