// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/extension.ts (startWorkflowRunFromRequest,
// startDynamicRunFromRequest, selectWorkflowExecutionProfile, resolveWorkflowExecutionProfileForLaunch,
// duplicateRunGuardNotice, spawnDetachedSupervisor). MIT, same author. Changes (WP11a): host-neutral
// `run`/`dynamic` handlers with no Pi context: the run options executor, profile, permissionMode,
// allowUnverifiedCapabilities, interactive + confirmDegradations (WP4d), model/effort; saved user
// profiles (user-profiles.ts) as the B2 "saved user profile" tier; capability refusals and the
// duplicate guard return `refused` results instead of throwing; WP33: every launch records the
// host-neutral launch capture (launch-capture.ts, schema agent-workflow-run-launch-v1); the detached supervisor is the
// `agent-workflow supervise` CLI and logs to `<run dir>/supervise.log`.
// WP17: HostApiContext.host reaches the engine (host-default executor) and launch data shows it.
// WP35: HostApiContext.hostTools (Pi host) → run option inheritHostTools + the run's host context.
// WP31: built-in presets as `--profile <id>`; the saved per-workflow preference (workflow-
// preferences.ts) applies to every host's launch (its profile when none is named, its role overrides
// as the engine's workflowPreference layer); launch data/text show the per-stage role assignment.
import {
	dashboardStartBudgetMs,
	ensureDashboard,
	readDashboardDiscovery,
} from "./dashboard/discovery.js";
import { getWorkflowProcessRole } from "../core/process-role.js";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowCapabilityError } from "../core/capability-negotiation.js";
import { hostLaunchCapture, type LaunchOrigin } from "./launch-capture.js";
import { ensureDirectDynamicRuntimeBundle } from "../core/dynamic-runtime-bundle.js";
import {
	formatHumanRunLaunch,
	runDynamicTask,
	runWorkflowSpec,
	WORKFLOW_EXPECTED_DEFINITION_FINGERPRINT,
	WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK,
	WorkflowDefinitionChangedError,
	WorkflowPreflightPassed,
	type WorkflowRunOptions,
	type WorkflowSavedUserProfileLayer,
} from "../core/engine.js";
import { workflowDefinitionFingerprint } from "../core/execution-profile.js";
import { createHostContext, withHostContext } from "../core/host-context.js";
import {
	HOST_DEFAULT_EXECUTORS,
	INSTALLED_DEFAULT_ORDER,
	unverifiedDefaultGuidance,
} from "../core/executor-default.js";
import { WorkflowExecutorUnavailableError } from "../core/executor-registry.js";
import {
	EXECUTOR_PRESET_IDS,
	executorPreset,
	isExecutorPresetId,
} from "../core/executor-presets.js";
import { formatApproxDuration } from "../core/run-estimates.js";
import { type LoadedWorkflowSpec, loadWorkflowSpec } from "../core/schema.js";
import { workflowRunDir } from "../core/store.js";
import type {
	ThinkingLevel,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutionProfileSelection,
	WorkflowRunHostAutoSelectionMetadata,
	WorkflowRunCapabilityNegotiation,
	WorkflowRunRecord,
} from "../core/types.js";
import type { WorkflowRuntimeDefaults } from "../core/workflow-runtime.js";
import type { CapabilityPreview } from "../sdk/requirements.js";
import { hostCommandHints, type WorkflowCommandHints } from "./hints.js";
import {
	HostUsageError,
	isThinkingLevel,
	parseCapabilityList,
} from "./args.js";
import {
	assertActionAllowed,
	type HostAction,
	type HostApiContext,
	type HostResult,
	hostEnv,
	outcomeForRunStatus,
	result,
	toDisplayPath,
} from "./types.js";
import {
	claimLaunch,
	launchFingerprint,
	recordForcedLaunch,
} from "./launch-guard.js";
import {
	readUserProfiles,
	type UserProfile,
	userProfileFromFile,
} from "./user-profiles.js";
import {
	readWorkflowPreferences,
	type WorkflowPreference,
	workflowPreferenceFrom,
} from "./workflow-preferences.js";

export type WorkflowProfileSelector = (
	title: string,
	options: string[],
	/** WP16: the option a headless launch picks (the declared default, else the base spec). */
	meta?: { headlessOption: string },
) => Promise<string | undefined>;

export interface LaunchRequestBase {
	/** Full runtime task text. */
	task: string;
	/** Run flag: executor id (B2 highest precedence). */
	executor?: string;
	/** Workflow-declared execution profile name, else a saved user profile name. */
	profile?: string;
	/** Run flag (WP4e): "free" | "safe". */
	permissionMode?: "free" | "safe";
	/** B4 opt-in: treat these unverified capabilities as available. */
	allowUnverifiedCapabilities?: string[];
	/** Run override of the model of every stage. */
	model?: string;
	/** Run override of the effort (thinking level) of every stage. */
	effort?: ThinkingLevel;
	/** Spawn a standalone supervisor so the run progresses after this process exits. */
	detach?: boolean;
	/** Skip the duplicate-launch guard. */
	forceNew?: boolean;
	/** `check`: run the preflight only (no run, no guard claim, no model call). */
	preflightOnly?: boolean;
	/** B4 (WP4d): the host can ask the user; degradations then need confirmDegradations. */
	interactive?: boolean;
	confirmDegradations?: (preview: CapabilityPreview) => Promise<boolean>;
	/** Interactive chooser between declared profiles when none is named (Pi host). */
	selectProfile?: WorkflowProfileSelector;
	/** Overrides for inputs the spec declares (for example depth). */
	inputOverrides?: Record<string, unknown>;
	/** WP33: how the host was asked (launch capture); absent → synthesized from the request. */
	launchOrigin?: LaunchOrigin;
	/**
	 * WP32: set by the `auto` action only: the selection facts of a confirmed auto launch (launch
	 * capture `agent-workflow-run-launch-v2`).
	 */
	autoSelection?: WorkflowRunHostAutoSelectionMetadata;
	/**
	 * WP42 (review round 1, finding 1): foreground cancellation of this launch (the `auto` action
	 * passes its session signal). Re-checked after every dialog of the launch path (profile chooser,
	 * capability confirm) and carried into the engine's `launchSignal` fence: aborted before
	 * publication = nothing published and nothing submitted; after publication = that run is stopped.
	 */
	signal?: AbortSignal;
}

export interface RunWorkflowRequest extends LaunchRequestBase {
	/** Workflow name, alias, or spec path. */
	workflow: string;
}

export type RunDynamicRequest = LaunchRequestBase;

