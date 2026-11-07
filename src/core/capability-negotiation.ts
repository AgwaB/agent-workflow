// New in agent-workflow (WP4d): B4 capability negotiation before launch (design §8.2/§8.3, owner
// decisions B4/B5, plan §2.2). Once per run, after executor selection: probe the executor (no model
// turn, bounded), merge the probed rows over its declared table, negotiate every compiled stage, fail
// before any launch on a refusal, record the
// probe summary, effective capabilities, per-stage reports and the preview on the run record.
// At launch the task backend re-derives the same decision from the recorded capabilities, so a
// runtime-generated task (foreach item, loop child, dynamic worker) is checked the same way and
// `forcedReadOnly` reaches the SubmitRequest.
// WP4e: the run permission mode reaches every stage context (free: coarse allowlist and environment
// warnings are recorded degradations, never refusals) and the preview's first line.
// Authored readOnly intent remains in each context; the SDK negotiates it only in safe mode.
// Free records a short informational note instead of requiring/warning about readOnly.
// WP5b: the probe summary keeps the executor's declared MCP output limit (mcpOutputLimitChars,
// mcpOutputNoticeChars) so the artifact server is launched with a measured limit.
// WP17: install/login hints come from executor-default.ts (first-run guidance names the install command).
// WP35: host-tool inheritance (Pi host + Pi executor) is recorded as a notice in the preview and record.
// WP31 (Q4): a mixed run (role profile) negotiates every stage against its own executor
// (`task.runtime.executor`): each executor is probed once, refusals name the stage and its executor,
// role-assigned models are checked against each probe's model list (unknown → refused; the probe
// cannot tell → notice), and the launch-time check uses the task executor's recorded capabilities.
// WP31×WP35: in a mixed run only pi stages inherit host tools; the host-tools notice names them.
// WP31 follow-up: unknown → refused only when the probe declares its list exhaustive
// (`modelListComplete`); a partial list (Claude aliases, Codex visible catalog) → "not verified by
// probe" notice and the run proceeds.
import {
	type ExecutorCapabilities,
	mergeProbedCapabilities,
} from "../sdk/capabilities.js";
import type { ExecutorProbe } from "../sdk/contract.js";
import { EXECUTOR_CONTRACT_VERSION } from "../sdk/contract.js";
import { type ExecutorDescriptor, loadExecutor } from "../sdk/descriptor.js";
import { mapTools, type ToolMapping } from "../sdk/tools.js";
import {
	resolveExecutorEffort,
	resolveExecutorModel,
} from "./executor-model-id.js";
import {
	buildCapabilityPreview,
	DEFAULT_REQUIREMENTS,
	type NegotiationReport,
	negotiateCapabilities,
	type RequirementKey,
	type StageRequirementContext,
} from "../sdk/requirements.js";
import { executorInheritsHostTools } from "./executor-policy.js";
import { strictCapabilityKeysProblem } from "./artifact-graph-schema.js";
import { executorSetupHints, installText } from "./executor-default.js";
import { modelListed, probeModelList } from "./role-profiles.js";
import { workflowTaskReadOnly } from "./tool-policy.js";
import type {
	CompiledLoopStageRecord,
	CompiledTask,
	CompiledWorkflow,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutorProbeSummary,
	WorkflowRunCapabilityNegotiation,
	WorkflowRunExecutorNames,
	WorkflowRunRecord,
	WorkflowStageCapabilityNegotiation,
} from "./types.js";

/** Default bound for one executor probe (version/auth/status commands only). */
export const DEFAULT_EXECUTOR_PROBE_TIMEOUT_MS = 30_000;

/** Probe seam: what the engine needs from an executor before launch. Injectable for tests. */
export type WorkflowExecutorProber = (
	descriptor: ExecutorDescriptor,
) => Promise<{
	probe: ExecutorProbe;
	capabilities: ExecutorCapabilities;
	/** The adapter's tool mapping, when it declares one (pre-launch tool check). */
	toolMapping?: ToolMapping;
}>;

export type WorkflowCapabilityErrorCode =
	| "EXECUTOR_PROBE_FAILED"
	| "EXECUTOR_NOT_INSTALLED"
	| "EXECUTOR_AUTH_NOT_READY"
	| "CAPABILITY_REFUSED"
	| "MODEL_UNKNOWN";

/** Raised before any run record or launch exists (and by the launch-time check for one task). */
export class WorkflowCapabilityError extends Error {
	readonly code: WorkflowCapabilityErrorCode;
	readonly executorId: string;
	/** Preview text when negotiation got that far. */
	readonly preview?: string;

	constructor(
		code: WorkflowCapabilityErrorCode,
		message: string,
		executorId: string,
		preview?: string,
	) {
		super(message);
		this.name = "WorkflowCapabilityError";
		this.code = code;
		this.executorId = executorId;
		if (preview !== undefined) this.preview = preview;
	}
}

/** CLI commands to name when an executor is missing or logged out (D1: each CLI owns its login). */
function hintsFor(executorId: string): {
	install: string;
	login: string;
	setup: string;
} {
	const hints = executorSetupHints(executorId);
	return {
		install: `\`${hints.check}\``,
		login: hints.login,
		// WP17 first-run guidance: the exact install command and where it is documented.
		setup: `install it: ${installText(hints)}; or choose another executor with --executor <id>`,
	};
}

const defaultProber: WorkflowExecutorProber = async (descriptor) => {
	const executor = await loadExecutor(descriptor);
	return {
		capabilities: executor.capabilities(),
		probe: await executor.probe(),
		...(executor.toolMapping === undefined
			? {}
			: { toolMapping: executor.toolMapping }),
	};
};

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			// Not unref'd (2026-11-05, first CI run on Node 22): it keeps the loop alive while the probe
			// hangs; cleared as soon as the race settles.
			timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

