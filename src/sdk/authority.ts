/**
 * Effect-boundary fencing (stage-1 plan §2.1 [R#1], design §8.6, owner decision B3).
 *
 * The engine issues a one-time `ExecutionAuthority` per attempt. An adapter MUST call
 * `authority.consume()` immediately before its first side effect (spawning a process, sending
 * `turn/start`, …) and may only proceed when the decision is `released`. A `revoked` decision means
 * "exit without any effect". Release and revoke are a single, final decision: once one wins, the
 * other can no longer happen. The durable implementation lives in `runtime/` (launch barrier); this
 * module defines the contract plus an in-memory reference gate.
 */
import { SdkError } from "./errors.js";

export interface AuthorityReleased {
	readonly kind: "released";
	readonly attemptKey: string;
	/** Opaque engine-issued identifier for this grant (e.g. barrier decision digest). */
	readonly grantId: string;
}
export interface AuthorityRevoked {
	readonly kind: "revoked";
	readonly attemptKey: string;
	readonly reason: string;
}
export type AuthorityDecision = AuthorityReleased | AuthorityRevoked;

export interface ExecutionAuthority {
	readonly attemptKey: string;
	/**
	 * Durably consume the grant. Resolves `released` at most once per attempt; a second consume
	 * rejects with `AUTHORITY_ALREADY_CONSUMED` (this is what blocks duplicate effects across
	 * resume rounds). Resolves `revoked` (repeatably) when the engine revoked before consumption.
	 */
	consume(): Promise<AuthorityDecision>;
}

/** Adapter helper: throw `AUTHORITY_REVOKED` unless the decision is `released`. */
export function requireReleased(decision: AuthorityDecision): AuthorityReleased {
	if (decision.kind === "released") return decision;
	throw new SdkError("AUTHORITY_REVOKED", `execution authority for ${decision.attemptKey} was revoked: ${decision.reason}`, {
		subject: decision.attemptKey,
	});
}

export type AuthorityGateState = "pending" | "released" | "revoked";

export type AuthorityTraceEntry =
	| { readonly type: "consume"; readonly attemptKey: string; readonly outcome: "released" | "revoked" | "rejected" }
	| { readonly type: "revoke"; readonly attemptKey: string; readonly outcome: "revoked" | "too_late" };

/** Engine-side handle for one attempt's authority. */
export interface AuthorityGate {
	readonly authority: ExecutionAuthority;
	/**
	 * Revoke before consumption (stop, lease loss). Returns `too_late` when the adapter already
	 * consumed the grant — the engine must then cancel and reconcile instead of assuming no effect.
	 */
	revoke(reason: string): "revoked" | "too_late";
	state(): AuthorityGateState;
}

let grantCounter = 0;

/**
 * In-memory reference gate. Single decision, one-time consume. Optional `onTrace` lets
 * conformance checks verify that effects happened only after a released consume.
 */
export function createAuthorityGate(options: {
	attemptKey: string;
	grantId?: string;
	onTrace?: (entry: AuthorityTraceEntry) => void;
}): AuthorityGate {
	const { attemptKey, onTrace } = options;
	if (typeof attemptKey !== "string" || attemptKey === "")
		throw new SdkError("INVALID_REQUEST", "authority gate requires a non-empty attemptKey");
	let current: AuthorityGateState = "pending";
	let revokeReason = "";
	grantCounter += 1;
	const grantId = options.grantId ?? `grant-${grantCounter}`;
	const authority: ExecutionAuthority = {
		attemptKey,
		async consume() {
			if (current === "revoked") {
				onTrace?.({ type: "consume", attemptKey, outcome: "revoked" });
				return { kind: "revoked", attemptKey, reason: revokeReason };
			}
			if (current === "released") {
				onTrace?.({ type: "consume", attemptKey, outcome: "rejected" });
				throw new SdkError("AUTHORITY_ALREADY_CONSUMED", `execution authority for ${attemptKey} was already consumed`, {
					subject: attemptKey,
				});
			}
			current = "released";
			onTrace?.({ type: "consume", attemptKey, outcome: "released" });
			return { kind: "released", attemptKey, grantId };
		},
	};
	return {
		authority,
		revoke(reason) {
			if (current === "released") {
				onTrace?.({ type: "revoke", attemptKey, outcome: "too_late" });
				return "too_late";
			}
			if (current === "pending") revokeReason = reason;
			current = "revoked";
			onTrace?.({ type: "revoke", attemptKey, outcome: "revoked" });
			return "revoked";
		},
		state: () => current,
	};
}
