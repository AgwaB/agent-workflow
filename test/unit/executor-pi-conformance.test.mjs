// WP6: the Pi executor against the conformance kit, offline + runtime tiers. Recorded (scrubbed)
// Pi 1.1.0 transcripts are replayed through the kit's stub CLI (test/fixtures/executors/pi/).
import assert from "node:assert/strict";
import { test } from "node:test";

import { registerConformanceTests } from "../../dist/sdk/conformance/index.js";
import { createPiStubHarness } from "../fixtures/executors/pi/harness.mjs";
import { UNIT_CONFORMANCE_TIMEOUTS } from "../fixtures/conformance-timeouts.mjs";

const results = [];
registerConformanceTests({
	test,
	harness: createPiStubHarness(),
	tiers: ["offline", "runtime"],
	timeouts: UNIT_CONFORMANCE_TIMEOUTS,
	prefix: "pi executor conformance",
	onResult: (result) => results.push(result),
});

// Skips must be exactly the justified ones (docs/executors/pi.md "Conformance").
const JUSTIFIED_SKIPS = {
	// Pi has no permission prompts in `--mode json --print`: tools outside the allowlist do not exist
	// for the worker (D2), so there is no approval_request to stage.
	"approval.allow": /scenario approval/u,
	"approval.deny": /scenario approval/u,
	"approval.respond_unknown": /scenario approval/u,
	"approval.timeout_fail_closed": /scenario approval/u,
};

test("pi executor conformance: no failures, only justified skips", () => {
	assert.ok(results.length >= 37, `only ${results.length} checks ran`);
	assert.deepEqual(
		results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
	for (const result of results.filter((entry) => entry.status === "skip")) {
		if (result.tier === "live") continue;
		const expected = JUSTIFIED_SKIPS[result.id];
		assert.ok(expected, `unexpected skip ${result.id}: ${result.reason}`);
		assert.match(result.reason ?? "", expected, result.id);
	}
	const byId = Object.fromEntries(results.map((result) => [result.id, result]));
	assert.deepEqual(byId["errors.failure_classes"].details, {
		fail_transient: "transient",
		fail_rate_limit: "rate_limit",
		fail_auth: "auth",
		fail_config: "config",
	});
	assert.deepEqual(byId["mcp.delivery_bound"].details, {
		limit: 20480,
		notice: 1024,
		served: 40960,
		delivered: byId["mcp.delivery_bound"].details.delivered,
	});
	assert.ok(byId["mcp.delivery_bound"].details.delivered > 20480);
	// WP5b: a page of the artifact server's size for Pi (20480 − 1024 − 1024) arrives whole.
	assert.equal(byId["mcp.paged_read"].status, "pass");
	assert.deepEqual(byId["mcp.paged_read"].details.pageLimit, 18432);
	assert.deepEqual(byId["fencing.consume_before_effect"].details, {
		effects: 1,
		consumes: ["released"],
	});
	for (const id of [
		"runtime.durable_authority",
		"runtime.detach_rediscovery",
		"runtime.control_relay",
	])
		assert.equal(byId[id].status, "pass", id);
});
