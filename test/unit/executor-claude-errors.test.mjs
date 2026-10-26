// WP8: Claude error classification table (live rows come from recorded transcripts).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CLAUDE_ERROR_RULES,
	classifyClaudeFailure,
} from "../../dist/executors/claude/index.js";
import { FAILURE_CLASSES, isAutoRetryable } from "../../dist/sdk/index.js";

const ROWS = [
	// live (transcripts/bare-not-logged-in): --bare refuses OAuth
	[
		{
			result: "Not logged in · Please run /login",
			terminalReason: "api_error",
		},
		"auth",
	],
	// live (transcripts/invalid-model): unknown model
	[
		{
			result:
				"There's an issue with the selected model (claude-nonexistent-model-0). It may not exist or you may not have access to it. Run --model to pick a different model.",
			apiErrorStatus: 404,
			terminalReason: "api_error",
			stderr:
				'[claude-code:unrecognized_model] {"model":"claude-nonexistent-model-0","query_source":"sdk"}',
		},
		"config",
	],
	// live (transcripts/interrupt) without our cancel: not classifiable → unknown (never retried)
	[
		{
			subtype: "error_during_execution",
			terminalReason: "aborted_streaming",
			errors: [
				"[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
			],
		},
		"unknown",
	],
	// documented API error shapes (not reproducible within budget)
	[
		{ result: "API Error: 429 rate_limit_error", apiErrorStatus: 429 },
		"rate_limit",
	],
	[{ result: "Claude AI usage limit reached|1793022000" }, "rate_limit"],
	[{ result: "API Error: 529 Overloaded", apiErrorStatus: 529 }, "transient"],
	[
		{ result: "API Error: 500 Internal server error", apiErrorStatus: 500 },
		"transient",
	],
	[{ stderr: "Error: socket hang up", exitCode: 1 }, "transient"],
	[
		{ result: "Invalid API key · Please run /login", apiErrorStatus: 401 },
		"auth",
	],
	[{ result: "OAuth token has expired. Please obtain a new token." }, "auth"],
	[{ result: "Prompt is too long", apiErrorStatus: 400 }, "permanent"],
	[{ subtype: "error_max_turns" }, "permanent"],
	[{ stderr: "error: unknown option '--frobnicate'", exitCode: 1 }, "config"],
	[
		{ result: "mcp server workflow_artifact failed to start (status failed)" },
		"config",
	],
	[{ stderr: "segmentation fault in flux module", exitCode: 139 }, "unknown"],
];

test("error table rows map to their classes", () => {
	for (const [input, expected] of ROWS)
		assert.equal(classifyClaudeFailure(input), expected, JSON.stringify(input));
});

test("rules use only SDK failure classes; unknown is never auto-retried", () => {
	for (const rule of CLAUDE_ERROR_RULES)
		assert.ok(FAILURE_CLASSES.includes(rule.class));
	assert.equal(
		isAutoRetryable(classifyClaudeFailure({ result: "???" })),
		false,
	);
});
