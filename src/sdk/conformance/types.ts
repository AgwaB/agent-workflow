/**
 * Executor conformance kit types (stage-1 plan WP9a [R#11]; prior-art §3 #10).
 * A check is a named, documented assertion over a `WorkflowExecutor` driven through a
 * `ConformanceHarness`. Results are JSON-serializable so adapters can store them as evidence.
 */
import type { ExecutorDescriptor, ExecutorRegistry } from "../descriptor.js";
import type { SubmitRequest, WorkflowExecutor } from "../contract.js";
import type { JsonValue } from "../json.js";

/** Version of the check catalog. Bumped when checks are added or their meaning changes. */
export const CONFORMANCE_KIT_VERSION = "0.3.0";

/**
 * - `offline`: no model calls; runs against stubs/fakes (CI default).
 * - `live`: talks to a real CLI and may spend money; opt in per run.
 * - `runtime`: drives the real durable runtime (launch barrier, detached durable worker, control
 *   mailbox) through `harness.runtime(scenario)`; no model calls with an offline stage (WP2b).
 */
export const CONFORMANCE_TIERS = ["offline", "live", "runtime"] as const;
export type ConformanceTier = (typeof CONFORMANCE_TIERS)[number];

export const CONFORMANCE_AREAS = [
	"identity",
	"probe",
	"capabilities",
	"idempotency",
	"fencing",
	"events",
	"usage",
	"approval",
	"permission",
	"cancel",
	"reconcile",
	"errors",
	"mcp",
	"descriptor",
	"live",
	"runtime",
] as const;
export type ConformanceArea = (typeof CONFORMANCE_AREAS)[number];

/**
 * Behaviours a harness can stage. Each check names the scenarios it needs; a check whose scenario the
 * harness does not support is skipped (never silently passed). See docs/conformance.md for contracts.
 */
export const CONFORMANCE_SCENARIOS = [
	/** started → message_delta(s) → usage → completed. */
	"complete",
	/** Like `complete`, but the CLI reports no cost: usage must carry `cost: null, source: "unknown"`. */
	"usage_unknown",
	/** started, then output for several seconds so cancel can interleave. */
	"slow",
	/** started → approval_request(kind: execute) → allow: completed / deny: no completed execute tool. */
	"approval",
	/** Fault: the adapter consumes authority, then crashes before launch evidence is recorded. */
	"crash_after_consume",
	/** The agent calls tool `echo` on MCP server `conformance` with the prompt's nonce and reports it. */
	"mcp_tool",
	"fail_transient",
	"fail_rate_limit",
	"fail_auth",
	"fail_config",
	"fail_permanent",
	/** CLI error text the adapter's table does not recognise: class must be `unknown`. */
	"fail_unknown",
] as const;
export type ConformanceScenario = (typeof CONFORMANCE_SCENARIOS)[number];

/** One process launch observed by a process-spawning harness (e.g. stub CLI invocation log). */
export interface LaunchRecord {
	readonly argv: readonly string[];
	readonly envKeys: readonly string[];
	readonly cwd?: string;
	/** stdin lines the launch received, when recorded (settings sent over a stdio protocol). */
	readonly stdin?: readonly string[];
}

/**
 * Documented launch settings per permission mode (WP4e, `permission.mode_mapping`). Each entry is a
 * substring of the launch invocation text: argv joined by newlines, then stdin lines (e.g.
 * `"--permission-mode\nbypassPermissions"` or `"\"approvalPolicy\":\"never\""`). The check submits
 * `tools: ["read", "bash"]` in `free`, `safe`, and `free` + `readOnly`.
 */
export interface PermissionModeSettings {
	/** Settings a `free`, non-readOnly launch must carry. */
	readonly free: readonly string[];
	/** Settings a `safe`, non-readOnly launch must carry. */
	readonly safe: readonly string[];
	/** Settings a `free` + `readOnly` launch must carry (it must carry no free-only setting). */
	readonly readOnly?: readonly string[];
	/**
	 * Documented reason when the adapter maps both modes to the same settings (e.g. a CLI with no
	 * approval prompts and no sandbox). Required when `free` and `safe` list the same settings.
	 */
	readonly equivalent?: string;
}

/** One executor instance (plus its observable side effects) for one check. */
export interface HarnessSession {
	readonly executor: WorkflowExecutor;
	/**
	 * Effects observed so far (process spawns, `turn/start` sends, …). With `attemptKey`, only that
	 * attempt's effects; without, all effects of this session. Must not count probes.
	 */
	effectCount(attemptKey?: string): Promise<number>;
	/** argv/env of launches for the attempt. Omit when the adapter spawns no process. */
	launches?(attemptKey: string): Promise<readonly LaunchRecord[]>;
	/** Simulate a process restart: a new executor instance sharing durable state. */
	restart?(): Promise<WorkflowExecutor>;
	dispose?(): Promise<void>;
}

