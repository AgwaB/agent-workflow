/**
 * Permission mode (owner decision D2 revised, 2026-10-26; WP4e).
 *
 * - `free`: workers get no approval prompts or sandbox/readOnly restrictions, even when the stage
 *   declares `readOnly`. Approval requests are answered `allow` (audited `engine-policy:free`).
 *   Authored readOnly intent and B5 context isolation are unchanged.
 * - `safe`: the original D2 behavior — no bypass/auto-accept flags, policy-based approvals that fail
 *   closed, and (engine side) a worktree for every write-capable stage.
 *
 * The engine always sets `SubmitRequest.permissionMode` explicitly (engine default: `free`). A caller
 * that omits it gets `safe` (SDK default), so a third-party integration never becomes permissive by
 * accident. Adapter obligations per mode: docs/usage.md#permission-modes.
 */
export type PermissionMode = "free" | "safe";

export const PERMISSION_MODES: readonly PermissionMode[] = ["free", "safe"];

/** What an adapter assumes when `SubmitRequest.permissionMode` is absent. */
export const SDK_DEFAULT_PERMISSION_MODE: PermissionMode = "safe";

/** What the engine selects when no run flag or profile chooses a mode. */
export const ENGINE_DEFAULT_PERMISSION_MODE: PermissionMode = "free";

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "free" || value === "safe";
}

/** The mode an adapter must apply to a request (absent → `safe`). */
export function effectivePermissionMode(req: {
	readonly permissionMode?: PermissionMode;
}): PermissionMode {
	return isPermissionMode(req.permissionMode)
		? req.permissionMode
		: SDK_DEFAULT_PERMISSION_MODE;
}

/** True when the executor must enforce the stage's authored readOnly intent (safe only). */
export function enforcesReadOnly(req: {
	readonly permissionMode?: PermissionMode;
	readonly readOnly: boolean;
}): boolean {
	return req.readOnly && effectivePermissionMode(req) === "safe";
}

/** True in free mode, regardless of the stage's authored readOnly intent. */
export function isUnrestricted(req: {
	readonly permissionMode?: PermissionMode;
	readonly readOnly: boolean;
}): boolean {
	return effectivePermissionMode(req) === "free";
}