export interface LaunchProfileInfo {
	name: string;
	/** WP31: `preset` = a built-in executor preset (executor-presets.ts). */
	kind: "declared" | "user" | "preset";
	/** `request`: named by the caller; the others were picked because none was named. */
	source:
		| "request"
		| "workflow-default"
		| "user-default"
		| "workflow-preference";
}

export interface LaunchData {
	/** WP43d: `auth` is set only when that dashboard requires sign-in (`--auth`). */
	dashboard?: { url: string; port: number; started?: true; auth?: true };
	mode: "named-workflow" | "direct-dynamic";
	runId?: string;
	status?: WorkflowRunRecord["status"];
	name?: string;
	specPath?: string;
	/** WP17: `host` is set when the host's default rule chose the executor. */
	executor?: { id: string; source: string; profile?: string; host?: string };
	/**
	 * WP31: per-stage executor/model/effort of a run with a role profile (`mixed`: more than one
	 * executor runs stages).
	 */
	roles?: {
		mixed: boolean;
		executors: string[];
		stages: Array<{
			stage: string;
			executor: string;
			source: string;
			role?: string;
			model?: string;
			effort?: string;
		}>;
		warnings?: string[];
	};
	permissionMode?: { mode: string; source: string; profile?: string };
	profile?: LaunchProfileInfo;
	capability?: {
		preview: string;
		confirmation: string;
		degradations: string[];
		forcedReadOnly: string[];
		/** WP12a: one-line notices (legacy agents shadowing bundled agents). */
		notices?: string[];
	};
	taskSummary?: WorkflowRunRecord["taskSummary"];
	detached?: { pid?: number; logPath: string };
	promptSchemaNotice?: string;
	/** Duplicate-launch guard: the active run with the same workflow and task. */
	duplicateOf?: string;
	/** Not started: capability refusal, unavailable executor or declined confirmation. */
	refusal?: { code: string; executorId?: string; preview?: string };
}

/**
 * Resolve an explicit or omitted declared execution profile for one named workflow. Headless
 * callers use the declared default only; interactive callers choose deterministically and can
 * select the base spec; cancellation stops launch.
 */
export async function selectWorkflowExecutionProfile(
	workflow: string,
	cwd: string,
	explicitProfile: string | undefined,
	select?: WorkflowProfileSelector,
	loadedWorkflow?: LoadedWorkflowSpec,
): Promise<string | undefined> {
	if (explicitProfile) return explicitProfile;
	const loaded = loadedWorkflow ?? (await loadWorkflowSpec(workflow, cwd));
	const profiles = loaded.spec.executionProfiles;
	if (!profiles || Object.keys(profiles).length === 0) return undefined;
	const names = Object.keys(profiles).sort((left, right) =>
		left.localeCompare(right),
	);
	const defaultProfile = loaded.spec.defaultExecutionProfile;
	if (!select) return defaultProfile;

	const ordered = defaultProfile
		? [defaultProfile, ...names.filter((name) => name !== defaultProfile)]
		: names;
	const labels = ordered.map((name) => `Profile: ${name}`);
	const options = [...labels, "Base (no profile)"];
	const selected = await select(
		`Choose execution profile for ${loaded.spec.name ?? workflow}`,
		options,
		{ headlessOption: defaultProfile ? labels[0]! : "Base (no profile)" },
	);
	if (selected === undefined)
		throw new Error("Workflow run cancelled before profile selection.");
	if (selected === "Base (no profile)") return undefined;
	const selectedIndex = labels.indexOf(selected);
	if (selectedIndex < 0)
		throw new Error(`Unknown profile selection: ${selected}`);
	return ordered[selectedIndex];
}

/**
 * pi-workflow launch precedence for hosts with a model registry: explicit declared profile >
 * saved per-workflow Pi preference > the declared selector above.
 */
export async function resolveWorkflowExecutionProfileForLaunch(
	workflow: string,
	cwd: string,
	explicitProfile: string | undefined,
	options: {
		select?: WorkflowProfileSelector;
		loadedWorkflow?: LoadedWorkflowSpec;
	} = {},
): Promise<WorkflowExecutionProfileSelection> {
	if (explicitProfile) return { executionProfile: explicitProfile };
	const loaded =
		options.loadedWorkflow ?? (await loadWorkflowSpec(workflow, cwd));
	const executionProfile = await selectWorkflowExecutionProfile(
		workflow,
		cwd,
		undefined,
		options.select,
		loaded,
	);
	return executionProfile ? { executionProfile } : {};
}

interface LaunchProfile {
	selection: WorkflowExecutionProfileSelection;
	runtimeDefaults?: WorkflowRuntimeDefaults;
	/** Saved user profile on a spec without an artifact graph: applied as run options. */
	fallback?: { executor?: string; permissionMode?: "free" | "safe" };
	/**
	 * WP37 (B2 field by field): the default saved user profile under a selected declared profile;
	 * the engine takes each field the declared profile leaves unset from it.
	 */
	savedUserProfile?: UserProfile;
	info?: LaunchProfileInfo;
}

/** WP37: the default saved user profile, or none when there is none or the file is unreadable. */
async function defaultUserProfileQuietly(
	env: NodeJS.ProcessEnv,
): Promise<UserProfile | undefined> {
	try {
		const file = await readUserProfiles(env);
		return file.default ? userProfileFromFile(file, file.default) : undefined;
	} catch {
		// Declared profiles never needed the saved profiles; an unreadable file does not block them.
		return undefined;
	}
}

/** WP37: the engine's saved-profile layer under a declared profile. */
function savedUserProfileLayer(
	profile: UserProfile,
): WorkflowSavedUserProfileLayer {
	return {
		name: profile.name,
		...(profile.executor ? { executor: profile.executor } : {}),
		...(profile.permissionMode
			? { permissionMode: profile.permissionMode }
			: {}),
		...(profile.strictCapabilities
			? { strictCapabilities: [...profile.strictCapabilities] }
			: {}),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.effort ? { effort: profile.effort } : {}),
		...(profile.roles ? { roles: profile.roles } : {}),
	};
}

