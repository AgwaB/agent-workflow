import type { TaskActivity } from "./task-activity.js";
// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/types.ts. MIT, same author. Changes: run.nativeHost→run.hostContext (HostContext); runtime.nativeToolsEnabled→runtime.inheritHostTools; added allowSharedCheckoutWrites (R#5), inheritHostTools run/compile flags, agent legacySource; artifact provenance digests config + MCP server spec instead of extension wrapper bytes. WP4c: run.executor (executor selection), spec executionProfileExecutors, WorkflowRunExecutionProfile.executor, task.ownedSessions, usage/budget record source "executor". WP4d: run.capabilityNegotiation (B4), spec allowReadOnlyDowngrade/executionProfileStrictCapabilities, WorkflowRunExecutionProfile.strictCapabilities. WP4e: run.permissionMode (WorkflowRunPermissionMode), spec executionProfilePermissionModes, WorkflowRunExecutionProfile.permissionMode, compiled.permissionMode, negotiation policy.permissionMode. WP31: role-level profiles (WorkflowRoleAssignment/WorkflowRoleMap, spec executionProfileRoles, run.roleExecution, compiled/task runtime.executor in role-profile runs, negotiation executors for mixed runs, executor source workflow-preference).
import type { ExecutorCapabilities } from "../sdk/capabilities.js";
import type { AuthStatus } from "../sdk/contract.js";
import type { ExecutorDescriptor } from "../sdk/descriptor.js";
import type { NegotiationReport } from "../sdk/requirements.js";
import type {
	WorkflowModelInfo,
	WorkflowRuntimeDefaults,
	WorkflowRuntimeThinkingResolution,
} from "./workflow-runtime.js";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	// Codex's top level; mapped before launch to the nearest level other executors/models have.
	"ultra",
] as const;
export const FAST_MODES = ["inherit", "off", "on"] as const;
export const WORKFLOW_PROFILE_ROLES = [
	"planning",
	"research-execution",
	"synthesis",
	"verification",
	"final-judgment",
] as const;
export const APPROVAL_MODES = ["non-interactive", "on-request"] as const;
export const WORKTREE_POLICIES = ["auto", "on", "off"] as const;
export const TOOL_CLASSIFICATIONS = [
	"read-only",
	"write-capable",
	"mutation-capable",
] as const;
export const WORKFLOW_RUN_TYPE = "artifact-graph" as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type FastMode = (typeof FAST_MODES)[number];
export type WorkflowProfileRole = (typeof WORKFLOW_PROFILE_ROLES)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type ToolClassification = (typeof TOOL_CLASSIFICATIONS)[number];
export type WorkflowRunType = typeof WORKFLOW_RUN_TYPE;

export interface BackendOptions {
	type?: "local-pi";
	mode?: "auto" | "headless";
}

export interface WorkflowBackendHandle {
	display?: string;
	[key: string]: unknown;
}

export interface WorkflowToolObjectSpec {
	name: string;
	extensions?: string[];
	classification?: ToolClassification;
	optional?: boolean;
	fallbackTools?: string[];
}

export type WorkflowToolSpec = string | WorkflowToolObjectSpec;

export interface CompiledToolProvider {
	/** Pi executor only (WP6): Pi extension files that provide the tool. */
	extensions?: string[];
	classification?: ToolClassification;
	optional?: boolean;
	fallbackTools?: string[];
	/**
	 * Engine-provided stdio MCP server that serves the tool (set at launch
	 * preparation, e.g. workflow_artifact; never authored). Executors pass it
	 * through `SubmitRequest.mcpServers`.
	 */
	mcpServer?: { name: string; command: string; args: string[] };
}

export interface WorkflowDefaults {
	cwd?: string;
	agent?: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	approvalMode?: ApprovalMode;
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	worktreePolicy?: WorktreePolicy;
	maxConcurrency?: number;
	maxRuntimeMs?: number;
	backend?: BackendOptions;
}

export interface RoleSpec {
	fromAgent?: string;
	prompt?: string;
	includeSections?: string[];
	excludeSections?: string[];
	maxChars?: number;
}

export type ArtifactGraphStageType =
	| "single"
	| "reduce"
	| "foreach"
	| "loop"
	| "dag"
	| "dynamic";

export type WorkflowArtifactKind = "control" | "analysis" | "refs" | "raw";

export interface WorkflowFailurePolicy {
	failFast?: boolean;
	cancelSiblingsOnFailure?: boolean;
	cancelDescendantsOnParentFailure?: boolean;
}

interface RequiredWorkflowArtifactReadPolicyBase {
	source: string;
	artifact: WorkflowArtifactKind;
	mustNotTruncate?: boolean;
	minReturnedBytes?: number;
}

export type RequiredWorkflowArtifactReadPolicy =
	| (RequiredWorkflowArtifactReadPolicyBase & {
			path: string;
			maxItems?: number;
			maxChars?: number;
	  })
	| (RequiredWorkflowArtifactReadPolicyBase & {
			path?: string;
			maxItems?: undefined;
			maxChars?: undefined;
	  });

export interface ExecutionProfileForeachBatch {
	/** Fixed v1 batch size for profile-only transparent foreach batching. */
	maxItems: 2;
	/** One or more simple JSONPaths evaluated relative to each foreach item. */
	groupBy?: string | string[];
}

/** Durable per-item eligibility metadata captured while a foreach item is raw. */
export interface WorkflowForeachBatchGrouping {
	enabled: true;
	/** False means adjacent items may pair without a grouping key. */
	groupBy: boolean;
	/** Canonical JSON for the first usable configured groupBy value. */
	groupKey?: string;
}

/** WP31 (B2): what a profile assigns to one role. Every field is optional. */
export interface WorkflowRoleAssignment {
	executor?: string;
	model?: string;
	effort?: ThinkingLevel;
}

/**
 * WP31: role key → assignment. Keys: a `profileRole` (planning, research-execution, synthesis,
 * verification, final-judgment), `agent:<agent name>`, or `default` (every role not listed).
 */
export type WorkflowRoleMap = Record<string, WorkflowRoleAssignment>;

export interface ExecutionProfileStageOverride {
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	foreachBatch?: ExecutionProfileForeachBatch;
}

/** Optional authored hints used only to compare existing execution candidates. */
export interface WorkflowRoutingHints {
	useWhen?: string[];
	avoidWhen?: string[];
	outputs?: string[];
}

export interface ArtifactGraphWorkflowSpec {
	schemaVersion: 1;
	name?: string;
	description?: string;
	routing?: WorkflowRoutingHints;
	input?: unknown;
	defaults?: WorkflowDefaults;
	roles?: Record<string, RoleSpec>;
	/**
	 * Named execution profiles selected at run time. Stage keys are top-level ids,
	 * canonical nested dag/loop ids (`container.child`), loop exhaustion slots
	 * (`loop.$onExhausted`), or dynamic decision slots (`stage.$planner`, etc.).
	 * Empty profiles are identity.
	 */
	executionProfiles?: Record<
		string,
		Record<string, ExecutionProfileStageOverride>
	>;
	/** Omitted profile selection uses this declared profile when present. */
	defaultExecutionProfile?: string;
	/** agent-workflow (B2): executor id per declared execution profile name. */
	executionProfileExecutors?: Record<string, string>;
	/**
	 * agent-workflow (WP4d): capability keys that must be `native` when a declared
	 * execution profile is selected (`ctx.strict` in B4 negotiation).
	 */
	executionProfileStrictCapabilities?: Record<string, string[]>;
	/**
	 * agent-workflow (WP4e, D2 revised): permission mode ("free" | "safe") a
	 * declared execution profile selects.
	 */
	executionProfilePermissionModes?: Record<string, "free" | "safe">;
	/**
	 * agent-workflow (WP31, B2): role → executor/model/effort per declared execution profile.
	 * Role keys: a `profileRole`, `agent:<name>` or `default`.
	 */
	executionProfileRoles?: Record<string, WorkflowRoleMap>;
	/**
	 * agent-workflow (WP4d, B4): when an executor has no precise tool allowlist
	 * (or cannot map a tool), run the stage with readOnly enforced instead of
	 * refusing it. Recorded as a degradation.
	 */
	allowReadOnlyDowngrade?: boolean;
	artifactGraph: WorkflowFailurePolicy & {
		stages: ArtifactGraphStageSpec[];
		maxConcurrency?: number;
	};
}

