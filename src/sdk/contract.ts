/**
 * Executor contract v0 (stage-1 plan §2.1, design §3/§8.6, owner decisions B1/B3/B5/D1–D3).
 * Semantics follow gajae-code's session CLI (idempotency keys, reconcile, `unknown` ≠ not run,
 * wait-timeout ≠ cancel) and gjc/vibe-kanban cancel scopes/results.
 */
import { isAbsolute } from "node:path";
import type { ApprovalDecision, ApprovalPolicy } from "./approval.js";
import type { ExecutionAuthority } from "./authority.js";
import type { ExecutorCapabilities } from "./capabilities.js";
import { SdkError } from "./errors.js";
import type { ExecEvent } from "./events.js";

/**
 * Contract version. Compatibility: for 0.x, same major+minor; from 1.0, same major (semver).
 * The SDK promises compatibility at 1.0 (F4).
 */
export const EXECUTOR_CONTRACT_VERSION = "0.1.0";

/** Opaque, JSON-serializable reference to one attempt's execution. Stored in run records. */
export interface ExecRef {
	readonly executorId: string;
	readonly attemptKey: string;
	/** Adapter-specific handle (pid file, thread id, …). */
	readonly handle: string;
	readonly sessionId?: string;
}

/** stdio MCP server to inject (e.g. the engine's `workflow_artifact` server). */
export interface McpServerSpec {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/**
	 * Environment for the server process. Secrets go here or into a permission-restricted temp
	 * file — adapters must never place secret values on argv (prior-art §3 #8).
	 */
	readonly env?: Readonly<Record<string, string>>;
}

/** B5: workers do not read the user's AGENTS.md/CLAUDE.md/skills/hooks/personal MCP unless `inherit`. */
export interface IsolationPolicy {
	readonly inherit: boolean;
}

export interface SubmitRequest {
	/** Engine-issued idempotency key (B3). Same key ⇒ same ExecRef, never a second effect. */
	readonly attemptKey: string;
	/** One-time effect-boundary authority; consume immediately before the first effect (R#1). */
	readonly authority: ExecutionAuthority;
	readonly cwd: string;
	readonly prompt: string;
	readonly systemPrompt?: string;
	readonly model?: string;
	readonly effort?: string;
	/** Pi tool names; the adapter maps them (see tools.ts). */
	readonly tools: readonly string[];
	readonly readOnly: boolean;
	readonly mcpServers: readonly McpServerSpec[];
	/** Keep the worker CLI session under this id (D3: only when same-session repair is needed). */
	readonly sessionId?: string;
	readonly resumeSessionId?: string;
	/** Absolute epoch-ms deadline. Waiting past it is not a cancellation. */
	readonly deadlineMs: number;
	readonly env: Readonly<Record<string, string>>;
	readonly isolation: IsolationPolicy;
	readonly approvalPolicy: ApprovalPolicy;
	/**
	 * Absolute attempt artifact directory owned by the runtime. Adapters may write raw CLI logs
	 * here (D3: normalized events are a view over raw output). Absent for callers without a run
	 * directory; adapters must not assume it exists.
	 */
	readonly artifactsDir?: string;
}

export type AuthStatus = "ok" | "missing" | "expired" | "unknown";

/** Readiness check result. Default probes make no model calls (D1: auth is owned by each CLI). */
export interface ExecutorProbe {
	readonly installed: boolean;
	readonly cliVersion: string | null;
	readonly auth: AuthStatus;
	/** Capability rows confirmed by this probe; merged with `source: "probed"`. */
	readonly capabilities?: Partial<ExecutorCapabilities>;
	/** Max characters the CLI delivers from one MCP tool result, if known (R#9). */
	readonly mcpOutputLimitChars?: number | null;
	readonly notes?: readonly string[];
}

export type CancelScope = "turn" | "owned";

/** An ACK is never evidence of termination; observe/reconcile decide that. */
export type CancelResult =
	| "cancelled"
	| "too_late"
	| "unsupported"
	| "uncertain"
	| "no_active";
export const CANCEL_RESULTS: readonly CancelResult[] = [
	"cancelled",
	"too_late",
	"unsupported",
	"uncertain",
	"no_active",
];

/**
 * `absent` = proven never launched. `unknown` = cannot prove either way: the engine must NOT retry
 * automatically; it stops and asks a person (B3).
 */
export type ReconcileResult =
	| { readonly found: ExecRef }
	| { readonly absent: true }
	| { readonly unknown: true; readonly reason?: string };

