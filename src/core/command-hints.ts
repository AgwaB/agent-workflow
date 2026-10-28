// New in agent-workflow (WP18b): the next-command hints that core run texts print (`Open: …`,
// `Resume: …`, `Logs: …`, stall warnings). Core formatters were ported from pi-workflow and printed
// its `/workflow …` slash commands everywhere; hosts now pass their own vocabulary through the host
// API (CLI `agent-workflow …`, Pi `/aw …`, MCP tool calls; src/hosts/hints.ts). The pi-workflow
// form stays the default of the core formatters so the ported core tests keep their texts.

/** One host's way to name the follow-up actions of a run. */
export interface WorkflowCommandHints {
	/** Show one run (status card). */
	status(runId: string): string;
	/** Wait for / keep driving a run. */
	wait(runId: string): string;
	/** Resume a failed, blocked or interrupted run. */
	resume(runId: string): string;
	/** Task logs; `task` may be a placeholder such as `<task-or-spec-id>`. */
	logs(runId: string, task?: string): string;
	/** The full record view. */
	raw(runId: string): string;
	/** Failed/blocked/interrupted task listing. */
	inspectFailures(runId: string): string;
	/** Stop (interrupt) a run. */
	stop(runId: string): string;
}

/** pi-workflow's `/workflow …` slash commands (default of the core formatters). */
export const PI_WORKFLOW_COMMAND_HINTS: WorkflowCommandHints = {
	status: (runId) => `/workflow ${runId}`,
	wait: (runId) => `/workflow status ${runId}`,
	resume: (runId) => `/workflow resume ${runId}`,
	logs: (runId, task) => `/workflow logs ${runId}${task ? ` ${task}` : ""}`,
	raw: (runId) => `/workflow show --raw ${runId}`,
	inspectFailures: (runId) => `/workflow logs ${runId}`,
	stop: (runId) => `/workflow stop ${runId}`,
};

/** Command-line hints for a command prefix (`agent-workflow`, `/aw`). */
export function commandLineHints(prefix: string): WorkflowCommandHints {
	return {
		status: (runId) => `${prefix} status ${runId}`,
		wait: (runId) => `${prefix} wait ${runId}`,
		resume: (runId) => `${prefix} resume ${runId}`,
		logs: (runId, task) =>
			`${prefix} logs ${runId}${task ? ` --task ${task}` : ""}`,
		raw: (runId) => `${prefix} show ${runId} --raw`,
		inspectFailures: (runId) => `${prefix} inspect ${runId} --failures`,
		stop: (runId) => `${prefix} stop ${runId}`,
	};
}

/**
 * Host-neutral resume hint for texts the engine persists (run/task messages are read later by any
 * host, so they cannot carry one host's vocabulary): the CLI command plus the Pi `/aw` form.
 */
export function persistedResumeHint(runId: string): string {
	return `agent-workflow resume ${runId} (Pi: /aw resume ${runId})`;
}
