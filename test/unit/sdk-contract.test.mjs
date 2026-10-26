import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as sdk from "../../dist/sdk/index.js";
import * as testing from "../../dist/sdk/testing/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PI_SCOPE = ["@earendil", "works"].join("-");

function listFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

test("sdk and sdk/testing resolve through the package export map", async () => {
	const viaPackage = await import("@agwab/agent-workflow/sdk");
	const testingViaPackage = await import("@agwab/agent-workflow/sdk/testing");
	assert.equal(viaPackage.MODULE, "src/sdk");
	assert.equal(testingViaPackage.MODULE, "src/sdk/testing");
	assert.equal(typeof viaPackage.negotiateCapabilities, "function");
	assert.equal(typeof testingViaPackage.createFakeExecutor, "function");
	assert.equal(
		viaPackage.EXECUTOR_CONTRACT_VERSION,
		sdk.EXECUTOR_CONTRACT_VERSION,
	);
});

test("sdk sources and build output never reference the Pi package scope", () => {
	for (const dir of [join(root, "src", "sdk"), join(root, "dist", "sdk")])
		for (const file of listFiles(dir))
			assert.ok(!readFileSync(file, "utf8").includes(PI_SCOPE), file);
});

test("sdk declaration files expose no `any`", () => {
	for (const file of listFiles(join(root, "dist", "sdk")).filter((path) =>
		path.endsWith(".d.ts"),
	)) {
		const text = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		assert.doesNotMatch(text, /\bany\b/, file);
	}
});

test("contract version compatibility is semver-like (0.x pins minor)", () => {
	assert.equal(sdk.EXECUTOR_CONTRACT_VERSION, "0.1.0");
	assert.ok(sdk.isContractCompatible("0.1.7"));
	assert.ok(!sdk.isContractCompatible("0.2.0"));
	assert.ok(!sdk.isContractCompatible("1.1.0"));
	assert.ok(sdk.isVersionCompatible("1.2.0", "1.9.3"));
	assert.ok(!sdk.isVersionCompatible("1.2.0", "2.0.0"));
	assert.ok(!sdk.isVersionCompatible("1.2.0", "not-a-version"));
});

test("assertWorkflowExecutor accepts the fake and rejects incomplete or incompatible executors", () => {
	sdk.assertWorkflowExecutor(testing.createFakeExecutor());
	assert.throws(
		() =>
			sdk.assertWorkflowExecutor({
				id: "x",
				version: "0.1.0",
				contractVersion: "0.1.0",
			}),
		(error) => sdk.isSdkError(error, "DESCRIPTOR_INVALID"),
	);
	assert.throws(
		() =>
			sdk.assertWorkflowExecutor(
				testing.createFakeExecutor({ contractVersion: "9.0.0" }),
			),
		(error) => sdk.isSdkError(error, "CONTRACT_VERSION_MISMATCH"),
	);
});

test("validateSubmitRequest enforces attempt identity, explicit cwd, and no secrets on argv", () => {
	const gate = sdk.createAuthorityGate({ attemptKey: "a-1" });
	assert.deepEqual(
		sdk.validateSubmitRequest(testing.fakeSubmitRequest(gate)),
		[],
	);
	const other = sdk.createAuthorityGate({ attemptKey: "a-2" });
	const mismatched = {
		...testing.fakeSubmitRequest(gate),
		authority: other.authority,
	};
	assert.match(
		sdk.validateSubmitRequest(mismatched).join(),
		/authority\.attemptKey/,
	);
	assert.match(
		sdk
			.validateSubmitRequest(testing.fakeSubmitRequest(gate, { cwd: "" }))
			.join(),
		/cwd/,
	);
	const leaky = testing.fakeSubmitRequest(gate, {
		mcpServers: [
			{
				name: "artifact",
				command: "node",
				args: ["server.mjs", "--token=sk-secret-123"],
				env: { TOKEN: "sk-secret-123" },
			},
		],
	});
	assert.match(
		sdk.validateSubmitRequest(leaky).join(),
		/leaks env TOKEN on argv/,
	);
});

