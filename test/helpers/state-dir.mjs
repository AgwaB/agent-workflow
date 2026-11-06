// Shared run-state base. The suite runner supplies an isolated AGENT_WORKFLOW_HOME.
import { mkdirSync } from "node:fs";
import { stateBase } from "../../dist/core/state-location.js";

export function stateDir(projectCwd) {
	if (!process.env.AGENT_WORKFLOW_HOME)
		throw new Error(
			"Tests must isolate AGENT_WORKFLOW_HOME before using stateDir",
		);
	const base = stateBase(projectCwd);
	mkdirSync(base, { recursive: true, mode: 0o700 });
	return base;
}
