// New in agent-workflow (WP13): the `agent-workflow` host MCP server's tools for agent hosts
// (Claude Code, Codex): workflow_list, workflow_run, workflow_dynamic, workflow_status,
// workflow_wait, workflow_stop, workflow_inspect, workflow_logs (WP18b), workflow_validate. Each is a thin call into one
// host API handler (src/hosts/api.ts). Schemas and wording follow the Pi host's `aw_*` tools
// (src/hosts/pi/tools.ts); differences: `detach` defaults to true (MCP calls are time-limited),
// every tool takes an optional `cwd` below the server's root, and degradation confirmation goes
// through MCP elicitation when the client supports it. docs/host-mcp.md.
// WP28 (owner decision Q7): every CLI command is a tool: workflow_resume, workflow_show,
// workflow_roles, workflow_agents, workflow_notices, workflow_doctor, workflow_prune,
// workflow_profile and workflow_supervise (detached). Changing calls (prune without dry run,
// profile set/delete/default/clear-default, notices acknowledge/clear) act only after an MCP
// elicitation confirmation; a client without form elicitation is refused with the terminal CLI
// command, and a declined/cancelled/failed elicitation changes nothing.
// WP36: the instructions and the still-running wait footer name `agent-workflow watch`, the Claude
// Code status line and the notify-check completion line.
// WP31: workflow_profile set takes `preset` and `roles` (role → executor/model/effort), op `presets`
// lists the built-in executor presets.
// WP29 (parity row 43): workflow_approve answers a dynamic-controller approval a run is blocked on.
// The server can ask its user only during a tool call, so it never approves while it drives a run:
// workflow_status/workflow_wait show the open approval (question + request id) and the agent calls
// workflow_approve after the user decided; the tool asks the user again through elicitation before
// anything is recorded (accept = as decided; declining the approval question rejects it for the run,
// pi-workflow's "no"; cancel/failure changes nothing) and refuses clients without elicitation.
// WP32 (owner decision Q5): workflow_auto recommends a workflow for a task. Before its one
// classifier call it asks the user's consent through elicitation (showing the task, the candidates
// and the classifier executor/model); a second elicitation (a form with one enum field) is the
// final choice among the ranked workflows, which then start through the normal launch path. A client
// without elicitation gets the local routing-only shortlist and no call; declining the choice
// returns the ranked list and starts nothing.
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import * as hostApi from "../../hosts/api.js";
import {
	ensureDashboard,
	launchConsumed,
	mintLaunchUrl,
	openInBrowser,
} from "../../hosts/dashboard/discovery.js";
import { assertActionAllowed } from "../../hosts/types.js";
import {
	awaitHostSessionMonitor,
	hostSessionMonitorAlive,
	isHostSessionId,
	monitorStartsWithRun,
	recordRunHostSession,
} from "../../hosts/notify-check.js";
import { codexTurnSession, hostWakeEnabled } from "../../hosts/host-wake.js";
import { WORKFLOW_DASHBOARD_TOOL } from "../visible-names.js";
export { WORKFLOW_DASHBOARD_TOOL } from "../visible-names.js";
import type {
	HostAction,
	HostApiContext,
	HostResult,
	InspectData,
	LaunchData,
	LaunchRequestBase,
	WaitData,
} from "../../hosts/api.js";
import { EXECUTOR_PRESET_IDS } from "../../core/executor-presets.js";
import {
	formatRoleAssignment,
	parseWorkflowRoleMap,
} from "../../core/role-profiles.js";
import { THINKING_LEVELS, WorkflowValidationError } from "../../core/types.js";
import { parseWorkflowNoticesArgs } from "../../core/workflow-notices.js";
import type { CapabilityPreview } from "../../sdk/requirements.js";
import {
	mcpVersionHasToolAnnotations,
	mcpVersionHasToolTitle,
} from "../artifact-server/protocol.js";
import { asRecord, type McpToolCallContext } from "../stdio-server.js";
import { runProject } from "../../hosts/project-root.js";

export const HOST_MCP_SERVER_NAME = "agent-workflow";

/** Hosts the server can be started for (`--host`); passed to the host API as `ctx.host`. */
export const HOST_MCP_HOSTS = ["claude-code", "codex", "generic"] as const;
export type HostMcpHost = (typeof HOST_MCP_HOSTS)[number];

/**
 * WP18b: hosts whose host API results get text `content` only, without `structuredContent`. Live bundle 4
 * (Claude Code 2.1.310, docs/live-acceptance-stage2.md case 1): Claude Code hands the model the
 * serialized `structuredContent` JSON instead of the `content` text when both are present, so every
 * result reached the model twice (`data` plus the same `text`). The tools declare no
 * `outputSchema`, so `structuredContent` is optional (MCP 2025-06-18). Codex and generic clients
 * keep it (not observed live yet; structured clients can use `data`).
 */
export const HOST_MCP_TEXT_ONLY_HOSTS: readonly HostMcpHost[] = ["claude-code"];

/** Whether host API results for this host and protocol revision carry `structuredContent`. */
export function hostMcpSendsStructuredContent(
	host: HostMcpHost,
	protocolVersion: string,
): boolean {
	return (
		mcpVersionHasStructuredContent(protocolVersion) &&
		!HOST_MCP_TEXT_ONLY_HOSTS.includes(host)
	);
}

export const WORKFLOW_LIST_TOOL = "workflow_list";
export const WORKFLOW_RUN_TOOL = "workflow_run";
export const WORKFLOW_DYNAMIC_TOOL = "workflow_dynamic";
export const WORKFLOW_STATUS_TOOL = "workflow_status";
export const WORKFLOW_WAIT_TOOL = "workflow_wait";
export const WORKFLOW_STOP_TOOL = "workflow_stop";
export const WORKFLOW_INSPECT_TOOL = "workflow_inspect";
export const WORKFLOW_VALIDATE_TOOL = "workflow_validate";
export const WORKFLOW_CHECK_TOOL = "workflow_check";
export const WORKFLOW_LOGS_TOOL = "workflow_logs";
export const WORKFLOW_RESUME_TOOL = "workflow_resume";
export const WORKFLOW_SHOW_TOOL = "workflow_show";
export const WORKFLOW_ROLES_TOOL = "workflow_roles";
export const WORKFLOW_AGENTS_TOOL = "workflow_agents";
export const WORKFLOW_NOTICES_TOOL = "workflow_notices";
export const WORKFLOW_DOCTOR_TOOL = "workflow_doctor";
export const WORKFLOW_PRUNE_TOOL = "workflow_prune";
export const WORKFLOW_PROFILE_TOOL = "workflow_profile";
export const WORKFLOW_SUPERVISE_TOOL = "workflow_supervise";
export const WORKFLOW_APPROVE_TOOL = "workflow_approve";
export const WORKFLOW_AUTO_TOOL = "workflow_auto";

/** WP28: tool calls that change state only after the user confirms through MCP elicitation. */
export const CONFIRMED_CHANGES = [
	`${WORKFLOW_PRUNE_TOOL} (dryRun=false)`,
	`${WORKFLOW_PROFILE_TOOL} (set, delete, default, clear-default)`,
	`${WORKFLOW_NOTICES_TOOL} (acknowledge, clear)`,
	`${WORKFLOW_APPROVE_TOOL} (approve, reject)`,
] as const;

/** WP32: tool calls that send a classifier request only after the user's elicitation consent. */
export const CONSENTED_CALLS = [
	`${WORKFLOW_AUTO_TOOL} (one classifier request with the task)`,
] as const;

/** Bound of one tool result's text (the list action bounds itself the same way). */
export const HOST_MCP_MAX_TEXT_CHARS = 50_000;

export const DEGRADATION_ELICITATION_TITLE =
	"Proceed with these executor capability degradations?";

/** Claude Code's MCP tool-call limit when neither MCP_TOOL_TIMEOUT nor a per-server timeout is set (2.1.318). */
export const CLAUDE_CODE_DEFAULT_TOOL_TIMEOUT_MS = 100_000_000;
/** Room left between one wait and the host's per-call limit. */
const WAIT_LIMIT_MARGIN_MS = 120_000;

/**
 * 2026-11-05 (owner: fewer host model turns while waiting): the bound of one workflow_wait call. 45 s
 * unless the host's per-call limit is known to be long, then up to 30 min (2 min below the limit):
 * Claude Code (host claude-code, CLAUDECODE=1 in the server's environment) allows MCP_TOOL_TIMEOUT or
 * 100,000,000 ms — live: in print mode a 150 s call returned normally; in an interactive session
 * Claude Code moved it to the background at 120 s, the turn ended, and its completion woke the
 * session. `toolTimeoutMs` is a limit the plugin set itself (`--tool-timeout-ms`, Codex
 * tool_timeout_sec). Other hosts (the Claude desktop app's chat, hand registrations) keep 45 s.
 */
export function hostMcpWaitSliceMs(options: {
	host: HostMcpHost;
	env: NodeJS.ProcessEnv;
	toolTimeoutMs?: number;
}): number {
	let limit = options.toolTimeoutMs;
	if (
		limit === undefined &&
		options.host === "claude-code" &&
		options.env.CLAUDECODE === "1"
	) {
		const configured = Number(options.env.MCP_TOOL_TIMEOUT);
		limit =
			Number.isFinite(configured) && configured >= 1000
				? configured
				: CLAUDE_CODE_DEFAULT_TOOL_TIMEOUT_MS;
	}
	if (
		limit === undefined ||
		limit - WAIT_LIMIT_MARGIN_MS <= hostApi.HOST_WAIT_MAX_TIMEOUT_MS
	)
		return hostApi.HOST_WAIT_MAX_TIMEOUT_MS;
	return Math.min(
		hostApi.HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS,
		limit - WAIT_LIMIT_MARGIN_MS,
	);
}

