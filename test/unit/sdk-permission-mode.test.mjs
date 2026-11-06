// New in agent-workflow (WP4e, D2 revised): SDK permission mode — request field and default,
// approval decisions per mode, negotiation in free mode (coarse allowlist and environment
// warnings are recorded degradations, never refusals or confirmations), and the preview line.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import * as testing from "../../dist/sdk/testing/index.js";

const { fakeCapabilities } = testing;

const executor = { id: "fake", version: "0.1.0" };
const coarse = fakeCapabilities({
	toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
});
const warned = (warning) => ({ level: "emulated", source: "probed", warning });
const entry = (report, key) => report.entries.find((item) => item.key === key);

function request(overrides = {}) {
	const attemptKey = "a1";
	return {
		attemptKey,
		authority: { attemptKey, consume: async () => ({ kind: "released" }) },
		cwd: "/tmp",
		prompt: "p",
		tools: [],
		readOnly: false,
		mcpServers: [],
		deadlineMs: Date.now() + 1000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: sdk.defaultApprovalPolicy(),
		...overrides,
	};
}

test("SubmitRequest.permissionMode: optional, validated, absent means safe", () => {
	assert.deepEqual(sdk.PERMISSION_MODES, ["free", "safe"]);
	assert.equal(sdk.SDK_DEFAULT_PERMISSION_MODE, "safe");
	assert.equal(sdk.ENGINE_DEFAULT_PERMISSION_MODE, "free");
	assert.equal(sdk.effectivePermissionMode(request()), "safe");
	assert.equal(
		sdk.effectivePermissionMode(request({ permissionMode: "free" })),
		"free",
	);
	assert.deepEqual(sdk.validateSubmitRequest(request()), []);
	for (const mode of ["free", "safe"])
		assert.deepEqual(
			sdk.validateSubmitRequest(request({ permissionMode: mode })),
			[],
		);
	assert.match(
		sdk.validateSubmitRequest(request({ permissionMode: "yolo" })).join(),
		/permissionMode must be "free" or "safe"/,
	);
	// Unrestricted only for free on a stage that is not readOnly.
	assert.equal(
		sdk.isUnrestricted({ permissionMode: "free", readOnly: false }),
		true,
	);
	assert.equal(
		sdk.isUnrestricted({ permissionMode: "free", readOnly: true }),
		false,
	);
	assert.equal(
		sdk.isUnrestricted({ permissionMode: "safe", readOnly: false }),
		false,
	);
	assert.equal(sdk.isUnrestricted({ readOnly: false }), false);
});

test("decideApproval: free allows everything except mutating kinds on a readOnly stage; safe/absent unchanged", () => {
	const policy = sdk.defaultApprovalPolicy();
	for (const kind of ["read", "execute", "edit", "fetch", "other"])
		assert.equal(
			sdk.decideApproval(
				policy,
				{ kind },
				{ readOnly: false, permissionMode: "free" },
			),
			"allow",
			kind,
		);
	assert.equal(
		sdk.decideApproval(
			policy,
			{ kind: "edit" },
			{ readOnly: true, permissionMode: "free" },
		),
		"deny",
	);
	assert.equal(
		sdk.decideApproval(
			policy,
			{ kind: "read" },
			{ readOnly: true, permissionMode: "free" },
		),
		"allow",
	);
	for (const stage of [
		{ readOnly: false },
		{ readOnly: false, permissionMode: "safe" },
	]) {
		assert.equal(sdk.decideApproval(policy, { kind: "read" }, stage), "deny");
		assert.equal(
			sdk.decideApproval(
				{ ...policy, interactive: true },
				{ kind: "execute" },
				stage,
			),
			"ask",
		);
	}
});

