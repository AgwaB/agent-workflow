/**
 * Engine-side answer policy for `approval_request` events (stage-1 plan §2.1 [R#4], owner decision D2).
 * Never auto-allows by default. readOnly stages deny mutating kinds. Without an interactive host,
 * anything not explicitly allowed is denied (fail-closed), including on timeout.
 */
import type { ApprovalRequestEvent, ToolKind } from "./events.js";
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
 * Decide how to answer an approval request.
 * - `deny`: readOnly stage + mutating kind, or not allowed and nobody to ask.
 * - `allow`: kind is in `allowKinds` (and not blocked by readOnly).
 * - `ask`: interactive host must ask a person; on timeout the answer is `deny`.
 */
export function decideApproval(
	policy: ApprovalPolicy,
	request: Pick<ApprovalRequestEvent, "kind">,
	stage: { readonly readOnly: boolean },
): ApprovalDecision | "ask" {
	if (stage.readOnly && isMutatingKind(request.kind)) return "deny";
	if (policy.allowKinds.includes(request.kind)) return "allow";
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
