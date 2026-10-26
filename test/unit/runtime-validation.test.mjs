// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) to node:test against dist/:
// test/checks/no-chain.mjs (whole), and the runtime-only parts of
// test/checks/schema-sync.mjs, thinking-levels.mjs, tool-result-budget.mjs and
// output-recovery.mjs. MIT, same author. Changes: see docs/runtime-port.md (test table).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	THINKING_LEVELS,
	createResultEnvelope,
	validateResolveInput,
} from "../../dist/runtime/index.js";

test("no-chain", () => {
	const modeRejected = validateResolveInput({ mode: "chain" });
	assert.equal(modeRejected.ok, false);
	assert.match(modeRejected.failure.error, /unsupported mode/);

	const fieldRejected = validateResolveInput({
		chain: [{ task: "do not run" }],
	});
	assert.equal(fieldRejected.ok, false);
	assert.match(fieldRejected.failure.error, /chain mode is not supported/);
});

test("schema-sync (validation half)", () => {
	// pi-subagent derived the key list from the registered Pi tool schema
	// (src/index.ts, not ported); the probe table itself is kept so every key it
	// names must still be accepted by validateResolveInput.
	const probeValues = {
		backend: "auto",
		visible: true,
		sandbox: true,
		agent: "worker",
		task: "inspect",
		roleContext: "role",
		agentScope: "auto",
		confirmProjectAgents: true,
		mode: "single",
		tasks: [{ agent: "worker", task: "inspect" }],
		concurrency: 2,
		failFast: true,
		cancelSiblingsOnFailure: true,
		asyncDependency: "background",
		workspace: "shared",
		worktree: true,
		worktreePolicy: "auto",
		cwd: ".",
		async: true,
		onComplete: "return",
		timeoutMs: 1000,
		model: "provider/model",
		tools: ["read"],
		systemPrompt: "prompt",
		skills: ["skill"],
		extensions: ["ext"],
		noExtensions: true,
		runsDir: ".agent-workflow/runs",
		correlationId: "corr",
		captureToolCalls: true,
		thinking: "low",
		thinkingLevel: "low",
		reasoningLevel: "low",
	};
	for (const key of Object.keys(probeValues)) {
		const single =
			key === "tasks" || key === "concurrency"
				? { [key]: probeValues[key], tasks: probeValues.tasks }
				: { agent: "worker", task: "inspect", [key]: probeValues[key] };
		const validation = validateResolveInput(single);
		assert.equal(
			validation.ok,
			true,
			`key "${key}" must be accepted by validateResolveInput: ${validation.ok ? "" : validation.failure.error}`,
		);
	}
	const taskLevel = validateResolveInput({
		tasks: [
			{
				agent: "worker",
				task: "inspect",
				captureToolCalls: true,
				noExtensions: true,
			},
		],
	});
	assert.equal(taskLevel.ok, true);
	assert.equal(taskLevel.input.tasks[0].captureToolCalls, true);
	assert.equal(taskLevel.input.tasks[0].noExtensions, true);
});

test("thinking-levels (constants + validation half)", () => {
	assert.deepEqual(THINKING_LEVELS, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	for (const key of ["thinking", "thinkingLevel", "reasoningLevel"]) {
		const validation = validateResolveInput({
			agent: "scout",
			task: "t",
			[key]: "max",
		});
		assert.equal(validation.ok, true, key);
		assert.equal(validation.input.thinking, "max", key);
	}
	const perTask = validateResolveInput({
		tasks: [{ agent: "scout", task: "t", thinking: "max" }],
	});
	assert.equal(perTask.ok, true);
	assert.equal(perTask.input.tasks[0].thinking, "max");
	const rejected = validateResolveInput({
		agent: "scout",
		task: "t",
		thinking: "ultra",
	});
	assert.equal(rejected.ok, false);
	assert.match(rejected.failure.error, /"xhigh", "max"\./);
});

test("tool-result-budget (validation passthrough half)", () => {
	const validBudgetInput = validateResolveInput({
		agent: "worker",
		task: "inspect",
		toolResultBudget: { maxTotalChars: 4096 },
	});
	assert.equal(validBudgetInput.ok, true);
	assert.deepEqual(validBudgetInput.input.toolResultBudget, {
		maxTotalChars: 4096,
	});
	const invalidBudgetInput = validateResolveInput({
		agent: "worker",
		task: "inspect",
		toolResultBudget: { maxTotalChars: "junk" },
	});
	assert.equal(
		invalidBudgetInput.ok,
		true,
		"invalid budget must not fail validation",
	);
	const taskBudgetInput = validateResolveInput({
		tasks: [
			{
				agent: "worker",
				task: "inspect",
				toolResultBudget: { maxTotalChars: 512 },
			},
		],
	});
	assert.equal(taskBudgetInput.ok, true);
	assert.deepEqual(taskBudgetInput.input.tasks[0].toolResultBudget, {
		maxTotalChars: 512,
	});
});

test("output-recovery (result envelope half)", () => {
	const envelope = createResultEnvelope({
		runId: "test",
		attemptId: "one",
		backend: "headless",
		status: "failed",
		cwd: "/tmp",
		metadata: { outputPartial: true },
	});
	assert.equal(
		envelope.metadata.outputPartial,
		true,
		"partial marker survives result serialization",
	);
});

test("generic backends (agent-workflow adaptation)", () => {
	// Executor ids replace the inline/headless/tmux enum; "auto" stays the
	// unresolved marker and is not reported as a failure backend.
	for (const backend of [
		"auto",
		"codex",
		"claude",
		"pi",
		"headless",
		"x.y_z:1-2",
	])
		assert.equal(validateResolveInput({ backend }).ok, true, backend);
	for (const backend of ["", "has space", "-leading", 7]) {
		const rejected = validateResolveInput({ backend });
		assert.equal(rejected.ok, false, String(backend));
		assert.match(rejected.failure.error, /unsupported backend/);
		assert.equal("backend" in rejected.failure, false);
	}
	const knownBackendFailure = validateResolveInput({
		backend: "codex",
		timeoutMs: -1,
	});
	assert.equal(knownBackendFailure.ok, false);
	assert.equal(knownBackendFailure.failure.backend, "codex");
	// The tmux-only `visible` rule and the inline-sandbox rule are gone.
	assert.equal(
		validateResolveInput({ backend: "codex", visible: true }).ok,
		true,
	);
	assert.equal(
		validateResolveInput({ backend: "inline", sandbox: true }).ok,
		true,
	);
	assert.equal(validateResolveInput({ visible: "yes" }).ok, false);
});
