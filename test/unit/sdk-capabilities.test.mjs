import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import { fakeCapabilities } from "../../dist/sdk/testing/index.js";

const executor = { id: "fake", version: "0.1.0" };
const unverified = sdk.level("native", "unverified");

function outcome(report, key) {
	return report.entries.find((entry) => entry.key === key);
}

test("capability tables validate structure and the agent-owned tool loop rule", () => {
	assert.deepEqual(sdk.validateCapabilities(sdk.noneCapabilities()), []);
	assert.deepEqual(sdk.validateCapabilities(fakeCapabilities()), []);
	assert.match(
		sdk
			.validateCapabilities({
				...sdk.noneCapabilities(),
				toolAllowlist: { level: "native", source: "declared", detail: "medium" },
			})
			.join(),
		/toolAllowlist\.detail/,
	);
	assert.match(
		sdk
			.validateCapabilities({
				...sdk.noneCapabilities(),
				webTools: {
					level: "none",
					source: "declared",
					detail: "none",
					safetyPolicy: "maybe",
				},
			})
			.join(),
		/safetyPolicy/,
	);
	assert.match(
		sdk
			.validateCapabilities({
				...sdk.noneCapabilities(),
				toolLoop: "agent",
				toolResultBudget: sdk.level("emulated"),
			})
			.join(),
		/cannot be emulated when toolLoop is agent/,
	);
	assert.throws(
		() => sdk.assertCapabilities({}),
		(error) => sdk.isSdkError(error, "INVALID_CAPABILITIES"),
	);
});

test("probe results override declared rows and are marked probed", () => {
	const declared = fakeCapabilities({ contextIsolation: unverified });
	const merged = sdk.mergeProbedCapabilities(declared, {
		contextIsolation: { level: "native", verifiedWith: "fake-cli 1.0.0" },
	});
	assert.deepEqual(merged.contextIsolation, {
		source: "probed",
		level: "native",
		verifiedWith: "fake-cli 1.0.0",
	});
	assert.equal(merged.readOnly, declared.readOnly);
});

test("refuse path: readOnly stage on an executor without readOnly → CAPABILITY_MISSING:readOnly", () => {
	const caps = fakeCapabilities({ readOnly: sdk.level("none") });
	const report = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
	});
	assert.equal(report.accepted, false);
	assert.deepEqual(report.refusals, ["CAPABILITY_MISSING:readOnly"]);
	assert.throws(
		() => sdk.assertAccepted(report),
		(error) => error.qualifiedCode === "CAPABILITY_MISSING:readOnly",
	);
	const reads = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ mcpInjection: sdk.level("none") }),
		{ readOnly: false, hasRequiredReads: true },
	);
	assert.deepEqual(reads.refusals, ["CAPABILITY_MISSING:mcpInjection"]);
});

test("refuse path (B5/R#6): contextIsolation unverified or none is refused unless inherit", () => {
	const unverifiedCaps = fakeCapabilities({ contextIsolation: unverified });
	const refused = sdk.negotiateCapabilities(executor, unverifiedCaps, {
		readOnly: false,
		hasRequiredReads: false,
	});
	assert.deepEqual(refused.refusals, ["CAPABILITY_UNVERIFIED:contextIsolation"]);
	assert.throws(
		() => sdk.assertAccepted(refused),
		(error) => sdk.isSdkError(error, "CAPABILITY_UNVERIFIED"),
	);
	const none = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ contextIsolation: sdk.level("none") }),
		{ readOnly: false, hasRequiredReads: false },
	);
	assert.deepEqual(none.refusals, ["CAPABILITY_MISSING:contextIsolation"]);
	const inherit = sdk.negotiateCapabilities(executor, unverifiedCaps, {
		readOnly: false,
		hasRequiredReads: false,
		inherit: true,
	});
	assert.equal(inherit.accepted, true);
	assert.equal(outcome(inherit, "contextIsolation").outcome, "degraded");
	const optIn = sdk.negotiateCapabilities(executor, unverifiedCaps, {
		readOnly: false,
		hasRequiredReads: false,
		allowUnverified: ["contextIsolation"],
	});
	assert.equal(optIn.accepted, true);
	assert.match(outcome(optIn, "contextIsolation").note, /opt-in/);
});

test("degrade path: coarse allowlist runs as readOnly only when the spec allows it", () => {
	const coarse = fakeCapabilities({
		toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
	});
	const ctx = {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["read", "grep"],
	};
	const refused = sdk.negotiateCapabilities(executor, coarse, ctx);
	assert.deepEqual(refused.refusals, ["CAPABILITY_MISSING:toolAllowlist.fine"]);
	const degraded = sdk.negotiateCapabilities(executor, coarse, {
		...ctx,
		allowReadOnlyDowngrade: true,
		interactive: true,
	});
	assert.equal(degraded.accepted, true);
	assert.equal(degraded.forcedReadOnly, true);
	assert.equal(degraded.needsConfirmation, true);
	assert.deepEqual(degraded.degradations, [
		"CAPABILITY_MISSING:toolAllowlist.fine",
	]);
	const noReadOnly = sdk.negotiateCapabilities(
		executor,
		{ ...coarse, readOnly: sdk.level("none") },
		{ ...ctx, allowReadOnlyDowngrade: true },
	);
	assert.equal(noReadOnly.accepted, false);
	const optional = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ partialStream: sdk.level("none") }),
		{ readOnly: false, hasRequiredReads: false, partialStream: true },
	);
	assert.equal(outcome(optional, "partialStream").outcome, "degraded");
	assert.equal(
		optional.needsConfirmation,
		false,
		"non-interactive hosts only record",
	);
});

