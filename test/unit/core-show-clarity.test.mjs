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
