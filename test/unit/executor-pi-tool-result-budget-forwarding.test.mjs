// agent-workflow 2026-11-08 (context-quality backlog R2): a dynamic task's sealed tool-result
// budget (default 320,000 characters) was recorded as configured but never reached Pi's executor
// config, so the Pi context hook never evicted anything. The Pi task descriptor now carries it.
import assert from "node:assert/strict";
import test from "node:test";

import { parsePiExecutorConfig } from "../../dist/executors/pi/index.js";
import { dynamicTaskToolResultBudgetConfiguration } from "../../dist/core/task-observability.js";
import { workflowTaskExecutorDescriptor } from "../../dist/core/task-runner.js";

const pi = {
	id: "pi",
	version: "0.1.0",
	contractVersion: "0.1.0",
	module: "m",
	config: null,
};
const task = { runtime: { approvalMode: "non-interactive" } };
const dynamicTask = {
	dynamicGenerated: { controllerSpecId: "c", opId: "o", requestHash: "h" },
};

function withEnv(value, run) {
	const key = "AGENT_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS";
	const saved = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		return run();
	} finally {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
}

test("the sealed dynamic budget reaches Pi's executor config and parses there", () => {
	const budget = withEnv(undefined, () =>
		dynamicTaskToolResultBudgetConfiguration(dynamicTask),
	);
	assert.deepEqual(budget, {
		configured: true,
		source: "default",
		maxTotalChars: 320_000,
	});
	const descriptor = workflowTaskExecutorDescriptor(pi, task, {
		toolResultBudget: budget,
	});
	assert.deepEqual(descriptor.config, {
		toolResultBudget: { maxTotalChars: 320_000 },
	});
	assert.deepEqual(parsePiExecutorConfig(descriptor.config).toolResultBudget, {
		maxTotalChars: 320_000,
	});

	const fromEnv = withEnv("50000", () =>
		dynamicTaskToolResultBudgetConfiguration(dynamicTask),
	);
	assert.deepEqual(
		workflowTaskExecutorDescriptor(pi, task, { toolResultBudget: fromEnv })
			.config,
		{ toolResultBudget: { maxTotalChars: 50_000 } },
	);
});

test("a disabled budget, a static task, another executor or an explicit config add nothing", () => {
	const disabled = withEnv("0", () =>
		dynamicTaskToolResultBudgetConfiguration(dynamicTask),
	);
	assert.deepEqual(disabled, { configured: false, source: "disabled" });
	assert.equal(
		workflowTaskExecutorDescriptor(pi, task, { toolResultBudget: disabled }),
		pi,
	);

	// Static stages have no sealed budget.
	assert.equal(dynamicTaskToolResultBudgetConfiguration({}), undefined);
	assert.equal(workflowTaskExecutorDescriptor(pi, task, {}), pi);

	const sealed = {
		configured: true,
		source: "default",
		maxTotalChars: 320_000,
	};
	const codex = { ...pi, id: "codex" };
	assert.equal(
		workflowTaskExecutorDescriptor(codex, task, { toolResultBudget: sealed }),
		codex,
	);

	assert.deepEqual(
		workflowTaskExecutorDescriptor(
			{ ...pi, config: { toolResultBudget: { maxTotalChars: 1_000 } } },
			task,
			{ toolResultBudget: sealed },
		).config,
		{ toolResultBudget: { maxTotalChars: 1_000 } },
	);
});