function applyUserProfile(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	profile: UserProfile,
	source: LaunchProfileInfo["source"],
): LaunchProfile {
	const runtimeDefaults: WorkflowRuntimeDefaults = {
		...(ctx.runtimeDefaults ?? {}),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.effort ? { thinking: profile.effort } : {}),
	};
	const info: LaunchProfileInfo = { name: profile.name, kind: "user", source };
	const isGraph = Array.isArray(
		(loaded.spec as { artifactGraph?: { stages?: unknown } }).artifactGraph
			?.stages,
	);
	if (!isGraph) {
		if (profile.strictCapabilities?.length)
			throw new Error(
				`saved user profile "${profile.name}" sets strictCapabilities, which needs an artifact-graph workflow; the run was not started`,
			);
		return {
			selection: {},
			runtimeDefaults,
			fallback: {
				...(profile.executor ? { executor: profile.executor } : {}),
				...(profile.permissionMode
					? { permissionMode: profile.permissionMode }
					: {}),
			},
			info,
		};
	}
	const override: WorkflowCapturedExecutionProfile = {
		name: profile.name,
		definitionFingerprint: workflowDefinitionFingerprint(loaded.spec),
		stageOverrides: {},
		...(profile.executor ? { executor: profile.executor } : {}),
		...(profile.permissionMode
			? { permissionMode: profile.permissionMode }
			: {}),
		...(profile.strictCapabilities
			? { strictCapabilities: [...profile.strictCapabilities] }
			: {}),
		...(profile.roles ? { roles: profile.roles } : {}),
	};
	return {
		selection: { executionProfileOverride: override },
		runtimeDefaults,
		info,
	};
}

/** WP31: a built-in preset launched like a saved user profile of the same name. */
function presetLaunchProfile(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	id: string,
	source: LaunchProfileInfo["source"],
): LaunchProfile {
	const preset = executorPreset(id);
	const profile = applyUserProfile(
		ctx,
		loaded,
		{
			name: preset.id,
			executor: preset.executor,
			roles: preset.roles,
			updatedAt: "",
		},
		source,
	);
	return { ...profile, info: { name: preset.id, kind: "preset", source } };
}

/**
 * WP19 round 2 (N5): the launch profile, resolved once from one read of the settings (saved user
 * profiles and the saved per-workflow preference with its stage overrides). The duplicate guard
 * fingerprints this snapshot and the launch runs from it; nothing re-reads settings in between.
 * Only the interactive declared-profile chooser runs later (after the guard claimed the launch,
 * so a duplicate never prompts); it picks from the snapshot.
 */
interface LaunchProfileSnapshot {
	/** Final profile (no interactive choice needed). */
	resolved?: LaunchProfile;
	/** The workflow declares profiles: the declared selector decides after the guard. */
	declaredChoice?: { userDefault?: UserProfile; userProfilesError?: unknown };
	/** WP31: the saved per-workflow preference of this workflow (profile and role overrides). */
	preference?: WorkflowPreference;
}

/** WP31: the saved preference of the launched workflow (keyed by `spec.name`), if any. */
async function workflowPreferenceForLaunch(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
): Promise<WorkflowPreference | undefined> {
	const name = loaded.spec.name?.trim();
	if (!name) return undefined;
	return workflowPreferenceFrom(
		await readWorkflowPreferences(hostEnv(ctx)),
		name,
	);
}

/**
 * WP31: the launch profile with the saved per-workflow preference: its `profile` is used when the
 * request names none (source `workflow-preference`); its roles reach the engine as a role layer.
 */
async function snapshotLaunchProfile(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	request: LaunchRequestBase,
): Promise<LaunchProfileSnapshot> {
	const preference = await workflowPreferenceForLaunch(ctx, loaded);
	const named =
		request.profile !== undefined
			? { name: request.profile, source: "request" as const }
			: preference?.profile !== undefined
				? { name: preference.profile, source: "workflow-preference" as const }
				: undefined;
	const snapshot = await snapshotProfileSelection(ctx, loaded, named);
	return preference ? { ...snapshot, preference } : snapshot;
}

/**
 * Profile for one launch. Named: a declared spec profile wins over a saved user profile of the
 * same name. Not named: declared default (or the interactive declared chooser) > default saved user
 * profile > none.
 */
async function snapshotProfileSelection(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	named:
		| { name: string; source: "request" | "workflow-preference" }
		| undefined,
): Promise<LaunchProfileSnapshot> {
	const env = hostEnv(ctx);
	const declared = loaded.spec.executionProfiles ?? {};
	if (named !== undefined) {
		if (Object.hasOwn(declared, named.name)) {
			const savedUserProfile = await defaultUserProfileQuietly(env);
			return {
				resolved: {
					selection: { executionProfile: named.name },
					info: { name: named.name, kind: "declared", source: named.source },
					...(savedUserProfile ? { savedUserProfile } : {}),
				},
			};
		}
		const file = await readUserProfiles(env);
		const user = userProfileFromFile(file, named.name);
		if (user)
			return { resolved: applyUserProfile(ctx, loaded, user, named.source) };
		// WP31: a built-in executor preset when no declared or saved profile has the name.
		if (isExecutorPresetId(named.name))
			return {
				resolved: presetLaunchProfile(ctx, loaded, named.name, named.source),
			};
		const declaredNames = Object.keys(declared).sort();
		const userNames = Object.keys(file.profiles).sort();
		throw new HostUsageError(
			`unknown profile "${named.name}"${named.source === "workflow-preference" ? ` (from the saved preference of workflow ${loaded.spec.name}; change it with: agent-workflow profile workflow set ${loaded.spec.name} --profile <name>)` : ""}: the workflow declares ${declaredNames.length ? declaredNames.join(", ") : "no execution profiles"}; saved user profiles: ${userNames.length ? userNames.join(", ") : "none"}; built-in presets: ${EXECUTOR_PRESET_IDS.join(", ")}`,
		);
	}
	if (Object.keys(declared).length > 0) {
		// The saved user profiles only matter when the chooser picks no declared profile: an
		// unreadable file fails the launch only then (as before).
		try {
			const file = await readUserProfiles(env);
			const userDefault = file.default
				? userProfileFromFile(file, file.default)
				: undefined;
			return { declaredChoice: userDefault ? { userDefault } : {} };
		} catch (error) {
			return { declaredChoice: { userProfilesError: error } };
		}
	}
	const file = await readUserProfiles(env);
	const userDefault = file.default
		? userProfileFromFile(file, file.default)
		: undefined;
	if (userDefault)
		return {
			resolved: applyUserProfile(ctx, loaded, userDefault, "user-default"),
		};
	return { resolved: { selection: {} } };
}

/** The final launch profile from the snapshot (runs the declared chooser when needed). */
async function finishLaunchProfile(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	request: LaunchRequestBase,
	snapshot: LaunchProfileSnapshot,
): Promise<LaunchProfile> {
	if (snapshot.resolved) return snapshot.resolved;
	const executionProfile = await selectWorkflowExecutionProfile(
		loaded.specPath,
		ctx.cwd,
		undefined,
		request.selectProfile,
		loaded,
	);
	if (executionProfile) {
		const savedUserProfile = snapshot.declaredChoice?.userDefault;
		return {
			selection: { executionProfile },
			info: {
				name: executionProfile,
				kind: "declared",
				source: "workflow-default",
			},
			...(savedUserProfile ? { savedUserProfile } : {}),
		};
	}
	if (snapshot.declaredChoice?.userProfilesError !== undefined)
		throw snapshot.declaredChoice.userProfilesError;
	const userDefault = snapshot.declaredChoice?.userDefault;
	if (userDefault)
		return applyUserProfile(ctx, loaded, userDefault, "user-default");
	return { selection: {} };
}