/** "45 s", "30 min". */
function waitBound(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)} s`
		: `${Math.round(ms / 60_000)} min`;
}

/**
 * Server instructions. Claude Code keeps only the first 4,096 characters ("Server instructions
 * truncated from 4508 to 4096 chars" in its MCP log, 2026-11-03), so they stay under that and the
 * rules a person notices come first. 2026-11-03 (owner, the Claude desktop app's chat: the agent
 * said "you can follow it in the dashboard" without the link): some apps fold tool results, so the
 * agent's own message must carry the run id and the dashboard link.
 */
export function hostMcpInstructions(
	waitSliceMs: number = hostApi.HOST_WAIT_MAX_TIMEOUT_MS,
): string {
	return [
		"agent-workflow runs multi-agent workflows (for example deep-review, deep-research) whose workers are coding-agent CLIs. Use these tools only when the user asks to run or manage an agent-workflow workflow.",
		"Call protocol:",
		`1. ${WORKFLOW_LIST_TOOL} when the workflow name is uncertain; never guess workflow names.`,
		`2. ${WORKFLOW_RUN_TOOL} {workflow, task} (or ${WORKFLOW_DYNAMIC_TOOL} {task}) starts a run (detached: it keeps going between calls) and returns its runId and a "Dashboard:" link at once. Put both in your next message, the link verbatim: some apps fold tool results, so your message is what the user sees.`,
		`3. ${WORKFLOW_WAIT_TOOL} {runId} waits at most ${waitBound(waitSliceMs)} per call; call it again while stillRunning is true. terminal=true: finished; actionRequired=true: blocked, report it and use ${WORKFLOW_INSPECT_TOOL}.`,
		'4. When it finished, quote the result preview and the report paths verbatim (do not re-summarize the report) and give the Dashboard link again. "Workflow finished — verdict: X (report ready)" (verdictGate=true) is the workflow\'s result with a non-passing verdict, not a failure.',
		`5. There is no completion push. If you stop waiting while it runs (for example a rate-limit backoff, nextRetry), tell the user the runId, what it waits for, the Dashboard link, and that they can ask you again or run \`agent-workflow watch <runId>\`. A line containing "agent-workflow: workflow … finished — …" in a later turn (maybe prefixed by a hook) comes from the completion check: relay it with the report path.`,
		`${WORKFLOW_STATUS_TOOL} lists runs or shows one; ${WORKFLOW_LOGS_TOOL} shows a redacted tail of task output; ${WORKFLOW_STOP_TOOL} interrupts a run (cancelling ${WORKFLOW_WAIT_TOOL} only stops waiting); ${WORKFLOW_VALIDATE_TOOL} checks a spec. ${WORKFLOW_SHOW_TOOL}, ${WORKFLOW_ROLES_TOOL}, ${WORKFLOW_AGENTS_TOOL}, ${WORKFLOW_DOCTOR_TOOL} are read-only. ${WORKFLOW_RESUME_TOOL} continues a failed, interrupted or blocked run and ${WORKFLOW_SUPERVISE_TOOL} supervises a running one: both start model calls, so only when the user asks.`,
		`A launch that needs the user's OK and could not ask them in a dialog starts nothing and says which limits to show; ask the user, and only if they agree call again with acceptDegradations as it says.`,
		`Dynamic approvals: a run stopped with actionRequired=true and pendingApprovals (a question and requestId): show the question; only when the user decides, call ${WORKFLOW_APPROVE_TOOL} {runId, requestId, decision} (it confirms in a dialog; approving starts model calls).`,
		`Choosing a workflow: only when the user asks you to pick one for a task, call ${WORKFLOW_AUTO_TOOL} {task}: it asks in a dialog before one classifier request, then lets the user choose; without dialogs it returns a local shortlist to show the user.`,
		`Changes that need the user's confirmation in an MCP dialog (refused with the terminal command without dialogs): ${CONFIRMED_CHANGES.join("; ")}. ${WORKFLOW_PRUNE_TOOL} without dryRun=false only previews.`,
		'Permission mode is "free" by default (workers run without approval prompts; read-only stages stay read-only); set permissionMode "safe", executor ("claude", "codex", "pi") or profile only when the user asks.',
		`${WORKFLOW_DASHBOARD_TOOL} opens the dashboard in the user's browser after a dialog; it never returns a sign-in URL. Every tool takes an optional cwd inside the project root.`,
	].join("\n");
}

export const HOST_MCP_INSTRUCTIONS = hostMcpInstructions();

const CWD_PROPERTY = {
	cwd: {
		type: "string",
		description:
			"Optional project directory for this call: the server's project root (default) or a directory below it. Paths outside the root are refused. The home directory itself is no project: runs without a cwd there are recorded in ~/.agent-workflow/home-runs (pass the project directory to work on a repository).",
	},
} as const;

const LAUNCH_OPTION_PROPERTIES = {
	executor: {
		type: "string",
		description:
			'Optional executor id that runs the workflow workers ("claude", "codex", "pi"). Omit to use the profile or this host\'s default executor. Same as --executor.',
	},
	profile: {
		type: "string",
		description:
			"Optional execution profile: a profile the workflow declares, else a saved user profile. Omit to use the workflow's declared default or the default saved profile.",
	},
	permissionMode: {
		type: "string",
		enum: ["free", "safe"],
		description:
			'Optional worker permission mode (same as --permission-mode). "free" (default) or "safe" (approvals/sandbox where the executor supports it).',
	},
	allowUnverified: {
		type: "array",
		items: { type: "string" },
		description:
			"Optional executor capability keys to accept although unverified (same as --allow-unverified).",
	},
	acceptDegradations: {
		type: "array",
		items: { type: "string" },
		description:
			"Only after a launch was not started because it needs the user's OK and the client could not ask them in a dialog: the capability keys the refusal listed (for example webTools) that the user accepted in this conversation after you showed them the limits. Never set it on your own.",
	},
	model: {
		type: "string",
		description: "Optional model override for every stage of this run.",
	},
	effort: {
		type: "string",
		enum: [...THINKING_LEVELS],
		description: "Optional effort (thinking/reasoning level) override.",
	},
	detach: {
		type: "boolean",
		description:
			"Optional, default true: spawn a standalone supervisor so the run keeps progressing between tool calls and after this server exits. false keeps the run in this server process only.",
	},
	forceNew: {
		type: "boolean",
		description:
			"Optional. Skip the duplicate-launch guard (an identical active run from the last 10 minutes).",
	},
	inputs: {
		type: "object",
		additionalProperties: true,
		description:
			'Optional workflow inputs the workflow declares (same as --input key=value), for example {"depth":"quick"}. Values must match the declared input types; strings are converted for number, boolean and JSON inputs. Undeclared keys are refused.',
	},
	...CWD_PROPERTY,
} as const;

const RUN_ID_PROPERTY = {
	runId: {
		type: "string",
		description: "Workflow run id or unambiguous id prefix.",
	},
} as const;

export interface HostMcpToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, boolean>;
}

