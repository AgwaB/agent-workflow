// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/process-role.ts. MIT, same author. Changes: env PI_WORKFLOW_ROLE→AGENT_WORKFLOW_ROLE; exported const PI_WORKFLOW_ROLE_ENV renamed AGENT_WORKFLOW_ROLE_ENV.
export const AGENT_WORKFLOW_ROLE_ENV = "AGENT_WORKFLOW_ROLE";

export type WorkflowProcessRole = "supervisor" | "worker" | "disabled";

export function getWorkflowProcessRole(
	env: NodeJS.ProcessEnv = process.env,
): WorkflowProcessRole {
	const raw = env[AGENT_WORKFLOW_ROLE_ENV]?.trim().toLowerCase();
	if (raw === "worker" || raw === "disabled" || raw === "supervisor")
		return raw;
	return "supervisor";
}

export function isWorkflowSupervisorEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return getWorkflowProcessRole(env) === "supervisor";
}

export function workflowWorkerEnvPrefix(): string {
	return `${AGENT_WORKFLOW_ROLE_ENV}=worker`;
}

export function assertWorkflowActionAllowedForRole(
	action: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const role = getWorkflowProcessRole(env);
	if (role === "supervisor") return;
	if (
		(action === "help" || action === "validate" || action === "board") &&
		role === "worker"
	)
		return;
	if (
		(action === "help" || action === "validate" || action === "board") &&
		role === "disabled"
	)
		return;
	throw new Error(
		`Workflow action "${action}" is not allowed when ${AGENT_WORKFLOW_ROLE_ENV}=${role}`,
	);
}

export function assertWorkflowToolAllowedForRole(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const role = getWorkflowProcessRole(env);
	if (role !== "supervisor")
		throw new Error(
			`Workflow tool is not allowed when ${AGENT_WORKFLOW_ROLE_ENV}=${role}`,
		);
}
