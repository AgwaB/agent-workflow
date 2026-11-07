// Executor-specific rules the engine applies before launch. The engine asks what an executor supports
// (host-tool inheritance, its model naming, a fast tier, per-task descriptor config, doctor fixes)
// instead of testing executor ids; each built-in adapter keeps its rules in a small policy module
// that never loads the adapter itself (adapters load only in durable workers).
import { PI_EXECUTOR_POLICY } from "../executors/pi/policy.js";
import { PI_EXECUTOR_ID } from "../executors/pi/version.js";
import type { ExecutorDescriptor } from "../sdk/descriptor.js";
import type { NegotiationReport } from "../sdk/requirements.js";
import type { ExecutorNameResolution } from "./executor-model-id.js";
import type { PreparedWorkflowTaskLaunch } from "./task-launch.js";
import type { CompiledTask, FastMode } from "./types.js";
import type { WorkflowModelInfo } from "./workflow-runtime.js";

export interface ExecutorDoctorFix {
	readonly tool: string;
	/** What would change, for the question to the user. */
	readonly description: string;
}

export type ExecutorDoctorFixResult =
	| { readonly changed: true; readonly path: string; readonly setting: string }
	| { readonly changed: false; readonly path: string; readonly reason: string };

export interface ExecutorPolicy {
	/** Tools of the launching host this executor's workers can inherit; absent: none. */
	readonly inheritedHostTools?: readonly string[];
	/**
	 * Model naming of a multi-provider CLI (`provider/model`), consulted after the generic vendor
	 * rules found no executor vendor; absent: the model passes unchanged.
	 */
	resolveModel?(
		model: string,
		vendor: string | undefined,
		listed: readonly string[] | null,
		listComplete: boolean,
	): ExecutorNameResolution;
	/** Validate a `fast: "on"` task before launch (throws when unsupported); absent: no fast tier. */
	resolveFastMode?(
		runtime: { fast?: FastMode; model?: string; api?: string },
		availableModels?: readonly WorkflowModelInfo[],
	): object | undefined;
	/** Executor descriptor for one sealed task launch (per-task config); absent: unchanged. */
	taskDescriptor?(
		descriptor: ExecutorDescriptor,
		compiledTask: Pick<CompiledTask, "runtime">,
		launch: Pick<PreparedWorkflowTaskLaunch, "hostContext">,
		capability: { report?: NegotiationReport },
	): ExecutorDescriptor;
	/** `doctor --fix` candidates for tools this executor cannot provide here. */
	doctorFixes?(
		unavailableTools: Readonly<Record<string, string>>,
		env: NodeJS.ProcessEnv,
	): ExecutorDoctorFix[];
	applyDoctorFix?(
		tool: string,
		env: NodeJS.ProcessEnv,
	): Promise<ExecutorDoctorFixResult>;
}

const POLICIES: Readonly<Record<string, ExecutorPolicy>> = {
	[PI_EXECUTOR_ID]: PI_EXECUTOR_POLICY,
};

const NO_POLICY: ExecutorPolicy = {};

/** The policy of a built-in executor; registered executors and an unknown id get none. */
export function executorPolicy(executorId: string | undefined): ExecutorPolicy {
	return (
		(executorId === undefined ? undefined : POLICIES[executorId]) ?? NO_POLICY
	);
}

/** Whether the executor's workers can inherit the launching host's tools. A missing id cannot. */
export function executorInheritsHostTools(
	executorId: string | undefined,
): boolean {
	return (executorPolicy(executorId).inheritedHostTools?.length ?? 0) > 0;
}

/**
 * Validate a task's fast tier for the executor that runs it. Only an executor with a fast tier
 * checks the model; on any other executor capability negotiation reports "runs without fast tier".
 */
export function validateExecutorFastMode(
	executorId: string | undefined,
	runtime: { fast?: FastMode; model?: string; api?: string },
	availableModels?: readonly WorkflowModelInfo[],
): void {
	if (runtime.fast !== "on") return;
	executorPolicy(executorId).resolveFastMode?.(runtime, availableModels);
}