export interface DynamicWorkflowBudgetSpec {
	maxAgents?: number;
	maxConcurrency?: number;
	maxRuntimeMs?: number;
	maxNestedWorkflowDepth?: number;
	maxGraphMutations?: number;
	maxHelperRuns?: number;
}

export interface DynamicWorkflowPermissionsSpec {
	approval?: "auto" | "ask";
	allowDynamicRoles?: boolean;
	allowDynamicTools?: boolean;
}

export interface DynamicWorkflowHelperSpec {
	uses: string;
	inputSchema?: string;
	outputSchema?: string;
	idempotent?: boolean;
}

export interface DynamicWorkflowNestedSpec {
	uses: string;
}

export interface DynamicDecisionLoopExecutionProfileSpec {
	agent?: string;
	/** Model-purpose metadata used only by workflow execution-profile presets. */
	profileRole?: WorkflowProfileRole;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	tools?: WorkflowToolSpec[];
	outputProfile?: string;
	maxRuntimeMs?: number;
}

export interface DynamicDecisionLoopSpec {
	planner?: DynamicDecisionLoopExecutionProfileSpec;
	workerDefaults?: DynamicDecisionLoopExecutionProfileSpec;
	verifier?: DynamicDecisionLoopExecutionProfileSpec;
	synthesis?: DynamicDecisionLoopExecutionProfileSpec;
	allowedAgents?: string[];
	allowedTools?: WorkflowToolSpec[];
	allowedOutputProfiles?: string[];
	maxDecisionRounds?: number;
	maxActionsPerRound?: number;
	repair?: { maxAttempts?: number };
	stateIndex?: {
		maxFindings?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Accepted by the authoring
		 * contract but not used by the decision-loop runtime.
		 */
		requiredFindingIds?: string[];
	};
	stopPolicy?: {
		/**
		 * @deprecated Phase 1 compatibility no-op. Synthesize decisions are
		 * governed by the canonical decision validator instead.
		 */
		requireSynthesisAction?: boolean;
		failOnInvalidDecision?: boolean;
		/**
		 * Maximum progress-aware stall score before the dynamic loop asks the
		 * planner for a bounded replan.
		 */
		maxStalls?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Dropped-branch enforcement is
		 * deferred; invalid/omitted work is surfaced via blockers/omissions.
		 */
		failOnDroppedRequiredBranch?: boolean;
	};
}

export interface DynamicWorkflowStageSpec {
	uses: string;
	mode?: "graph-splice";
	budget?: DynamicWorkflowBudgetSpec;
	permissions?: DynamicWorkflowPermissionsSpec;
	helpers?: Record<string, DynamicWorkflowHelperSpec>;
	workflows?: Record<string, DynamicWorkflowNestedSpec>;
	decisionLoop?: DynamicDecisionLoopSpec;
}

export interface ArtifactGraphRequiredReadSpec {
	source: string;
	artifact: WorkflowArtifactKind;
	path?: string;
	maxChars?: number;
	maxItems?: number;
	count?: number;
}

export type ArtifactGraphRequiredRead = string | ArtifactGraphRequiredReadSpec;
export interface ArtifactGraphForeachSpec {
	prompt: string;
	agent?: string;
	role?: string | string[];
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	maxRuntimeMs?: number;
	worktreePolicy?: WorktreePolicy;
	itemIdentityPath?: string;
	itemPayloadPath?: string;
}

export interface ArtifactGraphStageSpec {
	id: string;
	type?: ArtifactGraphStageType;
	prompt?: string;
	injectRuntimeTask?: boolean;
	agent?: string;
	role?: string | string[];
	/** Model-purpose metadata, distinct from the agent-context `role` field. */
	profileRole?: WorkflowProfileRole;
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	approvalMode?: ApprovalMode;
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	worktreePolicy?: WorktreePolicy;
	maxRuntimeMs?: number;
	maxConcurrency?: number;
	maxItems?: number;
	from?:
		| string
		| string[]
		| {
				source: string;
				path: string;
				streaming?: { enabled: true; minChunk?: number };
		  };
	after?: string | string[];
	sourcePolicy?: "success" | "partial" | "require-success";
	sourceProjection?: {
		include?: string[];
		maxChars?: number;
	};
	inputPolicy?: {
		requiredReads?: ArtifactGraphRequiredRead[];
		requiredReadPolicy?: RequiredWorkflowArtifactReadPolicy[];
		enforcement?: "fail";
		artifactAccess?: "enabled" | "none";
		terminalBarrier?: "all-sources";
		invalidateOnDependencyResume?: true;
		maxCompiledPromptChars?: number;
	};
	output?: {
		controlSchema?: string;
		analysis?: { required?: boolean };
		refs?: { required?: boolean; minItems?: number };
		maxDigestChars?: number;
		partial?: { paths: string[] };
	};
	each?: ArtifactGraphForeachSpec;
	stages?: ArtifactGraphStageSpec[];
	outputFrom?: string;
	support?: { uses: string; options?: Record<string, unknown> };
	dynamic?: DynamicWorkflowStageSpec;
	until?: unknown;
	/** Explicit null removes the round cap; omission is invalid for loops. */
	maxRounds?: number | null;
	progressPath?: string;
	onExhausted?: ArtifactGraphStageSpec;
}

export interface ValidationIssue {
	path: string;
	message: string;
}

export class WorkflowValidationError extends Error {
	readonly issues: ValidationIssue[];

	constructor(issues: ValidationIssue[]) {
		super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
		this.name = "WorkflowValidationError";
		this.issues = issues;
	}
}

export interface AgentDefinition {
	name: string;
	displayName: string;
	description?: string;
	packageName?: string;
	aliases: string[];
	sourcePath: string;
	scope: "project" | "user" | "bundled";
	frontmatter: Record<string, unknown>;
	body: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	tools?: string[];
	readOnly?: boolean;
	approvalMode?: ApprovalMode;
	maxSubagentDepth: number;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
}

export interface CompiledRole {
	name: string;
	fromAgent?: string;
	sourcePath?: string;
	content: string;
	maxChars: number;
	truncated: boolean;
	includedSections: string[];
	excludedSections: string[];
}

export type TaskCapability = ToolClassification;

export interface PermissionPreview {
	status: "pending" | "blocked";
	statusDetail?: "pending_approval" | "needs_attention";
	reason?: string;
}

export interface CompiledTaskRuntime {
	model?: string;
	api?: string;
	thinking?: ThinkingLevel;
	thinkingResolution?: WorkflowRuntimeThinkingResolution;
	fast?: FastMode;
	approvalMode: ApprovalMode;
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	/**
	 * Host-tool inheritance was deliberately enabled (or explicitly disabled).
	 * Pi executor only (WP6): when `true` the Pi adapter adds the launching
	 * host's own tools (codemode, `mcp__*`, MCP resources). Core already
	 * classifies such a task as mutation-capable.
	 */
	inheritHostTools?: boolean;
	maxRuntimeMs?: number;
	/**
	 * WP31: executor id of this task in a run with a role profile (mixed executors, Q4). Absent:
	 * the run's executor (`run.executor`).
	 */
	executor?: string;
}

export interface CompiledTaskSafety {
	readOnlyDeclared: boolean;
	capability: TaskCapability;
	sharedCwdSafe: boolean;
	worktreePolicy: WorktreePolicy;
	requiresWorktree: boolean;
	/**
	 * D2/R#5: present only when the executing user's run option
	 * `allowSharedCheckoutWrites` waived the worktree a write-capable task
	 * would otherwise require under `worktreePolicy: "off"`.
	 */
	allowSharedCheckoutWrites?: true;
	permission: PermissionPreview;
}

export type LoopUntilLeaf = {
	stage?: string;
	source?: string;
	path: string;
	equals?: string | number | boolean | null;
	notEquals?: string | number | boolean | null;
	lengthEquals?: number;
	exists?: boolean;
};

export type LoopUntilCondition =
	| LoopUntilLeaf
	| { all: LoopUntilCondition[] }
	| { any: LoopUntilCondition[] };

export type LoopResultStatus =
	| "failed"
	| "completed"
	| "exhausted"
	| "stopped_no_progress";

export interface CompiledLoopChildTaskRef {
	loopId: string;
	round: number;
	roundTag: string;
	childStageId: string;
	childTaskId: string;
	firstChildStage: boolean;
}

