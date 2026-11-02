// New in agent-workflow (WP4c-1): executor selection for workflow runs (owner decision B2) and the
// registry that maps executor ids to ExecutorDescriptor modules. pi-workflow had exactly one
// executor (pi-subagent headless Pi); here the run records which executor it uses, and an unknown or
// unavailable executor fails the run before any launch (never a silent fallback).
import { ACP_ADAPTER_VERSION } from "../executors/acp/version.js";
import {
	CLAUDE_ADAPTER_VERSION,
	CLAUDE_EXECUTOR_ID,
} from "../executors/claude/version.js";
import {
	CODEX_ADAPTER_VERSION,
	CODEX_EXECUTOR_ID,
} from "../executors/codex/version.js";
import {
	PI_EXECUTOR_ID,
	PI_EXECUTOR_VERSION,
} from "../executors/pi/version.js";
import { EXECUTOR_CONTRACT_VERSION } from "../sdk/contract.js";
import {
	type ExecutorDescriptor,
	validateExecutorDescriptor,
} from "../sdk/descriptor.js";
import type {
	WorkflowHostId,
	WorkflowRunExecutorCandidate,
	WorkflowRunExecutorSelection,
	WorkflowRunExecutorSource,
} from "./types.js";

/**
 * Built-in executor ids. Their adapters land in WP6 (pi), WP7 (codex) and WP8 (claude);
 * antigravity is the ACP adapter's Google Antigravity preset (live tier 2026-11-02).
 */
export const BUILTIN_EXECUTOR_IDS = [
	"pi",
	"codex",
	"claude",
	"antigravity",
] as const;

/**
 * Executor of a run record that carries no selection (created directly through the store, or a
 * pi-workflow import: those ran on Pi). New runs never use it: their default is the host's own CLI
 * (WP17, executor-default.ts).
 */
export const LEGACY_RECORD_EXECUTOR_ID = "pi";

const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface WorkflowExecutorRegistration {
	readonly id: string;
	/** Present when the executor can launch; persisted in the run record. */
	readonly descriptor?: ExecutorDescriptor;
	/** Why the executor cannot launch (built-ins before their adapter exists). */
	readonly unavailableReason?: string;
}

const BUILTIN_UNAVAILABLE: Readonly<Record<string, string>> = {};

/**
 * Built-in adapters that exist. The descriptor module is the adapter entry as a `file:` URL so a
 * fresh durable worker can reload it (R#15); only the adapter's dependency-free `version.js` is
 * imported here, never the adapter itself.
 */
const BUILTIN_DESCRIPTORS: Readonly<Record<string, () => ExecutorDescriptor>> =
	{
		[PI_EXECUTOR_ID]: () => ({
			id: PI_EXECUTOR_ID,
			version: PI_EXECUTOR_VERSION,
			contractVersion: EXECUTOR_CONTRACT_VERSION,
			module: new URL("../executors/pi/index.js", import.meta.url).href,
			config: null,
		}),
		[CLAUDE_EXECUTOR_ID]: () => ({
			id: CLAUDE_EXECUTOR_ID,
			version: CLAUDE_ADAPTER_VERSION,
			contractVersion: EXECUTOR_CONTRACT_VERSION,
			module: new URL("../executors/claude/index.js", import.meta.url).href,
			config: null,
		}),
		// The ACP adapter serves several agents; the preset in config picks this one (and its id).
		antigravity: () => ({
			id: "antigravity",
			version: ACP_ADAPTER_VERSION,
			contractVersion: EXECUTOR_CONTRACT_VERSION,
			module: new URL("../executors/acp/index.js", import.meta.url).href,
			config: { preset: "antigravity" },
		}),
		[CODEX_EXECUTOR_ID]: () => ({
			id: CODEX_EXECUTOR_ID,
			version: CODEX_ADAPTER_VERSION,
			contractVersion: EXECUTOR_CONTRACT_VERSION,
			module: new URL("../executors/codex/index.js", import.meta.url).href,
			config: null,
		}),
	};

const registrations = new Map<string, WorkflowExecutorRegistration>();

export class WorkflowExecutorUnavailableError extends Error {
	readonly executorId: string;
	readonly source: WorkflowRunExecutorSource;