/** What the snapshot means for the fingerprint (timestamps dropped). */
function snapshotIdentity(
	snapshot: LaunchProfileSnapshot,
): Record<string, unknown> {
	if (snapshot.resolved) {
		const { selection, runtimeDefaults, fallback, info, savedUserProfile } =
			snapshot.resolved;
		return {
			resolved: {
				info: info ?? null,
				executionProfile: selection.executionProfile ?? null,
				executionProfileOverride: selection.executionProfileOverride ?? null,
				runtimeDefaults: runtimeDefaults ?? null,
				fallback: fallback ?? null,
				savedUserProfile: savedUserProfile
					? { ...savedUserProfile, updatedAt: undefined }
					: null,
			},
		};
	}
	const userDefault = snapshot.declaredChoice?.userDefault;
	return {
		declaredChoice: {
			userDefault: userDefault
				? { ...userDefault, updatedAt: undefined }
				: null,
		},
	};
}

function runtimeOverrides(
	request: LaunchRequestBase,
): WorkflowRuntimeDefaults | undefined {
	return request.model || request.effort
		? {
				...(request.model ? { model: request.model } : {}),
				...(request.effort ? { thinking: request.effort } : {}),
			}
		: undefined;
}

function validateLaunchRequest(
	request: LaunchRequestBase,
	action: "run" | "dynamic",
): void {
	if (typeof request.task !== "string" || !request.task.trim())
		throw new HostUsageError(
			action === "run"
				? 'run needs a task: agent-workflow run <workflow> "<task>"'
				: 'dynamic needs a task: agent-workflow dynamic "<task>"',
		);
	for (const key of ["executor", "profile", "model"] as const)
		if (
			request[key] !== undefined &&
			(typeof request[key] !== "string" || !request[key]!.trim())
		)
			throw new HostUsageError(`${action} ${key} must be a non-empty string`);
	if (
		request.permissionMode !== undefined &&
		request.permissionMode !== "free" &&
		request.permissionMode !== "safe"
	)
		throw new HostUsageError(
			`${action} permissionMode must be "free" or "safe"`,
		);
	if (request.effort !== undefined && !isThinkingLevel(request.effort))
		throw new HostUsageError(`${action} effort is not a known effort level`);
	if (request.allowUnverifiedCapabilities !== undefined) {
		if (
			!Array.isArray(request.allowUnverifiedCapabilities) ||
			request.allowUnverifiedCapabilities.some((key) => typeof key !== "string")
		)
			throw new HostUsageError(
				`${action} allowUnverifiedCapabilities must be an array of capability keys`,
			);
		parseCapabilityList(
			request.allowUnverifiedCapabilities.join(","),
			"allowUnverifiedCapabilities",
		);
	}
	for (const key of ["detach", "forceNew", "interactive"] as const)
		if (request[key] !== undefined && typeof request[key] !== "boolean")
			throw new HostUsageError(`${action} ${key} must be a boolean`);
	if (request.interactive && typeof request.confirmDegradations !== "function")
		throw new HostUsageError(
			`${action}: an interactive launch needs a confirmDegradations callback`,
		);
}

function existingRunText(
	action: "run" | "dynamic",
	run: WorkflowRunRecord,
	hints: WorkflowCommandHints,
	now = Date.now(),
): string {
	const startedAgoMs = now - Date.parse(run.createdAt);
	const startedAgo = Number.isFinite(startedAgoMs)
		? `, started ${formatApproxDuration(startedAgoMs)} ago`
		: "";
	const what = action === "dynamic" ? "dynamic task" : "workflow, task";
	return [
		`Duplicate launch guard: run ${run.runId} is already active with the same ${what}, inputs and options (${run.status}${startedAgo}).`,
		`Not starting a new run; returning the existing run ${run.runId}. Check status (${hints.status(run.runId)}) or wait for it (${hints.wait(run.runId)}); launch again with --force-new to really start another run.`,
		formatHumanRunLaunch(run, { hints }),
	].join("\n");
}

/**
 * WP12a: type input overrides against the spec's declared `input` defaults. Every key must be
 * declared (an undeclared key used to be dropped silently). A string value (`--input key=value`)
 * becomes the declared default's type: number (finite), boolean (`true`/`false`), JSON for objects,
 * arrays and `null` defaults; a string default keeps the string. A non-string value must already
 * have the declared type.
 */
export function typedWorkflowInputOverrides(
	spec: unknown,
	overrides: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (overrides === undefined) return undefined;
	if (
		typeof overrides !== "object" ||
		overrides === null ||
		Array.isArray(overrides)
	)
		throw new HostUsageError("inputOverrides must be an object");
	const keys = Object.keys(overrides);
	if (keys.length === 0) return undefined;
	const declared = (spec as { input?: unknown } | undefined)?.input;
	const input =
		declared && typeof declared === "object" && !Array.isArray(declared)
			? (declared as Record<string, unknown>)
			: {};
	const names = Object.keys(input);
	const typed: Record<string, unknown> = {};
	for (const key of keys) {
		if (!Object.hasOwn(input, key))
			throw new HostUsageError(
				names.length === 0
					? `input ${key} is not declared: this workflow declares no inputs`
					: `input ${key} is not declared by this workflow (declared: ${names.join(", ")})`,
			);
		typed[key] = typedInputValue(key, input[key], overrides[key]);
	}
	return typed;
}

function inputKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function typedInputValue(
	key: string,
	declared: unknown,
	value: unknown,
): unknown {
	const kind = inputKind(declared);
	if (typeof value === "string" && kind !== "string") {
		if (kind === "number") {
			const number = value.trim() === "" ? Number.NaN : Number(value);
			if (!Number.isFinite(number))
				throw new HostUsageError(
					`input ${key} must be a number; got ${JSON.stringify(value)}`,
				);
			return number;
		}
		if (kind === "boolean") {
			if (value === "true") return true;
			if (value === "false") return false;
			throw new HostUsageError(
				`input ${key} must be true or false; got ${JSON.stringify(value)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new HostUsageError(
				`input ${key} must be JSON (${kind}); got ${JSON.stringify(value)}`,
			);
		}
		if (kind !== "null" && inputKind(parsed) !== kind)
			throw new HostUsageError(`input ${key} must be a JSON ${kind}`);
		return parsed;
	}
	if (kind !== "null" && inputKind(value) !== kind)
		throw new HostUsageError(
			`input ${key} must be a ${kind}; got ${inputKind(value)}`,
		);
	return value;
}

/** Path of the `agent-workflow` bin shipped with this package (src/hosts/cli/cli.mjs). */
export function agentWorkflowCliPath(): string {
	return fileURLToPath(new URL("../../src/hosts/cli/cli.mjs", import.meta.url));
}

/**
 * Spawn `agent-workflow supervise <runId>` detached from this process. Its output goes to
 * `<run dir>/supervise.log`. AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR=1 keeps it in this
 * process group (tests).
 */
export function spawnDetachedSupervisor(
	cwd: string,
	runId: string,
	env: NodeJS.ProcessEnv = process.env,
): { pid: number | undefined; logPath: string } {
	const logPath = join(workflowRunDir(cwd, runId), "supervise.log");
	const fd = openSync(logPath, "a");
	try {
		const child = spawn(
			process.execPath,
			[agentWorkflowCliPath(), "supervise", runId],
			{
				cwd,
				env,
				detached: env.AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR !== "1",
				stdio: ["ignore", fd, fd],
			},
		);
		child.unref();
		return { pid: child.pid, logPath };
	} finally {
		closeSync(fd);
	}
}

function isRefusal(error: unknown): boolean {
	return (
		error instanceof WorkflowCapabilityError ||
		error instanceof WorkflowExecutorUnavailableError
	);
}

/**
 * The launch's capability check in a few lines (owner, 2026-10-30: "short; stop on a problem"): the
 * summary line, then each degradation once with the stages it affects, then the notices. The full
 * per-stage preview stays in the run record (`capabilityNegotiation.preview`) and `--json`.
 */
export function compactCapabilityText(
	negotiation: Pick<
		WorkflowRunCapabilityNegotiation,
		"preview" | "stages" | "forcedReadOnly" | "notices"
	>,
): string {
	const lines = [negotiation.preview.split("\n")[0] ?? ""];
	const groups = new Map<string, string[]>();
	for (const stage of negotiation.stages)
		for (const entry of stage.report.entries) {
			if (entry.code === undefined) continue;
			const text = `${entry.key}${entry.note ? ` — ${entry.note}` : ""}`;
			groups.set(text, [...(groups.get(text) ?? []), stage.label]);
		}
	const total = negotiation.stages.length;
	for (const [text, labels] of groups)
		lines.push(
			`  ⚠ ${text} (${labels.length === total && total > 1 ? `all ${total} stages` : labels.join(", ")})`,
		);
	if (negotiation.forcedReadOnly.length > 0)
		lines.push(
			`  ⚠ readOnly enforced on: ${negotiation.forcedReadOnly.join(", ")}`,
		);
	for (const notice of negotiation.notices ?? []) lines.push(`  ⚠ ${notice}`);
	return lines.join("\n");
}

function refusalResult(
	action: "run" | "dynamic",
	mode: LaunchData["mode"],
	error: WorkflowCapabilityError | WorkflowExecutorUnavailableError,
	profile: LaunchProfileInfo | undefined,
): HostResult<LaunchData> {
	const capability = error instanceof WorkflowCapabilityError;
	return result(
		action,
		"refused",
		{
			mode,
			...(profile ? { profile } : {}),
			refusal: {
				code: capability ? error.code : "EXECUTOR_UNAVAILABLE",
				...(error.executorId ? { executorId: error.executorId } : {}),
				...(capability && error.preview ? { preview: error.preview } : {}),
			},
		},
		`Not started: ${error.message}`,
	);
}

/** WP42: the launch was cancelled (its foreground signal aborted) before anything was published. */
function cancelledLaunchResult(
	action: "run" | "dynamic",
	mode: LaunchData["mode"],
	profile: LaunchProfileInfo | undefined,
): HostResult<LaunchData> {
	return result(
		action,
		"refused",
		{
			mode,
			...(profile ? { profile } : {}),
			refusal: { code: LAUNCH_CANCELLED },
		},
		"Not started: the launch was cancelled (the session ended) before the run was published; nothing was started.",
	);
}

/** WP42: refusal code of a launch whose foreground signal aborted before publication. */
export const LAUNCH_CANCELLED = "LAUNCH_CANCELLED";

function launchData(
	ctx: HostApiContext,
	run: WorkflowRunRecord,
	mode: LaunchData["mode"],
	profile: LaunchProfileInfo | undefined,
): LaunchData {
	const negotiation = run.capabilityNegotiation;
	return {
		mode,
		runId: run.runId,
		status: run.status,
		...(run.name ? { name: run.name } : {}),
		...(mode === "named-workflow"
			? { specPath: toDisplayPath(run.specPath, ctx.cwd) }
			: {}),
		...(run.executor
			? {
					executor: {
						id: run.executor.id,
						source: run.executor.source,
						...(run.executor.profile ? { profile: run.executor.profile } : {}),
						...(run.executor.host ? { host: run.executor.host } : {}),
					},
				}
			: {}),
		...(run.permissionMode
			? { permissionMode: { ...run.permissionMode } }
			: {}),
		...(run.roleExecution ? { roles: launchRoles(run.roleExecution) } : {}),
		...(profile ? { profile } : {}),
		...(negotiation
			? {
					capability: {
						preview: negotiation.preview,
						confirmation: negotiation.confirmation,
						degradations: [...negotiation.degradations],
						forcedReadOnly: [...negotiation.forcedReadOnly],
						...(negotiation.notices
							? { notices: [...negotiation.notices] }
							: {}),
					},
				}
			: {}),
		taskSummary: run.taskSummary,
	};
}

/** WP31: the launch data view of `run.roleExecution`. */
function launchRoles(
	roleExecution: NonNullable<WorkflowRunRecord["roleExecution"]>,
): NonNullable<LaunchData["roles"]> {
	return {
		mixed: roleExecution.mixed,
		executors: Object.keys(roleExecution.executors),
		stages: Object.entries(roleExecution.stages).map(([stage, assignment]) => ({
			stage,
			executor: assignment.executor,
			source: assignment.source,
			...(assignment.role ? { role: assignment.role } : {}),
			...(assignment.model ? { model: assignment.model } : {}),
			...(assignment.effort ? { effort: assignment.effort } : {}),
		})),
		...(roleExecution.warnings?.length
			? { warnings: [...roleExecution.warnings] }
			: {}),
	};
}

/** WP31: one line per stage of a role-profile launch (`stage → executor model effort (role)`). */
export function formatLaunchRoles(
	roles: NonNullable<LaunchData["roles"]>,
): string {
	return [
		`Role profile (${roles.mixed ? `mixed executors: ${roles.executors.join(", ")}` : `executor: ${roles.executors[0] ?? "?"}`}):`,
		...roles.stages.map(
			(stage) =>
				`  ${stage.stage} → ${stage.executor}${stage.model ? ` ${stage.model}` : ""}${stage.effort ? ` ${stage.effort}` : ""} (${stage.role ? `role ${stage.role}, ` : ""}${stage.source})`,
		),
		...(roles.warnings ?? []).map((warning) => `  note: ${warning}`),
	].join("\n");
}

/**
 * WP19 (review #8): what this launch will actually run with, resolved without prompting or probing:
 * the host, the executor that applies and where it comes from (request flag, saved user profile
 * named by the request or the default one, the saved per-workflow preference, the workflow's
 * declared profiles, the host override, the host's own CLI or the terminal's installed-default
 * order), the resolved launch profile snapshot (WP19 round 2, N5: user profile contents, the saved
 * per-workflow preference with its stage overrides), the host's inherited model/effort, and a digest
 * of the workflow definition (which also covers its declared profiles and defaults). Two identical
 * requests from different hosts, or after a profile, preference or workflow change, are different
 * launches.
 */
function launchExecutionIdentity(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	request: LaunchRequestBase,
	snapshot: LaunchProfileSnapshot,
): Record<string, unknown> {
	const host = ctx.host ?? "cli";
	const resolved = snapshot.resolved;
	const override = resolved?.selection.executionProfileOverride;
	const userKind =
		resolved?.info?.kind === "user" || resolved?.info?.kind === "preset";
	const profileExecutor = userKind
		? (override?.executor ?? resolved?.fallback?.executor)
		: undefined;
	const userDefault =
		snapshot.declaredChoice?.userDefault ?? resolved?.savedUserProfile;
	const hostDefault =
		host === "cli" || host === "generic"
			? { id: INSTALLED_DEFAULT_ORDER.join(">"), source: "installed-default" }
			: { id: HOST_DEFAULT_EXECUTORS[host], source: "host-default" };
	const executor = request.executor
		? { id: request.executor, source: "request" }
		: profileExecutor
			? {
					id: profileExecutor,
					source:
						resolved?.info?.source === "request"
							? "user-profile"
							: "user-default",
				}
			: resolved?.info?.kind === "declared" || snapshot.declaredChoice
				? {
						id: "",
						source: "workflow-profile",
						...(userDefault?.executor
							? { userDefault: userDefault.executor }
							: {}),
						fallback: hostDefault,
					}
				: ctx.defaultExecutor
					? { id: ctx.defaultExecutor, source: "default" }
					: hostDefault;
	return {
		host,
		executor,
		defaultExecutor: ctx.defaultExecutor ?? "",
		profile: snapshotIdentity(snapshot),
		runtimeDefaults: ctx.runtimeDefaults ?? null,
		permissionMode:
			request.permissionMode ??
			override?.permissionMode ??
			resolved?.fallback?.permissionMode ??
			"",
		workflowDefinition: workflowDefinitionFingerprint(loaded.spec),
		// WP31: a changed per-workflow preference is a different launch.
		workflowPreference: snapshot.preference
			? { ...snapshot.preference, updatedAt: undefined }
			: null,
	};
}

async function launch(
	ctx: HostApiContext,
	action: "run" | "dynamic",
	request: LaunchRequestBase,
	loaded: LoadedWorkflowSpec,
	start: (options: WorkflowRunOptions) => Promise<WorkflowRunRecord>,
): Promise<HostResult<LaunchData>> {
	const mode = action === "run" ? "named-workflow" : "direct-dynamic";
	const task = request.task.trim();
	// WP19 round 3 (R5): the definition this launch is resolved from (guard, chooser); the engine
	// refuses to start when its own final load differs.
	const definitionFingerprint = workflowDefinitionFingerprint(loaded.spec);
	const inputOverrides = typedWorkflowInputOverrides(
		loaded.spec,
		request.inputOverrides,
	);
	// WP16: one guard for attached and detached launches (see launch-guard.ts).
	// WP19 (review #8): the identity is the resolved execution identity, not only the request.
	// WP19 round 2 (N5): resolved once; the launch below runs from the same snapshot.
	const snapshot = await snapshotLaunchProfile(ctx, loaded, request);
	if (request.signal?.aborted)
		return cancelledLaunchResult(action, mode, undefined);
	const execution = launchExecutionIdentity(ctx, loaded, request, snapshot);
	const fingerprint = launchFingerprint({
		execution,
		kind: action,
		cwd: ctx.cwd,
		specPath: loaded.specPath,
		...(loaded.spec.name ? { specName: loaded.spec.name } : {}),
		task,
		...(inputOverrides ? { inputs: inputOverrides } : {}),
		...(request.executor ? { executor: request.executor } : {}),
		...(request.profile ? { profile: request.profile } : {}),
		...(request.permissionMode
			? { permissionMode: request.permissionMode }
			: {}),
		...(request.allowUnverifiedCapabilities?.length
			? { allowUnverifiedCapabilities: request.allowUnverifiedCapabilities }
			: {}),
		...(request.model ? { model: request.model } : {}),
		...(request.effort ? { effort: request.effort } : {}),
	});
	let guard: Extract<
		Awaited<ReturnType<typeof claimLaunch>>,
		{ kind: "claimed" }
	> | null = null;
	const duplicate = (
		decision:
			| { kind: "existing"; run: WorkflowRunRecord }
			| { kind: "in-flight"; claimedAt: string },
	): HostResult<LaunchData> => {
		if (decision.kind === "existing") {
			const data = launchData(ctx, decision.run, mode, undefined);
			data.duplicateOf = decision.run.runId;
			return result(
				action,
				"existing",
				data,
				existingRunText(action, decision.run, hostCommandHints(ctx.host)),
			);
		}
		return result(
			action,
			"refused",
			{ mode, refusal: { code: "DUPLICATE_LAUNCH_IN_PROGRESS" } },
			`Duplicate launch guard: an identical launch started at ${decision.claimedAt} is still starting. Not starting a new run; check status in a moment, or launch again with --force-new to really start another run.`,
		);
	};
	if (!request.forceNew && !request.preflightOnly) {
		const decision = await claimLaunch(ctx.cwd, fingerprint);
		if (decision.kind !== "claimed") return duplicate(decision);
		guard = decision;
	}
	try {
		return await launchClaimed(ctx, action, request, loaded, start, {
			mode,
			task,
			snapshot,
			inputOverrides,
			definitionFingerprint,
			// WP19 round 2 (N1): the ownership fence right before `start()`. A launch whose claim
			// was taken over meanwhile starts nothing.
			beforeStart: async () => {
				if (!guard) return undefined;
				const fence = await guard.begin();
				return fence.kind === "owned" ? undefined : duplicate(fence);
			},
			onStarted: async (runId) => {
				if (guard) await guard.record(runId);
				else await recordForcedLaunch(ctx.cwd, fingerprint, runId);
			},
		});
	} finally {
		// No-op once the run id is recorded; frees the claim when nothing started.
		await guard?.release().catch(() => undefined);
	}
}

async function launchClaimed(
	ctx: HostApiContext,
	action: "run" | "dynamic",
	request: LaunchRequestBase,
	loaded: LoadedWorkflowSpec,
	start: (options: WorkflowRunOptions) => Promise<WorkflowRunRecord>,
	launch: {
		mode: LaunchData["mode"];
		task: string;
		snapshot: LaunchProfileSnapshot;
		inputOverrides: Record<string, unknown> | undefined;
		/** WP19 round 3 (R5): fingerprint of the definition the launch was resolved from. */
		definitionFingerprint: string;
		/** WP19 round 2 (N1): a result here means "do not start" (displaced launch). */
		beforeStart: () => Promise<HostResult<LaunchData> | undefined>;
		onStarted: (runId: string) => Promise<void>;
	},
): Promise<HostResult<LaunchData>> {
	const { mode, task, inputOverrides } = launch;
	if (request.signal?.aborted)
		return cancelledLaunchResult(action, mode, undefined);
	const profile = await finishLaunchProfile(
		ctx,
		loaded,
		request,
		launch.snapshot,
	);
	// WP42: the session may have ended while the profile chooser was open.
	if (request.signal?.aborted)
		return cancelledLaunchResult(action, mode, profile.info);
	let promptSchemaNotice = "";
	let promptSchemaDigest: string | undefined;
	const executor = request.executor ?? profile.fallback?.executor;
	const permissionMode =
		request.permissionMode ?? profile.fallback?.permissionMode;
	const runtimeDefaults = profile.runtimeDefaults ?? ctx.runtimeDefaults;
	const overrides = runtimeOverrides(request);
	const options: WorkflowRunOptions & {
		[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]: (
			notice: string,
			digest: string,
		) => void;
		[WORKFLOW_EXPECTED_DEFINITION_FINGERPRINT]: string;
	} = {
		task,
		...(request.preflightOnly ? { preflightOnly: true } : {}),
		...profile.selection,
		...(profile.savedUserProfile && profile.selection.executionProfile
			? { savedUserProfile: savedUserProfileLayer(profile.savedUserProfile) }
			: {}),
		// WP31: the saved per-workflow preference's role overrides.
		...(launch.snapshot.preference?.roles
			? {
					workflowPreference: {
						name: launch.snapshot.preference.workflow,
						roles: launch.snapshot.preference.roles,
					},
				}
			: {}),
		...(executor ? { executor } : {}),
		...(ctx.defaultExecutor ? { defaultExecutor: ctx.defaultExecutor } : {}),
		...(ctx.host ? { host: ctx.host } : {}),
		...(permissionMode ? { permissionMode } : {}),
		...(request.allowUnverifiedCapabilities?.length
			? {
					allowUnverifiedCapabilities: [...request.allowUnverifiedCapabilities],
				}
			: {}),
		...(request.interactive ? { interactive: true } : {}),
		...(request.confirmDegradations
			? { confirmDegradations: request.confirmDegradations }
			: {}),
		...(overrides ? { runtimeOverrides: overrides } : {}),
		...(runtimeDefaults ? { runtimeDefaults } : {}),
		...(ctx.availableModels ? { availableModels: ctx.availableModels } : {}),
		// WP29: an attached launch may ask the user to approve a dynamic controller.
		...(ctx.dynamicUi && !request.detach ? { dynamicUi: ctx.dynamicUi } : {}),
		...(ctx.hostTools ? { inheritHostTools: true } : {}),
		...(inputOverrides ? { inputOverrides } : {}),
		// WP42: the engine's foreground fence (after the capability confirm, before publication and
		// before the first dispatch; exact-run stop once published).
		...(request.signal ? { launchSignal: request.signal } : {}),
		// WP33: host-neutral launch capture (launch-command.txt + run.launch).
		launch: hostLaunchCapture(
			ctx.host,
			hostEnv(ctx),
			action,
			request,
			request.launchOrigin,
			request.autoSelection,
		),
		[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]: (notice, digest) => {
			if (digest === promptSchemaDigest) return;
			promptSchemaDigest = digest;
			promptSchemaNotice = notice;
		},
		[WORKFLOW_EXPECTED_DEFINITION_FINGERPRINT]: launch.definitionFingerprint,
	};
	// Nothing between the fence and `start()` awaits anything else.
	const displaced = await launch.beforeStart();
	if (displaced) return displaced;
	if (request.signal?.aborted)
		return cancelledLaunchResult(action, mode, profile.info);
	let run: WorkflowRunRecord;
	try {
		// WP35: a host that lends its tools records its host context on the run.
		run = await (ctx.hostTools
			? withHostContext(
					createHostContext({
						cwd: ctx.cwd,
						projectTrusted: ctx.hostTools.projectTrusted,
						env: hostEnv(ctx),
					}),
					() => start(options),
				)
			: start(options));
	} catch (error) {
		// WP42: aborted before publication (the engine's launchSignal fence threw): nothing started.
		if (request.signal?.aborted)
			return cancelledLaunchResult(action, mode, profile.info);
		if (error instanceof WorkflowPreflightPassed)
			return result(
				action,
				"success",
				{
					mode,
					...(profile.info ? { profile: profile.info } : {}),
					capability: {
						preview: error.negotiation.preview,
						confirmation: error.negotiation.confirmation,
						degradations: [...error.negotiation.degradations],
						forcedReadOnly: [...error.negotiation.forcedReadOnly],
						...(error.negotiation.notices
							? { notices: [...error.negotiation.notices] }
							: {}),
					},
				},
				[
					`Preflight passed: ${loaded.spec.name ?? "workflow"} on ${error.negotiation.executorId} — no run was started.`,
					compactCapabilityText(error.negotiation),
				].join("\n"),
			);
		if (error instanceof WorkflowDefinitionChangedError)
			return result(
				action,
				"refused",
				{
					mode,
					...(profile.info ? { profile: profile.info } : {}),
					refusal: { code: error.code },
				},
				`Not started: ${error.message}`,
			);
		if (isRefusal(error))
			return refusalResult(
				action,
				mode,
				error as WorkflowCapabilityError,
				profile.info,
			);
		throw error;
	}
	await launch.onStarted(run.runId).catch(() => undefined);
	const data = launchData(ctx, run, mode, profile.info);
	// Dashboard discovery/start is best effort and adds at most the 3 s discovery budget
	// (`dashboardStartBudgetMs`).
	let dashboardTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		data.dashboard = await Promise.race([
			(async (): Promise<LaunchData["dashboard"]> => {
				let dashboard = await readDashboardDiscovery(ctx.cwd);
				let started = false;
				if (
					!dashboard &&
					hostEnv(ctx).AGENT_WORKFLOW_DASHBOARD_AUTOSTART !== "0" &&
					getWorkflowProcessRole(hostEnv(ctx)) === "supervisor" &&
					!ctx.readonly &&
					["running", "completed", "blocked"].includes(run.status)
				) {
					dashboard = await ensureDashboard(ctx.cwd, hostEnv(ctx), {
						start: true,
					});
					started = Boolean(dashboard);
				}
				return dashboard
					? {
							url: `http://127.0.0.1:${dashboard.port}/?run=${run.runId}`,
							port: dashboard.port,
							...(started ? { started: true } : {}),
							...(dashboard.auth ? { auth: true } : {}),
						}
					: undefined;
			})(),
			new Promise<undefined>((done) => {
				dashboardTimer = setTimeout(
					() => done(undefined),
					dashboardStartBudgetMs(),
				);
			}),
		]);
	} catch {
		/* A dashboard failure must never fail the workflow launch. */
	} finally {
		clearTimeout(dashboardTimer);
	}
	if (promptSchemaNotice) data.promptSchemaNotice = promptSchemaNotice;
	let detachNote = "";
	if (request.detach && run.status === "running") {
		data.detached = spawnDetachedSupervisor(ctx.cwd, run.runId, hostEnv(ctx));
		const hints = hostCommandHints(ctx.host);
		detachNote = `\nDetached supervisor: pid ${data.detached.pid ?? "unknown"}, log ${toDisplayPath(data.detached.logPath, ctx.cwd)}\nCheck progress: ${hints.status(run.runId)}\nWait for the result: ${hints.wait(run.runId)}`;
	}
	const verb =
		run.status === "running"
			? "started"
			: run.status === "completed"
				? "completed"
				: run.status === "blocked"
					? "blocked"
					: "failed to start";
	const heading =
		action === "dynamic"
			? `Dynamic workflow ${verb}`
			: `Workflow ${verb}: ${run.name ?? "workflow"}`;
	// WP19 (review #9): the terminal default fell back to a CLI whose login is not verified.
	const chosenCandidate =
		run.executor?.source === "installed-default"
			? run.executor.candidates?.find(
					(candidate) => candidate.id === run.executor?.id,
				)
			: undefined;
	const unverifiedNote =
		chosenCandidate?.auth === "unknown"
			? unverifiedDefaultGuidance(chosenCandidate.id)
			: undefined;
	// WP43b: the dashboard link is the first thing a person wants after a launch; when none runs,
	// say so in one short line instead of silently omitting it.
	const dashboardLine = data.dashboard
		? `Dashboard: ${data.dashboard.url}${data.dashboard.started && data.dashboard.auth ? " · first time in this browser? agent-workflow dashboard --open" : ""}`
		: `Dashboard: not running · agent-workflow dashboard --open`;
	const text = [
		promptSchemaNotice || undefined,
		run.capabilityNegotiation
			? compactCapabilityText(run.capabilityNegotiation)
			: undefined,
		data.roles ? formatLaunchRoles(data.roles) : undefined,
		unverifiedNote,
		heading,
		data.runId ? dashboardLine : undefined,
		formatHumanRunLaunch(run, { hints: hostCommandHints(ctx.host) }),
	]
		.filter((line): line is string => Boolean(line))
		.join("\n")
		.concat(detachNote);
	return result(action, outcomeForRunStatus(run.status), data, text);
}