export interface CompiledLoopStageRecord {
	id: string;
	type: "loop";
	sourcePolicy?: string;
	maxRounds: number | null;
	until: LoopUntilCondition;
	childStageIds: string[];
	childTemplates: CompiledTask[];
	childStageRecords?: Array<{
		id: string;
		type?: string;
		sourcePolicy?: string;
	}>;
	onExhausted?: {
		stageId: string;
		template: CompiledTask;
	};
	progressPath?: string;
}

export interface LoopStateRecord {
	loopId: string;
	round: number;
	status?: LoopResultStatus;
	awaitingOnExhausted?: boolean;
	onExhaustedSpecId?: string;
	updatedAt?: string;
}

export interface LoopWorktreeRecord {
	loopId: string;
	path: string;
	branch: string | null;
	baseCwd: string | null;
}

export interface LoopResultRecord {
	loopId: string;
	status: LoopResultStatus;
	roundsUsed: number;
	worktreePath: string | null;
	finalCheck?: unknown;
	summary: string;
}

export interface WorkflowSourceContextSpec {
	maxPreviewChars?: number;
	maxStructuredChars?: number;
	maxStructuredCharsByStage?: Record<string, number>;
	structuredOutputPathsByStage?: Record<string, string[]>;
	maxPacketChars?: number;
}

export interface CompiledDynamicWorkflowBudget {
	maxAgents: number;
	maxConcurrency: number;
	maxRuntimeMs: number;
	maxNestedWorkflowDepth: number;
	maxGraphMutations: number;
	maxHelperRuns: number;
}

export interface CompiledDynamicWorkflowHelper {
	uses: string;
	usesPath?: string;
	inputSchema?: string;
	inputSchemaPath?: string;
	outputSchema?: string;
	outputSchemaPath?: string;
	idempotent?: boolean;
}

export interface CompiledDynamicNestedWorkflow {
	uses: string;
	usesPath?: string;
}

export interface CompiledDynamicDecisionLoopExecutionProfile {
	agent?: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	outputProfile?: string;
	maxRuntimeMs?: number;
}

export interface CompiledDynamicDecisionLoop {
	planner?: CompiledDynamicDecisionLoopExecutionProfile;
	workerDefaults?: CompiledDynamicDecisionLoopExecutionProfile;
	verifier?: CompiledDynamicDecisionLoopExecutionProfile;
	synthesis?: CompiledDynamicDecisionLoopExecutionProfile;
	allowedAgents: string[];
	allowedTools?: string[];
	allowedToolProviders?: Record<string, CompiledToolProvider>;
	allowedOutputProfiles: string[];
	maxDecisionRounds: number;
	maxActionsPerRound: number;
	repair: { maxAttempts: number };
	stateIndex: {
		maxFindings?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Accepted and compiled for
		 * compatibility, but not used by the decision-loop runtime.
		 */
		requiredFindingIds?: string[];
	};
	stopPolicy: {
		/**
		 * @deprecated Phase 1 compatibility no-op. Synthesize decisions are
		 * governed by the canonical decision validator instead.
		 */
		requireSynthesisAction: boolean;
		failOnInvalidDecision: boolean;
		/**
		 * Maximum progress-aware stall score before the dynamic loop asks the
		 * planner for a bounded replan.
		 */
		maxStalls: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Dropped-branch enforcement is
		 * deferred; invalid/omitted work is surfaced via blockers/omissions.
		 */
		failOnDroppedRequiredBranch: boolean;
	};
}

export interface CompiledDynamicWorkflowTask {
	uses: string;
	usesPath?: string;
	mode: "graph-splice";
	budget: CompiledDynamicWorkflowBudget;
	permissions: {
		approval: "auto" | "ask";
		allowDynamicRoles: boolean;
		allowDynamicTools: boolean;
	};
	helpers: Record<string, CompiledDynamicWorkflowHelper>;
	workflows: Record<string, CompiledDynamicNestedWorkflow>;
	decisionLoop?: CompiledDynamicDecisionLoop;
	runtimeOverrides?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
}

export interface WorkflowResourcePolicy {
	version: 1;
	skillDiscovery: "ambient" | "disabled";
	contextFiles: "disabled";
}

export interface CompiledArtifactGraphTask {
	enabled: true;
	output: {
		analysisRequired: boolean;
		refsRequired: boolean;
		refsMinItems?: number;
		refsUrlValidation?: boolean;
		controlSchema?: string;
		controlSchemaPath?: string;
		maxDigestChars?: number;
		partial?: { paths: string[] };
	};
	requiredReads: ArtifactGraphRequiredRead[];
	requiredReadPolicy?: RequiredWorkflowArtifactReadPolicy[];
	artifactAccess: "enabled" | "none";
	inputPolicy?: {
		terminalBarrier?: "all-sources";
		invalidateOnDependencyResume?: true;
		maxCompiledPromptChars?: number;
	};
	sourceProjection?: {
		include?: string[];
		maxChars?: number;
	};
}

export interface CompiledTask {
	id: string;
	agent: string;
	agentPath: string;
	agentDescription?: string;
	agentSystemPrompt: string;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	/** Absent means the task permanently retains pre-policy launch behavior. */
	resourcePolicyVersion?: 1;
	roleNames: string[];
	task: string;
	cwd: string;
	explicitCwd: boolean;
	explicitWorktreePolicy: boolean;
	runtime: CompiledTaskRuntime;
	safety: CompiledTaskSafety;
	outputContract?: string;
	sourceContext?: WorkflowSourceContextSpec;
	compiledPrompt: string;
	kind?: string;
	stageId?: string;
	taskId?: string;
	stageMaxConcurrency?: number;
	dependsOn?: string[];
	contextDependsOn?: string[];
	generation?: number;
	sourceGeneration?: number;
	foreach?: {
		from: unknown;
		prompt: string;
		maxItems?: number;
		/** Profile-only v1 batch metadata; base authored stages cannot set it. */
		batch?: ExecutionProfileForeachBatch;
		itemIdentityPath?: string;
		itemPayloadPath?: string;
		injectRuntimeTask: boolean;
		roleText?: string;
	};
	support?: {
		uses: string;
		options?: Record<string, unknown>;
	};
	dynamic?: CompiledDynamicWorkflowTask;
	dynamicGenerated?: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		branchId?: string;
		outputProfile?: string;
		/** Captured diagnostics for event-only recovery; absent on legacy tasks. */
		resourceWarnings?: string[];
	};
	/** Runtime-only synthetic carrier for one transparent foreach batch launch. */
	foreachBatchSynthetic?: {
		schema: "workflow-foreach-batch-v1";
	};
	foreachGenerated?: {
		placeholderSpecId: string;
		itemIdentity?: string;
		itemHash?: string;
		itemSourceTaskId?: string;
		itemSourceSpecId?: string;
		itemSourceKind?: "control" | "partial";
		itemRef?: string;
		sourceLineageDigest?: string;
		resolvedTaskId?: string;
		perItemDispatch?: true;
		batch?: WorkflowForeachBatchGrouping;
	};
	loopChild?: CompiledLoopChildTaskRef;
	loopPlaceholder?: {
		loopId: string;
	};
	loopExhausted?: {
		loopId: string;
		status: LoopResultStatus;
	};
	artifactGraph?: CompiledArtifactGraphTask;
}

export type TaskRunStatus =
	| "pending"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped"
	| "interrupted";
export type WorkflowRunStatus =
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "interrupted";

export interface WorkflowTaskUsageValues {
	inputTokens?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
	cachedInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	cacheReadInputTokens?: number | null;
	reasoningTokens?: number | null;
	costUsd?: number | null;
}

export interface WorkflowTaskUsageAttemptRecord
	extends WorkflowTaskUsageValues {
	source: string;
	capturedAt: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel | string;
	backendRunId?: string;
	backendAttemptId?: string;
	unavailable?: true;
	raw?: unknown;
}

export interface WorkflowTaskUsageAggregateRecord
	extends WorkflowTaskUsageValues {
	attempts: number;
	incomplete?: boolean;
}

export interface WorkflowTaskUsageRecord extends WorkflowTaskUsageValues {
	source: "executor";
	capturedAt: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel | string;
	incomplete?: boolean;
	aggregate?: WorkflowTaskUsageAggregateRecord;
	attempts?: WorkflowTaskUsageAttemptRecord[];
}

