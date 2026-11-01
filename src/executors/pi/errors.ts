// New in agent-workflow (WP6): Pi CLI error text → normalized failure class. Rows marked "live"
// were taken from real Pi 1.1.0 transcripts (test/fixtures/executors/pi/); the others are Pi 1.1.0
// messages read from its source/docs and have no live transcript yet. First match wins; anything
// unmatched is `unknown` (never guessed as transient, B3).
import {
	classifyFailure,
	type ErrorClassificationRule,
	type FailureClass,
} from "../../sdk/errors.js";

export interface PiErrorRule extends ErrorClassificationRule {
	/** Where the row comes from: a recorded transcript, or Pi source/docs only. */
	readonly evidence: "live" | "offline" | "source";
}

export const PI_ERROR_RULES: readonly PiErrorRule[] = [
	// Context overflow is permanent for the same request (pi-subagent CONTEXT_LENGTH_ERROR_PATTERN).
	{
		class: "permanent",
		match:
			/\bcontext[_ -]?length[_ -]?exceeded\b|\bcontext[_ -]?window[_ -]?(?:exceeded|overflow|exhausted)\b|\b(?:maximum|max)[_ -]?context[_ -]?length\b|\btoo many tokens\b/i,
		evidence: "source",
	},
	// `pi --model <unknown>` exits 1 before any request (offline transcript).
	{ class: "config", match: /Model ".*" not found/, evidence: "offline" },
	// A bare model id that several authenticated providers offer (Pi 1.x).
	{
		class: "config",
		match: /Model ".*" is ambiguous across providers/,
		evidence: "live",
	},
	{ class: "config", match: "Unknown option", evidence: "source" },
	{ class: "config", match: "Invalid thinking level", evidence: "source" },
	// WP35: the fast-tier guard aborted a request whose model/payload left the launch binding.
	{
		class: "config",
		match: /workflow fast mode .*binding mismatch|fast tier failed/,
		evidence: "offline",
	},
	// Missing credentials for a provider: exits 1 before any request (offline transcript).
	{ class: "auth", match: "No API key found for", evidence: "offline" },
	// Provider rejected the credential: assistant stopReason "error", exit 0 (live transcript).
	{ class: "auth", match: /\((?:401|403)\)/, evidence: "live" },
	{ class: "auth", match: "invalid_api_key", evidence: "live" },
	{ class: "auth", match: /oauth.*(?:expired|refresh)/i, evidence: "source" },
	// Provider 404 for an unknown model id passed through as a custom id.
	{ class: "config", match: /\(404\)/, evidence: "source" },
	{
		class: "config",
		match: /model_not_found|does not exist/i,
		evidence: "source",
	},
	// Google free-tier daily quota: HTTP 429 RESOURCE_EXHAUSTED inside the error JSON (live transcript).
	{
		class: "rate_limit",
		match: /"code"\s*:\s*429\b|RESOURCE_EXHAUSTED/,
		evidence: "live",
	},
	{ class: "rate_limit", match: /\(429\)/, evidence: "source" },
	{
		class: "rate_limit",
		match: /rate[_ -]?limit|quota|usage limit/i,
		evidence: "source",
	},
	// Google returned HTTP 500 "Internal error encountered." mid-run (live transcript, stopReason error).
	{
		class: "transient",
		match:
			/"code"\s*:\s*5\d\d\b|Internal Server Error|Internal error encountered/,
		evidence: "live",
	},
	{
		class: "transient",
		match: /\((?:500|502|503|504|529)\)/,
		evidence: "source",
	},
	{
		class: "transient",
		match:
			/overloaded|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|terminated/i,
		evidence: "source",
	},
];

export function classifyPiFailure(
	message: string,
	exitCode: number | null,
): FailureClass {
	return classifyFailure({ message, exitCode }, PI_ERROR_RULES);
}
