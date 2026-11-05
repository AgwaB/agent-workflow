/**
 * Permission mode (owner decision D2 revised, 2026-10-26; WP4e).
 *
 * - `free`: workers get no approval prompts and no sandbox restrictions, except on stages the spec
 *   declares `readOnly` (those stay read-only in both modes). Approval requests that still arrive are
 *   answered `allow` by engine policy (audited `engine-policy:free`); mutating kinds on a readOnly
 *   stage are still denied. B5 context isolation is unchanged.
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

/**
 * True when the request runs unrestricted: `free` mode on a stage that is not readOnly. Adapters use
 * this to choose their bypass settings; a readOnly request gets the same settings in both modes.
 */
export function isUnrestricted(req: {
	readonly permissionMode?: PermissionMode;
	readonly readOnly: boolean;
}): boolean {
	return effectivePermissionMode(req) === "free" && !req.readOnly;
}