export type WorkflowToolResultBudgetConfigurationSource =
	| "default"
	| "environment"
	| "disabled";

export interface WorkflowTaskToolResultBudgetAttemptRecord {
	source: string;
	capturedAt: string;
	configuredAt?: string;
	backendRunId?: string;
	backendAttemptId?: string;
	configured?: boolean;
	configurationSource?: WorkflowToolResultBudgetConfigurationSource;
	configuredMaxTotalChars?: number;
	terminal?: true;
	reported?: true;
	enabled?: boolean;
	maxTotalChars?: number;
	warning?: string;
	toolResults?: number;
	retainedChars?: number;
	evictedCount?: number;
	evictedChars?: number;
	evictableCount?: number;
	forcedEvictionApplied?: boolean;
	contextLengthExceeded?: boolean;
	contextOverflowRecovered?: boolean;
	contextRecovered?: boolean;
	unavailable?: true;
}

export interface WorkflowTaskToolResultBudgetConfigurationRecord {
	configuredAt: string;
	configured: boolean;
	configurationSource: WorkflowToolResultBudgetConfigurationSource;
	configuredMaxTotalChars?: number;
}

export interface WorkflowTaskToolResultBudgetAggregateRecord {
	attempts: number;
	terminalAttempts: number;
	pendingAttempts: number;
	reportingAttempts: number;
	unavailableAttempts: number;
	configuredAttempts: number;
	disabledConfigurationAttempts: number;
	backendEnabledAttempts: number;
	backendDisabledAttempts: number;
	evictionCounterExpectedAttempts: number;
	evictionCounterReportingAttempts: number;
	observedEvictedCount: number;
	observedEvictedChars: number;
	evictionAttempts: number;
	warningAttempts: number;
	forcedEvictionAttempts: number;
	contextRecoveryAttempts: number;
	contextRecoveredAttempts: number;
	contextOverflowRecoveredAttempts: number;
	contextLengthExceededAttempts: number;
	configuredMaxTotalChars?: number | null;
	backendMaxTotalChars?: number | null;
	maxToolResults?: number;
	maxRetainedChars?: number;
	maxEvictableCount?: number;
	maxUtilization?: number;
	incomplete?: boolean;
}

export interface WorkflowTaskToolResultBudgetRecord {
	source: "executor";
	capturedAt: string;
	incomplete?: boolean;
	pendingConfiguration?: WorkflowTaskToolResultBudgetConfigurationRecord;
	aggregate: WorkflowTaskToolResultBudgetAggregateRecord;
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[];
}

export interface WorkflowTaskTimingAttemptRecord {
	source: string;
	capturedAt: string;
	backendRunId?: string;
	backendAttemptId?: string;
	launchQueuedAt?: string;
	launchStartedAt?: string;
	launchCompletedAt?: string;
	launchWaitMs?: number;
	launchDurationMs?: number;
	waiting_for_global_worker_slot?: boolean;
	executionStartedAt?: string;
	executionCompletedAt?: string;
	executionMs?: number | null;
	totalMs?: number;
}

export interface WorkflowTaskTimingAggregateRecord {
	attempts: number;
	launchWaitMs?: number | null;
	launchDurationMs?: number | null;
	executionMs?: number | null;
	totalMs?: number | null;
	incomplete?: boolean;
}

export interface LaunchBootstrapProvenanceRecordBase {
	identitySha256: string;
	workflow: { type: string; specPathSha256: string };
	runId: string;
	task: { taskId: string; specId: string; generation?: number };
	attempt: {
		key: string;
		launchRetry: number;
		outputRetry: number;
		resume: number;
		/** Physical batch/fallback attempt; absent for legacy/non-batch records. */
		physicalAttempt?: number;
	};
	sessionId?: string;
	backend: { id: string; type: string; mode: string };
	prompt: { sha256: string; bytes: number };
	/**
	 * Artifact access binding. `configSha256` covers the canonical JSON of the
	 * ArtifactAccessConfig, `serverSpecSha256` the canonical JSON of the
	 * workflow_artifact MCP server launch spec (replaces the Pi extension
	 * wrapper bytes digest).
	 */
	artifacts?: {
		manifestSha256: string;
		configSha256: string;
		serverSpecSha256: string;
	};
	effectiveLaunch: {
		noExtensions?: true;
		/** Pi executor only (WP6): Pi extension paths and generated wrappers. */
		extensions: Array<{
			pathSha256: string;
			generated?: {
				kind: "fetch-cache" | "web-source" | "openai-fast" | "native-host";
				wrapperSha256: string;
				configSha256: string;
			};
		}>;
		captureToolCalls: boolean;
		toolResultBudgetSha256?: string;
		artifactBinding?: {
			manifestPathSha256: string;
			manifestBytesSha256: string;
			configPathSha256: string;
			configBytesSha256: string;
			serverSpecSha256: string;
		};
	};
	effectivePolicy: {
		tools: string[];
		/** The executor may add inherited host tools (Pi only). */
		inheritHostTools?: true;
		toolProvidersSha256: string;
		externalLaunchGrantSha256?: string;
		model?: string;
		api?: string;
		thinking?: string;
		fast?: string;
		approvalMode: string;
		maxRuntimeMs?: number;
		cwdSha256: string;
		stateRootSha256?: string;
		worktree: {
			enabled: boolean;
			pathSha256?: string;
			branchSha256?: string;
			baseCwdSha256?: string;
		};
	};
	sourceDependencies: {
		contextDependsOn: string[];
		sourceProjection?: unknown;
		requiredReads?: unknown;
		requiredReadPolicy?: unknown;
		artifactAccess?: string;
	};
}

/** Byte-compatible launch provenance for tasks compiled before resource policy. */
export interface LaunchBootstrapProvenanceRecordV1
	extends LaunchBootstrapProvenanceRecordBase {
	schema: "agent-workflow-launch-bootstrap-provenance-v1";
}

/** Explicit sealed resource-policy capture for newly compiled tasks. */
export interface LaunchBootstrapProvenanceRecordV2
	extends LaunchBootstrapProvenanceRecordBase {
	schema: "agent-workflow-launch-bootstrap-provenance-v2";
	resourcePolicy: WorkflowResourcePolicy;
}

export type LaunchBootstrapProvenanceRecord =
	| LaunchBootstrapProvenanceRecordV1
	| LaunchBootstrapProvenanceRecordV2;

export interface LaunchBootstrapProvenanceHistory {
	version: 1;
	records: LaunchBootstrapProvenanceRecord[];
}

export interface WorkflowLaunchAuthorityGrant {
	schema: "agent-workflow-launch-authority-v1";
	identitySha256: string;
	issuer: "agent-workflow-engine";
	operation: "launch-task";
	runId: string;
	task: { taskId: string; specId: string; generation?: number };
	attemptKey: string;
	backendId: string;
	launchBootstrapSha256: string;
}

export interface WorkflowLaunchAuthorityRecord {
	grant: WorkflowLaunchAuthorityGrant;
	state:
		| { phase: "issued" }
		| { phase: "registered" }
		| {
				phase: "consumed";
				backendRunId: string;
				backendAttemptId: string;
		  };
}

export interface WorkflowLaunchAuthorityHistory {
	version: 1;
	records: WorkflowLaunchAuthorityRecord[];
}

export interface WorkflowDurableLaunchBarrierDescriptor {
	schema: "pi-subagent-durable-launch-barrier-v2";
	identitySha256: string;
	directory: string;
	readyPath: string;
	decisionPath: string;
	ackPath: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	/** External one-run authority digest bound into the pi-subagent worker plan. */
	authorityBindingSha256?: string;
	directoryIdentity: { device: number; inode: number; uid?: number };
	timeoutMs: number;
	pollIntervalMs: number;
}

export interface WorkflowDurableLaunchBarrierCancellationRecord {
	cancellationId: string;
	requestedAt: string;
	reasonSha256: string;
	decision: "revoked" | "released";
	interruptStatus?: "interrupt-requested" | "already-terminal" | "unsupported";
	terminalAttemptId?: string;
	terminalStatus?: "cancelled" | "completed" | "failed";
	terminalObservedAt?: string;
}

