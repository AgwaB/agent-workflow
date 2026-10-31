// A process-spawning example adapter, driven by the stub CLI, passes the offline kit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runConformance } from "../../dist/sdk/conformance/index.js";
import { createStubCliHarness } from "../conformance/stub-cli-adapter.mjs";
import { UNIT_CONFORMANCE_TIMEOUTS } from "../fixtures/conformance-timeouts.mjs";

test("stub-CLI example adapter passes every offline check it can stage", async () => {
	const report = await runConformance(createStubCliHarness(), {
		timeouts: UNIT_CONFORMANCE_TIMEOUTS,
	});
	const byId = Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
	assert.deepEqual(
		report.results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
	for (const id of [
		"submit.idempotent_sequential",
		"submit.idempotent_after_restart",
		"fencing.consume_before_effect",
		"fencing.revoked_before_consume",
		"events.sequence",
		"usage.cost_honesty",
		"approval.allow",
		"approval.deny",
		"approval.respond_unknown",
		"approval.timeout_fail_closed",
		"cancel.active",
		"reconcile.found",
		"errors.failure_classes",
		"errors.unknown_class",
	])
		assert.equal(byId[id].status, "pass", `${id}: ${byId[id].reason ?? ""}`);
	// Effects are counted from the stub CLI invocation log (probes are not effects).
	assert.deepEqual(byId["fencing.consume_before_effect"].details, {
		effects: 1,
		consumes: ["released"],
	});
	assert.deepEqual(byId["cancel.active"].details, {
		declared: "native",
		result: "cancelled",
		terminal: "failed",
	});
	// Scenarios this adapter cannot stage are skipped, never passed.
	for (const id of [
		"fencing.crash_after_consume",
		"reconcile.unknown",
		"mcp.injection",
	])
		assert.equal(byId[id].status, "skip", id);
	assert.equal(report.executor.id, "stub-cli");
});