function probeSummary(probe: ExecutorProbe): WorkflowExecutorProbeSummary {
	return {
		installed: probe.installed === true,
		cliVersion: typeof probe.cliVersion === "string" ? probe.cliVersion : null,
		auth: probe.auth,
		...(Array.isArray(probe.notes) && probe.notes.length > 0
			? {
					notes: probe.notes
						.filter((note): note is string => typeof note === "string")
						.map((note) => note.slice(0, 500)),
				}
			: {}),
		...(positiveInteger(probe.mcpOutputLimitChars)
			? { mcpOutputLimitChars: probe.mcpOutputLimitChars }
			: {}),
		...(positiveInteger(probe.mcpOutputNoticeChars)
			? { mcpOutputNoticeChars: probe.mcpOutputNoticeChars }
			: {}),
		probedAt: new Date().toISOString(),
	};
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Probe once (no model turn), bounded by `timeoutMs`. Not installed, or auth `missing`/`expired`,
 * fails before launch naming the executor and the CLI command to run. `auth: "unknown"` proceeds
 * (some CLIs cannot report it without a model call) and stays visible in the record.
 */
export async function probeWorkflowExecutor(
	descriptor: ExecutorDescriptor,
	options: { prober?: WorkflowExecutorProber; timeoutMs?: number } = {},
): Promise<{
	summary: WorkflowExecutorProbeSummary;
	capabilities: ExecutorCapabilities;
	/** WP31: models the probe lists (no model call); null when it cannot tell. */
	models: string[] | null;
	/** WP31 follow-up: the probe declares `models` exhaustive (`modelListComplete: true`). */
	modelListComplete: boolean;
	toolMapping?: ToolMapping;
	modelEfforts?: Readonly<Record<string, readonly string[]>>;
	/** Tools the executor cannot provide here, with why and how to fix it (probe). */
	unavailableTools?: Readonly<Record<string, string>>;
}> {
	const id = descriptor.id;
	const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_PROBE_TIMEOUT_MS;
	let result: Awaited<ReturnType<WorkflowExecutorProber>>;
	try {
		result = await withTimeout(
			(options.prober ?? defaultProber)(descriptor),
			timeoutMs,
			() =>
				new WorkflowCapabilityError(
					"EXECUTOR_PROBE_FAILED",
					`executor "${id}" probe did not finish within ${timeoutMs} ms; the run was not started. Check that ${hintsFor(id).install} answers.`,
					id,
				),
		);
	} catch (error) {
		if (error instanceof WorkflowCapabilityError) throw error;
		throw new WorkflowCapabilityError(
			"EXECUTOR_PROBE_FAILED",
			`executor "${id}" could not be probed: ${error instanceof Error ? error.message : String(error)}. The run was not started.`,
			id,
		);
	}
	const summary = probeSummary(result.probe);
	if (!summary.installed)
		throw new WorkflowCapabilityError(
			"EXECUTOR_NOT_INSTALLED",
			`executor "${id}" is not installed or not runnable (${hintsFor(id).install} failed${
				summary.notes?.[0] === undefined ? "" : `: ${summary.notes[0]}`
			}); ${hintsFor(id).setup}. The run was not started.`,
			id,
		);
	if (summary.auth === "missing" || summary.auth === "expired")
		throw new WorkflowCapabilityError(
			"EXECUTOR_AUTH_NOT_READY",
			`executor "${id}" is not logged in (auth ${summary.auth}); ${hintsFor(id).login}, then start the run again. The run was not started.`,
			id,
		);
	let capabilities: ExecutorCapabilities;
	try {
		capabilities = mergeProbedCapabilities(
			result.capabilities,
			result.probe.capabilities,
		);
	} catch (error) {
		throw new WorkflowCapabilityError(
			"EXECUTOR_PROBE_FAILED",
			`executor "${id}" reported invalid capabilities: ${error instanceof Error ? error.message : String(error)}. The run was not started.`,
			id,
		);
	}
	return {
		summary,
		capabilities,
		models: probeModelList(
			result.probe as Parameters<typeof probeModelList>[0],
		),
		modelListComplete: result.probe.modelListComplete === true,
		...(result.toolMapping === undefined
			? {}
			: { toolMapping: result.toolMapping }),
		...(result.probe.modelEfforts === undefined
			? {}
			: { modelEfforts: result.probe.modelEfforts }),
		...(result.probe.unavailableTools === undefined ||
		Object.keys(result.probe.unavailableTools).length === 0
			? {}
			: { unavailableTools: result.probe.unavailableTools }),
	};
}

/**
 * `ctx.strict` for a run: the declared profile's `executionProfileStrictCapabilities` entry, or a
 * saved user profile's `strictCapabilities`. WP37 (B2 field by field): a declared profile without
 * an entry inherits `savedUnderDeclared` (the saved user profile layered under it). Unknown
 * capability names fail before launch.
 */
export function workflowProfileStrictCapabilities(
	spec: unknown,
	profileName: string | undefined,
	captured:
		| Pick<WorkflowCapturedExecutionProfile, "name" | "strictCapabilities">
		| undefined,
	savedUnderDeclared?: { name: string; strictCapabilities?: string[] },
): string[] {
	let keys: unknown;
	let where: string;
	if (profileName !== undefined) {
		const map = (
			spec as { executionProfileStrictCapabilities?: unknown } | undefined
		)?.executionProfileStrictCapabilities;
		keys =
			map !== null && typeof map === "object" && !Array.isArray(map)
				? (map as Record<string, unknown>)[profileName]
				: undefined;
		where = `workflow execution profile "${profileName}"`;
		if (keys === undefined && savedUnderDeclared !== undefined) {
			keys = savedUnderDeclared.strictCapabilities;
			where = `saved user profile "${savedUnderDeclared.name}"`;
		}
	} else {
		keys = captured?.strictCapabilities;
		where = `saved user profile "${captured?.name ?? ""}"`;
	}
	if (keys === undefined) return [];
	const problem = strictCapabilityKeysProblem(keys);
	if (problem !== undefined)
		throw new Error(
			`${where} strictCapabilities ${problem}; the run was not started`,
		);
	return [...new Set(keys as string[])];
}

/** Run-level inputs to every stage's requirement context. */
export interface WorkflowCapabilityPolicy {
	allowUnverified: string[];
	strict: string[];
	allowReadOnlyDowngrade: boolean;
	/**
	 * WP4e (D2 revised). `free`: coarse tool allowlists and environment
	 * warnings are recorded degradations, never refusals.
	 * Absent (records created before WP4e) = `safe`.
	 */
	permissionMode?: "free" | "safe";
	/**
	 * 2026-11-04: the run uses the experimental same-session repair
	 * (`AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`). Only then does a stage need `resume`: without
	 * it every executor repairs in a fresh attempt, and a missing `resume` changes nothing (a live
	 * Claude Code host asked the user to accept antigravity's "a repair starts a new session" on every
	 * launch). Absent = off.
	 */
	sameSessionRepair?: boolean;
}

/** B5: a task inherits the user's context files/skills only when the stage or agent opts in. */
export function workflowTaskInheritsContext(
	task: Pick<CompiledTask, "inheritProjectContext" | "inheritSkills">,
): boolean {
	return task.inheritProjectContext === true || task.inheritSkills === true;
}

/** Compiled tasks that never reach an executor themselves. */
function isExecutorTask(task: CompiledTask): boolean {
	return (
		task.support === undefined &&
		task.loopPlaceholder === undefined &&
		task.dynamic === undefined &&
		task.kind !== "loop"
	);
}

/**
 * StageRequirementContext of one compiled task (B4/B5, plan §6.5). Mirrors what the task backend
 * puts on the SubmitRequest: readOnly from the task's safety capability or its authored readOnly (WP12d-1), the Pi tool list, B5
 * `inherit` (same rule as `workflowTaskIsolation`), MCP injection for required reads, artifact access or an
 * MCP tool provider, same-session repair for artifact-graph tasks, fast tier when on.
 */
export function workflowTaskRequirementContext(
	task: CompiledTask,
	policy: WorkflowCapabilityPolicy,
): StageRequirementContext {
	const requiredReads = task.artifactGraph?.requiredReads ?? [];
	const mcpProvider = Object.values(task.runtime.toolProviders ?? {}).some(
		(provider) => provider.mcpServer !== undefined,
	);
	const needsMcp =
		requiredReads.length === 0 &&
		(task.artifactGraph?.artifactAccess === "enabled" || mcpProvider);
	return {
		readOnly: workflowTaskReadOnly(task),
		hasRequiredReads: requiredReads.length > 0,
		...(task.runtime.tools === undefined ? {} : { tools: task.runtime.tools }),
		allowReadOnlyDowngrade: policy.allowReadOnlyDowngrade,
		inherit: workflowTaskInheritsContext(task),
		wantsCost: true,
		partialStream: (task.artifactGraph?.output.partial?.paths.length ?? 0) > 0,
		sameSessionRepair:
			task.artifactGraph?.enabled === true && policy.sameSessionRepair === true,
		fastTier: task.runtime.fast === "on",
		...(needsMcp
			? { requirements: { mcpInjection: DEFAULT_REQUIREMENTS.mcpInjection } }
			: {}),
		allowUnverified: policy.allowUnverified as RequirementKey[],
		strict: policy.strict as RequirementKey[],
		permissionMode: policy.permissionMode ?? "safe",
	};
}

/** Stage templates to negotiate before launch: executor tasks plus loop child/exhaustion templates. */
export function workflowNegotiationTargets(
	compiled: Pick<CompiledWorkflow, "tasks" | "stages">,
): CompiledTask[] {
	const targets = new Map<string, CompiledTask>();
	const add = (task: CompiledTask | undefined) => {
		if (task === undefined || !isExecutorTask(task) || targets.has(task.id))
			return;
		targets.set(task.id, task);
	};
	for (const task of compiled.tasks) add(task);
	for (const stage of compiled.stages ?? []) {
		if ((stage as { type?: unknown }).type !== "loop") continue;
		const loop = stage as CompiledLoopStageRecord;
		for (const template of loop.childTemplates ?? []) add(template);
		add(loop.onExhausted?.template);
	}
	return [...targets.values()];
}

function optInHint(code: string, policy: WorkflowCapabilityPolicy): string {
	const [kind, ...rest] = code.split(":");
	const key = rest.join(":");
	if (kind === "CAPABILITY_UNVERIFIED")
		return `opt in with run option allowUnverifiedCapabilities: ["${key}"] (B4: unverified is refused by default)`;
	if (kind === "CAPABILITY_STRICT")
		return `the execution profile lists "${key.split(".")[0]}" in strictCapabilities; choose a profile without it or another executor`;
	if (kind === "CAPABILITY_MISSING" && key === "contextIsolation")
		return "no opt-in for isolated stages; set inheritProjectContext/inheritSkills on the agent to accept inherited user context (B5), or choose another executor";
	if (
		kind === "CAPABILITY_MISSING" &&
		(key.startsWith("toolAllowlist") || key.startsWith("tool.")) &&
		!policy.allowReadOnlyDowngrade
	)
		return 'opt in with spec "allowReadOnlyDowngrade": true (the stage then runs with readOnly enforced), or run with permissionMode "free" (coarse tool limits accepted)';
	return "no opt-in exists; choose another executor";
}

function refusalLines(
	stages: readonly WorkflowStageCapabilityNegotiation[],
	policy: WorkflowCapabilityPolicy,
	/** WP31: name each stage's executor (mixed runs). */
	withExecutor = false,
): string[] {
	const lines: string[] = [];
	for (const stage of stages)
		for (const entry of stage.report.entries) {
			if (entry.outcome !== "refused") continue;
			const code = entry.code ?? entry.key;
			const observed =
				entry.observed === null
					? "unmapped"
					: `${entry.observed.level}/${entry.observed.source}`;
			lines.push(
				`  - stage "${stage.label}"${withExecutor ? ` on ${stage.report.executorId}` : ""}: ${entry.key} — ${code} (executor has ${observed}${
					entry.note === undefined ? "" : `; ${entry.note}`
				}); ${optInHint(code, policy)}`,
			);
		}
	return lines;
}

function negotiateTask(
	executor: { id: string; version: string },
	capabilities: ExecutorCapabilities,
	task: CompiledTask,
	policy: WorkflowCapabilityPolicy,
	negotiatedAt: WorkflowStageCapabilityNegotiation["negotiatedAt"],
): WorkflowStageCapabilityNegotiation {
	return {
		label: task.id,
		...(task.stageId === undefined ? {} : { stageId: task.stageId }),
		negotiatedAt,
		report: negotiateCapabilities(
			executor,
			capabilities,
			workflowTaskRequirementContext(task, policy),
		),
	};
}

function probeHeader(summary: WorkflowExecutorProbeSummary): string[] {
	return [
		`  probe: installed, cli ${summary.cliVersion ?? "unknown"}, auth ${summary.auth}${
			summary.reusedFromRunId === undefined
				? ""
				: ` (from parent run ${summary.reusedFromRunId})`
		}`,
	];
}

/**
 * WP31×WP35: one stage's host-tool decision when the host lent its tools (Pi host): `inherited`
 * (pi executor), `readOnly` (a readOnly stage never inherits), `no-tools` (an explicitly tool-free
 * stage), `executor` (the stage runs on another executor; only pi inherits host tools).
 */
export type WorkflowStageHostTools = NonNullable<
	WorkflowStageCapabilityNegotiation["hostTools"]
>;

function stageHostTools(
	task: CompiledTask,
	runExecutorId: string | undefined,
	offered: boolean,
): WorkflowStageHostTools | undefined {
	if (task.runtime.inheritHostTools === true) return "inherited";
	if (task.runtime.inheritHostTools === false)
		return workflowTaskReadOnly(task) ? "readOnly" : "no-tools";
	if (!offered) return undefined;
	const executorId = task.runtime.executor ?? runExecutorId;
	return executorInheritsHostTools(executorId) ? undefined : "executor";
}

function stageHostToolsLine(
	status: WorkflowStageHostTools,
	executorId: string,
): string {
	switch (status) {
		case "inherited":
			return "  host tools: inherited (Pi host codemode, tool_search, mcp__*, MCP resources; mutation-capable)";
		case "readOnly":
			return "  host tools: not inherited (readOnly stage)";
		case "no-tools":
			return "  host tools: not inherited (tool-free stage)";
		case "executor":
			return `  host tools: not inherited (${executorId} executor; only pi inherits the Pi host's tools)`;
	}
}

/**
 * WP35: one notice recording host-tool inheritance (Pi host + Pi executor) in the preview and the
 * negotiation record: which stages get the host's native tools and which readOnly stages do not.
 * WP31×WP35: with `runExecutorId`, a mixed run's stages on another executor are named too.
 */
export function hostToolInheritanceNotice(
	tasks: readonly CompiledTask[],
	runExecutorId?: string,
): string | undefined {
	const inheriting = tasks
		.filter((task) => task.runtime.inheritHostTools === true)
		.map((task) => task.id);
	const withheld = tasks
		.filter(
			(task) =>
				task.runtime.inheritHostTools === false && workflowTaskReadOnly(task),
		)
		.map((task) => task.id);
	if (inheriting.length === 0 && withheld.length === 0) return undefined;
	const byExecutor = new Map<string | undefined, string[]>();
	for (const task of tasks) {
		if (task.runtime.inheritHostTools !== undefined) continue;
		const executorId = task.runtime.executor ?? runExecutorId;
		if (executorInheritsHostTools(executorId)) continue;
		byExecutor.set(executorId, [
			...(byExecutor.get(executorId) ?? []),
			task.id,
		]);
	}
	const by = inheriting.length === 0 ? "no stage" : inheriting.join(", ");
	const not =
		withheld.length === 0
			? ""
			: `; not by readOnly stage${withheld.length === 1 ? "" : "s"} ${withheld.join(", ")}`;
	const others = [...byExecutor.entries()]
		.map(
			([executorId, ids]) =>
				`; not by ${executorId ?? "unselected executor"} stage${ids.length === 1 ? "" : "s"} ${ids.join(", ")} (only pi inherits)`,
		)
		.join("");
	return `host tools: the Pi host's codemode, tool_search, MCP tools (mcp__*) and MCP resource tools are inherited by ${by} (mutation-capable: worktree and approval rules apply)${not}${others}`;
}

export interface NegotiateWorkflowRunInput {
	descriptor: ExecutorDescriptor;
	compiled: Pick<CompiledWorkflow, "tasks" | "stages">;
	policy: WorkflowCapabilityPolicy;
	/** Reuse a recorded probe (nested runs) instead of probing again. */
	recorded?: Pick<
		WorkflowRunCapabilityNegotiation,
		"probe" | "capabilities" | "names"
	>;
	recordedFromRunId?: string;
	prober?: WorkflowExecutorProber;
	probeTimeoutMs?: number;
	/**
	 * WP31 (Q4): descriptors of every other executor of a mixed run. A task runs on
	 * `task.runtime.executor` (absent: `descriptor`).
	 */
	executors?: Record<string, ExecutorDescriptor>;
	/** WP31: role-assigned models, checked against their executor's probe model list. */
	modelChecks?: Array<{ slot: string; executor: string; model: string }>;
}

interface ProbedExecutor {
	version: string;
	contractVersion: string;
	summary: WorkflowExecutorProbeSummary;
	capabilities: ExecutorCapabilities;
	models: string[] | null;
	modelListComplete: boolean;
	toolMapping?: ToolMapping;
	/** Effort levels per model from the probe (Codex, Pi), when the CLI reports them. */
	modelEfforts?: Readonly<Record<string, readonly string[]>>;
	unavailableTools?: Readonly<Record<string, string>>;
}

/**
 * WP31: refusals and notices of the role-model check (no model call; probe lists only). A model
 * missing from an exhaustive list (`modelListComplete`) is refused; missing from a partial list
 * (Claude's aliases) or with no list at all, it is noted as not verified and the run proceeds.
 */
function checkRoleModels(
	checks: NonNullable<NegotiateWorkflowRunInput["modelChecks"]>,
	probes: ReadonlyMap<string, ProbedExecutor>,
): { refusals: string[]; notices: string[] } {
	const refusals: string[] = [];
	const notices: string[] = [];
	const unverified = new Map<string, string[]>();
	const partial = new Map<string, { listed: string[]; slots: string[] }>();
	for (const check of checks) {
		const listed = probes.get(check.executor)?.models ?? null;
		if (listed === null) {
			const slots = unverified.get(`${check.executor}\0${check.model}`) ?? [];
			slots.push(check.slot);
			unverified.set(`${check.executor}\0${check.model}`, slots);
			continue;
		}
		if (modelListed(check.model, listed)) continue;
		if (probes.get(check.executor)?.modelListComplete !== true) {
			const key = `${check.executor}\0${check.model}`;
			const slots = partial.get(key) ?? { listed, slots: [] };
			slots.slots.push(check.slot);
			partial.set(key, slots);
			continue;
		}
		refusals.push(
			`  - stage "${check.slot}": model "${check.model}" is unknown to executor ${check.executor} (its probe lists: ${listed.join(", ") || "none"}); use one of those names in the profile`,
		);
	}
	for (const [key, slots] of unverified) {
		const [executor, model] = key.split("\0");
		notices.push(
			`model "${model}" for ${slots.join(", ")} is not verified: executor ${executor}'s probe does not list its models`,
		);
	}
	for (const [key, entry] of partial) {
		const [executor, model] = key.split("\0");
		notices.push(
			`model "${model}" for ${entry.slots.join(", ")} is not verified by probe: executor ${executor}'s probe lists ${entry.listed.join(", ") || "no model"}, which is not exhaustive; the run proceeds`,
		);
	}
	return { refusals, notices };
}

/**
 * Stages whose tools the executor has no mapping for. The executor itself refuses such an attempt
 * at submit (before any effect), but by then the run exists and earlier stages may already have
 * run — a launch that cannot succeed is refused here, before anything starts. Executors that do not
 * declare a mapping (third-party adapters, recorded probes) are not checked.
 */
function unmappedToolRefusals(
	tasks: readonly CompiledTask[],
	runExecutorId: string,
	probes: ReadonlyMap<string, ProbedExecutor>,
): string[] {
	const byExecutor = new Map<string, Map<string, string[]>>();
	for (const task of tasks) {
		const tools = task.runtime.tools;
		if (tools === undefined || tools.length === 0) continue;
		const id = task.runtime.executor ?? runExecutorId;
		const mapping = probes.get(id)?.toolMapping;
		if (mapping === undefined) continue;
		const unmapped = mapTools(tools, mapping).unmapped;
		if (unmapped.length === 0) continue;
		const key = unmapped.join(", ");
		const stages = byExecutor.get(id) ?? new Map<string, string[]>();
		stages.set(key, [...(stages.get(key) ?? []), task.id]);
		byExecutor.set(id, stages);
	}
	const lines: string[] = [];
	for (const [id, groups] of byExecutor)
		for (const [tools, labels] of groups)
			lines.push(
				`  ✗ ${labels.join(", ")}: executor ${id} has no mapping for ${tools}`,
			);
	return lines;
}

/**
 * Stages that ask for a tool the executor's probe reports unavailable here (2026-11-02: a Pi whose
 * pi-web-access has `fetch_content` turned off). Such a stage would run without the tool and return a
 * weaker result, so the run is refused before anything starts, with the probe's reason and fix.
 */
function unavailableToolRefusals(
	tasks: readonly CompiledTask[],
	runExecutorId: string,
	probes: ReadonlyMap<string, ProbedExecutor>,
): string[] {
	const byTool = new Map<
		string,
		{ id: string; reason: string; stages: string[] }
	>();
	for (const task of tasks) {
		const id = task.runtime.executor ?? runExecutorId;
		const unavailable = probes.get(id)?.unavailableTools;
		if (unavailable === undefined) continue;
		for (const tool of task.runtime.tools ?? []) {
			const reason = unavailable[tool];
			if (reason === undefined) continue;
			const key = `${id}\0${tool}`;
			const entry = byTool.get(key) ?? { id, reason, stages: [] };
			if (!entry.stages.includes(task.id)) entry.stages.push(task.id);
			byTool.set(key, entry);
		}
	}
	return [...byTool.entries()].map(([key, entry]) => {
		const tool = key.split("\0")[1];
		return `  ✗ ${entry.stages.join(", ")}: executor ${entry.id} cannot provide ${tool} here: ${entry.reason}`;
	});
}

/**
 * Model and effort names are the executor's (2026-10-30): resolve every stage's `model` and
 * `effort` for the executor that runs it (executor-model-id.ts) — rewrite a name to that tool's
 * form, refuse what it cannot run, note what its probe cannot confirm. `apply()` writes the resolved
 * names into the compiled tasks the run record is created from.
 */
function resolveTaskNames(
	tasks: readonly CompiledTask[],
	runExecutorId: string,
	probes: ReadonlyMap<
		string,
		Pick<ProbedExecutor, "models" | "modelListComplete" | "modelEfforts">
	>,
	/** `executor\0model` pairs a role profile assigned: their list check is checkRoleModels'. */
	roleChecked: ReadonlySet<string> = new Set(),
): { refusals: string[]; notices: string[]; apply: () => void } {
	const refusals = new Map<string, string[]>();
	const notices = new Map<string, string[]>();
	const writes: Array<() => void> = [];
	const group = (map: Map<string, string[]>, key: string, label: string) =>
		map.set(key, [...(map.get(key) ?? []), label]);
	for (const task of tasks) {
		const id = task.runtime.executor ?? runExecutorId;
		const probe = probes.get(id);
		const model = task.runtime.model;
		let resolvedModel = model;
		if (model !== undefined && model !== "") {
			const listChecked = !roleChecked.has(`${id}\0${model}`);
			const resolved = resolveExecutorModel(
				id,
				model,
				listChecked ? (probe?.models ?? null) : null,
				listChecked && probe?.modelListComplete === true,
			);
			if ("refused" in resolved)
				group(refusals, `executor ${id}: ${resolved.refused}`, task.id);
			else {
				if (resolved.notice !== undefined)
					group(notices, resolved.notice, task.id);
				resolvedModel = resolved.value;
				if (resolved.changed)
					writes.push(() => {
						task.runtime.model = resolved.value;
					});
			}
		}
		const effort = task.runtime.effort;
		if (effort !== undefined) {
			const resolved = resolveExecutorEffort(
				id,
				effort,
				resolvedModel,
				resolvedModel === undefined
					? undefined
					: probe?.modelEfforts?.[resolvedModel],
			);
			if ("refused" in resolved)
				group(refusals, `executor ${id}: ${resolved.refused}`, task.id);
			else {
				if (resolved.notice !== undefined)
					group(notices, resolved.notice, task.id);
				if (resolved.changed)
					writes.push(() => {
						task.runtime.effort = resolved.value as typeof task.runtime.effort;
					});
			}
		}
	}
	const which = (labels: string[]) =>
		labels.length === tasks.length && tasks.length > 1
			? `all ${tasks.length} stages`
			: labels.join(", ");
	return {
		refusals: [...refusals].map(
			([reason, labels]) => `  ✗ ${which(labels)}: ${reason}`,
		),
		notices: [...notices].map(
			([notice, labels]) => `${notice} (${which(labels)})`,
		),
		apply: () => {
			for (const write of writes) write();
		},
	};
}

/**
 * The executors a run cannot use, in one refusal. One alone keeps its own error (code and text),
 * plus the stages that use it in a mixed run; several are listed with each fix, e.g. a Pi-hosted run
 * whose reviewers go to codex and claude names both logins at once.
 */
function notReadyError(
	notReady: readonly { id: string; error: unknown }[],
	input: NegotiateWorkflowRunInput,
	runExecutorId: string,
): WorkflowCapabilityError {
	const stagesOf = new Map<string, string[]>();
	for (const task of workflowNegotiationTargets(input.compiled)) {
		const id = task.runtime.executor ?? runExecutorId;
		stagesOf.set(id, [...(stagesOf.get(id) ?? []), task.id]);
	}
	const mixed = stagesOf.size > 1 || notReady.length > 1;
	const reason = ({ id, error }: { id: string; error: unknown }) => {
		const text = (error instanceof Error ? error.message : String(error))
			.replace(/\s*The run was not started\.$/, "")
			.replace(/\.$/, "");
		const stages = stagesOf.get(id) ?? [];
		return mixed && stages.length > 0
			? `${text} (used by ${stages.length === 1 ? "stage" : "stages"} ${stages.join(", ")})`
			: text;
	};
	const first = notReady[0]!;
	const code =
		first.error instanceof WorkflowCapabilityError
			? first.error.code
			: "EXECUTOR_PROBE_FAILED";
	if (notReady.length === 1)
		return new WorkflowCapabilityError(
			code,
			`${reason(first)}. The run was not started.`,
			first.id,
		);
	return new WorkflowCapabilityError(
		code,
		[
			`${notReady.length} executors this run needs cannot be used:`,
			...notReady.map((entry) => `- ${reason(entry)}`),
			"Fix them, or move their stages to another executor (--executor, or the profile's roles). The run was not started.",
		].join("\n"),
		first.id,
	);
}

/**
 * Pre-launch negotiation for a whole run. Throws `WorkflowCapabilityError` (nothing launched,
 * no run record) on probe failure, any refusal.
 */
export async function negotiateWorkflowRun(
	input: NegotiateWorkflowRunInput,
): Promise<WorkflowRunCapabilityNegotiation> {
	const { descriptor, policy } = input;
	const executor = { id: descriptor.id, version: descriptor.version };
	const probeOptions = {
		...(input.prober === undefined ? {} : { prober: input.prober }),
		...(input.probeTimeoutMs === undefined
			? {}
			: { timeoutMs: input.probeTimeoutMs }),
	};
	// WP31 (Q4): every executor of the run is probed once (the run's own first, then the others in a
	// stable order). 2026-11-02: all of them before refusing, so a mixed run names every executor
	// that is not installed or not logged in, with the stages that use it and how to fix it.
	const otherDescriptors = Object.keys(input.executors ?? {})
		.sort()
		.filter((id) => id !== executor.id)
		.map((id) => input.executors![id]!);
	const settled = await Promise.allSettled([
		input.recorded === undefined
			? probeWorkflowExecutor(descriptor, probeOptions)
			: Promise.resolve({
					summary: {
						...input.recorded.probe,
						...(input.recordedFromRunId === undefined
							? {}
							: { reusedFromRunId: input.recordedFromRunId }),
					},
					capabilities: input.recorded.capabilities,
					models: null,
					modelListComplete: false,
				}),
		...otherDescriptors.map((other) =>
			probeWorkflowExecutor(other, probeOptions),
		),
	]);
	const descriptors = [descriptor, ...otherDescriptors];
	const notReady = settled.flatMap((result, index) =>
		result.status === "rejected"
			? [{ id: descriptors[index]!.id, error: result.reason as unknown }]
			: [],
	);
	if (notReady.length > 0) throw notReadyError(notReady, input, executor.id);
	const probes = new Map<string, ProbedExecutor>();
	settled.forEach((result, index) => {
		if (result.status !== "fulfilled") return;
		const target = descriptors[index]!;
		probes.set(target.id, {
			version: target.version,
			contractVersion: target.contractVersion,
			...result.value,
		});
	});
	const probed = probes.get(executor.id)!;
	const mixed = probes.size > 1;
	const stages = workflowNegotiationTargets(input.compiled).map((task) => {
		const id = task.runtime.executor ?? executor.id;
		const target = probes.get(id);
		if (target === undefined)
			throw new WorkflowCapabilityError(
				"CAPABILITY_REFUSED",
				`stage "${task.id}" is assigned to executor "${id}", which this run did not prepare; the run was not started.`,
				id,
			);
		return negotiateTask(
			{ id, version: target.version },
			target.capabilities,
			task,
			policy,
			"pre-launch",
		);
	});
	const modelCheck = checkRoleModels(input.modelChecks ?? [], probes);
	const targets0 = workflowNegotiationTargets(input.compiled);
	const names = resolveTaskNames(
		targets0,
		executor.id,
		probes,
		new Set(
			(input.modelChecks ?? []).map(
				(check) => `${check.executor}\0${check.model}`,
			),
		),
	);
	const toolRefusals = [
		...unmappedToolRefusals(targets0, executor.id, probes),
		...unavailableToolRefusals(targets0, executor.id, probes),
		...names.refusals,
	];
	const notices = [...modelCheck.notices, ...names.notices];
	// WP35: host-tool inheritance notice. WP31×WP35: per stage (each stage's preview block and
	// record say whether it inherits; in a mixed run only pi stages do).
	const targets = workflowNegotiationTargets(input.compiled);
	const hostTools = hostToolInheritanceNotice(targets, executor.id);
	if (hostTools !== undefined) {
		notices.push(hostTools);
		const byId = new Map(targets.map((task) => [task.id, task]));
		for (const stage of stages) {
			const task = byId.get(stage.label);
			const status =
				task === undefined
					? undefined
					: stageHostTools(task, executor.id, true);
			if (status !== undefined) stage.hostTools = status;
		}
	}
	const executorsLabel = [...probes.entries()]
		.map(([id, target]) => {
			const count = stages.filter(
				(stage) => stage.report.executorId === id,
			).length;
			return `${id}@${target.version} ×${count}`;
		})
		.join(" + ");
	const preview = buildCapabilityPreview(stages, {
		executor,
		// WP39b (live bundle 5, O13): a direct dynamic run has no stage up front ("0 stages").
		...(stages.length === 0
			? {
					stagesLabel:
						"stages are generated at run time; each is negotiated when generated",
				}
			: {}),
		...(mixed ? { executorLabel: `mixed: ${executorsLabel}` } : {}),
		header: mixed
			? [...probes.entries()].map(
					([id, target]) =>
						`  probe ${id}: installed, cli ${target.summary.cliVersion ?? "unknown"}, auth ${target.summary.auth}`,
				)
			: probeHeader(probed.summary),
		permissionMode: policy.permissionMode ?? "safe",
		...(hostTools === undefined
			? {}
			: {
					stageNotes: new Map(
						stages
							.filter((stage) => stage.hostTools !== undefined)
							.map((stage) => [
								stage.label,
								[stageHostToolsLine(stage.hostTools!, stage.report.executorId)],
							]),
					),
				}),
	});
	if (!preview.accepted)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				mixed
					? "a stage's executor cannot run it; the run was not started and no task was launched:"
					: `executor ${executor.id}@${executor.version} cannot run this workflow; the run was not started and no task was launched:`,
				...refusalLines(stages, policy, mixed),
			].join("\n"),
			mixed
				? (stages.find((stage) => !stage.report.accepted)?.report.executorId ??
						executor.id)
				: executor.id,
			preview.text,
		);
	if (modelCheck.refusals.length > 0)
		throw new WorkflowCapabilityError(
			"MODEL_UNKNOWN",
			[
				"a role profile assigns a model the executor does not offer; the run was not started and no task was launched:",
				...modelCheck.refusals,
			].join("\n"),
			executor.id,
			preview.text,
		);
	if (toolRefusals.length > 0)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				"a stage asks for tools, a model or an effort its executor cannot provide; the run was not started and no task was launched:",
				...toolRefusals,
			].join("\n"),
			executor.id,
			preview.text,
		);
	// Accepted: the run is created from the compiled tasks, with each model/effort in its executor's
	// own form.
	names.apply();
	const others = [...probes.entries()].filter(([id]) => id !== executor.id);
	return {
		schema: "agent-workflow-capability-negotiation-v1",
		executorId: executor.id,
		executorVersion: executor.version,
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		probe: probed.summary,
		capabilities: probed.capabilities,
		policy: {
			allowUnverified: [...policy.allowUnverified],
			strict: [...policy.strict],
			allowReadOnlyDowngrade: policy.allowReadOnlyDowngrade,
			permissionMode: policy.permissionMode ?? "safe",
			...(policy.sameSessionRepair === true ? { sameSessionRepair: true } : {}),
		},
		stages,
		degradations: [...preview.degradations],
		forcedReadOnly: [...preview.forcedReadOnly],
		// One-line notices (model/effort names the probe cannot confirm, …) shown with the preview.
		preview:
			notices.length === 0
				? preview.text
				: [preview.text, ...notices.map((notice) => `Notice: ${notice}`)].join(
						"\n",
					),
		...(notices.length === 0 ? {} : { notices }),
		...(others.length === 0
			? {}
			: {
					executors: Object.fromEntries(
						others.map(([id, target]) => [
							id,
							{
								executorVersion: target.version,
								contractVersion: target.contractVersion,
								probe: target.summary,
								capabilities: target.capabilities,
								...executorNamesField(target),
							},
						]),
					),
				}),
		// A nested run reuses its parent's probe: and with it, its recorded vocabulary.
		...(input.recorded?.names !== undefined
			? { names: input.recorded.names }
			: executorNamesField(probes.get(executor.id))),
	};
}

