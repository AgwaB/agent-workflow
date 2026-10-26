// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/pi-agent-dir.ts. MIT, same author. Changes: replaced piAgentDir (PI_CODING_AGENT_DIR or ~/.pi/agent) with agentWorkflowHome (AGENT_WORKFLOW_HOME or ~/.agent-workflow); the Pi directory survives only as a read-only legacy discovery root (F5).
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

/** Pi's own override for its config directory (`~/.pi/agent` by default). */
export const LEGACY_PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Legacy Pi per-user directory, used **read-only** by workflow-spec and agent
 * discovery so user-authored pi-workflow definitions keep working (F5). It
 * follows Pi's documented `PI_CODING_AGENT_DIR` override because that is where
 * Pi itself keeps those files. agent-workflow never writes here.
 */
export function legacyPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[LEGACY_PI_CODING_AGENT_DIR_ENV]?.trim();
	return override ? resolve(override) : join(homedir(), ".pi", "agent");
}

/** Project-local state directory (was `<project>/.pi`). */
export const PROJECT_STATE_DIRECTORY = ".agent-workflow";

/** Legacy project-local Pi directory; discovery reads it, nothing writes it. */
export const LEGACY_PROJECT_PI_DIRECTORY = ".pi";
