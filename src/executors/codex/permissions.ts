import type { CodexToolPlan } from "./tools.js";

const sandboxTypes = {
	"read-only": "readOnly",
	"workspace-write": "workspaceWrite",
	"danger-full-access": "dangerFullAccess",
} as const;
const profiles = {
	"read-only": ":read-only",
	"workspace-write": ":workspace",
	"danger-full-access": ":danger-full-access",
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** v2 sandbox is a tagged policy, not the kebab-case request mode. Profile provenance is optional. */
export function codexPermissionMismatch(
	requested: Pick<CodexToolPlan, "sandbox" | "approvalPolicy">,
	response: Record<string, unknown>,
): string | undefined {
	const sandbox = record(response.sandbox) ? response.sandbox.type : undefined;
	const profile = response.activePermissionProfile;
	const expectedProfile = profiles[requested.sandbox];
	if (
		sandbox === sandboxTypes[requested.sandbox] &&
		response.approvalPolicy === requested.approvalPolicy &&
		(profile === undefined ||
			profile === null ||
			(record(profile) &&
				profile.id === expectedProfile &&
				(profile.extends === undefined || profile.extends === null)))
	)
		return undefined;
	// Never dump arbitrary provider config into the message (it may contain unrelated secrets).
	const show = (value: unknown) =>
		typeof value === "string" ? value.slice(0, 200) : "missing/invalid";
	return `Codex effective permissions differ from the request: requested sandbox=${requested.sandbox}, approvalPolicy=${requested.approvalPolicy}, activePermissionProfile=${expectedProfile}; effective sandbox=${show(sandbox)}, approvalPolicy=${show(response.approvalPolicy)}, activePermissionProfile=${profile === undefined || profile === null ? "not reported" : record(profile) ? `${show(profile.id)} (extends=${profile.extends == null ? "none" : show(profile.extends)})` : "invalid"}. requirements.toml or managed configuration may have forced a fallback. Ask your administrator to permit the requested mode or select a compatible executor/profile; no turn was started.`;
}
