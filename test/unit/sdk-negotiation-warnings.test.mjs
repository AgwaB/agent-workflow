// New in agent-workflow (WP4d): environment warnings on capability levels, strict capabilities and
// the run-level capability preview.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import { fakeCapabilities } from "../../dist/sdk/testing/index.js";

const executor = { id: "fake", version: "0.1.0" };
const warned = (warning) => ({
	level: "emulated",
	source: "probed",
	warning,
});

function entry(report, key) {
	return report.entries.find((item) => item.key === key);
}

test("Level.warning validates as a string and survives a probe merge", () => {
	assert.deepEqual(
		sdk.validateCapabilities(
			fakeCapabilities({ readOnly: warned("3 allow rules") }),
		),
		[],
	);
	assert.match(
		sdk
			.validateCapabilities(
				fakeCapabilities({
					readOnly: { level: "emulated", source: "probed", warning: 3 },
				}),
			)
			.join(),
		/readOnly\.warning must be a string/,
	);
	const merged = sdk.mergeProbedCapabilities(fakeCapabilities(), {
		readOnly: { level: "emulated", warning: "w" },
	});
	assert.deepEqual(merged.readOnly, {
		source: "probed",
		level: "emulated",
		warning: "w",
	});
});

test("emulated + warning negotiates as a degradation with the warning as note", () => {
	const caps = fakeCapabilities({ readOnly: warned("2 allow rules in R") });
	const quiet = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
	});
	const readOnly = entry(quiet, "readOnly");
	assert.equal(readOnly.outcome, "degraded");
	assert.equal(readOnly.code, "CAPABILITY_WARNING:readOnly");
	assert.equal(readOnly.note, "2 allow rules in R");
	assert.equal(readOnly.observed.warning, "2 allow rules in R");
	assert.equal(quiet.accepted, true);
	assert.deepEqual(quiet.degradations, ["CAPABILITY_WARNING:readOnly"]);
	// Non-interactive: recorded, no confirmation.
	assert.equal(quiet.needsConfirmation, false);
	const interactive = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
		interactive: true,
	});
	assert.equal(interactive.needsConfirmation, true);
});

test("emulated without a warning stays a silent emulated pass", () => {
	const caps = fakeCapabilities({ readOnly: sdk.level("emulated", "probed") });
	const report = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
		interactive: true,
	});
	assert.equal(entry(report, "readOnly").outcome, "emulated");
	assert.equal(entry(report, "readOnly").emulatedBy, "executor");
	assert.deepEqual(report.degradations, []);
	assert.equal(report.needsConfirmation, false);
});

test("a warning on a native level does not degrade; an empty warning is ignored", () => {
	const native = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({
			contextIsolation: { level: "native", source: "probed", warning: "x" },
		}),
		{ readOnly: false, hasRequiredReads: false },
	);
	assert.equal(entry(native, "contextIsolation").outcome, "native");
	const empty = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ contextIsolation: warned("") }),
		{ readOnly: false, hasRequiredReads: false },
	);
	assert.equal(entry(empty, "contextIsolation").outcome, "emulated");
});

test("contextIsolation warning degrades even when inherit is off (required capability present)", () => {
	const report = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ contextIsolation: warned("global AGENTS.md") }),
		{ readOnly: false, hasRequiredReads: false },
	);
	assert.equal(report.accepted, true);
	assert.deepEqual(report.degradations, [
		"CAPABILITY_WARNING:contextIsolation",
	]);
});

test("strict: emulated is refused with CAPABILITY_STRICT; native passes; non-required keys are ignored", () => {
	const caps = fakeCapabilities({ readOnly: sdk.level("emulated") });
	const refused = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
		strict: ["readOnly"],
	});
	assert.equal(refused.accepted, false);
	assert.deepEqual(refused.refusals, ["CAPABILITY_STRICT:readOnly"]);
	assert.match(
		entry(refused, "readOnly").note,
		/must be native \(was emulated/,
	);
	assert.throws(
		() => sdk.assertAccepted(refused),
		(error) => sdk.isSdkError(error, "CAPABILITY_MISSING"),
	);
	const native = sdk.negotiateCapabilities(executor, fakeCapabilities(), {
		readOnly: true,
		hasRequiredReads: false,
		strict: ["readOnly", "contextIsolation"],
	});
	assert.equal(native.accepted, true);
	// readOnly is not required by a writable stage, so strict readOnly does not apply.
	const writable = sdk.negotiateCapabilities(executor, caps, {
		readOnly: false,
		hasRequiredReads: false,
		strict: ["readOnly"],
	});
	assert.equal(writable.accepted, true);
});

