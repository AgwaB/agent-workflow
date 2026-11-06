// Stop confirmation must recover a worker that exits without publishing its terminal result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { interruptSubagentTask } from "../../dist/core/task-cancellation.js";
import {
	beginRunRecord,
	captureProcessIdentity,
	readRunRecord,
} from "../../dist/runtime/index.js";

const supported = process.platform === "linux" || process.platform === "darwin";

for (const ignoresTerm of [false, true]) {
	test(`stop confirms worker exit without a finalizer (${ignoresTerm ? "SIGKILL" : "SIGTERM"})`, {
		skip: supported
			? false
			: `process identity unsupported on ${process.platform}`,
	}, async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "aw-stop-reconcile-"));
		const child = spawn(
			process.execPath,
			[
				"-e",
				[
					ignoresTerm ? 'process.on("SIGTERM", () => {});' : "",
					'setInterval(() => {}, 1000); process.stdout.write("ready");',
				].join("\n"),
			],
			{ stdio: ["ignore", "pipe", "inherit"], detached: true },
		);
		const exited = once(child, "exit");
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await exited;
			await rm(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		});
		await once(child.stdout, "data");
		const identity = await captureProcessIdentity(child.pid);
		const runId = "run_stop_reconcile";
		const attemptId = "attempt_stop_reconcile";
		await beginRunRecord({
			cwd,
			runId,
			mode: "single",
			backend: "fake",
			activeAttemptId: attemptId,
			attempts: [
				{
					attemptId,
					status: "running",
					process: {
						workerPid: identity.pid,
						workerProcessGroupId: identity.processGroupId,
						workerProcessBirthIdentity: identity.birthIdentity,
					},
				},
			],
		});
		const ack = await interruptSubagentTask(
			{
				taskId: "task-stop",
				specId: "stop",
				backendHandle: {
					engine: "agent-workflow",
					backend: "runtime",
					cwd,
					runId,
					attemptId,
					runsDir: ".agent-workflow/runs",
				},
			},
			"workflow stopped",
		);
		assert.equal(ack.attemptId, attemptId);
		assert.equal(ack.status, "cancelled");
		assert.equal(ack.interruptStatus, "interrupt-requested");
		assert.equal((await exited)[1], ignoresTerm ? "SIGKILL" : "SIGTERM");
		const record = await readRunRecord({ cwd, runId });
		assert.equal(record.status, "cancelled");
		assert.equal(record.activeAttemptId, null);
		assert.equal(record.attempts[0].failureKind, "user_cancelled");
	});
}
