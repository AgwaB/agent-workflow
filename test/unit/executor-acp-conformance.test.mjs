// ACP executor pilot: the conformance kit against the scripted ACP agent (offline and runtime
// tiers). No agent CLI, no model call.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runConformance } from "../../dist/sdk/conformance/index.js";
import { UNIT_CONFORMANCE_TIMEOUTS } from "../fixtures/conformance-timeouts.mjs";
import { createAcpHarness } from "../fixtures/executors/acp/harness.mjs";

const failures = (report) =>
	report.results
		.filter((result) => result.status === "fail")
		.map((result) => [result.id, result.violations]);

test("acp adapter passes every offline check it can stage", {
	timeout: 300_000,
}, async () => {
	const report = await runConformance(createAcpHarness(), {
		timeouts: UNIT_CONFORMANCE_TIMEOUTS,
	});
	assert.deepEqual(failures(report), []);
	const byId = Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
	const skipped = report.results
		.filter((result) => result.tier === "offline" && result.status !== "pass")
		.map((result) => [result.id, result.status, result.reason]);
	// Justified skips: no MCP delivery limit is declared (unknown until the live tier measures it).
	assert.deepEqual(
		skipped.map(([id]) => id).sort(),
		["mcp.delivery_bound", "mcp.paged_read"].sort(),
		JSON.stringify(skipped),
	);
	assert.deepEqual(byId["errors.failure_classes"].details, {
		fail_transient: "transient",
		fail_rate_limit: "rate_limit",
		fail_auth: "auth",
		fail_config: "config",
		fail_permanent: "permanent",
	});
	assert.equal(byId["cancel.active"].details.result, "cancelled");
	assert.equal(report.executor.id, "gemini");
});

test("acp adapter passes the runtime tier (durable worker, rediscovery, control relay)", {
	timeout: 600_000,
}, async () => {
	const report = await runConformance(createAcpHarness(), {
		tiers: ["runtime"],
		only: ["runtime."],
		timeouts: UNIT_CONFORMANCE_TIMEOUTS,
	});
	assert.deepEqual(failures(report), []);
	for (const result of report.results)
		assert.equal(result.status, "pass", `${result.id}: ${result.reason ?? ""}`);
});
