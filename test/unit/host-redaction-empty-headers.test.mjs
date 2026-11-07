// New in agent-workflow (WP19 round 4, review F2): an empty credential header must not consume the
// next line. Round 3's header rule used `\s*` around the colon, which crosses line endings, so
// `x-api-key:` at the end of a line redacted the following report line (`Exit code: 1`,
// `3 critical findings`). The separators are now horizontal whitespace only. Based on the
// reviewer's probe /tmp/aw-wp19r4-verified.test.mjs ("empty credential headers …").
import assert from "node:assert/strict";
import { test } from "node:test";

const { redactSensitiveWorkflowText: redact } = await import(
	"../../dist/core/workflow-sensitive-query.js"
);
const { hostTextRedactor } = await import("../../dist/hosts/redaction.js");

const CASES = [
	["x-api-key:\nExit code: 1\nFinding remains.", "Exit code: 1"],
	[
		"Authorization:\n3 critical findings\nFinding remains.",
		"3 critical findings",
	],
	[
		"Cookie:\r\nHTTP status code: 403\r\nFinding remains.",
		"HTTP status code: 403",
	],
	["x-api-key:   \nExit code: 1", "Exit code: 1"],
	["Set-Cookie:\t\n\n3 critical findings", "3 critical findings"],
];

test("F2: an empty credential header keeps the next line", () => {
	const redactHost = hostTextRedactor({});
	for (const [text, nextLine] of CASES)
		for (const out of [redact(text), redactHost(text)]) {
			assert.ok(
				out.includes(nextLine),
				`${JSON.stringify(text)} → ${JSON.stringify(out)}`,
			);
			assert.equal(out, text, "nothing to redact");
		}
});

test("F2: non-empty credential headers are still redacted, and only on their own line", () => {
	assert.equal(
		redact("x-api-key: k3y012\nExit code: 1"),
		"x-api-key: REDACTED\nExit code: 1",
	);
	assert.equal(
		redact("Authorization:\tabc\n3 critical findings"),
		"Authorization: REDACTED\n3 critical findings",
	);
	assert.equal(
		redact("Cookie: sid=abc\r\nHTTP status code: 403"),
		"Cookie: REDACTED\r\nHTTP status code: 403",
	);
});
