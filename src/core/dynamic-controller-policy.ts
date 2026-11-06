import { hashDynamicRequest } from "./dynamic-events.js";
import {
	readOrRebuildDynamicState,
	recordDynamicEventAndUpdateState,
} from "./dynamic-state.js";
import { DynamicControllerBudgetBlocked } from "./dynamic-controller-errors.js";
import type { CompiledDynamicWorkflowTask } from "./types.js";

export async function assertDynamicRuntimeBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const message = await dynamicRuntimeBudgetExceededMessageForController(
		input.cwd,
		input.runId,
		input.controllerSpecId,
		input.dynamic,
	);
	if (message) throw new DynamicControllerBudgetBlocked(message);
}

export async function dynamicRuntimeBudgetExceededMessageForController(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	dynamic: CompiledDynamicWorkflowTask,
): Promise<string | undefined> {
	const state = await readOrRebuildDynamicState(cwd, runId);
	const runtimeMs =
		state.controllers[controllerSpecId]?.counters.runtimeMs ?? 0;
	return dynamicRuntimeBudgetExceededMessage(dynamic, runtimeMs);
}

function dynamicRuntimeBudgetExceededMessage(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): string | undefined {
	if (consumedRuntimeMs >= dynamic.budget.maxRuntimeMs) {
		return `dynamic runtime budget exhausted: runtimeMs=${consumedRuntimeMs} maxRuntimeMs=${dynamic.budget.maxRuntimeMs}`;
	}
	return undefined;
}

export async function recordDynamicRuntimeUsage(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	elapsedMs: number,
): Promise<void> {
	await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId,
		type: "budget.used",
		opId: `${controllerSpecId}:budget:runtime`,
		requestHash: hashDynamicRequest({ controllerSpecId, elapsedMs }),
		payload: { counters: { runtimeMs: elapsedMs } },
	});
}
