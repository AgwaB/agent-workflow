import {
	ASYNC_DEPENDENCIES,
	EXECUTION_MODES,
	ON_COMPLETE_ACTIONS,
	WORKSPACE_MODES,
	WORKTREE_POLICIES,
	isAsyncDependency,
	isExecutionMode,
	isOnCompleteAction,
	isWorktreePolicy,
	isWorkspaceMode,
	type ResolveInput,
	type ResolveValidationFailure,
	type SandboxInput,
	type SandboxOptionsInput,
	type WorkerTaskInput,
	type WorkspaceInput,
} from "./constants.js";
import { assertDurableLaunchBarrierV2Descriptor } from "../durable-launch-barrier.js";

export type ResolveValidationResult =
	| { ok: true; input: ResolveInput }
	| { ok: false; failure: ResolveValidationFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: string, executorId?: string): ResolveValidationResult {
	return {
		ok: false,
		failure: {
			...(executorId ? { executorId } : {}),
			status: "failed",
			failureKind: "validation",
			error,
		},
	};
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	return String(value);
}

function formatOptions(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(", ");
}

function validateString(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): string | ResolveValidationResult {
	if (typeof value !== "string" || value.length === 0) {
		return failure(
			`${fieldName} must be a non-empty string when provided.`,
			executorId,
		);
	}
	return value;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateSessionId(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): string | ResolveValidationResult {
	const sessionId = validateString(value, fieldName, executorId);
	if (typeof sessionId !== "string") return sessionId;
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		return failure(
			`${fieldName} must contain only letters, numbers, dots, underscores, or dashes.`,
			executorId,
		);
	}
	return sessionId;
}

function validateBoolean(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): boolean | ResolveValidationResult {
	if (typeof value !== "boolean") {
		return failure(`${fieldName} must be a boolean when provided.`, executorId);
	}
	return value;
}

function validateTimeoutMs(
	value: unknown,
	executorId: string | undefined,
): number | ResolveValidationResult {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return failure(
			"timeoutMs must be a positive finite number when provided.",
			executorId,
		);
	}
	return value;
}

function validateConcurrency(
	value: unknown,
	executorId: string | undefined,
): number | ResolveValidationResult {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return failure(
			"concurrency must be a positive integer when provided.",
			executorId,
		);
	}
	return value;
}

function validateStringArray(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): string[] | ResolveValidationResult {
	if (!Array.isArray(value)) {
		return failure(
			`${fieldName} must be an array of non-empty strings when provided.`,
			executorId,
		);
	}

	const items: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string" || entry.length === 0) {
			return failure(
				`${fieldName}[${index}] must be a non-empty string.`,
				executorId,
			);
		}
		items.push(entry);
	}
	return Array.from(new Set(items));
}

function validateTools(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): string[] | ResolveValidationResult {
	return validateStringArray(value, fieldName, executorId);
}

const DOMAIN_PATTERN =
	/^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function isAllowedDomainPattern(value: string): boolean {
	if (value === "localhost") return true;
	if (!DOMAIN_PATTERN.test(value)) return false;
	// Reject overly broad wildcards such as "*.com"; require *.example.com shape.
	if (value.startsWith("*.")) return value.slice(2).includes(".");
	return true;
}

function validateSandbox(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): SandboxInput | null | ResolveValidationResult {
	if (value === null || value === false) return null;
	if (value === true) return true;
	if (isRecord(value)) {
		const sandbox: SandboxOptionsInput = {};
		const unknownKeys = Object.keys(value).filter(
			(key) => key !== "allowedDomains",
		);
		if (unknownKeys.length > 0) {
			return failure(
				`unsupported ${fieldName} option(s): ${unknownKeys.map((key) => `"${key}"`).join(", ")}; supported options are "allowedDomains".`,
				executorId,
			);
		}
		if (value.allowedDomains !== undefined) {
			const allowedDomains = validateStringArray(
				value.allowedDomains,
				`${fieldName}.allowedDomains`,
				executorId,
			);
			if (!Array.isArray(allowedDomains)) return allowedDomains;
			for (const domain of allowedDomains) {
				if (!isAllowedDomainPattern(domain)) {
					return failure(
						`${fieldName}.allowedDomains entry ${formatValue(domain)} must be a bare domain or *.example.com-style wildcard without protocol, path, or port.`,
						executorId,
					);
				}
			}
			sandbox.allowedDomains = allowedDomains;
		}
		return sandbox;
	}
	return failure(
		`${fieldName} must be a boolean or an options object when provided. Use true for an offline sandbox, { allowedDomains: [...] } to allow network egress, or false/null to disable sandboxing.`,
		executorId,
	);
}

