// A host's model/thinking defaults belong to one executor (the Pi host passes Pi's current model as
// "pi"). When the run selects a different executor (e.g. through a saved or declared profile the host
// cannot see), those defaults must not reach the other executor's workers.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runtimeDefaultsForExecutor } from "../../dist/core/workflow-runtime.js";

test("defaults tagged for pi apply to pi and are dropped for other executors", () => {
	const piDefaults = {
		model: "openai-codex/gpt-6.1-sol",
		thinking: "medium",
		fast: "on",
		executor: "pi",
	};
	assert.deepEqual(runtimeDefaultsForExecutor(piDefaults, "pi"), piDefaults);
	assert.deepEqual(runtimeDefaultsForExecutor(piDefaults, "claude"), {
		fast: "on",
		executor: "pi",
	});
	assert.deepEqual(
		runtimeDefaultsForExecutor({ model: "x", executor: "pi" }, "codex"),
		{ executor: "pi" },
	);
});

test("untagged defaults keep the previous behavior", () => {
	const untagged = { model: "m", thinking: "low" };
	assert.deepEqual(runtimeDefaultsForExecutor(untagged, "codex"), untagged);
	assert.equal(runtimeDefaultsForExecutor(undefined, "pi"), undefined);
});
