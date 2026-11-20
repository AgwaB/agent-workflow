// Agent-workflow state is separate from Pi project state.
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/** Project-local state directory. */
export const PROJECT_STATE_DIRECTORY = ".agent-workflow";

/** Pi's own project state; excluded from runtime artifact scans (Pi is a supported host). */
export const PI_PROJECT_DIRECTORY = ".pi";

/**
 * Human-text form of a path the product created (a managed worktree): `~/<rest>` under the current
 * user's home, so the generic home-path redaction leaves it usable; otherwise unchanged.
 */
export function displayPathUnderHome(path: string): string {
	const home = homedir();
	if (!home) return path;
	const rel = relative(home, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return path;
	return `~/${rel.split("\\").join("/")}`;
}
