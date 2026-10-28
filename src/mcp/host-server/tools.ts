// New in agent-workflow (WP13): the `agent-workflow` host MCP server's tools for agent hosts
// (Claude Code, Codex): workflow_list, workflow_run, workflow_dynamic, workflow_status,
// workflow_wait, workflow_stop, workflow_inspect, workflow_logs (WP18b), workflow_validate. Each is a thin call into one
// host API handler (src/hosts/api.ts). Schemas and wording follow the Pi host's `aw_*` tools
// (src/hosts/pi/tools.ts); differences: `detach` defaults to true (MCP calls are time-limited),
// every tool takes an optional `cwd` below the server's root, and degradation confirmation goes
// through MCP elicitation when the client supports it. docs/host-mcp.md.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import * as hostApi from "../../hosts/api.js";
import type {
	HostApiContext,
	HostResult,
	InspectData,
	LaunchData,
	LaunchRequestBase,
	WaitData,
} from "../../hosts/api.js";
import { THINKING_LEVELS, WorkflowValidationError } from "../../core/types.js";
import type { CapabilityPreview } from "../../sdk/requirements.js";
import {
	mcpVersionHasToolAnnotations,
	mcpVersionHasToolTitle,
} from "../artifact-server/protocol.js";
import { asRecord, type McpToolCallContext } from "../stdio-server.js";

export const HOST_MCP_SERVER_NAME = "agent-workflow";

/** Hosts the server can be started for (`--host`); passed to the host API as `ctx.host`. */
export const HOST_MCP_HOSTS = ["claude-code", "codex", "generic"] as const;
export type HostMcpHost = (typeof HOST_MCP_HOSTS)[number];

/**
 * WP18b: hosts that get the text `content` only, without `structuredContent`. Live bundle 4
 * (Claude Code 2.1.310, docs/live-acceptance-stage2.md case 1): Claude Code hands the model the
 * serialized `structuredContent` JSON instead of the `content` text when both are present, so every
 * result reached the model twice (`data` plus the same `text`). The tools declare no
 * `outputSchema`, so `structuredContent` is optional (MCP 2025-06-18). Codex and generic clients
 * keep it (not observed live yet; structured clients can use `data`).
 */
export const HOST_MCP_TEXT_ONLY_HOSTS: readonly HostMcpHost[] = ["claude-code"];

/** Whether results for this host and protocol revision carry `structuredContent`. */
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
export const WORKFLOW_LOGS_TOOL = "workflow_logs";

/** Bound of one tool result's text (the list action bounds itself the same way). */
export const HOST_MCP_MAX_TEXT_CHARS = 50_000;

export const DEGRADATION_ELICITATION_TITLE =
	"Proceed with these executor capability degradations?";

const WAIT_SECONDS = hostApi.HOST_WAIT_MAX_TIMEOUT_MS / 1000;

export const HOST_MCP_INSTRUCTIONS = [
	"agent-workflow runs multi-agent workflows (for example deep-review, deep-research) whose workers are coding-agent CLIs. Use these tools only when the user asks to run or manage an agent-workflow workflow.",
	"Call protocol:",
	`1. ${WORKFLOW_LIST_TOOL} when the workflow name is uncertain; never guess workflow names.`,
	`2. ${WORKFLOW_RUN_TOOL} {workflow, task} (or ${WORKFLOW_DYNAMIC_TOOL} {task} for a spec-less dynamic workflow) starts a run and returns its runId at once. Runs are detached by default, so they keep going between calls and after this server stops.`,
	`3. ${WORKFLOW_WAIT_TOOL} {runId} waits at most ${WAIT_SECONDS} s per call. While stillRunning is true, call ${WORKFLOW_WAIT_TOOL} again with the same runId. terminal=true means finished; actionRequired=true means blocked: report it and use ${WORKFLOW_INSPECT_TOOL}.`,
	"4. When the run finished, quote the result preview and give the report paths verbatim; do not paraphrase or re-summarize the report. Read the report file for details.",
	`${WORKFLOW_STATUS_TOOL} lists runs or shows one; ${WORKFLOW_LOGS_TOOL} shows a bounded, redacted tail of task output, stderr and executor events; ${WORKFLOW_STOP_TOOL} interrupts a run (cancelling ${WORKFLOW_WAIT_TOOL} only stops waiting); ${WORKFLOW_VALIDATE_TOOL} checks a workflow spec.`,
	'Permission mode: "free" by default (workers run without approval prompts; stages the workflow declares read-only stay read-only). Set permissionMode "safe" only when the user asks for approvals/sandboxing.',
	'Executor: omit executor to use the workflow profile or this host\'s default executor; set executor ("claude", "codex", "pi") or profile only when the user asks (for example "run it on codex").',
	"Every tool takes an optional cwd (a directory inside the project this server was started in); omit it to use the project root.",
].join("\n");

