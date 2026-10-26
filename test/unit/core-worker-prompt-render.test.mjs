// New in agent-workflow (WP10): worker prompts name the artifact tool by the executor's visible
// name (src/core/artifact-tool-names.ts) and carry the artifact tool guidelines; the prompt files
// keep the engine's canonical text.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	WORKFLOW_ARTIFACT_TOOL_PLACEHOLDER,
	artifactToolVisibleName,
	renderWorkerPromptToolNames,
	workflowArtifactToolGuidelinesSection,
} from "../../dist/core/artifact-tool-names.js";
import { WORKFLOW_ARTIFACT_TOOL_GUIDELINES } from "../../dist/core/artifact-access.js";
import {
	makeProject,
	runDynamicTask,
	setTaskRuntimeApiForTests,
} from "../helpers/unit-test-support.mjs";

const VISIBLE = "mcp__workflow_artifact__workflow_artifact";
const BARE_TOOL_MENTION =
	/(?<![A-Za-z0-9_])workflow_artifact(?![A-Za-z0-9_:])/u;

test("the renderer emits each executor's verified visible artifact tool name", () => {
	const prompt = `Call workflow_artifact with action=list. Use ${WORKFLOW_ARTIFACT_TOOL_PLACEHOLDER} again.`;
	for (const id of ["pi", "codex", "claude"]) {
		const mapping = ARTIFACT_TOOL_NAME_MAPPINGS[id];
		assert.equal(mapping.verified, true, id);
		assert.equal(artifactToolVisibleName(id), mapping.visibleName);
		assert.equal(
			renderWorkerPromptToolNames(prompt, id),
			`Call ${mapping.visibleName} with action=list. Use ${mapping.visibleName} again.`,
		);
	}
	// Unknown executors get the common MCP convention.
	assert.equal(
		renderWorkerPromptToolNames("use workflow_artifact", "my-cli"),
		`use ${VISIBLE}`,
	);
});

test("the renderer leaves evidence locators, longer identifiers and rendered names alone", () => {
	const text = [
		"refs: workflow_artifact:task-3.control",
		"field workflow_artifact_reads and myworkflow_artifact",
		`already ${VISIBLE}`,
		'tools: ["read", "workflow_artifact"]',
		"(workflow_artifact)",
	].join("\n");
	const rendered = renderWorkerPromptToolNames(text, "codex");
	assert.equal(
		rendered,
		[
			"refs: workflow_artifact:task-3.control",
			"field workflow_artifact_reads and myworkflow_artifact",
			`already ${VISIBLE}`,
			`tools: ["read", "${VISIBLE}"]`,
			`(${VISIBLE})`,
		].join("\n"),
	);
	assert.equal(renderWorkerPromptToolNames(rendered, "codex"), rendered);
	assert.deepEqual(workflowArtifactToolGuidelinesSection(), [
		"# Workflow Artifact Tool",
		...WORKFLOW_ARTIFACT_TOOL_GUIDELINES.map((line) => `- ${line}`),
	]);
});

test("the task backend sends rendered prompts with the artifact guidelines and keeps canonical prompt files", async () => {
	const cwd = makeProject();
	try {
		const launched = [];
		setTaskRuntimeApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: "run_prompt_render",
					attemptId: "attempt_prompt_render",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const run = await runDynamicTask(cwd, {
			task: "Research dynamic workflow evaluation methods.",
			runtimeOverrides: { model: "openai-codex/gpt-5.5", thinking: "low" },
		});
		assert.equal(launched.length, 1);
		const [options] = launched;
		assert.equal(options.executor.id, "pi");
		const systemPrompt = String(options.systemPrompt);
		const task = String(options.task);
		assert.match(systemPrompt, /# Workflow Artifact Tool/);
		assert.ok(
			systemPrompt.includes(
				`- Use ${VISIBLE} to inspect upstream workflow artifacts`,
			),
		);
		assert.doesNotMatch(systemPrompt, BARE_TOOL_MENTION);
		assert.doesNotMatch(task, BARE_TOOL_MENTION);

		// The launched task is the dynamic planner (task-1 is the controller placeholder).
		const launchedTask = run.tasks.find((candidate) =>
			String(options.runsDir).endsWith(`/${candidate.taskId}`),
		);
		assert.ok(launchedTask, String(options.runsDir));
		const files = launchedTask.files;
		const systemPromptFile = readFileSync(
			join(cwd, files.systemPrompt),
			"utf8",
		);
		const taskFile = readFileSync(join(cwd, files.taskPrompt), "utf8");
		assert.ok(
			systemPromptFile.includes(
				"- Use workflow_artifact to inspect upstream workflow artifacts",
			),
		);
		assert.equal(
			renderWorkerPromptToolNames(systemPromptFile, "pi"),
			systemPrompt,
		);
		assert.equal(renderWorkerPromptToolNames(taskFile, "pi"), task);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});
