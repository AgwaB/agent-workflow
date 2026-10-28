// New in agent-workflow (WP28): opt-in deferred exposure of the Pi host's `aw_*` tools
// (AGENT_WORKFLOW_TOOL_EXPOSURE=deferred; port of pi-workflow b83cc4f PI_WORKFLOW_TOOL_EXPOSURE):
// with it every tool is registered with `exposure: "deferred"` (Pi keeps it out of each request
// until `tool_search` loads it); without it, or with any other value, tools are registered as before.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakePi } from "../helpers/pi-host-fake.mjs";

const ext = await import("../../dist/hosts/pi/extension.js");
const names = await import("../../dist/hosts/pi/names.js");

function register(extra) {
	const env = { ...process.env, ...extra };
	delete env.AGENT_WORKFLOW_ROLE;
	if (!("AGENT_WORKFLOW_TOOL_EXPOSURE" in extra))
		delete env.AGENT_WORKFLOW_TOOL_EXPOSURE;
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env })(pi);
	return pi;
}

test("aw_* tools defer only when AGENT_WORKFLOW_TOOL_EXPOSURE=deferred", () => {
	const direct = register({});
	assert.deepEqual([...direct.tools.keys()], [...names.AW_TOOL_NAMES]);
	for (const tool of direct.tools.values())
		assert.equal("exposure" in tool, false, tool.name);

	const deferred = register({ AGENT_WORKFLOW_TOOL_EXPOSURE: "deferred" });
	assert.deepEqual([...deferred.tools.keys()], [...names.AW_TOOL_NAMES]);
	for (const tool of deferred.tools.values())
		assert.equal(tool.exposure, "deferred", tool.name);
	// The command is not a tool and is unaffected.
	assert.ok(deferred.commands.has("aw"));

	for (const value of ["", "eager", "Deferred", "1"]) {
		const other = register({ AGENT_WORKFLOW_TOOL_EXPOSURE: value });
		for (const tool of other.tools.values())
			assert.equal("exposure" in tool, false, `${value}: ${tool.name}`);
	}
});

test("worker processes register no tools, deferred or not", () => {
	const env = {
		...process.env,
		AGENT_WORKFLOW_ROLE: "worker",
		AGENT_WORKFLOW_TOOL_EXPOSURE: "deferred",
	};
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env })(pi);
	assert.equal(pi.tools.size, 0);
});