export const HOST_MCP_TOOLS: readonly HostMcpToolDefinition[] = [
	{
		name: WORKFLOW_LIST_TOOL,
		title: "List agent-workflow workflows",
		description: `List agent-workflow workflow specs discoverable from the project, the user directory and the installed package. Paginated (max 20); output bounded to 50KB/2000 lines; use offset/query for more. Use it before ${WORKFLOW_RUN_TOOL} when the workflow name is uncertain; do not guess names.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					description: "Optional name or alias substring filter.",
				},
				offset: {
					type: "integer",
					minimum: 0,
					description: "Zero-based continuation offset (default 0).",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 20,
					description: "Page size (default/max 20).",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_RUN_TOOL,
		title: "Run agent-workflow workflow",
		description: `Start a named agent-workflow run from an explicit user request (only when the user asks to run/use a workflow and both the workflow and a concrete task are known). Returns once the run is launched, with its runId; then call ${WORKFLOW_WAIT_TOOL} {runId} and repeat while stillRunning is true. Preserve the user's language, file references, constraints and requested depth in task. Set executor, profile, permissionMode or inputs only when the user asks. Detached by default.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				workflow: {
					type: "string",
					description:
						'Exact workflow name or spec path, for example "deep-review".',
				},
				task: {
					type: "string",
					description:
						"Full runtime task for the workflow. Preserve the user's language, file references, and constraints.",
				},
				...LAUNCH_OPTION_PROPERTIES,
			},
			required: ["workflow", "task"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_DYNAMIC_TOOL,
		title: "Run agent-workflow dynamic workflow",
		description: `Start a spec-less direct dynamic agent-workflow run, only when the user explicitly asks for a dynamic workflow and gives a concrete task (if the user names a workflow such as deep-review, use ${WORKFLOW_RUN_TOOL}). Returns once launched; then call ${WORKFLOW_WAIT_TOOL} {runId} and repeat while stillRunning is true. Detached by default.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				task: {
					type: "string",
					description:
						"Full runtime task for spec-less direct dynamic workflow execution. Preserve the user's language, file references, constraints, and requested depth.",
				},
				...LAUNCH_OPTION_PROPERTIES,
			},
			required: ["task"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_STATUS_TOOL,
		title: "agent-workflow run status",
		description: `Show one agent-workflow run (status and tasks) or, without runId, every top-level run (newest first). Does not wait; use ${WORKFLOW_WAIT_TOOL} to wait for a result.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: {
					type: "string",
					description:
						"Optional run id or unambiguous id prefix; omit to list runs.",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_WAIT_TOOL,
		title: "Wait for agent-workflow run",
		description: waitToolDescription(hostApi.HOST_WAIT_MAX_TIMEOUT_MS),
		inputSchema: waitToolInputSchema(hostApi.HOST_WAIT_MAX_TIMEOUT_MS),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_STOP_TOOL,
		title: "Stop agent-workflow run",
		description:
			"Stop (interrupt) a non-terminal agent-workflow run: records a durable stop intent and cancels running workers. pending=true means another supervisor will apply the stop shortly.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { ...RUN_ID_PROPERTY, ...CWD_PROPERTY },
			required: ["runId"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_INSPECT_TOOL,
		title: "Inspect agent-workflow run",
		description:
			"Inspect an agent-workflow run: reliability summary (retries, resumes, context-limit failures) and its tasks. failures=true lists only failed/blocked/interrupted tasks; results=true includes each listed task's result text.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...RUN_ID_PROPERTY,
				failures: {
					type: "boolean",
					description:
						"Optional. List only failed, blocked and interrupted tasks.",
				},
				results: {
					type: "boolean",
					description: "Optional. Include the listed tasks' result text.",
				},
				...CWD_PROPERTY,
			},
			required: ["runId"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_LOGS_TOOL,
		title: "agent-workflow run logs",
		description: `Bounded, redacted tail of an agent-workflow run's task logs: output, stderr and executor events per task (without task: the most recently started tasks, at most ${hostApi.LOGS_MAX_TASKS}). Use it to see what a running or failed task is doing; for the result of a finished run use ${WORKFLOW_WAIT_TOOL}.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...RUN_ID_PROPERTY,
				task: {
					type: "string",
					description:
						"Optional task id or spec id; omit for every started task.",
				},
				lines: {
					type: "integer",
					minimum: 1,
					maximum: hostApi.LOGS_MAX_LINES,
					description: `Lines per stream (default ${hostApi.LOGS_DEFAULT_LINES}, max ${hostApi.LOGS_MAX_LINES}).`,
				},
				stream: {
					type: "string",
					enum: [...hostApi.LOG_STREAMS, "all"],
					description:
						"Optional: one stream (output, stderr, events) or all (default).",
				},
				...CWD_PROPERTY,
			},
			required: ["runId"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_VALIDATE_TOOL,
		title: "Validate agent-workflow workflow",
		description:
			"Validate an agent-workflow workflow spec (name, alias or path) without running it: tasks, roles, concurrency, permission previews and warnings. An invalid spec is an error result listing the problems.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				workflow: {
					type: "string",
					description: "Workflow name, alias or spec path.",
				},
				...CWD_PROPERTY,
			},
			required: ["workflow"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_RESUME_TOOL,
		title: "Resume agent-workflow run",
		description: `Resume a failed, interrupted or blocked agent-workflow run: resets its failed, interrupted and resumable blocked tasks and continues the run. This starts new model calls on the run's executors (cost), so call it only when the user asks to resume or continue the run. Detached by default; then call ${WORKFLOW_WAIT_TOOL} {runId} and repeat while stillRunning is true.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...RUN_ID_PROPERTY,
				detach: {
					type: "boolean",
					description:
						"Optional, default true: spawn a standalone supervisor so the resumed run keeps progressing between tool calls and after this server exits.",
				},
				...CWD_PROPERTY,
			},
			required: ["runId"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_SHOW_TOOL,
		title: "Show agent-workflow spec or run",
		description: `Show a workflow spec (ref = workflow name, alias or spec path) or a run's details (ref = run id; raw=true for the raw run record view). Read-only; for a run's progress prefer ${WORKFLOW_STATUS_TOOL}, for its result ${WORKFLOW_WAIT_TOOL}.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ref: {
					type: "string",
					description:
						"Workflow name, alias or spec path, or a run id (workflow_…).",
				},
				raw: {
					type: "boolean",
					description:
						"Optional. Treat ref as a run (id or prefix) and show the raw run record view.",
				},
				...CWD_PROPERTY,
			},
			required: ["ref"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_ROLES_TOOL,
		title: "agent-workflow workflow roles",
		description:
			"Show the compiled role context of an agent-workflow workflow (which agent, tools and permissions each stage gets). Read-only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				workflow: {
					type: "string",
					description: "Workflow name, alias or spec path.",
				},
				...CWD_PROPERTY,
			},
			required: ["workflow"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_AGENTS_TOOL,
		title: "List agent-workflow agents",
		description:
			"List the agent definitions agent-workflow discovers (project, user directory, package). Read-only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { ...CWD_PROPERTY },
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_NOTICES_TOOL,
		title: "agent-workflow unfinished-run notices",
		description:
			'Unfinished-run notices (notification-only; runs and resume are unchanged). action "list" (default) is read-only and shows each notice\'s --state hash. "acknowledge" (runId, state, reason) hides a notice and "clear" (runId) removes an acknowledgement: both ask the user to confirm in an MCP dialog first and are refused when the client cannot show one.',
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ["list", "acknowledge", "clear"],
					description: "Optional, default list.",
				},
				runId: {
					type: "string",
					description: "Exact run id (acknowledge, clear).",
				},
				state: {
					type: "string",
					description: "The notice's sha256 state from the list (acknowledge).",
				},
				reason: {
					type: "string",
					description: "Why the notice is acknowledged (acknowledge).",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_DOCTOR_TOOL,
		title: "agent-workflow doctor",
		description:
			"Read-only environment check (no model call, nothing written): which executors (claude, codex, pi) are installed and logged in, the default executor here and why, permission-mode default, Node version, AGENT_WORKFLOW_HOME, environment warnings and stale run-index entries.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { ...CWD_PROPERTY },
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_PRUNE_TOOL,
		title: "Prune agent-workflow runs",
		description:
			"Retention of finished agent-workflow runs, stale executor attempt state and host launch claims. A dry run by default: lists what would be removed and changes nothing. dryRun=false deletes, only after the user confirms in an MCP dialog (refused when the client cannot show one). Active runs are never pruned.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				keep: {
					type: "integer",
					minimum: 0,
					description:
						"Optional. Keep this many newest finished runs (same as --keep).",
				},
				olderThanDays: {
					type: "number",
					minimum: 0,
					description:
						"Optional. Only finished runs older than this many days (same as --older-than).",
				},
				dryRun: {
					type: "boolean",
					description:
						"Optional, default true. false deletes after the user's confirmation (same as --yes).",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_PROFILE_TOOL,
		title: "agent-workflow saved user profiles",
		description:
			'Saved agent-workflow user profiles (executor, model, effort, permission mode, strict capabilities, roles: role → executor/model/effort) that profile= on a launch selects. op "list" (default), "show" and "presets" (built-in executor presets codex, claude, pi, mixed) are read-only; "workflow-list"/"workflow-show" read and "workflow-set"/"workflow-clear" change the saved preference of one workflow (its default profile and role overrides, applied to every launch of it). "set", "delete", "default" and "clear-default" change the user\'s profiles only after the user confirms in an MCP dialog (refused when the client cannot show one). Change profiles only when the user asks.',
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				op: {
					type: "string",
					enum: [
						"list",
						"show",
						"set",
						"delete",
						"default",
						"clear-default",
						"presets",
						"workflow-list",
						"workflow-show",
						"workflow-set",
						"workflow-clear",
					],
					description:
						'Optional, default list. "workflow-*" ops manage the saved per-workflow preference of `workflow` (the profile a launch of it uses when none is named, and role overrides); workflow-list/workflow-show are read-only, workflow-set/workflow-clear ask for confirmation.',
				},
				name: {
					type: "string",
					description:
						"Profile name (set, delete, default; optional for show: the default profile).",
				},
				executor: {
					type: "string",
					description: 'set: executor id ("claude", "codex", "pi").',
				},
				model: { type: "string", description: "set: model id." },
				effort: {
					type: "string",
					enum: [...THINKING_LEVELS],
					description: "set: effort (thinking/reasoning level).",
				},
				permissionMode: {
					type: "string",
					enum: ["free", "safe"],
					description: "set: worker permission mode.",
				},
				strictCapabilities: {
					type: "array",
					items: { type: "string" },
					description: "set: capability keys that must be verified.",
				},
				workflow: {
					type: "string",
					description:
						"workflow-show/-set/-clear: workflow name or spec path (the preference is keyed by the workflow name).",
				},
				profile: {
					type: "string",
					description:
						"workflow-set: profile the workflow uses when a launch names none (declared, saved user profile or preset).",
				},
				preset: {
					type: "string",
					enum: [...EXECUTOR_PRESET_IDS],
					description:
						"set: start from a built-in executor preset (replaces the saved executor and roles; other fields here still win).",
				},
				roles: {
					type: "object",
					description:
						'set: role → {executor?, model?, effort?}. Roles: default, planning, research-execution, synthesis, verification, final-judgment, or "agent:<name>". Merged role by role; unset "roles.<role>" removes one.',
					additionalProperties: {
						type: "object",
						additionalProperties: false,
						properties: {
							executor: { type: "string" },
							model: { type: "string" },
							effort: { type: "string", enum: [...THINKING_LEVELS] },
						},
					},
				},
				unset: {
					type: "array",
					items: { type: "string" },
					description: "set: fields to remove from the profile.",
				},
				makeDefault: {
					type: "boolean",
					description: "set: also make it the default profile.",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_SUPERVISE_TOOL,
		title: "Supervise agent-workflow run",
		description: `Start a standalone background supervisor (agent-workflow supervise <runId>) for a running agent-workflow run that no live process drives, for example an attached run whose host session ended. The run then continues and makes model calls (cost), so call it only when the user asks. Does nothing when the run is not running or a live supervisor already drives it. Then call ${WORKFLOW_WAIT_TOOL} {runId}.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { ...RUN_ID_PROPERTY, ...CWD_PROPERTY },
			required: ["runId"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_APPROVE_TOOL,
		title: "Approve agent-workflow dynamic controller",
		description: `Answer a dynamic-controller approval a run is blocked on (pendingApprovals in ${WORKFLOW_WAIT_TOOL}/${WORKFLOW_STATUS_TOOL}: the question and its requestId). Call it only after the user decided. The user confirms in a dialog (MCP elicitation) before anything is recorded; clients without dialogs are refused with the terminal command. decision "approve": accepting runs the controller and resumes the run (new model calls; detached by default, then call ${WORKFLOW_WAIT_TOOL}); declining the dialog rejects the controller for this run. decision "reject": accepting rejects it for this run (it is never asked again). Cancelling changes nothing.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...RUN_ID_PROPERTY,
				requestId: {
					type: "string",
					description:
						"requestId of the pending approval (from pendingApprovals in the wait/status result).",
				},
				decision: {
					type: "string",
					enum: ["approve", "reject"],
					description: "The user's decision.",
				},
				detach: {
					type: "boolean",
					description:
						"Optional, default true: after an approval, resume the run in a standalone supervisor so it keeps progressing between tool calls.",
				},
				...CWD_PROPERTY,
			},
			required: ["runId", "requestId", "decision"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_AUTO_TOOL,
		title: "Choose and run an agent-workflow workflow",
		description: `Recommend an agent-workflow workflow for a task and start the one the user chooses. Call it only when the user asks you to pick a workflow for a concrete task (if the user names a workflow, use ${WORKFLOW_RUN_TOOL}). The user is asked in a dialog (MCP elicitation) before the task is sent to one classifier request on the run's default executor; a second dialog lets the user choose the workflow (or none), which then starts like ${WORKFLOW_RUN_TOOL} (detached by default; then call ${WORKFLOW_WAIT_TOOL}). Without dialog support nothing is sent: the result is a local shortlist with the ${WORKFLOW_RUN_TOOL} calls to start one; show it and let the user pick. If the user declines a dialog, nothing starts; do not retry unless the user asks.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				task: {
					type: "string",
					description:
						"Full runtime task. Preserve the user's language, file references, constraints and requested depth.",
				},
				...LAUNCH_OPTION_PROPERTIES,
			},
			required: ["task"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: WORKFLOW_DASHBOARD_TOOL,
		title: "Open agent-workflow dashboard",
		description:
			"Call when the user wants to see or open the dashboard (or right after a launch when no dashboard is running and the user wants to watch). Ensures the project's local dashboard is running, then opens it in the user's browser after they consent in a dialog (URL dialog, else a form dialog); clients without dialogs get terminal instructions. Optional run selects a full workflow run id. Never changes a run or returns a sign-in URL.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				run: {
					type: "string",
					pattern: "^workflow_[A-Za-z0-9_-]+$",
					description:
						"Optional full workflow run id to select in the dashboard.",
				},
				...CWD_PROPERTY,
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
	},
	{
		name: WORKFLOW_CHECK_TOOL,
		title: "Preflight agent-workflow workflow",
		description: `The launch preflight without the launch: picks the executor and checks what a run needs — executor installed and logged in, every stage's tools, model and effort available on the executor that would run it (names rewritten to that tool's form), capabilities. Returns the short check, or why a run would not start (an error result). No run, no model call. Use it when the user asks whether a workflow can run here or with an executor/model, or before ${WORKFLOW_RUN_TOOL} after a refusal.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				workflow: {
					type: "string",
					description: "Workflow name, alias or spec path.",
				},
				task: {
					type: "string",
					description:
						"Optional runtime task (only some workflows compile differently by task).",
				},
				executor: LAUNCH_OPTION_PROPERTIES.executor,
				profile: LAUNCH_OPTION_PROPERTIES.profile,
				permissionMode: LAUNCH_OPTION_PROPERTIES.permissionMode,
				allowUnverified: LAUNCH_OPTION_PROPERTIES.allowUnverified,
				model: LAUNCH_OPTION_PROPERTIES.model,
				effort: LAUNCH_OPTION_PROPERTIES.effort,
				inputs: LAUNCH_OPTION_PROPERTIES.inputs,
				...CWD_PROPERTY,
			},
			required: ["workflow"],
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
];

/** Tool definitions as sent for one negotiated protocol revision. */
function waitToolDescription(waitSliceMs: number): string {
	return `Drive and wait for an agent-workflow run for at most ${waitBound(waitSliceMs)} per call. Returns terminal, actionRequired, stillRunning, the status, a bounded result preview and the report artifact paths. If stillRunning is true, call ${WORKFLOW_WAIT_TOOL} again with the same runId. If actionRequired is true, report the blocker and use ${WORKFLOW_INSPECT_TOOL}. When terminal, quote the preview and the report paths rather than paraphrasing them. Do not poll run files; cancelling this call cancels only the wait.`;
}

function waitToolInputSchema(waitSliceMs: number): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			...RUN_ID_PROPERTY,
			timeoutMs: {
				type: "number",
				minimum: hostApi.HOST_WAIT_MIN_TIMEOUT_MS,
				maximum: waitSliceMs,
				description: `Optional bound of this wait in milliseconds (default and maximum ${waitSliceMs}).`,
			},
			...CWD_PROPERTY,
		},
		required: ["runId"],
	};
}

/** 2026-11-05: `waitSliceMs` is the server's bound of one workflow_wait (hostMcpWaitSliceMs). */
export function hostMcpToolDefinitions(
	protocolVersion: string,
	waitSliceMs: number = hostApi.HOST_WAIT_MAX_TIMEOUT_MS,
): Record<string, unknown>[] {
	return HOST_MCP_TOOLS.map((tool) => ({
		name: tool.name,
		...(mcpVersionHasToolTitle(protocolVersion) ? { title: tool.title } : {}),
		description:
			tool.name === WORKFLOW_WAIT_TOOL
				? waitToolDescription(waitSliceMs)
				: tool.description,
		inputSchema:
			tool.name === WORKFLOW_WAIT_TOOL
				? waitToolInputSchema(waitSliceMs)
				: tool.inputSchema,
		...(mcpVersionHasToolAnnotations(protocolVersion)
			? { annotations: { title: tool.title, ...tool.annotations } }
			: {}),
	}));
}

/** The host API surface the server calls (tests may pass a recording wrapper). */
export type HostMcpApi = Pick<
	typeof hostApi,
	| "listWorkflowsAction"
	| "runWorkflowAction"
	| "runDynamicAction"
	| "statusAction"
	| "waitAction"
	| "stopAction"
	| "inspectAction"
	| "logsAction"
	| "validateWorkflowAction"
	| "checkWorkflowAction"
	| "resumeAction"
	| "showAction"
	| "workflowRolesAction"
	| "listAgentsAction"
	| "noticesAction"
	| "doctorAction"
	| "pruneAction"
	| "profileAction"
	| "workflowPreferenceAction"
	| "superviseDetachedAction"
	| "approveAction"
	| "autoAction"
>;

export interface HostMcpServiceOptions {
	/** Project root (the server's working directory); `cwd` arguments must stay inside it. */
	root: string;
	/** `--host` identity, passed to the host API as `ctx.host`. */
	host: HostMcpHost;
	/** Environment for role checks, the user home and detached supervisors (default process.env). */
	env?: NodeJS.ProcessEnv;
	api?: HostMcpApi;
	/** Logger for diagnostics (stderr in the server). */
	log?: (message: string) => void;
	/** 2026-11-05: bound of one workflow_wait call (default 45 s; the server sets hostMcpWaitSliceMs). */
	waitSliceMs?: number;
	/** 2026-11-05: how long a first-run launch waits for the session's monitor (tests shorten it). */
	monitorStartWaitMs?: number;
}

export interface HostMcpToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError: boolean;
}

// --- argument parsing (mirrors src/hosts/pi/tools.ts) ---

const UsageError = hostApi.HostUsageError;

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim())
		throw new UsageError(`${key} must be a non-empty string`);
	return value.trim();
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = optionalString(params, key);
	if (value === undefined) throw new UsageError(`${key} is required`);
	return value;
}

function optionalBoolean(
	params: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean")
		throw new UsageError(`${key} must be a boolean`);
	return value;
}

function optionalInteger(
	params: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
): number | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		throw new UsageError(`${key} must be an integer from ${min} to ${max}`);
	return value;
}

function rejectUnknown(name: string, params: Record<string, unknown>) {
	const tool = HOST_MCP_TOOLS.find((entry) => entry.name === name);
	const allowed = Object.keys(
		(tool?.inputSchema.properties as Record<string, unknown>) ?? {},
	);
	for (const key of Object.keys(params))
		if (!allowed.includes(key))
			throw new UsageError(`unknown parameter ${key}`);
}

/** Tool arguments → LaunchRequestBase fields (without the confirmation hooks). */
/**
 * WP32: unique option labels of the auto choice (the enum values of the elicitation form), in the
 * ranked order. WP39b (O4): no number prefix; Codex numbers enum options itself ("1. 1. …") and
 * Claude Code lists them in order. Equal labels get their scope (`review [user]`), then a counter.
 */
export function autoChoiceOptions(
	choices: readonly hostApi.AutoCandidateView[],
): string[] {
	const counts = new Map<string, number>();
	for (const choice of choices)
		counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
	const seen = new Set<string>();
	return choices.map((choice) => {
		const base = `${choice.label}${(counts.get(choice.label) ?? 0) > 1 ? ` [${choice.scope}]` : ""}${choice.recommended ? " (recommended)" : ""}`;
		let option = base;
		for (let n = 2; seen.has(option); n += 1) option = `${base} #${n}`;
		seen.add(option);
		return option;
	});
}