	constructor(
		message: string,
		executorId: string,
		source: WorkflowRunExecutorSource,
	) {
		super(message);
		this.name = "WorkflowExecutorUnavailableError";
		this.executorId = executorId;
		this.source = source;
	}
}

/**
 * Register (or replace) the descriptor module that serves an executor id. Built-in ids are
 * registered the same way once their adapters exist; tests register fake descriptors.
 * Returns an unregister function that restores the previous registration.
 */
export function registerWorkflowExecutor(
	descriptor: ExecutorDescriptor,
): () => void {
	const problems = validateExecutorDescriptor(descriptor);
	if (problems.length > 0)
		throw new Error(
			`invalid executor descriptor for ${String(descriptor?.id)}: ${problems.join("; ")}`,
		);
	const previous = registrations.get(descriptor.id);
	const registration: WorkflowExecutorRegistration = {
		id: descriptor.id,
		descriptor: { ...descriptor },
	};
	registrations.set(descriptor.id, registration);
	return () => {
		if (registrations.get(descriptor.id) !== registration) return;
		if (previous === undefined) registrations.delete(descriptor.id);
		else registrations.set(descriptor.id, previous);
	};
}

export function workflowExecutorRegistration(
	id: string,
): WorkflowExecutorRegistration | undefined {
	const registered = registrations.get(id);
	if (registered !== undefined) return registered;
	const builtin = BUILTIN_DESCRIPTORS[id];
	if (builtin !== undefined) return { id, descriptor: builtin() };
	const builtinReason = BUILTIN_UNAVAILABLE[id];
	return builtinReason === undefined
		? undefined
		: { id, unavailableReason: builtinReason };
}

export interface RunExecutorSelectionInput {
	/** Run flag (`--executor`). */
	runFlag?: string;
	/** WP31: workflow name of the saved per-workflow preference and its executor. */
	workflowPreferenceName?: string;
	workflowPreferenceExecutor?: string;
	/** Name of the workflow-declared execution profile selected for the run. */
	workflowProfileName?: string;
	workflowProfileExecutor?: string;
	/** Name of the saved user profile captured for the run. */
	userProfileName?: string;
	userProfileExecutor?: string;
	/** Lowest-precedence default (host override, host default or legacy record default). */
	defaultExecutor?: string;
	/** Which rule produced `defaultExecutor` (WP17); `default` when absent. */
	defaultSource?: Extract<
		WorkflowRunExecutorSource,
		"default" | "host-default" | "installed-default"
	>;
	/** Host whose rule chose the default (recorded with `host-default`/`installed-default`). */
	host?: WorkflowHostId;
	/** Candidates the `installed-default` rule probed (recorded). */
	candidates?: WorkflowRunExecutorCandidate[];
}

function describeSource(
	source: WorkflowRunExecutorSource,
	profile: string | undefined,
): string {
	if (source === "run-flag") return "run flag";
	if (source === "workflow-preference")
		return `saved preference of workflow "${profile}"`;
	if (source === "workflow-profile")
		return `workflow execution profile "${profile}"`;
	if (source === "user-profile") return `saved user profile "${profile}"`;
	if (source === "host-default") return "host default";
	if (source === "installed-default") return "installed default";
	return "default";
}

/**
 * B2 precedence: run flag > workflow-declared profile > saved user profile > default. The default
 * must be passed in (`defaultExecutor`); new runs compute it with resolveRunExecutorForHost
 * (executor-default.ts, WP17).
 * Throws WorkflowExecutorUnavailableError (naming the executor and where it came from) when the
 * selected id is unknown or its adapter is unavailable. Lower-precedence sources are never tried
 * as a fallback.
 */