export type ApprovalResponseResult =
	| "accepted"
	| "unknown_request"
	| "too_late";

export interface WorkflowExecutor {
	/** "pi" | "codex" | "claude" | external id. */
	readonly id: string;
	/** Adapter version (semver). */
	readonly version: string;
	/** Contract version the adapter implements. */
	readonly contractVersion: string;
	probe(): Promise<ExecutorProbe>;
	capabilities(): ExecutorCapabilities;
	submit(req: SubmitRequest): Promise<ExecRef>;
	observe(ref: ExecRef): AsyncIterable<ExecEvent>;
	cancel(ref: ExecRef, scope: CancelScope): Promise<CancelResult>;
	reconcile(attemptKey: string): Promise<ReconcileResult>;
	/** Answer an `approval_request` (R#4). */
	respond(
		ref: ExecRef,
		requestId: string,
		decision: ApprovalDecision,
	): Promise<ApprovalResponseResult>;
}

function parseVersion(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
	return match === null
		? null
		: [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Semver-ish compatibility: same major (from 1.0) or same major+minor (0.x). */
export function isVersionCompatible(expected: string, actual: string): boolean {
	const a = parseVersion(expected);
	const b = parseVersion(actual);
	if (a === null || b === null) return false;
	if (a[0] !== b[0]) return false;
	return a[0] === 0 ? a[1] === b[1] : true;
}

export function isContractCompatible(version: string): boolean {
	return isVersionCompatible(EXECUTOR_CONTRACT_VERSION, version);
}

export function isReconcileUnknown(
	result: ReconcileResult,
): result is { unknown: true; reason?: string } {
	return "unknown" in result && result.unknown === true;
}

const EXECUTOR_METHODS = [
	"probe",
	"capabilities",
	"submit",
	"observe",
	"cancel",
	"reconcile",
	"respond",
] as const;

/** Structural check of an executor object (does not call it). */
export function assertWorkflowExecutor(
	value: unknown,
): asserts value is WorkflowExecutor {
	const problems: string[] = [];
	if (value === null || typeof value !== "object") {
		problems.push("executor must be an object");
	} else {
		const record = value as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id === "")
			problems.push("id must be a non-empty string");
		if (
			typeof record.version !== "string" ||
			parseVersion(record.version) === null
		)
			problems.push("version must be semver");
		if (
			typeof record.contractVersion !== "string" ||
			!isContractCompatible(record.contractVersion)
		)
			problems.push(
				`contractVersion must be compatible with ${EXECUTOR_CONTRACT_VERSION}`,
			);
		for (const method of EXECUTOR_METHODS)
			if (typeof record[method] !== "function")
				problems.push(`${method} must be a function`);
	}
	if (problems.length > 0) {
		const contract = problems.some((problem) =>
			problem.startsWith("contractVersion"),
		);
		throw new SdkError(
			contract ? "CONTRACT_VERSION_MISMATCH" : "DESCRIPTOR_INVALID",
			`invalid executor: ${problems.join("; ")}`,
		);
	}
}

/** Validate the engine-built request shape before handing it to an adapter. */
export function validateSubmitRequest(req: SubmitRequest): string[] {
	const problems: string[] = [];
	if (typeof req.attemptKey !== "string" || req.attemptKey === "")
		problems.push("attemptKey must be a non-empty string");
	if (
		req.authority === undefined ||
		typeof req.authority.consume !== "function"
	)
		problems.push("authority is required");
	else if (req.authority.attemptKey !== req.attemptKey)
		problems.push("authority.attemptKey must equal attemptKey");
	if (typeof req.cwd !== "string" || req.cwd === "")
		problems.push("cwd must be explicit (desktop hosts may lack one)");
	if (
		req.artifactsDir !== undefined &&
		(typeof req.artifactsDir !== "string" || !isAbsolute(req.artifactsDir))
	)
		problems.push("artifactsDir must be an absolute path when provided");
	if (!Array.isArray(req.tools)) problems.push("tools must be an array");
	if (!Number.isFinite(req.deadlineMs))
		problems.push("deadlineMs must be a finite number");
	for (const server of req.mcpServers ?? [])
		for (const arg of server.args)
			for (const [key, secret] of Object.entries(server.env ?? {}))
				if (secret.length >= 8 && arg.includes(secret))
					problems.push(`mcp server ${server.name} leaks env ${key} on argv`);
	return problems;
}