export interface WorkflowDurableLaunchBarrierRecord {
	attemptKey: string;
	launchAuthoritySha256: string;
	/** External authority digest expected in descriptor, READY, and decision. */
	authorityBindingSha256?: string;
	descriptor: WorkflowDurableLaunchBarrierDescriptor;
	phase:
		| "created"
		| "ready"
		| "consumed"
		| "released"
		| "acknowledged"
		| "revoked"
		| "release_won_cancellation_pending"
		| "cancellation_acknowledged";
	readySha256?: string;
	launchPayloadSha256?: string;
	executionPlanSha256?: string;
	decisionSha256?: string;
	ackSha256?: string;
	backendRunId?: string;
	backendAttemptId?: string;
	releasePayloadSha256?: string;
	releaseWinner?: boolean;
	cancellation?: WorkflowDurableLaunchBarrierCancellationRecord;
}

export interface WorkflowDurableLaunchBarrierHistory {
	version: 2;
	records: WorkflowDurableLaunchBarrierRecord[];
}

export interface WorkflowTaskTimingRecord {
	source: "agent-workflow";
	capturedAt: string;
	launchQueuedAt?: string;
	launchStartedAt?: string;
	launchCompletedAt?: string;
	launchWaitMs?: number;
	launchDurationMs?: number;
	waiting_for_global_worker_slot?: boolean;
	launchSlotReleaseDelayMs?: number;
	maxConcurrentLaunches?: number;
	maxLiveModelWorkers?: number;
	experimentalLaunchRampEnabled?: boolean;
	adaptiveLiveModelWorkersEnabled?: boolean;
	adaptiveLiveModelWorkers?: Record<
		string,
		{
			limit: number;
			lastDecision: string;
			baselineMs?: number;
			samples: number;
		}
	>;
	executionStartedAt?: string;
	executionCompletedAt?: string;
	executionMs?: number | null;
	totalMs?: number;
	refreshReconcileMs?: number;
	refreshStatusPollMs?: number;
	terminalOutputCopyMs?: number;
	terminalStderrCopyMs?: number;
	terminalOutputBytes?: number;
	terminalStderrBytes?: number;
	terminalArtifactMaterializeMs?: number;
	terminalArtifactBundleWriteMs?: number;
	aggregate?: WorkflowTaskTimingAggregateRecord;
	attempts?: WorkflowTaskTimingAttemptRecord[];
}

export type WorkflowForeachBatchPhase =
	| "prepared"
	| "launching"
	| "running"
	| "terminal_received"
	| "committing"
	| "completed"
	| "fallback_prepared"
	| "fallback_applied"
	| "stopped"
	| "invalidated"
	| "non_reusable";

/** Per-task ownership marker for an active or archived transparent foreach batch. */
export interface WorkflowForeachBatchTaskState {
	batchId: string;
	role: "leader" | "member";
	phase: WorkflowForeachBatchPhase;
	/** Durable identity of the physical batch/singleton attempt owning this task. */
	physicalAttempt?: number;
	/** Prevent a malformed/failed batch from being selected again for this item. */
	batchingDisabled?: true;
}

export interface WorkflowForeachBatchMember {
	taskId: string;
	specId: string;
	role: "leader" | "member";
	/** Final singleton prompt prepared before the physical batch launch. */
	preparedPrompt: string;
	preparedPromptSha256: string;
}

/**
 * Durable ownership and terminal-demux journal for one physical max-2 launch.
 * Records are retained after completion/fallback so restart never infers members
 * from list adjacency.
 */
export interface WorkflowForeachBatchRecord {
	version: 1;
	batchId: string;
	placeholderSpecId: string;
	stageId?: string;
	generation?: number;
	sourceGeneration?: number;
	grouping: WorkflowForeachBatchGrouping;
	executionSurfaceSha256: string;
	stateRootSha256?: string;
	capabilitySubjectSha256?: string;
	dispatch?: {
		schema: "workflow-foreach-batch-dispatch-v1";
		state: "reserved" | "terminal_received" | "reconciled" | "non_reusable";
		attemptKey: string;
		reservationSha256: string;
		reservedAt: string;
		terminalReceivedAt?: string;
		reconciledAt?: string;
		reason?: string;
	};
	members: [WorkflowForeachBatchMember, WorkflowForeachBatchMember];
	attempt: number;
	phase: WorkflowForeachBatchPhase;
	preparedAt: string;
	batchPrompt: string;
	batchPromptSha256: string;
	terminal?: {
		receivedAt: string;
		rawPath: string;
		receiptPath: string;
		rawSha256: string;
		backendRunId?: string;
		backendAttemptId?: string;
		status: "completed" | "failed" | "interrupted";
		completedAt?: string;
		startedAt?: string;
		exitCode?: number;
	};
	fallback?: {
		preparedAt: string;
		appliedAt?: string;
		reason: string;
		diagnosticsPath?: string;
	};
	commit?: {
		startedAt: string;
		completedAt?: string;
	};
	/** Physical-call observability; logical members are not double-counted. */
	physicalExecution?: {
		leaderTaskId: string;
		usage?: WorkflowTaskUsageRecord;
		timing?: WorkflowTaskTimingRecord;
	};
}

/** Worker CLI session an executor kept for this task (R#10, D3); retention deletes only these. */
export interface WorkflowTaskOwnedSessionRecord {
	executorId: string;
	kind: string;
	locator: string;
	backendRunId: string;
	backendAttemptId: string;
	recordedAt: string;
	/**
	 * WP12a (D3): the engine released this session once no attempt could use it again (task
	 * completed/skipped, or run completed/failed). `deleted`/`not_found`: gone; `unsupported`: the
	 * executor has no deleteOwnedSession; `refused`/`failed`: kept, prune retries.
	 */
	release?: {
		at: string;
		outcome: "deleted" | "not_found" | "unsupported" | "refused" | "failed";
		error?: string;
	};
}

export interface WorkflowTaskRunRecord {
	activity?: TaskActivity;
	/** Engine-owned worker sessions reported by the executor (R#10). */
	ownedSessions?: WorkflowTaskOwnedSessionRecord[];
	taskId: string;
	specId: string;
	displayName: string;
	agent: string;
	agentDescription?: string;
	agentFile: string;
	roles: string[];
	status: TaskRunStatus;
	statusDetail: string;
	runtime: {
		model?: string;
		api?: string;
		thinking?: ThinkingLevel;
		thinkingResolution?: WorkflowRuntimeThinkingResolution;
		fast?: FastMode;
		approvalMode: ApprovalMode;
		maxRuntimeMs?: number;
		/** WP31: the task's executor in a run with a role profile (absent: `run.executor`). */
		executor?: string;
	};
	tools?: string[];
	cwd: string;
	worktree: {
		enabled: boolean;
		path: string | null;
		branch: string | null;
		baseCwd: string | null;
		warning: string | null;
		snapshot?: WorktreeSnapshotRecord;
	};
	backendTaskId: string;
	pid?: number;
	launchToken?: string;
	backendHandle?: WorkflowBackendHandle;
	kind?: string;
	stageId?: string;
	dependsOn?: string[];
	terminalBarrier?: {
		mode: "all-sources";
		sourceSpecIds: string[];
	};
	generation?: number;
	sourceGeneration?: number;
	dispatchMap?: {
		version: 1;
		generation: number;
		sourceTaskId: string;
		entries: Array<{
			itemIdentity: string;
			taskId: string;
			specId: string;
			itemSourceTaskId: string;
			itemSourceSpecId: string;
			itemSourceKind: "control" | "partial";
			itemRef: string;
			itemHash: string;
			perItemDispatch?: true;
		}>;
		digest: string;
	};
	promptMetadata?: {
		version: 1;
		chars: number;
		maxChars?: number;
		measuredAt: string;
	};
	/** Internal persisted launch identity; not a workflow authoring or package API. */
	launchBootstrap?: LaunchBootstrapProvenanceHistory;
	/** Internal host-owned launch grant; not an external authority or public API. */
	launchAuthority?: WorkflowLaunchAuthorityHistory;
	/** General pi-subagent durable launch barrier receipts, retained by attempt. */
	durableLaunchBarrier?: WorkflowDurableLaunchBarrierHistory;
	startedAt?: string;
	completedAt?: string;
	elapsedMs?: number;
	usage?: WorkflowTaskUsageRecord;
	toolResultBudget?: WorkflowTaskToolResultBudgetRecord;
	timing?: WorkflowTaskTimingRecord;
	exitCode?: number;
	files: {
		systemPrompt: string;
		taskPrompt: string;
		output: string;
		stderr: string;
		result: string;
	};
	backendFiles?: Record<string, string>;
	/** Host-owned raw byte integrity for the current materialized generation. */
	rawArtifactIntegrity?: import("./workflow-raw-contract.js").RawIntegrity;
	lastMessage?: string;
	outputRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
		artifacts?: string[];
		repairMode?: "same_session" | "new_session";
		sessionId?: string;
	};
	resumeEvents?: WorkflowTaskResumeEvent[];
	artifactGraph?: CompiledArtifactGraphTask;
	dynamicGenerated?: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		branchId?: string;
		outputProfile?: string;
	};
	foreachGenerated?: {
		placeholderSpecId: string;
		itemIdentity?: string;
		itemHash?: string;
		itemSourceTaskId?: string;
		itemSourceSpecId?: string;
		itemSourceKind?: "control" | "partial";
		itemRef?: string;
		sourceLineageDigest?: string;
		resolvedTaskId?: string;
		perItemDispatch?: true;
		batch?: WorkflowForeachBatchGrouping;
	};
	/** Internal leader/member ownership for profile-only transparent batching. */
	foreachBatch?: WorkflowForeachBatchTaskState;
	launchRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
		nextEligibleAt?: string;
		retryAfterMs?: number;
	};
}

