// 2026-10-31: recording a live process's identity retries a transient `unknown` (the Darwin helper
// timing out on a loaded machine failed a task launch with "Darwin process identity inspection
// failed: Command failed"); `dead` is final and a persistent `unknown` still fails with its reason.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	captureProcessIdentity,
	setProcessIdentityInspectorForTests,
} from "../../dist/runtime/process-identity.js";

const supported = process.platform === "darwin" || process.platform === "linux";

function inspector(results) {
	const calls = [];
	setProcessIdentityInspectorForTests(async (pid, inspect) => {
		calls.push(pid);
		const next = results.shift();
		return next === undefined ? inspect(pid) : next;
	});
	return calls;
}

test("a transient unknown is retried and the live identity is recorded", {
	skip: supported ? false : "process identity needs darwin or linux",
}, async (t) => {
	t.after(() => setProcessIdentityInspectorForTests(undefined));
	const calls = inspector([
		{ state: "unknown", reason: "helper timed out (simulated load)" },
	]);
	const identity = await captureProcessIdentity(process.pid);
	assert.equal(identity.pid, process.pid);
	assert.match(identity.birthIdentity, /^(darwin|linux):/u);
	assert.equal(calls.length, 2);
});

test("a persistent unknown fails with its reason after the bounded attempts", async (t) => {
	t.after(() => setProcessIdentityInspectorForTests(undefined));
	const unknown = {
		state: "unknown",
		reason: "helper timed out (simulated load)",
	};
	const calls = inspector([unknown, unknown, unknown, unknown]);
	await assert.rejects(
		captureProcessIdentity(process.pid),
		/helper timed out \(simulated load\)/u,
	);
	assert.equal(calls.length, 3);
});

test("dead is final: no retry", async (t) => {
	t.after(() => setProcessIdentityInspectorForTests(undefined));
	const calls = inspector([{ state: "dead" }]);
	await assert.rejects(
		captureProcessIdentity(process.pid),
		/process exited before its identity could be recorded/u,
	);
	assert.equal(calls.length, 1);
});
