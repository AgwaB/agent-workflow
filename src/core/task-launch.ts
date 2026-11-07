import type { ArtifactMcpServerSpec } from "./artifact-access.js";
import type { HostContext } from "./host-context.js";
import type {
	CompiledTask,
	CompiledToolProvider,
	WorkflowLaunchAuthorityGrant,
	WorkflowResourcePolicy,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
	WorkflowToolResultBudgetConfigurationSource,
} from "./types.js";

export type TaskLaunchResult =
	| { kind: "launched" }
	| { kind: "capacity"; message: string; retryAfterMs?: number }
	| { kind: "fatal"; message: string };

export interface PreparedWorkflowTaskLaunch {
	/** Present only when the task inherits host tools; equals the run's HostContext. */
	hostContext?: HostContext;
	/** Present only for a versioned compiled task and sealed before launch. */
	resourcePolicy?: WorkflowResourcePolicy;
	/** Provider metadata retained for launch auditing and wrapper preparation. */
	toolProviders?: Record<string, CompiledToolProvider>;
	captureToolCalls: boolean;
	toolResultBudget?: {
		configured: boolean;
		source: WorkflowToolResultBudgetConfigurationSource;
		maxTotalChars?: number;
	};
	/** workflow_artifact access: manifest + ArtifactAccessConfig + MCP server spec. */
	artifactBinding?: {
		manifestPath: string;
		expectedManifestBytes: string;
		configPath: string;
		expectedConfigBytes: string;
		serverSpec: ArtifactMcpServerSpec;
	};
	authority?: WorkflowLaunchAuthorityGrant;
}

export interface WorkflowTaskRunner {
	refreshRun(cwd: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord>;
	prepareTaskLaunch(
		cwd: string,
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		compiledTask: CompiledTask,
	): Promise<PreparedWorkflowTaskLaunch>;
	launchTask(
		cwd: string,
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		compiledTask: CompiledTask,
		leaseSignal?: AbortSignal,
		workflowStopSignal?: AbortSignal,
		preparedLaunch?: PreparedWorkflowTaskLaunch,
	): Promise<TaskLaunchResult>;
	cleanupRun(cwd: string, run: WorkflowRunRecord): Promise<void>;
}

let activeRunner: WorkflowTaskRunner | undefined;

/**
 * Install the task runner the engine launches, refreshes and cleans up tasks through (the runtime
 * API runner registers itself; tests may swap in a fake). Returns a function that restores the
 * previous runner.
 */
export function setWorkflowTaskRunner(runner: WorkflowTaskRunner): () => void {
	const previous = activeRunner;
	activeRunner = runner;
	return () => {
		if (activeRunner === runner) activeRunner = previous;
	};
}

export function workflowTaskRunner(): WorkflowTaskRunner {
	if (activeRunner === undefined)
		throw new Error("no workflow task runner is registered");
	return activeRunner;
}
