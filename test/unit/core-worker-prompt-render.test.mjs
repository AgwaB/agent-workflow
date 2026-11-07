import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP10): worker prompts name the artifact tool by the executor's visible
// name (src/core/artifact-tool-names.ts) and carry the artifact tool guidelines; the prompt files
// keep the engine's canonical text.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	ARTIFACT_TOOL_NAME_MAPPINGS,
	WORKER_TOOL_NAME_MAPPINGS,
	WORKFLOW_ARTIFACT_TOOL_PLACEHOLDER,
	artifactToolVisibleName,
	renderWorkerPromptToolNames,
	workerToolMappingNote,
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
	for (const id of ["pi", "codex", "claude", "antigravity"]) {
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

// Live bundle 3: a Codex worker told "Only these tools are enabled: read, grep, find, ls, …" has no
// tool by those names and reported SPEC.md "unavailable" without running a command.
test("the renderer maps the enabled logical tool names for Codex and Claude, not for Pi", () => {
	const systemPrompt = [
		"You are workflow subagent 'scout'.",
		"# Effective Tool Policy",
		"Only these tools are enabled for this workflow task: read, grep, find, ls, workflow_artifact.",
		"If the agent definition below mentions tools that are not in this enabled list, ignore those mentions; unavailable tools cannot be called in this workflow run.",
	].join("\n");
	const enabledLine = `Only these tools are enabled for this workflow task: read, grep, find, ls, ${VISIBLE}.`;
	assert.equal(
		renderWorkerPromptToolNames(systemPrompt, "pi"),
		systemPrompt.replace(/ls, workflow_artifact\./u, `ls, ${VISIBLE}.`),
	);
	for (const id of ["codex", "claude"]) {
		const rendered = renderWorkerPromptToolNames(systemPrompt, id);
		const lines = rendered.split("\n");
		assert.equal(lines[2], enabledLine);
		assert.equal(
			lines[3],
			workerToolMappingNote(["read", "grep", "find", "ls", VISIBLE], id),
		);
		assert.equal(lines.length, 5);
		assert.equal(renderWorkerPromptToolNames(rendered, id), rendered);
	}
	const codex = workerToolMappingNote(["read", "grep", "find", "ls"], "codex");
	assert.match(codex, /^On this executor \(codex\) /u);
	assert.match(codex, /read → the shell tool with a read-only command/u);
	assert.match(codex, /ls → the shell tool \(ls\)/u);
	assert.equal(
		workerToolMappingNote(
			["read", "find", "web_search", "fetch_content"],
			"claude",
		),
		"On this executor (claude) these tool names are provided as: read → Read; find → Glob; web_search → WebSearch; fetch_content → WebFetch. Use them for the listed tools; the stage's read-only and tool limits still apply.",
	);
	assert.equal(workerToolMappingNote(["read"], "pi"), undefined);
	assert.equal(workerToolMappingNote([VISIBLE], "codex"), undefined);
	assert.equal(workerToolMappingNote(["read"], "my-cli"), undefined);
	// Every tool the adapters map (docs/executors.md "Tool mapping") has a row.
	for (const id of ["codex", "claude", "antigravity"])
		assert.deepEqual(Object.keys(WORKER_TOOL_NAME_MAPPINGS[id]).sort(), [
			"bash",
			"edit",
			"fetch_content",
			"find",
			"grep",
			"ls",
			"read",
			"web_search",
			"write",
		]);
	// Task prompts have no enabled-tools line and stay as before.
	assert.equal(
		renderWorkerPromptToolNames("Use read/grep/find/ls only.", "codex"),
		"Use read/grep/find/ls only.",
	);
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
			runtimeOverrides: { model: "openai-codex/gpt-5.5", effort: "low" },
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
			join(stateDir(cwd), files.systemPrompt),
			"utf8",
		);
		const taskFile = readFileSync(
			join(stateDir(cwd), files.taskPrompt),
			"utf8",
		);
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

test("antigravity: the enabled-tools note names its tools and says shell search is not available read-only", () => {
	const note = workerToolMappingNote(["read", "grep", "ls"], "antigravity");
	assert.match(
		note,
		/^On this executor \(antigravity\) these tool names are provided as: read → view_file; grep → run_command with rg or grep \(one plain command: no pipes, redirects, \$ or globs on a read-only stage\); ls → run_command with ls or tree/,
	);
});