/** The probed vocabulary recorded on the run (stages generated later are checked against it). */
function executorNamesField(target: ProbedExecutor | undefined): {
	names?: WorkflowRunExecutorNames;
} {
	if (target === undefined) return {};
	const names: WorkflowRunExecutorNames = {
		...(target.toolMapping === undefined
			? {}
			: {
					// A tool the probe reports unavailable is not offered to generated stages either.
					tools: Object.entries(target.toolMapping.entries)
						.filter(([, entry]) => entry.type !== "none")
						.map(([name]) => name)
						.filter((name) => target.unavailableTools?.[name] === undefined),
				}),
		...(target.models === null ? {} : { models: [...target.models] }),
		...(target.modelListComplete ? { modelListComplete: true } : {}),
		...(target.modelEfforts === undefined
			? {}
			: {
					modelEfforts: Object.fromEntries(
						Object.entries(target.modelEfforts).map(([model, levels]) => [
							model,
							[...levels],
						]),
					),
				}),
	};
	return Object.keys(names).length === 0 ? {} : { names };
}

/**
 * The tool, model and effort checks a planned stage gets before launch, for a stage generated
 * during the run (dynamic `ctx.agent`), against the recorded vocabulary of its executor
 * (`negotiation.names`). Refusals throw `WorkflowCapabilityError`. With `apply`, names are
 * rewritten in the executor's form (call it where the task is built, before it is recorded and
 * its launch sealed) and notices are added to the negotiation. Runs recorded before the vocabulary
 * (no `names`) are only checked for what the recorded probe still allows.
 */
