// Only tasks on an executor that inherits host tools (Pi) may inherit them; declared read-only
// stages never do. Host-tool inheritance remains conservatively mutation-capable in safe mode.
import { executorInheritsHostTools } from "./executor-policy.js";
import type {
	CompiledTask,
	CompiledTaskSafety,
	CompiledToolProvider,
	ToolClassification,
} from "./types.js";

/**
 * Pi tool-name vocabulary a worker gets when its tool list is unspecified and
 * host tools are inherited. Executors map these names (sdk/tools.ts).
 */
export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write"] as const;

/**
 * Inherited host tools (Pi: codemode, `mcp__*`, MCP resources) can mutate
 * anything the host can reach, so a task that inherits them is classified
 * mutation-capable before launch, whatever its own tool list says.
 */
export const INHERITED_HOST_TOOLS_CLASSIFICATION: ToolClassification =
	"mutation-capable";

export interface WorkflowToolPolicyOptions {
	/**
	 * Host-level opt-in, set by the launching host (Pi host adapter, WP6) and
	 * recorded in the run. Core never turns this on by itself (B5 isolation).
	 */
	inheritHostTools?: boolean;
}

export interface WorkflowToolPolicy {
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	/**
	 * Present only when compilation considered host-tool inheritance: `true`
	 * means the executor may add the host's own tools (Pi only, WP6); `false`
	 * means an explicitly tool-free task stays tool-free.
	 */
	inheritHostTools?: boolean;
}

/**
 * WP31×WP35: whether the run's host-tool decision applies to one task. Host tools are inherited
 * per task, only by tasks whose executor inherits host tools (executor-policy.ts): the task's own
 * executor (`runtime.executor`, mixed role-profile runs), else the run's. A missing executor cannot.
 */
export function runInheritsHostToolsForTask(
	run: { inheritHostTools?: boolean; executor?: { id: string } },
	task: { runtime: { executor?: string } },
): boolean {
	if (run.inheritHostTools !== true) return false;
	const executorId = task.runtime.executor ?? run.executor?.id;
	return executorInheritsHostTools(executorId);
}

/**
 * Apply the host-tool decision to a validated/authored tool selection.
 * Callers must perform authored authority checks before this helper.
 */
export function applyWorkflowToolPolicy(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	options: WorkflowToolPolicyOptions & {
		/**
		 * WP35: the stage declares readOnly. Inherited host tools are mutation-capable, so a
		 * readOnly stage never inherits them (decided `false`, like an explicitly tool-free task).
		 */
		readOnlyDeclared?: boolean;
	} = {},
): WorkflowToolPolicy {
	if (options.inheritHostTools === true && options.readOnlyDeclared === true) {
		const readOnlyPolicy: WorkflowToolPolicy = { inheritHostTools: false };
		if (tools !== undefined) readOnlyPolicy.tools = [...tools];
		if (toolProviders !== undefined)
			readOnlyPolicy.toolProviders = cloneToolProviders(toolProviders);
		return readOnlyPolicy;
	}
	if (options.inheritHostTools !== true) {
		const legacyPolicy: WorkflowToolPolicy = {};
		if (tools !== undefined) legacyPolicy.tools = [...tools];
		if (toolProviders !== undefined)
			legacyPolicy.toolProviders = cloneToolProviders(toolProviders);
		return legacyPolicy;
	}

	if (tools?.length === 0) {
		const disabledPolicy: WorkflowToolPolicy = {
			tools: [],
			inheritHostTools: false,
		};
		if (toolProviders !== undefined)
			disabledPolicy.toolProviders = cloneToolProviders(toolProviders);
		return disabledPolicy;
	}

	// Preserve the ordinary tool selection; do not turn a read-only stage into a shell stage.
	const enabledPolicy: WorkflowToolPolicy = {
		tools: [...(tools ?? DEFAULT_WORKER_TOOLS)],
		inheritHostTools: true,
	};
	if (toolProviders !== undefined && Object.keys(toolProviders).length > 0)
		enabledPolicy.toolProviders = cloneToolProviders(toolProviders);
	return enabledPolicy;
}

/** Safety of a task whose executor may add inherited host tools. */
export function inheritedHostToolSafety(
	safety: CompiledTaskSafety,
	approvalMode: string,
	options: {
		allowSharedCheckoutWrites?: boolean;
		permissionMode?: "free" | "safe";
	} = {},
): CompiledTaskSafety {
	const free = options.permissionMode === "free";
	const allowShared =
		!free &&
		options.allowSharedCheckoutWrites === true &&
		safety.worktreePolicy === "off";
	return {
		...safety,
		capability: INHERITED_HOST_TOOLS_CLASSIFICATION,
		sharedCwdSafe: false,
		// In safe mode, write-capable tasks require a worktree even under spec policy off;
		// only the executing user can waive this through the run option.
		// Free mode honors the spec policy as written.
		requiresWorktree: free ? safety.worktreePolicy !== "off" : !allowShared,
		...(allowShared ? { allowSharedCheckoutWrites: true as const } : {}),
		permission:
			approvalMode === "on-request"
				? {
						status: "blocked",
						statusDetail: "pending_approval",
						reason:
							"mutation-capable background task uses on-request approval mode",
					}
				: safety.permission,
	};
}

/**
 * WP12d-1 (review #1): whether a task launches read-only. The authored readOnly contract wins over
 * the tool classification (inherited host tools, records compiled before the compile-time filter),
 * in both permission modes.
 */
export function workflowTaskReadOnly(
	task: Pick<CompiledTask, "safety">,
): boolean {
	return (
		task.safety.capability === "read-only" ||
		task.safety.readOnlyDeclared === true
	);
}

/** Apply the run's host-tool decision to a task compiled without one. */
export function prepareWorkflowTaskToolPolicy(
	task: CompiledTask,
	options: WorkflowToolPolicyOptions & {
		allowSharedCheckoutWrites?: boolean;
		/** WP4e: the run's permission mode (R#5 only in `safe`). */
		permissionMode?: "free" | "safe";
	} = {},
): CompiledTask {
	if (
		options.inheritHostTools !== true ||
		task.runtime.inheritHostTools !== undefined ||
		task.kind === "support" ||
		task.kind === "dynamic"
	)
		return task;
	const policy = applyWorkflowToolPolicy(
		task.runtime.tools,
		task.runtime.toolProviders,
		options,
	);
	return {
		...task,
		runtime: { ...task.runtime, ...policy },
		...(policy.inheritHostTools !== true
			? {}
			: {
					safety: inheritedHostToolSafety(
						task.safety,
						task.runtime.approvalMode,
						options,
					),
				}),
	};
}

function cloneToolProviders(
	providers: Record<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> {
	return Object.fromEntries(
		Object.entries(providers).map(([tool, provider]) => {
			const copy: CompiledToolProvider = { ...provider };
			if (provider.fallbackTools !== undefined)
				copy.fallbackTools = [...provider.fallbackTools];
			return [tool, copy];
		}),
	);
}