export function launchRequestFromArguments(
	params: Record<string, unknown>,
): LaunchRequestBase {
	const executor = optionalString(params, "executor");
	const profile = optionalString(params, "profile");
	const permission = optionalString(params, "permissionMode");
	const model = optionalString(params, "model");
	const effort = optionalString(params, "effort");
	const allow = params.allowUnverified;
	if (
		allow !== undefined &&
		(!Array.isArray(allow) || allow.some((key) => typeof key !== "string"))
	)
		throw new UsageError("allowUnverified must be an array of strings");
	const allowUnverified =
		Array.isArray(allow) && allow.length
			? hostApi.parseCapabilityList(allow.join(","), "allowUnverified")
			: undefined;
	const inputs = params.inputs;
	if (
		inputs !== undefined &&
		(inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
	)
		throw new UsageError("inputs must be an object");
	const inputOverrides =
		inputs && Object.keys(inputs).length > 0
			? { ...(inputs as Record<string, unknown>) }
			: undefined;
	// MCP tool calls are time-limited: detach unless the caller opts out.
	const detach = optionalBoolean(params, "detach") ?? true;
	return {
		task: requiredString(params, "task"),
		...(executor ? { executor } : {}),
		...(profile ? { profile } : {}),
		...(permission
			? {
					permissionMode: hostApi.parsePermissionMode(
						permission,
						"permissionMode",
					),
				}
			: {}),
		...(allowUnverified
			? { allowUnverifiedCapabilities: allowUnverified }
			: {}),
		...(model ? { model } : {}),
		...(effort ? { effort: hostApi.parseThinkingLevel(effort) } : {}),
		...(detach ? { detach: true } : {}),
		...(optionalBoolean(params, "forceNew") ? { forceNew: true } : {}),
		...(inputOverrides ? { inputOverrides } : {}),
	};
}

/**
 * Resolve a `cwd` argument: the root itself or an existing directory below it (after resolving
 * symlinks). Anything else is a usage error.
 */
export async function resolveCallCwd(
	root: string,
	requested: string | undefined,
): Promise<string> {
	if (requested === undefined) return root;
	const target = resolve(root, requested);
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		throw new UsageError(`cwd ${requested} does not exist`);
	}
	const rel = relative(root, real);
	if (
		rel !== "" &&
		(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
	)
		throw new UsageError(
			`cwd ${requested} is outside the server's project root ${root}; use the root or a directory below it`,
		);
	if (!(await stat(real)).isDirectory())
		throw new UsageError(`cwd ${requested} is not a directory`);
	return real;
}

/** The client can show a form-mode elicitation (MCP 2025-06-18 and later). */
export function clientSupportsFormElicitation(
	protocolVersion: string,
	capabilities: Record<string, unknown>,
): boolean {
	if (protocolVersion === "2024-11-05" || protocolVersion === "2025-03-26")
		return false;
	const elicitation = asRecord(capabilities.elicitation);
	if (elicitation === undefined) return false;
	// An empty object means form mode (backward compatibility); `url` alone does not.
	return elicitation.form !== undefined || elicitation.url === undefined;
}

/** URL mode was introduced in MCP 2025-11-25 and must be explicitly advertised. */
export function clientSupportsUrlElicitation(
	protocolVersion: string,
	capabilities: Record<string, unknown>,
): boolean {
	return (
		protocolVersion >= "2025-11-25" &&
		asRecord(capabilities.elicitation)?.url !== undefined
	);
}

/** Answer of one confirmation elicitation; `error` = an error response or a failed request. */
export type ElicitationAnswer = "accept" | "decline" | "cancel" | "error";

/**
 * WP13 elicitation helper (WP28: shared by the degradation confirmation and the confirmed changes):
 * one form-mode `elicitation/create` with an empty form. Only `accept` lets the caller go on.
 */
export async function elicitConfirmation(
	call: McpToolCallContext,
	message: string,
	what: string,
	log: (message: string) => void,
): Promise<ElicitationAnswer> {
	try {
		const answer = asRecord(
			await call.sendRequest(
				"elicitation/create",
				{
					...(call.protocolVersion === "2025-06-18" ? {} : { mode: "form" }),
					message,
					requestedSchema: { type: "object", properties: {} },
				},
				call.signal,
			),
		);
		if (answer?.action === "accept") return "accept";
		return answer?.action === "decline" ? "decline" : "cancel";
	} catch (error) {
		log(
			`${what} failed (treated as declined): ${error instanceof Error ? error.message : String(error)}`,
		);
		return "error";
	}
}

/**
 * WP32: one form-mode elicitation with a single required enum field (the final choice of
 * workflow_auto). Resolves with the chosen index, or the answer when nothing was chosen.
 */
export async function elicitChoice(
	call: McpToolCallContext,
	message: string,
	field: { title: string; options: string[]; default?: string },
	what: string,
	log: (message: string) => void,
): Promise<
	{ index: number } | { answer: Exclude<ElicitationAnswer, "accept"> }
> {
	try {
		const answer = asRecord(
			await call.sendRequest(
				"elicitation/create",
				{
					...(call.protocolVersion === "2025-06-18" ? {} : { mode: "form" }),
					message,
					requestedSchema: {
						type: "object",
						properties: {
							workflow: {
								type: "string",
								title: field.title,
								enum: field.options,
								...(field.default ? { default: field.default } : {}),
							},
						},
						required: ["workflow"],
					},
				},
				call.signal,
			),
		);
		if (answer?.action !== "accept")
			return { answer: answer?.action === "decline" ? "decline" : "cancel" };
		const chosen = asRecord(answer.content)?.workflow;
		const index =
			typeof chosen === "string" ? field.options.indexOf(chosen) : -1;
		return index >= 0 ? { index } : { answer: "cancel" };
	} catch (error) {
		log(
			`${what} failed (treated as cancelled): ${error instanceof Error ? error.message : String(error)}`,
		);
		return { answer: "error" };
	}
}

/** One POSIX shell word (for the terminal command of a refused change). */
export function shellWord(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'\\''`)}'`;
}

function boundedText(text: string): string {
	if (text.length <= HOST_MCP_MAX_TEXT_CHARS) return text;
	return `${text.slice(0, HOST_MCP_MAX_TEXT_CHARS)}\n[truncated ${text.length - HOST_MCP_MAX_TEXT_CHARS} characters; read the run files for the rest]`;
}

/** A run without the full record (bounded): run summary + brief task rows. */
function runProjection(run: InspectData["run"]): Record<string, unknown> {
	const tasks = Array.isArray(run.tasks) ? run.tasks : [];
	return {
		...hostApi.summarizeRun(run),
		tasks: tasks.map((task) => ({
			taskId: task.taskId,
			specId: task.specId,
			status: task.status,
			statusDetail: String(task.statusDetail),
			...(task.lastMessage ? { lastMessage: task.lastMessage } : {}),
		})),
	};
}

/** Inspect without the full run record (bounded): run summary + brief task rows. */
function inspectProjection(data: InspectData): Record<string, unknown> {
	return {
		run: runProjection(data.run),
		reliability: data.reliability,
		listed: data.listed,
	};
}

/** `workflow_profile` op set: the profile values, the change summary and the CLI flags. */
function profileSetFromArguments(params: Record<string, unknown>): {
	values: Record<string, unknown>;
	unset?: string[];
	makeDefault: boolean;
	preset?: string;
	describe: string[];
	flags: string[];
} {
	const stringList = (key: string): string[] | undefined => {
		const value = params[key];
		if (value === undefined) return undefined;
		if (
			!Array.isArray(value) ||
			value.some((entry) => typeof entry !== "string" || !entry.trim())
		)
			throw new UsageError(`${key} must be an array of non-empty strings`);
		return value.map((entry: string) => entry.trim());
	};
	const values: Record<string, unknown> = {};
	const describe: string[] = [];
	const flags: string[] = [];
	const executor = optionalString(params, "executor");
	const model = optionalString(params, "model");
	const effort = optionalString(params, "effort");
	const permission = optionalString(params, "permissionMode");
	const strict = stringList("strictCapabilities");
	const unset = stringList("unset");
	if (executor) {
		values.executor = executor;
		flags.push("--executor", executor);
	}
	if (model) {
		values.model = model;
		flags.push("--model", model);
	}
	if (effort) {
		values.effort = hostApi.parseThinkingLevel(effort);
		flags.push("--effort", effort);
	}
	if (permission) {
		values.permissionMode = hostApi.parsePermissionMode(
			permission,
			"permissionMode",
		);
		flags.push("--permission-mode", permission);
	}
	if (strict?.length) {
		values.strictCapabilities = hostApi.parseCapabilityList(
			strict.join(","),
			"strictCapabilities",
		);
		flags.push("--strict-capabilities", strict.join(","));
	}
	for (const [key, value] of Object.entries(values))
		describe.push(
			`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
		);
	if (unset?.length) {
		describe.push(`remove: ${unset.join(", ")}`);
		flags.push("--unset", unset.join(","));
	}
	const makeDefault = optionalBoolean(params, "makeDefault") === true;
	if (makeDefault) flags.push("--default");
	// WP31: preset and roles.
	const preset = optionalString(params, "preset");
	if (preset) {
		if (!(EXECUTOR_PRESET_IDS as readonly string[]).includes(preset))
			throw new UsageError(
				`preset must be one of ${EXECUTOR_PRESET_IDS.join(", ")}`,
			);
		describe.push(`preset: ${preset} (replaces executor and roles)`);
		flags.push("--preset", preset);
	}
	if (params.roles !== undefined) {
		let roles: ReturnType<typeof parseWorkflowRoleMap>;
		try {
			roles = parseWorkflowRoleMap(params.roles, "roles");
		} catch (error) {
			throw new UsageError(
				error instanceof Error ? error.message : String(error),
			);
		}
		values.roles = roles;
		for (const [role, assignment] of Object.entries(roles)) {
			const text = `${assignment.executor ?? ""}:${assignment.model ?? ""}:${assignment.effort ?? ""}`;
			describe.push(`role ${role}: ${formatRoleAssignment(assignment)}`);
			flags.push("--role", `${role}=${text.replace(/:+$/, "")}`);
		}
	}
	return {
		values,
		...(unset?.length ? { unset } : {}),
		makeDefault,
		...(preset ? { preset } : {}),
		describe,
		flags,
	};
}

