// WP7: the codex adapter passes the offline conformance kit against a stub `codex app-server`
// that replays scrubbed live transcripts (test/fixtures/executors/codex/recorded/) where they
// exist and protocol-shaped synthetic ones otherwise; `mcp_tool` uses a fake app-server that
// really launches the injected MCP server from the thread config.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runConformance } from "../../dist/sdk/conformance/index.js";
import { createCodexStubHarness } from "../fixtures/executors/codex/harness.mjs";
import { scenarioTranscript } from "../fixtures/executors/codex/scenarios.mjs";

test("codex adapter passes every offline conformance check", async () => {
	const report = await runConformance(createCodexStubHarness(), {
		tiers: ["offline"],
	});
	const failures = report.results
		.filter((result) => result.status === "fail")
		.map((result) => [result.id, result.violations]);
	assert.deepEqual(failures, []);
	const offline = report.results.filter((result) => result.tier === "offline");
	// Justified skip (WP5b): the adapter clips normalized tool_call.output at 16,384 chars, so the
	// event view cannot show a 30,400-char page whole (docs/executors/codex.md "MCP output limit").
	assert.deepEqual(
		offline
			.filter((result) => result.status !== "pass")
			.map((result) => [result.id, result.reason]),
		[
			[
				"mcp.paged_read",
				"the adapter's normalized tool_call.output keeps at most 16384 chars (< page size 30400); the event view cannot prove page delivery — verify live",
			],
		],
		"no other offline check may be skipped",
	);
	assert.equal(report.executor.id, "codex");
	const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
	assert.deepEqual(byId["fencing.consume_before_effect"].details, {
		effects: 1,
		consumes: ["released"],
	});
	assert.equal(byId["cancel.active"].details.result, "cancelled");
	assert.deepEqual(byId["errors.failure_classes"].details, {
		fail_transient: "transient",
		fail_rate_limit: "rate_limit",
		fail_auth: "auth",
		fail_config: "config",
		fail_permanent: "permanent",
	});
});

test("conformance scenarios replay live recordings where they exist", () => {
	for (const scenario of [
		"complete",
		"usage_unknown",
		"slow",
		"approval",
		"fail_auth",
		"fail_config",
	])
		assert.equal(scenarioTranscript(scenario).source, "recorded", scenario);
	for (const scenario of [
		"fail_transient",
		"fail_rate_limit",
		"fail_permanent",
		"fail_unknown",
		"crash_after_consume",
	])
		assert.equal(scenarioTranscript(scenario).source, "synthetic", scenario);
});