const CWD_PROPERTY = {
	cwd: {
		type: "string",
		description:
			"Optional project directory for this call: the server's project root (default) or a directory below it. Paths outside the root are refused.",
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
		description: `Drive and wait for an agent-workflow run for at most ${WAIT_SECONDS} s per call. Returns terminal, actionRequired, stillRunning, the status, a bounded result preview and the report artifact paths. If stillRunning is true, call ${WORKFLOW_WAIT_TOOL} again with the same runId. If actionRequired is true, report the blocker and use ${WORKFLOW_INSPECT_TOOL}. When terminal, quote the preview and the report paths rather than paraphrasing them. Do not poll run files; cancelling this call cancels only the wait.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...RUN_ID_PROPERTY,
				timeoutMs: {
					type: "number",
					minimum: hostApi.HOST_WAIT_MIN_TIMEOUT_MS,
					maximum: hostApi.HOST_WAIT_MAX_TIMEOUT_MS,
					description: `Optional bound of this wait in milliseconds (default and maximum ${hostApi.HOST_WAIT_MAX_TIMEOUT_MS}).`,
				},
				...CWD_PROPERTY,
			},
			required: ["runId"],
		},
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
];

/** Tool definitions as sent for one negotiated protocol revision. */
export function hostMcpToolDefinitions(
	protocolVersion: string,
): Record<string, unknown>[] {
	return HOST_MCP_TOOLS.map((tool) => ({
		name: tool.name,
		...(mcpVersionHasToolTitle(protocolVersion) ? { title: tool.title } : {}),
		description: tool.description,
		inputSchema: tool.inputSchema,
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

function boundedText(text: string): string {
	if (text.length <= HOST_MCP_MAX_TEXT_CHARS) return text;
	return `${text.slice(0, HOST_MCP_MAX_TEXT_CHARS)}\n[truncated ${text.length - HOST_MCP_MAX_TEXT_CHARS} characters; read the run files for the rest]`;
}

/** Inspect without the full run record (bounded): run summary + brief task rows. */
function inspectProjection(data: InspectData): Record<string, unknown> {
	const tasks = Array.isArray(data.run.tasks) ? data.run.tasks : [];
	return {
		run: {
			...hostApi.summarizeRun(data.run),
			tasks: tasks.map((task) => ({
				taskId: task.taskId,
				specId: task.specId,
				status: task.status,
				statusDetail: String(task.statusDetail),
				...(task.lastMessage ? { lastMessage: task.lastMessage } : {}),
			})),
		},
		reliability: data.reliability,
		listed: data.listed,
	};
}

function launchNext(data: LaunchData): string | undefined {
	if (data.runId && data.status === "running")
		return `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} and repeat while stillRunning is true.`;
	if (data.duplicateOf)
		return `Next: call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.duplicateOf}"} for the active run, or ${WORKFLOW_RUN_TOOL} with forceNew=true to really start another run.`;
	return undefined;
}

function waitNext(data: WaitData): string {
	const state = `[${WORKFLOW_WAIT_TOOL}] runId=${data.runId} status=${data.status} terminal=${data.terminal} actionRequired=${data.actionRequired} stillRunning=${data.stillRunning}`;
	if (data.stillRunning)
		return `${state}\nNext: call ${WORKFLOW_WAIT_TOOL} {"runId":"${data.runId}"} again.`;
	if (data.actionRequired)
		return `${state}\nNext: report the blocker; ${WORKFLOW_INSPECT_TOOL} {"runId":"${data.runId}","failures":true} shows the failed tasks; the user can resume with: agent-workflow resume ${data.runId}`;
	const reports = data.reportArtifacts.map(
		(artifact) => `${artifact.label}: ${artifact.path}`,
	);
	return `${state}${reports.length ? `\n${reports.join("\n")}` : ""}\nQuote the result preview and the report paths; do not paraphrase the report.`;
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

	const context = async (
		args: Record<string, unknown>,
	): Promise<HostApiContext> => ({
		cwd: await resolveCallCwd(options.root, optionalString(args, "cwd")),
		env,
		host: options.host,
	});

	const confirmHooks = (
		call: McpToolCallContext,
	): Pick<LaunchRequestBase, "interactive" | "confirmDegradations"> => {
		if (
			!clientSupportsFormElicitation(
				call.protocolVersion,
				call.clientCapabilities,
			)
		)
			return {};
		return {
			interactive: true,
			confirmDegradations: async (preview: CapabilityPreview) => {
				try {
					const answer = asRecord(
						await call.sendRequest(
							"elicitation/create",
							{
								...(call.protocolVersion === "2025-06-18"
									? {}
									: { mode: "form" }),
								message: `${DEGRADATION_ELICITATION_TITLE}\n\n${preview.text}`,
								requestedSchema: { type: "object", properties: {} },
							},
							call.signal,
						),
					);
					return answer?.action === "accept";
				} catch (error) {
					log(
						`degradation confirmation failed (treated as declined): ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
			},
		};
	};

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

	const handlers: Record<
		string,
		(
			args: Record<string, unknown>,
			call: McpToolCallContext,
		) => Promise<HostMcpToolResult>
	> = {
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
			const workflow = requiredString(args, "workflow");
			const launched = await api.runWorkflowAction(ctx, {
				workflow,
				...launchRequestFromArguments(args),
				...confirmHooks(call),
			});
			return finish(call, launched, launched.data, launchNext(launched.data));
		},
		[WORKFLOW_DYNAMIC_TOOL]: async (args, call) => {
			const ctx = await context(args);
			const launched = await api.runDynamicAction(ctx, {
				...launchRequestFromArguments(args),
				...confirmHooks(call),
			});
			return finish(call, launched, launched.data, launchNext(launched.data));
		},
		[WORKFLOW_STATUS_TOOL]: async (args, call) => {
			const runId = optionalString(args, "runId");
			const status = await api.statusAction(
				await context(args),
				runId ? { runId } : {},
			);
			return finish(call, status, status.data);
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
				...(timeoutMs === undefined ? {} : { timeoutMs }),
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
			return finish(call, waited, waited.data, waitNext(waited.data));
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
