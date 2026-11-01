// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/experimental-speed-flags.ts. MIT, same author. Changes: env PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP→AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP, PI_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH→AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH, PI_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP→AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP, PI_WORKFLOW_CACHE_SHAPE_METRICS→AGENT_WORKFLOW_CACHE_SHAPE_METRICS, PI_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER→AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER, PI_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR→AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR, PI_WORKFLOW_PER_ITEM_DISPATCH→AGENT_WORKFLOW_PER_ITEM_DISPATCH.
export const EXPERIMENTAL_TOOL_DEDUP_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP";
export const EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH";
export const EXPERIMENTAL_LAUNCH_RAMP_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP";
export const CACHE_SHAPE_METRICS_ENV = "AGENT_WORKFLOW_CACHE_SHAPE_METRICS";
export const EXPERIMENTAL_DEPTH_ROUTER_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER";
export const EXPERIMENTAL_SAME_SESSION_REPAIR_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR";
export const PER_ITEM_DISPATCH_ENV = "AGENT_WORKFLOW_PER_ITEM_DISPATCH";

const ACTIVE_EXPERIMENTAL_SPEED_FLAGS = [
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	PER_ITEM_DISPATCH_ENV,
] as const;

const TRUE_PATTERN = /^(1|true|yes|on)$/i;

export function workflowExperimentalFlagEnabled(
	name: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return TRUE_PATTERN.test(env[name]?.trim() ?? "");
}

/**
 * agent-workflow 2026-11-01: flags that change what a run does are decided at launch and recorded
 * as `run.experimentalFlags`, so a run behaves the same whichever process drives it later (live
 * finding: the waiting CLI took over supervision without the launch environment). Launch ramp and
 * adaptive live workers stay process-level: they pace one process's launches across runs.
 */
export const RUN_SCOPED_EXPERIMENTAL_FLAGS = [
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	PER_ITEM_DISPATCH_ENV,
] as const;

/** The run-scoped flags enabled in a launch environment (recorded on the new run). */
export function runScopedExperimentalFlagsAtLaunch(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return RUN_SCOPED_EXPERIMENTAL_FLAGS.filter((name) =>
		workflowExperimentalFlagEnabled(name, env),
	);
}

/**
 * A run-scoped flag for this run: its recorded launch decision; runs created before flags were
 * recorded fall back to the current environment (the old behavior).
 */
export function runExperimentalFlagEnabled(
	run: { readonly experimentalFlags?: readonly string[] } | undefined,
	name: (typeof RUN_SCOPED_EXPERIMENTAL_FLAGS)[number],
	env: Record<string, string | undefined> = process.env,
): boolean {
	return Array.isArray(run?.experimentalFlags)
		? run.experimentalFlags.includes(name)
		: workflowExperimentalFlagEnabled(name, env);
}

export function enabledWorkflowExperimentalSpeedFlags(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return ACTIVE_EXPERIMENTAL_SPEED_FLAGS.filter((name) =>
		workflowExperimentalFlagEnabled(name, env),
	);
}