test("degrade path: unmapped tools follow the same B4 rule", () => {
	const mapping = {
		executorId: "fake",
		entries: {
			read: { type: "tool", names: ["Read"] },
			bash: { type: "none", reason: "not exposed" },
		},
	};
	const ctx = {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["read", "bash"],
		toolMapping: mapping,
	};
	assert.deepEqual(
		sdk.negotiateCapabilities(executor, fakeCapabilities(), ctx).refusals,
		["CAPABILITY_MISSING:tool.bash"],
	);
	const degraded = sdk.negotiateCapabilities(executor, fakeCapabilities(), {
		...ctx,
		allowReadOnlyDowngrade: true,
	});
	assert.equal(degraded.accepted, true);
	assert.deepEqual(degraded.degradations, ["CAPABILITY_MISSING:tool.bash"]);
});

test("emulate path: cost from tokens by the engine; usage none degrades, never zero-filled", () => {
	const tokens = fakeCapabilities({
		usage: { level: "native", source: "declared", detail: "tokens" },
	});
	const report = sdk.negotiateCapabilities(executor, tokens, {
		readOnly: false,
		hasRequiredReads: false,
	});
	const cost = outcome(report, "usage.cost");
	assert.equal(cost.outcome, "emulated");
	assert.equal(cost.emulatedBy, "engine");
	assert.equal(report.accepted, true);
	const none = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({
			usage: { level: "none", source: "declared", detail: "none" },
		}),
		{ readOnly: false, hasRequiredReads: false },
	);
	assert.equal(outcome(none, "usage.cost").outcome, "degraded");
	const required = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({
			usage: { level: "none", source: "declared", detail: "none" },
		}),
		{
			readOnly: false,
			hasRequiredReads: false,
			requirements: { "usage.cost": { need: "required", onMissing: "emulate" } },
		},
	);
	assert.equal(required.accepted, false);
	const executorEmulated = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ nativeSchema: sdk.level("emulated") }),
		{
			readOnly: false,
			hasRequiredReads: false,
			requirements: { nativeSchema: { need: "required", onMissing: "refuse" } },
		},
	);
	assert.equal(outcome(executorEmulated, "nativeSchema").emulatedBy, "executor");
});

test("webTools (C2, plan §6.5): missing refuses, non-engine safety policy is recorded as degraded", () => {
	const none = sdk.negotiateCapabilities(executor, fakeCapabilities(), {
		readOnly: true,
		hasRequiredReads: false,
		tools: ["web_search"],
	});
	assert.ok(none.refusals.includes("CAPABILITY_MISSING:webTools"));
	const caps = fakeCapabilities({
		webTools: {
			level: "native",
			source: "probed",
			detail: "search+fetch",
			safetyPolicy: "unknown",
		},
	});
	const report = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
		webTools: true,
	});
	assert.equal(report.accepted, true);
	assert.match(outcome(report, "webTools").note, /safetyPolicy: unknown/);
});

test("toolResultBudget (C1): optional degrade; unknown requirement keys are rejected", () => {
	const report = sdk.negotiateCapabilities(executor, fakeCapabilities(), {
		readOnly: false,
		hasRequiredReads: false,
		toolResultBudget: true,
		fastTier: true,
	});
	assert.equal(outcome(report, "toolResultBudget").outcome, "degraded");
	assert.equal(outcome(report, "fastTier").outcome, "degraded");
	assert.throws(
		() =>
			sdk.negotiateCapabilities(executor, fakeCapabilities(), {
				readOnly: false,
				hasRequiredReads: false,
				requirements: { warpDrive: { need: "required", onMissing: "refuse" } },
			}),
		(error) => sdk.isSdkError(error, "INVALID_REQUEST"),
	);
});

test("preview and run record expose selection vs dispatch and degradation", () => {
	const coarse = fakeCapabilities({
		toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
	});
	const negotiation = sdk.negotiateCapabilities(executor, coarse, {
		readOnly: true,
		hasRequiredReads: true,
		tools: ["read"],
		allowReadOnlyDowngrade: true,
	});
	const preview = sdk.formatNegotiationPreview(negotiation, "review");
	assert.match(
		preview[0],
		/^review: fake@0\.1\.0 — accepted with degradation \(forced readOnly\)$/,
	);
	assert.ok(
		preview.some(
			(line) =>
				line.includes("toolAllowlist.fine: degraded") &&
				line.includes("[CAPABILITY_MISSING:toolAllowlist.fine]"),
		),
	);
	const record = sdk.createExecutorRunRecord({
		selection: {
			profileRole: "review",
			executorId: "fake",
			model: "m-large",
			effort: "high",
			source: "user-profile",
		},
		dispatch: {
			executorId: "fake",
			executorVersion: "0.1.0",
			cliVersion: "fake-cli 1.0.0",
			model: "m-large-2026",
			effort: "high",
		},
		descriptor: {
			id: "fake",
			version: "0.1.0",
			contractVersion: sdk.EXECUTOR_CONTRACT_VERSION,
			module: "@agwab/agent-workflow/sdk/testing",
			config: null,
		},
		negotiation,
		probe: {
			installed: true,
			cliVersion: "fake-cli 1.0.0",
			auth: "ok",
			notes: ["x"],
		},
	});
	assert.equal(record.degraded, true);
	assert.equal(record.schema, "agent-workflow-executor-record-v0");
	assert.notEqual(record.selection.model, record.dispatch.model);
	assert.deepEqual(record.probe, {
		installed: true,
		cliVersion: "fake-cli 1.0.0",
		auth: "ok",
	});
	assert.deepEqual(
		JSON.parse(JSON.stringify(record)),
		record,
		"record is JSON-serializable",
	);
});