test("strict: warning-degraded, engine-emulated and readOnly-downgraded outcomes are refused", () => {
	const warning = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ readOnly: warned("allow rules") }),
		{ readOnly: true, hasRequiredReads: false, strict: ["readOnly"] },
	);
	assert.deepEqual(warning.refusals, ["CAPABILITY_STRICT:readOnly"]);
	assert.match(entry(warning, "readOnly").note, /allow rules/);
	const tokens = fakeCapabilities({
		usage: { level: "native", source: "declared", detail: "tokens" },
	});
	const cost = sdk.negotiateCapabilities(executor, tokens, {
		readOnly: false,
		hasRequiredReads: false,
		strict: ["usage"],
	});
	assert.deepEqual(cost.refusals, ["CAPABILITY_STRICT:usage.cost"]);
	const coarse = fakeCapabilities({
		toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
	});
	const downgraded = sdk.negotiateCapabilities(executor, coarse, {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["read", "bash"],
		allowReadOnlyDowngrade: true,
		strict: ["toolAllowlist"],
	});
	assert.deepEqual(downgraded.refusals, [
		"CAPABILITY_STRICT:toolAllowlist.fine",
	]);
	assert.throws(
		() =>
			sdk.negotiateCapabilities(executor, fakeCapabilities(), {
				readOnly: false,
				hasRequiredReads: false,
				strict: ["warpDrive"],
			}),
		(error) => sdk.isSdkError(error, "INVALID_REQUEST"),
	);
});

test("buildCapabilityPreview aggregates stages with labels", () => {
	const caps = fakeCapabilities({
		readOnly: warned("5 allow rules"),
		toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
	});
	const review = sdk.negotiateCapabilities(executor, caps, {
		readOnly: true,
		hasRequiredReads: false,
		interactive: true,
	});
	const write = sdk.negotiateCapabilities(executor, caps, {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["edit"],
		allowReadOnlyDowngrade: true,
		interactive: true,
	});
	const preview = sdk.buildCapabilityPreview(
		[
			{ label: "review", report: review },
			{ label: "write", report: write },
		],
		{ executor, header: ["  probe: fake-cli 1.0.0, auth ok"] },
	);
	assert.equal(preview.accepted, true);
	assert.equal(preview.needsConfirmation, true);
	assert.deepEqual(preview.degradations, [
		"review: CAPABILITY_WARNING:readOnly",
		"write: CAPABILITY_MISSING:toolAllowlist.fine",
	]);
	assert.deepEqual(preview.forcedReadOnly, ["write"]);
	const lines = preview.text.split("\n");
	assert.match(
		lines[0],
		/^Capability check \(fake@0\.1\.0, 2 stages\): accepted with 2 degradations; forced readOnly: write$/,
	);
	assert.equal(lines[1], "  probe: fake-cli 1.0.0, auth ok");
	assert.ok(
		lines.some(
			(line) =>
				line.includes("readOnly: degraded") && line.includes("5 allow rules"),
		),
	);
	const refused = sdk.buildCapabilityPreview([
		{
			label: "x",
			report: sdk.negotiateCapabilities(
				executor,
				fakeCapabilities({ readOnly: sdk.level("none") }),
				{ readOnly: true, hasRequiredReads: false, interactive: true },
			),
		},
	]);
	assert.equal(refused.accepted, false);
	assert.equal(refused.needsConfirmation, false);
	assert.deepEqual(refused.refusals, ["x: CAPABILITY_MISSING:readOnly"]);
	assert.match(refused.text, /REFUSED \(1\)/);
});
