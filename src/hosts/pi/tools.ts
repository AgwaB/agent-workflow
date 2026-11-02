// New in agent-workflow (WP11b): the four agent tools `aw_list`, `aw_run`, `aw_dynamic`, `aw_wait`.
// Schemas, descriptions and prompt guidelines are adapted from pi-workflow 0.16.4 (b83cc4f)
// `workflow_list/run/dynamic/wait` with executor-neutral wording: the parent agent is Pi, the
// workflow workers run on the selected executor (default pi). Each tool calls one host API handler.
// WP33: pi-workflow's session-owned wait: `aw_wait` refuses a run another Pi session owns, and a
// settled result returned to an agent of the owning session is that run's presentation (the
// completion message is not delivered again; an in-process presentation lease keeps the tracker
// from sending it while the agent waits). WP28 (owner decision Q9): `awaitTerminal` +
// `timeoutMs` on run/dynamic and long `aw_wait` calls are restored with pi-workflow's bounds
// (default 30 min, max 4 h; the host API `longWait`), cancelling the tool call cancels only the
// wait; a launch whose awaited result is returned is not delivered again later (it is tracked for
// delivery only when the wait ends before the run settles). WP28: AGENT_WORKFLOW_TOOL_EXPOSURE=deferred
// registers the tools with deferred exposure (pi-workflow PI_WORKFLOW_TOOL_EXPOSURE). WP12c: `inputs` on run/dynamic (the tool form of --input; typed by the host
// API like the CLI's strings). WP16: launched runs are tracked for the status line and completion
// delivery into this session (feedback.ts; a tool launch triggers a follow-up turn when it settles);
// an identical launch while the first run is active returns that run (`outcome: "existing"`).
import {
	formatHostError,
	HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS,
	HOST_LONG_WAIT_MAX_TIMEOUT_MS,
	HOST_WAIT_MIN_TIMEOUT_MS,
	type HostResult,
	HostUsageError,
	type LaunchData,
	type RunSummary,
	type WaitData,
	parseCapabilityList,
	parsePermissionMode,
	parseThinkingLevel,
} from "../api.js";
import { readRunRecord } from "../../core/store.js";
import { THINKING_LEVELS } from "../../core/types.js";
import { trackLaunched } from "./command.js";
import {
	piSessionId,
	presentCompletion,
	readFeedbackAudience,
} from "./feedback.js";
import { hostContext, launchHooks, type PiHostDeps } from "./host.js";
import {
	AW_COMMAND,
	AW_DYNAMIC_TOOL,
	AW_LIST_TOOL,
	AW_RUN_TOOL,
	AW_WAIT_TOOL,
} from "./names.js";
import type {
	PiExtensionApi,
	PiExtensionContext,
	PiToolResult,
	PiToolUpdate,
} from "./pi-types.js";

const LONG_WAIT_MINUTES = HOST_LONG_WAIT_DEFAULT_TIMEOUT_MS / 60_000;
const LONG_WAIT_MAX_HOURS = HOST_LONG_WAIT_MAX_TIMEOUT_MS / 3_600_000;

/** WP28: the terminal-wait options of `aw_run`/`aw_dynamic` (pi-workflow `awaitTerminal`). */
const AWAIT_PROPERTIES = {
	awaitTerminal: {
		type: "boolean",
		description: `Optional. Wait for the run to finish (or need action) and return its result and a bounded final-result preview, up to timeoutMs (default ${LONG_WAIT_MINUTES} minutes). Mutually exclusive with detach.`,
	},
	timeoutMs: {
		type: "number",
		minimum: HOST_WAIT_MIN_TIMEOUT_MS,
		maximum: HOST_LONG_WAIT_MAX_TIMEOUT_MS,
		description: `Optional terminal-wait timeout in milliseconds (max ${LONG_WAIT_MAX_HOURS} h). Requires awaitTerminal=true.`,
	},
} as const;

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
	// WP12c: the tool form of --input key=value. Values are typed by the spec's declared input
	// defaults (host API `typedWorkflowInputOverrides`): a string is parsed for a number/boolean/JSON
	// default, any other value must already have the declared type; undeclared keys are refused.
	inputs: {
		type: "object",
		additionalProperties: true,
		description:
			'Optional workflow inputs the workflow declares (same as --input key=value), for example {"depth":"quick"}. Values must match the declared input types; strings are converted for number, boolean and JSON inputs. Undeclared keys are refused.',
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
		...AWAIT_PROPERTIES,
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
		...AWAIT_PROPERTIES,
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
			maximum: HOST_LONG_WAIT_MAX_TIMEOUT_MS,
			description: `Optional wait timeout in milliseconds; defaults to ${LONG_WAIT_MINUTES} minutes (max ${LONG_WAIT_MAX_HOURS} h).`,
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

const LAUNCH_KEYS = new Set([
	"task",
	...Object.keys(LAUNCH_OPTION_PROPERTIES),
	...Object.keys(AWAIT_PROPERTIES),
]);

/** `timeoutMs` of a long wait: an integer from 1000 to 14400000 (pi-workflow's bounds). */
function optionalWaitTimeout(
	params: Record<string, unknown>,
	tool: string,
): number | undefined {
	const value = params.timeoutMs;
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < HOST_WAIT_MIN_TIMEOUT_MS ||
		value > HOST_LONG_WAIT_MAX_TIMEOUT_MS
	)
		throw new HostUsageError(
			`${tool} timeoutMs must be an integer from ${HOST_WAIT_MIN_TIMEOUT_MS} to ${HOST_LONG_WAIT_MAX_TIMEOUT_MS}`,
		);
	return value;
}

