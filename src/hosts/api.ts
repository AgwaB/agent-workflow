// Host-neutral API: CLI, MCP, and Pi adapters call one typed handler per action.
// No Pi imports; contracts are in docs/extending.md#host-api.
import { showWorkflowSpecAction } from "./catalog.js";
import { showRunAction } from "./runs.js";
import type { HostApiContext, HostResult } from "./types.js";

export {
	HostUsageError,
	isEffortLevel,
	type ParsedSuperviseArgs,
	type ParsedWorkflowDynamicArgs,
	type ParsedWorkflowPruneArgs,
	type ParsedWorkflowRunArgs,
	parseCapabilityList,
	parseDuration,
	parsePermissionMode,
	parseSuperviseArgs,
	parseEffortLevel,
	parseWorkflowAutoArgs,
	parseWorkflowDynamicArgs,
	parseWorkflowPruneArgs,
	parseWorkflowRunArgs,
	tokenizeWorkflowArgs,
	type WorkflowArgToken,
} from "./args.js";
export {
	type AutoCandidateView,
	type AutoClassifierTarget,
	type AutoData,
	type AutoPhase,
	type AutoRequest,
	autoAction,
	resolveAutoClassifier,
} from "./auto.js";
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
	applyDoctorFix,
	type DoctorData,
	type DoctorExecutorReport,
	type DoctorFix,
	type DoctorRequest,
	doctorAction,
	doctorFixes,
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
	checkWorkflowAction,
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
	isExecutorProfileName,
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
	request: {
		ref: string;
		raw?: boolean;
		includeTaskLogs?: boolean;
		includeReport?: boolean;
		snapshot?: boolean;
		includeTask?: boolean;
	},
): Promise<
	HostResult<
		| Awaited<ReturnType<typeof showRunAction>>["data"]
		| Awaited<ReturnType<typeof showWorkflowSpecAction>>["data"]
	>
> {
	if (request.raw || request.ref.startsWith("workflow_"))
		return showRunAction(ctx, {
			runId: request.ref,
			...(request.snapshot ? { snapshot: true } : {}),
			...(request.includeTaskLogs ? { includeTaskLogs: true } : {}),
			...(request.includeReport ? { includeReport: true } : {}),
			...(request.includeTask ? { includeTask: true } : {}),
			...(request.raw ? { raw: true } : {}),
		});
	return showWorkflowSpecAction(ctx, { workflow: request.ref });
}
