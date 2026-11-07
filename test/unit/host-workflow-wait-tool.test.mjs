import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const execFileAsync = promisify(execFile);

const { awaitWithinWorkflowWaitBoundary } = await import(
	"../../dist/core/engine.js"
);
const { acquireRunFileLease, setRunLeaseTestHooksForTests } = await import(
	"../../dist/core/store.js"
);
const { summarizeWorkflowTerminal } = await import(
	"../../dist/core/workflow-terminal.js"
);
const ext = await import("../../dist/hosts/pi/extension.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");

const RUNS = [".agent-workflow", "workflows"];

function runRecord(cwd, overrides = {}) {
	const runId = overrides.runId ?? "workflow_wait_fixture";
	return {
		schemaVersion: 1,
		runId,
		name: "wait-fixture",
		type: "artifact-graph",
		status: "completed",
		taskSummary: {
			total: 1,
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 1,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd,
		createdAt: "2026-07-25T00:00:00.000Z",
		updatedAt: "2026-07-25T00:00:01.000Z",
		specPath: ".agent-workflow/workflows/spec.json",
		tasks: [taskRecord(runId, "task-1", "final")],
		...overrides,
	};
}

function taskRecord(runId, taskId, specId, overrides = {}) {
	const dir = `.agent-workflow/workflows/${runId}/tasks/${taskId}`;
	return {
		taskId,
		specId,
		status: "completed",
		statusDetail: "completed",
		runtime: { model: "test-model", effort: "none" },
		files: {
			systemPrompt: `${dir}/system.md`,
			taskPrompt: `${dir}/task.md`,
			output: `${dir}/output.log`,
			stderr: `${dir}/stderr.log`,
			result: `${dir}/result.json`,
		},
		...overrides,
	};
}

async function writeDynamicControl(cwd, run, control) {
	const path = join(
		stateDir(cwd),
		dirname(run.tasks[0].files.output),
		"control.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(control, null, 2)}\n`);
}

async function writeRunFixture(cwd, run, control = {}, artifacts = {}) {
	const runPath = join(stateDir(cwd), ...RUNS, run.runId, "run.json");
	await mkdir(dirname(runPath), { recursive: true });
	await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
	await writeDynamicControl(cwd, run, control);
	const taskDir = join(stateDir(cwd), dirname(run.tasks[0].files.output));
	for (const [fileName, content] of Object.entries(artifacts)) {
		const artifactPath = join(taskDir, fileName);
		await mkdir(dirname(artifactPath), { recursive: true });
		await writeFile(artifactPath, content);
	}
}

async function writeFeedbackAudience(cwd, runId, sessionId) {
	const audience = await feedback.bindFeedbackAudience(
		cwd,
		runId,
		sessionId,
		"tool",
	);
	assert.equal(audience?.sessionId, sessionId);
}

async function feedbackReceipts(cwd, runId) {
	const dir = join(
		stateDir(cwd),
		...RUNS,
		runId,
		feedback.FEEDBACK_RECEIPTS_DIR,
	);
	const files = await readdir(dir).catch((error) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	return Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map(async (file) => ({
				file,
				receipt: JSON.parse(await readFile(join(dir, file), "utf8")),
			})),
	);
}

/** The Pi host with a fake Pi: `aw_wait` and the session's completion tracker. */
function piHost() {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({
		env: { ...process.env, AGENT_WORKFLOW_ROLE: "supervisor" },
		feedbackPollMs: 50,
	})(pi);
	return { pi, tracker: ext.piRunFeedbackForTests(pi) };
}

async function awWait(cwd, runId, sessionId, { signal, onUpdate } = {}) {
	const { pi } = piHost();
	return pi.tools
		.get("aw_wait")
		.execute(
			`call-${runId}`,
			{ runId, timeoutMs: 60_000 },
			signal ?? new AbortController().signal,
			onUpdate,
			fakeCtx(cwd, { hasUI: false, sessionId }),
		);
}

/** deliverCompletion as an agent-tool launch (follow-up turn), the messages recorded on `pi`. */
async function deliver(cwd, run, sessionId, ctxOptions = {}) {
	const pi = fakePi();
	const ctx = fakeCtx(cwd, { sessionId, ...ctxOptions });
	const outcome = await feedback.deliverCompletion(pi, ctx, run, {
		triggerTurn: true,
	});
	return { outcome, sent: pi.messages.map((entry) => entry.message), ctx };
}

async function tempProject(prefix) {
	return mkdtemp(join(tmpdir(), prefix));
}

test("workflow wait boundary enforces timeout and cancellation without owning the operation", async () => {
	const never = new Promise(() => {});
	const startedAt = Date.now();
	await assert.rejects(
		awaitWithinWorkflowWaitBoundary(
			never,
			25,
			undefined,
			"wait timeout sentinel",
		),
		/wait timeout sentinel/,
	);
	assert.ok(Date.now() - startedAt < 250);

	const controller = new AbortController();
	const aborted = awaitWithinWorkflowWaitBoundary(
		never,
		5_000,
		controller.signal,
		"must not time out",
	);
	controller.abort(new Error("wait cancellation sentinel"));
	await assert.rejects(aborted, /wait cancellation sentinel/);
});

test("run-file lease retries release internally and abandons persistent failures for immediate reclaim", async () => {
	const cwd = await tempProject("aw-wait-lease-hooks-");
	try {
		let initialReleaseAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ initial }) {
				if (initial) throw new Error("initial heartbeat hook failed");
			},
			onBeforeReleaseLockRename() {
				initialReleaseAttempts += 1;
				if (initialReleaseAttempts === 1)
					throw new Error("transient initial release hook failed");
			},
		});
		await assert.rejects(
			acquireRunFileLease(cwd, "workflow_hook_initial", "presentation"),
			/initial heartbeat hook failed/,
		);
		assert.equal(initialReleaseAttempts, 2);

		setRunLeaseTestHooksForTests(undefined);
		const transient = await acquireRunFileLease(
			cwd,
			"workflow_hook_transient",
			"presentation",
		);
		assert.ok(transient);
		let transientAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeReleaseLockRename() {
				transientAttempts += 1;
				if (transientAttempts === 1)
					throw new Error("transient release hook failed");
			},
		});
		await transient.release();
		assert.equal(transientAttempts, 2);

		setRunLeaseTestHooksForTests(undefined);
		const persistent = await acquireRunFileLease(
			cwd,
			"workflow_hook_persistent",
			"presentation",
		);
		assert.ok(persistent);
		let persistentAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeReleaseLockRename() {
				persistentAttempts += 1;
				throw new Error("persistent release hook failed");
			},
		});
		await assert.rejects(
			persistent.release(),
			/persistent release hook failed/,
		);
		assert.equal(persistentAttempts, 3);
		setRunLeaseTestHooksForTests(undefined);
		const childScript = `
			import { acquireRunFileLease } from ${JSON.stringify(
				new URL("../../dist/core/store.js", import.meta.url).href,
			)};
			const lease = await acquireRunFileLease(
				process.env.RECLAIM_CWD,
				"workflow_hook_persistent",
				"presentation",
				500,
			);
			if (!lease) throw new Error("child could not reclaim abandoned lease");
			await lease.release();
			process.stdout.write("reclaimed");
		`;
		const child = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", childScript],
			{ env: { ...process.env, RECLAIM_CWD: cwd } },
		);
		assert.equal(child.stdout, "reclaimed");

		const racing = await acquireRunFileLease(
			cwd,
			"workflow_hook_release_reclaim_race",
			"presentation",
		);
		assert.ok(racing);
		const releaseHookEntered = Promise.withResolvers();
		const continueRelease = Promise.withResolvers();
		setRunLeaseTestHooksForTests({
			async onBeforeReleaseLockRename({ lockFile }) {
				if (!lockFile.includes("workflow_hook_release_reclaim_race")) return;
				releaseHookEntered.resolve();
				await continueRelease.promise;
			},
		});
		const racingRelease = racing.release();
		await releaseHookEntered.promise;
		// Ordinary cleanup retains exclusive ownership until its rename.
		assert.equal(
			await acquireRunFileLease(
				cwd,
				"workflow_hook_release_reclaim_race",
				"presentation",
				0,
			),
			undefined,
		);
		continueRelease.resolve();
		await racingRelease;
		const reclaimedRace = await acquireRunFileLease(
			cwd,
			"workflow_hook_release_reclaim_race",
			"presentation",
			500,
		);
		assert.ok(reclaimedRace);
		setRunLeaseTestHooksForTests(undefined);
		await reclaimedRace.release();

		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ initial }) {
				if (initial) throw new Error("persistent initial heartbeat failure");
			},
			onBeforeReleaseLockRename() {
				throw new Error("persistent initial cleanup failure");
			},
		});
		await assert.rejects(
			acquireRunFileLease(
				cwd,
				"workflow_hook_persistent_initial",
				"presentation",
			),
			/Failed to initialize and release run-file lease/,
		);
		setRunLeaseTestHooksForTests(undefined);
		const reclaimedInitial = await acquireRunFileLease(
			cwd,
			"workflow_hook_persistent_initial",
			"presentation",
		);
		assert.ok(reclaimedInitial);
		await reclaimedInitial.release();
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("successful completion feedback preserves the authoritative result and report paths", async () => {
	const cwd = await tempProject("aw-result-only-feedback-");
	try {
		const run = runRecord(cwd, { runId: "workflow_result_only" });
		await writeRunFixture(
			cwd,
			run,
			{
				completionSummaryMarkdown:
					"## Core conclusion\n\nUse the verified result.\n\n## Evidence level\n\n- 4 verified claims.",
				executiveMarkdown: "# Full report\n\nFULL_REPORT_ONLY_TEXT",
				sidecarPath: "final-report.md",
				auditSidecarPath: "audit.md",
			},
			{
				"final-report.md": "# Full report\n\nFULL_REPORT_ONLY_TEXT",
				"audit.md": "# Evidence audit\n\nAUDIT_ONLY_TEXT",
			},
		);
		await writeFeedbackAudience(cwd, run.runId, "session-result-only");
		const { outcome, sent } = await deliver(cwd, run, "session-result-only");
		assert.equal(outcome, "delivered");
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /Use the verified result/);
		assert.match(sent[0].content, /without re-summarizing/);
		assert.match(sent[0].content, /Preserve factual wording, counts/);
		assert.match(sent[0].content, /## Detailed reports/);
		assert.match(
			sent[0].content,
			/workflow_result_only\/tasks\/task-1\/final-report\.md/,
		);
		assert.match(
			sent[0].content,
			/workflow_result_only\/tasks\/task-1\/audit\.md/,
		);
		assert.doesNotMatch(
			sent[0].content,
			/FULL_REPORT_ONLY_TEXT|AUDIT_ONLY_TEXT/,
		);
		assert.doesNotMatch(sent[0].content, /Open: \/(?:aw|workflow)/);
		assert.doesNotMatch(sent[0].content, /completed, 0 failed/);
		assert.doesNotMatch(sent[0].content, /link relevant artifacts/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("immutable completion receipt precedes best-effort UI notification", async () => {
	const cwd = await tempProject("aw-wait-notify-");
	try {
		const run = runRecord(cwd, { runId: "workflow_notify_best_effort" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-notify");
		const pi = fakePi();
		const ctx = fakeCtx(cwd, { sessionId: "session-notify" });
		ctx.ui.notify = () => {
			throw new Error("UI notification failed");
		};
		const outcome = await feedback.deliverCompletion(pi, ctx, run, {
			triggerTurn: true,
		});
		assert.equal(outcome, "delivered");
		assert.equal(pi.messages.length, 1);
		const receipts = await feedbackReceipts(cwd, run.runId);
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0].receipt.sessionId, "session-notify");
		assert.equal(receipts[0].receipt.epoch, feedback.feedbackEpoch(run));
		// Same session runtime (queue): the epoch is not sent again (WP19: another runtime without
		// readable history may get it once more, at least once, never lost).
		const repeated = await feedback.deliverCompletion(pi, ctx, run, {
			triggerTurn: true,
		});
		assert.equal(repeated, "already-delivered");
		assert.equal(pi.messages.length, 1);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("terminal delivery epochs allow same-status resume (legacy marker half not applicable)", async () => {
	const cwd = await tempProject("aw-wait-epochs-");
	try {
		const base = runRecord(cwd, { runId: "workflow_same_status_resume" });
		const first = {
			...base,
			status: "failed",
			taskSummary: { ...base.taskSummary, completed: 0, failed: 1 },
			tasks: [
				{
					...base.tasks[0],
					status: "failed",
					statusDetail: "first failure",
					completedAt: "2026-07-25T00:00:01.000Z",
				},
			],
		};
		await writeRunFixture(cwd, first);
		await writeFeedbackAudience(cwd, first.runId, "session-epochs");
		const pi = fakePi();
		const ctx = fakeCtx(cwd, { sessionId: "session-epochs" });
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, first, { triggerTurn: false }),
			"delivered",
		);
		const resumed = {
			...first,
			updatedAt: "2026-07-25T00:00:03.000Z",
			tasks: [
				{
					...first.tasks[0],
					statusDetail: "second failure",
					completedAt: "2026-07-25T00:00:03.000Z",
					resumeEvents: [
						{
							at: "2026-07-25T00:00:02.000Z",
							fromStatus: "failed",
							fromStatusDetail: "first failure",
						},
					],
				},
			],
		};
		assert.notEqual(
			feedback.feedbackEpoch(resumed),
			feedback.feedbackEpoch(first),
		);
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, resumed, {
				triggerTurn: false,
			}),
			"delivered",
		);
		assert.equal(pi.messages.length, 2);
		assert.equal((await feedbackReceipts(cwd, first.runId)).length, 2);
		// The same settled state is one epoch: never delivered twice.
		assert.equal(
			await feedback.deliverCompletion(pi, ctx, resumed, {
				triggerTurn: false,
			}),
			"already-delivered",
		);
		assert.equal(pi.messages.length, 2);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("feedback watcher stops after retry exhaustion and warns once", async () => {
	const cwd = await tempProject("aw-wait-watcher-exhausted-");
	try {
		const run = runRecord(cwd, { runId: "workflow_watcher_exhausted" });
		await writeRunFixture(cwd, run);
		const pi = fakePi();
		let sends = 0;
		pi.sendMessage = () => {
			sends += 1;
			throw new Error("persistent send failure");
		};
		const tracker = new feedback.PiRunFeedback(pi, { pollMs: 60_000 });
		const ctx = fakeCtx(cwd, { sessionId: "session-watcher-exhausted" });
		try {
			assert.equal(await tracker.track(ctx, run.runId, "tool"), true);
			for (let tick = 0; tick < 8; tick += 1) await tracker.tick();
			assert.equal(sends, 4);
			const warnings = ctx.notes.filter((note) => note.type === "error");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0].message, /persistent send failure/);
			assert.match(warnings[0].message, new RegExp(`/aw status ${run.runId}`));
			assert.deepEqual(tracker.trackedRunIds(), []);
		} finally {
			tracker.stop();
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow wait returns a terminal result without model polling", async () => {
	const cwd = await tempProject("aw-wait-tool-");
	try {
		const run = runRecord(cwd);
		const completionSummaryMarkdown = `\n  ${[
			"## Core conclusion",
			"Completed result from the workflow.  ",
			"Multibyte evidence: café 🚀  ",
			"evidence ".repeat(800).trim(),
			"PRESERVED_SUMMARY_TAIL",
		].join("\n\n")}\n\n`;
		assert.ok(completionSummaryMarkdown.length > 6000);
		await writeRunFixture(
			cwd,
			run,
			{
				completionSummaryMarkdown,
				executiveMarkdown: "# Full report\n\nFULL_REPORT_ONLY_TEXT",
				sidecarPath: "final-report.md",
				auditSidecarPath: "audit.md",
			},
			{
				"final-report.md": "# Full report\n\nFULL_REPORT_ONLY_TEXT",
				"audit.md": "# Evidence audit\n\nAUDIT_ONLY_TEXT",
			},
		);
		await writeFeedbackAudience(cwd, run.runId, "session-wait-test");
		const result = await awWait(cwd, run.runId, "session-wait-test");
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.semanticStatus, "completed");
		assert.equal(result.details.terminal, true);
		assert.equal(result.details.preview, completionSummaryMarkdown);
		assert.match(result.content[0].text, /PRESERVED_SUMMARY_TAIL/);
		assert.doesNotMatch(result.content[0].text, /… truncated/);
		assert.match(result.content[0].text, /## Detailed reports/);
		assert.match(
			result.content[0].text,
			/workflow_wait_fixture\/tasks\/task-1\/final-report\.md/,
		);
		assert.match(
			result.content[0].text,
			/workflow_wait_fixture\/tasks\/task-1\/audit\.md/,
		);
		assert.doesNotMatch(result.content[0].text, /Workflow terminal|Run:/);
		assert.doesNotMatch(
			result.content[0].text,
			/FULL_REPORT_ONLY_TEXT|AUDIT_ONLY_TEXT/,
		);
		assert.deepEqual(result.details.reportArtifacts, [
			{
				kind: "final-report",
				label: "Final report",
				path: ".agent-workflow/workflows/workflow_wait_fixture/tasks/task-1/final-report.md",
			},
			{
				kind: "evidence-audit",
				label: "Evidence audit",
				path: ".agent-workflow/workflows/workflow_wait_fixture/tasks/task-1/audit.md",
			},
		]);
		// WP33: the owning session's wait is the presentation (one receipt, no message).
		assert.equal(typeof result.details.feedbackEpoch, "string");
		assert.equal((await feedbackReceipts(cwd, run.runId)).length, 1);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow wait reports blocked action-required state without a final preview", async () => {
	const cwd = await tempProject("aw-wait-blocked-");
	try {
		const base = runRecord(cwd, { runId: "workflow_wait_blocked" });
		const run = {
			...base,
			status: "blocked",
			taskSummary: { ...base.taskSummary, completed: 0, blocked: 1 },
			tasks: [
				{
					...base.tasks[0],
					status: "blocked",
					statusDetail: "approval_required",
					lastMessage: "Approval is required.",
				},
			],
		};
		await writeRunFixture(cwd, run, {
			executiveMarkdown: "Intermediate text must not become a final result.",
		});
		await writeFeedbackAudience(cwd, run.runId, "session-blocked");
		const result = await awWait(cwd, run.runId, "session-blocked");
		assert.equal(result.details.terminal, false);
		assert.equal(result.details.actionRequired, true);
		assert.equal(result.details.preview, undefined);
		assert.deepEqual(result.details.blockedTaskIds, ["final"]);
		assert.match(result.content[0].text, /Workflow blocked; action required/);
		assert.doesNotMatch(result.content[0].text, /Intermediate text/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

function directDynamicRun(cwd, runId, overrides = {}) {
	return runRecord(cwd, {
		runId,
		provenance: { mode: "direct-dynamic" },
		tasks: [
			taskRecord(runId, "controller", "dynamic.controller", {
				kind: "dynamic",
				statusDetail: "dynamic_completed",
			}),
			taskRecord(runId, "synthesis", "dynamic.synthesis", {
				dynamicGenerated: { outputProfile: "synthesis_v1" },
			}),
		],
		...overrides,
	});
}

test("result-only completion is limited to successful semantic statuses with output", async () => {
	const cwd = await tempProject("aw-result-only-statuses-");
	try {
		for (const [status, preview] of [
			["synthesized", "Synthesized result."],
			["exhausted", "Exhausted result."],
		]) {
			const runId = `workflow_result_only_${status}`;
			const run = directDynamicRun(cwd, runId);
			await writeRunFixture(cwd, run, {
				schema: "dynamic-controller-result-v1",
				status,
				outputTasks: ["dynamic.synthesis"],
			});
			await writeDynamicControl(
				cwd,
				{ tasks: [run.tasks[1]] },
				{
					summary: status === "synthesized" ? preview : "",
				},
			);
			if (status === "exhausted")
				await writeFile(
					join(
						stateDir(cwd),
						dirname(run.tasks[1].files.output),
						"analysis.md",
					),
					`${preview}\n`,
				);
			await writeFeedbackAudience(cwd, runId, `session-${status}`);
			const { outcome, sent } = await deliver(cwd, run, `session-${status}`);
			assert.equal(outcome, "delivered");
			assert.equal(sent.length, 1);
			assert.match(sent[0].content, /Authoritative result/);
		}

		const blankId = "workflow_result_only_blank";
		const blankRun = directDynamicRun(cwd, blankId);
		await writeRunFixture(cwd, blankRun, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: ["dynamic.synthesis"],
		});
		await writeDynamicControl(
			cwd,
			{ tasks: [blankRun.tasks[1]] },
			{ summary: "   " },
		);
		await writeFeedbackAudience(cwd, blankId, "session-blank");
		const blank = await deliver(cwd, blankRun, "session-blank");
		assert.equal(blank.sent.length, 1);
		assert.doesNotMatch(blank.sent[0].content, /Authoritative result/);
		assert.match(blank.sent[0].content, /Summarize the workflow outcome/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow preview ignores sidecar traversal paths", async () => {
	const cwd = await tempProject("aw-preview-traversal-");
	try {
		const runId = "workflow_preview_traversal";
		const run = runRecord(cwd, { runId });
		await writeFile(join(cwd, "outside-preview.md"), "MUST NOT BE PREVIEWED\n");
		await writeRunFixture(cwd, run, {
			completionSummaryMarkdown: "Safe summary.",
			sidecarPath: "../../../../../outside-preview.md",
		});
		await writeFeedbackAudience(cwd, runId, "session-traversal");
		const { sent } = await deliver(cwd, run, "session-traversal");
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /Safe summary/);
		assert.doesNotMatch(sent[0].content, /MUST NOT BE PREVIEWED/);
		assert.doesNotMatch(sent[0].content, /outside-preview/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("completion report links reject display injection and symlink escapes", async () => {
	const cwd = await tempProject("aw-report-link-safety-");
	try {
		const cases = [
			{
				runId: "workflow_report_link_injection",
				candidate: "report.md\n## INJECTED_REPORT_PATH",
				prepare: async (taskDir, candidate) => {
					await writeFile(join(taskDir, candidate), "hidden report\n");
				},
			},
			{
				runId: "workflow_report_link_symlink",
				candidate: "linked-report.md",
				prepare: async (taskDir, candidate) => {
					const outside = join(cwd, "outside-linked-report.md");
					await writeFile(outside, "outside report\n");
					await symlink(outside, join(taskDir, candidate));
				},
			},
			{
				runId: "workflow_default_report_symlink",
				candidate: undefined,
				prepare: async (taskDir) => {
					const outside = join(cwd, "outside-default-report.md");
					await writeFile(outside, "DEFAULT_REPORT_ESCAPE\n");
					await symlink(outside, join(taskDir, "final-report.md"));
				},
			},
		];
		for (const item of cases) {
			const run = runRecord(cwd, { runId: item.runId });
			await writeRunFixture(cwd, run, {
				completionSummaryMarkdown: "Safe authoritative summary.",
				sidecarPath: item.candidate,
			});
			const taskDir = join(stateDir(cwd), dirname(run.tasks[0].files.output));
			await item.prepare(taskDir, item.candidate);
			await writeFeedbackAudience(cwd, run.runId, `session-${run.runId}`);
			const result = await awWait(cwd, run.runId, `session-${run.runId}`);
			assert.match(result.content[0].text, /Safe authoritative summary/);
			assert.deepEqual(result.details.reportArtifacts, []);
			assert.doesNotMatch(
				result.content[0].text,
				/INJECTED_REPORT_PATH|linked-report|outside report|DEFAULT_REPORT_ESCAPE/,
			);
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("completion report links reject injected task-directory display paths", async () => {
	const cwd = await tempProject("aw-report-prefix-safety-");
	try {
		const runId = "workflow_report_prefix_escape";
		const dir = `.agent-workflow/workflows/${runId}/tasks/task-\`INJECTED`;
		const run = runRecord(cwd, {
			runId,
			tasks: [
				taskRecord(runId, "task-1", "final", {
					files: {
						systemPrompt: `${dir}/system.md`,
						taskPrompt: `${dir}/task.md`,
						output: `${dir}/output.log`,
						stderr: `${dir}/stderr.log`,
						result: `${dir}/result.json`,
					},
				}),
			],
		});
		await writeRunFixture(
			cwd,
			run,
			{
				completionSummaryMarkdown: "Safe authoritative summary.",
				sidecarPath: "final-report.md",
			},
			{ "final-report.md": "hidden report\n" },
		);
		await writeFeedbackAudience(cwd, run.runId, "session-prefix-link");
		const result = await awWait(cwd, run.runId, "session-prefix-link");
		assert.match(result.content[0].text, /Safe authoritative summary/);
		assert.deepEqual(result.details.reportArtifacts, []);
		assert.doesNotMatch(result.content[0].text, /INJECTED|hidden report/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow preview rejects a control.json symlink escape", async () => {
	const cwd = await tempProject("aw-control-link-safety-");
	try {
		const run = runRecord(cwd, { runId: "workflow_control_link_escape" });
		await writeRunFixture(cwd, run);
		const taskDir = join(stateDir(cwd), dirname(run.tasks[0].files.output));
		await rm(join(taskDir, "control.json"));
		const outside = join(cwd, "outside-control.json");
		await writeFile(
			outside,
			JSON.stringify({ completionSummaryMarkdown: "EXTERNAL_CONTROL_ESCAPE" }),
		);
		await symlink(outside, join(taskDir, "control.json"));
		await writeFeedbackAudience(cwd, run.runId, "session-control-link");
		const { sent } = await deliver(cwd, run, "session-control-link");
		assert.equal(sent.length, 1);
		assert.doesNotMatch(sent[0].content, /EXTERNAL_CONTROL_ESCAPE/);
		assert.match(sent[0].content, /Summarize the workflow outcome/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("direct dynamic synthesis rejects normalized raw protocol aliases", async () => {
	const cwd = await tempProject("aw-raw-alias-safety-");
	try {
		const runId = "workflow_raw_alias_escape";
		const run = directDynamicRun(cwd, runId);
		await writeRunFixture(cwd, run, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesis"],
		});
		const taskDir = join(stateDir(cwd), dirname(run.tasks[1].files.output));
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[1]] },
			{ sidecarPath: "raw.md/." },
		);
		await writeFile(join(taskDir, "raw.md"), "RAW_ALIAS_ESCAPE\n");
		await writeFeedbackAudience(cwd, runId, "session-raw-alias");
		const { sent } = await deliver(cwd, run, "session-raw-alias");
		assert.equal(sent.length, 1);
		assert.doesNotMatch(sent[0].content, /RAW_ALIAS_ESCAPE/);
		assert.match(sent[0].content, /Summarize the workflow outcome/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("direct dynamic synthesis previews validated analysis, never protocol wrappers", async () => {
	const cwd = await tempProject("aw-preview-dynamic-");
	try {
		const runId = "workflow_preview_dynamic";
		const run = directDynamicRun(cwd, runId);
		await writeRunFixture(cwd, run, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesis"],
		});
		const taskDir = join(stateDir(cwd), dirname(run.tasks[1].files.output));
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[1]] },
			{
				summary: "",
				sidecarPath: "raw.md",
			},
		);
		await writeFile(
			join(taskDir, "analysis.md"),
			"Validated synthesis analysis.\n",
		);
		await writeFile(
			join(taskDir, "raw.md"),
			"<control>RAW PROTOCOL</control>\n",
		);
		await writeFile(
			join(taskDir, "output.log"),
			"<analysis>RAW WRAPPER</analysis>\n",
		);
		await writeFeedbackAudience(cwd, runId, "session-dynamic-preview");
		const { sent } = await deliver(cwd, run, "session-dynamic-preview");
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /Validated synthesis analysis/);
		assert.doesNotMatch(sent[0].content, /RAW PROTOCOL|RAW WRAPPER/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow wait previews the declared dynamic output instead of the last completed task", async () => {
	const cwd = await tempProject("aw-wait-output-");
	try {
		const runId = "workflow_wait_authoritative_output";
		const run = runRecord(cwd, {
			runId,
			provenance: { mode: "direct-dynamic" },
			taskSummary: {
				total: 3,
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 3,
				failed: 0,
				skipped: 0,
				interrupted: 0,
			},
			tasks: [
				taskRecord(runId, "task-1", "dynamic.controller", {
					kind: "dynamic",
					statusDetail: "dynamic_completed",
				}),
				taskRecord(runId, "task-2", "dynamic.synthesis-final"),
				taskRecord(runId, "task-3", "dynamic.intermediate-tail"),
			],
		});
		await writeRunFixture(cwd, run, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesis-final"],
		});
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[1]] },
			{
				executiveMarkdown: "Authoritative synthesized answer.",
			},
		);
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[2]] },
			{
				executiveMarkdown: "Misleading later intermediate output.",
			},
		);
		await writeFeedbackAudience(cwd, run.runId, "session-output");
		const result = await awWait(cwd, runId, "session-output");
		assert.deepEqual(result.details.outputTaskIds, ["dynamic.synthesis-final"]);
		assert.match(result.details.preview, /Authoritative synthesized/);
		assert.doesNotMatch(
			result.details.preview,
			/Misleading later intermediate/,
		);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow wait never falls back to an upstream artifact when the final task failed", async () => {
	const cwd = await tempProject("aw-wait-failed-final-");
	try {
		const runId = "workflow_wait_failed_final";
		const run = runRecord(cwd, {
			runId,
			status: "failed",
			taskSummary: {
				total: 2,
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 1,
				failed: 1,
				skipped: 0,
				interrupted: 0,
			},
			tasks: [
				taskRecord(runId, "task-1", "research"),
				taskRecord(runId, "task-2", "final", {
					status: "failed",
					statusDetail: "workflow_output_invalid_exhausted",
					dependsOn: ["research"],
				}),
			],
		});
		await writeRunFixture(cwd, run);
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[0]] },
			{
				executiveMarkdown: "Upstream output is not the final answer.",
			},
		);
		await writeFeedbackAudience(cwd, run.runId, "session-failed-final");
		const result = await awWait(cwd, runId, "session-failed-final");
		assert.equal(result.details.terminal, true);
		assert.deepEqual(result.details.outputTaskIds, ["final"]);
		assert.equal(result.details.preview, undefined);
		assert.doesNotMatch(result.content[0].text, /Upstream output/);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

function controllerTask(cwd, runId, overrides = {}) {
	const base = runRecord(cwd).tasks[0];
	return {
		...base,
		specId: "dynamic.controller",
		statusDetail: "dynamic_completed",
		files: {
			...base.files,
			output: `.agent-workflow/workflows/${runId}/tasks/task-1/output.log`,
		},
		...overrides,
	};
}

test("terminal summary distinguishes dynamic synthesis from exhausted no-output completion", async () => {
	const cwd = await tempProject("aw-wait-summary-");
	try {
		const synthesized = runRecord(cwd, {
			runId: "workflow_dynamic_synthesized",
			provenance: { mode: "direct-dynamic" },
			tasks: [
				controllerTask(cwd, "workflow_dynamic_synthesized", {
					outputRetry: { attempts: 1 },
					launchRetry: { attempts: 2 },
				}),
			],
		});
		await writeDynamicControl(cwd, synthesized, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesize-r1"],
		});
		const synthesizedSummary = await summarizeWorkflowTerminal(
			cwd,
			synthesized,
		);
		assert.equal(synthesizedSummary.semanticStatus, "synthesized");
		assert.deepEqual(synthesizedSummary.outputTaskIds, [
			"dynamic.synthesize-r1",
		]);
		assert.equal(synthesizedSummary.outputRetryAttempts, 1);
		assert.equal(synthesizedSummary.launchRetryAttempts, 2);

		const exhausted = runRecord(cwd, {
			runId: "workflow_dynamic_exhausted",
			provenance: { mode: "direct-dynamic" },
			tasks: [controllerTask(cwd, "workflow_dynamic_exhausted")],
		});
		await writeDynamicControl(cwd, exhausted, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: [],
		});
		const exhaustedSummary = await summarizeWorkflowTerminal(cwd, exhausted);
		assert.equal(exhaustedSummary.semanticStatus, "exhausted_without_output");
		assert.equal(exhaustedSummary.engineStatus, "completed");

		const incomplete = {
			...exhausted,
			runId: "workflow_dynamic_incomplete",
			status: "failed",
			taskSummary: { ...exhausted.taskSummary, completed: 0, failed: 1 },
			tasks: [
				controllerTask(cwd, "workflow_dynamic_incomplete", {
					status: "failed",
					statusDetail: "dynamic_incomplete",
				}),
			],
		};
		await writeDynamicControl(cwd, incomplete, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: [],
		});
		const incompleteSummary = await summarizeWorkflowTerminal(cwd, incomplete);
		assert.equal(incompleteSummary.engineStatus, "failed");
		assert.equal(incompleteSummary.semanticStatus, "dynamic_incomplete");
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("terminal summary reports static degradation without changing engine status", async () => {
	const cwd = await tempProject("aw-wait-static-");
	try {
		const run = runRecord(cwd, {
			degradation: {
				finalOutputRendered: true,
				failedTaskIds: ["task-2"],
				degradedHelperTaskIds: [],
				summary: "one non-final task failed",
			},
		});
		const summary = await summarizeWorkflowTerminal(cwd, run);
		assert.equal(summary.engineStatus, "completed");
		assert.equal(summary.semanticStatus, "completed_degraded");
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