export function resolveGeneratedTaskNames(
	negotiation: WorkflowRunCapabilityNegotiation,
	task: CompiledTask,
	options: { apply: boolean },
): void {
	if (!isExecutorTask(task)) return;
	const executorId = task.runtime.executor ?? negotiation.executorId;
	const names =
		executorId === negotiation.executorId
			? negotiation.names
			: negotiation.executors?.[executorId]?.names;
	const unmapped =
		names?.tools === undefined
			? []
			: (task.runtime.tools ?? []).filter(
					(tool) => !names.tools!.includes(tool),
				);
	const resolved = resolveTaskNames(
		[task],
		executorId,
		new Map([
			[
				executorId,
				{
					models: names?.models ?? null,
					modelListComplete: names?.modelListComplete === true,
					...(names?.modelEfforts ? { modelEfforts: names.modelEfforts } : {}),
				},
			],
		]),
	);
	if (unmapped.length > 0 || resolved.refusals.length > 0)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				`executor ${executorId} refused generated task ${task.id} before launch:`,
				...(unmapped.length > 0
					? [
							`  ✗ ${task.id}: executor ${executorId} has no mapping for ${unmapped.join(", ")}`,
						]
					: []),
				...resolved.refusals,
			].join("\n"),
			executorId,
		);
	if (!options.apply) return;
	resolved.apply();
	// A rebuilt task (resume) brings the same notices again: record each once.
	const fresh = resolved.notices.filter(
		(notice) => !(negotiation.notices ?? []).includes(notice),
	);
	if (fresh.length > 0)
		negotiation.notices = [...(negotiation.notices ?? []), ...fresh];
}

