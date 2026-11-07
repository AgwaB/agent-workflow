// New in agent-workflow (WP12d-1, stage-1 review #7): a forced readOnly downgrade negotiates the
// newly required `readOnly` capability with its normal strictness, warning and confirmation rules.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import { fakeCapabilities } from "../../dist/sdk/testing/index.js";

const executor = { id: "fake", version: "0.1.0" };
const coarse = { level: "native", source: "declared", detail: "coarse" };
const warned = {
	level: "emulated",
	source: "probed",
	warning: "2 allow rules",
};

function entry(report, key) {
	return report.entries.filter((item) => item.key === key);
}

const writable = {
	readOnly: false,
	hasRequiredReads: false,
	tools: ["read", "bash"],
	allowReadOnlyDowngrade: true,
};

test("forced readOnly + strict readOnly refuses an emulated (warned) readOnly", () => {
	const caps = fakeCapabilities({ toolAllowlist: coarse, readOnly: warned });
	const report = sdk.negotiateCapabilities(executor, caps, {
		...writable,
		strict: ["readOnly"],
	});
	assert.equal(report.accepted, false);
	assert.deepEqual(report.refusals, ["CAPABILITY_STRICT:readOnly"]);
	assert.equal(entry(report, "readOnly").length, 1);
	assert.throws(
		() => sdk.assertAccepted(report),
		(error) => sdk.isSdkError(error, "CAPABILITY_MISSING"),
	);
});

test("forced readOnly + strict readOnly refuses a plain emulated readOnly", () => {
	const caps = fakeCapabilities({
		toolAllowlist: coarse,
		readOnly: sdk.level("emulated", "probed"),
	});
	const report = sdk.negotiateCapabilities(executor, caps, {
		...writable,
		strict: ["readOnly"],
	});
	assert.equal(report.accepted, false);
	assert.deepEqual(report.refusals, ["CAPABILITY_STRICT:readOnly"]);
});

test("forced readOnly records the readOnly environment warning and asks interactively", () => {
	const caps = fakeCapabilities({ toolAllowlist: coarse, readOnly: warned });
	const report = sdk.negotiateCapabilities(executor, caps, writable);
	assert.equal(report.accepted, true);
	assert.equal(report.forcedReadOnly, true);
	const [readOnly] = entry(report, "readOnly");
	assert.equal(readOnly?.outcome, "degraded");
	assert.equal(readOnly?.code, "CAPABILITY_WARNING:readOnly");
	assert.equal(readOnly?.note, "2 allow rules");
	assert.deepEqual(report.degradations, [
		"CAPABILITY_MISSING:toolAllowlist.fine",
		"CAPABILITY_WARNING:readOnly",
	]);
	assert.equal(report.needsConfirmation, undefined);
	assert.equal(
		sdk.negotiateCapabilities(executor, caps, {
			...writable,
			interactive: true,
		}).needsConfirmation,
		undefined,
	);
});

test("forced readOnly with a native readOnly stays accepted under strict readOnly", () => {
	const caps = fakeCapabilities({
		toolAllowlist: coarse,
		readOnly: sdk.level("native", "probed"),
	});
	const report = sdk.negotiateCapabilities(executor, caps, {
		...writable,
		strict: ["readOnly"],
	});
	assert.equal(report.accepted, true);
	assert.equal(report.forcedReadOnly, true);
	assert.equal(entry(report, "readOnly")[0]?.outcome, "native");
});

test("an unmapped-tool forced readOnly is negotiated the same way", () => {
	const caps = fakeCapabilities({ readOnly: warned });
	const report = sdk.negotiateCapabilities(executor, caps, {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["read", "custom_tool"],
		toolMapping: {
			executorId: "fake",
			entries: { read: { type: "tool", names: ["Read"] } },
		},
		allowReadOnlyDowngrade: true,
		strict: ["readOnly"],
	});
	assert.equal(report.accepted, false);
	assert.deepEqual(report.refusals, ["CAPABILITY_STRICT:readOnly"]);
});

test("a stage that is already readOnly gets exactly one readOnly entry", () => {
	const caps = fakeCapabilities({ toolAllowlist: coarse, readOnly: warned });
	const report = sdk.negotiateCapabilities(executor, caps, {
		...writable,
		readOnly: true,
	});
	assert.equal(entry(report, "readOnly").length, 1);
});
