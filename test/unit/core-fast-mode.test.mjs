// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/fast-mode.test.mjs. MIT, same author. Changes: imports from dist/core (the config half of workflow-fast-mode-extension.ts is core fast-tier.ts); project agents under .agent-workflow/agents (was .pi/agents). Not ported here (core-port record "WP38"): "task launch prepares a sealed generated Fast extension only for fast:on" and "generated Fast hook preserves payload fields, forces priority, and checks the task model" — superseded by executor-wp35-fast-guard.test.mjs (WP35 moved the provider-stream guard into the Pi executor's per-run extension).
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { buildDynamicGeneratedCompiledTask } from "../../dist/core/dynamic-generated-task-runtime.js";
import { applyWorkflowExecutionProfile } from "../../dist/core/execution-profile.js";
import { createTaskRunRecord } from "../../dist/core/store.js";
import {
	resolveWorkflowFastModeConfig,
	workflowFastEligibleModelIds,
} from "../../dist/core/fast-tier.js";
import { selectWorkflowRuntime } from "../../dist/core/workflow-runtime.js";

const ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-fast-mode-"));

after(() => {
	rmSync(ROOT, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function project() {
	const cwd = mkdtempSync(join(ROOT, "project-"));
	const agentDir = join(cwd, ".agent-workflow", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "fast-worker.md"),
		`---\ndescription: Fast worker\ntools: [read]\nreadOnly: true\n---\nUse repository evidence.\n`,
	);
	writeFileSync(
		join(agentDir, "fast-agent-default.md"),
		`---\ndescription: Fast worker with task defaults\ntools: [read]\nreadOnly: true\nmodel: ${CODEX_FAST_MODEL.fullId}\nfast: on\n---\nUse repository evidence.\n`,
	);
	return cwd;
}

function model(fullId, api) {
	const slash = fullId.indexOf("/");
	return {
		provider: fullId.slice(0, slash),
		id: fullId.slice(slash + 1),
		fullId,
		api,
		reasoning: true,
	};
}

function workflow(defaults = {}, stage = {}) {
	return {
		schemaVersion: 1,
		name: "fast-mode-test",
		defaults: {
			agent: "fast-worker",
			tools: ["read"],
			readOnly: true,
			...defaults,
		},
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Inspect.", ...stage }],
		},
	};
}

const CODEX_FAST_MODEL = model(
	"openai-codex/gpt-5.6-sol",
	"openai-codex-responses",
);

test("fast:on parses and runtime layering preserves explicit inherit/off semantics", () => {
	assert.deepEqual(workflowFastEligibleModelIds(), [
		"openai/gpt-5.4",
		"openai/gpt-5.5",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
		"openai/gpt-5.6-luna",
		"openai/gpt-6-astra",
		"openai/gpt-6-sol",
		"openai/gpt-6-luna",
		"openai/gpt-6.1-sol",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.6",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-6-astra",
		"openai-codex/gpt-6-sol",
		"openai-codex/gpt-6-luna",
		"openai-codex/gpt-6.1-sol",
	]);
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(
			workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
		),
	);
	assert.deepEqual(selectWorkflowRuntime({ fast: "inherit" }, { fast: "on" }), {
		fast: "on",
	});
	assert.deepEqual(selectWorkflowRuntime({ fast: "off" }, { fast: "on" }), {
		fast: "off",
	});
	assert.throws(
		() =>
			resolveWorkflowFastModeConfig({
				fast: "on",
				model: CODEX_FAST_MODEL.fullId,
			}),
		/requires a resolved API binding/,
	);
	const openAiModel = model("openai/gpt-5.4", "openai-responses");
	assert.deepEqual(
		resolveWorkflowFastModeConfig({ fast: "on", model: openAiModel.fullId }, [
			openAiModel,
		]),
		{
			provider: "openai",
			model: "gpt-5.4",
			api: "openai-responses",
			serviceTier: "priority",
		},
	);
});

