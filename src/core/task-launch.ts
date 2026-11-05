// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/backend.ts. MIT, same author. Changes: core-side launch/backend types only; the built-in pi-subagent headless backend became a registration hook (WP4c binds it to the runtime API); Pi-specific fields marked; artifactBinding now carries the artifact-access config and MCP server spec instead of the extension wrapper.
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

export type BackendLaunchResult =
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

export interface WorkflowBackend {
	readonly id: string;
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
	): Promise<BackendLaunchResult>;
	cleanupRun(cwd: string, run: WorkflowRunRecord): Promise<void>;
}

type WorkflowBackendKey =
	`${WorkflowRunRecord["backend"]["type"]}/${WorkflowRunRecord["backend"]["mode"]}`;

const backends = new Map<WorkflowBackendKey, WorkflowBackend>();

/**
 * Register the backend that serves `run.backend` records of this type/mode.
 * The runtime-API backend registers `local/headless` here. Returns an unregister function.
 */
export function registerWorkflowBackend(
	backend: {
		type: WorkflowRunRecord["backend"]["type"];
		mode: WorkflowRunRecord["backend"]["mode"];
	},
	implementation: WorkflowBackend,
): () => void {
	const key: WorkflowBackendKey = `${backend.type}/${backend.mode}`;
	backends.set(key, implementation);
	return () => {
		if (backends.get(key) === implementation) backends.delete(key);
	};
}

export function resolveWorkflowBackend(
	run: WorkflowRunRecord,
): WorkflowBackend {
	const backend = backends.get(`${run.backend.type}/${run.backend.mode}`);
	if (backend !== undefined) return backend;
	throw new Error(
		`Unsupported workflow backend: ${run.backend.type}/${run.backend.mode}`,
	);
}
