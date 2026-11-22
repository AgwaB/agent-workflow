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
	/** Actionable text appended to the failure message; `$1` is the first capture group of `match`. */
	readonly hint?: string;
}

export const PI_ERROR_RULES: readonly PiErrorRule[] = [
	// Context overflow is permanent for the same request.
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
	// A model whose provider api comes from a Pi extension (models.json custom `api`): workflow workers run
	// with --no-extensions, so the api is never registered (live, run workflow_mwoulqyw_05a7a5 task-2).
	{
		class: "config",
		match: /No API provider registered for api: ([^\s'"`,;]+)/,
		evidence: "live",
		hint: 'the model\'s provider api "$1" is registered by a Pi extension, and workflow stages run without user extensions. List that extension in AGENT_WORKFLOW_PI_EXTENSIONS (comma-separated paths or npm: sources) or pick a model whose provider is built into Pi. See docs/executors.md (Pi → Isolation).',
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
	// Provider "model is busy": status token then ':' and a JSON body with a string code (live, 2026-11-16).
	{
		class: "transient",
		match:
			/^\s*5\d\d\s*:|"code"\s*:\s*"(?:upstream_busy|overloaded|server_error)"/i,
		evidence: "live",
	},
	// Provider stream broke after tokens were sent: assistant stopReason "error" with this message (live,
	// DeepSeek via OpenAI-compatible proxy, 2026-11-17 runs workflow_mwk50eau_532ced and workflow_mwkp9dv3_a851e6).
	{ class: "transient", match: /model failed mid-stream/i, evidence: "live" },
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

/** The failure message with the matching rule's actionable hint appended (unchanged when none applies). */
export function withPiFailureHint(message: string): string {
	for (const rule of PI_ERROR_RULES) {
		if (rule.hint === undefined || !(rule.match instanceof RegExp)) continue;
		const m = rule.match.exec(message);
		if (m === null) continue;
		return `${message}\nHint: ${rule.hint.replace("$1", m[1] ?? "")}`;
	}
	return message;
}
