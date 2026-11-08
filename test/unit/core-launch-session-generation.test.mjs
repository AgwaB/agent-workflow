// agent-workflow 2026-11-08 (found by the L4 live check): a foreach child rebuilt by a resume invalidation reuses its
// task id with fresh counters; its attempt identity and session id must carry the source generation, or the
// executor returns the previous generation's attempt (Codex: fence violation). Generation 0 stays byte-identical.
import assert from "node:assert/strict";
import test from "node:test";

import {
	isWorkflowTaskSessionIdentity,
	workflowTaskAttemptIdentity,
	workflowTaskSessionId,
} from "../../dist/core/launch-session.js";

const run = { runId: "workflow_abc_123" };
const child = (sourceGeneration) => ({
	taskId: "task-12",
	specId: "devil-advocate.finding-001",
	artifactGraph: { enabled: true },
	foreachGenerated: {
		placeholderSpecId: "devil-advocate.item",
		itemIdentity: "finding-001",
	},
	...(sourceGeneration === undefined ? {} : { sourceGeneration }),
});

test("generation 0 and absent keep the historical attempt identity and session id", () => {
	for (const task of [child(undefined), child(0)]) {
		const session = workflowTaskSessionId(run, task);
		assert.equal(session, "agent-workflow.workflow_abc_123.task-12");
		assert.equal(
			workflowTaskAttemptIdentity(task, session),
			"launch-retry:0;output-retry:0;resume:0;session:agent-workflow.workflow_abc_123.task-12",
		);
	}
});

test("a rebuilt child (source generation 1, 2) gets a distinct attempt identity and session id", () => {
	const seen = new Set();
	for (const generation of [0, 1, 2]) {
		const task = child(generation);
		const session = workflowTaskSessionId(run, task);
		const identity = workflowTaskAttemptIdentity(task, session);
		assert.equal(seen.has(identity), false, `generation ${generation}`);
		seen.add(identity);
		if (generation > 0) {
			assert.equal(
				session,
				`agent-workflow.workflow_abc_123.task-12.gen-${generation}`,
			);
			assert.match(identity, new RegExp(`;generation:${generation};session:`));
			assert.equal(
				isWorkflowTaskSessionIdentity({
					runId: run.runId,
					taskId: task.taskId,
					launchRetry: 0,
					outputRetry: 0,
					resume: 0,
					sourceGeneration: generation,
					sessionId: session,
				}),
				true,
			);
		}
	}
	// A non-foreach task with a generation (invalidated in place) keeps its resume-based identity.
	const invalidated = {
		taskId: "task-3",
		specId: "dedup.main",
		artifactGraph: { enabled: true },
		generation: 1,
		sourceGeneration: 1,
		resumeEvents: [{}],
	};
	assert.equal(
		workflowTaskSessionId(run, invalidated),
		"agent-workflow.workflow_abc_123.task-3.resume-1",
	);
	assert.doesNotMatch(
		workflowTaskAttemptIdentity(invalidated, "s"),
		/generation:/,
	);
});
