// New in agent-workflow (WP19 round 2, re-review N4): structured-credential redaction is
// escape-aware. Before the fix the value regex ended at the first escaped quote, so valid JSON such
// as {"Cookie":"sid=\"SENSITIVE-COOKIE\"; path=/"} kept the whole cookie secret and a password with
// an escaped quote kept its tail. Covers plain JSON and nested escaped JSON (an event line carrying
// a request), and that non-secret fields after a redacted value stay readable.
import assert from "node:assert/strict";
import { test } from "node:test";

const { redactSensitiveWorkflowText: redact } = await import(
	"../../dist/core/workflow-sensitive-query.js"
);
const { hostTextRedactor } = await import("../../dist/hosts/redaction.js");

const plain = JSON.stringify({
	password: 'prefix"SENSITIVE-TAIL',
	Cookie: 'sid="SENSITIVE-COOKIE"; path=/',
	note: "visible",
});
const nested = JSON.stringify({
	type: "tool",
	input: JSON.stringify({
		headers: {
			Cookie: 'sid="SENSITIVE-NESTED-COOKIE"; theme=dark',
			Accept: "application/json",
		},
		password: 'p"SENSITIVE-NESTED-PW tail',
	}),
});
const doubleNested = JSON.stringify({
	x: JSON.stringify({
		y: JSON.stringify({ refresh_token: 'rt "SENSITIVE-DEEP" tail' }),
	}),
});
const LEAKS = [
	"SENSITIVE-TAIL",
	"SENSITIVE-COOKIE",
	"SENSITIVE-NESTED-COOKIE",
	"SENSITIVE-NESTED-PW",
	"SENSITIVE-DEEP",
];

test("N4: escaped quotes inside structured credentials are redacted completely", () => {
	const redactHost = hostTextRedactor({});
	for (const line of [plain, nested, doubleNested])
		for (const out of [redact(line), redactHost(line)])
			for (const leak of LEAKS)
				assert.ok(!out.includes(leak), `${line}\n→ ${out}\nstill has ${leak}`);
	assert.equal(
		redact(plain),
		'{"password":"REDACTED","Cookie":"REDACTED","note":"visible"}',
	);
	// The structure after a redacted value is intact.
	assert.match(redact(nested), /\\"Accept\\":\\"application\/json\\"/);
	assert.match(redact(nested), /\\"Cookie\\":\\"REDACTED\\"/);
	// An escaped backslash right before the closing quote still ends the value.
	assert.equal(
		redact('{"password":"ends with \\\\","next":"visible"}'),
		'{"password":"REDACTED","next":"visible"}',
	);
});
