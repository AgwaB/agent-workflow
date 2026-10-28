// New in agent-workflow (WP11a): the host API layer (`@agwab/agent-workflow/hosts/api`). One typed,
// host-neutral handler per action; the `agent-workflow` CLI, the stage-2 host MCP server and the Pi
// host (WP11b) all call these instead of re-implementing command logic. No Pi imports. Contracts:
// docs/host-api.md. Logic ported from pi-workflow 0.16.4 (b83cc4f) src/extension.ts and src/cli.mjs
// (see each module's header). WP17: `doctor` (doctor.ts) and the optional HostApiContext.host.
// WP16: the duplicate-launch guard covers detached launches (launch-guard.ts, outcome `existing`)
// and the `logs` action (logs.ts). WP31: `workflowPreferenceAction` (saved per-workflow preferences).
// and the `logs` action (logs.ts). WP29: the `approve` action (approve.ts) answers a dynamic-controller
// approval a run is blocked on. WP34: `executorModelsAction` (each executor's probed model list, for
// role-profile editors such as the Pi profile picker).
import { showWorkflowSpecAction } from "./catalog.js";
import { showRunAction } from "./runs.js";
import type { HostApiContext, HostResult } from "./types.js";

export {
	type ApproveData,
	type ApproveRequest,
	approveAction,
	DYNAMIC_REJECT_TITLE,
} from "./approve.js";
export {
	DYNAMIC_APPROVAL_TITLE,
	type PendingDynamicApproval,
} from "../core/dynamic-approval.js";
export {
	HostUsageError,
	isThinkingLevel,
	type ParsedSuperviseArgs,
	type ParsedWorkflowDynamicArgs,
	type ParsedWorkflowPruneArgs,
	type ParsedWorkflowRunArgs,
	parseCapabilityList,
	parseDuration,
	parsePermissionMode,
	parseSuperviseArgs,
	parseThinkingLevel,
	parseWorkflowDynamicArgs,
	parseWorkflowPruneArgs,
	parseWorkflowRunArgs,
	tokenizeWorkflowArgs,
	type WorkflowArgToken,
} from "./args.js";
export {
	type AgentSummary,
	type ListData,
	type ListRequest,
	listAgentsAction,
	listWorkflowsAction,
	type ProfileData,
	type ProfileRequest,
	profileAction,
	type RolesData,
	showWorkflowSpecAction,
	type ValidateData,
	validateWorkflowAction,
	type WorkflowListSummary,
	type WorkflowPreferenceData,
	type WorkflowPreferenceRequest,
	workflowPreferenceAction,
	workflowRolesAction,
} from "./catalog.js";
export {
	type DoctorData,
	type DoctorExecutorReport,
	type DoctorRequest,
	doctorAction,
} from "./doctor.js";
export {
	type ExecutorModelList,
	type ExecutorModelsData,
	type ExecutorModelsRequest,
	executorModelsAction,
	modelListNote,
} from "./executor-models.js";
export { COMMAND_HELP, GENERAL_HELP, helpAction } from "./help.js";
export {
	agentWorkflowCliPath,
	type LaunchData,
	type LaunchProfileInfo,
	type LaunchRequestBase,
	type RunDynamicRequest,
	type RunWorkflowRequest,
	resolveWorkflowExecutionProfileForLaunch,
	runDynamicAction,
	runWorkflowAction,
	selectWorkflowExecutionProfile,
	spawnDetachedSupervisor,
	type WorkflowProfileSelector,
} from "./launch.js";
export {
	LOG_STREAMS,
	type LogStream,
	type LogStreamKind,
	type LogsData,
	type LogsRequest,
	type LogsTask,
	LOGS_DEFAULT_LINES,
	LOGS_MAX_LINES,
	LOGS_MAX_TASKS,
	logsAction,
} from "./logs.js";
export {
	formatWorkflowResultPresentation,
	readWorkflowResultPresentation,
	type WorkflowResultArtifact,
	type WorkflowResultPresentation,
} from "./result-presentation.js";
export {
	boundedWaitTimeout,
	type InspectData,
	inspectAction,
	noticesAction,
	pruneAction,
	type RedriveData,
	redriveRunsAction,
	type ResumeData,
	type RunSummary,
	resumeAction,
	type StatusData,
	type StopData,
	HOST_STOP_CONFIRM_TIMEOUT_MS,
	type SuperviseData,
	type SuperviseDetachedData,
	type SuperviseRequest,
	superviseDetachedAction,
	showRunAction,
	statusAction,
	stopAction,
	summarizeRun,
	superviseAction,
	type WaitData,
	type WaitRequest,
	waitAction,
} from "./runs.js";
export {
	registerTestExecutorFromEnv,
	TEST_EXECUTOR_ACK_ENV,
	TEST_EXECUTOR_ACK_VALUE,
	TEST_EXECUTOR_MODULE_ENV,
	TestExecutorHookError,
} from "./test-executor.js";
export {
	formatHostError,
	HOST_API_VERSION,
	HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS,
	HOST_LONG_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MIN_TIMEOUT_MS,
	type HostAction,
	type HostApiContext,
	type HostOutcome,
	type HostResult,
	MODULE,
	outcomeForRunStatus,
} from "./types.js";
export {
	type UserProfile,
	type UserProfileValues,
	USER_PROFILE_FIELDS,
	userProfilesPath,
} from "./user-profiles.js";
export {
	type WorkflowPreference,
	workflowPreferencesPath,
} from "./workflow-preferences.js";

/** `show <ref> [raw]`: a run (`--raw`, or a `workflow_…` id) or else a workflow spec. */
export async function showAction(
	ctx: HostApiContext,
	request: { ref: string; raw?: boolean },
): Promise<
	HostResult<
		| Awaited<ReturnType<typeof showRunAction>>["data"]
		| Awaited<ReturnType<typeof showWorkflowSpecAction>>["data"]
	>
> {
	if (request.raw || request.ref.startsWith("workflow_"))
		return showRunAction(ctx, {
			runId: request.ref,
			...(request.raw ? { raw: true } : {}),
		});
	return showWorkflowSpecAction(ctx, { workflow: request.ref });
}
