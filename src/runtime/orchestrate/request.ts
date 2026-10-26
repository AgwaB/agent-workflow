// New in agent-workflow (WP2a-2): executor-neutral run input, its validation, the SubmitRequest
// built from it, and the execution-plan digest a durable worker reports in barrier READY.
// Replaces pi-subagent's Pi-specific request fields (agent, backend, extensions, noExtensions,
// thinking, …) with an `ExecutorDescriptor` plus SDK `SubmitRequest` fields.
import {
	type ApprovalPolicy,
	defaultApprovalPolicy,
} from "../../sdk/approval.js";
import type {
	IsolationPolicy,
	McpServerSpec,
	SubmitRequest,
} from "../../sdk/contract.js";
import {
	type ExecutorDescriptor,
	validateExecutorDescriptor,
} from "../../sdk/descriptor.js";
import { TOOL_KINDS } from "../../sdk/events.js";
import {
	type ResolveInput,
	type ResolveValidationFailure,
	type SubagentTaskInput,
} from "../core/constants.js";
import { validateResolveInput } from "../core/validation.js";
import { durableLaunchBarrierDigest } from "../durable-launch-barrier.js";
import { DURABLE_WORKER_BINDING_ENV } from "../workers/durable-worker-binding.js";

/** Legacy Pi child env name that carries the same binding (WP6 Pi adapter). */
export const LEGACY_PI_DURABLE_WORKER_BINDING_ENV =
	"PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON";

/**
 * Deadline used when the caller sets no `timeoutMs`: the largest valid `Date` (8.64e15 ms).
 * pi-subagent had no default timeout; SubmitRequest requires a finite deadline, so "none" is
 * encoded as "the end of representable time".
 */
export const NO_DEADLINE_MS = 8_640_000_000_000_000;

/**
 * Executor request fields carried by a run input (SubmitRequest minus `authority`, `cwd`,
 * `deadlineMs`, `artifactsDir`, which the runtime derives). `task` keeps its pi-subagent name and
 * becomes `SubmitRequest.prompt`.
 */
export interface ExecutorRequestFields {
	task?: string;
	systemPrompt?: string;
	model?: string;
	/** Replaces pi-subagent `thinking`; passed through verbatim (executor-specific levels). */
	effort?: string;
	tools?: string[];
	readOnly?: boolean;
	mcpServers?: McpServerSpec[];
	sessionId?: string;
	resumeSessionId?: string;
	env?: Record<string, string>;
	isolation?: IsolationPolicy;
	approvalPolicy?: Partial<ApprovalPolicy>;
	/** Engine-issued idempotency key (B3). Default: `<runId>:<attemptId>`. */
	attemptKey?: string;
}

/** Pi-specific keys that the runtime API refuses (they have executor-neutral replacements). */
export const PI_SPECIFIC_INPUT_KEYS = [
	"agent",
	"backend",
	"extensions",
	"noExtensions",
	"thinking",
	"thinkingLevel",
	"reasoningLevel",
	"agentScope",
	"confirmProjectAgents",
	"roleContext",
	"skills",
	"toolResultBudget",
	"visible",
] as const;

type PiSpecificKey = (typeof PI_SPECIFIC_INPUT_KEYS)[number];
type GenericTaskFields = Omit<
	SubagentTaskInput,
	PiSpecificKey | keyof ExecutorRequestFields
>;
type GenericRunFields = Omit<
	ResolveInput,
	PiSpecificKey | "tasks" | keyof ExecutorRequestFields
>;

export interface RuntimeTaskInput
	extends GenericTaskFields,
		ExecutorRequestFields {
	/** Per-task executor override; defaults to the run's executor. */
	executor?: ExecutorDescriptor;
}

export interface RuntimeRunInput
	extends GenericRunFields,
		ExecutorRequestFields {
	executor: ExecutorDescriptor;
	tasks?: RuntimeTaskInput[];
}

export type RuntimeValidationResult =
	| { ok: true; input: RuntimeRunInput }
	| { ok: false; failure: ResolveValidationFailure };

