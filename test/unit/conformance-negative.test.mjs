// Negative tests: each injected adapter bug must fail the named conformance check.
import assert from "node:assert/strict";
import { test } from "node:test";

import { level } from "../../dist/sdk/index.js";
import {
	createFakeHarness,
	runConformance,
} from "../../dist/sdk/conformance/index.js";

async function run(harnessOptions, only, options = {}) {
	const report = await runConformance(createFakeHarness(harnessOptions), {
		only,
		...options,
	});
	return Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
}

function assertFails(result, pattern) {
	assert.equal(result.status, "fail", `${result.id} should fail`);
	assert.ok(
		result.violations.some((violation) => pattern.test(violation)),
		`${result.id} violations ${JSON.stringify(result.violations)} do not match ${pattern}`,
	);
}

test("double effect on resubmit fails submit.idempotent_sequential", async () => {
	const results = await run(
		{
			wrap(fake, { store }) {
				const seen = new Set();
				let extra = 0;
				return {
					...fake,
					async submit(req) {
						const ref = await fake.submit(req);
						if (!seen.has(req.attemptKey)) {
							seen.add(req.attemptKey);
							return ref;
						}
						// Bug: a "new" launch for a known attemptKey.
						extra += 1;
						store.trace.push({
							type: "effect",
							attemptKey: req.attemptKey,
							executorId: fake.id,
						});
						return { ...ref, handle: `${ref.handle}-dup-${extra}` };
					},
				};
			},
		},
		["submit.idempotent_sequential"],
	);
	assertFails(results["submit.idempotent_sequential"], /different ExecRef/);
	assertFails(
		results["submit.idempotent_sequential"],
		/exactly 1 effect.*saw 2/,
	);
});

test("launch without consume fails the fencing checks", async () => {
	const results = await run({ faults: { complete: { skipConsume: true } } }, [
		"fencing.",
	]);
	assertFails(
		results["fencing.consume_before_effect"],
		/never called authority\.consume/,
	);
	assertFails(
		results["fencing.consume_before_effect"],
		/without a released authority consume/,
	);
	assertFails(
		results["fencing.revoked_before_consume"],
		/revoked attempt caused 1 effect/,
	);
	assert.equal(results["fencing.crash_after_consume"].status, "pass");
});

test("unknown cost reported as 0 fails usage.cost_honesty", async () => {
	const results = await run(
		{
			executor: {
				capabilities: { usage: { ...level("native"), detail: "tokens" } },
			},
			scripts: {
				usage_unknown: [
					{ type: "started", sessionId: null },
					{
						type: "usage",
						input: 3,
						output: 1,
						cached: 0,
						cost: 0,
						source: "estimated",
					},
					{ type: "completed", finalText: "x" },
				],
			},
		},
		["usage.cost_honesty"],
	);
	assertFails(
		results["usage.cost_honesty"],
		/usage_unknown: cost 0 .*must be cost null/,
	);
	assertFails(
		results["usage.cost_honesty"],
		/usage\.detail is tokens but a usage event carries cost/,
	);
});

test("event after the terminal event fails events.sequence", async () => {
	const results = await run(
		{
			wrap: (fake) => ({
				...fake,
				async *observe(ref) {
					yield* fake.observe(ref);
					yield { type: "message_delta", text: "late" };
				},
			}),
		},
		["events.sequence"],
	);
	assertFails(results["events.sequence"], /event after terminal event/);
});

test("hanging cancel while declaring cancel unsupported fails cancel.declared_matches", async () => {
	const results = await run(
		{
			executor: {
				capabilities: { cancel: { ...level("none"), detail: "kill" } },
			},
			wrap: (fake) => ({
				...fake,
				cancel: () => new Promise(() => {}),
			}),
		},
		["cancel."],
		{ timeouts: { callMs: 200 } },
	);
	assertFails(
		results["cancel.declared_matches"],
		/declared none but resolved error: .*did not settle within 200ms/,
	);
	assertFails(
		results["cancel.active"],
		/cancel returned threw: .*did not settle/,
	);
});

