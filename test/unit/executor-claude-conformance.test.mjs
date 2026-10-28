// WP8: the Claude adapter against the conformance kit, offline (stub CLI replaying scrubbed
// claude-code 2.1.310 transcripts) and runtime tier (real durable runtime, stub CLI).
import assert from "node:assert/strict";
import { test } from "node:test";

import { runConformance } from "../../dist/sdk/conformance/index.js";
import { createClaudeStubHarness } from "../fixtures/executors/claude/harness.mjs";

const failures = (report) =>
	report.results
		.filter((result) => result.status === "fail")
		.map((result) => [result.id, result.violations]);

test("claude adapter passes every offline check it can stage", {
	timeout: 300_000,
}, async () => {
	const report = await runConformance(createClaudeStubHarness());
	assert.deepEqual(failures(report), []);
	const byId = Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
	for (const result of report.results.filter(
		(entry) => entry.tier === "offline",
	)) {
		if (result.id === "mcp.delivery_bound") continue;
		assert.equal(result.status, "pass", `${result.id}: ${result.reason ?? ""}`);
	}
	// Justified skip: Claude spills an over-limit MCP result to a file and delivers only a notice
	// (live: transcripts/mcp-limit-*), so no delivered output contains the nonce to measure.
	assert.equal(byId["mcp.delivery_bound"].status, "skip");
	assert.match(byId["mcp.delivery_bound"].reason, /no tool_call output/);
	assert.deepEqual(byId["fencing.consume_before_effect"].details, {
		effects: 1,
		consumes: ["released"],
	});
	assert.deepEqual(byId["errors.failure_classes"].details, {
		fail_transient: "transient",
		fail_rate_limit: "rate_limit",
		fail_auth: "auth",
		fail_config: "config",
		fail_permanent: "permanent",
	});
	assert.deepEqual(byId["cancel.active"].details, {
		declared: "native",
		result: "cancelled",
		terminal: "failed",
	});
	assert.equal(byId["probe.shape"].details.mcpOutputLimitChars, 22_500);
	assert.equal(report.executor.id, "claude");
});

test("claude adapter passes the runtime tier (durable worker, rediscovery, control relay)", {
	timeout: 600_000,
}, async () => {
	const report = await runConformance(createClaudeStubHarness(), {
		tiers: ["runtime"],
		only: ["runtime."],
	});
	assert.deepEqual(failures(report), []);
	const byId = Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
	for (const id of [
		"runtime.durable_authority",
		"runtime.detach_rediscovery",
		"runtime.control_relay",
	])
		assert.equal(byId[id].status, "pass", `${id}: ${byId[id].reason ?? ""}`);
	// WP37 (B3): the killed worker took the CLI's stdio with it and no result was recorded, so the
	// adapter reconciles `unknown` (with a reason) instead of `found`; still needs_decision.
	assert.equal(
		byId["runtime.durable_authority"].details.kill,
		"marked-needs-decision/unknown",
	);
});
