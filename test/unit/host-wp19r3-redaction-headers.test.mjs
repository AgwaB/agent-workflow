// New in agent-workflow (WP19 round 3, review R1): values under unequivocal credential headers are
// always redacted, whatever their length or alphabet. Round 2 (N6) exempted credential header
// names from assignment redaction and then judged the value's shape, so short or letters-only keys
// (`x-api-key: abcdefghijklmnop`, `x-api-key: k3y012`, bare `Authorization: abc`) passed through.
// Prose is kept only through narrow exceptions: a non-credential label (`Exit code: 1`) or an
// obvious statement after `Authorization:` (`missing …`, `not required …`). Based on the reviewer's
// probe /tmp/aw-wp19r3-extra.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

const { redactSensitiveWorkflowText: redact } = await import(
	"../../dist/core/workflow-sensitive-query.js"
);
const { hostTextRedactor } = await import("../../dist/hosts/redaction.js");

const LEAKS = [
	["x-api-key: abcdefghijklmnop", "abcdefghijklmnop"],
	["x-api-key: k3y012", "k3y012"],
	["X-API-Key: abc", "abc"],
	["api-key: shortkey", "shortkey"],
	["Authorization: abc", "abc"],
	["Authorization: abcdefghijklmnop", "abcdefghijklmnop"],
	["Proxy-Authorization: abcdefghijklmnop", "abcdefghijklmnop"],
	["Authorization: not s3cr3tvalue1", "s3cr3tvalue1"],
	["Cookie: abc", "abc"],
	["Set-Cookie: abc", "abc"],
	["X-Auth-Token: abcdef", "abcdef"],
	["x-csrf-token: qwerty", "qwerty"],
	["'x-api-key': abcdef", "abcdef"],
	["password: abc", "abc"],
	["token: abc", "abc"],
];

const PROSE = [
	"Exit code: 1",
	"HTTP status code: 403",
	"Authorization: missing on the delete endpoint; any tenant can delete data.",
	"Authorization: not required for /health",
	"Session: started at 10:00 and ended without errors",
];

test("R1: known credential headers are redacted whatever the value's length or alphabet", () => {
	const redactHost = hostTextRedactor({});
	for (const [line, secret] of LEAKS)
		for (const out of [redact(line), redactHost(line)]) {
			assert.ok(!out.includes(secret), `${line} → ${out}`);
			assert.match(out, /REDACTED/, line);
		}
	assert.equal(redact("x-api-key: k3y012"), "x-api-key: REDACTED");
	assert.equal(redact("Authorization: abc"), "Authorization: REDACTED");
});

test("R1: N6 report prose is still preserved", () => {
	const redactHost = hostTextRedactor({});
	for (const line of PROSE) {
		assert.equal(redact(line), line);
		assert.equal(redactHost(line), line);
	}
	const report = PROSE.join("\n");
	assert.equal(redactHost(report), report);
});
