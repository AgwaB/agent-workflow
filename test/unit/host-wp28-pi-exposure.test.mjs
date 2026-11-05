// Deferred exposure registers aw_* tools with exposure deferred so tool_search
// loads them on demand. Absent or other settings keep default registration.
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
