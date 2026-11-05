import assert from "node:assert/strict";
import { test } from "node:test";
import {
	artifactGraphWorkflowSpec,
	compileWorkflow,
	makeProject,
	writeAgent,
} from "../helpers/unit-test-support.mjs";
import { hostToolInheritanceNotice } from "../../dist/core/capability-negotiation.js";
import { parseAgentMarkdown } from "../../dist/core/agents.js";
import { createRunRecord } from "../../dist/core/store.js";
import {
	launchSubagentTask,
	runOneShotSubagentCall,
} from "../../dist/core/task-backend.js";
import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import { runInheritsHostToolsForTask } from "../../dist/core/tool-policy.js";
import { validateResolveInput } from "../../dist/runtime/core/validation.js";
import {
	prepareDurableWorkerBinding,
	buildDurableWorkerBinding,
} from "../../dist/runtime/workers/durable-worker-binding.js";

test("store-created records without an executor fail closed without modifying the record or calling the runtime", async (t) => {
	const cwd = makeProject();
	writeAgent(cwd, "unit-scout", "read");
	const compiled = await compileWorkflow(artifactGraphWorkflowSpec(), {
		cwd,
		task: "Read.",
	});
	const { run } = await createRunRecord(cwd, compiled, "spec.json");
	let calls = 0;
	setTaskRuntimeApiForTests({
		async runSubagent() {
			calls += 1;
			throw new Error("must not launch");
		},
	});
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const result = await launchSubagentTask(
		cwd,
		run,
		run.tasks[0],
		compiled.tasks[0],
	);
	assert.equal(result.kind, "fatal");
	assert.match(result.message, /records no executor; it cannot launch tasks/);
	assert.equal(run.executor, undefined);
	assert.equal(calls, 0);
});

test("one-shot callers must provide an explicit executor", async (t) => {
	let calls = 0;
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			calls += 1;
			assert.equal(options.executor.id, "pi");
			return { runId: "one", attemptId: "a", status: "completed" };
		},
	});
	t.after(() => setTaskRuntimeApiForTests(undefined));
	for (const executor of [undefined, "", " "]) {
		await assert.rejects(
			runOneShotSubagentCall({ executor, task: "Read." }),
			/one-shot calls require an explicit executor/,
		);
	}
	assert.equal(calls, 0);
	assert.equal(
		(await runOneShotSubagentCall({ executor: "pi", task: "Read." })).status,
		"completed",
	);
	assert.equal(calls, 1);
});

test("missing executor does not inherit Pi host tools", () => {
	const task = { runtime: {} };
	assert.equal(
		runInheritsHostToolsForTask({ inheritHostTools: true }, task),
		false,
	);
	assert.equal(
		runInheritsHostToolsForTask(
			{ inheritHostTools: true, executor: { id: "pi" } },
			task,
		),
		true,
	);
});

test("host-tool notices do not categorize an unselected stage as Pi", () => {
	const tasks = [
		{ id: "inheriting", runtime: { executor: "pi", inheritHostTools: true } },
		{ id: "unselected", runtime: {} },
	];
	assert.match(
		hostToolInheritanceNotice(tasks),
		/not by unselected executor stage unselected/,
	);
	assert.doesNotMatch(
		hostToolInheritanceNotice(tasks, "pi"),
		/unselected executor/,
	);
});

test("unsupported agent frontmatter remains inert like any unknown key", () => {
	const agent = parseAgentMarkdown(
		'---\nname: unit\ntools: ["read"]\nreadOnly: true\nsystemPromptMode: replace\napprovalMode: always\nmaxSubagentDepth: 5\nunknownSetting: anything\n---\nRead only.\n',
		"/tmp/unit.md",
		"project",
	);
	for (const key of [
		"systemPromptMode",
		"approvalMode",
		"maxSubagentDepth",
		"unknownSetting",
	]) {
		assert.equal(Object.hasOwn(agent, key), false);
		assert.ok(Object.hasOwn(agent.frontmatter, key));
	}
	assert.equal(agent.readOnly, true);
	assert.deepEqual(agent.tools, ["read"]);
});

test("barrier V1 is rejected at request validation and worker binding boundaries", () => {
	const descriptor = {
		schema: "pi-subagent-durable-launch-barrier-v1",
		identitySha256: "1".repeat(64),
		subjectSha256: "2".repeat(64),
	};
	const validation = validateResolveInput({
		task: "Read.",
		backend: "headless",
		async: true,
		durableLaunchBarrier: descriptor,
	});
	assert.equal(validation.ok, false);
	assert.match(validation.failure.error, /schema/);
	assert.throws(
		() =>
			prepareDurableWorkerBinding({
				payload: {
					cwd: "/tmp",
					runId: "r",
					attemptId: "a",
					input: { durableLaunchBarrier: descriptor },
				},
				launchPayloadSha256: "3".repeat(64),
				executionPlanSha256: "4".repeat(64),
			}),
		/barrier v2 is required/,
	);
	assert.throws(
		() =>
			buildDurableWorkerBinding({
				preflight: {
					schema: "pi-subagent-durable-worker-binding-preflight-v1",
				},
			}),
		/binding v2 preflight is required/,
	);
});

test("the public runtime no longer exports the V1 barrier API", async () => {
	const runtime = await import("../../dist/runtime/index.js");
	for (const name of [
		"createDurableLaunchBarrier",
		"releaseDurableLaunchBarrier",
		"waitForDurableLaunchBarrierReady",
		"waitForDurableLaunchBarrierAck",
		"LEGACY_PI_DURABLE_WORKER_BINDING_ENV",
	]) {
		assert.equal(Object.hasOwn(runtime, name), false, name);
	}
	assert.equal(typeof runtime.createDurableLaunchBarrierV2, "function");
});