test("compiler accepts an eligible Fast model and rejects unresolved or unsupported bindings", async () => {
	const cwd = project();
	const compiled = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
		{ cwd, task: "Check fast mode", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(compiled.tasks[0].runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(compiled.tasks[0].runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(compiled.tasks[0].runtime.fast, "on");
	const taskRecord = createTaskRunRecord(
		cwd,
		"workflow_fast_record",
		compiled.tasks[0],
		0,
	);
	assert.equal(taskRecord.runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(taskRecord.runtime.fast, "on");
	const baseline = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId }),
		{ cwd, task: "Check default off", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(baseline.tasks[0].runtime.fast, undefined);
	assert.equal(baseline.tasks[0].runtime.api, undefined);

	const agentDefault = await compileWorkflow(
		workflow({ agent: "fast-agent-default" }),
		{ cwd, task: "Check agent opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(agentDefault.tasks[0].runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(agentDefault.tasks[0].runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(agentDefault.tasks[0].runtime.fast, "on");

	const disabled = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }, { fast: "off" }),
		{ cwd, task: "Check opt-out", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(disabled.tasks[0].runtime.fast, "off");

	const profileSpec = workflow({ model: CODEX_FAST_MODEL.fullId, fast: "off" });
	profileSpec.executionProfiles = { accelerated: { main: { fast: "on" } } };
	parseArtifactGraphWorkflowSpec(profileSpec);
	const profiled = await compileWorkflow(
		applyWorkflowExecutionProfile(profileSpec, "accelerated", undefined).spec,
		{ cwd, task: "Check profile opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(profiled.tasks[0].runtime.fast, "on");

	const foreachSpec = workflow({
		model: CODEX_FAST_MODEL.fullId,
		fast: "off",
	});
	foreachSpec.artifactGraph.stages = [
		{ id: "source", type: "single", prompt: "Produce items." },
		{
			id: "fanout",
			type: "foreach",
			from: { source: "source", path: "$.items" },
			each: { prompt: "Inspect ${item}.", fast: "on" },
		},
	];
	const foreachCompiled = await compileWorkflow(
		parseArtifactGraphWorkflowSpec(foreachSpec),
		{ cwd, task: "Check foreach opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(
		foreachCompiled.tasks.find((task) => task.stageId === "fanout").runtime
			.fast,
		"on",
	);
	const inheritedEachSpec = workflow({
		model: CODEX_FAST_MODEL.fullId,
		fast: "on",
	});
	inheritedEachSpec.artifactGraph.stages = [
		{ id: "source", type: "single", prompt: "Produce items." },
		{
			id: "fanout",
			type: "foreach",
			fast: "off",
			from: { source: "source", path: "$.items" },
			each: { prompt: "Inspect ${item}.", fast: "inherit" },
		},
	];
	const inheritedEach = await compileWorkflow(
		parseArtifactGraphWorkflowSpec(inheritedEachSpec),
		{
			cwd,
			task: "Check foreach inheritance",
			availableModels: [CODEX_FAST_MODEL],
		},
	);
	assert.equal(
		inheritedEach.tasks.find((task) => task.stageId === "fanout").runtime.fast,
		"off",
	);

	const unsupported = model("anthropic/claude-opus-4-6", "anthropic-messages");
	await assert.rejects(
		compileWorkflow(workflow({ model: unsupported.fullId, fast: "on" }), {
			cwd,
			task: "Reject unsupported provider",
			availableModels: [unsupported],
		}),
		/fast:on is not supported for model "anthropic\/claude-opus-4-6"/,
	);
	await assert.rejects(
		compileWorkflow(workflow({ fast: "on" }), {
			cwd,
			task: "Reject unresolved model",
		}),
		/requires a resolved OpenAI model/,
	);
	await assert.rejects(
		compileWorkflow(workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }), {
			cwd,
			task: "Reject API mismatch",
			availableModels: [{ ...CODEX_FAST_MODEL, api: "openai-responses" }],
		}),
		/requires openai-codex-responses.*registered openai-responses/,
	);
});

test("dynamic generated tasks inherit and validate Fast runtime settings", async () => {
	const cwd = project();
	const controllerCompiledTask = {
		id: "adaptive.controller",
		key: "adaptive.controller",
		specId: "adaptive.controller",
		taskId: "controller",
		stageId: "adaptive",
		agent: "dynamic",
		agentPath: "./helpers/controller.mjs",
		agentSystemPrompt: "",
		roleNames: [],
		task: "Run controller.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			model: CODEX_FAST_MODEL.fullId,
			api: CODEX_FAST_MODEL.api,
			fast: "on",
			approvalMode: "non-interactive",
		},
		safety: {
			readOnlyDeclared: false,
			capability: "mutation-capable",
			sharedCwdSafe: false,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
		compiledPrompt: "Run controller.",
		kind: "dynamic",
	};
	const generated = await buildDynamicGeneratedCompiledTask({
		cwd,
		run: {
			runId: "workflow_dynamic_fast_mode",
			provenance: {},
			tasks: [
				{
					specId: "adaptive.controller",
					stageId: "adaptive",
					taskId: "controller",
					status: "running",
				},
			],
		},
		compiledFlow: { tasks: [controllerCompiledTask] },
		controllerCompiledTask,
		controllerSpecId: "adaptive.controller",
		controllerStageId: "adaptive",
		generatedSpecId: "adaptive.worker",
		opId: "op-fast",
		requestHash: "hash-fast",
		request: {
			id: "worker",
			agent: "fast-worker",
			profile: "worker",
			prompt: "Inspect the target.",
			inputs: [],
		},
		dynamic: {
			uses: "./helpers/controller.mjs",
			mode: "graph-splice",
			budget: { maxAgents: 10, maxConcurrency: 2, maxRuntimeMs: 1000 },
			permissions: {
				approval: "auto",
				allowDynamicRoles: true,
				allowDynamicTools: true,
			},
			helpers: {},
			workflows: {},
			decisionLoop: {
				workerDefaults: { tools: ["read"] },
				allowedAgents: [],
				allowedOutputProfiles: [],
			},
		},
	});
	assert.equal(generated.runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(generated.runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(generated.runtime.fast, "on");
});
