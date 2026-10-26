// New in agent-workflow (WP4d): B4 capability negotiation before launch (design §8.2/§8.3, owner
// decisions B4/B5, plan §2.2). Once per run, after executor selection: probe the executor (no model
// turn, bounded), merge the probed rows over its declared table, negotiate every compiled stage, fail
// before any launch on a refusal, ask an interactive host to confirm degradations, and record the
// probe summary, effective capabilities, per-stage reports and the preview on the run record.
// At launch the task backend re-derives the same decision from the recorded capabilities, so a
// runtime-generated task (foreach item, loop child, dynamic worker) is checked the same way and
// `forcedReadOnly` reaches the SubmitRequest.
import {
	type ExecutorCapabilities,
	mergeProbedCapabilities,
} from "../sdk/capabilities.js";
import type { ExecutorProbe } from "../sdk/contract.js";
import { EXECUTOR_CONTRACT_VERSION } from "../sdk/contract.js";
import { type ExecutorDescriptor, loadExecutor } from "../sdk/descriptor.js";
import {
	buildCapabilityPreview,
	type CapabilityPreview,
	DEFAULT_REQUIREMENTS,
	type NegotiationReport,
	negotiateCapabilities,
	type RequirementKey,
	type StageRequirementContext,
} from "../sdk/requirements.js";
import { strictCapabilityKeysProblem } from "./artifact-graph-schema.js";
import type {
	CompiledLoopStageRecord,
	CompiledTask,
	CompiledWorkflow,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutorProbeSummary,
	WorkflowRunCapabilityNegotiation,
	WorkflowRunRecord,
	WorkflowStageCapabilityNegotiation,
} from "./types.js";

/** Default bound for one executor probe (version/auth/status commands only). */
export const DEFAULT_EXECUTOR_PROBE_TIMEOUT_MS = 30_000;

/** Probe seam: what the engine needs from an executor before launch. Injectable for tests. */
export type WorkflowExecutorProber = (
	descriptor: ExecutorDescriptor,
) => Promise<{ probe: ExecutorProbe; capabilities: ExecutorCapabilities }>;

export type WorkflowCapabilityErrorCode =
	| "EXECUTOR_PROBE_FAILED"
	| "EXECUTOR_NOT_INSTALLED"
	| "EXECUTOR_AUTH_NOT_READY"
	| "CAPABILITY_REFUSED"
	| "CAPABILITY_CONFIRMATION_REQUIRED"
	| "CAPABILITY_DEGRADATION_DECLINED";

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
const EXECUTOR_HINTS: Readonly<
	Record<string, { install: string; login: string }>
> = {
	pi: {
		install: "`pi --version`",
		login: "run `pi` and use `/login` (check with `pi auth check`)",
	},
	codex: { install: "`codex --version`", login: "run `codex login`" },
	claude: { install: "`claude --version`", login: "run `claude auth login`" },
};

function hintsFor(executorId: string): { install: string; login: string } {
	return (
		EXECUTOR_HINTS[executorId] ?? {
			install: `the ${executorId} CLI's version command`,
			login: `log in with the ${executorId} CLI`,
		}
	);
}

