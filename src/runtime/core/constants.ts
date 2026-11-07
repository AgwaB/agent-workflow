import type { DurableLaunchBarrierV2Descriptor } from "../durable-launch-barrier.js";

/**
 * Project-local default for run records and attempt artifacts (owner decision,
 * stage-1 plan WP2a). Callers may still pass an explicit `runsDir` inside cwd.
 */
export const DEFAULT_RUNS_DIR = ".agent-workflow/runs";

/**
 * Backend selection marker: `"auto"` leaves the choice to the caller's
 * resolver. Any other value is an executor id (`ExecutorDescriptor.id`).
 */
export const AUTO_BACKEND = "auto" as const;
export const STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export const FAILURE_KINDS = [
	"validation",
	"spawn",
	"timeout",
	"abort",
	"cancelled",
	"sandbox",
	"rpc",
	"model",
	"provider_error",
	"model_error",
	"output_schema_error",
	"guard_failure",
	"user_cancelled",
	"tool",
	"exit",
	"parse",
	"internal",
	"stale",
	// WP2a-2 executor seam (see docs/extending.md#architecture "Failure kinds").
	/** Executor `failed.class: "transient"`; the core may retry automatically. */
	"transient",
	/** Executor `failed.class: "rate_limit"`; the core may retry after backoff. */
	"rate_limit",
	/** Executor `failed.class: "auth"`: login/credentials. Never retried automatically. */
	"executor_auth",
	/** Executor `failed.class: "config"`: CLI/profile misconfiguration. Never retried automatically. */
	"executor_config",
	/** Executor `failed.class: "permanent"`. Never retried automatically. */
	"executor_permanent",
	/** Executor `failed.class: "unknown"`: the adapter could not classify the failure. Never retried automatically. */
	"executor_unknown",
	/** Reconcile: the executor proved the attempt never launched (`absent`). Safe to relaunch. */
	"not_started",
	/** Reconcile: the executor cannot prove either way (`unknown`, B3). Stop and ask a person. */
	"needs_decision",
	// WP2c.
	/** The engine revoked the launch authority (barrier revoke) before release; nothing ran. Status `cancelled`. */
	"revoked",
] as const;
export const EXECUTION_MODES = ["single", "parallel"] as const;
export const ASYNC_DEPENDENCIES = [
	"needed-before-final",
	"background",
	"unclassified",
] as const;
export const AGENT_SCOPES = ["auto", "global", "project"] as const;
export const WORKSPACE_MODES = ["shared", "worktree", "auto"] as const;
export const WORKTREE_POLICIES = ["auto", "required", "never"] as const;
export const ON_COMPLETE_ACTIONS = ["return", "notify", "detach"] as const;

/** Executor id, or `"auto"` when the resolver still has to choose. */
export type Backend = string;
/** Executor id that produced (or will produce) a run attempt. Never `"auto"`. */
export type ResolvedBackend = string;
export type Status = (typeof STATUSES)[number];

export function isTerminalStatus(status: Status): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * Failure kind for a run stopped by its AbortSignal. A plain abort (the caller
 * dropped the tool call) stays "abort"; an abort whose reason was tagged by
 * `userCancelledAbortReason` (an operator interrupt delivered to the durable
 * worker) is recorded as "user_cancelled" on every backend.
 */
export function abortFailureKind(
	signal: AbortSignal | undefined,
): "abort" | "user_cancelled" {
	const reason = signal?.reason as { failureKind?: unknown } | undefined;
	return reason?.failureKind === "user_cancelled" ? "user_cancelled" : "abort";
}

export function userCancelledAbortReason(
	message: string,
): Error & { failureKind: "user_cancelled" } {
	return Object.assign(new Error(message), {
		failureKind: "user_cancelled" as const,
	});
}

export function isFailureKind(value: unknown): value is FailureKind {
	return (
		typeof value === "string" &&
		(FAILURE_KINDS as readonly string[]).includes(value)
	);
}
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type AsyncDependency = (typeof ASYNC_DEPENDENCIES)[number];
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type OnCompleteAction = (typeof ON_COMPLETE_ACTIONS)[number];

export interface SandboxOptionsInput {
	/**
	 * Network domains the sandboxed child process may reach (e.g. "api.anthropic.com",
	 * "*.npmjs.org"). Omitted or empty means no network access (deny-all), matching
	 * `sandbox: true`. Enforcement is executor-specific.
	 */
	allowedDomains?: string[];
}

