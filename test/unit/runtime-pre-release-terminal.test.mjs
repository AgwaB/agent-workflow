// Pre-release stops must write terminal status/failureKind, clear the active attempt,
// discard the pristine workspace, and drain ownership through the terminal finalizer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { promisify } from "node:util";
import {
	createDurableLaunchBarrierV2,
	getSubagentStatus,
	readRunEvents,
	readRunRecord,
	revokeDurableLaunchBarrierV2,
	runSubagent,
	waitForSubagent,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let root;
let counter = 0;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-pre-release-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function fresh(label) {
	counter += 1;
	return {
		cwd: join(root, `${label}-${counter}`),
		effectLog: join(root, `${label}-${counter}.effects.jsonl`),
		barrierDir: join(root, `${label}-${counter}.barrier`),
	};
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function createRepo(repo) {
	await mkdir(repo, { recursive: true });
	await execFileAsync("git", ["init"], { cwd: repo });
	await writeFile(join(repo, "README.md"), "base\n");
	await execFileAsync("git", ["add", "README.md"], { cwd: repo });
	await execFileAsync(
		"git",
		[
			"-c",
			"user.name=AW Check",
			"-c",
			"user.email=aw-check@example.invalid",
			"commit",
			"-m",
			"init",
		],
		{ cwd: repo },
	);
}

function attemptDir(cwd, run) {
	return join(
		cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
}

async function waitForTerminalEvents(cwd, run, status, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const events = await readRunEvents({ cwd, runId: run.runId }, Infinity);
		if (
			events.some(
				(event) =>
					event.type === `attempt.${status}` &&
					event.attemptId === run.attemptId,
			) &&
			events.some((event) => event.type === `run.${status}`)
		)
			return events;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(
		`no terminal ${status} events for ${run.runId}: ${JSON.stringify(await readRunEvents({ cwd, runId: run.runId }, Infinity))}`,
	);
}

async function assertTerminal(cwd, run, status, failureKind) {
	const waited = await waitForSubagent({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs: 20_000,
		pollIntervalMs: 25,
	});
	assert.equal(waited.status, "completed", JSON.stringify(waited));
	assert.equal(waited.snapshot.status, status, JSON.stringify(waited));
	assert.equal(waited.snapshot.failureKind, failureKind);
	// The finalizer drains ownership and publishes the terminal events.
	await waitForTerminalEvents(cwd, run, status);
	const result = JSON.parse(
		await readFile(join(attemptDir(cwd, run), "result.json"), "utf8"),
	);
	assert.equal(result.status, status, "result.json is terminal");
	assert.equal(result.failureKind, failureKind);
	const record = await readRunRecord({ cwd, runId: run.runId });
	assert.equal(record.activeAttemptId, null, "the attempt is not active");
	assert.equal(record.status, status);
	assert.equal(record.failureKind, failureKind);
	const attempt = record.attempts.find(
		(candidate) => candidate.attemptId === run.attemptId,
	);
	assert.equal(attempt.status, status);
	assert.equal(attempt.failureKind, failureKind);
	const snapshot = await getSubagentStatus({ cwd, runId: run.runId });
	assert.equal(snapshot.status, status);
	assert.equal(snapshot.failureKind, failureKind);
	return result;
}

test("pre-release guard failure (barrier timeout) → failed/guard_failure, terminal result, inactive, worktree discarded", async () => {
	const { cwd, effectLog, barrierDir } = fresh("timeout");
	await createRepo(cwd);
	const descriptor = await createDurableLaunchBarrierV2({
		directory: barrierDir,
		subjectSha256: sha256(`subject:${barrierDir}`),
		timeoutMs: 2_000,
		pollIntervalMs: 5,
	});
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "must never run",
		async: true,
		workspace: "worktree",
		durableLaunchBarrier: descriptor,
	});
	// The engine never decides: the worker's barrier wait times out.
	const result = await assertTerminal(cwd, run, "failed", "guard_failure");
	assert.match(
		await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
		/timed out/u,
	);
	assert.equal(result.workspace.mode, "worktree");
	assert.equal(result.workspace.worktreeCleanupStatus, "removed");
	assert.equal(typeof result.workspace.worktreePath, "string");
	assert.equal(
		await exists(result.workspace.worktreePath),
		false,
		"the pristine worktree was discarded",
	);
	const effects = readEffectLog(effectLog);
	assert.deepEqual(
		effects.map((entry) => [entry.type, entry.outcome]),
		[
			["submit", undefined],
			["consume", "rejected"],
		],
		"nothing was executed",
	);
});

test("pre-release engine revoke → cancelled/revoked, terminal result, inactive, finalizer ran", async () => {
	const { cwd, effectLog, barrierDir } = fresh("revoke");
	await mkdir(cwd, { recursive: true });
	const descriptor = await createDurableLaunchBarrierV2({
		directory: barrierDir,
		subjectSha256: sha256(`subject:${barrierDir}`),
		timeoutMs: 20_000,
		pollIntervalMs: 5,
	});
	const revoked = await revokeDurableLaunchBarrierV2(descriptor, {
		cancellationId: "engine-stop",
		reasonSha256: sha256("workflow stopped"),
	});
	assert.equal(revoked.outcome, "revoked");
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "must never run",
		async: true,
		durableLaunchBarrier: descriptor,
	});
	const result = await assertTerminal(cwd, run, "cancelled", "revoked");
	assert.equal(result.workspace.mode, "shared");
	assert.match(
		await readFile(join(attemptDir(cwd, run), "stderr.log"), "utf8"),
		/revoked/u,
	);
	assert.deepEqual(
		readEffectLog(effectLog).map((entry) => [entry.type, entry.outcome]),
		[
			["submit", undefined],
			["consume", "revoked"],
		],
	);
});
