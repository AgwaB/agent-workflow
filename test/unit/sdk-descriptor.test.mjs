import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import {
	createFakeExecutor,
	createFakeExecutorModule,
} from "../../dist/sdk/testing/index.js";

const testingUrl = new URL("../../dist/sdk/testing/index.js", import.meta.url)
	.href;
const sdkUrl = new URL("../../dist/sdk/index.js", import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), "aw-sdk-descriptor-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// An "external adapter" module on disk, as a third party would ship it.
const adapterPath = join(dir, "external-adapter.mjs");
writeFileSync(
	adapterPath,
	`import { createFakeExecutor } from ${JSON.stringify(testingUrl)};\n` +
		`export function createExecutor(config) { return createFakeExecutor({ id: config.id ?? "external", version: config.version ?? "1.2.0" }); }\n`,
);
const defaultExportPath = join(dir, "default-export.mjs");
writeFileSync(
	defaultExportPath,
	`import { createFakeExecutor } from ${JSON.stringify(testingUrl)};\nexport default { createExecutor: () => createFakeExecutor({ id: "dflt" }) };\n`,
);
const noFactoryPath = join(dir, "no-factory.mjs");
writeFileSync(noFactoryPath, "export const nothing = 1;\n");

const descriptor = (overrides = {}) => ({
	id: "external",
	version: "1.2.0",
	contractVersion: sdk.EXECUTOR_CONTRACT_VERSION,
	module: adapterPath,
	config: {},
	...overrides,
});

test("descriptor validation rejects relative modules and non-JSON config", () => {
	assert.deepEqual(sdk.validateExecutorDescriptor(descriptor()), []);
	assert.match(
		sdk
			.validateExecutorDescriptor(descriptor({ module: "./adapter.mjs" }))
			.join(),
		/relative/,
	);
	assert.match(
		sdk
			.validateExecutorDescriptor(descriptor({ config: { fn: () => 1 } }))
			.join(),
		/JSON/,
	);
	assert.match(
		sdk.validateExecutorDescriptor(descriptor({ version: "latest" })).join(),
		/semver/,
	);
	assert.throws(
		() => sdk.assertExecutorDescriptor({}),
		(error) => sdk.isSdkError(error, "DESCRIPTOR_INVALID"),
	);
});

test("describeExecutor captures id/version/contract from a live executor", () => {
	const executor = createFakeExecutor({ id: "pi-like", version: "0.3.1" });
	assert.deepEqual(
		sdk.describeExecutor(executor, "@agwab/agent-workflow/sdk/testing", {
			id: "pi-like",
		}),
		{
			id: "pi-like",
			version: "0.3.1",
			contractVersion: sdk.EXECUTOR_CONTRACT_VERSION,
			module: "@agwab/agent-workflow/sdk/testing",
			config: { id: "pi-like" },
		},
	);
});

test("loadExecutor imports by absolute path, file URL, default export, or registry", async () => {
	const fromPath = await sdk.loadExecutor(descriptor());
	assert.equal(fromPath.id, "external");
	const fromUrl = await sdk.loadExecutor(
		descriptor({
			module: new URL(`file://${adapterPath}`).href,
			version: "1.0.0",
		}),
	);
	assert.equal(
		fromUrl.version,
		"1.2.0",
		"same-major versions are compatible from 1.0",
	);
	assert.equal(
		(
			await sdk.loadExecutor(
				descriptor({ id: "dflt", version: "0.1.0", module: defaultExportPath }),
			)
		).id,
		"dflt",
	);
	const registry = sdk.createExecutorRegistry();
	registry.register("virtual:fake", createFakeExecutorModule());
	assert.equal(
		(
			await sdk.loadExecutor(
				descriptor({ id: "fake", version: "0.1.0", module: "virtual:fake" }),
				{ registry },
			)
		).id,
		"fake",
	);
	assert.throws(
		() => registry.register("bad", {}),
		(error) => sdk.isSdkError(error, "DESCRIPTOR_INVALID"),
	);
});

test("loadExecutor refuses instead of substituting", async () => {
	const cases = [
		[
			descriptor({ module: join(dir, "missing.mjs") }),
			"DESCRIPTOR_MODULE_NOT_FOUND",
		],
		[descriptor({ module: noFactoryPath }), "DESCRIPTOR_INVALID"],
		[descriptor({ id: "other" }), "DESCRIPTOR_ID_MISMATCH"],
		[descriptor({ version: "2.0.0" }), "DESCRIPTOR_VERSION_MISMATCH"],
		[
			descriptor({ config: { version: "0.9.0" }, version: "0.8.0" }),
			"DESCRIPTOR_VERSION_MISMATCH",
		],
		[descriptor({ contractVersion: "0.2.0" }), "CONTRACT_VERSION_MISMATCH"],
	];
	for (const [input, code] of cases)
		await assert.rejects(
			sdk.loadExecutor(input),
			(error) => sdk.isSdkError(error, code),
			code,
		);
});

test("detach rediscovery: a new process reloads the external adapter from the stored descriptor", () => {
	const stored = JSON.stringify(descriptor({ config: { id: "external" } }));
	const script = `
		import { loadExecutor, assertCapabilities } from ${JSON.stringify(sdkUrl)};
		const executor = await loadExecutor(JSON.parse(process.argv[1]));
		assertCapabilities(executor.capabilities());
		const probe = await executor.probe();
		process.stdout.write(JSON.stringify({ id: executor.id, version: executor.version, installed: probe.installed }));
	`;
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script, stored],
		{ encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		id: "external",
		version: "1.2.0",
		installed: true,
	});
});
