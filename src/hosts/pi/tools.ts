// New in agent-workflow (WP11b): the four agent tools `aw_list`, `aw_run`, `aw_dynamic`, `aw_wait`.
// Schemas, descriptions and prompt guidelines are adapted from pi-workflow 0.16.4 (b83cc4f)
// `workflow_list/run/dynamic/wait` with executor-neutral wording: the parent agent is Pi, the
// workflow workers run on the selected executor (default pi). Each tool calls one host API handler.
// Differences from pi-workflow: no `awaitTerminal` on run/dynamic and `aw_wait` waits at most 45 s
// per call (the host API bound), so the agent calls `aw_wait` again while `stillRunning` is true;
// no completion-feedback delivery or presentation lease (stage 2).
import {
	formatHostError,
	HOST_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MIN_TIMEOUT_MS,
	type HostResult,
	HostUsageError,
	type LaunchData,
	parseCapabilityList,
	parsePermissionMode,
	parseThinkingLevel,
} from "../api.js";
import { THINKING_LEVELS } from "../../core/types.js";
import {
	hostContext,
	interactiveLaunchHooks,
	type PiHostDeps,
	piHostText,
} from "./host.js";
import {
	AW_COMMAND,
	AW_DYNAMIC_TOOL,
	AW_LIST_TOOL,
	AW_RUN_TOOL,
	AW_WAIT_TOOL,
} from "./names.js";
import type { PiExtensionApi, PiToolResult } from "./pi-types.js";

const LAUNCH_OPTION_PROPERTIES = {
	executor: {
		type: "string",
		description:
			'Optional executor id that runs the workflow workers ("pi", "codex", "claude"). Omit to use the profile or the default (pi). Same as --executor.',
	},
	profile: {
		type: "string",
		description:
			"Optional execution profile: a profile the workflow declares, else a saved user profile. Omit to use the workflow's declared default (asked interactively when the session has a UI) or the default saved profile.",
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
			"Optional. When true, spawn a standalone supervisor so the run keeps progressing after this Pi session exits.",
	},
	forceNew: {
		type: "boolean",
		description:
			"Optional. Skip the duplicate-launch guard (an identical active run from the last 10 minutes).",
	},
} as const;

export const AW_LIST_PARAMETERS = {
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
	},
} as const;

export const AW_RUN_PARAMETERS = {
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
} as const;

export const AW_DYNAMIC_PARAMETERS = {
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
} as const;

export const AW_WAIT_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		runId: {
			type: "string",
			description: "Workflow run id or unambiguous id prefix to wait for.",
		},
		timeoutMs: {
			type: "number",
			minimum: HOST_WAIT_MIN_TIMEOUT_MS,
			maximum: HOST_WAIT_MAX_TIMEOUT_MS,
			description: `Optional bound of this wait in milliseconds (default and maximum ${HOST_WAIT_MAX_TIMEOUT_MS}).`,
		},
	},
	required: ["runId"],
} as const;

function record(params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new HostUsageError("tool parameters must be an object");
	return params as Record<string, unknown>;
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim())
		throw new HostUsageError(`${key} must be a non-empty string`);
	return value.trim();
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = optionalString(params, key);
	if (value === undefined) throw new HostUsageError(`${key} is required`);
	return value;
}

function optionalBoolean(
	params: Record<string, unknown>,
	key: string,
): boolean {
	const value = params[key];
	if (value === undefined) return false;
	if (typeof value !== "boolean")
		throw new HostUsageError(`${key} must be a boolean`);
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
		throw new HostUsageError(`${key} must be an integer from ${min} to ${max}`);
	return value;
}

const LAUNCH_KEYS = new Set(["task", ...Object.keys(LAUNCH_OPTION_PROPERTIES)]);

function rejectUnknown(params: Record<string, unknown>, allowed: Set<string>) {
	for (const key of Object.keys(params))
		if (!allowed.has(key)) throw new HostUsageError(`unknown parameter ${key}`);
}

/** Tool parameters → LaunchRequestBase fields (without the interactive hooks). */
export function launchRequestFromToolParams(params: Record<string, unknown>) {
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
		throw new HostUsageError("allowUnverified must be an array of strings");
	const allowUnverified =
		Array.isArray(allow) && allow.length
			? parseCapabilityList(allow.join(","), "allowUnverified")
			: undefined;
	return {
		task: requiredString(params, "task"),
		...(executor ? { executor } : {}),
		...(profile ? { profile } : {}),
		...(permission
			? { permissionMode: parsePermissionMode(permission, "permissionMode") }
			: {}),
		...(allowUnverified
			? { allowUnverifiedCapabilities: allowUnverified }
			: {}),
		...(model ? { model } : {}),
		...(effort ? { effort: parseThinkingLevel(effort) } : {}),
		...(optionalBoolean(params, "detach") ? { detach: true } : {}),
		...(optionalBoolean(params, "forceNew") ? { forceNew: true } : {}),
	};
}

