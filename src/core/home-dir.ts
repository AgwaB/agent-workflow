// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/pi-agent-dir.ts. MIT, same author. Changes: replaced piAgentDir (PI_CODING_AGENT_DIR or ~/.pi/agent) with agentWorkflowHome (AGENT_WORKFLOW_HOME or ~/.agent-workflow); Pi project state remains separate.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const AGENT_WORKFLOW_HOME_ENV = "AGENT_WORKFLOW_HOME";

/**
 * agent-workflow's per-user directory. Every user-scoped lookup and write
 * (user workflows, user agents, profile settings) uses this directory.
 */
export function agentWorkflowHome(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env[AGENT_WORKFLOW_HOME_ENV]?.trim();
	return override ? resolve(override) : join(homedir(), ".agent-workflow");
}

/** Project-local state directory (was `<project>/.pi`). */
export const PROJECT_STATE_DIRECTORY = ".agent-workflow";

/** Pi's own project state; excluded from runtime artifact scans (Pi is a supported host). */
export const PI_PROJECT_DIRECTORY = ".pi";
