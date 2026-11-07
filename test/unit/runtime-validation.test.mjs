import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createResultEnvelope,
	validateResolveInput,
} from "../../dist/runtime/index.js";

test("unknown run and task fields are refused by name; mode is checked", () => {
	const modeRejected = validateResolveInput({ mode: "chain" });
	assert.equal(modeRejected.ok, false);
	assert.match(modeRejected.failure.error, /unsupported mode/);
	for (const [input, field] of [
		[{ task: "t", unknownField: 1 }, "unknownField"],
		[{ tasks: [{ task: "t", extra: true }] }, "tasks[0].extra"],
	]) {
		const rejected = validateResolveInput(input, "fixture");
		assert.equal(rejected.ok, false, field);
		assert.equal(rejected.failure.error, `unsupported request field ${field}`);
		assert.equal(rejected.failure.executorId, "fixture");
	}
	const untagged = validateResolveInput({ timeoutMs: -1 });
	assert.equal(untagged.ok, false);
	assert.equal("executorId" in untagged.failure, false);
});

test("schema-sync (validation half)", () => {
	// Every key in the probe table must be accepted by validateResolveInput.
	const probeValues = {
		sandbox: true,
		task: "inspect",
		mode: "single",
		tasks: [{ task: "inspect" }],
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
		runsDir: ".agent-workflow/runs",
		correlationId: "corr",
		captureToolCalls: true,
	};
	for (const key of Object.keys(probeValues)) {
		const single =
			key === "tasks" || key === "concurrency"
				? { [key]: probeValues[key], tasks: probeValues.tasks }
				: { task: "inspect", [key]: probeValues[key] };
		const validation = validateResolveInput(single);
		assert.equal(
			validation.ok,
			true,
			`key "${key}" must be accepted by validateResolveInput: ${validation.ok ? "" : validation.failure.error}`,
		);
	}
	const taskLevel = validateResolveInput({
		tasks: [{ task: "inspect", captureToolCalls: true }],
	});
	assert.equal(taskLevel.ok, true);
	assert.equal(taskLevel.input.tasks[0].captureToolCalls, true);
});

test("output-recovery (result envelope half)", () => {
	const envelope = createResultEnvelope({
		runId: "test",
		attemptId: "one",
		executorId: "headless",
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