/**
 * 2026-11-05 (owner: wait in code, wake the host once). `monitored`: this Claude Code session runs
 * the plugin's completion monitor (notify-check --follow --session), which reports the run when it
 * has settled; the agent ends its turn instead of calling workflow_wait every 45 s. (A first version
 * asked the agent to start a Monitor with a local command; a live haiku host refused that as an
 * instruction from a tool result — rightly — so the plugin starts the monitor itself.)
 */
type Delivery = "wait" | "claude-monitor" | "codex-queue";

/**
 * 2026-11-05: when the result comes to the session by itself (monitor, codex queue), the launch text
 * must not also say "Wait for the result: workflow_wait …" (live: a haiku host given both followed
 * that line and called workflow_wait).
 */
function withoutWaitLine<T>(
	outcome: HostResult<T>,
	how: Delivery,
): HostResult<T> {
	return how === "wait"
		? outcome
		: {
				...outcome,
				text: outcome.text.replace(/\nWait for the result: [^\n]*/gu, ""),
			};
}

function launchNext(
	data: LaunchData,
	delivery: Delivery = "wait",
	waitHint = "",
): string | undefined {
	if (data.runId && data.status === "running") {
		const wait =
			delivery === "codex-queue"
				? `agent-workflow puts the result into this Codex session when the run has finished (a queued message): end your turn now and do not call ${WORKFLOW_WAIT_TOOL}. When the message "agent-workflow: workflow … (run ${data.runId}) finished — …" arrives, tell the user the verdict, the run id and the link. Call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} only if the user asks you to wait here.`
				: delivery === "claude-monitor"
					? `This session's agent-workflow completion monitor (from the plugin) reports the run when it has finished: end your turn now and do not call ${WORKFLOW_WAIT_TOOL}. When its line "agent-workflow: workflow … (run ${data.runId}) finished — …" arrives, tell the user the verdict, the run id and the link. Call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} only if the user asks you to wait here.`
					: `Then call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} and repeat while stillRunning is true.${waitHint}`;
		return data.dashboard
			? `Now tell the user, in your own message (some apps fold tool results): run ${data.runId}, Dashboard: ${data.dashboard.url} — the link as is${data.dashboard.auth ? `; if it asks them to sign in, call ${WORKFLOW_DASHBOARD_TOOL}` : ""}. ${wait}`
			: `Now tell the user the run id ${data.runId} in your own message; the dashboard is not running (${WORKFLOW_DASHBOARD_TOOL} opens it when they want it). ${wait}`;
	}
	if (data.duplicateOf)
		return `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.duplicateOf}"} for the active run, or ${WORKFLOW_RUN_TOOL} with forceNew=true to really start another run.`;
	return undefined;
}

/** WP29: the next step of a result that shows open approvals. */
function approvalNext(
	runId: string,
	pending: hostApi.PendingDynamicApproval[] | undefined,
): string | undefined {
	if (!pending?.length) return undefined;
	return `Next: the run waits for the user's approval of ${pending.map((approval) => `dynamic controller ${approval.controllerSpecId} (requestId ${approval.requestId})`).join(", ")}. Show the user the approval question above and ask them to approve or reject. Only after they decide, call ${WORKFLOW_APPROVE_TOOL} {"runId":"${runId}","requestId":"…","decision":"approve"|"reject"}; it asks them to confirm in a dialog.`;
}

function waitNext(data: WaitData, waitHint = ""): string {
	const state = `[${WORKFLOW_WAIT_TOOL}] runId=${data.runId} status=${data.status} terminal=${data.terminal} actionRequired=${data.actionRequired} stillRunning=${data.stillRunning}`;
	const approval = approvalNext(data.runId, data.pendingApprovals);
	if (approval) return `${state}\n${approval}`;
	if (data.stillRunning) {
		const waitingFor = data.nextRetry
			? `a scheduled retry at ${data.nextRetry.at}${data.nextRetry.reason ? ` (${data.nextRetry.reason})` : ""}`
			: "its running tasks";
		return `${state}${data.nextRetry ? ` nextRetryAt=${data.nextRetry.at}` : ""}\nNext: call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} again.${waitHint} If you stop waiting, tell the user the run ${data.runId} is still running and waiting for ${waitingFor}, and that they can ask you again for the result or follow it with agent-workflow watch ${data.runId} in a terminal: there is no completion push to this chat.`;
	}
	if (data.actionRequired)
		return `${state}\nNext: report the blocker; ${WORKFLOW_INSPECT_TOOL} {"runId":"${data.runId}","failures":true} shows the failed tasks. When the user asks to continue, ${WORKFLOW_RESUME_TOOL} {"runId":"${data.runId}"} resumes it (new model calls; CLI: agent-workflow resume ${data.runId}).`;
	const reports = data.reportArtifacts.map(
		(artifact) => `${artifact.label}: ${artifact.path}`,
	);
	const verdict = data.verdict ? ` verdict=${data.verdict}` : "";
	const gate = data.verdictGate
		? `\nThe run finished with the domain verdict ${data.verdict ?? "(not reported)"}; status=failed only means this verdict did not pass the workflow's final gate. Report it as the workflow's result (verdict and report), not as a workflow failure.`
		: "";
	const dashboard = data.dashboard
		? ` Include the link ${data.dashboard.url} in your message as is: it opens this run's report in the dashboard${data.dashboard.auth ? ` (if it asks them to sign in, call ${WORKFLOW_DASHBOARD_TOOL} {"run":"${data.runId}"})` : ""}.`
		: "";
	return `${state}${verdict}${reports.length ? `\n${reports.join("\n")}` : ""}${gate}\nQuote the result preview and the report paths; do not paraphrase the report.${dashboard}`;
}

export interface HostMcpService {
	call(
		name: string,
		args: Record<string, unknown>,
		context: McpToolCallContext,
	): Promise<HostMcpToolResult>;
}

