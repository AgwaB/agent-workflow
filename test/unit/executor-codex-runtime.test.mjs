// WP7: runtime-tier conformance with the codex adapter descriptor (module = the built adapter,
// config = stub codex path + state dir): durable fencing through a real detached worker, detach
// rediscovery from a fresh process, approval/cancel relay through the control mailbox.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runConformance } from "../../dist/sdk/conformance/index.js";
import { createCodexStubHarness } from "../fixtures/executors/codex/harness.mjs";

test("codex adapter passes the runtime conformance tier against the stub CLI", async () => {
	const report = await runConformance(createCodexStubHarness(), {
		tiers: ["runtime"],
		only: ["runtime."],
	});
	assert.deepEqual(
		report.results.map((result) => [
			result.id,
			result.status,
			result.violations,
		]),
		[
			["runtime.durable_authority", "pass", []],
			["runtime.detach_rediscovery", "pass", []],
			["runtime.control_relay", "pass", []],
		],
	);
	const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
	// sessionBound: a found attempt is never adopted by another process.
	assert.equal(
		byId["runtime.durable_authority"].details.kill,
		"marked-needs-decision/found",
	);
});
