// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/extension.ts (startWorkflowRunFromRequest,
// startDynamicRunFromRequest, selectWorkflowExecutionProfile, resolveWorkflowExecutionProfileForLaunch,
// duplicateRunGuardNotice, spawnDetachedSupervisor). MIT, same author. Changes (WP11a): host-neutral
// `run`/`dynamic` handlers with no Pi context: the run options executor, profile, permissionMode,
// allowUnverifiedCapabilities, interactive + confirmDegradations (WP4d), model/effort; saved user
// profiles (user-profiles.ts) as the B2 "saved user profile" tier; capability refusals and the
// duplicate guard return `refused` results instead of throwing; no launch-capture record (the
// v1 capture schema only knows Pi slash commands and Pi tools); the detached supervisor is the
// `agent-workflow supervise` CLI and logs to `<run dir>/supervise.log`.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowCapabilityError } from "../core/capability-negotiation.js";
import { ensureDirectDynamicRuntimeBundle } from "../core/dynamic-runtime-bundle.js";
import {
	formatHumanRunLaunch,
	runDynamicTask,
	runWorkflowSpec,
	WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK,
	type WorkflowRunOptions,
} from "../core/engine.js";
import { workflowDefinitionFingerprint } from "../core/execution-profile.js";
import { WorkflowExecutorUnavailableError } from "../core/executor-registry.js";
import {
	type DuplicateRunTarget,
	findDuplicateActiveRun,
	formatApproxDuration,
} from "../core/run-estimates.js";
import { type LoadedWorkflowSpec, loadWorkflowSpec } from "../core/schema.js";
import { workflowRunDir } from "../core/store.js";
import type {
	ThinkingLevel,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutionProfileSelection,
	WorkflowRunRecord,
} from "../core/types.js";
import { resolveSavedWorkflowExecutionProfile } from "../core/workflow-profile-settings.js";
import type { WorkflowRuntimeDefaults } from "../core/workflow-runtime.js";
import type { CapabilityPreview } from "../sdk/requirements.js";
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
	readUserProfiles,
	type UserProfile,
	userProfileFromFile,
} from "./user-profiles.js";

export type WorkflowProfileSelector = (
	title: string,
	options: string[],
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
	/** B4 (WP4d): the host can ask the user; degradations then need confirmDegradations. */
	interactive?: boolean;
	confirmDegradations?: (preview: CapabilityPreview) => Promise<boolean>;
	/** Interactive chooser between declared profiles when none is named (Pi host). */
	selectProfile?: WorkflowProfileSelector;
	/** Overrides for inputs the spec declares (for example depth). */
	inputOverrides?: Record<string, unknown>;
}

export interface RunWorkflowRequest extends LaunchRequestBase {
	/** Workflow name, alias, or spec path. */
	workflow: string;
}

export type RunDynamicRequest = LaunchRequestBase;

export interface LaunchProfileInfo {
	name: string;
	kind: "declared" | "user" | "workflow-preference";
	/** `request`: named by the caller; the others were picked because none was named. */
	source:
		| "request"
		| "workflow-default"
		| "user-default"
		| "workflow-preference";
}

export interface LaunchData {
	mode: "named-workflow" | "direct-dynamic";
	runId?: string;
	status?: WorkflowRunRecord["status"];
	name?: string;
	specPath?: string;
	executor?: { id: string; source: string; profile?: string };
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
		availableModels?: HostApiContext["availableModels"];
		currentRuntime?: WorkflowRuntimeDefaults;
		runtimeOverrides?: WorkflowRuntimeDefaults;
	} = {},
): Promise<WorkflowExecutionProfileSelection> {
	if (explicitProfile) return { executionProfile: explicitProfile };
	const loaded =
		options.loadedWorkflow ?? (await loadWorkflowSpec(workflow, cwd));
	const saved = await resolveSavedWorkflowExecutionProfile({
		spec: loaded.spec,
		specPath: loaded.specPath,
		availableModels: options.availableModels ?? [],
		currentRuntime: options.currentRuntime ?? {},
		runtimeOverrides: options.runtimeOverrides,
	});
	if (saved) return { executionProfileOverride: saved };
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
	info?: LaunchProfileInfo;
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
	};
	return {
		selection: { executionProfileOverride: override },
		runtimeDefaults,
		info,
	};
}

/**
 * Profile for one launch. Named: a declared spec profile wins over a saved user profile of the
 * same name. Not named: (host with a model registry: saved per-workflow Pi preference) > declared
 * default (or the interactive declared chooser) > default saved user profile > none.
 */
