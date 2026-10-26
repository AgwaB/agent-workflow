// New in agent-workflow (WP4e): permission mode resolution (owner decision "D2 개정 — 권한 모드",
// 2026-10-26). `free` (default) runs workers without approval prompts or sandbox restrictions
// except on stages the spec declares readOnly; `safe` keeps the original D2 behavior (no bypass,
// R#5 forced worktree for write-capable stages, fail-closed approvals, B4 coarse-tool refusal).
// Precedence follows B2: run flag > workflow-declared profile > saved user profile > default.
import {
	ENGINE_DEFAULT_PERMISSION_MODE,
	isPermissionMode,
	type PermissionMode,
} from "../sdk/permission.js";
import type {
	WorkflowRunPermissionMode,
	WorkflowRunPermissionModeSource,
	WorkflowRunRecord,
} from "./types.js";

export type { PermissionMode };

export interface RunPermissionModeInput {
	/** Run flag (`permissionMode` run option). */
	runFlag?: unknown;
	/** Name of the workflow-declared execution profile selected for the run. */
	workflowProfileName?: string;
	workflowProfileMode?: unknown;
	/** Name of the saved user profile captured for the run. */
	userProfileName?: string;
	userProfileMode?: unknown;
	/** Host default; ENGINE_DEFAULT_PERMISSION_MODE (`free`) when absent. */
	defaultMode?: unknown;
}

/**
 * B2 precedence for the permission mode. An invalid value from any source fails before launch
 * (naming the source); lower-precedence sources are never tried as a fallback for an invalid one.
 */
export function resolveRunPermissionMode(
	input: RunPermissionModeInput,
): WorkflowRunPermissionMode {
	const candidates: Array<{
		value: unknown;
		source: WorkflowRunPermissionModeSource;
		profile?: string;
		where: string;
	}> = [
		{ value: input.runFlag, source: "run-flag", where: "run flag" },
		{
			value: input.workflowProfileMode,
			source: "workflow-profile",
			...(input.workflowProfileName === undefined
				? {}
				: { profile: input.workflowProfileName }),
			where: `workflow execution profile "${input.workflowProfileName ?? ""}"`,
		},
		{
			value: input.userProfileMode,
			source: "user-profile",
			...(input.userProfileName === undefined
				? {}
				: { profile: input.userProfileName }),
			where: `saved user profile "${input.userProfileName ?? ""}"`,
		},
		{
			value: input.defaultMode ?? ENGINE_DEFAULT_PERMISSION_MODE,
			source: "default",
			where: "default",
		},
	];
	const selected = candidates.find(
		(candidate) => candidate.value !== undefined,
	);
	if (selected === undefined)
		return { mode: ENGINE_DEFAULT_PERMISSION_MODE, source: "default" };
	if (!isPermissionMode(selected.value))
		throw new Error(
			`permission mode ${JSON.stringify(selected.value)} from ${selected.where} is invalid; use "free" or "safe". The run was not started.`,
		);
	return {
		mode: selected.value,
		source: selected.source,
		...(selected.profile === undefined ? {} : { profile: selected.profile }),
	};
}

/**
 * Permission mode a workflow-declared execution profile selects (spec
 * `executionProfilePermissionModes`). Spec validation rejects other values; one that slipped past it
 * fails here, before launch.
 */
export function workflowDeclaredProfilePermissionMode(
	spec: unknown,
	profileName: string | undefined,
): PermissionMode | undefined {
	if (profileName === undefined) return undefined;
	const map = (
		spec as { executionProfilePermissionModes?: unknown } | undefined
	)?.executionProfilePermissionModes;
	if (map === null || typeof map !== "object" || Array.isArray(map))
		return undefined;
	const value = (map as Record<string, unknown>)[profileName];
	if (value === undefined || isPermissionMode(value)) return value;
	throw new Error(
		`workflow execution profile "${profileName}" permission mode ${JSON.stringify(value)} is invalid; use "free" or "safe". The run was not started.`,
	);
}

/**
 * Effective mode of a run record. Records created before WP4e carry none: they keep the behavior
 * they were created with (`safe`).
 */
export function workflowRunPermissionMode(
	run: Pick<WorkflowRunRecord, "permissionMode"> | undefined,
): PermissionMode {
	const mode = run?.permissionMode?.mode;
	return isPermissionMode(mode) ? mode : "safe";
}
