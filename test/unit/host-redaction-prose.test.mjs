// New in agent-workflow (WP19 round 2, re-review N6): the host redactor distinguishes credential
// assignments and header values from report prose. Before the fix `Exit code: 1`, `HTTP status
// code: 403` and a security finding `Authorization: missing on the delete endpoint; …` were
// redacted (the last one lost the finding's explanation). Real header values and tokens are still
// redacted; the round-1 redaction cases stay in host-logs-containment-redaction.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

const { redactSensitiveWorkflowText: redact } = await import(
	"../../dist/core/workflow-sensitive-query.js"
);
const { hostTextRedactor } = await import("../../dist/hosts/redaction.js");

const PROSE = [
	"Exit code: 1",
	"HTTP status code: 403",
	"Authorization: missing on the delete endpoint; any tenant can delete data.",
	"Session: started at 10:00 and ended without errors",
	'{"code": 404, "message": "not found"}',
];

const SECRETS = [
	["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
	["authorization: Bearer abc.def.ghi-jkl", "abc.def.ghi"],
	["Proxy-Authorization: Digest username=u, response=9f8e7d6c5b", "9f8e7d6c5b"],
	["Authorization: sk-live-0123456789abcdef", "sk-live-0123456789"],
	["Cookie: sid=s3cr3tcookie; theme=dark", "s3cr3tcookie"],
	["Set-Cookie: session=s3cr3tcookie; Path=/; HttpOnly", "s3cr3tcookie"],
	["x-api-key: k3y0123456789", "k3y0123456789"],
	["password: hunter2", "hunter2"],
	["api_key: s3cr3tak", "s3cr3tak"],
	["OAuth code: 4/0AX4XfWh-s3cr3t", "4/0AX4XfWh"],
	["see https://example.test/cb?access_token=s3cr3tat&x=1", "s3cr3tat"],
	["access_token=s3cr3tat2", "s3cr3tat2"],
];

test("N6: report prose survives redaction; credential headers and tokens do not", () => {
	const redactHost = hostTextRedactor({});
	for (const line of PROSE) {
		assert.equal(redact(line), line);
		assert.equal(redactHost(line), line);
	}
	const report = PROSE.join("\n");
	assert.equal(redactHost(report), report);
	for (const [line, secret] of SECRETS) {
		const out = redactHost(line);
		assert.ok(!out.includes(secret), `${line} → ${out}`);
		assert.match(out, /REDACTED/);
	}
});