/**
 * Runtime tier (WP2b): an executor the durable runtime can reload in a fresh process. The runtime
 * checks launch real detached durable workers with `descriptor`, so the descriptor must be loadable
 * by `loadExecutor` in another process (absolute module path or package specifier, JSON config, no
 * secrets) and effects must be observable across processes (file-backed, e.g. the stub CLI
 * invocation log).
 */
export interface RuntimeStage {
	readonly descriptor: ExecutorDescriptor;
	/** Effects for the attempt (or all) seen by any process; probes are not effects. */
	effectCount(attemptKey?: string): Promise<number>;
	/** Extra runtime run input (model, effort, env, mcpServers, tools, …) merged into the run. */
	readonly runInput?: Readonly<Record<string, JsonValue>>;
	dispose?(): Promise<void>;
}

export interface ConformanceHarness {
	readonly name: string;
	readonly scenarios: readonly ConformanceScenario[];
	/** Open a fresh session staged for one scenario. */
	open(scenario: ConformanceScenario): Promise<HarnessSession>;
	/** Adjust the kit-built request (model, env, …). Must keep attemptKey/authority as given. */
	request?(base: SubmitRequest, scenario: ConformanceScenario): SubmitRequest;
	/** Descriptor (and optional in-process registry) for the rediscovery check (R#15). */
	descriptor?(): Promise<{
		readonly descriptor: ExecutorDescriptor;
		readonly registry?: ExecutorRegistry;
	}>;
	/** True when sessions drive a real CLI/model; required for the `live` tier. */
	readonly live?: boolean;
	/** Documented launch settings per permission mode (`permission.mode_mapping`, WP4e). */
	readonly permissionModes?: PermissionModeSettings;
	/**
	 * Stage `scenario` for the runtime tier (WP2b). `workDir` is a fresh directory owned by the
	 * check. Omit when the adapter cannot be reloaded in a fresh process: runtime checks then skip.
	 */
	runtime?(
		scenario: ConformanceScenario,
		options: { readonly workDir: string },
	): Promise<RuntimeStage>;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface ConformanceTimeouts {
	/** Single contract call (probe, submit, cancel, reconcile, respond). */
	readonly callMs: number;
	/** Draining an event stream to its terminal event (offline). */
	readonly streamMs: number;
	/** Draining an event stream in the live tier. */
	readonly liveStreamMs: number;
	/** Whole check. */
	readonly checkMs: number;
}

export const DEFAULT_CONFORMANCE_TIMEOUTS: ConformanceTimeouts = {
	callMs: 5_000,
	streamMs: 15_000,
	liveStreamMs: 300_000,
	checkMs: 60_000,
};

export interface CheckOutcome {
	readonly status: CheckStatus;
	readonly violations: readonly string[];
	readonly reason?: string;
	readonly details?: JsonValue;
}

/** Static description of a check (JSON-serializable). */
export interface ConformanceCheckInfo {
	readonly id: string;
	readonly tier: ConformanceTier;
	readonly area: ConformanceArea;
	readonly title: string;
	/** Plan/design references (R#1, B3, …). */
	readonly refs: readonly string[];
	/** Scenarios the check opens (any unsupported ⇒ skip unless the check falls back). */
	readonly scenarios: readonly ConformanceScenario[];
	/** Set on placeholders: why the check cannot run yet. */
	readonly pending?: string;
}

export interface CheckResult extends ConformanceCheckInfo {
	readonly status: CheckStatus;
	readonly durationMs: number;
	readonly violations: readonly string[];
	readonly reason?: string;
	readonly details?: JsonValue;
}

export interface ConformanceSummary {
	readonly total: number;
	readonly pass: number;
	readonly fail: number;
	readonly skip: number;
}

/** JSON-serializable report of one `runConformance` call. */
export interface ConformanceReport {
	readonly kitVersion: string;
	readonly contractVersion: string;
	readonly harness: string;
	readonly executor: {
		readonly id: string;
		readonly version: string;
		readonly contractVersion: string;
	} | null;
	readonly tiers: readonly ConformanceTier[];
	readonly startedAt: string;
	readonly durationMs: number;
	/** True when no check failed (skips do not fail a run; inspect them). */
	readonly ok: boolean;
	readonly summary: ConformanceSummary;
	readonly results: readonly CheckResult[];
}
