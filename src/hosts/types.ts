// New in agent-workflow (WP11a): shared contracts of the host API layer. Every host (the
// `agent-workflow` CLI, the stage-2 host MCP server, the Pi host) calls the same handlers and gets
// the same structured result plus a plain-text rendering.
import { relative } from "node:path";

import { assertWorkflowActionAllowedForRole } from "../core/process-role.js";
import { WorkflowValidationError } from "../core/types.js";
import type {
	WorkflowModelInfo,
	WorkflowRuntimeDefaults,
} from "../core/workflow-runtime.js";

export const MODULE = "src/hosts";

/** Host API contract version (bumped on breaking result/request changes). */
export const HOST_API_VERSION = "1";

/**
 * Upper bound of one `wait` call. MCP hosts have per-tool-call timeouts (Codex `tool_timeout_sec`
 * defaults to 60 s), so a single wait returns "still running + status" within 45 s and the host
 * calls again. The CLI loops over bounded waits.
 */
export const HOST_WAIT_MAX_TIMEOUT_MS = 45_000;
export const HOST_WAIT_MIN_TIMEOUT_MS = 1_000;

export type HostAction =
	| "help"
	| "list"
	| "validate"
	| "roles"
	| "agents"
	| "profile"
	| "run"
	| "dynamic"
	| "status"
	| "show"
	| "inspect"
	| "wait"
	| "resume"
	| "stop"
	| "prune"
	| "notices"
	| "supervise";

/**
 * `success`: a query/mutation completed. Run states: `running` (launched or still running after a
 * bounded wait), `completed`, `failed`, `blocked` (action required), `interrupted`. `refused`: a
 * launch was not started (capability refusal, unavailable executor, declined confirmation,
 * duplicate guard). `timeout`: supervise gave up at its deadline.
 */
export type HostOutcome =
	| "success"
	| "running"
	| "completed"
	| "failed"
	| "blocked"
	| "interrupted"
	| "refused"
	| "timeout";

export interface HostResult<T> {
	action: HostAction;
	/** True when a CLI would exit 0 (success, launched/running, terminal completed). */
	ok: boolean;
	outcome: HostOutcome;
	data: T;
	/** Plain-text rendering for humans (CLI stdout, MCP text content). */
	text: string;
}

/** Per-call host context. No Pi objects: hosts pass plain values. */
export interface HostApiContext {
	/** Project directory (run records live under `<cwd>/.agent-workflow/`). */
	cwd: string;
	/** Environment for role checks and the user home (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** Host default executor (lowest B2 precedence); engine default "pi" when absent. */
	defaultExecutor?: string;
	/** The host's current model/effort (Pi host); lowest-precedence runtime defaults. */
	runtimeDefaults?: WorkflowRuntimeDefaults;
	/**
	 * Model registry of the host. When present (Pi host) the per-workflow Pi profile preferences
	 * (`/workflow profile`) are consulted at launch; hosts without a registry (CLI, MCP) skip them.
	 */
	availableModels?: WorkflowModelInfo[];
	/**
	 * Identity of the calling host, for example "claude-code" or "codex" (the host MCP server's
	 * `--host`), "pi" or "cli". Additive (WP13): the handlers pass it through unchanged; the
	 * stage-2 default-executor rule (WP17) reads it.
	 */
	host?: string;
}

export function hostEnv(ctx: HostApiContext): NodeJS.ProcessEnv {
	return ctx.env ?? process.env;
}

export function assertActionAllowed(
	ctx: HostApiContext,
	action: HostAction | "board",
): void {
	assertWorkflowActionAllowedForRole(action, hostEnv(ctx));
}

export function result<T>(
	action: HostAction,
	outcome: HostOutcome,
	data: T,
	text: string,
): HostResult<T> {
	return {
		action,
		ok:
			outcome === "success" || outcome === "running" || outcome === "completed",
		outcome,
		data,
		text,
	};
}

/** Engine run status → host outcome. */
export function outcomeForRunStatus(status: string): HostOutcome {
	if (status === "running") return "running";
	if (status === "completed") return "completed";
	if (status === "blocked") return "blocked";
	if (status === "interrupted") return "interrupted";
	return "failed";
}

export function toDisplayPath(path: string, cwd: string): string {
	const display = relative(cwd, path);
	if (display === "") return path;
	return display.startsWith("..") ? path : display;
}

export function formatHostError(error: unknown): string {
	if (error instanceof WorkflowValidationError) {
		return `Workflow validation failed:\n${error.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
	}
	return error instanceof Error ? error.message : String(error);
}