const SESSION_ID = /^[A-Za-z0-9._-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string, backend?: string): RuntimeValidationResult {
	return {
		ok: false,
		failure: {
			...(backend === undefined ? {} : { backend }),
			status: "failed",
			failureKind: "validation",
			error,
		},
	};
}

const PI_REPLACEMENTS: Partial<Record<PiSpecificKey, string>> = {
	agent: "supply prompt/systemPrompt/model/tools in the request",
	backend: "pass executor: ExecutorDescriptor",
	thinking: "use effort",
	thinkingLevel: "use effort",
	reasoningLevel: "use effort",
	extensions: "use mcpServers or executor config",
	noExtensions: "use isolation",
};

/** Validate the executor-specific request fields of one run or task. Returns an error or null. */
function validateRequestFields(
	value: Record<string, unknown>,
	label: string,
): string | null {
	for (const key of PI_SPECIFIC_INPUT_KEYS)
		if (value[key] !== undefined)
			return `${label}${key} is a Pi-specific option and is not accepted by the runtime API${PI_REPLACEMENTS[key] ? `; ${PI_REPLACEMENTS[key]}` : ""}.`;
	if (
		value.effort !== undefined &&
		(typeof value.effort !== "string" || value.effort.length === 0)
	)
		return `${label}effort must be a non-empty string when provided.`;
	if (value.readOnly !== undefined && typeof value.readOnly !== "boolean")
		return `${label}readOnly must be a boolean when provided.`;
	if (
		value.attemptKey !== undefined &&
		(typeof value.attemptKey !== "string" || value.attemptKey.length === 0)
	)
		return `${label}attemptKey must be a non-empty string when provided.`;
	if (
		value.resumeSessionId !== undefined &&
		(typeof value.resumeSessionId !== "string" ||
			!SESSION_ID.test(value.resumeSessionId))
	)
		return `${label}resumeSessionId must contain only letters, numbers, dots, underscores, or dashes.`;
	if (value.env !== undefined) {
		if (!isRecord(value.env)) return `${label}env must be an object.`;
		for (const [key, entry] of Object.entries(value.env))
			if (typeof entry !== "string")
				return `${label}env.${key} must be a string.`;
	}
	if (value.isolation !== undefined) {
		if (
			!isRecord(value.isolation) ||
			typeof value.isolation.inherit !== "boolean"
		)
			return `${label}isolation must be { inherit: boolean }.`;
	}
	if (value.approvalPolicy !== undefined) {
		const policy = value.approvalPolicy;
		if (!isRecord(policy)) return `${label}approvalPolicy must be an object.`;
		if (
			policy.allowKinds !== undefined &&
			(!Array.isArray(policy.allowKinds) ||
				policy.allowKinds.some(
					(kind) => !(TOOL_KINDS as readonly unknown[]).includes(kind),
				))
		)
			return `${label}approvalPolicy.allowKinds must list ACP tool kinds.`;
		if (
			policy.interactive !== undefined &&
			typeof policy.interactive !== "boolean"
		)
			return `${label}approvalPolicy.interactive must be a boolean.`;
		if (
			policy.timeoutMs !== undefined &&
			(typeof policy.timeoutMs !== "number" ||
				!Number.isFinite(policy.timeoutMs) ||
				policy.timeoutMs < 0)
		)
			return `${label}approvalPolicy.timeoutMs must be a non-negative number.`;
	}
	if (value.mcpServers !== undefined) {
		if (!Array.isArray(value.mcpServers))
			return `${label}mcpServers must be an array.`;
		for (const [index, server] of value.mcpServers.entries()) {
			if (
				!isRecord(server) ||
				typeof server.name !== "string" ||
				server.name.length === 0 ||
				typeof server.command !== "string" ||
				server.command.length === 0 ||
				!Array.isArray(server.args) ||
				server.args.some((arg) => typeof arg !== "string") ||
				(server.env !== undefined &&
					(!isRecord(server.env) ||
						Object.values(server.env).some(
							(entry) => typeof entry !== "string",
						)))
			)
				return `${label}mcpServers[${index}] must be { name, command, args: string[], env?: Record<string,string> }.`;
		}
	}
	if (value.executor !== undefined) {
		const problems = validateExecutorDescriptor(value.executor);
		if (problems.length > 0)
			return `${label}executor is invalid: ${problems.join("; ")}`;
	}
	return null;
}

