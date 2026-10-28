// New in agent-workflow (WP19 round 2, re-review N7): stopping the Pi run tracker while
// `restore()` awaits the audience read must not resurrect polling. Before the fix the restore
// went on to track the active run and schedule a timer after `stop()`, and later ticks (no ctx)
// never cleared it. Synthetic run records and fake Pi objects only; no model or agent-CLI calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");

function defer() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

test("N7: stop() during restore()'s audience read leaves no polling timer and no tracked run", async (t) => {
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r2-restore-")),
	);
	t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }));
	const runId = "workflow_wp19r2_restore";
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await fs.mkdir(dir, { recursive: true });
	const at = new Date().toISOString();
	await fs.writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			status: "running",
			name: "restore probe",
			createdAt: at,
			updatedAt: at,
			tasks: [
				{
					taskId: "task-1",
					specId: "a",
					status: "running",
					statusDetail: "running",
					files: { output: ".agent-workflow/x" },
				},
			],
			taskSummary: {
				total: 1,
				completed: 0,
				failed: 0,
				interrupted: 0,
				pending: 0,
				running: 1,
				blocked: 0,
				skipped: 0,
			},
		}),
	);
	await feedback.bindFeedbackAudience(cwd, runId, "A", "command");
	const ctx = fakeCtx(cwd, { sessionId: "A" });
	const tracker = new feedback.PiRunFeedback(fakePi(), { pollMs: 30 });
	const readStarted = defer();
	const resumeRead = defer();
	const realRead = fs.readFile;
	let intercepted = false;
	fs.readFile = async (path, ...args) => {
		if (
			!intercepted &&
			String(path).endsWith(feedback.FEEDBACK_AUDIENCE_FILE)
		) {
			intercepted = true;
			readStarted.resolve();
			await resumeRead.promise;
		}
		return realRead(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		const pending = tracker.restore(ctx);
		await readStarted.promise;
		tracker.stop();
		resumeRead.resolve();
		await pending;
		// A few poll intervals later: still nothing.
		await new Promise((done) => setTimeout(done, 100));
		assert.equal(tracker.isPolling(), false, "polling resurrected after stop");
		assert.deepEqual(tracker.trackedRunIds(), []);
	} finally {
		resumeRead.resolve();
		fs.readFile = realRead;
		syncBuiltinESMExports();
		tracker.stop();
	}
});
