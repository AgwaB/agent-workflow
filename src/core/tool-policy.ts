// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/workflow-native-tool-policy.ts. MIT, same author. Changes: the native-host expansion (codemode, tool_search, mcp__*, MCP resource tools) is no longer added here; it becomes the task flag runtime.inheritHostTools that only the Pi executor honors (WP6), and core keeps the conservative mutation-capable safety it implied. WP4e: inheritedHostToolSafety/prepareWorkflowTaskToolPolicy take permissionMode (R#5 only in safe).
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
 * Apply the host-tool decision to a validated/authored tool selection.
 * Callers must perform authored authority checks before this helper.
 */
export function applyWorkflowToolPolicy(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	options: WorkflowToolPolicyOptions = {},
): WorkflowToolPolicy {
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
		// D2/R#5 (safe mode): a write-capable task needs a worktree even under a
		// spec-level "off"; only the executing user's run option can waive it.
		// WP4e free mode: the spec's worktreePolicy as written (pi-workflow).
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
			if (provider.extensions !== undefined)
				copy.extensions = [...provider.extensions];
			if (provider.fallbackTools !== undefined)
				copy.fallbackTools = [...provider.fallbackTools];
			return [tool, copy];
		}),
	);
}