const REQUEST_ONLY_KEYS = [
	"executor",
	"effort",
	"readOnly",
	"mcpServers",
	"resumeSessionId",
	"env",
	"isolation",
	"approvalPolicy",
	"attemptKey",
	"parentSessionId",
] as const;

function pickRequestFields(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of REQUEST_ONLY_KEYS)
		if (value[key] !== undefined) picked[key] = value[key];
	return picked;
}

function withoutRequestFields(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const copy = { ...value };
	for (const key of REQUEST_ONLY_KEYS) delete copy[key];
	return copy;
}

/**
 * Validate a runtime run input. Generic fields go through the ported `validateResolveInput`
 * (with `backend` set to the executor id); executor fields are validated here. Pi-specific keys
 * are refused with a validation failure that names the replacement.
 */
export function validateRuntimeRunInput(raw: unknown): RuntimeValidationResult {
	if (!isRecord(raw)) return fail("runtime run input must be an object.");
	if (raw.executor === undefined)
		return fail("executor (an ExecutorDescriptor) is required.");
	const descriptorProblems = validateExecutorDescriptor(raw.executor);
	if (descriptorProblems.length > 0)
		return fail(`executor is invalid: ${descriptorProblems.join("; ")}`);
	const executor = raw.executor as ExecutorDescriptor;
	const backend = executor.id;
	const topProblem = validateRequestFields(raw, "");
	if (topProblem !== null) return fail(topProblem, backend);
	if (
		raw.parentSessionId !== undefined &&
		(typeof raw.parentSessionId !== "string" ||
			raw.parentSessionId.length === 0)
	)
		return fail(
			"parentSessionId must be a non-empty string when provided.",
			backend,
		);
	let taskExtras: Record<string, unknown>[] | undefined;
	let genericTasks: unknown;
	if (Array.isArray(raw.tasks)) {
		taskExtras = [];
		const tasks: unknown[] = [];
		for (const [index, task] of raw.tasks.entries()) {
			if (!isRecord(task)) {
				tasks.push(task);
				taskExtras.push({});
				continue;
			}
			const problem = validateRequestFields(task, `tasks[${index}].`);
			if (problem !== null) return fail(problem, backend);
			taskExtras.push(pickRequestFields(task));
			tasks.push(withoutRequestFields(task));
		}
		genericTasks = tasks;
	} else genericTasks = raw.tasks;
	const generic = validateResolveInput({
		...withoutRequestFields(raw),
		...(genericTasks === undefined ? {} : { tasks: genericTasks }),
		backend,
	});
	if (!generic.ok) return { ok: false, failure: generic.failure };
	const { backend: _backend, ...rest } = generic.input;
	const input: RuntimeRunInput = {
		...(rest as GenericRunFields & ExecutorRequestFields),
		...(pickRequestFields(raw) as Partial<RuntimeRunInput>),
		executor,
	};
	if (rest.tasks !== undefined)
		input.tasks = rest.tasks.map((task, index) => ({
			...(task as GenericTaskFields & ExecutorRequestFields),
			...(taskExtras?.[index] ?? {}),
		}));
	return { ok: true, input };
}

/** Request fields of one prepared attempt (the SubmitRequest without its authority). */
export type SubmitRequestFields = Omit<SubmitRequest, "authority">;

export function defaultAttemptKey(runId: string, attemptId: string): string {
	return `${runId}:${attemptId}`;
}

function sanitizedEnv(
	env: Record<string, string> | undefined,
): Record<string, string> {
	const copy = { ...(env ?? {}) };
	// The binding is handed over by the authority after release, never by the caller.
	delete copy[DURABLE_WORKER_BINDING_ENV];
	delete copy[LEGACY_PI_DURABLE_WORKER_BINDING_ENV];
	return copy;
}

