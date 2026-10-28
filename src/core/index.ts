// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/index.ts. MIT, same author. Changes: core entry point (`MODULE` kept for the package skeleton test); WORKFLOW_COMMAND/WORKFLOW_HELP (Pi `/workflow` slash-command help text) moved out to the Pi host (WP11b); adds the executor registry, task-backend and runtime test seam exports (WP4c).
export const MODULE = "src/core";
export {
	discoverAgents,
	loadAgentByName,
	parseAgentMarkdown,
} from "./agents.js";
export {
	formatLogs,
	formatRunDetails,
	formatRunStatus,
	formatStatus,
	refreshRun,
	resumeRun,
	resumeSupervisors,
	runDynamicTask,
	stopRun,
	runWorkflow,
	runWorkflowSpec,
	waitForRun,
} from "./engine.js";
export type { ResumeRunSummary, StopRunSummary } from "./engine.js";
export {
	estimateWorkflowDurationMs,
	findDuplicateActiveRun,
	formatApproxDuration,
} from "./run-estimates.js";
export type {
	DuplicateActiveRunMatch,
	DuplicateRunTarget,
	WorkflowDurationEstimate,
} from "./run-estimates.js";
export {
	listWorkflows,
	listWorkflowRoutingSpecs,
	resolveWorkflowRef,
	WORKFLOW_ROUTING_CATALOG_BOUNDS,
} from "./workflow-specs.js";
export type {
	ResolvedWorkflowSpecRef,
	WorkflowRoutingCatalog,
	WorkflowRoutingScope,
	WorkflowRoutingSpecRecord,
	WorkflowSpecRecord,
} from "./workflow-specs.js";
export {
	formatWorkflowAutoRecommendation,
	parseWorkflowAutoComparisonOutput,
	recommendWorkflowAuto,
	workflowAutoDirectDraft,
	WORKFLOW_AUTO_COMPARE_CORRELATION_ID,
	WORKFLOW_AUTO_COMPARE_TIMEOUT_MS,
	WORKFLOW_AUTO_MAX_CANDIDATE_CARDS,
	WORKFLOW_AUTO_MAX_MODEL_INPUT_BYTES,
	WORKFLOW_AUTO_MAX_TASK_BYTES,
} from "./workflow-router.js";
export type {
	WorkflowAutoAssessment,
	WorkflowAutoCandidate,
	WorkflowAutoCandidateFacts,
	WorkflowAutoCandidateKind,
	WorkflowAutoComparison,
	WorkflowAutoComparisonStatus,
	WorkflowAutoReadiness,
	WorkflowAutoRecommendation,
	WorkflowAutoRequest,
	WorkflowAutoResult,
} from "./workflow-router.js";
export { compileRole, extractMarkdownSections } from "./roles.js";
export { loadWorkflow, loadWorkflowSpec, parseWorkflow } from "./schema.js";
export { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
export type {
	AgentDefinition,
	ApprovalMode,
	BackendOptions,
	CompiledWorkflow,
	CompiledRole,
	CompiledTask,
	ExecutionProfileForeachBatch,
	ExecutionProfileStageOverride,
	FastMode,
	WorkflowDefaults,
	WorkflowRoutingHints,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutionProfileSelection,
	WorkflowProfileRole,
	WorkflowRunExecutionProfile,
	WorkflowRunAutoSelectionMetadata,
	WorkflowRunLaunchCapture,
	WorkflowRunLaunchCaptureV1,
	WorkflowRunLaunchCaptureV2,
	WorkflowRunLaunchCommandMetadata,
	WorkflowRunLaunchMetadata,
	WorkflowRunLaunchMetadataV1,
	WorkflowRunLaunchMetadataV2,
	WorkflowRunLaunchProfile,
	WorkflowRunLaunchSource,
	WorkflowAutoRoute,
	WorkflowRunProvenance,
	ArtifactGraphWorkflowSpec,
	ArtifactGraphStageSpec,
	ArtifactGraphStageType,
	WorkflowArtifactKind,
	RoleSpec,
	TaskCapability,
	ThinkingLevel,
	WorktreePolicy,
} from "./types.js";
export { WORKFLOW_PROFILE_ROLES, WorkflowValidationError } from "./types.js";
export { runDynamicDecisionLoop } from "./dynamic-decision-loop.js";
export type {
	DynamicDecisionLoopControllerContext,
	DynamicDecisionLoopResult,
	DynamicDecisionLoopRunResult,
	RunDynamicDecisionLoopOptions,
} from "./dynamic-decision-loop.js";
export {
	assertValidDynamicDecision,
	validateDynamicDecision,
} from "./dynamic-decision.js";
export type {
	DynamicDecisionAction,
	DynamicDecisionPhase,
	DynamicDecisionStatus,
	DynamicDecisionValidationContext,
	DynamicDecisionValidationResult,
	NormalizedDynamicDecision,
} from "./dynamic-decision.js";
export { dynamicOutputProfileValues } from "./dynamic-profiles.js";
export type { DynamicOutputProfile } from "./dynamic-profiles.js";
export {
	buildDynamicToolResultBudgetMetrics,
	DYNAMIC_TOOL_RESULT_BUDGET_METRICS_SCHEMA_VERSION,
} from "./dynamic-tool-result-budget-metrics.js";
export type {
	DynamicToolResultBudgetControllerMetrics,
	DynamicToolResultBudgetMetricsSchemaVersion,
	DynamicToolResultBudgetRollup,
	DynamicToolResultBudgetRunMetrics,
	DynamicToolResultBudgetStatusCounts,
	DynamicToolResultBudgetTaskMetrics,
} from "./dynamic-tool-result-budget-metrics.js";
export {
	buildWorkflowRunMetrics,
	WORKFLOW_METRICS_PRICING_MODEL_VERSION,
	WORKFLOW_METRICS_SCHEMA_VERSION,
} from "./workflow-metrics.js";
export {
	VERIFICATION_STATUS,
	VERIFICATION_STATUS_BUCKETS,
	VERIFICATION_STATUS_LABELS,
	VERIFICATION_STATUS_VALUES,
	canonicalVerificationStatus,
	isNonVerifiedTerminalStatus,
	isVerificationBlockedStatus,
	isVerifiedStatus,
	verificationStatusBucket,
} from "./verification-ontology.js";
export type {
	TerminalVerificationStatus,
	VerificationStatus,
} from "./verification-ontology.js";
export type {
	WorkflowLaunchTimingMetrics,
	WorkflowMetricValue,
	WorkflowMetricsPricingModelVersion,
	WorkflowMetricsPricingSource,
	WorkflowMetricsSchemaVersion,
	WorkflowRetryMetrics,
	WorkflowRunMetrics,
	WorkflowRunMetricsMetadata,
	WorkflowRunMetricsRollup,
	WorkflowStageMetrics,
	WorkflowTaskMetrics,
	WorkflowTaskStatusCounts,
	WorkflowUsageMetrics,
} from "./workflow-metrics.js";
export {
	BUILTIN_EXECUTOR_IDS,
	LEGACY_RECORD_EXECUTOR_ID,
	registerWorkflowExecutor,
	resolveRunExecutorSelection,
	workflowExecutorRegistration,
	WorkflowExecutorUnavailableError,
} from "./executor-registry.js";
export type {
	RunExecutorSelectionInput,
	WorkflowExecutorRegistration,
} from "./executor-registry.js";
export {
	cachedExecutorProber,
	DEFAULT_READINESS_PROBE_TIMEOUT_MS,
	EXECUTOR_PROBE_CACHE_TTL_MS,
	executorSetupHints,
	HOST_DEFAULT_EXECUTORS,
	INSTALLED_DEFAULT_ORDER,
	installText,
	isWorkflowHostId,
	noUsableExecutorMessage,
	probeExecutorReadiness,
	probeIsUsable,
	readinessFixHint,
	resetExecutorProbeCacheForTests,
	resolveHostDefaultExecutor,
	resolveRunExecutorForHost,
	WORKFLOW_HOST_IDS,
} from "./executor-default.js";
export type {
	ExecutorReadiness,
	ExecutorReadinessProber,
	ExecutorReadinessState,
	ExecutorSetupHints,
	HostDefaultExecutor,
	ResolveRunExecutorInput,
} from "./executor-default.js";
export {
	DEFAULT_EXECUTOR_PROBE_TIMEOUT_MS,
	negotiateWorkflowRun,
	probeWorkflowExecutor,
	WorkflowCapabilityError,
	workflowTaskCapabilityLaunch,
	workflowTaskRequirementContext,
} from "./capability-negotiation.js";
export type {
	WorkflowCapabilityErrorCode,
	WorkflowCapabilityPolicy,
	WorkflowExecutorProber,
} from "./capability-negotiation.js";
export {
	resolveRunPermissionMode,
	workflowDeclaredProfilePermissionMode,
	workflowRunPermissionMode,
} from "./permission-mode.js";
export type { RunPermissionModeInput } from "./permission-mode.js";
export type {
	WorkflowHostId,
	WorkflowRunExecutorCandidate,
	WorkflowRunExecutorSelection,
	WorkflowRunExecutorSource,
	WorkflowRunPermissionMode,
	WorkflowRunPermissionModeSource,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
export {
	ensureWorkflowTaskBackendRegistered,
	workflowExecutorAttemptKey,
	workflowTaskBackend,
} from "./task-backend.js";
export {
	registerWorkflowBackend,
	resolveWorkflowBackend,
} from "./task-launch.js";
export type {
	BackendLaunchResult,
	PreparedWorkflowTaskLaunch,
	WorkflowBackend,
} from "./task-launch.js";
export { setTaskRuntimeApiForTests } from "./runtime-port.js";
export {
	EXECUTOR_NEEDS_DECISION_FAILURE_KIND,
	EXECUTOR_NEEDS_DECISION_STATUS_DETAIL,
} from "./terminal-result.js";
export { setExecutorAuthKindProbe } from "./retry-policy.js";
export type {
	ExecutorAuthKind,
	ExecutorAuthKindProbe,
} from "./retry-policy.js";
export type {
	WorkflowRunOptions,
	WorkflowSavedUserProfileLayer,
} from "./engine.js";