test("probe that consumes a stored authority fails probe.side_effect_free", async () => {
	const results = await run(
		{
			wrap(fake) {
				let last;
				return {
					...fake,
					async submit(req) {
						last = req;
						return fake.submit(req);
					},
					async probe() {
						// Bug: a "smoke launch" during readiness check reuses the last authority.
						await last?.authority.consume().catch(() => {});
						return fake.probe();
					},
				};
			},
		},
		["probe.side_effect_free"],
	);
	assertFails(
		results["probe.side_effect_free"],
		/probe\(\) called consume\(\)/,
	);
});

test("reconcile absent after a consume-crash fails reconcile.unknown", async () => {
	const results = await run(
		{
			wrap: (fake) => ({
				...fake,
				reconcile: async (attemptKey) => {
					const result = await fake.reconcile(attemptKey);
					return "unknown" in result ? { absent: true } : result;
				},
			}),
		},
		["reconcile.unknown"],
	);
	assertFails(
		results["reconcile.unknown"],
		/returned absent after a consumed authority/,
	);
});

test("approval allowed without asking fails approval.deny", async () => {
	const results = await run(
		{
			scripts: {
				approval: [
					{ type: "started", sessionId: null },
					{
						type: "approval_request",
						requestId: "auto",
						kind: "execute",
						detail: "rm -rf",
					},
					{
						type: "tool_call",
						name: "bash",
						kind: "execute",
						status: "completed",
					},
					{ type: "completed", finalText: "auto-allowed" },
				],
			},
		},
		["approval.deny", "approval.timeout_fail_closed"],
	);
	assertFails(
		results["approval.deny"],
		/denied execute tool bash still completed/,
	);
	assertFails(results["approval.timeout_fail_closed"], /still completed/);
});

// WP2b runtime tier: the same bugs, injected into the module a durable worker reloads in a fresh
// process (createFakeHarness({ runtime: { faults } })).
async function runRuntime(faults, only) {
	const report = await runConformance(
		createFakeHarness({ runtime: { faults } }),
		{
			tiers: ["runtime"],
			only,
		},
	);
	return Object.fromEntries(
		report.results.map((result) => [result.id, result]),
	);
}

test("runtime: launch without consume through a real worker fails runtime.durable_authority", async () => {
	const results = await runRuntime({ complete: { skipConsume: true } }, [
		"runtime.durable_authority",
	]);
	assertFails(
		results["runtime.durable_authority"],
		/effect\(s\) while the launch barrier still held the authority/,
	);
	assertFails(
		results["runtime.durable_authority"],
		/revoked attempt caused 1 effect/,
	);
});

test("runtime: reconcile absent after an effect (worker killed) fails runtime.durable_authority", async () => {
	const results = await runRuntime({ slow: { reconcileAbsent: true } }, [
		"runtime.durable_authority",
	]);
	assertFails(
		results["runtime.durable_authority"],
		/returned absent after an effect/,
	);
});

test("runtime: an adapter that ignores a relayed deny fails runtime.control_relay", async () => {
	const results = await runRuntime({ approval: { ignoreDeny: true } }, [
		"runtime.control_relay",
	]);
	assertFails(
		results["runtime.control_relay"],
		/denied execute tool still completed/,
	);
});

test("an adapter that ignores permissionMode fails permission.mode_mapping (WP4e)", async () => {
	const ignoring = await run(
		{
			wrap: (fake) => ({
				...fake,
				// Bug: always launches with the safe settings.
				submit: (req) => fake.submit({ ...req, permissionMode: "safe" }),
			}),
		},
		["permission.mode_mapping"],
	);
	assertFails(
		ignoring["permission.mode_mapping"],
		/free launch lacks documented setting "--sandbox=off"/,
	);
	const bypassReadOnly = await run(
		{
			wrap: (fake) => ({
				...fake,
				// Bug: free mode also unlocks readOnly stages.
				submit: (req) =>
					fake.submit(
						req.permissionMode === "free" ? { ...req, readOnly: false } : req,
					),
			}),
		},
		["permission.mode_mapping"],
	);
	assertFails(
		bypassReadOnly["permission.mode_mapping"],
		/free-readOnly launch has setting "--sandbox=off"/,
	);
});
