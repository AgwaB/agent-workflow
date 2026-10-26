import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as conformance from "../../dist/sdk/conformance/index.js";

const {
	CONFORMANCE_CATALOG,
	catalogCounts,
	createFakeHarness,
	describeCatalog,
	registerConformanceTests,
	runConformance,
} = conformance;

test("package export ./sdk/conformance resolves to the built kit", async () => {
	const pkg = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	const target = pkg.exports["./sdk/conformance"];
	assert.deepEqual(target, {
		types: "./dist/sdk/conformance/index.d.ts",
		default: "./dist/sdk/conformance/index.js",
	});
	const mod = await import(new URL(`../../${target.default}`, import.meta.url));
	assert.equal(mod.MODULE, "src/sdk/conformance");
});

test("catalog: unique ids, every tier present, JSON description", () => {
	const ids = CONFORMANCE_CATALOG.map((check) => check.id);
	assert.equal(new Set(ids).size, ids.length);
	const counts = catalogCounts();
	assert.ok(counts.offline >= 30, `offline checks: ${counts.offline}`);
	assert.ok(counts.live >= 4);
	assert.equal(counts.runtime, 3);
	const described = describeCatalog();
	assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
	// WP2b: the runtime tier is implemented (no placeholders left).
	for (const check of described.filter((entry) => entry.tier === "runtime"))
		assert.equal(check.pending, undefined, check.id);
	assert.deepEqual(
		described
			.filter((entry) => entry.tier === "runtime")
			.map((entry) => entry.id),
		[
			"runtime.durable_authority",
			"runtime.detach_rediscovery",
			"runtime.control_relay",
		],
	);
	for (const required of [
		"submit.idempotent_sequential",
		"fencing.consume_before_effect",
		"fencing.revoked_before_consume",
		"fencing.crash_after_consume",
		"events.sequence",
		"usage.cost_honesty",
		"approval.allow",
		"approval.deny",
		"cancel.active",
		"reconcile.found",
		"reconcile.absent",
		"reconcile.unknown",
		"errors.failure_classes",
		"mcp.injection",
		"mcp.delivery_bound",
		"live.readonly_enforced",
		"live.isolation",
		"live.session_ownership",
		"runtime.detach_rediscovery",
	])
		assert.ok(ids.includes(required), `missing ${required}`);
});

test("fake executor passes every offline check; live/runtime are skipped with reasons", async () => {
	const seen = [];
	const report = await runConformance(createFakeHarness(), {
		onResult: (result) => seen.push(result.id),
	});
	const failures = report.results.filter((result) => result.status === "fail");
	assert.deepEqual(
		failures.map((result) => [result.id, result.violations]),
		[],
	);
	assert.equal(report.ok, true);
	for (const result of report.results) {
		if (result.tier === "offline")
			assert.equal(result.status, "pass", `${result.id}: ${result.reason}`);
		else {
			assert.equal(result.status, "skip");
			assert.ok(result.reason.length > 0);
		}
	}
	assert.equal(report.summary.total, CONFORMANCE_CATALOG.length);
	assert.equal(report.summary.pass, catalogCounts().offline);
	assert.deepEqual(
		seen,
		CONFORMANCE_CATALOG.map((check) => check.id),
	);
	assert.deepEqual(report.executor, {
		id: "fake",
		version: "0.1.0",
		contractVersion: "0.1.0",
	});
	assert.deepEqual(report.tiers, ["offline"]);
	assert.deepEqual(JSON.parse(JSON.stringify(report)), report);

	const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
	assert.deepEqual(byId["fencing.consume_before_effect"].details, {
		effects: 1,
		consumes: ["released"],
	});
	assert.deepEqual(byId["mcp.delivery_bound"].details, {
		limit: 4096,
		served: 8192,
		delivered: 4096,
	});
});

test("filters, live tier on a non-live harness, and unsupported scenarios skip honestly", async () => {
	const report = await runConformance(
		createFakeHarness({
			scenarios: ["complete"],
			descriptor: false,
			mcpOutputLimitChars: null,
		}),
		{
			tiers: ["offline", "live"],
			only: ["fencing.", "live.", "descriptor."],
			exclude: ["live.resume"],
		},
	);
	const status = Object.fromEntries(
		report.results.map((result) => [
			result.id,
			[result.status, result.reason ?? null],
		]),
	);
	assert.deepEqual(status["fencing.consume_before_effect"], ["pass", null]);
	assert.deepEqual(status["fencing.crash_after_consume"], [
		"skip",
		"harness does not support scenario crash_after_consume",
	]);
	assert.deepEqual(status["descriptor.reload"], [
		"skip",
		"harness provides no descriptor",
	]);
	assert.deepEqual(status["live.isolation"], ["skip", "harness is not live"]);
	assert.equal(status["live.resume"], undefined);
	assert.equal(report.ok, true);
});

test("delivery bound skips when the probe reports no MCP output limit", async () => {
	const report = await runConformance(
		createFakeHarness({ mcpOutputLimitChars: null }),
		{ only: ["mcp.delivery_bound"] },
	);
	assert.equal(report.results[0].status, "skip");
	assert.match(report.results[0].reason, /deliveryUnverified/);
});

test("runtime tier: the fake executor passes every runtime check through real durable workers", async () => {
	const report = await runConformance(createFakeHarness(), {
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
	assert.deepEqual(byId["runtime.durable_authority"].details, {
		release: "completed/null",
		revoke: "cancelled/revoked",
		kill: "marked-needs-decision/unknown",
	});
	assert.equal(
		byId["runtime.detach_rediscovery"].details.mismatch,
		"failed/guard_failure",
	);
	assert.equal(
		byId["runtime.control_relay"].details.cancel,
		"cancelled → cancelled/user_cancelled",
	);
});

test("runtime tier skips honestly without a runtime stage", async () => {
	const report = await runConformance(createFakeHarness({ runtime: false }), {
		tiers: ["runtime"],
		only: ["runtime."],
	});
	for (const result of report.results) {
		assert.equal(result.status, "skip", result.id);
		assert.match(result.reason, /no runtime stage/u);
	}
});

registerConformanceTests({
	test,
	harness: createFakeHarness({ name: "fake-registered" }),
	only: ["identity.", "submit.", "approval.", "runtime."],
});
