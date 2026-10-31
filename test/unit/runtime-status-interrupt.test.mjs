// New in agent-workflow (WP2a-1): smoke coverage for orchestrate/status.ts and
// orchestrate/interrupt.ts, whose pi-subagent coverage lives in lifecycle.mjs /
// reconcile.mjs (deferred to WP2a-2 because they drive run.ts/async.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	UNKNOWN_BACKEND,
	beginRunRecord,
	captureProcessIdentity,
	createAttemptArtifactStore,
	finishAttemptFromResult,
	getRunStatus,
	interruptRun,
	readRunEvents,
	readRunRecord,
	waitForRun,
} from "../../dist/runtime/index.js";

const supported = process.platform === "linux" || process.platform === "darwin";

test("status: record-only snapshot, result snapshot, wait", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-status-"));
	try {
		process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(cwd, "index");
		await beginRunRecord({
			cwd,
			runId: "run_status",
			mode: "single",
			activeAttemptId: "a1",
			attempts: [{ attemptId: "a1", status: "running" }],
		});
		const running = await getRunStatus({ cwd, runId: "run_status" });
		assert.equal(running.status, "running");
		assert.equal(running.backend, UNKNOWN_BACKEND, "no backend recorded");
		assert.equal(
			running.registryPath,
			".agent-workflow/runs/run_status/run.json",
		);
		const timedOut = await waitForRun({
			cwd,
			runId: "run_status",
			timeoutMs: 30,
			pollIntervalMs: 10,
		});
		assert.equal(timedOut.status, "timeout");

		const store = await createAttemptArtifactStore({
			cwd,
			runId: "run_status",
			attemptId: "a1",
		});
		const output = await store.writeTextArtifact("output", "done\n");
		const result = await store.writeResult({
			backend: "codex",
			status: "completed",
			cwd,
			artifacts: [output],
		});
		await finishAttemptFromResult({ cwd, runId: "run_status" }, result);
		const waited = await waitForRun({
			cwd,
			runId: "run_status",
			timeoutMs: 1000,
			pollIntervalMs: 10,
		});
		assert.equal(waited.outcome, "terminal");
		assert.equal(waited.snapshot.backend, "codex");
		assert.equal(waited.snapshot.status, "completed");
		assert.equal(
			waited.snapshot.resultPath,
			".agent-workflow/runs/run_status/attempts/a1/result.json",
		);
	} finally {
		delete process.env.AGENT_WORKFLOW_RUN_INDEX_DIR;
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("interrupt: signals only an identity-verified process", {
	skip: supported
		? false
		: `process identity unsupported on ${process.platform}`,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-interrupt-"));
	const child = spawn("/bin/sleep", ["30"], {
		stdio: "ignore",
		detached: true,
	});
	try {
		process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(cwd, "index");
		assert.equal(
			(await interruptRun({ cwd, runId: "run_missing" })).status,
			"not-found",
		);
		const identity = await captureProcessIdentity(child.pid);
		await beginRunRecord({
			cwd,
			runId: "run_interrupt",
			mode: "single",
			backend: "codex",
			activeAttemptId: "a1",
			attempts: [
				{
					attemptId: "a1",
					status: "running",
					process: {
						pid: identity.pid,
						processGroupId: identity.processGroupId,
						processBirthIdentity: identity.birthIdentity,
					},
				},
			],
		});
		// A forged birth identity is never signalled.
		await beginRunRecord({
			cwd,
			runId: "run_forged",
			mode: "single",
			activeAttemptId: "a1",
			attempts: [
				{
					attemptId: "a1",
					status: "running",
					process: {
						pid: identity.pid,
						processGroupId: identity.processGroupId,
						processBirthIdentity: `${identity.birthIdentity}0`,
					},
				},
			],
		});
		const forged = await interruptRun({ cwd, runId: "run_forged" });
		assert.equal(forged.status, "unsupported");
		assert.deepEqual(forged.unsupportedAttempts, ["a1"]);

		const exited = once(child, "exit");
		const result = await interruptRun({
			cwd,
			runId: "run_interrupt",
			reason: "test",
			escalateAfterMs: 60_000,
			killAfterMs: 60_000,
		});
		assert.equal(result.status, "interrupt-requested");
		assert.deepEqual(result.interruptedAttempts, ["a1"]);
		const [, signal] = await exited;
		assert.equal(signal, "SIGTERM");
		const record = await readRunRecord({ cwd, runId: "run_interrupt" });
		assert.equal(record.interrupt.signal, "SIGTERM");
		assert.equal(record.interrupt.reason, "test");
		const events = await readRunEvents({ cwd, runId: "run_interrupt" });
		assert.ok(events.some((event) => event.type === "run.interrupt_requested"));
	} finally {
		delete process.env.AGENT_WORKFLOW_RUN_INDEX_DIR;
		try {
			child.kill("SIGKILL");
		} catch {}
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
