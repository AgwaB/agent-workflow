import { stateDir } from "../helpers/state-dir.mjs";
// Session-start catch-up delivers at most five messages without starting a new turn.
// A receipt alone is not proof of delivery; consult the owning session history.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const feedback = await import("../../dist/hosts/pi/feedback.js");

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "surface-regression-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	return cwd;
}

let counter = 0;
async function failedRun(cwd, owner) {
	counter += 1;
	const runId = `workflow_catchup_${counter}`;
	const at = new Date(Date.now() - 60_000 + counter).toISOString();
	const dir = `.agent-workflow/workflows/${runId}/tasks/task-1`;
	const run = {
		schemaVersion: 1,
		runId,
		name: "catch-up",
		type: "artifact-graph",
		status: "failed",
		taskSummary: {
			total: 1,
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 0,
			failed: 1,
			skipped: 0,
			interrupted: 0,
		},
		cwd,
		backend: { type: "local", mode: "headless" },
		createdAt: at,
		updatedAt: at,
		specPath: "spec.json",
		tasks: [
			{
				taskId: "task-1",
				specId: "main",
				status: "failed",
				statusDetail: "failed",
				files: {
					systemPrompt: `${dir}/system.md`,
					taskPrompt: `${dir}/task.md`,
					output: `${dir}/output.log`,
					stderr: `${dir}/stderr.log`,
					result: `${dir}/result.json`,
				},
			},
		],
	};
	await mkdir(join(stateDir(cwd), dir), { recursive: true });
	await writeFile(
		join(stateDir(cwd), ".agent-workflow", "workflows", runId, "run.json"),
		`${JSON.stringify(run)}\n`,
	);
	assert.ok(await feedback.bindFeedbackAudience(cwd, runId, owner, "command"));
	return run;
}

async function sessionStart(pi, cwd, history) {
	const tracker = new feedback.PiRunFeedback(pi, { pollMs: 60_000 });
	try {
		await tracker.restore(fakeCtx(cwd, { sessionId: "owner", history }));
	} finally {
		tracker.stop();
	}
}

test("catch-up delivery cap excludes foreign runs", async (t) => {
	const cwd = await project(t);
	for (let i = 0; i < 7; i += 1)
		await failedRun(cwd, i === 0 ? "owner" : "other");
	const pi = fakePi();
	await sessionStart(pi, cwd);
	assert.equal(pi.messages.length, 1);
	assert.deepEqual(pi.messages[0].options, { triggerTurn: false });
});

test("catch-up cap counts deliveries rather than five existing receipts", async (t) => {
	const cwd = await project(t);
	for (let i = 0; i < 6; i += 1) await failedRun(cwd, "owner");
	// The session's history holds what Pi delivered (WP19: a receipt alone is not proof).
	const history = [];
	const pi = fakePi({ history });
	await sessionStart(pi, cwd, history);
	assert.equal(pi.messages.length, 5);
	await sessionStart(pi, cwd, history);
	assert.equal(pi.messages.length, 6);
	await sessionStart(pi, cwd, history);
	assert.equal(pi.messages.length, 6);
});

// Ported: "canonical skipped dependent stage is shown as skipped, not interrupted". Changes: the run
// is driven in process (`runWorkflowSpec` + `waitForRun`, was `cli.mjs supervise --all`); the stage
// status is the WP34 board's (`stageGroups` + `summarizeTasks` + `statusForSummary` + `statusLabel`
// in src/hosts/pi/board-format.ts, was `WorkflowView.render`); `inspect` is the host API's
// `inspectAction` text.
test("canonical skipped dependent stage is shown as skipped, not interrupted", async (t) => {
	const cwd = await project(t);
	// Support-only run: the default fixture executor stands in for an installed agent CLI.
	await import("../helpers/register-default-executor.mjs");
	const { runWorkflowSpec, waitForRun } = await import(
		"../../dist/core/engine.js"
	);
	const { inspectAction, showAction } = await import("../../dist/hosts/api.js");
	const board = await import("../../dist/hosts/pi/board-format.js");
	const specPath = join(cwd, "spec.json");
	await writeFile(
		join(cwd, "helper.mjs"),
		'export default async()=>{throw new Error("upstream failure")}',
	);
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "skip-fixture",
			artifactGraph: {
				stages: [
					{ id: "upstream", support: { uses: "./helper.mjs" } },
					{
						id: "dependent",
						after: "upstream",
						support: { uses: "./helper.mjs" },
					},
				],
			},
		}),
	);
	const started = await runWorkflowSpec(specPath, cwd, {
		task: "local failure dependency",
	});
	const final = await waitForRun(cwd, started.runId, 60_000);
	assert.equal(final.status, "failed");
	assert.equal(
		final.tasks.find((task) => task.stageId === "dependent").status,
		"skipped",
	);
	const shown = await showAction({ cwd }, { ref: final.runId });
	assert.equal(shown.data.kind, "run");
	const record = shown.data.run;
	const stages = board.stageGroups(final, record);
	const dependent = stages.find((stage) => stage.id === "dependent");
	const status = board.statusForSummary(board.summarizeTasks(dependent.tasks));
	assert.equal(status, "skipped");
	assert.equal(board.statusLabel({}, status), "SKIPPED");
	const inspected = await inspectAction({ cwd }, { runId: final.runId });
	assert.match(inspected.text, /completion: incomplete/);
});
