// agent-workflow 2026-11-04 (host × executor live matrix): every Antigravity launch from a Claude Code
// host stopped to ask "a repair starts a new session — OK?", although repairs start a fresh attempt
// on every executor unless the run enables the experimental same-session repair. A stage needs
// `resume` only in such a run; otherwise a missing `resume` is not negotiated at all.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import { fakeCapabilities } from "../../dist/sdk/testing/index.js";

const { workflowTaskRequirementContext } = await import(
	"../../dist/core/capability-negotiation.js"
);

const executor = { id: "fake", version: "0.1.0" };
const noResume = fakeCapabilities({
	resume: { level: "none", source: "declared" },
});
const task = {
	id: "a.main",
	runtime: { tools: ["read"] },
	safety: { readOnlyDeclared: true, capability: "read-only" },
	artifactGraph: { enabled: true, requiredReads: [], output: {} },
};
const policy = {
	interactive: true,
	allowUnverified: [],
	strict: [],
	allowReadOnlyDowngrade: false,
	permissionMode: "free",
};

test("resume is negotiated only when the run uses the experimental same-session repair", () => {
	const off = sdk.negotiateCapabilities(
		executor,
		noResume,
		workflowTaskRequirementContext(task, policy),
	);
	assert.equal(
		off.entries.find((entry) => entry.key === "resume"),
		undefined,
	);
	assert.equal(off.needsConfirmation, false);

	const on = sdk.negotiateCapabilities(
		executor,
		noResume,
		workflowTaskRequirementContext(task, {
			...policy,
			sameSessionRepair: true,
		}),
	);
	const resume = on.entries.find((entry) => entry.key === "resume");
	assert.equal(resume?.outcome, "degraded");
	assert.equal(on.needsConfirmation, true);
});