const defaultProber: WorkflowExecutorProber = async (descriptor) => {
	const executor = await loadExecutor(descriptor);
	return {
		capabilities: executor.capabilities(),
		probe: await executor.probe(),
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
			timer = setTimeout(() => reject(onTimeout()), timeoutMs);
			timer.unref?.();
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
		probedAt: new Date().toISOString(),
	};
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
			}). The run was not started.`,
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
	return { summary, capabilities };
}

/**
 * `ctx.strict` for a run: the declared profile's `executionProfileStrictCapabilities` entry, or a
 * saved user profile's `strictCapabilities`. Unknown capability names fail before launch.
 */
export function workflowProfileStrictCapabilities(
	spec: unknown,
	profileName: string | undefined,
	captured:
		| Pick<WorkflowCapturedExecutionProfile, "name" | "strictCapabilities">
		| undefined,
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
	interactive: boolean;
	allowUnverified: string[];
	strict: string[];
	allowReadOnlyDowngrade: boolean;
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
 * puts on the SubmitRequest: readOnly from the task's safety capability, the Pi tool list, B5
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
		readOnly: task.safety.capability === "read-only",
		hasRequiredReads: requiredReads.length > 0,
		...(task.runtime.tools === undefined ? {} : { tools: task.runtime.tools }),
		allowReadOnlyDowngrade: policy.allowReadOnlyDowngrade,
		inherit: workflowTaskInheritsContext(task),
		wantsCost: true,
		partialStream: (task.artifactGraph?.output.partial?.paths.length ?? 0) > 0,
		sameSessionRepair: task.artifactGraph?.enabled === true,
		fastTier: task.runtime.fast === "on",
		...(needsMcp
			? { requirements: { mcpInjection: DEFAULT_REQUIREMENTS.mcpInjection } }
			: {}),
		allowUnverified: policy.allowUnverified as RequirementKey[],
		strict: policy.strict as RequirementKey[],
		interactive: policy.interactive,
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
		return 'opt in with spec "allowReadOnlyDowngrade": true (the stage then runs with readOnly enforced)';
	return "no opt-in exists; choose another executor";
}

function refusalLines(
	stages: readonly WorkflowStageCapabilityNegotiation[],
	policy: WorkflowCapabilityPolicy,
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
				`  - stage "${stage.label}": ${entry.key} — ${code} (executor has ${observed}${
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

export interface NegotiateWorkflowRunInput {
	descriptor: ExecutorDescriptor;
	compiled: Pick<CompiledWorkflow, "tasks" | "stages">;
	policy: WorkflowCapabilityPolicy;
	/** Reuse a recorded probe (nested runs) instead of probing again. */
	recorded?: Pick<WorkflowRunCapabilityNegotiation, "probe" | "capabilities">;
	recordedFromRunId?: string;
	prober?: WorkflowExecutorProber;
	probeTimeoutMs?: number;
	/** B4 confirmation hook; called only when interactive and a stage needs confirmation. */
	confirmDegradations?: (preview: CapabilityPreview) => Promise<boolean>;
}

/**
 * Pre-launch negotiation for a whole run. Throws `WorkflowCapabilityError` (nothing launched,
 * no run record) on probe failure, any refusal, or declined/impossible confirmation.
 */
export async function negotiateWorkflowRun(
	input: NegotiateWorkflowRunInput,
): Promise<WorkflowRunCapabilityNegotiation> {
	const { descriptor, policy } = input;
	const executor = { id: descriptor.id, version: descriptor.version };
	const probed =
		input.recorded === undefined
			? await probeWorkflowExecutor(descriptor, {
					...(input.prober === undefined ? {} : { prober: input.prober }),
					...(input.probeTimeoutMs === undefined
						? {}
						: { timeoutMs: input.probeTimeoutMs }),
				})
			: {
					summary: {
						...input.recorded.probe,
						...(input.recordedFromRunId === undefined
							? {}
							: { reusedFromRunId: input.recordedFromRunId }),
					},
					capabilities: input.recorded.capabilities,
				};
	const stages = workflowNegotiationTargets(input.compiled).map((task) =>
		negotiateTask(executor, probed.capabilities, task, policy, "pre-launch"),
	);
	const preview = buildCapabilityPreview(stages, {
		executor,
		header: probeHeader(probed.summary),
	});
	if (!preview.accepted)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				`executor ${executor.id}@${executor.version} cannot run this workflow; the run was not started and no task was launched:`,
				...refusalLines(stages, policy),
			].join("\n"),
			executor.id,
			preview.text,
		);
	let confirmation: WorkflowRunCapabilityNegotiation["confirmation"] =
		"not-needed";
	if (preview.degradations.length > 0)
		confirmation = policy.interactive ? "confirmed" : "non-interactive";
	if (preview.needsConfirmation) {
		if (input.confirmDegradations === undefined)
			throw new WorkflowCapabilityError(
				"CAPABILITY_CONFIRMATION_REQUIRED",
				`interactive run needs confirmation of capability degradations but the host provided no confirmDegradations hook; the run was not started.\n${preview.text}`,
				executor.id,
				preview.text,
			);
		const accepted = await input.confirmDegradations(preview);
		if (accepted !== true)
			throw new WorkflowCapabilityError(
				"CAPABILITY_DEGRADATION_DECLINED",
				`capability degradations were declined (${preview.degradations.join(", ")}); the run was not started.`,
				executor.id,
				preview.text,
			);
	}
	return {
		schema: "agent-workflow-capability-negotiation-v1",
		executorId: executor.id,
		executorVersion: executor.version,
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		probe: probed.summary,
		capabilities: probed.capabilities,
		policy: {
			interactive: policy.interactive,
			allowUnverified: [...policy.allowUnverified],
			strict: [...policy.strict],
			allowReadOnlyDowngrade: policy.allowReadOnlyDowngrade,
		},
		confirmation,
		stages,
		degradations: [...preview.degradations],
		forcedReadOnly: [...preview.forcedReadOnly],
		preview: preview.text,
	};
}

/**
 * Launch-time decision for one task (task backend, before any effect). Re-derives the report from
 * the recorded effective capabilities and policy; a task generated at runtime whose template was
 * not negotiated before launch is appended to the record (`negotiatedAt: "launch"`, never asks for
 * confirmation). Runs recorded before WP4d (no negotiation) are not checked.
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
		interactive: false,
	};
	const stage = negotiateTask(
		{ id: negotiation.executorId, version: negotiation.executorVersion },
		negotiation.capabilities,
		task,
		policy,
		"launch",
	);
	if (!stage.report.accepted)
		throw new WorkflowCapabilityError(
			"CAPABILITY_REFUSED",
			[
				`executor ${negotiation.executorId}@${negotiation.executorVersion} refused task ${task.id} before launch:`,
				...refusalLines([stage], policy),
			].join("\n"),
			negotiation.executorId,
		);
	if (!negotiation.stages.some((recorded) => recorded.label === task.id)) {
		negotiation.stages.push(stage);
		for (const code of stage.report.degradations)
			negotiation.degradations.push(`${task.id}: ${code}`);
		if (stage.report.forcedReadOnly) negotiation.forcedReadOnly.push(task.id);
	}
	return { forcedReadOnly: stage.report.forcedReadOnly, report: stage.report };
}
