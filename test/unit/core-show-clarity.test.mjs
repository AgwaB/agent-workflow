// agent-workflow 2026-11-23 (live-checks defects 1/3/4): `status`/`show` say why a task did not finish, in plain words.
// Fixture run records only; the engine-level support-helper case lives in core-support-declared-reason.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

const format = await import("../../dist/core/engine-format.js");

const BOILERPLATE = [
	"Validation error: workflow output protocol was invalid.",
	"Return exactly these sections, in this order, with no prose outside the tags:",
	"<control>{...}</control>",
	"<analysis>...</analysis>",
	"<refs>[...]</refs>",
	"Schema repair guidance:",
	"- Preserve the requested output schema exactly; add missing required fields and remove incompatible shapes rather than adding prose explanations.",
	"Issues:",
	"- $.findings: control JSON schema failed: array length must be >= 16",
].join("\n");

const task = (specId, status, extra = {}) => ({
	taskId: `task-${specId}`,
	specId,
	displayName: specId,
	agent: "scout",
	status,
	statusDetail: status,
	runtime: { model: "m", effort: "medium" },
	dependsOn: [],
	...extra,
});

function runOf(tasks, extra = {}) {
	const count = (status) => tasks.filter((t) => t.status === status).length;
	return {
		runId: "workflow_clarity",
		name: "project-review",
		type: "artifact-graph",
		status: "failed",
		cwd: "/tmp/x",
		createdAt: "2026-11-23T00:00:00.000Z",
		updatedAt: "2026-11-23T00:01:00.000Z",
		tasks,
		taskSummary: {
			total: tasks.length,
			pending: count("pending"),
			running: count("running"),
			blocked: count("blocked"),
			completed: count("completed"),
			failed: count("failed"),
			skipped: count("skipped"),
			interrupted: count("interrupted"),
		},
		...extra,
	};
}

const skippedAfter = (specId, dep) =>
	task(specId, "skipped", {
		statusDetail: "skipped_after_dependency_failure",
		lastMessage: `skipped because dependency ${dep} did not complete`,
		dependsOn: [dep],
	});

test("status and show list tasks skipped for a failed dependency, with the failed input named", () => {
	const run = runOf([
		task("performance-review.main", "completed"),
		task("docs-review.main", "completed"),
		task("security-review.main", "failed", {
			statusDetail: "workflow_output_invalid_exhausted",
			lastMessage: "the model gave up",
		}),
		skippedAfter("merge-findings.main", "security-review.main"),
		skippedAfter("summary.main", "merge-findings.main"),
	]);
	for (const text of [
		format.formatHumanRunStatus(run),
		format.formatHumanRunDetails(run),
	]) {
		assert.match(
			text,
			/Skipped:\n {2}• merge-findings\.main — its input security-review\.main failed\n {2}• summary\.main — its input merge-findings\.main was skipped/u,
			text,
		);
		assert.match(text, /2\/5 completed .* 1 failed · 2 skipped/u, text);
	}
});

test("the Skipped list is capped and says what it leaves out", () => {
	const skipped = [1, 2, 3, 4, 5].map((n) =>
		skippedAfter(`later${n}.main`, "first.main"),
	);
	const run = runOf([task("first.main", "failed"), ...skipped]);
	const text = format.formatHumanRunStatus(run);
	const block = text.slice(text.indexOf("Skipped:"));
	assert.match(block, /later3\.main/u);
	assert.doesNotMatch(block, /later4\.main/u);
	assert.match(block, /… and 2 more skipped/u);
});

test("a skipped task whose input failed for a non-failed reason is still named", () => {
	const run = runOf([
		task("a.main", "blocked"),
		skippedAfter("b.main", "a.main"),
	]);
	assert.match(
		format.formatHumanRunStatus(run),
		/b\.main — its input a\.main was blocked/u,
	);
});

test("show lists the final stage of a run with more than five completed tasks", () => {
	const rounds = [1, 2, 3].flatMap((n) => [
		task(`refine.r0${n}.draft`, "completed", {
			loopChild: { loopId: "refine", round: n },
		}),
		task(`refine.r0${n}.review`, "completed", {
			loopChild: { loopId: "refine", round: n },
		}),
	]);
	const run = runOf(
		[
			task("refine.loop", "completed"),
			...rounds,
			task("publish.main", "completed", { dependsOn: ["refine.loop"] }),
		],
		{ status: "completed" },
	);
	const text = format.formatHumanRunDetails(run);
	const block = text.slice(text.indexOf("Completed:"), text.indexOf("Open:"));
	assert.match(block, /✓ publish\.main/u, text);
	assert.match(block, /… and 3 more completed/u, text);
	assert.equal(block.match(/✓/gu).length, 5, "still capped at five");
});

