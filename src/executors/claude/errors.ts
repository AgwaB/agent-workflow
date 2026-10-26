/**
 * Claude Code error text → failure class (plan §2.3). Rows marked `live` come from recorded
 * transcripts (test/fixtures/executors/claude/transcripts); the others are documented Claude Code /
 * Anthropic API error shapes that could not be reproduced safely within the WP8 budget.
 * The classifier input is built by `claudeFailureText` from the `result` event (result text,
 * `api_error_status`, `terminal_reason`, `errors`) plus stderr, so rules can match any of them.
 */
import {
	classifyFailure,
	type ErrorClassificationRule,
	type FailureClass,
} from "../../sdk/errors.js";

export const CLAUDE_ERROR_RULES: readonly ErrorClassificationRule[] = [
	// auth (live: `--bare` without an API key → "Not logged in · Please run /login")
	{ class: "auth", match: "not logged in" },
	{ class: "auth", match: "please run /login" },
	{ class: "auth", match: "invalid api key" },
	{
		class: "auth",
		match: /oauth token (?:has )?expired|token (?:has )?expired/iu,
	},
	{ class: "auth", match: "authentication_error" },
	{ class: "auth", match: /api_error_status=(?:401|403)\b/u },
	// rate limit (Anthropic 429 / subscription usage limits)
	{ class: "rate_limit", match: /api_error_status=429\b/u },
	{ class: "rate_limit", match: "rate_limit_error" },
	{ class: "rate_limit", match: /usage limit|limit reached|rate limit/iu },
	// config (live: unknown model → 404 "issue with the selected model", stderr unrecognized_model)
	{ class: "config", match: "issue with the selected model" },
	{ class: "config", match: "unrecognized_model" },
	{ class: "config", match: /api_error_status=404\b/u },
	{ class: "config", match: /error: (?:unknown option|option '|invalid)/iu },
	{ class: "config", match: "claude cli not found" },
	{ class: "config", match: /mcp server .* failed to start/iu },
	// transient (Anthropic overload / 5xx / network)
	{ class: "transient", match: /api_error_status=(?:500|502|503|504|529)\b/u },
	{ class: "transient", match: "overloaded" },
	{
		class: "transient",
		match:
			/econnreset|etimedout|econnrefused|socket hang up|fetch failed|network error|request timed out/iu,
	},
	// permanent (request can never succeed as is)
	{
		class: "permanent",
		match: /prompt is too long|context (?:window|length)/iu,
	},
	{
		class: "permanent",
		match: /error_max_turns|error_max_budget|max_budget/iu,
	},
	{ class: "permanent", match: "invalid_request_error" },
	{ class: "permanent", match: /api_error_status=400\b/u },
];

export interface ClaudeFailureInput {
	readonly result?: string | null;
	readonly subtype?: string | null;
	readonly apiErrorStatus?: number | null;
	readonly terminalReason?: string | null;
	readonly errors?: readonly string[];
	readonly stderr?: string;
	readonly exitCode?: number | null;
}

export function claudeFailureText(input: ClaudeFailureInput): string {
	const parts: string[] = [];
	if (input.result) parts.push(input.result);
	if (input.subtype) parts.push(`subtype=${input.subtype}`);
	if (input.apiErrorStatus !== null && input.apiErrorStatus !== undefined)
		parts.push(`api_error_status=${input.apiErrorStatus}`);
	if (input.terminalReason)
		parts.push(`terminal_reason=${input.terminalReason}`);
	for (const error of input.errors ?? []) parts.push(error);
	if (input.stderr?.trim()) parts.push(input.stderr.trim());
	return parts.join(" | ");
}

export function classifyClaudeFailure(input: ClaudeFailureInput): FailureClass {
	return classifyFailure(
		{ message: claudeFailureText(input), exitCode: input.exitCode ?? null },
		CLAUDE_ERROR_RULES,
	);
}
