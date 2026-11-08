// Executor-specific rules the engine applies before launch. The engine asks what an executor supports
// (host-tool inheritance, its model naming, a fast tier, per-task descriptor config, doctor fixes)
// instead of testing executor ids; each built-in adapter keeps its rules in a small policy module
// that never loads the adapter itself (adapters load only in durable workers).
import { CLAUDE_EXECUTOR_POLICY } from "../executors/claude/policy.js";
import { CLAUDE_EXECUTOR_ID } from "../executors/claude/version.js";
import { CODEX_EXECUTOR_POLICY } from "../executors/codex/policy.js";
import { CODEX_EXECUTOR_ID } from "../executors/codex/version.js";
import { PI_EXECUTOR_POLICY } from "../executors/pi/policy.js";
import { PI_EXECUTOR_ID } from "../executors/pi/version.js";
import type { ExecutorDescriptor } from "../sdk/descriptor.js";
import type { NegotiationReport } from "../sdk/requirements.js";
import type { ExecutorNameResolution } from "./executor-model-id.js";
import { type ExecutorPresetId, executorPreset } from "./executor-presets.js";
import { modelListed } from "./role-profiles.js";
import type { PreparedWorkflowTaskLaunch } from "./task-launch.js";
import {
	type CompiledTask,
	EFFORT_LEVELS,
	type EffortLevel,
	type FastMode,
	type WorkflowRoleMap,
} from "./types.js";
import type { WorkflowModelInfo } from "./workflow-runtime.js";

export interface ExecutorDoctorFix {
	readonly tool: string;
	/** What would change, for the question to the user. */
	readonly description: string;
}

export type ExecutorDoctorFixResult =
	| { readonly changed: true; readonly path: string; readonly setting: string }
	| { readonly changed: false; readonly path: string; readonly reason: string };

/** The model/effort a CLI uses when a request names none, as the user configured it. */
export interface ExecutorUserDefaults {
	readonly model?: string;
	readonly effort?: string;
	/** Where they were read (shown in the launch notice). */
	readonly source: string;
}

export interface ExecutorPolicy {
	/**
	 * Built-in default profile (a preset): the lowest model/effort layer for this executor's stages,
	 * below every authored and chosen setting. Absent: the CLI's own defaults (Pi: its current model).
	 */
	readonly defaultPreset?: ExecutorPresetId;
	/** The user's own CLI defaults: every stage uses them when the preset's model is not offered. */
	userDefaults?(env: NodeJS.ProcessEnv): ExecutorUserDefaults | undefined;
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
		launch: Pick<
			PreparedWorkflowTaskLaunch,
			"hostContext" | "toolResultBudget"
		>,
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
	[CODEX_EXECUTOR_ID]: CODEX_EXECUTOR_POLICY,
	[CLAUDE_EXECUTOR_ID]: CLAUDE_EXECUTOR_POLICY,
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

export interface ExecutorDefaultProfile {
	/** Role → model/effort, applied only where nothing authored or chosen sets them. */
	roles: WorkflowRoleMap;
	/** Launch notice when the user's own CLI settings replaced the preset. */
	notice?: string;
}

/** The fields of a saved user profile an executor default profile reads. */
export interface ExecutorProfileValues {
	executor?: string;
	model?: string;
	effort?: EffortLevel;
	roles?: WorkflowRoleMap;
}

function isEffortLevel(value: string | undefined): value is EffortLevel {
	return (
		value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value)
	);
}

function modelEffort(entry: { model?: string; effort?: EffortLevel }): {
	model?: string;
	effort?: EffortLevel;
} {
	return {
		...(entry.model === undefined ? {} : { model: entry.model }),
		...(entry.effort === undefined ? {} : { effort: entry.effort }),
	};
}

/**
 * A saved profile named after `executorId` (the user's changes) on top of `base` (the built-in
 * default profile, role → model/effort): its flat model/effort replace the base ones in every role,
 * its role entries win field by field. Entries for another executor are skipped (a model belongs to
 * its executor); so are the flat values when the profile's executor is another one.
 */
