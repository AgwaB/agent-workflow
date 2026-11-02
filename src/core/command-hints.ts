// New in agent-workflow (WP18b): the next-command hints that core run texts print (`Open: …`,
// `Resume: …`, `Logs: …`, stall warnings). Hosts pass their own vocabulary through the host API
// (CLI `agent-workflow …`, Pi `/aw …`, MCP tool calls; src/hosts/hints.ts); the CLI form is the
// default of the core formatters.

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

/** The CLI form: the default of the core formatters (and the CLI host's hints). */
export const DEFAULT_COMMAND_HINTS: WorkflowCommandHints =
	commandLineHints("agent-workflow");

/**
 * Host-neutral command for texts that cannot know the host (core errors, persisted run/task
 * messages read later by any host): the CLI command plus the Pi `/aw` form.
 */
export function neutralCommand(args: string): string {
	return `agent-workflow ${args} (Pi: /aw ${args})`;
}

/** Host-neutral resume hint for texts the engine persists. */
export function persistedResumeHint(runId: string): string {
	return neutralCommand(`resume ${runId}`);
}