export function resolveRunExecutorSelection(
	input: RunExecutorSelectionInput,
): WorkflowRunExecutorSelection {
	const candidates: Array<{
		id: string | undefined;
		source: WorkflowRunExecutorSource;
		profile?: string;
	}> = [
		{ id: input.runFlag, source: "run-flag" },
		{
			id: input.workflowPreferenceExecutor,
			source: "workflow-preference",
			profile: input.workflowPreferenceName,
		},
		{
			id: input.workflowProfileExecutor,
			source: "workflow-profile",
			profile: input.workflowProfileName,
		},
		{
			id: input.userProfileExecutor,
			source: "user-profile",
			profile: input.userProfileName,
		},
		{
			id: input.defaultExecutor,
			source: input.defaultSource ?? "default",
		},
	];
	const selected = candidates.find(
		(candidate) => candidate.id !== undefined && candidate.id !== "",
	);
	if (selected === undefined || selected.id === undefined)
		throw new WorkflowExecutorUnavailableError(
			"no executor selected for this workflow run",
			"",
			"default",
		);
	const where = describeSource(selected.source, selected.profile);
	if (!EXECUTOR_ID_PATTERN.test(selected.id))
		throw new WorkflowExecutorUnavailableError(
			`executor id "${selected.id}" from ${where} is invalid`,
			selected.id,
			selected.source,
		);
	const registration = workflowExecutorRegistration(selected.id);
	if (registration === undefined)
		throw new WorkflowExecutorUnavailableError(
			`executor "${selected.id}" from ${where} is unknown; known executors: ${[
				...new Set([...BUILTIN_EXECUTOR_IDS, ...registrations.keys()]),
			]
				.sort()
				.join(", ")}. The run was not started.`,
			selected.id,
			selected.source,
		);
	if (registration.descriptor === undefined)
		throw new WorkflowExecutorUnavailableError(
			`executor "${selected.id}" from ${where} is unavailable: ${registration.unavailableReason ?? "no adapter registered"}. The run was not started.`,
			selected.id,
			selected.source,
		);
	const defaulted =
		selected.source === "host-default" ||
		selected.source === "installed-default";
	return {
		id: selected.id,
		source: selected.source,
		...(selected.profile === undefined ? {} : { profile: selected.profile }),
		...(defaulted && input.host !== undefined ? { host: input.host } : {}),
		...(defaulted && input.candidates !== undefined
			? { candidates: input.candidates.map((candidate) => ({ ...candidate })) }
			: {}),
		descriptor: { ...registration.descriptor },
	};
}

/** Executor id a workflow-declared execution profile selects (spec `executionProfileExecutors`). */
export function workflowDeclaredProfileExecutor(
	spec: unknown,
	profileName: string | undefined,
): string | undefined {
	if (profileName === undefined) return undefined;
	const map = (spec as { executionProfileExecutors?: unknown } | undefined)
		?.executionProfileExecutors;
	if (map === null || typeof map !== "object" || Array.isArray(map))
		return undefined;
	const value = (map as Record<string, unknown>)[profileName];
	return typeof value === "string" ? value : undefined;
}

/**
 * Descriptor a run launches with. Uses the descriptor recorded at run creation (rediscovery,
 * R#15); a run without one (legacy pi-workflow record) cannot launch.
 */
export function recordedRunExecutorDescriptor(
	run: {
		runId: string;
		executor?: WorkflowRunExecutorSelection;
		roleExecution?: {
			executors?: Record<string, WorkflowRunExecutorSelection>;
		};
	},
	/** WP31: the task's executor in a mixed run (absent or the run's executor: `run.executor`). */
	executorId?: string,
): ExecutorDescriptor {
	const selection =
		executorId === undefined || executorId === run.executor?.id
			? run.executor
			: Object.hasOwn(run.roleExecution?.executors ?? {}, executorId)
				? run.roleExecution!.executors![executorId]
				: undefined;
	if (selection === undefined && executorId !== undefined && run.executor)
		throw new WorkflowExecutorUnavailableError(
			`workflow run ${run.runId} records no descriptor for the task executor "${executorId}"; it cannot launch the task (start a new run)`,
			executorId,
			"default",
		);
	if (selection === undefined)
		throw new WorkflowExecutorUnavailableError(
			`workflow run ${run.runId} records no executor; it cannot launch tasks (start a new run)`,
			"",
			"default",
		);
	const problems = validateExecutorDescriptor(selection.descriptor);
	if (problems.length > 0 || selection.descriptor.id !== selection.id)
		throw new WorkflowExecutorUnavailableError(
			`workflow run ${run.runId} records an invalid descriptor for executor "${selection.id}": ${problems.join("; ") || "id mismatch"}`,
			selection.id,
			selection.source,
		);
	return { ...selection.descriptor };
}