export function overlayExecutorProfile(
	executorId: string,
	base: WorkflowRoleMap,
	saved: ExecutorProfileValues,
): WorkflowRoleMap {
	const flatExecutor = saved.executor ?? executorId;
	const flat = flatExecutor === executorId ? modelEffort(saved) : {};
	const roles: WorkflowRoleMap = {};
	for (const [role, entry] of Object.entries(base))
		roles[role] = { ...modelEffort(entry), ...flat };
	if (roles.default === undefined && Object.keys(flat).length > 0)
		roles.default = { ...flat };
	for (const [role, entry] of Object.entries(saved.roles ?? {})) {
		if ((entry.executor ?? flatExecutor) !== executorId) continue;
		roles[role] = { ...(roles[role] ?? {}), ...modelEffort(entry) };
	}
	for (const [role, entry] of Object.entries(roles))
		if (Object.keys(entry).length === 0) delete roles[role];
	return roles;
}

/**
 * The default profile of an executor for this machine. Built in (codex, claude): the preset when
 * its model is offered (or the probe lists no models), else the user's own CLI model/effort for every
 * stage (none configured: the CLI's own defaults). A saved profile named after the executor (`saved`)
 * applies on top (overlayExecutorProfile); pi has only that. `listedModels` is the probe list.
 */
export function resolveExecutorDefaultProfile(
	executorId: string,
	listedModels: readonly string[] | null,
	env: NodeJS.ProcessEnv = process.env,
	saved?: ExecutorProfileValues,
): ExecutorDefaultProfile | undefined {
	const builtIn = builtInExecutorDefaultProfile(executorId, listedModels, env);
	if (saved === undefined) return builtIn;
	const roles = overlayExecutorProfile(executorId, builtIn?.roles ?? {}, saved);
	if (Object.keys(roles).length === 0 && builtIn?.notice === undefined)
		return undefined;
	return {
		roles,
		...(builtIn?.notice === undefined ? {} : { notice: builtIn.notice }),
	};
}

function builtInExecutorDefaultProfile(
	executorId: string,
	listedModels: readonly string[] | null,
	env: NodeJS.ProcessEnv,
): ExecutorDefaultProfile | undefined {
	const policy = executorPolicy(executorId);
	if (policy.defaultPreset === undefined) return undefined;
	const roles: WorkflowRoleMap = {};
	for (const [role, assignment] of Object.entries(
		executorPreset(policy.defaultPreset).roles,
	))
		roles[role] = modelEffort(assignment);
	const model = roles.default?.model;
	if (
		model === undefined ||
		listedModels === null ||
		modelListed(model, listedModels)
	)
		return { roles };
	const user = policy.userDefaults?.(env);
	const effort = isEffortLevel(user?.effort) ? user.effort : undefined;
	const unified = {
		...(user?.model === undefined ? {} : { model: user.model }),
		...(effort === undefined ? {} : { effort }),
	};
	const described = [unified.model, unified.effort].filter(Boolean).join(", ");
	return {
		roles: Object.keys(unified).length === 0 ? {} : { default: unified },
		notice:
			described === ""
				? `${executorId} default profile: model "${model}" is not offered here and no ${executorId} model/effort is configured; stages without one use ${executorId}'s own defaults`
				: `${executorId} default profile: model "${model}" is not offered here; stages without a model/effort use your ${executorId} settings (${described}) from ${user!.source}`,
	};
}

/**
 * Model/effort of a stage from an executor default profile, field by field: the most specific
 * entry that sets a field wins it (agent > profileRole > default).
 */
export function executorDefaultRuntime(
	roles: WorkflowRoleMap | undefined,
	slot: { agent?: string; profileRole?: string },
): { model?: string; effort?: EffortLevel } | undefined {
	if (roles === undefined) return undefined;
	const entries = [
		...(slot.agent ? [`agent:${slot.agent}`] : []),
		...(slot.profileRole ? [slot.profileRole] : []),
		"default",
	].flatMap((key) => (roles[key] ? [roles[key]!] : []));
	const model = entries.find((entry) => entry.model !== undefined)?.model;
	const effort = entries.find((entry) => entry.effort !== undefined)?.effort;
	if (model === undefined && effort === undefined) return undefined;
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
	};
}