test("negotiation: coarse allowlist refuses in safe, degrades (recorded, no forced readOnly) in free", () => {
	const ctx = {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["read", "bash"],
	};
	for (const safe of [ctx, { ...ctx, permissionMode: "safe" }]) {
		const refused = sdk.negotiateCapabilities(executor, coarse, safe);
		assert.equal(refused.accepted, false);
		assert.deepEqual(refused.refusals, [
			"CAPABILITY_MISSING:toolAllowlist.fine",
		]);
	}
	const free = sdk.negotiateCapabilities(executor, coarse, {
		...ctx,
		permissionMode: "free",
		interactive: true,
		strict: ["toolAllowlist"],
	});
	assert.equal(free.accepted, true);
	assert.equal(free.forcedReadOnly, false);
	assert.equal(free.needsConfirmation, undefined, "free never asks for these");
	assert.equal(free.permissionMode, "free");
	const allowlist = entry(free, "toolAllowlist.fine");
	assert.equal(allowlist.outcome, "degraded");
	assert.equal(allowlist.code, "CAPABILITY_MISSING:toolAllowlist.fine");
	assert.equal(allowlist.acceptedByFreeMode, true);
	assert.match(allowlist.note, /free permission mode/);
	assert.deepEqual(free.degradations, [
		"CAPABILITY_MISSING:toolAllowlist.fine",
	]);
	// safe with the spec opt-in keeps the WP4d readOnly downgrade.
	const downgraded = sdk.negotiateCapabilities(executor, coarse, {
		...ctx,
		permissionMode: "safe",
		allowReadOnlyDowngrade: true,
	});
	assert.equal(downgraded.forcedReadOnly, true);
});

test("negotiation: environment warnings in free are recorded, never strict-refused or confirmed; readOnly stays required", () => {
	const caps = fakeCapabilities({ readOnly: warned("151 allow rules") });
	const ctx = {
		readOnly: true,
		hasRequiredReads: false,
		strict: ["readOnly"],
		interactive: true,
	};
	const safe = sdk.negotiateCapabilities(executor, caps, {
		...ctx,
		permissionMode: "safe",
	});
	assert.deepEqual(safe.refusals, ["CAPABILITY_STRICT:readOnly"]);
	const free = sdk.negotiateCapabilities(executor, caps, {
		...ctx,
		permissionMode: "free",
	});
	assert.equal(free.accepted, true);
	assert.equal(free.needsConfirmation, undefined);
	assert.equal(entry(free, "readOnly").code, "CAPABILITY_WARNING:readOnly");
	assert.equal(entry(free, "readOnly").acceptedByFreeMode, true);
	// Other degradations still follow B4 in free (interactive confirmation).
	const partial = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ partialStream: { level: "none", source: "declared" } }),
		{
			readOnly: true,
			hasRequiredReads: false,
			partialStream: true,
			interactive: true,
			permissionMode: "free",
		},
	);
	assert.equal(partial.needsConfirmation, undefined);
	// A missing readOnly capability is refused in free too.
	const none = sdk.negotiateCapabilities(
		executor,
		fakeCapabilities({ readOnly: { level: "none", source: "declared" } }),
		{ readOnly: true, hasRequiredReads: false, permissionMode: "free" },
	);
	assert.deepEqual(none.refusals, ["CAPABILITY_MISSING:readOnly"]);
});

test("buildCapabilityPreview shows the permission mode on the first line", () => {
	const report = sdk.negotiateCapabilities(executor, coarse, {
		readOnly: false,
		hasRequiredReads: false,
		tools: ["bash"],
		permissionMode: "free",
	});
	const preview = sdk.buildCapabilityPreview([{ label: "s", report }], {
		executor,
		permissionMode: "free",
	});
	assert.match(
		preview.text.split("\n")[0],
		/^Capability check \(fake@0\.1\.0, 1 stage, permission mode: free\): accepted with 1 degradation$/,
	);
	assert.match(
		preview.text,
		/toolAllowlist\.fine: degraded \(accepted: free mode\)/,
	);
	const legacy = sdk.buildCapabilityPreview([{ label: "s", report }], {
		executor,
	});
	assert.doesNotMatch(legacy.text.split("\n")[0], /permission mode/);
});

test("fake executor maps both modes to distinct synthetic launch settings", () => {
	const { fakeLaunchArgv, FAKE_PERMISSION_MODE_SETTINGS } = testing;
	assert.deepEqual(
		fakeLaunchArgv({ permissionMode: "free", readOnly: false }).slice(1),
		[...FAKE_PERMISSION_MODE_SETTINGS.free],
	);
	assert.deepEqual(
		fakeLaunchArgv({ permissionMode: "safe", readOnly: false }).slice(1),
		[...FAKE_PERMISSION_MODE_SETTINGS.safe],
	);
	assert.deepEqual(fakeLaunchArgv({ readOnly: false }).slice(1), [
		...FAKE_PERMISSION_MODE_SETTINGS.safe,
	]);
	assert.deepEqual(
		fakeLaunchArgv({ permissionMode: "free", readOnly: true }).slice(1),
		[...FAKE_PERMISSION_MODE_SETTINGS.readOnly],
	);
});