/**
 * Launch-time decision for one task (task backend, before any effect). Re-derives the report from
 * the recorded effective capabilities and policy; a task generated at runtime whose template was
 * not negotiated before launch is appended to the record (`negotiatedAt: "launch"`, never asks for
 * prompting). Runs recorded before WP4d (no negotiation) are not checked.
 */
export function workflowTaskCapabilityLaunch(
	run: Pick<WorkflowRunRecord, "capabilityNegotiation">,
	task: CompiledTask,
): { forcedReadOnly: boolean; report?: NegotiationReport } {
	const negotiation = run.capabilityNegotiation;
	if (negotiation === undefined || !isExecutorTask(task))
		return { forcedReadOnly: false };
	const policy: WorkflowCapabilityPolicy = {
		...negotiation.policy,
	};
	// WP31 (Q4): the task's own executor in a mixed run.
	const executorId = task.runtime.executor ?? negotiation.executorId;
	const target =
		executorId === negotiation.executorId
			? {
					version: negotiation.executorVersion,
					capabilities: negotiation.capabilities,
				}
			: Object.hasOwn(negotiation.executors ?? {}, executorId)
				? {
						version: negotiation.executors![executorId]!.executorVersion,
						capabilities: negotiation.executors![executorId]!.capabilities,
					}
				: undefined;
	if (target === undefined)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			`task ${task.id} is assigned to executor ${executorId}, which was not negotiated before launch; it was not launched`,
			executorId,
		);
	const stage = negotiateTask(
		{ id: executorId, version: target.version },
		target.capabilities,
		task,
		policy,
		"launch",
	);
	if (!stage.report.accepted)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				`executor ${executorId}@${target.version} refused task ${task.id} before launch:`,
				...refusalLines([stage], policy),
			].join("\n"),
			executorId,
		);
	if (!negotiation.stages.some((recorded) => recorded.label === task.id)) {
		// A stage generated during the run (dynamic/auto): the tool, model and effort checks the
		// planned stages got before launch. Its names were already rewritten where it was built
		// (`resolveGeneratedTaskNames`, before its launch was sealed); here only refusals count,
		// since rewriting a sealed task would no longer match its recorded launch.
		resolveGeneratedTaskNames(negotiation, task, { apply: false });
		negotiation.stages.push(stage);
		for (const code of stage.report.degradations)
			negotiation.degradations.push(`${task.id}: ${code}`);
		if (stage.report.forcedReadOnly) negotiation.forcedReadOnly.push(task.id);
	}
	return { forcedReadOnly: stage.report.forcedReadOnly, report: stage.report };
}
