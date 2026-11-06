/**
 * Engine-side answer policy for `approval_request` events (stage-1 plan §2.1 [R#4], owner decision D2).
 * `safe` mode (and any request without `permissionMode`): never auto-allows by default. readOnly
 * stages deny mutating kinds. Without an interactive host, anything not explicitly allowed is denied
 * (fail-closed), including on timeout. `free` mode: everything is allowed, without readOnly enforcement.
 */
import type { ApprovalRequestEvent, ToolKind } from "./events.js";
import { effectivePermissionMode, type PermissionMode } from "./permission.js";
import { checkReadOnlyShellCommand } from "./shell-readonly.js";
import { isMutatingKind } from "./tools.js";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalPolicy {
	/** Kinds answered `allow` without asking (from spec `approvalMode` + user run flags). Default: none. */
	readonly allowKinds: readonly ToolKind[];
	/** True only when an interactive host can show the request to a person. */
	readonly interactive: boolean;
	/** How long to wait for a person before answering `deny`. */
	readonly timeoutMs: number;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

export function defaultApprovalPolicy(
	overrides: Partial<ApprovalPolicy> = {},
): ApprovalPolicy {
	return {
		allowKinds: [],
		interactive: false,
		timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
		...overrides,
	};
}

/**
 * The kind a request is judged as. On a readOnly stage a shell execution whose command is a plain
 * read-only inspection command (`rg`, `ls`, `git diff`, ...) is a `search`, not an `execute`
 * (owner decision 2026-11-02; gajae-code's read-only bash profile). Everything else keeps its kind.
 */
export function effectiveApprovalKind(
	request: Pick<ApprovalRequestEvent, "kind" | "command">,
	stage: { readonly readOnly: boolean },
): ToolKind {
	if (
		stage.readOnly &&
		request.kind === "execute" &&
		typeof request.command === "string" &&
		checkReadOnlyShellCommand(request.command).ok
	)
		return "search";
	return request.kind;
}

/**
 * Decide how to answer an approval request.
 * - `deny`: (safe) readOnly stage + mutating kind, or not allowed and nobody to ask.
 * - `allow`: `free` mode, or kind is in `allowKinds` (and not blocked by readOnly).
 * - `ask`: (safe) interactive host must ask a person; on timeout the answer is `deny`.
 */
export function decideApproval(
	policy: ApprovalPolicy,
	request: Pick<ApprovalRequestEvent, "kind" | "command">,
	stage: {
		readonly readOnly: boolean;
		readonly permissionMode?: PermissionMode;
	},
): ApprovalDecision | "ask" {
	if (effectivePermissionMode(stage) === "free") return "allow";
	const kind = effectiveApprovalKind(request, stage);
	if (stage.readOnly && isMutatingKind(kind)) return "deny";
	if (policy.allowKinds.includes(kind)) return "allow";
	return policy.interactive ? "ask" : "deny";
}

/** Await a person's answer with fail-closed timeout. */
export async function awaitApprovalAnswer(
	answer: Promise<ApprovalDecision>,
	policy: Pick<ApprovalPolicy, "timeoutMs">,
): Promise<ApprovalDecision> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ApprovalDecision>((resolve) => {
		timer = setTimeout(() => resolve("deny"), Math.max(0, policy.timeoutMs));
	});
	try {
		return await Promise.race([
			answer.catch((): ApprovalDecision => "deny"),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