function toolResult<T>(
	outcome: HostResult<T>,
	details: Record<string, unknown>,
): PiToolResult {
	return {
		content: [{ type: "text", text: piHostText(outcome.text) }],
		details: { ...details, outcome: outcome.outcome, ok: outcome.ok },
		...(outcome.outcome === "refused" ? { isError: true } : {}),
	};
}

function launchDetails(data: LaunchData): Record<string, unknown> {
	return {
		...data,
		...(data.runId && data.status === "running"
			? {
					waitWith: `${AW_WAIT_TOOL} {"runId":"${data.runId}"}`,
					openCommand: `/${AW_COMMAND} status ${data.runId}`,
				}
			: {}),
	};
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		// Pi turns a thrown error into a failed tool result; keep the host API's message.
		throw new Error(formatHostError(error));
	}
}

export function registerAwTools(pi: PiExtensionApi, deps: PiHostDeps): void {
	pi.registerTool({
		name: AW_LIST_TOOL,
		label: "List agent-workflow workflows",
		description:
			"List agent-workflow workflow specs discoverable from the current project, the user directory and the installed package. Paginated (max 20); output bounded to 50KB/2000 lines; use offset/query for more.",
		promptSnippet:
			"List available agent-workflow workflow names, descriptions, and spec paths.",
		promptGuidelines: [
			`Use ${AW_LIST_TOOL} when the user asks what agent-workflow workflows exist or asks you to choose a workflow but did not name one.`,
			`Use ${AW_LIST_TOOL} before ${AW_RUN_TOOL} when the requested workflow name is uncertain; do not guess workflow names.`,
		],
		parameters: AW_LIST_PARAMETERS,
		annotations: { readOnlyHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params ?? {});
				rejectUnknown(input, new Set(["query", "offset", "limit"]));
				const query = optionalString(input, "query");
				const offset = optionalInteger(
					input,
					"offset",
					0,
					Number.MAX_SAFE_INTEGER,
				);
				const limit = optionalInteger(input, "limit", 1, 20) ?? 20;
				const listed = await deps.api.listWorkflowsAction(
					hostContext(deps, ctx),
					{
						...(query ? { query } : {}),
						...(offset === undefined ? {} : { offset }),
						limit,
					},
				);
				return toolResult(listed, { ...listed.data });
			});
		},
	});

	pi.registerTool({
		name: AW_RUN_TOOL,
		label: "Run agent-workflow workflow",
		description:
			"Start a named agent-workflow run from an explicit user request. Workers run on the selected executor (executor/profile parameters; default pi). Returns once the run is launched; then use aw_wait for the result.",
		promptSnippet:
			"Start an agent-workflow workflow by exact workflow name/path and full runtime task text.",
		promptGuidelines: [
			`Use ${AW_RUN_TOOL} when the user explicitly asks to run, start, execute, or use an agent-workflow workflow by name, including non-English requests that explicitly name a workflow.`,
			`Do not use ${AW_RUN_TOOL} for ordinary research, review, or coding requests unless the user asks to use a workflow.`,
			`Do not call ${AW_RUN_TOOL} unless both an exact workflow name/path and a concrete task are known; ask a clarifying question if either is missing.`,
			`Set ${AW_RUN_TOOL}.executor, profile or permissionMode only when the user asks for them (for example "run it on codex"); use detach=true only for explicit background execution.`,
			`After ${AW_RUN_TOOL} returns a running run whose result the task needs, call ${AW_WAIT_TOOL}.`,
			`Preserve the user's task language, file references, constraints, and requested depth in ${AW_RUN_TOOL}.task; do not reduce it to 'run the workflow'.`,
		],
		parameters: AW_RUN_PARAMETERS,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params);
				rejectUnknown(input, new Set([...LAUNCH_KEYS, "workflow"]));
				const request = launchRequestFromToolParams(input);
				const launched = await deps.api.runWorkflowAction(
					hostContext(deps, ctx, { executor: request.executor }),
					{
						workflow: requiredString(input, "workflow"),
						...request,
						...interactiveLaunchHooks(ctx),
					},
				);
				return toolResult(launched, launchDetails(launched.data));
			});
		},
	});

	pi.registerTool({
		name: AW_DYNAMIC_TOOL,
		label: "Run agent-workflow dynamic workflow",
		description:
			"Start a spec-less direct dynamic agent-workflow run from an explicit dynamic-workflow request. Workers run on the selected executor (default pi). Returns once the run is launched; then use aw_wait for the result.",
		promptSnippet:
			"Start a spec-less direct dynamic agent-workflow run from full runtime task text.",
		promptGuidelines: [
			`Use ${AW_DYNAMIC_TOOL} only when the user explicitly asks for an agent-workflow dynamic workflow, dynamic research, or adaptive/direct dynamic execution and provides a concrete task.`,
			`Do not use ${AW_DYNAMIC_TOOL} for ordinary research, review, or coding requests unless the user explicitly asks for dynamic workflow execution.`,
			`If the user names a workflow such as deep-research or deep-review, use ${AW_RUN_TOOL} instead.`,
			`Do not call ${AW_DYNAMIC_TOOL} unless a concrete task is known; ask a clarifying question if it is missing.`,
			`After ${AW_DYNAMIC_TOOL} returns a running run whose synthesis the task needs, call ${AW_WAIT_TOOL}; use detach=true only for explicit background execution.`,
			`Preserve the user's task language, file references, constraints, and requested depth in ${AW_DYNAMIC_TOOL}.task.`,
		],
		parameters: AW_DYNAMIC_PARAMETERS,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params);
				rejectUnknown(input, LAUNCH_KEYS);
				const request = launchRequestFromToolParams(input);
				const launched = await deps.api.runDynamicAction(
					hostContext(deps, ctx, { executor: request.executor }),
					{ ...request, ...interactiveLaunchHooks(ctx) },
				);
				return toolResult(launched, launchDetails(launched.data));
			});
		},
	});

	pi.registerTool({
		name: AW_WAIT_TOOL,
		label: "Wait for agent-workflow run",
		description: `Drive and wait for an existing agent-workflow run for at most ${HOST_WAIT_MAX_TIMEOUT_MS / 1000} s without model-driven polling. Returns terminal, actionRequired and stillRunning, the semantic status, and a bounded authoritative-result preview when the run finished.`,
		promptSnippet:
			"Wait for an agent-workflow run and return its result without polling files through the model.",
		promptGuidelines: [
			`Use ${AW_WAIT_TOOL} when ${AW_RUN_TOOL} or ${AW_DYNAMIC_TOOL} returned a running run and the current task needs its final result.`,
			`If ${AW_WAIT_TOOL} returns stillRunning=true, call ${AW_WAIT_TOOL} again with the same runId; each call waits at most ${HOST_WAIT_MAX_TIMEOUT_MS / 1000} s.`,
			`If ${AW_WAIT_TOOL} returns terminal=false and actionRequired=true, report the blocker and suggest /${AW_COMMAND} inspect and /${AW_COMMAND} resume instead of treating the run as complete.`,
			`Do not read run.json or task logs to poll workflow progress; call ${AW_WAIT_TOOL}.`,
			`Cancelling ${AW_WAIT_TOOL} cancels only the wait; it does not stop the workflow.`,
		],
		parameters: AW_WAIT_PARAMETERS,
		async execute(_id, params, signal, onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params);
				rejectUnknown(input, new Set(["runId", "timeoutMs"]));
				const timeoutMs = input.timeoutMs;
				if (
					timeoutMs !== undefined &&
					(typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
				)
					throw new HostUsageError("timeoutMs must be a number");
				const waited = await deps.api.waitAction(hostContext(deps, ctx), {
					runId: requiredString(input, "runId"),
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					...(signal ? { signal } : {}),
					...(onUpdate
						? {
								onProgress: (run) =>
									onUpdate({
										content: [
											{
												type: "text",
												text: `Waiting for ${run.runId}: ${run.taskSummary.completed}/${run.taskSummary.total} completed (${run.status})`,
											},
										],
										details: {
											runId: run.runId,
											status: run.status,
											taskSummary: run.taskSummary,
										},
									}),
							}
						: {}),
				});
				return toolResult(waited, {
					...waited.data,
					...(waited.data.actionRequired
						? {
								inspectCommand: `/${AW_COMMAND} inspect ${waited.data.runId} --failures`,
								resumeCommand: `/${AW_COMMAND} resume ${waited.data.runId}`,
							}
						: {}),
				});
			});
		},
	});
}
