// agent-workflow 2026-11-08 (K2): AGENT_WORKFLOW_EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW drops the failed attempt from an
// output-repair prompt. The live A/B (internal) found the preview anchors the retry on the failed answer's content.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	prepareArtifactGraphRetryTask,
	prepareDagTask,
} from "../../dist/core/artifact-graph-runtime.js";
import { fromStatePath } from "../../dist/core/state-location.js";
import {
	RUN_SCOPED_EXPERIMENTAL_FLAGS,
	EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW_ENV,
	runScopedExperimentalFlagsAtLaunch,
} from "../../dist/core/experimental-speed-flags.js";
import {
	artifactGraphWorkflowSpec,
	createRunRecord,
	makeProject,
	writeAgent,
} from "../helpers/unit-test-support.mjs";

async function retryPrompt(options) {
	const cwd = makeProject();
	writeAgent(cwd, "unit-scout", "read");
	const spec = artifactGraphWorkflowSpec();
	spec.defaults.worktreePolicy = "off";
	const compiled = await compileWorkflow(spec, { cwd });
	const { run } = await createRunRecord(cwd, compiled, join(cwd, "spec.json"));
	const task = run.tasks[0];
	const prepared = await prepareDagTask(cwd, run, compiled, 0);
	const invalid = join(
		dirname(fromStatePath(cwd, task.files.result)),
		"raw.invalid-attempt-1.md",
	);
	mkdirSync(dirname(invalid), { recursive: true });
	writeFileSync(invalid, '<control>{"pick":"FAILED-ANSWER-CONTENT"}</control>');
	task.outputRetry = {
		attempts: 1,
		message: "control is missing required field checkCode",
	};
	return (await prepareArtifactGraphRetryTask(cwd, task, prepared, options))
		.compiledPrompt;
}

test("output repair shows the failed attempt by default and omits it with the K2 switch", async () => {
	const withPreview = await retryPrompt();
	assert.match(withPreview, /# Previous Attempt Preview/);
	assert.match(withPreview, /FAILED-ANSWER-CONTENT/);
	const without = await retryPrompt({ withoutPreview: true });
	assert.doesNotMatch(without, /Previous Attempt Preview/);
	assert.doesNotMatch(without, /FAILED-ANSWER-CONTENT/);
	// The validation error and the retry instructions stay.
	assert.match(without, /# Workflow Output Retry Instructions/);
	assert.match(without, /control is missing required field checkCode/);
});

test("the K2 switch is a run-scoped launch decision", () => {
	assert.ok(
		RUN_SCOPED_EXPERIMENTAL_FLAGS.includes(
			EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW_ENV,
		),
	);
	assert.deepEqual(
		runScopedExperimentalFlagsAtLaunch({
			[EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW_ENV]: "1",
		}),
		[EXPERIMENTAL_REPAIR_WITHOUT_PREVIEW_ENV],
	);
	assert.deepEqual(runScopedExperimentalFlagsAtLaunch({}), []);
});