test("a failed model stage shows the validation issue, not the repair instructions", () => {
	const run = runOf([
		task("security-review.main", "failed", {
			statusDetail: "workflow_output_invalid_exhausted",
			lastMessage: BOILERPLATE,
		}),
	]);
	for (const text of [
		format.formatHumanRunStatus(run),
		format.formatHumanRunDetails(run),
		format.formatHumanRunOutcome(run),
	]) {
		assert.match(
			text,
			/\$\.findings: control JSON schema failed: array length must be >= 16/u,
			text,
		);
		assert.doesNotMatch(text, /Return exactly these sections/u, text);
		assert.doesNotMatch(text, /Schema repair guidance/u, text);
		assert.doesNotMatch(text, /<control>/u, text);
	}
	// The task record keeps the full text.
	assert.match(run.tasks[0].lastMessage, /Schema repair guidance/u);
});

test("several validation issues are listed, bounded", () => {
	const issues = [1, 2, 3, 4, 5].map((n) => `- $.f${n}: bad`).join("\n");
	const run = runOf([
		task("a.main", "failed", {
			lastMessage: `${BOILERPLATE.split("Issues:")[0]}Issues:\n${issues}`,
		}),
	]);
	const text = format.formatHumanRunStatus(run);
	assert.match(text, /\$\.f1: bad/u);
	assert.match(text, /\$\.f3: bad/u);
	assert.doesNotMatch(text, /\$\.f4/u);
	assert.match(text, /and 2 more/u);
});

test("inspect does not count the last, exhausted attempt as an output retry", async () => {
	const { summarizeReliability } = await import("../../dist/hosts/runs.js");
	const output = (...tasks) => summarizeReliability(tasks).outputRetries;
	const retry = (attempts, reason) => ({
		outputRetry: { attempts, maxAttempts: 2, reason },
	});
	// AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES=0: one failing attempt, no retry.
	assert.equal(
		output(task("a", "failed", retry(1, "workflow_output_invalid_exhausted"))),
		0,
	);
	// Default 2 repairs: three attempts, two retries.
	assert.equal(
		output(task("a", "failed", retry(3, "workflow_output_invalid_exhausted"))),
		2,
	);
	// A scheduled (not yet exhausted) repair is a retry.
	assert.equal(
		output(task("a", "pending", retry(1, "workflow_output_invalid"))),
		1,
	);
	// A resume event keeps the same reading of its recorded attempts.
	assert.equal(
		output(
			task("a", "completed", {
				resumeEvents: [
					{
						outputRetryAttempts: 3,
						outputRetryReason: "workflow_output_invalid_exhausted",
					},
				],
			}),
		),
		2,
	);
});

test("a support helper that declared failed or blocked shows its own reason", async () => {
	const runtime = await import("../../dist/core/artifact-graph-runtime.js");
	const message = runtime.supportDeclaredMessage;
	assert.equal(typeof message, "function");
	assert.equal(
		message("failed", {
			digest:
				"1 of 1 file(s) failed: OUTPUT.md missing from the writer worktree",
			gates: { passed: false },
		}),
		"support declared failed: 1 of 1 file(s) failed: OUTPUT.md missing from the writer worktree",
	);
	// No digest given (the default text says nothing): keep the plain verdict.
	assert.equal(
		message("blocked", { status: "blocked" }),
		"support declared blocked",
	);
	// Long or multi-line digests are one bounded line.
	const long = message("failed", { digest: `a\n\n${"b ".repeat(300)}` });
	assert.ok(long.length <= "support declared failed: ".length + 200, long);
	assert.doesNotMatch(long, /\n/u);
	assert.match(long, /…$/u);
	// A non-object output has no reason to show.
	assert.equal(message("failed", "text"), "support declared failed");

	const run = runOf([
		task("final.main", "failed", {
			statusDetail: "support_declared_failed",
			lastMessage: message("failed", {
				digest: "lacks 1 required marker(s)",
			}),
		}),
	]);
	for (const text of [
		format.formatHumanRunStatus(run),
		format.formatHumanRunDetails(run),
	])
		assert.match(
			text,
			/support declared failed: lacks 1 required marker\(s\)/u,
			text,
		);
});
