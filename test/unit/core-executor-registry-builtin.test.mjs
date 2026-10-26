// The built-in Pi adapter (WP6) is registered as available: selecting "pi" yields a descriptor whose
// module a fresh process can load with the SDK loader (R#15), with matching id and version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { workflowExecutorRegistration } from "../../dist/core/executor-registry.js";
import { PI_EXECUTOR_VERSION } from "../../dist/executors/pi/version.js";

test("built-in pi executor is available with a loadable descriptor", () => {
	const registration = workflowExecutorRegistration("pi");
	assert.equal(registration?.unavailableReason, undefined);
	const descriptor = registration?.descriptor;
	assert.equal(descriptor?.id, "pi");
	assert.equal(descriptor?.version, PI_EXECUTOR_VERSION);
	assert.match(
		descriptor?.module ?? "",
		/^file:.*\/dist\/executors\/pi\/index\.js$/u,
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
	assert.deepEqual(JSON.parse(out), { id: "pi", version: PI_EXECUTOR_VERSION });
});

test("codex and claude stay unavailable until their adapters land", () => {
	for (const id of ["codex", "claude"]) {
		const registration = workflowExecutorRegistration(id);
		assert.equal(registration?.descriptor, undefined);
		assert.match(registration?.unavailableReason ?? "", /not implemented yet/u);
	}
});