/**
 * Normalize a run input into the SubmitRequest fields for one attempt. Deterministic for a given
 * input, run/attempt id, cwd, start time and artifacts dir (the plan digest depends on it).
 */
export function buildSubmitRequestFields(options: {
	input: ExecutorRequestFields & { timeoutMs?: number };
	runId: string;
	attemptId: string;
	/** Execution cwd (the worktree path in worktree mode). */
	cwd: string;
	startedAt: string | Date;
	artifactsDir?: string;
}): SubmitRequestFields {
	const { input } = options;
	if (typeof input.task !== "string")
		throw new Error("executor execution requires a task (prompt).");
	const startedMs =
		options.startedAt instanceof Date
			? options.startedAt.getTime()
			: Date.parse(options.startedAt);
	if (!Number.isFinite(startedMs))
		throw new Error("startedAt must be a valid timestamp.");
	const deadlineMs =
		input.timeoutMs === undefined
			? NO_DEADLINE_MS
			: Math.min(NO_DEADLINE_MS, startedMs + input.timeoutMs);
	return {
		attemptKey:
			input.attemptKey ?? defaultAttemptKey(options.runId, options.attemptId),
		cwd: options.cwd,
		prompt: input.task,
		...(input.systemPrompt === undefined
			? {}
			: { systemPrompt: input.systemPrompt }),
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.effort === undefined ? {} : { effort: input.effort }),
		tools: [...(input.tools ?? [])],
		readOnly: input.readOnly ?? false,
		mcpServers: (input.mcpServers ?? []).map((server) => ({
			name: server.name,
			command: server.command,
			args: [...server.args],
			...(server.env === undefined ? {} : { env: { ...server.env } }),
		})),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.resumeSessionId === undefined
			? {}
			: { resumeSessionId: input.resumeSessionId }),
		deadlineMs,
		env: sanitizedEnv(input.env),
		isolation: { inherit: input.isolation?.inherit ?? false },
		approvalPolicy: defaultApprovalPolicy(input.approvalPolicy ?? {}),
		...(options.artifactsDir === undefined
			? {}
			: { artifactsDir: options.artifactsDir }),
	};
}

export const EXECUTION_PLAN_SCHEMA = "agent-workflow-durable-execution-plan-v1";

export interface ExecutionPlan {
	schema: typeof EXECUTION_PLAN_SCHEMA;
	/** Executor id (= `executor.id`); kept under the pi-subagent field name. */
	backend: string;
	executor: ExecutorDescriptor;
	runId: string;
	attemptId: string;
	/** Execution cwd (worktree path in worktree mode). */
	cwd: string;
	workspace: { mode: string; cwd: string; worktreePath: string | null };
	request: SubmitRequestFields;
}

/**
 * The plan a durable worker reports in barrier READY (`executionPlanSha256`). It is computed
 * before `submit` and covers: the executor descriptor (id, version, contractVersion, module,
 * config), run and attempt ids, the execution cwd, the workspace (mode, base cwd, worktree path),
 * and every SubmitRequest field except the authority object (attemptKey, cwd, prompt,
 * systemPrompt, model, effort, tools, readOnly, mcpServers incl. env, sessionId,
 * resumeSessionId, deadlineMs, env, isolation, approvalPolicy, artifactsDir). Digest:
 * SHA-256 over canonical JSON (sorted keys, undefined dropped) — `durableLaunchBarrierDigest`.
 */
export function buildExecutionPlan(options: {
	executor: ExecutorDescriptor;
	runId: string;
	attemptId: string;
	workspace: { mode: string; cwd: string; worktreePath: string | null };
	request: SubmitRequestFields;
}): ExecutionPlan {
	return {
		schema: EXECUTION_PLAN_SCHEMA,
		backend: options.executor.id,
		executor: options.executor,
		runId: options.runId,
		attemptId: options.attemptId,
		cwd: options.request.cwd,
		workspace: options.workspace,
		request: options.request,
	};
}

export function executionPlanDigest(plan: ExecutionPlan): string {
	return durableLaunchBarrierDigest(plan);
}