export function createHostMcpService(
	options: HostMcpServiceOptions,
): HostMcpService {
	const api = options.api ?? hostApi;
	const env = options.env ?? process.env;
	const log = options.log ?? (() => undefined);
	const waitSliceMs = options.waitSliceMs ?? hostApi.HOST_WAIT_MAX_TIMEOUT_MS;
	const longWait = waitSliceMs > hostApi.HOST_WAIT_MAX_TIMEOUT_MS;
	// 2026-11-05: Codex (0.166.0, code mode) runs tool calls inside a JavaScript cell that yields to the
	// model after 30 s (its `wait` after 10 s), each a model turn, unless the cell asks for longer
	// (`// @exec` pragma; Codex sets no maximum). So a long workflow_wait needs the cell to say so.
	const waitHint =
		longWait && options.host === "codex"
			? ` In Codex code mode, begin that exec cell with // @exec: {"yield_time_ms": ${waitSliceMs + 30_000}} (and give wait the same yield_time_ms), so the cell waits for the whole call instead of yielding every 30 s.`
			: "";

	// 2026-11-05 (owner: wait in code, wake the host once): how this launch's result reaches the
	// session without workflow_wait. Claude Code: the session id (CLAUDE_CODE_SESSION_ID) is linked to
	// the run, and a live completion monitor of that session reports it. Codex: the thread of the call
	// (x-codex-turn-metadata) is linked when the session is interactive and a detached supervisor
	// drives the run; the supervisor queues the result into the thread (host-wake.ts).
	const delivery = async (
		ctx: HostApiContext,
		data: LaunchData | undefined,
		call: McpToolCallContext,
	): Promise<Delivery> => {
		if (!data?.runId || data.status !== "running") return "wait";
		if (options.host === "claude-code") {
			const session = env.CLAUDE_CODE_SESSION_ID;
			if (!isHostSessionId(session)) return "wait";
			await recordRunHostSession(ctx.cwd, data.runId, session);
			if (await hostSessionMonitorAlive(ctx.cwd, session))
				return "claude-monitor";
			// 2026-11-05: the project's first run. The monitor (none in print mode or the Agent SDK,
			// CLAUDE_CODE_ENTRYPOINT sdk-*) waits in its shell for the run directory this launch created.
			const projectDir = env.CLAUDE_PROJECT_DIR;
			return projectDir &&
				!/^sdk-/u.test(env.CLAUDE_CODE_ENTRYPOINT ?? "") &&
				(await monitorStartsWithRun(projectDir, data.runId)) &&
				(await awaitHostSessionMonitor(
					ctx.cwd,
					session,
					options.monitorStartWaitMs,
					call.signal,
				))
				? "claude-monitor"
				: "wait";
		}
		if (options.host === "codex" && hostWakeEnabled(env) && data.detached) {
			const turn = codexTurnSession(call.meta);
			if (!turn?.interactive) return "wait";
			await recordRunHostSession(ctx.cwd, data.runId, turn.threadId);
			return "codex-queue";
		}
		return "wait";
	};

	const context = async (
		args: Record<string, unknown>,
	): Promise<HostApiContext> => ({
		// 2026-11-04: the home directory (whose .agent-workflow is the user-level home) is never the
		// project; the Claude desktop app starts this server in ~ (src/hosts/project-root.ts).
		cwd: runProject(
			await resolveCallCwd(options.root, optionalString(args, "cwd")),
			env,
		),
		env,
		host: options.host,
	});

	/**
	 * Degradation confirmation (WP4d). Only a run whose limits need the user's OK asks; one whose
	 * limits are only recorded (free mode, unknown cost) starts without a question. A client that
	 * shows dialogs asks in one (elicitation); its `decline` is the user's no. 2026-11-04 (owner:
	 * "if confirmation is required, ask; otherwise skip"): where the user cannot be asked in a
	 * dialog — the client has none (the Claude desktop app's chat), or answers it without the user
	 * (`cancel` at once: Claude Code print mode, e.g. the app's Code tab, and agy) — nothing starts;
	 * the result (`confirmNext`) tells the agent to show the user the limits and, when they agree in
	 * the conversation, call again with `acceptDegradations` naming the keys (`confirmedVia: "chat"`).
	 * Before 2026-11-04 a client without dialogs started such runs unasked ("non-interactive").
	 */
	const confirmHooks = (
		call: McpToolCallContext,
		args: Record<string, unknown>,
		state: { unanswered?: CapabilityPreview } = {},
	): Pick<LaunchRequestBase, "interactive" | "confirmDegradations"> => {
		const accepted = args.acceptDegradations;
		if (
			accepted !== undefined &&
			(!Array.isArray(accepted) ||
				accepted.some((key) => typeof key !== "string"))
		)
			throw new UsageError("acceptDegradations must be an array of strings");
		if (Array.isArray(accepted) && accepted.length > 0)
			return {
				interactive: true,
				confirmDegradations: async (preview: CapabilityPreview) =>
					preview.needsOk.every((key) => accepted.includes(key))
						? "chat"
						: false,
			};
		if (
			!clientSupportsFormElicitation(
				call.protocolVersion,
				call.clientCapabilities,
			)
		)
			return {
				interactive: true,
				confirmDegradations: async (preview: CapabilityPreview) => {
					state.unanswered = preview;
					return "unasked";
				},
			};
		return {
			interactive: true,
			confirmDegradations: async (preview: CapabilityPreview) => {
				const answer = await elicitConfirmation(
					call,
					`${DEGRADATION_ELICITATION_TITLE}\n\n${preview.prompt}`,
					"degradation confirmation",
					log,
				);
				if (answer === "accept") return true;
				if (answer === "decline") return false;
				state.unanswered = preview;
				return "unasked";
			},
		};
	};
	/** The next step of a launch whose limits need the user's OK and nobody could ask (above). */
	const confirmNext = (
		retry: string,
		state: { unanswered?: CapabilityPreview },
	): string | undefined => {
		const preview = state.unanswered;
		if (!preview) return undefined;
		return `Nothing started: this run needs the user's OK, and this client could not ask them in a dialog (it has none, or answered it without the user). Ask the user in your reply — show these limits and ask whether to proceed:\n\n${preview.prompt}\n\nOnly if they agree, call ${retry} plus acceptDegradations: ${JSON.stringify(preview.needsOk)}. If they do not, start nothing.`;
	};

	/**
	 * WP28: gate of a changing call. Undefined = the user accepted, go on; otherwise the refusal
	 * result (no elicitation support → the terminal command; declined, cancelled or failed → nothing
	 * changed).
	 */
	const requireConfirmation = async (
		call: McpToolCallContext,
		change: {
			action: HostAction;
			summary: string;
			detail?: string | (() => Promise<string>);
			command: string;
			cwd: string;
		},
	): Promise<HostMcpToolResult | undefined> => {
		const terminal = `${change.cwd === options.root ? "" : `cd ${shellWord(change.cwd)} && `}${change.command}`;
		if (
			!clientSupportsFormElicitation(
				call.protocolVersion,
				call.clientCapabilities,
			)
		)
			return refusedChange(
				call,
				change.action,
				"unsupported",
				terminal,
				`Not changed: ${change.summary} needs the user's confirmation, and this MCP client does not support confirmation dialogs (elicitation). The user can run it in a terminal instead:\n  ${terminal}`,
			);
		const detail =
			typeof change.detail === "function"
				? await change.detail()
				: change.detail;
		const answer = await elicitConfirmation(
			call,
			`${change.summary}?${detail ? `\n\n${detail}` : ""}`,
			`${change.action} confirmation`,
			log,
		);
		if (answer === "accept") return undefined;
		return refusedChange(
			call,
			change.action,
			answer === "decline" ? "declined" : "cancelled",
			terminal,
			`Not changed: the user ${answer === "decline" ? "declined" : "did not confirm"} "${change.summary}". Nothing was changed; do not retry unless the user asks.`,
		);
	};

	const refusedChange = (
		call: McpToolCallContext,
		action: HostAction,
		confirmation: "unsupported" | "declined" | "cancelled",
		command: string,
		text: string,
	): HostMcpToolResult =>
		finish(
			call,
			{ action, ok: false, outcome: "refused", data: undefined, text },
			{ confirmation, command, changed: false },
		);

	const finish = <T>(
		call: McpToolCallContext,
		outcome: HostResult<T>,
		data: unknown,
		next?: string,
	): HostMcpToolResult => {
		const text = boundedText(outcome.text);
		const structured = hostMcpSendsStructuredContent(
			options.host,
			call.protocolVersion,
		);
		return {
			content: [{ type: "text", text: next ? `${text}\n\n${next}` : text }],
			...(structured
				? {
						structuredContent: {
							action: outcome.action,
							ok: outcome.ok,
							outcome: outcome.outcome,
							data,
							text,
							...(next ? { next } : {}),
						},
					}
				: {}),
			isError: outcome.outcome === "refused",
		};
	};

	/** WP31: `workflow_profile` op workflow-list|workflow-show|workflow-set|workflow-clear. */
	const workflowPreferenceCall = async (
		op: string,
		args: Record<string, unknown>,
		call: McpToolCallContext,
	): Promise<HostMcpToolResult> => {
		const allowed = new Set([
			"op",
			"workflow",
			"profile",
			"roles",
			"unset",
			"cwd",
		]);
		for (const key of Object.keys(args))
			if (!allowed.has(key))
				throw new UsageError(`${key} is not valid with op ${op}`);
		const workflow = optionalString(args, "workflow");
		if (op !== "workflow-list" && !workflow)
			throw new UsageError(`workflow is required with op ${op}`);
		if (op === "workflow-list" && workflow)
			throw new UsageError("workflow is not valid with op workflow-list");
		if (op !== "workflow-set")
			for (const key of ["profile", "roles", "unset"])
				if (args[key] !== undefined)
					throw new UsageError(`${key} is only valid with op workflow-set`);
		const ctx = await context(args);
		const cli = (words: string[]) =>
			`agent-workflow profile workflow ${words.map(shellWord).join(" ")}`;
		let request: hostApi.WorkflowPreferenceRequest;
		let change:
			| { summary: string; detail?: string; command: string }
			| undefined;
		switch (op) {
			case "workflow-list":
				request = { op: "list" };
				break;
			case "workflow-show":
				request = { op: "show", workflow: workflow! };
				break;
			case "workflow-set": {
				const profile = optionalString(args, "profile");
				const unsetValue = args.unset;
				if (
					unsetValue !== undefined &&
					(!Array.isArray(unsetValue) ||
						unsetValue.some((entry) => typeof entry !== "string"))
				)
					throw new UsageError("unset must be an array of strings");
				const unset = unsetValue as string[] | undefined;
				let roles: ReturnType<typeof parseWorkflowRoleMap> | undefined;
				try {
					roles =
						args.roles === undefined
							? undefined
							: parseWorkflowRoleMap(args.roles, "roles");
				} catch (error) {
					throw new UsageError(
						error instanceof Error ? error.message : String(error),
					);
				}
				const words = ["set", workflow!];
				const describe: string[] = [];
				if (profile) {
					words.push("--profile", profile);
					describe.push(`profile: ${profile}`);
				}
				for (const [role, assignment] of Object.entries(roles ?? {})) {
					words.push(
						"--role",
						`${role}=${`${assignment.executor ?? ""}:${assignment.model ?? ""}:${assignment.effort ?? ""}`.replace(/:+$/, "")}`,
					);
					describe.push(`role ${role}: ${formatRoleAssignment(assignment)}`);
				}
				if (unset?.length) {
					words.push("--unset", unset.join(","));
					describe.push(`remove: ${unset.join(", ")}`);
				}
				request = {
					op: "set",
					workflow: workflow!,
					...(profile ? { profile } : {}),
					...(roles ? { roles } : {}),
					...(unset?.length ? { unset } : {}),
				};
				change = {
					summary: `Save the agent-workflow preference of workflow ${workflow}`,
					detail: describe.join("\n") || "(no field changes)",
					command: cli(words),
				};
				break;
			}
			case "workflow-clear":
				request = { op: "clear", workflow: workflow! };
				change = {
					summary: `Clear the agent-workflow preference of workflow ${workflow}`,
					command: cli(["clear", workflow!]),
				};
				break;
			default:
				throw new UsageError(
					"op must be one of workflow-list, workflow-show, workflow-set, workflow-clear",
				);
		}
		if (change) {
			const refused = await requireConfirmation(call, {
				action: "profile",
				...change,
				detail: `${change.detail ? `${change.detail}\n` : ""}A saved workflow preference applies to every launch of that workflow (CLI, MCP hosts and Pi) of this user.`,
				cwd: ctx.cwd,
			});
			if (refused) return refused;
		}
		const preference = await api.workflowPreferenceAction(ctx, request);
		return finish(call, preference, preference.data);
	};

	const handlers: Record<
		string,
		(
			args: Record<string, unknown>,
			call: McpToolCallContext,
		) => Promise<HostMcpToolResult>
	> = {
		[WORKFLOW_DASHBOARD_TOOL]: async (args, call) => {
			const ctx = await context(args);
			// Same local-process authority as stop; never bypass worker/disabled role restrictions.
			assertActionAllowed(ctx, "stop");
			const run = args.run;
			if (
				run !== undefined &&
				(typeof run !== "string" || !/^workflow_[A-Za-z0-9_-]+$/.test(run))
			)
				throw new UsageError(
					"run must be a full workflow id matching ^workflow_[A-Za-z0-9_-]+$",
				);
			const dashboard = await ensureDashboard(ctx.cwd, env, { start: true });
			if (!dashboard)
				throw new Error(
					"Could not start the dashboard: no live dashboard was discovered within 3 seconds.",
				);
			let url: string;
			try {
				url = await mintLaunchUrl(dashboard, run === undefined ? {} : { run });
			} catch {
				// Never echo transport errors: they can contain credentials or the launch URL.
				throw new Error("Could not mint dashboard launch URL.");
			}
			const urlElicitation = clientSupportsUrlElicitation(
				call.protocolVersion,
				call.clientCapabilities,
			);
			let opened = false;
			if (urlElicitation) {
				const elicitationId = randomUUID();
				try {
					const answer = asRecord(
						await call.sendRequest(
							"elicitation/create",
							{
								mode: "url",
								url,
								elicitationId,
								message: `Open the agent-workflow dashboard for ${basename(ctx.cwd)}?`,
							},
							call.signal,
						),
					);
					opened = answer?.action === "accept";
				} catch {
					// The client may echo the sign-in URL in its error. Do not log or return it.
				}
				// MCP 2025-11-25: tell the client when the out-of-band step finished, else it keeps
				// "waiting for completion" (Claude Code shows Reopen/Skip). The dashboard knows: the
				// one-time token was consumed by the browser's sign-in. Bounded wait, then give up quietly.
				if (opened) {
					const deadline = Date.now() + 20_000;
					while (Date.now() < deadline && !call.signal.aborted) {
						if ((await launchConsumed(dashboard, url)) === true) {
							call.sendNotification("notifications/elicitation/complete", {
								elicitationId,
							});
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}
			}
			// Clients without URL elicitation but with form dialogs (Codex today): ask consent in a
			// form dialog, then open the browser from this server — it runs on the user's machine
			// (stdio), so this is the same as `/aw dashboard` in Pi. The URL still never reaches the
			// model. Clients with no dialogs at all get terminal instructions.
			let method: "url-elicitation" | "form-consent" | "instructions" =
				urlElicitation ? "url-elicitation" : "instructions";
			if (
				!urlElicitation &&
				clientSupportsFormElicitation(
					call.protocolVersion,
					call.clientCapabilities,
				)
			) {
				method = "form-consent";
				const answer = await elicitConfirmation(
					call,
					`Open the agent-workflow dashboard for ${basename(ctx.cwd)} in your browser?`,
					"dashboard open confirmation",
					() => {},
				);
				if (answer === "accept") opened = await openInBrowser(url, env);
			}
			const text =
				method === "instructions"
					? `Dashboard is running on 127.0.0.1:${dashboard.port}; open it from a terminal with \`agent-workflow dashboard --open\` (project ${ctx.cwd})`
					: opened
						? `Opened the dashboard in your browser (127.0.0.1:${dashboard.port}).`
						: `Dashboard is running on 127.0.0.1:${dashboard.port}; it was not opened (declined or no browser). Open it from a terminal with \`agent-workflow dashboard --open\`.`;
			return {
				content: [{ type: "text", text }],
				...(mcpVersionHasStructuredContent(call.protocolVersion)
					? {
							structuredContent: {
								running: true,
								port: dashboard.port,
								opened,
								method,
							},
						}
					: {}),
				isError: false,
			};
		},
		[WORKFLOW_LIST_TOOL]: async (args, call) => {
			const query = optionalString(args, "query");
			const offset = optionalInteger(
				args,
				"offset",
				0,
				Number.MAX_SAFE_INTEGER,
			);
			const limit = optionalInteger(args, "limit", 1, 20) ?? 20;
			const listed = await api.listWorkflowsAction(await context(args), {
				...(query ? { query } : {}),
				...(offset === undefined ? {} : { offset }),
				limit,
			});
			return finish(call, listed, listed.data);
		},
		[WORKFLOW_RUN_TOOL]: async (args, call) => {
			const ctx = await context(args);
			const confirmation: { unanswered?: CapabilityPreview } = {};
			const workflow = requiredString(args, "workflow");
			const launched = await api.runWorkflowAction(ctx, {
				workflow,
				...launchRequestFromArguments(args),
				// WP33: launch capture (redacted by the host API).
				launchOrigin: {
					kind: "tool",
					name: WORKFLOW_RUN_TOOL,
					arguments: { ...args },
				},
				...confirmHooks(call, args, confirmation),
			});
			const confirm = confirmNext(
				`${WORKFLOW_RUN_TOOL} again with the same arguments`,
				confirmation,
			);
			const how =
				confirm === undefined
					? await delivery(ctx, launched.data, call)
					: "wait";
			return finish(
				call,
				withoutWaitLine(launched, how),
				launched.data,
				confirm ?? launchNext(launched.data, how, waitHint),
			);
		},
		[WORKFLOW_DYNAMIC_TOOL]: async (args, call) => {
			const ctx = await context(args);
			const confirmation: { unanswered?: CapabilityPreview } = {};
			const launched = await api.runDynamicAction(ctx, {
				...launchRequestFromArguments(args),
				launchOrigin: {
					kind: "tool",
					name: WORKFLOW_DYNAMIC_TOOL,
					arguments: { ...args },
				},
				...confirmHooks(call, args, confirmation),
			});
			const confirm = confirmNext(
				`${WORKFLOW_DYNAMIC_TOOL} again with the same arguments`,
				confirmation,
			);
			const how =
				confirm === undefined
					? await delivery(ctx, launched.data, call)
					: "wait";
			return finish(
				call,
				withoutWaitLine(launched, how),
				launched.data,
				confirm ?? launchNext(launched.data, how, waitHint),
			);
		},
		[WORKFLOW_AUTO_TOOL]: async (args, call) => {
			const ctx = await context(args);
			const elicitation = clientSupportsFormElicitation(
				call.protocolVersion,
				call.clientCapabilities,
			);
			const confirmation: { unanswered?: CapabilityPreview } = {};
			const auto = await api.autoAction(ctx, {
				...launchRequestFromArguments(args),
				launchOrigin: {
					kind: "tool",
					name: WORKFLOW_AUTO_TOOL,
					arguments: { ...args },
				},
				...confirmHooks(call, args, confirmation),
				...(call.signal ? { signal: call.signal } : {}),
				...(elicitation
					? {
							consent: {
								source: "elicitation" as const,
								// WP39b O1: only `decline` is the user's no; `cancel`/an error is the
								// client's (e.g. Claude Code print mode auto-cancels).
								confirm: async (title: string, message: string) => {
									const answer = await elicitConfirmation(
										call,
										`${title}\n\n${message}`,
										"auto consent",
										log,
									);
									return answer === "accept"
										? true
										: answer === "decline"
											? false
											: undefined;
								},
							},
							choose: async (prompt: hostApi.AutoChoicePrompt) => {
								const options = autoChoiceOptions(prompt.choices);
								const recommended = prompt.choices.findIndex(
									(choice) => choice.candidateId === prompt.recommendedId,
								);
								const chosen = await elicitChoice(
									call,
									`${prompt.title}\n\n${prompt.message}\n\nDecline to start nothing.`,
									{
										title: "Workflow to start",
										options,
										...(recommended >= 0
											? { default: options[recommended] }
											: {}),
									},
									"auto choice",
									log,
								);
								return "index" in chosen
									? prompt.choices[chosen.index]?.candidateId
									: undefined;
							},
						}
					: {}),
			});
			const data = auto.data;
			let next: string | undefined;
			let how: Delivery = "wait";
			if (data.phase === "launched" && confirmation.unanswered)
				// Not again through workflow_auto: that would compare (and ask) once more.
				next = confirmNext(
					data.selected?.kind === "direct-dynamic"
						? `${WORKFLOW_DYNAMIC_TOOL} with the same task`
						: `${WORKFLOW_RUN_TOOL} with the selected workflow and the same task`,
					confirmation,
				);
			else if (data.phase === "launched" && data.launch) {
				how = await delivery(ctx, data.launch, call);
				next = launchNext(data.launch, how, waitHint);
			} else if (data.phase === "consent-unavailable")
				next = `Next: show the user the shortlist and ask which workflow to run; then call ${WORKFLOW_RUN_TOOL} {"workflow":"…","task":"…"} (or ${WORKFLOW_DYNAMIC_TOOL}). Nothing was sent and nothing started.`;
			else if (data.phase === "ranked" || data.phase === "cancelled")
				next = `Nothing started. If the user then names a workflow, call ${WORKFLOW_RUN_TOOL} {"workflow":"…","task":"…"}; do not call ${WORKFLOW_AUTO_TOOL} again unless the user asks.`;
			else if (data.phase === "consent-declined")
				next = `The user declined: nothing was sent and nothing started. Do not retry unless the user asks.`;
			else if (data.phase === "consent-cancelled")
				next = `The client cancelled the confirmation dialog or cannot ask the user here (no answer was given): nothing was sent and nothing started. Show the user the shortlist and ask which workflow to run; then call ${WORKFLOW_RUN_TOOL} {"workflow":"…","task":"…"} (or ${WORKFLOW_DYNAMIC_TOOL}).`;
			return finish(call, withoutWaitLine(auto, how), data, next);
		},
		[WORKFLOW_STATUS_TOOL]: async (args, call) => {
			const runId = optionalString(args, "runId");
			const status = await api.statusAction(
				await context(args),
				runId ? { runId } : {},
			);
			return finish(
				call,
				status,
				status.data,
				status.data.run
					? approvalNext(
							status.data.run.runId,
							status.data.run.pendingApprovals,
						)
					: undefined,
			);
		},
		[WORKFLOW_WAIT_TOOL]: async (args, call) => {
			const timeoutMs = args.timeoutMs;
			if (
				timeoutMs !== undefined &&
				(typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
			)
				throw new UsageError("timeoutMs must be a number");
			let progress = 0;
			let lastLine = "";
			const waited = await api.waitAction(await context(args), {
				runId: requiredString(args, "runId"),
				// 2026-11-05: a host with a long per-call limit waits up to waitSliceMs (hostMcpWaitSliceMs).
				...(longWait
					? {
							longWait: true,
							timeoutMs: Math.min(
								(timeoutMs as number | undefined) ?? waitSliceMs,
								waitSliceMs,
							),
						}
					: timeoutMs === undefined
						? {}
						: { timeoutMs }),
				signal: call.signal,
				...(call.progressToken === undefined
					? {}
					: {
							onProgress: (run) => {
								const message = `${run.runId}: ${run.taskSummary.completed}/${run.taskSummary.total} completed, ${run.taskSummary.running} running (${run.status})`;
								if (message === lastLine) return;
								lastLine = message;
								progress += 1;
								call.sendNotification("notifications/progress", {
									progressToken: call.progressToken,
									progress,
									message,
								});
							},
						}),
			});
			return finish(call, waited, waited.data, waitNext(waited.data, waitHint));
		},
		[WORKFLOW_STOP_TOOL]: async (args, call) => {
			const stopped = await api.stopAction(await context(args), {
				runId: requiredString(args, "runId"),
			});
			return finish(
				call,
				stopped,
				stopped.data,
				stopped.data.pending
					? `The stop is pending: another supervisor applies it shortly. Check with ${WORKFLOW_STATUS_TOOL} {"runId":"${stopped.data.runId}"}.`
					: undefined,
			);
		},
		[WORKFLOW_INSPECT_TOOL]: async (args, call) => {
			const failures = optionalBoolean(args, "failures");
			const results = optionalBoolean(args, "results");
			const inspected = await api.inspectAction(await context(args), {
				runId: requiredString(args, "runId"),
				...(failures ? { failures: true } : {}),
				...(results ? { results: true } : {}),
			});
			return finish(call, inspected, inspectProjection(inspected.data));
		},
		[WORKFLOW_LOGS_TOOL]: async (args, call) => {
			const task = optionalString(args, "task");
			const lines = optionalInteger(args, "lines", 1, hostApi.LOGS_MAX_LINES);
			const stream = optionalString(args, "stream");
			if (
				stream !== undefined &&
				stream !== "all" &&
				!(hostApi.LOG_STREAMS as readonly string[]).includes(stream)
			)
				throw new UsageError(
					`stream must be one of ${[...hostApi.LOG_STREAMS, "all"].join(", ")}`,
				);
			const logs = await api.logsAction(await context(args), {
				runId: requiredString(args, "runId"),
				...(task ? { task } : {}),
				...(lines === undefined ? {} : { lines }),
				...(stream ? { stream: stream as hostApi.LogStreamKind | "all" } : {}),
			});
			return finish(call, logs, logs.data);
		},
		[WORKFLOW_VALIDATE_TOOL]: async (args, call) => {
			const validated = await api.validateWorkflowAction(await context(args), {
				workflow: requiredString(args, "workflow"),
			});
			return finish(call, validated, validated.data);
		},
		[WORKFLOW_CHECK_TOOL]: async (args, call) => {
			const { detach: _detach, ...request } = launchRequestFromArguments({
				...args,
				task: optionalString(args, "task") ?? "preflight check",
			});
			const checked = await api.checkWorkflowAction(await context(args), {
				workflow: requiredString(args, "workflow"),
				...request,
			});
			return finish(call, checked, checked.data);
		},
		[WORKFLOW_RESUME_TOOL]: async (args, call) => {
			const runId = requiredString(args, "runId");
			// Time-limited calls: detach unless the caller opts out (as launches).
			const detach = optionalBoolean(args, "detach") ?? true;
			const resumed = await api.resumeAction(await context(args), {
				runId,
				...(detach ? { detach: true } : {}),
			});
			return finish(
				call,
				resumed,
				resumed.data,
				resumed.data.status === "running"
					? `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${resumed.data.runId}"} and repeat while stillRunning is true.`
					: undefined,
			);
		},
		[WORKFLOW_APPROVE_TOOL]: async (args, call) => {
			const runId = requiredString(args, "runId");
			const requestId = requiredString(args, "requestId");
			const decision = requiredString(args, "decision");
			if (decision !== "approve" && decision !== "reject")
				throw new UsageError('decision must be "approve" or "reject"');
			const detach = optionalBoolean(args, "detach") ?? true;
			const ctx = await context(args);
			if (
				!clientSupportsFormElicitation(
					call.protocolVersion,
					call.clientCapabilities,
				)
			) {
				const terminal = `${ctx.cwd === options.root ? "" : `cd ${shellWord(ctx.cwd)} && `}agent-workflow approve ${shellWord(runId)} --request ${shellWord(requestId)}${decision === "reject" ? " --reject" : ""}`;
				return refusedChange(
					call,
					"approve",
					"unsupported",
					terminal,
					`Not changed: answering a dynamic-controller approval needs the user's confirmation, and this MCP client does not support confirmation dialogs (elicitation). The user can answer it in a terminal instead:\n  ${terminal}`,
				);
			}
			const answered = await api.approveAction(ctx, {
				runId,
				requestId,
				decision,
				...(detach ? { detach: true } : {}),
				confirm: async (title, message) => {
					const answer = await elicitConfirmation(
						call,
						`${title}\n\n${message}`,
						"approval confirmation",
						log,
					);
					return answer === "accept"
						? true
						: answer === "decline"
							? false
							: undefined;
				},
			});
			return finish(
				call,
				answered,
				answered.data,
				answered.data.decision === "approved" &&
					answered.data.status === "running"
					? `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${answered.data.runId}"} and repeat while stillRunning is true.`
					: answered.data.decision === "unanswered"
						? "Nothing was recorded; do not retry unless the user asks."
						: undefined,
			);
		},
		[WORKFLOW_SHOW_TOOL]: async (args, call) => {
			const ref = requiredString(args, "ref");
			const raw = optionalBoolean(args, "raw");
			const shown = await api.showAction(await context(args), {
				ref,
				...(raw ? { raw: true } : {}),
			});
			const data = shown.data;
			return finish(
				call,
				shown,
				data.kind === "run"
					? { kind: "run", run: runProjection(data.run) }
					: data,
			);
		},
		[WORKFLOW_ROLES_TOOL]: async (args, call) => {
			const roles = await api.workflowRolesAction(await context(args), {
				workflow: requiredString(args, "workflow"),
			});
			return finish(call, roles, roles.data);
		},
		[WORKFLOW_AGENTS_TOOL]: async (args, call) => {
			const agents = await api.listAgentsAction(await context(args));
			return finish(call, agents, agents.data);
		},
		[WORKFLOW_DOCTOR_TOOL]: async (args, call) => {
			const doctor = await api.doctorAction(await context(args));
			return finish(call, doctor, doctor.data);
		},
		[WORKFLOW_SUPERVISE_TOOL]: async (args, call) => {
			const supervised = await api.superviseDetachedAction(
				await context(args),
				{ runId: requiredString(args, "runId") },
			);
			return finish(
				call,
				supervised,
				supervised.data,
				supervised.data.reason === "not-running"
					? undefined
					: `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${supervised.data.runId}"} and repeat while stillRunning is true.`,
			);
		},
		[WORKFLOW_NOTICES_TOOL]: async (args, call) => {
			const action = optionalString(args, "action") ?? "list";
			const runId = optionalString(args, "runId");
			const state = optionalString(args, "state");
			const reason = optionalString(args, "reason");
			const allowed: Record<string, string[]> = {
				list: [],
				acknowledge: ["runId", "state", "reason"],
				clear: ["runId"],
			};
			const keys = allowed[action];
			if (!keys)
				throw new UsageError("action must be one of list, acknowledge, clear");
			for (const key of ["runId", "state", "reason"]) {
				const given = args[key] !== undefined;
				if (given && !keys.includes(key))
					throw new UsageError(`${key} is not valid with action ${action}`);
				if (!given && keys.includes(key))
					throw new UsageError(`${key} is required with action ${action}`);
			}
			const argv =
				action === "list"
					? ["list"]
					: action === "clear"
						? ["clear", runId!]
						: ["acknowledge", runId!, "--state", state!, "--reason", reason!];
			try {
				parseWorkflowNoticesArgs(argv);
			} catch (error) {
				throw new UsageError(
					error instanceof Error ? error.message : String(error),
				);
			}
			const ctx = await context(args);
			if (action !== "list") {
				const refused = await requireConfirmation(call, {
					action: "notices",
					summary:
						action === "clear"
							? `Clear the acknowledgement of the unfinished-run notice for ${runId}`
							: `Acknowledge (hide) the unfinished-run notice for ${runId}`,
					detail: `${action === "acknowledge" ? `Reason: ${reason}\n` : ""}Notification only: the run and its resume are unchanged.`,
					command: `agent-workflow notices ${argv.map(shellWord).join(" ")}`,
					cwd: ctx.cwd,
				});
				if (refused) return refused;
			}
			const notices = await api.noticesAction(ctx, { argv });
			return finish(call, notices, notices.data);
		},
		[WORKFLOW_PRUNE_TOOL]: async (args, call) => {
			const keep = optionalInteger(args, "keep", 0, Number.MAX_SAFE_INTEGER);
			const olderThanDays = args.olderThanDays;
			if (
				olderThanDays !== undefined &&
				(typeof olderThanDays !== "number" ||
					!Number.isFinite(olderThanDays) ||
					olderThanDays < 0)
			)
				throw new UsageError("olderThanDays must be a non-negative number");
			const dryRun = optionalBoolean(args, "dryRun") ?? true;
			const retention = {
				...(keep === undefined ? {} : { keep }),
				...(olderThanDays === undefined ? {} : { olderThanDays }),
			};
			const ctx = await context(args);
			if (!dryRun) {
				const refused = await requireConfirmation(call, {
					action: "prune",
					summary: `Delete finished agent-workflow runs and stale state in ${ctx.cwd}`,
					detail: async () =>
						`Dry run of this prune:\n${(await api.pruneAction(ctx, retention)).text}`,
					command: [
						"agent-workflow prune --yes",
						...(keep === undefined ? [] : [`--keep ${keep}`]),
						...(olderThanDays === undefined
							? []
							: [`--older-than ${olderThanDays}`]),
					].join(" "),
					cwd: ctx.cwd,
				});
				if (refused) return refused;
			}
			const pruned = await api.pruneAction(ctx, {
				...retention,
				...(dryRun ? {} : { yes: true }),
			});
			return finish(call, pruned, pruned.data);
		},
		[WORKFLOW_PROFILE_TOOL]: async (args, call) => {
			const op = optionalString(args, "op") ?? "list";
			// WP31: saved per-workflow preferences.
			if (op.startsWith("workflow-"))
				return workflowPreferenceCall(op, args, call);
			for (const key of ["workflow", "profile"])
				if (args[key] !== undefined)
					throw new UsageError(`${key} is only valid with the workflow-* ops`);
			const name = optionalString(args, "name");
			const setOnly = [
				"executor",
				"model",
				"effort",
				"permissionMode",
				"strictCapabilities",
				"unset",
				"makeDefault",
				"preset",
				"roles",
			];
			if (op !== "set")
				for (const key of setOnly)
					if (args[key] !== undefined)
						throw new UsageError(`${key} is only valid with op set`);
			const needsName = op === "set" || op === "delete" || op === "default";
			if (needsName && !name)
				throw new UsageError(`name is required with op ${op}`);
			if ((op === "list" || op === "clear-default" || op === "presets") && name)
				throw new UsageError(`name is not valid with op ${op}`);
			let request: hostApi.ProfileRequest;
			let change:
				| { summary: string; detail?: string; command: string }
				| undefined;
			const cli = (words: string[]) =>
				`agent-workflow profile ${words.map(shellWord).join(" ")}`;
			switch (op) {
				case "list":
					request = { op: "list" };
					break;
				case "presets":
					request = { op: "presets" };
					break;
				case "show":
					request = name ? { op: "show", name } : { op: "show" };
					break;
				case "set": {
					const set = profileSetFromArguments(args);
					request = {
						op: "set",
						name: name!,
						values: set.values,
						...(set.unset ? { unset: set.unset } : {}),
						...(set.makeDefault ? { makeDefault: true } : {}),
						...(set.preset ? { preset: set.preset } : {}),
					};
					change = {
						summary: `Save the agent-workflow user profile "${name}"${set.makeDefault ? " and make it the default" : ""}`,
						detail: set.describe.join("\n") || "(no field changes)",
						command: cli(["set", name!, ...set.flags]),
					};
					break;
				}
				case "delete":
					request = { op: "delete", name: name! };
					change = {
						summary: `Delete the agent-workflow user profile "${name}"`,
						command: cli(["delete", name!]),
					};
					break;
				case "default":
					request = { op: "default", name: name! };
					change = {
						summary: `Make "${name}" the default agent-workflow user profile`,
						command: cli(["default", name!]),
					};
					break;
				case "clear-default":
					request = { op: "default", name: null };
					change = {
						summary: "Clear the default agent-workflow user profile",
						command: cli(["default", "--clear"]),
					};
					break;
				default:
					throw new UsageError(
						"op must be one of list, show, set, delete, default, clear-default, presets",
					);
			}
			const ctx = await context(args);
			if (change) {
				const refused = await requireConfirmation(call, {
					action: "profile",
					...change,
					detail: `${change.detail ? `${change.detail}\n` : ""}Saved user profiles apply to every project of this user.`,
					cwd: ctx.cwd,
				});
				if (refused) return refused;
			}
			const profiles = await api.profileAction(ctx, request);
			return finish(call, profiles, profiles.data);
		},
	};

	return {
		async call(name, args, call) {
			const handler = handlers[name];
			if (!handler) throw new UsageError(`unknown tool ${name}`);
			try {
				rejectUnknown(name, args);
				return await handler(args, call);
			} catch (error) {
				return errorResult(
					hostMcpSendsStructuredContent(options.host, call.protocolVersion),
					error,
				);
			}
		},
	};
}

/** Tool `structuredContent` was introduced in 2025-06-18. */
export function mcpVersionHasStructuredContent(version: string): boolean {
	return version !== "2024-11-05" && version !== "2025-03-26";
}

/**
 * Handler errors become tool results with `isError` (MCP: input-validation and execution errors are
 * reported to the model so it can correct the call), with `error.kind` usage (HostUsageError, the
 * CLI's exit 2), validation (an invalid workflow spec) or error.
 */
function errorResult(structured: boolean, error: unknown): HostMcpToolResult {
	const kind =
		error instanceof hostApi.HostUsageError
			? "usage"
			: error instanceof WorkflowValidationError
				? "validation"
				: "error";
	const message = hostApi.formatHostError(error);
	const text = kind === "usage" ? `Usage error: ${message}` : message;
	return {
		content: [{ type: "text", text: boundedText(text) }],
		...(structured
			? {
					structuredContent: {
						ok: false,
						outcome: kind,
						error: { kind, message: boundedText(message) },
					},
				}
			: {}),
		isError: true,
	};
}