export interface TaskSummary {
	pending: number;
	running: number;
	blocked: number;
	completed: number;
	failed: number;
	skipped: number;
	interrupted: number;
	total: number;
}

/**
 * Shape of `.agent-workflow/workflows/<runId>/supervisor.json` written by the run-lease
 * heartbeat. `lastTaskTransitionAt`/`taskStatusCounts` are progress signals:
 * `updatedAt` proves the supervisor process is alive, while
 * `lastTaskTransitionAt` proves the run is actually making task progress.
 */
export interface WorkflowSupervisorRecord {
	schemaVersion?: number;
	ownerId?: string;
	pid?: number;
	updatedAt?: string;
	lockFile?: string;
	lastTaskTransitionAt?: string;
	taskStatusCounts?: TaskSummary;
}

export interface WorkflowTaskResumeEvent {
	at: string;
	fromStatus: TaskRunStatus;
	fromStatusDetail: string;
	lastMessage?: string;
	outputRetryAttempts?: number;
	outputRetryReason?: string;
	outputRetryRepairMode?: "same_session" | "new_session";
	launchRetryAttempts?: number;
	launchRetryReason?: string;
	backendRunId?: string;
	backendAttemptId?: string;
}

export type WorkflowRouteDecision = "direct" | "dynamic" | "workflow";
export type WorkflowRouteDepth = "quick" | "standard" | "max";

/** Where a run's executor came from (B2: run flag > workflow profile > user profile > default). */
export type WorkflowRunExecutorSource =
	| "run-flag"
	/** WP31: the saved per-workflow preference (role overrides). */
	| "workflow-preference"
	| "workflow-profile"
	| "user-profile"
	/** Explicit host override (`defaultExecutor`) or a legacy record without a selection. */
	| "default"
	/** WP17: the host's own CLI (Claude Code → claude, Codex → codex, Pi → pi). */
	| "host-default"
	/** WP17: terminal CLI, first installed and logged-in of pi → claude → codex. */
	| "installed-default";

/** WP17: host identity a host passes to the engine (`--host` of the MCP server, Pi host, CLI). */
/** `generic`: a host MCP client other than Claude Code/Codex (no own CLI; uses the installed order). */
export type WorkflowHostId = "claude-code" | "codex" | "pi" | "cli" | "generic";

/** WP17: non-secret probe state of one candidate the `installed-default` rule looked at. */
export interface WorkflowRunExecutorCandidate {
	id: string;
	installed: boolean;
	cliVersion: string | null;
	auth: AuthStatus;
	/** installed and auth not missing/expired (`unknown` counts as usable). */
	usable: boolean;
}

/** Executor chosen for a run, frozen at creation (agent-workflow WP4c). */
export interface WorkflowRunExecutorSelection {
	id: string;
	source: WorkflowRunExecutorSource;
	/** Profile name when the source is a profile. */
	profile?: string;
	/** WP17: the host whose rule chose the default (`host-default`/`installed-default`). */
	host?: WorkflowHostId;
	/** WP17: candidates probed by the `installed-default` rule, in order. */
	candidates?: WorkflowRunExecutorCandidate[];
	descriptor: ExecutorDescriptor;
}

/** Executor readiness from `probe()` (no model turn, no secrets), recorded per run (WP4d). */
export interface WorkflowExecutorProbeSummary {
	installed: boolean;
	cliVersion: string | null;
	auth: AuthStatus;
	notes?: string[];
	/**
	 * WP5b: the probe's declared MCP output limit (R#9), present only when the probe reports one.
	 * The task backend derives the artifact server's `--max-output-chars` from it.
	 */
	mcpOutputLimitChars?: number;
	/** WP5b: what the CLI adds around a result it cut, present only when the probe reports it. */
	mcpOutputNoticeChars?: number;
	probedAt: string;
	/** Nested runs reuse the parent's probe instead of probing again. */
	reusedFromRunId?: string;
}

/** One negotiated stage (compiled task template) of a run (WP4d). */
export interface WorkflowStageCapabilityNegotiation {
	/** Compiled task id (spec id) the report belongs to. */
	label: string;
	stageId?: string;
	/** `launch`: a runtime-generated task first negotiated at its launch. */
	negotiatedAt: "pre-launch" | "launch";
	report: NegotiationReport;
	/**
	 * WP31×WP35: present when the host lent its tools (Pi host): whether this stage inherits them
	 * (`inherited`: pi executor) or why not (`readOnly`, `no-tools`, `executor`: not pi).
	 */
	hostTools?: "inherited" | "readOnly" | "no-tools" | "executor";
}

/** B4 negotiation record (design §8.3, owner decisions B4/B5). */
/** Where a run's permission mode came from (WP4e; B2 precedence). */
export type WorkflowRunPermissionModeSource =
	| "run-flag"
	| "workflow-profile"
	| "user-profile"
	| "default"
	| "parent-run";

/** Effective permission mode frozen at run creation (WP4e, D2 revised). */
export interface WorkflowRunPermissionMode {
	mode: "free" | "safe";
	source: WorkflowRunPermissionModeSource;
	/** Profile name when the source is a profile. */
	profile?: string;
}

export interface WorkflowRunCapabilityNegotiation {
	schema: "agent-workflow-capability-negotiation-v1";
	executorId: string;
	executorVersion: string;
	contractVersion: string;
	probe: WorkflowExecutorProbeSummary;
	/** Declared capabilities merged with the probe's rows (`mergeProbedCapabilities`). */
	capabilities: ExecutorCapabilities;
	policy: {
		interactive: boolean;
		allowUnverified: string[];
		strict: string[];
		allowReadOnlyDowngrade: boolean;
		/** WP4e; absent on records created before WP4e (= safe). */
		permissionMode?: "free" | "safe";
		/** 2026-11-04: the run's experimental same-session repair is on (absent = off). */
		sameSessionRepair?: boolean;
	};
	/** `confirmed`: an interactive host accepted the degradations before launch. */
	confirmation: "not-needed" | "confirmed" | "non-interactive";
	/**
	 * How a `confirmed` run was confirmed: the host's dialog, or (2026-11-03) the user's answer in
	 * the conversation relayed by the agent (`acceptDegradations`) where the client cannot show one.
	 */
	confirmedVia?: "dialog" | "chat";
	stages: WorkflowStageCapabilityNegotiation[];
	/** `<stage>: <code>` for every degraded entry. */
	degradations: string[];
	/** Stages launched with readOnly enforced (B4 readOnly downgrade). */
	forcedReadOnly: string[];
	/** Pre-start preview text shown to hosts. */
	preview: string;
	/** One-line notices (model/effort names the probe cannot confirm, …), also in `preview`. */
	notices?: string[];
	/** What the run's executor can name (tools, models, efforts): checks stages generated later. */
	names?: WorkflowRunExecutorNames;
	/**
	 * WP31 (Q4): the other executors of a mixed run (role profile), each probed once. Stage reports
	 * name their executor (`report.executorId`); the top-level fields belong to `executorId`.
	 */
	executors?: Record<string, WorkflowRunNegotiatedExecutor>;
}