/** Fields one task of a parallel run may set; anything else is refused by name. */
const TASK_INPUT_KEYS: ReadonlySet<string> = new Set([
	"task",
	"sandbox",
	"cwd",
	"timeoutMs",
	"model",
	"sessionId",
	"tools",
	"systemPrompt",
	"captureToolCalls",
]);

/** Fields a run input may set; anything else is refused by name. */
const RUN_INPUT_KEYS: ReadonlySet<string> = new Set([
	"sandbox",
	"task",
	"mode",
	"tasks",
	"concurrency",
	"failFast",
	"cancelSiblingsOnFailure",
	"asyncDependency",
	"workspace",
	"worktree",
	"worktreePolicy",
	"cwd",
	"async",
	"onComplete",
	"timeoutMs",
	"model",
	"tools",
	"systemPrompt",
	"captureToolCalls",
	"runsDir",
	"correlationId",
	"sessionId",
	"parentSessionId",
	"durableLaunchBarrier",
]);

function validateTaskItem(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): WorkerTaskInput | ResolveValidationResult {
	if (!isRecord(value)) {
		return failure(`${fieldName} must be an object.`, executorId);
	}

	for (const key of Object.keys(value))
		if (!TASK_INPUT_KEYS.has(key))
			return failure(
				`unsupported request field ${fieldName}.${key}`,
				executorId,
			);

	const task: WorkerTaskInput = {};

	if (value.task !== undefined) {
		const taskText = validateString(
			value.task,
			`${fieldName}.task`,
			executorId,
		);
		if (typeof taskText !== "string") return taskText;
		task.task = taskText;
	}

	if (value.sandbox !== undefined) {
		const sandbox = validateSandbox(
			value.sandbox,
			`${fieldName}.sandbox`,
			executorId,
		);
		if (sandbox !== null && sandbox !== true && "ok" in sandbox) return sandbox;
		task.sandbox = sandbox;
	}

	if (value.cwd !== undefined) {
		const cwd = validateString(value.cwd, `${fieldName}.cwd`, executorId);
		if (typeof cwd !== "string") return cwd;
		task.cwd = cwd;
	}

	if (value.timeoutMs !== undefined) {
		const timeoutMs = validateTimeoutMs(value.timeoutMs, executorId);
		if (typeof timeoutMs !== "number") return timeoutMs;
		task.timeoutMs = timeoutMs;
	}

	if (value.model !== undefined) {
		const model = validateString(value.model, `${fieldName}.model`, executorId);
		if (typeof model !== "string") return model;
		task.model = model;
	}

	if (value.sessionId !== undefined) {
		const sessionId = validateSessionId(
			value.sessionId,
			`${fieldName}.sessionId`,
			executorId,
		);
		if (typeof sessionId !== "string") return sessionId;
		task.sessionId = sessionId;
	}

	if (value.tools !== undefined) {
		const tools = validateTools(value.tools, `${fieldName}.tools`, executorId);
		if (!Array.isArray(tools)) return tools;
		task.tools = tools;
	}

	if (value.systemPrompt !== undefined) {
		const systemPrompt = validateString(
			value.systemPrompt,
			`${fieldName}.systemPrompt`,
			executorId,
		);
		if (typeof systemPrompt !== "string") return systemPrompt;
		task.systemPrompt = systemPrompt;
	}

	if (value.captureToolCalls !== undefined) {
		const captureToolCalls = validateBoolean(
			value.captureToolCalls,
			`${fieldName}.captureToolCalls`,
			executorId,
		);
		if (typeof captureToolCalls !== "boolean") return captureToolCalls;
		task.captureToolCalls = captureToolCalls;
	}

	return task;
}

function validateTaskList(
	value: unknown,
	fieldName: string,
	executorId: string | undefined,
): WorkerTaskInput[] | ResolveValidationResult {
	if (!Array.isArray(value) || value.length === 0) {
		return failure(
			`${fieldName} must be a non-empty array of task objects when provided.`,
			executorId,
		);
	}

	const tasks: WorkerTaskInput[] = [];
	for (const [index, entry] of value.entries()) {
		const task = validateTaskItem(entry, `${fieldName}[${index}]`, executorId);
		if ("ok" in task) return task;
		tasks.push(task);
	}
	return tasks;
}

