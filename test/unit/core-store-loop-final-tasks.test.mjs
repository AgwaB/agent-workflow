// test-tier: integration
// A loop followed by a stage that reads it (`from`): the loop controller placeholder (`<loop>.loop`) is
// orphaned by dependency rewriting, like a materialized foreach. It must not count as a final task, so the
// consumer's output is the result preview (2026-11-22: `wait` showed "Final result preview: unavailable").
// Real engine, synthetic worker (rehearse --keep). No model, no network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { generatePatternFiles } from "../../dist/core/authoring-patterns.js";
import { rehearseWorkflow } from "../../dist/core/rehearsal.js";
import { finalStageTasks } from "../../dist/core/store.js";
import { summarizeWorkflowTerminal } from "../../dist/core/workflow-terminal.js";

let base;
before(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "aw-loop-final-")));
});
after(async () => {
	await rm(base, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

function findRunJson(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "worker-runs") continue;
			const found = findRunJson(path);
			if (found) return found;
		} else if (
			entry.name === "run.json" &&
			/workflow_/u.test(dirname(path).split("/").pop())
		)
			return path;
	}
	return undefined;
}

for (const loop of ["pass", "exhaust"]) {
	test(`loop-refine (${loop}): the publish stage is the only final task, not the loop controller`, async () => {
		const cwd = join(base, loop);
		const dir = join(cwd, ".agent-workflow/workflows/lr");
		await mkdir(join(dir, "schemas"), { recursive: true });
		for (const file of generatePatternFiles("loop-refine", "lr")) {
			await writeFile(join(dir, ...file.path.split("/")), file.content);
		}
		const { report, stateRoot } = await rehearseWorkflow(cwd, {
			workflow: "lr",
			loop,
			keep: true,
		});
		try {
			assert.equal(report.status, "completed");
			const runPath = findRunJson(stateRoot);
			assert.ok(runPath, "kept state has the run record");
			const run = JSON.parse(readFileSync(runPath, "utf8"));
			assert.ok(
				run.tasks.some((task) => task.kind === "loop"),
				"the loop controller task exists",
			);
			assert.deepEqual(
				finalStageTasks(run.tasks).map((task) => task.specId),
				["publish.main"],
			);
			const summary = await summarizeWorkflowTerminal(cwd, run);
			assert.deepEqual(summary.outputTaskIds, ["publish.main"]);
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});
}

test("a loop with no later stage keeps its existing final tasks", () => {
	const task = (specId, options = {}) => ({
		taskId: `task-${specId}`,
		specId,
		kind: "single",
		status: "completed",
		...options,
	});
	const tasks = [
		task("refine.loop", { kind: "loop" }),
		task("refine.r01.draft", { loopChild: { loopId: "refine", round: 1 } }),
		task("refine.r01.review", {
			dependsOn: ["refine.r01.draft"],
			loopChild: { loopId: "refine", round: 1 },
		}),
	];
	assert.deepEqual(
		finalStageTasks(tasks).map((candidate) => candidate.specId),
		["refine.loop", "refine.r01.review"],
	);
});