async function resolveLaunchProfile(
	ctx: HostApiContext,
	loaded: LoadedWorkflowSpec,
	request: LaunchRequestBase,
): Promise<LaunchProfile> {
	const env = hostEnv(ctx);
	const declared = loaded.spec.executionProfiles ?? {};
	if (request.profile !== undefined) {
		if (Object.hasOwn(declared, request.profile))
			return {
				selection: { executionProfile: request.profile },
				info: { name: request.profile, kind: "declared", source: "request" },
			};
		const file = await readUserProfiles(env);
		const user = userProfileFromFile(file, request.profile);
		if (user) return applyUserProfile(ctx, loaded, user, "request");
		const declaredNames = Object.keys(declared).sort();
		const userNames = Object.keys(file.profiles).sort();
		throw new HostUsageError(
			`unknown profile "${request.profile}": the workflow declares ${declaredNames.length ? declaredNames.join(", ") : "no execution profiles"}; saved user profiles: ${userNames.length ? userNames.join(", ") : "none"}`,
		);
	}
	if (ctx.availableModels !== undefined) {
		const selection = await resolveWorkflowExecutionProfileForLaunch(
			loaded.specPath,
			ctx.cwd,
			undefined,
			{
				loadedWorkflow: loaded,
				availableModels: ctx.availableModels,
				currentRuntime: ctx.runtimeDefaults ?? {},
				...(request.selectProfile ? { select: request.selectProfile } : {}),
				runtimeOverrides: runtimeOverrides(request),
			},
		);
		if (selection.executionProfileOverride)
			return {
				selection,
				info: {
					name: selection.executionProfileOverride.name,
					kind: "workflow-preference",
					source: "workflow-preference",
				},
			};
		if (selection.executionProfile)
			return {
				selection,
				info: {
					name: selection.executionProfile,
					kind: "declared",
					source: "workflow-default",
				},
			};
	} else {
		const executionProfile = await selectWorkflowExecutionProfile(
			loaded.specPath,
			ctx.cwd,
			undefined,
			request.selectProfile,
			loaded,
		);
		if (executionProfile)
			return {
				selection: { executionProfile },
				info: {
					name: executionProfile,
					kind: "declared",
					source: "workflow-default",
				},
			};
	}
	const file = await readUserProfiles(env);
	if (file.default) {
		const user = userProfileFromFile(file, file.default);
		if (user) return applyUserProfile(ctx, loaded, user, "user-default");
	}
	return { selection: {} };
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

async function duplicateRunGuardNotice(
	cwd: string,
	target: DuplicateRunTarget,
	task: string,
): Promise<{ runId: string; text: string } | undefined> {
	const existing = await findDuplicateActiveRun(cwd, target, task.trim()).catch(
		() => undefined,
	);
	if (!existing) return undefined;
	const startedAgoMs = Date.now() - Date.parse(existing.createdAt);
	const startedAgo = Number.isFinite(startedAgoMs)
		? ` (started ${formatApproxDuration(startedAgoMs)} ago)`
		: "";
	const what = target.kind === "dynamic" ? "dynamic task" : "workflow and task";
	return {
		runId: existing.runId,
		text: [
			`Duplicate launch guard: run ${existing.runId} is already active with the same ${what}${startedAgo}.`,
			`Not starting a new run. Check status ${existing.runId}, or launch again with --force-new to really start another run.`,
		].join("\n"),
	};
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
					},
				}
			: {}),
		...(run.permissionMode
			? { permissionMode: { ...run.permissionMode } }
			: {}),
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

async function launch(
	ctx: HostApiContext,
	action: "run" | "dynamic",
	request: LaunchRequestBase,
	loaded: LoadedWorkflowSpec,
	start: (options: WorkflowRunOptions) => Promise<WorkflowRunRecord>,
): Promise<HostResult<LaunchData>> {
	const mode = action === "run" ? "named-workflow" : "direct-dynamic";
	const task = request.task.trim();
	const inputOverrides = typedWorkflowInputOverrides(
		loaded.spec,
		request.inputOverrides,
	);
	if (!request.detach && !request.forceNew) {
		const target: DuplicateRunTarget =
			action === "dynamic"
				? { kind: "dynamic" }
				: { kind: "spec", name: loaded.spec.name };
		const duplicate = await duplicateRunGuardNotice(ctx.cwd, target, task);
		if (duplicate)
			return result(
				action,
				"refused",
				{ mode, duplicateOf: duplicate.runId },
				duplicate.text,
			);
	}
	const profile = await resolveLaunchProfile(ctx, loaded, request);
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
	} = {
		task,
		...profile.selection,
		...(executor ? { executor } : {}),
		...(ctx.defaultExecutor ? { defaultExecutor: ctx.defaultExecutor } : {}),
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
		...(inputOverrides ? { inputOverrides } : {}),
		[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]: (notice, digest) => {
			if (digest === promptSchemaDigest) return;
			promptSchemaDigest = digest;
			promptSchemaNotice = notice;
		},
	};
	let run: WorkflowRunRecord;
	try {
		run = await start(options);
	} catch (error) {
		if (isRefusal(error))
			return refusalResult(
				action,
				mode,
				error as WorkflowCapabilityError,
				profile.info,
			);
		throw error;
	}
	const data = launchData(ctx, run, mode, profile.info);
	if (promptSchemaNotice) data.promptSchemaNotice = promptSchemaNotice;
	let detachNote = "";
	if (request.detach && run.status === "running") {
		data.detached = spawnDetachedSupervisor(ctx.cwd, run.runId, hostEnv(ctx));
		detachNote = `\nDetached supervisor: pid ${data.detached.pid ?? "unknown"}, log ${toDisplayPath(data.detached.logPath, ctx.cwd)}\nCheck progress: agent-workflow status ${run.runId}\nWait for the result: agent-workflow wait ${run.runId}`;
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
	const text = [
		promptSchemaNotice || undefined,
		data.capability?.preview,
		heading,
		formatHumanRunLaunch(run),
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
