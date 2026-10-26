/**
 * Named SDK errors and adapter failure classification (stage-1 plan §2.3, design §3/§8.3).
 * Refusals are always named errors; capabilities are never silently dropped.
 */

/** Normalized failure classes. Adapters map CLI error text onto these. */
export const FAILURE_CLASSES = ["transient", "rate_limit", "auth", "config", "permanent", "unknown"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type SdkErrorCode =
	| "CAPABILITY_MISSING"
	| "CAPABILITY_UNVERIFIED"
	| "INVALID_CAPABILITIES"
	| "INVALID_EVENT"
	| "INVALID_EVENT_SEQUENCE"
	| "INVALID_REQUEST"
	| "AUTHORITY_REVOKED"
	| "AUTHORITY_ALREADY_CONSUMED"
	| "CONTRACT_VERSION_MISMATCH"
	| "DESCRIPTOR_INVALID"
	| "DESCRIPTOR_MODULE_NOT_FOUND"
	| "DESCRIPTOR_ID_MISMATCH"
	| "DESCRIPTOR_VERSION_MISMATCH"
	| "UNKNOWN_EXEC_REF";

export class SdkError extends Error {
	readonly code: SdkErrorCode;
	/** Optional qualifier, e.g. `toolAllowlist.fine` for `CAPABILITY_MISSING:toolAllowlist.fine`. */
	readonly subject: string | undefined;

	constructor(code: SdkErrorCode, message: string, options: { subject?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SdkError";
		this.code = code;
		this.subject = options.subject;
	}

	/** Stable identifier such as `CAPABILITY_MISSING:toolAllowlist.fine`. */
	get qualifiedCode(): string {
		return this.subject === undefined ? this.code : `${this.code}:${this.subject}`;
	}
}

export function isSdkError(value: unknown, code?: SdkErrorCode): value is SdkError {
	return value instanceof SdkError && (code === undefined || value.code === code);
}

/** One row of an adapter's "CLI error text → class" table. First matching rule wins. */
export interface ErrorClassificationRule {
	readonly class: FailureClass;
	/** Case-insensitive substring, or a RegExp tested against the message. */
	readonly match: string | RegExp;
	/** Optional exit code the rule is restricted to. */
	readonly exitCode?: number;
}

export interface ErrorClassificationInput {
	readonly message: string;
	readonly exitCode?: number | null;
}

/** Classify an adapter failure. Anything unmatched is `unknown` (never guessed as transient). */
export function classifyFailure(
	input: ErrorClassificationInput | string,
	rules: readonly ErrorClassificationRule[],
): FailureClass {
	const message = typeof input === "string" ? input : input.message;
	const exitCode = typeof input === "string" ? undefined : input.exitCode;
	const lower = message.toLowerCase();
	for (const rule of rules) {
		if (rule.exitCode !== undefined && rule.exitCode !== exitCode) continue;
		const hit = typeof rule.match === "string" ? lower.includes(rule.match.toLowerCase()) : rule.match.test(message);
		if (hit) return rule.class;
	}
	return "unknown";
}

/**
 * Whether the engine may retry automatically. `unknown` is never retried automatically (B3):
 * the run stops and a human decides.
 */
export function isAutoRetryable(failureClass: FailureClass): boolean {
	return failureClass === "transient" || failureClass === "rate_limit";
}
