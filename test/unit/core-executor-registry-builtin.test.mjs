// Built-in adapters that exist are registered as available: selecting their id yields a descriptor
// whose module a fresh process can load with the SDK loader (R#15), with matching id and version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
	BUILTIN_EXECUTOR_IDS,
	workflowExecutorRegistration,
} from "../../dist/core/executor-registry.js";
import { ACP_ADAPTER_VERSION } from "../../dist/executors/acp/version.js";
import { CLAUDE_ADAPTER_VERSION } from "../../dist/executors/claude/version.js";
import { CODEX_ADAPTER_VERSION } from "../../dist/executors/codex/version.js";
import { PI_EXECUTOR_VERSION } from "../../dist/executors/pi/version.js";

// [id, version, adapter directory]: antigravity is the ACP adapter's preset.
const BUILTINS = [
	["pi", PI_EXECUTOR_VERSION, "pi"],
	["claude", CLAUDE_ADAPTER_VERSION, "claude"],
	["codex", CODEX_ADAPTER_VERSION, "codex"],
	["antigravity", ACP_ADAPTER_VERSION, "acp"],
];

test("every built-in id has a test row", () => {
	assert.deepEqual(
		[...BUILTIN_EXECUTOR_IDS].sort(),
		BUILTINS.map(([id]) => id).sort(),
	);
});

for (const [id, version, dir] of BUILTINS) {
	test(`built-in ${id} executor is available with a loadable descriptor`, () => {
		const registration = workflowExecutorRegistration(id);
		assert.equal(registration?.unavailableReason, undefined);
		const descriptor = registration?.descriptor;
		assert.equal(descriptor?.id, id);
		assert.equal(descriptor?.version, version);
		assert.match(
			descriptor?.module ?? "",
			new RegExp(`^file:.*/dist/executors/${dir}/index\\.js$`, "u"),
		);
		const loaderUrl = new URL("../../dist/sdk/descriptor.js", import.meta.url)
			.href;
		const script = `const { loadExecutor } = await import(${JSON.stringify(loaderUrl)});
const executor = await loadExecutor(${JSON.stringify(descriptor)});
process.stdout.write(JSON.stringify({ id: executor.id, version: executor.version }));`;
		const out = execFileSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{ encoding: "utf8" },
		);
		assert.deepEqual(JSON.parse(out), { id, version });
	});
}

test("an unknown executor id has no registration", () => {
	assert.equal(workflowExecutorRegistration("nope"), undefined);
});