/** `run`: start exactly the named workflow. Returns once launched (status usually `running`). */
export async function runWorkflowAction(
	ctx: HostApiContext,
	request: RunWorkflowRequest,
): Promise<HostResult<LaunchData>> {
	assertActionAllowed(ctx, "run" satisfies HostAction);
	if (typeof request.workflow !== "string" || !request.workflow.trim())
		throw new HostUsageError(
			'run needs a workflow: agent-workflow run <workflow> "<task>"',
		);
	validateLaunchRequest(request, "run");
	const loaded = await loadWorkflowSpec(request.workflow.trim(), ctx.cwd);
	return launch(ctx, "run", request, loaded, (options) =>
		runWorkflowSpec(loaded.specPath, ctx.cwd, options),
	);
}

/**
 * `check`: the launch preflight only (owner, 2026-10-30) — the same executor selection, compile
 * and capability/tool/model/effort checks as `run`, then stop. `refused` names what would stop a
 * run; `success` shows the short check. No run, no duplicate-launch claim, no model call.
 */
export async function checkWorkflowAction(
	ctx: HostApiContext,
	request: Omit<RunWorkflowRequest, "task"> & { task?: string },
): Promise<HostResult<LaunchData>> {
	assertActionAllowed(ctx, "validate" satisfies HostAction);
	if (typeof request.workflow !== "string" || !request.workflow.trim())
		throw new HostUsageError(
			"check needs a workflow: agent-workflow check <workflow>",
		);
	const full = {
		...request,
		task: request.task?.trim() || "preflight check",
		detach: false,
		preflightOnly: true,
	};
	validateLaunchRequest(full, "run");
	const loaded = await loadWorkflowSpec(request.workflow.trim(), ctx.cwd);
	const checked = await launch(ctx, "run", full, loaded, (options) =>
		runWorkflowSpec(loaded.specPath, ctx.cwd, options),
	);
	return { ...checked, action: "check" };
}

/** `dynamic`: start a spec-less direct dynamic run. */
export async function runDynamicAction(
	ctx: HostApiContext,
	request: RunDynamicRequest,
): Promise<HostResult<LaunchData>> {
	assertActionAllowed(ctx, "dynamic" satisfies HostAction);
	validateLaunchRequest(request, "dynamic");
	const specPath = await ensureDirectDynamicRuntimeBundle(ctx.cwd);
	const loaded = await loadWorkflowSpec(specPath, ctx.cwd);
	return launch(ctx, "dynamic", request, loaded, (options) =>
		runDynamicTask(ctx.cwd, options),
	);
}
