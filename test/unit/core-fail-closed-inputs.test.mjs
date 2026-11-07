import assert from "node:assert/strict";
import { test } from "node:test";
import {
	artifactGraphWorkflowSpec,
	compileWorkflow,
	makeProject,
	parseWorkflow,
	writeAgent,
} from "../helpers/unit-test-support.mjs";
import { hostToolInheritanceNotice } from "../../dist/core/capability-negotiation.js";
import { parseAgentMarkdown } from "../../dist/core/agents.js";
import { createRunRecord } from "../../dist/core/store.js";
import {
	launchWorkerTask,
	runOneShotWorkerCall,
} from "../../dist/core/task-runner.js";
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
		async runWorker() {
			calls += 1;
			throw new Error("must not launch");
		},
	});
	t.after(() => setTaskRuntimeApiForTests(undefined));
	const result = await launchWorkerTask(
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
		async runWorker(options) {
			calls += 1;
			assert.equal(options.executor.id, "pi");
			return { runId: "one", attemptId: "a", status: "completed" };
		},
	});
	t.after(() => setTaskRuntimeApiForTests(undefined));
	for (const executor of [undefined, "", " "]) {
		await assert.rejects(
			runOneShotWorkerCall({ executor, task: "Read." }),
			/one-shot calls require an explicit executor/,
		);
	}
	assert.equal(calls, 0);
	assert.equal(
		(await runOneShotWorkerCall({ executor: "pi", task: "Read." })).status,
		"completed",
	);
	assert.equal(calls, 1);
});

test("a missing executor does not inherit host tools", () => {
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

test("host-tool notices do not categorize an unselected stage by executor", () => {
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

test("unknown agent frontmatter stays inert", () => {
	const agent = parseAgentMarkdown(
		'---\nname: unit\ntools: ["read"]\nreadOnly: true\nunknownSetting: anything\n---\nRead only.\n',
		"/tmp/unit.md",
		"project",
	);
	for (const key of ["unknownSetting"]) {
		assert.equal(Object.hasOwn(agent, key), false);
		assert.ok(Object.hasOwn(agent.frontmatter, key));
	}
	assert.equal(agent.readOnly, true);
	assert.deepEqual(agent.tools, ["read"]);
});

test("an unknown durable launch barrier or binding schema is refused", () => {
	const descriptor = {
		schema: "unknown-durable-launch-barrier",
		identitySha256: "1".repeat(64),
		subjectSha256: "2".repeat(64),
	};
	const validation = validateResolveInput(
		{ task: "Read.", async: true, durableLaunchBarrier: descriptor },
		"fixture",
	);
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
				preflight: { schema: "unknown-durable-worker-binding-preflight" },
			}),
		/binding v2 preflight is required/,
	);
	assert.throws(
		() =>
			buildDurableWorkerBinding({
				preflight: {
					schema: "agent-workflow-durable-worker-binding-preflight-v2",
				},
				ack: { schema: "unknown-durable-launch-barrier-ack" },
			}),
		/barrier v2 acknowledgement is required/,
	);
});

test("compiled workflows carry no launcher identity and the spec has no launcher selector", async () => {
	const cwd = makeProject();
	writeAgent(cwd, "unit-scout", "read");
	const spec = artifactGraphWorkflowSpec();
	const compiled = await compileWorkflow(spec, { cwd, task: "Read." });
	assert.equal(Object.hasOwn(compiled, "worker"), false);
	assert.throws(
		() =>
			parseWorkflow({
				...spec,
				defaults: { ...spec.defaults, worker: { type: "local" } },
			}),
		(error) =>
			error.issues.some(
				(issue) =>
					issue.path === "$.defaults.worker" &&
					issue.message === "unknown field",
			),
	);
});

test("SDK tool exports use the workflow vocabulary", async () => {
	const sdk = await import("../../dist/sdk/index.js");
	assert.ok(sdk.WORKFLOW_TOOL_NAMES.includes("read"));
	assert.equal(sdk.WORKFLOW_TOOL_KINDS.write, "edit");
});