export type SandboxInput = true | SandboxOptionsInput;

export interface WorkspaceInput {
	mode?: WorkspaceMode;
	path?: string;
}

export interface ToolResultBudgetInput {
	/**
	 * Cumulative character budget across retained child tool results. When a
	 * new tool result would exceed it, the oldest retained results are evicted
	 * (replaced with short placeholders) until it fits; the newest result is
	 * never evicted. Invalid values are ignored with a recorded warning.
	 */
	maxTotalChars: number;
}

export interface SubagentTaskInput {
	agent?: string;
	task?: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	sandbox?: SandboxInput | false | null;
	visible?: boolean;
	cwd?: string;
	timeoutMs?: number;
	model?: string;
	sessionId?: string;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	/** Disable ambient extension discovery while retaining explicit extension paths. */
	noExtensions?: boolean;
	captureToolCalls?: boolean;
	/** Opt-in transcript hygiene for child tool results (executor-specific). */
	toolResultBudget?: ToolResultBudgetInput;
}

export interface ResolveInput {
	backend?: Backend;
	sandbox?: SandboxInput | false | null;
	visible?: boolean;
	agent?: string;
	task?: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	mode?: ExecutionMode;
	tasks?: SubagentTaskInput[];
	concurrency?: number;
	/** Stop scheduling additional parallel siblings after the first failed result. */
	failFast?: boolean;
	/** Abort already-running parallel siblings after the first failed result. Implies fail-fast scheduling. */
	cancelSiblingsOnFailure?: boolean;
	asyncDependency?: AsyncDependency;
	workspace?: WorkspaceInput | WorkspaceMode;
	worktree?: boolean | string;
	worktreePolicy?: WorktreePolicy;
	cwd?: string;
	async?: boolean;
	onComplete?: OnCompleteAction;
	timeoutMs?: number;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	/** Disable ambient extension discovery while retaining explicit extension paths. */
	noExtensions?: boolean;
	captureToolCalls?: boolean;
	/** Opt-in transcript hygiene for child tool results (executor-specific). */
	toolResultBudget?: ToolResultBudgetInput;
	runsDir?: string;
	correlationId?: string;
	/** Executor session id to attach a child run to when explicitly set by code API. */
	sessionId?: string;
	/** Session id of the parent that launched this run. Injected by the host, not a model-settable tool arg. */
	parentSessionId?: string;
	/** Optional general gate that pauses a durable worker before model/provider execution. */
	durableLaunchBarrier?: DurableLaunchBarrierV2Descriptor;
}

export interface ResolveSuccess {
	backend: ResolvedBackend;
	status: "completed";
}

export interface ResolveValidationFailure {
	backend?: ResolvedBackend;
	status: "failed";
	failureKind: "validation";
	error: string;
}

export type ResolveOutput = ResolveSuccess | ResolveValidationFailure;

function isOneOf<T extends string>(
	values: readonly T[],
	value: unknown,
): value is T {
	return (
		typeof value === "string" && (values as readonly string[]).includes(value)
	);
}

const BACKEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** `"auto"` or a non-empty executor id made of letters, digits, `.`, `_`, `:` or `-`. */
export function isBackend(value: unknown): value is Backend {
	return typeof value === "string" && BACKEND_ID_PATTERN.test(value);
}

/** An executor id (any backend value except `"auto"`). */
export function isResolvedBackend(value: unknown): value is ResolvedBackend {
	return isBackend(value) && value !== AUTO_BACKEND;
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
	return isOneOf(EXECUTION_MODES, value);
}

export function isAsyncDependency(value: unknown): value is AsyncDependency {
	return isOneOf(ASYNC_DEPENDENCIES, value);
}

export function isAgentScope(value: unknown): value is AgentScope {
	return isOneOf(AGENT_SCOPES, value);
}

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
	return isOneOf(WORKSPACE_MODES, value);
}

export function isWorktreePolicy(value: unknown): value is WorktreePolicy {
	return isOneOf(WORKTREE_POLICIES, value);
}

export function isOnCompleteAction(value: unknown): value is OnCompleteAction {
	return isOneOf(ON_COMPLETE_ACTIONS, value);
}
