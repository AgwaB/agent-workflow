/**
 * Codex failure classification (plan §2.3). The app-server reports structured `codexErrorInfo`
 * on `error` notifications and failed turns (codex-cli 0.159.2 `CodexErrorInfo`); that wins. The
 * text table covers JSON-RPC errors, process failures and `other`. Rows marked `recorded` come
 * from real codex-cli 0.159.2 transcripts (test/fixtures/executors/codex/); the others follow the
 * protocol enum. Anything unmatched is `unknown` (never guessed transient, B3).
 */
import {
	classifyFailure,
	type ErrorClassificationRule,
	type FailureClass,
} from "../../sdk/errors.js";

/** `codexErrorInfo` string variants (or object variant keys) → class. */
export const CODEX_ERROR_INFO_CLASSES: Readonly<Record<string, FailureClass>> =
	{
		unauthorized: "auth",
		usageLimitExceeded: "rate_limit",
		rateLimitExceeded: "rate_limit",
		serverOverloaded: "transient",
		internalServerError: "transient",
		httpConnectionFailed: "transient",
		responseStreamConnectionFailed: "transient",
		responseStreamDisconnected: "transient",
		responseTooManyFailedAttempts: "transient",
		flexUnavailable: "transient",
		contextWindowExceeded: "permanent",
		sessionBudgetExceeded: "permanent",
		cyberPolicy: "permanent",
		misalignmentPolicyViolation: "permanent",
		tooManyDenials: "permanent",
		threadRollbackFailed: "permanent",
		sandboxError: "config",
		badRequest: "config",
		activeTurnNotSteerable: "permanent",
		// "other" falls through to the text table.
	};

/** Text rules (first match wins), case-insensitive substrings or regexes. */
export const CODEX_ERROR_RULES: readonly ErrorClassificationRule[] = [
	// recorded (live call #3): 400 invalid_request_error, code model_not_found, codexErrorInfo "other"
	{ class: "config", match: "model_not_found" },
	{
		class: "config",
		match:
			/model .*(?:not supported|does not exist|not found|is not available)/i,
	},
	{ class: "config", match: "unknown model" },
	{ class: "config", match: "invalid model" },
	// recorded (live call #4, empty CODEX_HOME): "401 Unauthorized: Missing bearer…" with
	// codexErrorInfo httpConnectionFailed{httpStatusCode: 401} — caught by the status check above.
	{ class: "auth", match: "not logged in" },
	{ class: "auth", match: /please (?:log|sign) ?in/i },
	{ class: "auth", match: "unauthorized" },
	{ class: "auth", match: /\b401\b/ },
	{ class: "auth", match: "token expired" },
	{ class: "auth", match: "refresh token" },
	{ class: "rate_limit", match: /\b429\b/ },
	{ class: "rate_limit", match: "rate limit" },
	{ class: "rate_limit", match: "usage limit" },
	{ class: "config", match: "failed to load configuration" },
	{ class: "config", match: "invalid transport" },
	{ class: "config", match: "is not supported for stdio" },
	{ class: "config", match: "codex cli not found" },
	{ class: "config", match: "enoent" },
	{ class: "config", match: "isolation guard" },
	{ class: "permanent", match: "context window" },
	{ class: "permanent", match: "context_length_exceeded" },
	{ class: "transient", match: /\b5\d\d\b/ },
	{ class: "transient", match: "connection reset" },
	{ class: "transient", match: "timed out" },
	{ class: "transient", match: "stream disconnected" },
	{ class: "transient", match: "econnreset" },
	{ class: "transient", match: "overloaded" },
];

function errorInfoKey(info: unknown): string | undefined {
	if (typeof info === "string") return info;
	if (info !== null && typeof info === "object") {
		const keys = Object.keys(info);
		return keys.length === 1 ? keys[0] : undefined;
	}
	return undefined;
}

function httpStatus(info: unknown): number | undefined {
	if (info === null || typeof info !== "object") return undefined;
	for (const value of Object.values(info)) {
		if (value !== null && typeof value === "object") {
			const status = (value as { httpStatusCode?: unknown }).httpStatusCode;
			if (typeof status === "number") return status;
		}
	}
	return undefined;
}

/** Classify a Codex failure from `codexErrorInfo` (structured) and/or message text. */
export function classifyCodexFailure(input: {
	readonly message: string;
	readonly codexErrorInfo?: unknown;
	readonly exitCode?: number | null;
}): FailureClass {
	const status = httpStatus(input.codexErrorInfo);
	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "auth";
	const key = errorInfoKey(input.codexErrorInfo);
	if (key !== undefined && key !== "other") {
		const mapped = CODEX_ERROR_INFO_CLASSES[key];
		if (mapped !== undefined) {
			// badRequest covers both invalid models and malformed requests: let the text decide
			// when it names something more specific.
			if (key === "badRequest") {
				const byText = classifyFailure(
					{ message: input.message, exitCode: input.exitCode ?? null },
					CODEX_ERROR_RULES,
				);
				return byText === "unknown" ? mapped : byText;
			}
			return mapped;
		}
	}
	return classifyFailure(
		{ message: input.message, exitCode: input.exitCode ?? null },
		CODEX_ERROR_RULES,
	);
}