/**
 * 2026-10-30: an executor's vocabulary as probed before launch (no model call), recorded so a stage
 * generated during the run (dynamic/auto) is checked like the planned ones before it is submitted.
 */
export interface WorkflowRunExecutorNames {
	/** Workflow tool names the executor maps; absent when its adapter declares no mapping. */
	tools?: string[];
	/** Models its probe lists (absent: not listable). */
	models?: string[];
	modelListComplete?: boolean;
	/** Effort levels per model, when the CLI reports them. */
	modelEfforts?: Record<string, string[]>;
}

/** WP31: probe and effective capabilities of one more executor of a mixed run. */
export interface WorkflowRunNegotiatedExecutor {
	executorVersion: string;
	contractVersion: string;
	probe: WorkflowExecutorProbeSummary;
	capabilities: ExecutorCapabilities;
	names?: WorkflowRunExecutorNames;
}

/** WP31: where a stage's executor came from (B2 precedence extended to roles). */
export type WorkflowStageExecutorSource =
	| WorkflowRunExecutorSource
	| "parent-stage";

/** WP31: the resolved role assignment of one model-backed stage slot. */
export interface WorkflowStageRoleAssignment {
	executor: string;
	source: WorkflowStageExecutorSource;
	/** Profile (or workflow) name of the layer that chose the executor. */
	profile?: string;
	/** Role key that matched (`agent:<name>`, a profileRole or `default`). */
	role?: string;
	/** Model / effort a role entry set (absent: stage, agent, run defaults or the executor's own). */
	model?: string;
	effort?: ThinkingLevel;
}

/** WP31: role-profile resolution frozen at run creation (absent when no role profile applies). */
export interface WorkflowRunRoleExecution {
	schema: "agent-workflow-role-execution-v1";
	/** More than one executor runs stages of this run (Q4). */
	mixed: boolean;
	/** Every executor the run uses, including `run.executor`. */
	executors: Record<string, WorkflowRunExecutorSelection>;
	/** Canonical stage slot id → assignment. */
	stages: Record<string, WorkflowStageRoleAssignment>;
	/** Layers that contributed, in precedence order. */
	layers: Array<{ tier: string; name: string }>;
	warnings?: string[];
}

/** Effective declared or user-saved profile frozen into a new run. */
export interface WorkflowRunExecutionProfile {
	/** Selected declared or user-saved profile name. */
	name: string;
	/** Executor id a saved user profile selects (B2); declared profiles use the spec's executionProfileExecutors. */
	executor?: string;
	/**
	 * Capability keys that must be `native` for this profile (WP4d `ctx.strict`);
	 * declared profiles use the spec's executionProfileStrictCapabilities.
	 */
	strictCapabilities?: string[];
	/**
	 * Permission mode a saved user profile selects (WP4e); declared profiles
	 * use the spec's executionProfilePermissionModes.
	 */
	permissionMode?: "free" | "safe";
	/** Definition identity captured with a user-saved profile before launch. */
	definitionFingerprint?: string;
	/** WP31: role map of a saved user profile or preset. */
	roles?: WorkflowRoleMap;
	/** Canonical stage-id → captured profile overrides applied at compile time. */
	stageOverrides: Record<string, ExecutionProfileStageOverride>;
}

/** A user profile resolved against one exact authored definition before launch. */
export interface WorkflowCapturedExecutionProfile
	extends WorkflowRunExecutionProfile {
	definitionFingerprint: string;
}

/** Launch-time profile choice: declared spec id or a captured user profile. */
export interface WorkflowExecutionProfileSelection {
	executionProfile?: string;
	executionProfileOverride?: WorkflowCapturedExecutionProfile;
}

/** Legacy routing audit retained for historical run records; new explicit launches omit it. */
export interface WorkflowRunRouting {
	requested: string;
	decided: WorkflowRouteDecision;
	depth: WorkflowRouteDepth;
	confidence: number;
	reason: string;
	/** Wall-clock duration of the opt-in router classifier pass in milliseconds. */
	routerElapsedMs?: number;
	routerModel?: string;
	routerThinking?: string;
}

export interface WorkflowRunProvenance {
	mode?: string;
	requestedWorkflow?: string | null;
	specPath?: string | null;
	userSelectedWorkflow?: boolean;
	generatedSpec?: boolean;
	runtimeBundle?: string;
	runtimeVersion?: string;
	[key: string]: unknown;
}

export type WorkflowRunLaunchProfile =
	| { kind: "named"; name: string }
	| { kind: "base" }
	| { kind: "not-applicable" };

export type WorkflowRunLaunchCommandMetadata =
	| {
			state: "captured";
			artifact: "launch-command.txt";
			encoding: "utf-8";
			bytes: number;
			sha256: string;
			/**
			 * WP33 (host-neutral launch capture, schema `agent-workflow-run-launch-v1`):
			 * `agent-workflow-host-command-v1` = the host's own command line (`agent-workflow run …`, `/aw run …`) and
			 * `agent-workflow-tool-call-v1` = a tool call rendered as `<tool> <JSON arguments>`; both
			 * with credentials redacted and the home directory shown as `~`.
			 */
			fidelity: WorkflowRunLaunchCommandFidelity;
			sensitivity: "user-input";
			disclosure: "explicit-only";
	  }
	| { state: "unavailable"; reason: "not-a-command" };

export type WorkflowRunLaunchCommandFidelity =
	| "agent-workflow-host-command-v1"
	| "agent-workflow-tool-call-v1";

export type WorkflowAutoRoute = "direct" | "named-workflow" | "direct-dynamic";

/**
 * WP33 (parity row 35): launch provenance of a run launched through the host API (CLI, Pi host,
 * host MCP server): `schema`, `source`, `entry`, `requestKind`, `routingMode`, `profile`,
 * `task`, `command`. `source` names the host (`cli`, `pi`, `mcp:<host>`) and `entry` how it was
 * asked (a command line or a tool call). The command text (redacted) lives in `launch-command.txt`.
 */
export type WorkflowRunLaunchHostSource = "cli" | "pi" | `mcp:${string}`;

export type WorkflowRunLaunchEntry =
	| { kind: "command"; action: "run" | "dynamic" }
	| { kind: "tool"; name: string };

export interface WorkflowRunLaunchMetadataHostV1 {
	schema: "agent-workflow-run-launch-v1";
	source: WorkflowRunLaunchHostSource;
	entry: WorkflowRunLaunchEntry;
	requestKind: "named-workflow" | "direct-dynamic";
	routingMode: "off";
	profile: WorkflowRunLaunchProfile;
	task: { characters: number; lines: number };
	command: WorkflowRunLaunchCommandMetadata;
}

/** WP32: how the user consented to the auto classifier call. */
export type WorkflowAutoConsentSource = "prompt" | "flag" | "elicitation";

/** WP32: one candidate an auto launch offered (opaque id, kind, workflow label). */
export interface WorkflowRunAutoCandidateRef {
	candidateId: string;
	kind: "named-workflow" | "direct-dynamic";
	label: string;
}

/**
 * WP32 (owner decision Q5): the selection facts of a confirmed host `auto` launch. No task text
 * (its SHA-256 only), no paths, no classifier prose: the offered candidates, the classifier's
 * recommendation, the user's choice, the classifier executor/model and how consent was given.
 */
export interface WorkflowRunHostAutoSelectionMetadata {
	candidates: WorkflowRunAutoCandidateRef[];
	/** Null: the classifier recommended nothing launchable. */
	recommendation: {
		candidateId: string;
		confidence: "high" | "medium" | "low";
	} | null;
	selected: WorkflowRunAutoCandidateRef;
	/** True when the user chose the recommended candidate. */
	choseRecommendation: boolean;
	classifier: { executor: string; model: string | null };
	consent: WorkflowAutoConsentSource;
	taskSha256: string;
	confirmed: true;
}

/**
 * WP32: host-neutral launch provenance of a confirmed `auto` launch (CLI `agent-workflow auto`,
 * Pi `/aw auto`, MCP `workflow_auto`). Distinct from `agent-workflow-run-launch-v1` rather than
 * widening its strict `routingMode: "off"`.
 */
export interface WorkflowRunLaunchMetadataHostV2 {
	schema: "agent-workflow-run-launch-v2";
	source: WorkflowRunLaunchHostSource;
	entry: WorkflowRunLaunchEntryAuto;
	requestKind: "named-workflow" | "direct-dynamic";
	routingMode: "auto-confirmed";
	profile: WorkflowRunLaunchProfile;
	task: { characters: number; lines: number };
	selection: WorkflowRunHostAutoSelectionMetadata;
	command: WorkflowRunLaunchCommandMetadata;
}

