// New in agent-workflow (WP18b): the host's command vocabulary for the next-step hints of the core
// run texts (`Open: …`, `Resume: …`, `Logs: …`, stall warnings). Handlers pick the hints from
// `ctx.host`, so every host gets its own commands from the same host API call and no host rewrites
// handler text: the CLI (and an unknown host) `agent-workflow …`, the Pi host `/aw …`, host MCP
// clients (Claude Code, Codex, generic) the `workflow_*` tool calls. WP28: every CLI command has an
// MCP tool, so resume and the raw run view name `workflow_resume` and `workflow_show`.
import {
	commandLineHints,
	DEFAULT_COMMAND_HINTS,
	type WorkflowCommandHints,
} from "../core/command-hints.js";
import type { WorkflowHostId } from "../core/types.js";

export type { WorkflowCommandHints } from "../core/command-hints.js";

export const CLI_COMMAND_HINTS: WorkflowCommandHints = DEFAULT_COMMAND_HINTS;
export const PI_COMMAND_HINTS: WorkflowCommandHints = commandLineHints("/aw");

function toolCall(tool: string, args: Record<string, unknown>): string {
	return `${tool} ${JSON.stringify(args)}`;
}

/** Host MCP tool calls (names match src/mcp/host-server/tools.ts; checked by a unit test). */
export const MCP_COMMAND_HINTS: WorkflowCommandHints = {
	status: (runId) => toolCall("workflow_status", { runId }),
	wait: (runId) => toolCall("workflow_wait", { runId }),
	resume: (runId) => toolCall("workflow_resume", { runId }),
	logs: (runId, task) =>
		toolCall("workflow_logs", task ? { runId, task } : { runId }),
	raw: (runId) => toolCall("workflow_show", { ref: runId, raw: true }),
	inspectFailures: (runId) =>
		toolCall("workflow_inspect", { runId, failures: true }),
	stop: (runId) => toolCall("workflow_stop", { runId }),
};

/** The command hints of one host (`ctx.host`); absent → the CLI form. */
export function hostCommandHints(
	host: WorkflowHostId | undefined,
): WorkflowCommandHints {
	if (host === "pi") return PI_COMMAND_HINTS;
	if (host === "claude-code" || host === "codex" || host === "generic")
		return MCP_COMMAND_HINTS;
	return CLI_COMMAND_HINTS;
}

/** WP29: one open dynamic-controller approval as hosts show it (src/core/dynamic-approval.ts). */
export interface PendingApprovalHint {
	requestId: string;
	controllerSpecId: string;
	message: string;
}

/**
 * WP29: the host's command to answer one open approval: `agent-workflow approve <run>` (CLI), `/aw
 * approve <run>` (Pi), the `workflow_approve` tool call (MCP). `--reject` / `decision: "reject"`
 * rejects it.
 */
export function hostApproveHint(
	host: WorkflowHostId | undefined,
	runId: string,
	requestId: string,
	decision: "approve" | "reject" = "approve",
): string {
	if (host === "claude-code" || host === "codex" || host === "generic")
		return toolCall("workflow_approve", { runId, requestId, decision });
	const prefix = host === "pi" ? "/aw" : "agent-workflow";
	return `${prefix} approve ${runId} --request ${requestId.slice(0, 12)}${decision === "reject" ? " --reject" : ""}`;
}

/** WP29: the text block of a run's open approvals (status and wait results). */
export function pendingApprovalLines(
	host: WorkflowHostId | undefined,
	runId: string,
	pending: readonly PendingApprovalHint[],
): string[] {
	return pending.flatMap((approval) => [
		"",
		`Awaiting approval: dynamic controller ${approval.controllerSpecId} (request ${approval.requestId})`,
		...approval.message.split("\n").map((line) => `  ${line}`),
		`Approve: ${hostApproveHint(host, runId, approval.requestId)}`,
		`Reject: ${hostApproveHint(host, runId, approval.requestId, "reject")}`,
	]);
}