function validateWorkspace(
	value: unknown,
	executorId: string | undefined,
): WorkspaceInput | ResolveInput["workspace"] | ResolveValidationResult {
	if (isWorkspaceMode(value)) return value;
	if (!isRecord(value)) {
		return failure(
			`workspace must be one of ${formatOptions(WORKSPACE_MODES)} or an object when provided.`,
			executorId,
		);
	}

	const workspace: WorkspaceInput = {};
	if (value.mode !== undefined) {
		if (!isWorkspaceMode(value.mode)) {
			return failure(
				`unsupported workspace.mode ${formatValue(value.mode)}; supported workspace modes are ${formatOptions(WORKSPACE_MODES)}.`,
				executorId,
			);
		}
		workspace.mode = value.mode;
	}

	if (value.path !== undefined) {
		const workspacePath = validateString(
			value.path,
			"workspace.path",
			executorId,
		);
		if (typeof workspacePath !== "string") return workspacePath;
		workspace.path = workspacePath;
	}

	return workspace;
}

/**
 * Validate the generic part of a runtime run input. `executorId` (the run's executor) tags a
 * validation failure; any field outside the known set is refused by name.
 */
export function validateResolveInput(
	raw: unknown = {},
	executorId?: string,
): ResolveValidationResult {
	if (raw === undefined) raw = {};

	if (!isRecord(raw)) {
		return failure("worker input must be an object.");
	}

	const input: ResolveInput = {};
	const failureExecutorId = executorId;

	for (const key of Object.keys(raw))
		if (!RUN_INPUT_KEYS.has(key))
			return failure(`unsupported request field ${key}`, failureExecutorId);

	if (raw.sandbox !== undefined) {
		const sandbox = validateSandbox(raw.sandbox, "sandbox", failureExecutorId);
		if (sandbox !== null && sandbox !== true && "ok" in sandbox) return sandbox;
		input.sandbox = sandbox;
	}

	if (raw.task !== undefined) {
		const task = validateString(raw.task, "task", failureExecutorId);
		if (typeof task !== "string") return task;
		input.task = task;
	}

	if (raw.mode !== undefined) {
		if (!isExecutionMode(raw.mode)) {
			return failure(
				`unsupported mode ${formatValue(raw.mode)}; supported modes are ${formatOptions(EXECUTION_MODES)}.`,
				failureExecutorId,
			);
		}
		input.mode = raw.mode;
	}

	if (raw.tasks !== undefined) {
		const tasks = validateTaskList(raw.tasks, "tasks", failureExecutorId);
		if ("ok" in tasks) return tasks;
		input.tasks = tasks;
	}

	if (raw.concurrency !== undefined) {
		const concurrency = validateConcurrency(raw.concurrency, failureExecutorId);
		if (typeof concurrency !== "number") return concurrency;
		input.concurrency = concurrency;
	}

	if (raw.failFast !== undefined) {
		const failFast = validateBoolean(
			raw.failFast,
			"failFast",
			failureExecutorId,
		);
		if (typeof failFast !== "boolean") return failFast;
		input.failFast = failFast;
	}

	if (raw.cancelSiblingsOnFailure !== undefined) {
		const cancelSiblingsOnFailure = validateBoolean(
			raw.cancelSiblingsOnFailure,
			"cancelSiblingsOnFailure",
			failureExecutorId,
		);
		if (typeof cancelSiblingsOnFailure !== "boolean")
			return cancelSiblingsOnFailure;
		input.cancelSiblingsOnFailure = cancelSiblingsOnFailure;
	}

	if (raw.workspace !== undefined) {
		const workspace = validateWorkspace(raw.workspace, failureExecutorId);
		if (
			typeof workspace === "object" &&
			workspace !== null &&
			"ok" in workspace
		)
			return workspace;
		input.workspace = workspace;
	}

	if (raw.worktree !== undefined) {
		if (
			typeof raw.worktree !== "boolean" &&
			(typeof raw.worktree !== "string" || raw.worktree.length === 0)
		) {
			return failure(
				"worktree must be a boolean or non-empty string path when provided.",
				failureExecutorId,
			);
		}
		input.worktree = raw.worktree;
	}

	if (raw.worktreePolicy !== undefined) {
		if (!isWorktreePolicy(raw.worktreePolicy)) {
			return failure(
				`unsupported worktreePolicy ${formatValue(raw.worktreePolicy)}; supported worktree policies are ${formatOptions(WORKTREE_POLICIES)}.`,
				failureExecutorId,
			);
		}
		input.worktreePolicy = raw.worktreePolicy;
	}

	if (raw.cwd !== undefined) {
		const cwd = validateString(raw.cwd, "cwd", failureExecutorId);
		if (typeof cwd !== "string") return cwd;
		input.cwd = cwd;
	}

	if (raw.runsDir !== undefined) {
		const runsDir = validateString(raw.runsDir, "runsDir", failureExecutorId);
		if (typeof runsDir !== "string") return runsDir;
		input.runsDir = runsDir;
	}

	if (raw.correlationId !== undefined) {
		const correlationId = validateString(
			raw.correlationId,
			"correlationId",
			failureExecutorId,
		);
		if (typeof correlationId !== "string") return correlationId;
		input.correlationId = correlationId;
	}

	if (raw.sessionId !== undefined) {
		if (raw.tasks !== undefined || raw.mode === "parallel") {
			return failure(
				"top-level sessionId is not supported with parallel tasks; set tasks[i].sessionId instead.",
				failureExecutorId,
			);
		}

		const sessionId = validateSessionId(
			raw.sessionId,
			"sessionId",
			failureExecutorId,
		);
		if (typeof sessionId !== "string") return sessionId;
		input.sessionId = sessionId;
	}

	if (raw.async !== undefined) {
		const asyncValue = validateBoolean(raw.async, "async", failureExecutorId);
		if (typeof asyncValue !== "boolean") return asyncValue;
		input.async = asyncValue;
	}

	if (raw.durableLaunchBarrier !== undefined) {
		try {
			assertDurableLaunchBarrierV2Descriptor(raw.durableLaunchBarrier);
		} catch (error) {
			return failure(
				error instanceof Error ? error.message : String(error),
				failureExecutorId,
			);
		}
		input.durableLaunchBarrier = raw.durableLaunchBarrier;
	}

	if (raw.onComplete !== undefined) {
		if (!isOnCompleteAction(raw.onComplete)) {
			return failure(
				`unsupported onComplete ${formatValue(raw.onComplete)}; supported onComplete actions are ${formatOptions(ON_COMPLETE_ACTIONS)}.`,
				failureExecutorId,
			);
		}
		input.onComplete = raw.onComplete;
	}

	if (raw.asyncDependency !== undefined) {
		if (!isAsyncDependency(raw.asyncDependency)) {
			return failure(
				`unsupported asyncDependency ${formatValue(raw.asyncDependency)}; supported async dependencies are ${formatOptions(ASYNC_DEPENDENCIES)}.`,
				failureExecutorId,
			);
		}
		input.asyncDependency = raw.asyncDependency;
	}

	if (raw.timeoutMs !== undefined) {
		const timeoutMs = validateTimeoutMs(raw.timeoutMs, failureExecutorId);
		if (typeof timeoutMs !== "number") return timeoutMs;
		input.timeoutMs = timeoutMs;
	}

	if (raw.model !== undefined) {
		const model = validateString(raw.model, "model", failureExecutorId);
		if (typeof model !== "string") return model;
		input.model = model;
	}

	if (raw.tools !== undefined) {
		const tools = validateTools(raw.tools, "tools", failureExecutorId);
		if (!Array.isArray(tools)) return tools;
		input.tools = tools;
	}

	if (raw.systemPrompt !== undefined) {
		const systemPrompt = validateString(
			raw.systemPrompt,
			"systemPrompt",
			failureExecutorId,
		);
		if (typeof systemPrompt !== "string") return systemPrompt;
		input.systemPrompt = systemPrompt;
	}

	if (raw.captureToolCalls !== undefined) {
		const captureToolCalls = validateBoolean(
			raw.captureToolCalls,
			"captureToolCalls",
			failureExecutorId,
		);
		if (typeof captureToolCalls !== "boolean") return captureToolCalls;
		input.captureToolCalls = captureToolCalls;
	}

	if (input.durableLaunchBarrier !== undefined) {
		if (input.mode === "parallel" || input.tasks !== undefined) {
			return failure(
				"durableLaunchBarrier supports one durable run only; parallel tasks need distinct barriers.",
				failureExecutorId,
			);
		}
		if (
			input.async !== true &&
			input.onComplete !== "detach" &&
			input.onComplete !== "notify"
		) {
			return failure(
				"durableLaunchBarrier requires durable async execution.",
				failureExecutorId,
			);
		}
	}

	return { ok: true, input };
}