export type WorkflowRunLaunchEntryAuto =
	| { kind: "command"; action: "auto" }
	| { kind: "tool"; name: string };

/** Structured creation-launch provenance. Exact command text lives in a private sidecar. */
export type WorkflowRunLaunchMetadata =
	| WorkflowRunLaunchMetadataHostV1
	| WorkflowRunLaunchMetadataHostV2;

/** WP33: the host API's capture (the command text is always captured, already redacted). */
export type WorkflowRunLaunchCaptureHostV1 = Omit<
	WorkflowRunLaunchMetadataHostV1,
	"command"
> & {
	command: { state: "captured"; text: string };
};

/** WP32: the host API's capture of a confirmed `auto` launch. */
export type WorkflowRunLaunchCaptureHostV2 = Omit<
	WorkflowRunLaunchMetadataHostV2,
	"command"
> & {
	command: { state: "captured"; text: string };
};

/** Non-persisted launch input carried from a launch surface to the engine. */
export type WorkflowRunLaunchCapture =
	| WorkflowRunLaunchCaptureHostV1
	| WorkflowRunLaunchCaptureHostV2;

/**
 * Deterministic claim-support accounting computed after a direct dynamic
 * run's synthesis completes. Fail-open: audit computation errors are recorded
 * as `{ error }` on the run record instead of failing the run.
 */
export interface WorkflowDynamicRunAudit {
	claimsTotal: number;
	claimsWithSources: number;
	claimsWithoutSources: number;
	refsTotal: number;
	uniqueSourceUrls: number;
	sourceRefJoinFailures: number;
	/** Bounded to 24 entries. */
	unsupportedClaimIds: string[];
	/** Which claim-bearing synthesis control arrays were counted. */
	countedClaimKeys: string[];
	synthesisTaskIds: string[];
}

/**
 * Optional degradation metadata computed when a run reaches a terminal
 * "completed" or "failed" status. Present only when the terminal status hides
 * a partial outcome: work was delivered despite task failures (final-stage
 * tasks completed while other tasks failed), or a completed run leaned on
 * degraded helper output. The run `status` enum is intentionally unchanged;
 * consumers that need the distinction read this field.
 */
export interface WorkflowRunDegradation {
	finalOutputRendered: boolean;
	failedTaskIds: string[];
	degradedHelperTaskIds: string[];
	summary: string;
}

export interface WorkflowRunRecord {
	schemaVersion: 1;
	/** Launching host's references, fixed for this run and its children. */
	hostContext?: import("./host-context.js").HostContext;
	/** Host-level opt-in to host-tool inheritance (Pi executor only, WP6). */
	inheritHostTools?: true;
	/** D2/R#5: the executing user allowed shared-checkout writes for this run. */
	allowSharedCheckoutWrites?: true;
	/**
	 * 2026-11-01: engine-side web quote checks are on for this run (default; off when launched with
	 * AGENT_WORKFLOW_EVIDENCE_REFETCH=0, and absent on runs created before the check). Recorded so
	 * the stage does not depend on the environment of whichever process later drives the run.
	 */
	evidenceRefetch?: true;
	/**
	 * 2026-11-01: run-scoped experimental flags enabled at launch (experimental-speed-flags.ts
	 * RUN_SCOPED_EXPERIMENTAL_FLAGS); absent on runs created before, which read the environment.
	 */
	experimentalFlags?: string[];
	/**
	 * WP4e (D2 revised): effective permission mode and where it came from.
	 * Absent on records created before WP4e; those run as `safe`.
	 */
	permissionMode?: WorkflowRunPermissionMode;
	runId: string;
	name?: string;
	description?: string;
	type: WorkflowRunType;
	artifactGraph?: { enabled: true };
	status: WorkflowRunStatus;
	degradation?: WorkflowRunDegradation;
	taskSummary: TaskSummary;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	failurePolicy?: Required<WorkflowFailurePolicy>;
	parentRunId?: string;
	rootRunId?: string;
	round?: number;
	fanout?: unknown[];
	invalidationJournal?: {
		generation: number;
		idempotencyKey: string;
		sourceTaskIds: string[];
		invalidatedTaskIds: string[];
		artifactState: "pending" | "quarantined";
		status: "prepared" | "applied";
	};
	loopStates?: LoopStateRecord[];
	loopWorktrees?: LoopWorktreeRecord[];
	loopResults?: LoopResultRecord[];
	dynamic?: {
		events: string;
		state: string;
	};
	/** Claim-support audit for direct dynamic runs (fail-open accounting). */
	dynamicAudit?: WorkflowDynamicRunAudit | { error: string };
	createdAt: string;
	updatedAt: string;
	specPath: string;
	provenance?: WorkflowRunProvenance;
	routing?: WorkflowRunRouting;
	executionProfile?: WorkflowRunExecutionProfile;
	/** Executor selection frozen at creation; absent on records created directly through the store. */
	executor?: WorkflowRunExecutorSelection;
	/** WP31: per-stage executor/model/effort of a run with a role profile. */
	roleExecution?: WorkflowRunRoleExecution;
	/**
	 * B4 capability negotiation done before the first launch (WP4d): executor
	 * probe summary, effective capabilities, per-stage reports and the preview.
	 * Absent on records created before WP4d (launch-time checks are skipped).
	 */
	capabilityNegotiation?: WorkflowRunCapabilityNegotiation;
	launch?: WorkflowRunLaunchMetadata;
	/** Durable transparent foreach batch journals, including terminal receipts. */
	foreachBatches?: WorkflowForeachBatchRecord[];
	/** Task-usage rollup persisted when the run reaches a terminal status or blocks (WP12a). */
	usage?: WorkflowRunUsageRollup;
	tasks: WorkflowTaskRunRecord[];
}

/**
 * Run-level sum of per-task provider-reported usage. Values cover only tasks
 * that reported usage (`tasksReporting`); no cost is ever derived from token
 * counts. Parent-session usage lives in the parent-usage.json sidecar, not
 * here, because the parent session does not own run.json.
 */
export interface WorkflowRunUsageRollup extends WorkflowTaskUsageValues {
	source: "task-rollup";
	capturedAt: string;
	taskCount: number;
	tasksReporting: number;
}

export interface WorkflowIndexRecord {
	schemaVersion: 1;
	updatedAt: string;
	runs: Array<{
		runId: string;
		name?: string;
		type: WorkflowRunType;
		artifactGraph?: { enabled: true };
		status: WorkflowRunStatus;
		degradation?: WorkflowRunDegradation;
		taskSummary: TaskSummary;
		createdAt: string;
		updatedAt: string;
		runJson: string;
		parentRunId?: string;
		rootRunId?: string;
		round?: number;
		fanout?: unknown[];
		/**
		 * Deprecated compatibility projection. New index writes omit task rows;
		 * consumers that need task-level details should load runJson/run.json.
		 */
		tasks?: Array<{
			taskId: string;
			displayName: string;
			agent: string;
			status: TaskRunStatus;
			statusDetail: string;
			lastMessage?: string;
			kind?: string;
			stageId?: string;
			backendHandle?: WorkflowBackendHandle;
		}>;
	}>;
}

export interface WorktreeSnapshotRecord {
	files?: string[];
	hash?: string;
	[key: string]: unknown;
}

export interface CompiledWorkflow {
	schemaVersion: 1;
	name?: string;
	description?: string;
	type: WorkflowRunType;
	task?: string;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	maxConcurrency: number;
	failurePolicy?: Required<WorkflowFailurePolicy>;
	roles: CompiledRole[];
	tasks: CompiledTask[];
	stages?: Array<Record<string, unknown> | CompiledLoopStageRecord>;
	warnings: string[];
	artifactGraph?: { enabled: true };
	/** Compiled with the host's `inheritHostTools` option (Pi only, WP6). */
	inheritHostTools?: true;
	/** D2/R#5: compiled with the executing user's `allowSharedCheckoutWrites`. */
	allowSharedCheckoutWrites?: true;
	/** WP4e: permission mode the workflow was compiled under (R#5 applies only in `safe`). */
	permissionMode?: "free" | "safe";
}