/** WP28: `awaitTerminal`/`timeoutMs` of a launch tool (pi-workflow `parseWorkflowAwaitParams`). */
export function awaitOptionsFromToolParams(
	params: Record<string, unknown>,
	tool: string,
): { awaitTerminal: boolean; timeoutMs?: number } {
	const value = params.awaitTerminal;
	if (value !== undefined && typeof value !== "boolean")
		throw new HostUsageError(`${tool} awaitTerminal must be a boolean`);
	const awaitTerminal = value === true;
	const timeoutMs = optionalWaitTimeout(params, tool);
	if (timeoutMs !== undefined && !awaitTerminal)
		throw new HostUsageError(`${tool} timeoutMs requires awaitTerminal=true`);
	if (awaitTerminal && params.detach === true)
		throw new HostUsageError(
			`${tool} detach and awaitTerminal are mutually exclusive`,
		);
	return { awaitTerminal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/** Progress of a long wait through Pi's `onUpdate`. */
function waitProgress(
	onUpdate: PiToolUpdate | undefined,
): { onProgress: (run: RunSummary) => void } | Record<string, never> {
	if (!onUpdate) return {};
	return {
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
	};
}

function waitDetails(data: WaitData): Record<string, unknown> {
	return {
		...data,
		...(data.actionRequired
			? {
					inspectCommand: `/${AW_COMMAND} inspect ${data.runId} --failures`,
					resumeCommand: `/${AW_COMMAND} resume ${data.runId}`,
				}
			: {}),
	};
}

/**
 * WP33 (parity row 20, pi-workflow `workflow_wait` session binding): an agent may wait on a run
 * that this session owns (its WP16 audience) or that no session owns (launched by the CLI, MCP or a
 * session without UI). A run owned by another Pi session is refused: its completion is presented
 * there. Returns the full run id (prefixes resolved) or undefined when the run cannot be read
 * (the wait itself then reports the error).
 */
async function assertWaitOwnership(
	ctx: PiExtensionContext,
	runRef: string,
): Promise<string | undefined> {
	let runId: string;
	try {
		runId = (await readRunRecord(ctx.cwd, runRef)).runId;
	} catch {
		return undefined;
	}
	const audience = await readFeedbackAudience(ctx.cwd, runId);
	if (audience && audience.sessionId !== piSessionId(ctx))
		throw new HostUsageError(
			`run ${runId} is owned by another Pi session: its completion is presented there. Check it with /${AW_COMMAND} status ${runId}.`,
		);
	return runId;
}

/**
 * WP33: wait for `runId` holding the tracker's presentation lease; when the run settled, the tool
 * result presents it (presentCompletion) and the completion message is not sent again. The
 * details get `feedbackEpoch` (the session history confirms the presentation through it) or
 * `completionAlreadyDelivered` when the message reached the session first.
 */
async function presentedWait(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	tool: string,
	runId: string | undefined,
	wait: () => Promise<HostResult<WaitData>>,
): Promise<{
	waited: HostResult<WaitData>;
	presentation: Record<string, unknown>;
}> {
	const release = runId
		? deps.feedback.holdPresentation(ctx.cwd, runId)
		: () => undefined;
	try {
		const waited = await wait();
		const settled = waited.data.terminal || waited.data.actionRequired;
		if (!settled || waited.data.stillRunning)
			return { waited, presentation: {} };
		const run = await readRunRecord(ctx.cwd, waited.data.runId).catch(
			() => undefined,
		);
		if (!run) return { waited, presentation: {} };
		const presented = await presentCompletion(ctx, run, {
			tool,
			now: deps.now(),
		}).catch(() => ({ outcome: "not-owner" as const, epoch: undefined }));
		if (presented.outcome === "not-owner") return { waited, presentation: {} };
		deps.feedback.forget(ctx.cwd, run.runId);
		return {
			waited,
			presentation:
				presented.outcome === "presented"
					? { feedbackEpoch: presented.epoch }
					: { completionAlreadyDelivered: true },
		};
	} finally {
		release();
	}
}

const ALREADY_DELIVERED_NOTE =
	"The completion message of this result was already delivered to this session.";

/**
 * WP28: a launch tool with `awaitTerminal`: wait (long) for the launched run and return the wait
 * result plus the launch details under `launch`. WP33: the run is tracked (bound to this session)
 * before the wait, under the presentation lease, so an awaited result is presented by the tool
 * result and never delivered a second time; when the wait ends before the run settles (timeout)
 * or is cancelled, the tracker reports back as for a plain launch.
 */
async function launchResult(
	deps: PiHostDeps,
	ctx: PiExtensionContext,
	action: "run" | "dynamic",
	launched: HostResult<LaunchData>,
	note: string | undefined,
	awaitOptions: { awaitTerminal: boolean; timeoutMs?: number },
	signal: AbortSignal | undefined,
	onUpdate: PiToolUpdate | undefined,
): Promise<PiToolResult> {
	const runId = launched.data.runId;
	const running = launched.data.status === "running";
	if (!awaitOptions.awaitTerminal || !runId || !running) {
		await trackLaunched(deps, ctx, action, launched.data, "tool");
		return toolResult(launched, launchDetails(launched.data), note);
	}
	// Cancelling (or a failing wait) ends only the wait: the run continues, stays tracked and
	// reports back like a plain launch once the lease is released.
	const release = deps.feedback.holdPresentation(ctx.cwd, runId);
	let presented: Awaited<ReturnType<typeof presentedWait>>;
	try {
		await trackLaunched(deps, ctx, action, launched.data, "tool");
		presented = await presentedWait(
			deps,
			ctx,
			action === "run" ? AW_RUN_TOOL : AW_DYNAMIC_TOOL,
			runId,
			() =>
				deps.api.waitAction(hostContext(deps, ctx), {
					runId,
					longWait: true,
					...(awaitOptions.timeoutMs === undefined
						? {}
						: { timeoutMs: awaitOptions.timeoutMs }),
					...(signal ? { signal } : {}),
					...waitProgress(onUpdate),
				}),
		);
	} finally {
		release();
	}
	const { waited, presentation } = presented;
	return toolResult(
		waited,
		{
			...waitDetails(waited.data),
			...presentation,
			launch: launchDetails(launched.data),
		},
		presentation.completionAlreadyDelivered
			? [note, ALREADY_DELIVERED_NOTE].filter(Boolean).join("\n")
			: note,
	);
}

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
	const inputs = params.inputs;
	if (
		inputs !== undefined &&
		(inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
	)
		throw new HostUsageError("inputs must be an object");
	const inputOverrides =
		inputs && Object.keys(inputs).length > 0
			? { ...(inputs as Record<string, unknown>) }
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
		...(inputOverrides ? { inputOverrides } : {}),
	};
}

function toolResult<T>(
	outcome: HostResult<T>,
	details: Record<string, unknown>,
	note?: string,
): PiToolResult {
	const text = note ? `${outcome.text}\n${note}` : outcome.text;
	return {
		content: [{ type: "text", text }],
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

/** WP28 environment switch of the `aw_*` tools' exposure (docs/environment.md). */
export const AW_TOOL_EXPOSURE_ENV = "AGENT_WORKFLOW_TOOL_EXPOSURE";

/**
 * WP28: opt-in deferred exposure (port of pi-workflow b83cc4f `workflowToolExposure`,
 * `PI_WORKFLOW_TOOL_EXPOSURE=deferred`): the tools stay out of every request until Pi's
 * `tool_search` loads them. Any other value (or none) keeps Pi's default.
 */
export function awToolExposure(env: NodeJS.ProcessEnv): {
	exposure?: "deferred";
} {
	return env[AW_TOOL_EXPOSURE_ENV] === "deferred"
		? { exposure: "deferred" }
		: {};
}

export function registerAwTools(pi: PiExtensionApi, deps: PiHostDeps): void {
	const exposure = awToolExposure(deps.env);
	pi.registerTool({
		...exposure,
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
		...exposure,
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
			`Set ${AW_RUN_TOOL}.inputs only for inputs the workflow declares and the user asked for (for example {"depth":"quick"}); otherwise the spec defaults apply.`,
			`Set ${AW_RUN_TOOL}.awaitTerminal=true when the current task needs the final workflow result; otherwise, after ${AW_RUN_TOOL} returns a running run whose result the task needs, call ${AW_WAIT_TOOL}.`,
			`Preserve the user's task language, file references, constraints, and requested depth in ${AW_RUN_TOOL}.task; do not reduce it to 'run the workflow'.`,
		],
		parameters: AW_RUN_PARAMETERS,
		async execute(_id, params, signal, onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params);
				rejectUnknown(input, new Set([...LAUNCH_KEYS, "workflow"]));
				const awaitOptions = awaitOptionsFromToolParams(input, AW_RUN_TOOL);
				const request = launchRequestFromToolParams(input);
				const hooks = launchHooks(ctx);
				const launched = await deps.api.runWorkflowAction(
					hostContext(deps, ctx, { executor: request.executor }),
					{
						workflow: requiredString(input, "workflow"),
						...request,
						// WP33: launch capture (redacted by the host API).
						launchOrigin: {
							kind: "tool",
							name: AW_RUN_TOOL,
							arguments: { ...input },
						},
						...hooks.hooks,
					},
				);
				return launchResult(
					deps,
					ctx,
					"run",
					launched,
					hooks.note(),
					awaitOptions,
					signal,
					onUpdate,
				);
			});
		},
	});

	pi.registerTool({
		...exposure,
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
			`Set ${AW_DYNAMIC_TOOL}.awaitTerminal=true when the current task needs the synthesis (or call ${AW_WAIT_TOOL} after it returns a running run); use detach=true only for explicit background execution.`,
			`Preserve the user's task language, file references, constraints, and requested depth in ${AW_DYNAMIC_TOOL}.task.`,
		],
		parameters: AW_DYNAMIC_PARAMETERS,
		async execute(_id, params, signal, onUpdate, ctx) {
			return guarded(async () => {
				await deps.ready();
				const input = record(params);
				rejectUnknown(input, LAUNCH_KEYS);
				const awaitOptions = awaitOptionsFromToolParams(input, AW_DYNAMIC_TOOL);
				const request = launchRequestFromToolParams(input);
				const hooks = launchHooks(ctx);
				const launched = await deps.api.runDynamicAction(
					hostContext(deps, ctx, { executor: request.executor }),
					{
						...request,
						launchOrigin: {
							kind: "tool",
							name: AW_DYNAMIC_TOOL,
							arguments: { ...input },
						},
						...hooks.hooks,
					},
				);
				return launchResult(
					deps,
					ctx,
					"dynamic",
					launched,
					hooks.note(),
					awaitOptions,
					signal,
					onUpdate,
				);
			});
		},
	});

	pi.registerTool({
		...exposure,
		name: AW_WAIT_TOOL,
		label: "Wait for agent-workflow run",
		description: `Drive and wait for an existing agent-workflow run until it is terminal or needs action (default ${LONG_WAIT_MINUTES} minutes, at most ${LONG_WAIT_MAX_HOURS} h) without model-driven polling. Returns terminal, actionRequired and stillRunning, the semantic status, and a bounded authoritative-result preview when the run finished.`,
		promptSnippet:
			"Wait for an agent-workflow run and return its result without polling files through the model.",
		promptGuidelines: [
			`Use ${AW_WAIT_TOOL} when ${AW_RUN_TOOL} or ${AW_DYNAMIC_TOOL} returned a running run and the current task needs its final result.`,
			`Call ${AW_WAIT_TOOL} once with an appropriate timeoutMs; if it returns stillRunning=true (the timeout passed first), call it again only when the task still needs the result.`,
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
				const timeoutMs = optionalWaitTimeout(input, AW_WAIT_TOOL);
				const runRef = requiredString(input, "runId");
				// WP33: only this session's (or an unowned) run; presented by this result.
				const runId = await assertWaitOwnership(ctx, runRef);
				const { waited, presentation } = await presentedWait(
					deps,
					ctx,
					AW_WAIT_TOOL,
					runId,
					() =>
						deps.api.waitAction(hostContext(deps, ctx), {
							runId: runRef,
							longWait: true,
							...(timeoutMs === undefined ? {} : { timeoutMs }),
							...(signal ? { signal } : {}),
							...waitProgress(onUpdate),
						}),
				);
				return toolResult(
					waited,
					{ ...waitDetails(waited.data), ...presentation },
					presentation.completionAlreadyDelivered
						? ALREADY_DELIVERED_NOTE
						: undefined,
				);
			});
		},
	});
}
