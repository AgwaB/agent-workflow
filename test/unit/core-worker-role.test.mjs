// The worker role is request-scoped through env; the parent process role never changes.
import { resolveRunExecutorSelection } from "../../dist/core/executor-registry.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../helpers/register-default-executor.mjs";
import { launchWorkerTask } from "../../dist/core/task-runner.js";
import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import { setWorkerLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { WORKFLOW_RUN_TYPE } from "../../dist/core/types.js";

setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });

function makeLaunchFixture(cwd, suffix) {
	const now = new Date().toISOString();
	const runId = `workflow_worker_role_${suffix}`;
	const dir = `.agent-workflow/workflows/${runId}/tasks/task-1`;
	const task = {
		taskId: "task-1",
		specId: `worker-role-${suffix}.main`,
		displayName: `worker-role-${suffix}.main`,
		agent: "unit-scout",
		agentFile: ".agent-workflow/agents/unit-scout.md",
		roles: [],
		status: "pending",
		statusDetail: "pending",
		runtime: { approvalMode: "non-interactive" },
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		workerTaskId: "",
		files: {
			systemPrompt: `${dir}/system.md`,
			taskPrompt: `${dir}/task.md`,
			output: `${dir}/output.log`,
			stderr: `${dir}/stderr.log`,
			result: `${dir}/result.json`,
		},
	};
	const run = {
		executor: resolveRunExecutorSelection({ runFlag: "pi" }),
		schemaVersion: 1,
		runId,
		type: WORKFLOW_RUN_TYPE,
		status: "running",
		taskSummary: {
			pending: 1,
			running: 0,
			blocked: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			total: 1,
		},
		cwd,
		createdAt: now,
		updatedAt: now,
		specPath: "workflow.json",
		tasks: [task],
	};
	const compiledTask = {
		id: `worker-role-${suffix}.main`,
		agent: "unit-scout",
		agentPath: ".agent-workflow/agents/unit-scout.md",
		agentSystemPrompt: "Launch agent.",
		roleNames: [],
		task: "Do the work.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			fast: "off",
			approvalMode: "non-interactive",
			tools: ["read"],
		},
		safety: { capability: "read-only", reason: "test" },
		compiledPrompt: "Launch prompt.",
	};
	return { run, task, compiledTask };
}

test("workflow child worker launches inherit worker role and restore the parent role", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-worker-role-"));
	const originalRole = process.env.AGENT_WORKFLOW_ROLE;
	const observed = [];
	try {
		process.env.AGENT_WORKFLOW_ROLE = "supervisor";
		setTaskRuntimeApiForTests({
			async runWorker(options) {
				observed.push({ role: process.env.AGENT_WORKFLOW_ROLE, options });
				return {
					runId: "run_worker_role_child",
					attemptId: "attempt_worker_role_child",
					status: "running",
				};
			},
			async getWorkerStatus() {
				return null;
			},
			async reconcileWorkerRun() {
				return {};
			},
			async interruptWorker() {
				return {};
			},
		});

		const { run, task, compiledTask } = makeLaunchFixture(cwd, "launch");
		const result = await launchWorkerTask(cwd, run, task, compiledTask);

		assert.equal(result.kind, "launched");
		assert.equal(observed.length, 1);
		assert.deepEqual(observed[0].options.env, {
			AGENT_WORKFLOW_ROLE: "worker",
		});
		// The supervisor's own role is never swapped while the child launches.
		assert.equal(observed[0].role, "supervisor");
		assert.equal(process.env.AGENT_WORKFLOW_ROLE, "supervisor");
	} finally {
		setTaskRuntimeApiForTests(undefined);
		if (originalRole === undefined) delete process.env.AGENT_WORKFLOW_ROLE;
		else process.env.AGENT_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});
