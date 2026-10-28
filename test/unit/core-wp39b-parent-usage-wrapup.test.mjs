// New in agent-workflow (WP39b, flaky `host-wp33-pi-parent-usage`): the parent-usage tracker
// decided "the run has settled" from the run index, whose updates are debounced, so a parent
// message right after the run completed was counted as a during-run message and the next one as
// the wrap-up (4 messages instead of 3 under load). It now reads the run record first. Synthetic
// records; no agent CLI, no model call.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const usage = await import("../../dist/core/workflow-parent-usage.js");
const store = await import("../../dist/core/store.js");

const roots = [];
after(async () => {
	for (const root of roots)
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function writeRun(cwd, runId, status) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	mkdirSync(dir, { recursive: true });
	const at = new Date().toISOString();
	writeFileSync(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			name: "wf",
			type: "workflow",
			createdAt: at,
			updatedAt: at,
			tasks: [
				{
					taskId: "task-1",
					specId: "a",
					status,
					statusDetail: status,
					runtime: {},
					files: {},
				},
			],
		}),
	);
}

let stamp = 0;
const assistant = (input) => ({
	role: "assistant",
	content: [],
	usage: {
		input,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 1,
	},
	timestamp: (stamp += 1),
});

test("the first parent message after the run record settled is the wrap-up, even while the index lags", async () => {
	const cwd = realpathSync(await mkdtemp(join(tmpdir(), "aw-wp39b-usage-")));
	roots.push(cwd);
	const runId = "workflow_wrapup";
	writeRun(cwd, runId, "running");
	await store.updateIndex(cwd, [runId]);
	usage.beginParentUsageTracking(cwd, runId, "session-a");
	await usage.recordParentSessionUsage(cwd, assistant(10), "session-a");
	// The run completes; its index entry is not rewritten yet (debounced in the engine).
	writeRun(cwd, runId, "completed");
	assert.equal(
		(await store.readIndex(cwd)).runs.find((run) => run.runId === runId).status,
		"running",
	);
	await usage.recordParentSessionUsage(cwd, assistant(20), "session-a");
	await usage.recordParentSessionUsage(cwd, assistant(40), "session-a");
	const record = JSON.parse(
		readFileSync(
			join(cwd, ".agent-workflow", "workflows", runId, "parent-usage.json"),
			"utf8",
		),
	);
	assert.equal(record.assistantMessages, 2, "one during the run + the wrap-up");
	assert.equal(record.inputTokens, 30);
	assert.ok(record.completedAt);
});
