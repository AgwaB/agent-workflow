// New in agent-workflow (WP19 round 3, review R4): malformed nested escapes fail closed. When the
// escape-aware scanner met a quote of an enclosing level inside a credential value it stopped
// there and kept the rest of the line, so
// {"input":"{\"password\":\"prefix"SENSITIVE-SUFFIX\"}"} still exposed `SENSITIVE-SUFFIX`. Now the
// rest of the line is treated as the value. Based on the reviewer's probe
// /tmp/aw-wp19r3-extra.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

const { redactSensitiveWorkflowText: redact } = await import(
	"../../dist/core/workflow-sensitive-query.js"
);
const { hostTextRedactor } = await import("../../dist/hosts/redaction.js");

test("R4: a malformed nested escape inside a credential value redacts through the end of the line", () => {
	const redactHost = hostTextRedactor({});
	const malformed = String.raw`{"input":"{\"password\":\"prefix"SENSITIVE-SUFFIX\"}"}`;
	const deeper = String.raw`{"a":"{\"b\":\"{\\\"refresh_token\\\":\\\"rt\"SENSITIVE-DEEP\\\"}\"}"}`;
	for (const line of [malformed, deeper])
		for (const out of [redact(line), redactHost(line)]) {
			assert.ok(!out.includes("SENSITIVE"), `${line}\n→ ${out}`);
			assert.match(out, /REDACTED/);
		}
	// Nothing after `password` survives, and only the rest of that line is affected.
	const out = redact(malformed);
	assert.equal(
		out.slice(out.indexOf("password")),
		String.raw`password\":\"REDACTED`,
	);
	assert.equal(
		redact(`${malformed}\nnext line stays`).split("\n")[1],
		"next line stays",
	);
	// Well-formed nested escapes still end the value at its own delimiter.
	const wellFormed = JSON.stringify({
		input: JSON.stringify({ password: 'p"x', note: "visible" }),
	});
	assert.match(redact(wellFormed), /\\"note\\":\\"visible\\"/);
});
