// New in agent-workflow (WP39b, live bundle 5 O13): the capability preview of a launch whose
// stages are generated at run time (direct dynamic: no stage to negotiate up front) said
// "0 stages". It now says that stages are generated at run time and each is negotiated when
// generated. No agent CLI, no model call (an in-memory prober).
import assert from "node:assert/strict";
import { test } from "node:test";

const { negotiateWorkflowRun } = await import(
	"../../dist/core/capability-negotiation.js"
);
const { fakeCapabilities } = await import("../../dist/sdk/testing/index.js");

const descriptor = {
	id: "codex",
	version: "0.1.0",
	contractVersion: "0.1.0",
	module: "unused",
	config: null,
};
const policy = {
	interactive: false,
	allowUnverified: [],
	strict: [],
	allowReadOnlyDowngrade: false,
	permissionMode: "free",
};
const probe = { installed: true, cliVersion: "1.0.0", auth: "ok" };

test("a launch without up-front stages says they are generated at run time, not 0 stages", async () => {
	const negotiation = await negotiateWorkflowRun({
		descriptor,
		compiled: { tasks: [], stages: [], agentNotices: [] },
		policy,
		prober: async () => ({ probe, capabilities: fakeCapabilities() }),
	});
	const [first] = negotiation.preview.split("\n");
	assert.equal(
		first,
		"Capability check (codex@0.1.0, stages are generated at run time; each is negotiated when generated, permission mode: free): accepted",
	);
	assert.doesNotMatch(negotiation.preview, /\b0 stages\b/);
});