test("validateSubmitRequest accepts an absolute artifactsDir and rejects a relative one", () => {
	const gate = sdk.createAuthorityGate({ attemptKey: "a-3" });
	assert.deepEqual(
		sdk.validateSubmitRequest(
			testing.fakeSubmitRequest(gate, { artifactsDir: root }),
		),
		[],
	);
	assert.match(
		sdk
			.validateSubmitRequest(
				testing.fakeSubmitRequest(gate, { artifactsDir: "runs/attempt" }),
			)
			.join(),
		/artifactsDir must be an absolute path/,
	);
});

test("reconcile helpers distinguish unknown from absent", () => {
	assert.ok(sdk.isReconcileUnknown({ unknown: true }));
	assert.ok(!sdk.isReconcileUnknown({ absent: true }));
	assert.deepEqual(sdk.CANCEL_RESULTS, [
		"cancelled",
		"too_late",
		"unsupported",
		"uncertain",
		"no_active",
	]);
});

test("errors: classification tables default to unknown, and unknown is never auto-retried", () => {
	const rules = [
		{ class: "rate_limit", match: "429" },
		{ class: "auth", match: /not logged in/i },
		{ class: "config", match: "unknown model", exitCode: 2 },
		{ class: "transient", match: "ECONNRESET" },
	];
	assert.equal(
		sdk.classifyFailure("HTTP 429 Too Many Requests", rules),
		"rate_limit",
	);
	assert.equal(sdk.classifyFailure("Error: Not logged in", rules), "auth");
	assert.equal(
		sdk.classifyFailure({ message: "unknown model foo", exitCode: 2 }, rules),
		"config",
	);
	assert.equal(
		sdk.classifyFailure({ message: "unknown model foo", exitCode: 1 }, rules),
		"unknown",
	);
	assert.equal(sdk.classifyFailure("SSE header timeout", rules), "unknown");
	assert.ok(
		sdk.isAutoRetryable("transient") && sdk.isAutoRetryable("rate_limit"),
	);
	for (const cls of ["auth", "config", "permanent", "unknown"])
		assert.ok(!sdk.isAutoRetryable(cls), cls);
	const error = new sdk.SdkError("CAPABILITY_MISSING", "x", {
		subject: "toolAllowlist.fine",
	});
	assert.equal(error.qualifiedCode, "CAPABILITY_MISSING:toolAllowlist.fine");
});

test("approval policy never auto-allows, denies mutations in readOnly, and fails closed", async () => {
	const policy = sdk.defaultApprovalPolicy();
	assert.deepEqual(policy.allowKinds, []);
	assert.equal(
		sdk.decideApproval(policy, { kind: "read" }, { readOnly: false }),
		"deny",
	);
	assert.equal(
		sdk.decideApproval(
			{ ...policy, interactive: true },
			{ kind: "read" },
			{ readOnly: false },
		),
		"ask",
	);
	const allowExec = sdk.defaultApprovalPolicy({
		allowKinds: ["execute", "read"],
	});
	assert.equal(
		sdk.decideApproval(allowExec, { kind: "execute" }, { readOnly: true }),
		"deny",
	);
	assert.equal(
		sdk.decideApproval(allowExec, { kind: "execute" }, { readOnly: false }),
		"allow",
	);
	assert.equal(
		sdk.decideApproval(allowExec, { kind: "read" }, { readOnly: true }),
		"allow",
	);
	assert.equal(
		await sdk.awaitApprovalAnswer(new Promise(() => {}), { timeoutMs: 5 }),
		"deny",
	);
	assert.equal(
		await sdk.awaitApprovalAnswer(Promise.reject(new Error("host gone")), {
			timeoutMs: 1000,
		}),
		"deny",
	);
	assert.equal(
		await sdk.awaitApprovalAnswer(Promise.resolve("allow"), {
			timeoutMs: 1000,
		}),
		"allow",
	);
});
