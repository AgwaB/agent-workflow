// Executor-specific rules live in adapter policy modules; the engine asks what an executor supports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	executorInheritsHostTools,
	executorPolicy,
	validateExecutorFastMode,
} from "../../dist/core/executor-policy.js";
import { resolveExecutorModel } from "../../dist/core/executor-model-id.js";
import { selectWorkflowRuntime } from "../../dist/core/workflow-runtime.js";

test("only an executor whose policy lends host tools inherits them; a missing executor does not", () => {
	assert.equal(executorInheritsHostTools("pi"), true);
	for (const id of ["codex", "claude", "antigravity", "custom", undefined])
		assert.equal(executorInheritsHostTools(id), false, String(id));
	assert.deepEqual(executorPolicy("custom"), {});
});

test("the fast tier is validated only by an executor that has one", () => {
	const runtime = { fast: "on", model: "anthropic/claude-opus-5-5" };
	assert.throws(
		() => validateExecutorFastMode("pi", runtime),
		/fast:on is not supported/,
	);
	assert.doesNotThrow(() => validateExecutorFastMode("codex", runtime));
	assert.doesNotThrow(() => validateExecutorFastMode(undefined, runtime));
	assert.doesNotThrow(() =>
		validateExecutorFastMode("pi", { fast: "off", model: "x/y" }),
	);
});

test("Pi model naming comes from the Pi policy (provider preference for a bare id)", () => {
	const listed = ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"];
	assert.deepEqual(resolveExecutorModel("pi", "gpt-6.1-sol", listed, true), {
		value: "openai-codex/gpt-6.1-sol",
		changed: true,
	});
	assert.deepEqual(resolveExecutorModel("codex", "openai/gpt-6.1-sol"), {
		value: "gpt-6.1-sol",
		changed: true,
	});
});

test("a model suffix is not an effort: effort comes only from the effort field", () => {
	assert.deepEqual(
		selectWorkflowRuntime({ model: "openai/gpt-6.1-sol:high" }),
		{
			model: "openai/gpt-6.1-sol:high",
		},
	);
	assert.deepEqual(
		selectWorkflowRuntime({ model: "openai/gpt-6.1-sol" }, { effort: "low" }),
		{ model: "openai/gpt-6.1-sol", effort: "low" },
	);
});
