// New in agent-workflow (WP11a): a guarded, test-only hook that registers an executor descriptor
// from a module named in the environment, so a packed-install test (or any end-to-end CLI test) can
// run workflows without a real agent CLI. It is honored only when all of these hold:
//   AGENT_WORKFLOW_TEST_EXECUTOR_MODULE  absolute path of an ES module that exports
//                                        `testExecutorDescriptor` (an ExecutorDescriptor)
//   AGENT_WORKFLOW_TEST_EXECUTOR_ACK     exactly "test-only" (a second, deliberate variable)
//   descriptor id                        starts with "test-" (it can never shadow pi/codex/claude)
// The executor is only registered, never made the default: a run must still select it with
// `--executor <id>`. A registration prints one warning line to stderr.
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { registerWorkflowExecutor } from "../core/executor-registry.js";
import type { ExecutorDescriptor } from "../sdk/descriptor.js";

export const TEST_EXECUTOR_MODULE_ENV = "AGENT_WORKFLOW_TEST_EXECUTOR_MODULE";
export const TEST_EXECUTOR_ACK_ENV = "AGENT_WORKFLOW_TEST_EXECUTOR_ACK";
export const TEST_EXECUTOR_ACK_VALUE = "test-only";
const TEST_EXECUTOR_ID = /^test-[A-Za-z0-9._-]+$/;

export class TestExecutorHookError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TestExecutorHookError";
	}
}

/**
 * Register the test executor named by the environment. Returns its id, or undefined when the
 * module variable is unset. Throws TestExecutorHookError when the variable is set but a guard
 * fails (the CLI then refuses to run anything).
 */
export async function registerTestExecutorFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const modulePath = env[TEST_EXECUTOR_MODULE_ENV];
	if (modulePath === undefined || modulePath === "") return undefined;
	if (env[TEST_EXECUTOR_ACK_ENV] !== TEST_EXECUTOR_ACK_VALUE)
		throw new TestExecutorHookError(
			`${TEST_EXECUTOR_MODULE_ENV} is set but ${TEST_EXECUTOR_ACK_ENV} is not "${TEST_EXECUTOR_ACK_VALUE}"; the test executor hook is for tests only. Unset ${TEST_EXECUTOR_MODULE_ENV}.`,
		);
	if (!isAbsolute(modulePath))
		throw new TestExecutorHookError(
			`${TEST_EXECUTOR_MODULE_ENV} must be an absolute path`,
		);
	let loaded: { testExecutorDescriptor?: ExecutorDescriptor };
	try {
		loaded = (await import(pathToFileURL(modulePath).href)) as {
			testExecutorDescriptor?: ExecutorDescriptor;
		};
	} catch (error) {
		throw new TestExecutorHookError(
			`${TEST_EXECUTOR_MODULE_ENV}: cannot import ${modulePath} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const descriptor = loaded.testExecutorDescriptor;
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		typeof descriptor.id !== "string"
	)
		throw new TestExecutorHookError(
			`${TEST_EXECUTOR_MODULE_ENV}: ${modulePath} must export testExecutorDescriptor`,
		);
	if (!TEST_EXECUTOR_ID.test(descriptor.id))
		throw new TestExecutorHookError(
			`${TEST_EXECUTOR_MODULE_ENV}: test executor id "${descriptor.id}" must start with "test-"`,
		);
	registerWorkflowExecutor(descriptor);
	return descriptor.id;
}
