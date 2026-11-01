// 2026-11-01: an executor failure names the CLI's own error line, and Pi's "ambiguous model" is a
// configuration failure (it was "executor_unknown" with no reason in the task).
import assert from "node:assert/strict";
import test from "node:test";
import { withCliErrorLine } from "../../dist/core/terminal-result.js";
import { classifyPiFailure } from "../../dist/executors/pi/errors.js";

const PI_STDERR = [
	'unknown: Warning: No models match pattern "anthropic/claude-opus-5-5"',
	'Warning: No models match pattern "anthropic/claude-haiku-5-5"',
	'Error: Model "gpt-6-luna" is ambiguous across providers: openai-codex/gpt-6-luna, openai/gpt-6-luna. More than one matching provider is authenticated.',
	"",
].join("\n");

test("the last CLI error line is appended once, bounded and on one line", () => {
	assert.equal(
		withCliErrorLine("executor run failed: executor_config", PI_STDERR),
		'executor run failed: executor_config — Error: Model "gpt-6-luna" is ambiguous across providers: openai-codex/gpt-6-luna, openai/gpt-6-luna. More than one matching provider is authenticated.',
	);
	assert.equal(
		withCliErrorLine(
			"executor run failed: executor_unknown",
			"unknown: Error: boom\u0007 x",
		),
		"executor run failed: executor_unknown — Error: boom  x",
	);
	// Warnings, prose and secrets that are not an error line are not copied.
	assert.equal(
		withCliErrorLine(
			"executor run failed: executor_unknown",
			"Warning: x\ntoken=abc\n",
		),
		"executor run failed: executor_unknown",
	);
	const long = withCliErrorLine("m", `Error: ${"x".repeat(500)}`);
	assert.ok(long.length < 260 && long.endsWith("…"));
});

test("Pi's ambiguous model error is a configuration failure, warnings alone are not", () => {
	assert.equal(classifyPiFailure(PI_STDERR, 1), "config");
	assert.notEqual(
		classifyPiFailure('Warning: No models match pattern "x"', 1),
		"config",
	);
});
