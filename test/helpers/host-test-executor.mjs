// New in agent-workflow (WP11a): module for the CLI's guarded test-executor hook
// (AGENT_WORKFLOW_TEST_EXECUTOR_MODULE + AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only, see
// src/hosts/test-executor.ts). Exports a descriptor over the workflow executor fixture (no model or
// agent-CLI calls). Config from the environment:
//   AW_HOST_TEST_EFFECT_LOG        absolute JSONL effect log (required)
//   AW_HOST_TEST_EXECUTOR_ID       executor id (default "test-fixture")
//   AW_HOST_TEST_EXECUTOR_CONFIG   JSON merged into the fixture config (capabilities, stepDelayMs, …)
import { workflowFixtureDescriptor } from "./workflow-executor-fixture.mjs";

const effectLog = process.env.AW_HOST_TEST_EFFECT_LOG;
if (!effectLog) throw new Error("AW_HOST_TEST_EFFECT_LOG is required");

export const testExecutorDescriptor = workflowFixtureDescriptor({
	...JSON.parse(process.env.AW_HOST_TEST_EXECUTOR_CONFIG ?? "{}"),
	id: process.env.AW_HOST_TEST_EXECUTOR_ID ?? "test-fixture",
	effectLog,
});
