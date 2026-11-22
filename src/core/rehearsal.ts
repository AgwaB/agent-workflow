// `agent-workflow rehearse`: run a workflow through the real engine with no model and no network.
// Every model task is answered by the synthetic executor (src/core/rehearsal-executor.ts) with a control
// generated from the stage's own control schema; support helpers and dynamic controllers run for real
// (trusted local code); required artifact reads go through the real workflow_artifact tool. The result is a
// per-stage wiring report: tasks, sources received, required reads, foreach counts, loop rounds, helper
// errors, whether the final report rendered.
//
// Isolation: the whole rehearsal runs under a temporary AGENT_WORKFLOW_HOME (the user's workflows/ and agents/
// directories are linked in read-only, nothing else), so run state, the executor state directory, the
// provider pause and credentials of the real home are never read or written. The temporary root is removed
// afterwards unless `keep` is set. The synthetic executor is registered under a private id for the duration
// of the rehearsal and removed again: it is not a selectable executor.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflow } from "./compiler.js";
import { runWorkflowSpec, waitForRun } from "./engine.js";
import { agentWorkflowHome, AGENT_WORKFLOW_HOME_ENV } from "./home-dir.js";
import { registerWorkflowExecutor } from "./executor-registry.js";
import {
	plannedRequiredReads,
	REHEARSAL_EXECUTOR_VERSION,
	readRehearsalEffects,
	type RehearsalEffect,
	foreachHintToJson,
	type RehearsalForeachHint,
} from "./rehearsal-executor.js";
import { createShadowProject, hasDynamicStage } from "./rehearsal-shadow.js";
import {
	removeRehearsalRoot,
	waitForRootProcesses,
} from "./rehearsal-settle.js";
import { loadWorkflowSpec } from "./schema.js";
import { finalStageTasks, readRunRecord, workflowRunDir } from "./store.js";
import {
	type ArtifactGraphStageSpec,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
	WorkflowValidationError,
} from "./types.js";
import { EXECUTOR_CONTRACT_VERSION } from "../sdk/contract.js";

export const REHEARSAL_SCHEMA = "agent-workflow-rehearsal-v1" as const;
export const REHEARSAL_EXECUTOR_ID = "aw-rehearsal-synthetic";
/**
 * Set to "1" in the process environment while a rehearsal runs (helpers run in-process). A helper whose
 * check can only pass on real output (files a writer stage wrote, a git history) may skip that check
 * when it is set; the wiring around it is still exercised. Never set for a real run.
 */
export const REHEARSAL_ENV = "AGENT_WORKFLOW_REHEARSAL";
export const REHEARSAL_DEFAULT_ITEMS = 2;
export const REHEARSAL_MAX_ITEMS = 20;
const RUN_WAIT_MS = 10 * 60_000;
/** How long to wait for the run's worker and finalizer processes to stop writing before cleanup. */
const SETTLE_WAIT_MS = 30_000;
const RUN_INDEX_DIR_ENV = "AGENT_WORKFLOW_RUN_INDEX_DIR";

export type RehearsalLoopMode = "pass" | "exhaust";

export interface RehearsalOptions {
	workflow: string;
	task?: string;
	items?: number;
	loop?: RehearsalLoopMode;
	keep?: boolean;
	signal?: AbortSignal;
}

export interface RehearsalReadReport {
	read: string;
	satisfied: boolean;
	message?: string;
}

export interface RehearsalStageReport {
	stage: string;
	kind: string;
	/** Tasks of the stage (a foreach counts its items; a loop its round tasks). */
	tasks: number;
	statuses: Record<string, number>;
	/** `from` sources the stage names (spec order). */
	declaredSources: string[];
	/** Model tasks that received at least one source / that received none. */
	sourcesReceived: { withSources: number; withoutSources: number };
	requiredReads: RehearsalReadReport[];
	/** Foreach only: item tasks materialized. */
	items?: number;
	/** Failed or blocked tasks: id, status detail and the engine's message. */
	failures: Array<{ task: string; statusDetail: string; message: string }>;
	/** Support/dynamic helper tasks that failed, with the helper's message. */
	helperErrors: string[];
	/**
	 * Support helpers that ran and declared `failed`/`blocked` themselves: a content gate (for example an
	 * owner-ledger reconciliation) that synthetic outputs cannot satisfy. Reported, not a wiring failure.
	 */
	gates: Array<{ task: string; status: string; reasons: string[] }>;
}

export interface RehearsalLoopReport {
	loop: string;
	status: string;
	rounds: number;
	maxRounds: number | null;
	forced: string[];
}

export interface RehearsalReport {
	schema: typeof REHEARSAL_SCHEMA;
	workflow: string;
	options: { items: number; loop: RehearsalLoopMode };
	/**
	 * The rehearsal's outcome: `content-gates` when the wiring is fine and only the workflow's own content
	 * gates rejected the synthetic data (see `gates`); `invalid-spec` when the spec did not load or compile;
	 * otherwise the run's final status (`completed` or, with findings, `failed`, `blocked`, ...).
	 */
	status: string;
	/** The run's own final status (`failed`/`blocked` under `content-gates`), or `invalid-spec`. */
	runStatus: string;
	/** True when the rehearsal found nothing wrong with the wiring (also under `content-gates`). */
	ok: boolean;
	/** Stages with skipped tasks when content gates ended the run early (they never ran). */
	skippedAfterGates: string[];
	stages: RehearsalStageReport[];
	loops: RehearsalLoopReport[];
	finalReportRendered: boolean;
	/** Wiring failures, one sentence each (exit code 1 when any). */
	findings: string[];
	/** Spec validation warnings (the same as `validate`). */
	warnings: string[];
	/** Spec validation errors when the spec is invalid. */
	validationIssues: Array<{ path: string; message: string }>;
}

export interface RehearsalResult {
	report: RehearsalReport;
	/** The temporary state root, only with `keep`. */
	stateRoot?: string;
	/** The temporary root that could not be fully removed (or that a process was still using). */
	leftover?: string;
}

export function validateRehearsalOptions(options: RehearsalOptions): string[] {
	const problems: string[] = [];
	if (typeof options.workflow !== "string" || options.workflow.trim() === "")
		problems.push("a workflow name or spec path is required");
	if (
		options.items !== undefined &&
		(!Number.isInteger(options.items) ||
			options.items < 0 ||
			options.items > REHEARSAL_MAX_ITEMS)
	)
		problems.push(
			`--items must be an integer from 0 to ${REHEARSAL_MAX_ITEMS}`,
		);
	if (
		options.loop !== undefined &&
		options.loop !== "pass" &&
		options.loop !== "exhaust"
	)
		problems.push("--loop must be pass or exhaust");
	return problems;
}

function sourceNames(from: ArtifactGraphStageSpec["from"]): string[] {
	if (from === undefined) return [];
	if (typeof from === "string") return [from];
	if (Array.isArray(from)) return [...from];
	return [from.source];
}

/** stage id → the sources it names, over the whole spec (nested dag/loop children included). */
function declaredSourcesByStage(
	stages: readonly ArtifactGraphStageSpec[],
	out = new Map<string, string[]>(),
): Map<string, string[]> {
	for (const stage of stages) {
		// A foreach's `from: {source, path}` names the array its items come from; each task gets its item,
		// not the source as an artifact, so only plain `from` lists are sources a task must receive.
		out.set(
			stage.id,
			stage.type === "foreach" &&
				typeof stage.from === "object" &&
				!Array.isArray(stage.from)
				? []
				: sourceNames(stage.from),
		);
		if (stage.stages !== undefined) declaredSourcesByStage(stage.stages, out);
		if (stage.onExhausted !== undefined)
			out.set(stage.onExhausted.id, sourceNames(stage.onExhausted.from));
	}
	return out;
}

/** loop stage id → its declared maxRounds (null when the cap is removed). */
function loopRoundCaps(
	stages: readonly ArtifactGraphStageSpec[],
	out = new Map<string, number | null>(),
): Map<string, number | null> {
	for (const stage of stages) {
		if (stage.type === "loop") out.set(stage.id, stage.maxRounds ?? null);
		if (stage.stages !== undefined) loopRoundCaps(stage.stages, out);
	}
	return out;
}

/** The foreach stages' fan-out edges: source stage, array path, item identity path. */
function foreachHints(
	stages: readonly ArtifactGraphStageSpec[],
	out: RehearsalForeachHint[] = [],
): RehearsalForeachHint[] {
	for (const stage of stages) {
		const from = stage.from;
		if (
			stage.type === "foreach" &&
			from !== undefined &&
			typeof from === "object" &&
			!Array.isArray(from)
		)
			out.push({
				source: from.source,
				path: from.path,
				...(stage.each?.itemIdentityPath === undefined
					? {}
					: { identityPath: stage.each.itemIdentityPath }),
			});
		if (stage.stages !== undefined) foreachHints(stage.stages, out);
	}
	return out;
}

function stageIdOf(task: WorkflowTaskRunRecord): string {
	if (task.foreachGenerated?.placeholderSpecId !== undefined)
		return task.foreachGenerated.placeholderSpecId.replace(/\.item$/u, "");
	if (task.stageId !== undefined) return task.stageId;
	return task.specId.replace(/\.[^.]*$/u, "") || task.specId;
}

function describeRead(read: {
	source: string;
	artifact: string;
	path?: string;
}): string {
	return `${read.source}.${read.artifact}${read.path === undefined ? "" : ` ${read.path}`}`;
}

/** Text that varies between runs (run id, temp paths) replaced by placeholders, so reports compare equal. */
function normalizer(runId: string, roots: string[]): (text: string) => string {
	return (text) => {
		let out = text.split(runId).join("<run>");
		for (const root of roots) out = out.split(root).join("<root>");
		return out
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<time>")
			.replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gu, "<sha256>")
			.replace(/workflow_[A-Za-z0-9_-]+/gu, "<run>");
	};
}

export function buildRehearsalReport(input: {
	workflow: string;
	options: { items: number; loop: RehearsalLoopMode };
	run: WorkflowRunRecord;
	effects: readonly RehearsalEffect[];
	declared: ReadonlyMap<string, string[]>;
	/** task id → the reasons a support helper gave when it declared failed/blocked. */
	gateReasons?: ReadonlyMap<string, string[]>;
	maxRounds?: ReadonlyMap<string, number | null>;
	warnings: string[];
	normalize: (text: string) => string;
}): RehearsalReport {
	const { run, effects, declared, normalize } = input;
	const byStage = new Map<string, WorkflowTaskRunRecord[]>();
	for (const task of run.tasks) {
		const stage = stageIdOf(task);
		byStage.set(stage, [...(byStage.get(stage) ?? []), task]);
	}
	const submits = new Map<string, RehearsalEffect & { type: "submit" }>();
	const readsByTask = new Map<
		string,
		Array<RehearsalEffect & { type: "read" }>
	>();
	for (const effect of effects) {
		if (effect.type === "submit") submits.set(effect.taskId, effect);
		if (effect.type === "read")
			readsByTask.set(effect.taskId, [
				...(readsByTask.get(effect.taskId) ?? []),
				effect,
			]);
	}
	const findings: string[] = [];
	const stages: RehearsalStageReport[] = [];
	for (const [stage, tasks] of [...byStage].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		// The placeholder of a foreach/loop is bookkeeping; the stage's work is its item/round tasks.
		const working = tasks.filter(
			(task) =>
				![
					"foreach_empty",
					"foreach_materialized",
					"foreach_streaming_complete",
				].includes(task.statusDetail) || tasks.length === 1,
		);
		const kinds = new Set(tasks.map((task) => task.kind ?? "single"));
		const kind =
			tasks.some((task) => task.foreachGenerated !== undefined) ||
			tasks.some((task) => task.kind === "foreach")
				? "foreach"
				: ([...kinds][0] ?? "single");
		const statuses: Record<string, number> = {};
		for (const task of tasks)
			statuses[task.status] = (statuses[task.status] ?? 0) + 1;
		const declaredSources = declared.get(stage) ?? [];
		let withSources = 0;
		let withoutSources = 0;
		const reads = new Map<string, RehearsalReadReport>();
		for (const task of tasks) {
			const submit = submits.get(task.taskId);
			if (submit !== undefined) {
				if (submit.sources.length > 0) withSources += 1;
				else withoutSources += 1;
			}
			for (const planned of plannedRequiredReads(
				task.artifactGraph?.requiredReads ?? [],
				task.artifactGraph?.requiredReadPolicy ?? [],
			)) {
				const label = describeRead(planned);
				const done = (readsByTask.get(task.taskId) ?? []).find(
					(read) =>
						read.source === planned.source &&
						read.artifact === planned.artifact &&
						read.path === (planned.path ?? null) &&
						!read.ok,
				);
				const previous = reads.get(label);
				if (done !== undefined)
					reads.set(label, {
						read: label,
						satisfied: false,
						message: normalize(done.message ?? "read failed"),
					});
				else if (previous === undefined)
					reads.set(label, { read: label, satisfied: true });
			}
		}
		const isGate = (task: WorkflowTaskRunRecord): boolean =>
			/^support_declared_(failed|blocked)$/u.test(task.statusDetail);
		const gates = tasks.filter(isGate).map((task) => ({
			task: task.specId,
			status: task.status,
			reasons: input.gateReasons?.get(task.taskId) ?? [],
		}));
		const failures = tasks
			.filter(
				(task) =>
					(task.status === "failed" || task.status === "blocked") &&
					!isGate(task),
			)
			.map((task) => ({
				task: task.specId,
				statusDetail: task.statusDetail,
				message: normalize(String(task.lastMessage ?? "").slice(0, 400)),
			}));
		const helperErrors = tasks
			.filter(
				(task) =>
					(task.kind === "support" || task.kind === "dynamic") &&
					(task.status === "failed" || task.status === "blocked") &&
					!isGate(task),
			)
			.map(
				(task) =>
					`${task.specId}: ${normalize(String(task.lastMessage ?? task.statusDetail).slice(0, 400))}`,
			);
		const items = tasks.filter(
			(task) =>
				task.foreachGenerated !== undefined &&
				task.specId !== task.foreachGenerated.placeholderSpecId,
		).length;
		const report: RehearsalStageReport = {
			stage,
			kind,
			tasks: working.length,
			statuses,
			declaredSources,
			sourcesReceived: { withSources, withoutSources },
			requiredReads: [...reads.values()].sort((a, b) =>
				a.read.localeCompare(b.read),
			),
			...(kind === "foreach" ? { items } : {}),
			failures,
			helperErrors,
			gates,
		};
		stages.push(report);
		if (declaredSources.length > 0 && withoutSources > 0)
			findings.push(
				`stage ${stage} names sources (${declaredSources.join(", ")}) but ${withoutSources} of its task${withoutSources === 1 ? "" : "s"} received none`,
			);
		for (const read of report.requiredReads)
			if (!read.satisfied)
				findings.push(
					`stage ${stage}: required read ${read.read} does not resolve (${read.message})`,
				);
		for (const error of helperErrors)
			findings.push(`stage ${stage}: helper failed: ${error}`);
		for (const failure of failures) {
			if (helperErrors.some((error) => error.startsWith(`${failure.task}:`)))
				continue;
			findings.push(
				`stage ${stage}: task ${failure.task} ${failure.statusDetail}: ${failure.message}`,
			);
		}
		for (const issue of effects) {
			if (issue.type !== "control-invalid") continue;
			if (!tasks.some((task) => task.taskId === issue.taskId)) continue;
			findings.push(
				`stage ${stage}: no schema-valid control could be generated for ${issue.specId}: ${issue.issues.slice(0, 3).join("; ")}`,
			);
		}
	}
	const forcedByLoop = new Map<string, string[]>();
	for (const effect of effects)
		if (effect.type === "loop-forced") {
			const loop = /^loop (\S+) round/u.exec(effect.note)?.[1];
			if (loop !== undefined)
				forcedByLoop.set(loop, [
					...(forcedByLoop.get(loop) ?? []),
					effect.note,
				]);
		}
	const loops: RehearsalLoopReport[] = (run.loopResults ?? [])
		.map((result) => ({
			loop: result.loopId,
			status: result.status,
			rounds: result.roundsUsed,
			maxRounds: input.maxRounds?.get(result.loopId) ?? null,
			forced: [...new Set(forcedByLoop.get(result.loopId) ?? [])].sort(),
		}))
		.sort((a, b) => a.loop.localeCompare(b.loop));
	const finalTasks = finalStageTasks(run.tasks);
	const finalReportRendered =
		finalTasks.length > 0 &&
		finalTasks.every((task) => task.status === "completed");
	const onlyGates =
		(run.status === "failed" || run.status === "blocked") &&
		stages.every(
			(stage) => stage.failures.length === 0 && stage.helperErrors.length === 0,
		) &&
		stages.some((stage) => stage.gates.length > 0);
	if (run.status !== "completed" && !onlyGates)
		findings.unshift(`the run ended ${run.status}, not completed`);
	else if (run.status === "completed" && !finalReportRendered)
		findings.push("the run completed but its final stage did not render");
	const ok = findings.length === 0;
	const contentGates =
		ok && stages.some((stage) => stage.gates.length > 0) && onlyGates;
	return {
		schema: REHEARSAL_SCHEMA,
		workflow: input.workflow,
		options: input.options,
		status: contentGates ? "content-gates" : run.status,
		runStatus: run.status,
		ok,
		skippedAfterGates: contentGates
			? stages
					.filter((stage) => (stage.statuses.skipped ?? 0) > 0)
					.map((stage) => stage.stage)
			: [],
		stages,
		loops,
		finalReportRendered,
		findings,
		warnings: input.warnings,
		validationIssues: [],
	};
}

/** Why support helpers that declared failed/blocked said so (their control's blockers or reason text). */
function readGateReasons(
	runDir: string,
	run: WorkflowRunRecord,
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const task of run.tasks) {
		if (!/^support_declared_(failed|blocked)$/u.test(task.statusDetail))
			continue;
		let control: unknown;
		try {
			control = JSON.parse(
				readFileSync(
					join(runDir, "tasks", task.taskId, "control.json"),
					"utf8",
				),
			);
		} catch {
			continue;
		}
		if (typeof control !== "object" || control === null) continue;
		const record = control as Record<string, unknown>;
		// A gate helper states why in blockers/reasons or, as the lab helpers do, in the digest it must write.
		const texts = [
			record.blockers,
			record.reasons,
			record.reason,
			record.message,
			record.problems,
			record.errors,
			record.failures,
			record.digest,
		]
			.flatMap((value) => (Array.isArray(value) ? value : [value]))
			.filter(
				(value): value is string => typeof value === "string" && value !== "",
			);
		// A renderer helper often states its gate only through its verdict and the report it still wrote.
		if (texts.length === 0)
			texts.push(
				`helper control status ${String(record.status ?? task.status)}${
					typeof record.verdict === "string"
						? `, verdict ${record.verdict}`
						: ""
				}`,
			);
		out.set(
			task.taskId,
			texts.slice(0, 3).map((text) => text.slice(0, 240)),
		);
	}
	return out;
}

function linkReadOnlyHomeEntries(realHome: string, tempHome: string): void {
	// The user's workflows and agents stay discoverable; nothing else of the real home is visible.
	for (const name of ["workflows", "agents"]) {
		const source = join(realHome, name);
		if (existsSync(source)) symlinkSync(source, join(tempHome, name));
	}
}

function invalidSpecReport(
	options: RehearsalOptions,
	settings: { items: number; loop: RehearsalLoopMode },
	issues: Array<{ path: string; message: string }>,
): RehearsalReport {
	return {
		schema: REHEARSAL_SCHEMA,
		workflow: options.workflow,
		options: settings,
		status: "invalid-spec",
		runStatus: "invalid-spec",
		ok: false,
		skippedAfterGates: [],
		stages: [],
		loops: [],
		finalReportRendered: false,
		findings: issues.map(
			(issue) => `invalid spec: ${issue.path}: ${issue.message}`,
		),
		warnings: [],
		validationIssues: issues,
	};
}

export async function rehearseWorkflow(
	cwd: string,
	options: RehearsalOptions,
): Promise<RehearsalResult> {
	const problems = validateRehearsalOptions(options);
	if (problems.length > 0) throw new Error(problems.join("; "));
	const settings = {
		items: options.items ?? REHEARSAL_DEFAULT_ITEMS,
		loop: options.loop ?? ("pass" as RehearsalLoopMode),
	};
	const task = options.task?.trim() || "rehearsal task";

	// Load and compile in the real home (user agents/workflows resolve), before the state root is swapped.
	let loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>;
	let warnings: string[];
	let canWrite = false;
	try {
		loaded = await loadWorkflowSpec(options.workflow.trim(), cwd);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
			task,
		});
		warnings = [...compiled.warnings];
		// A stage that can write gets a managed git worktree from the engine; see rehearsal-shadow.ts.
		canWrite =
			(compiled.tasks ?? []).some(
				(compiledTask: { safety?: { requiresWorktree?: boolean } }) =>
					compiledTask.safety?.requiresWorktree === true,
			) || hasDynamicStage(loaded.spec.artifactGraph?.stages ?? []);
	} catch (error) {
		if (error instanceof WorkflowValidationError)
			return { report: invalidSpecReport(options, settings, error.issues) };
		throw error;
	}

	const realHome = agentWorkflowHome();
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "aw-rehearse-")));
	const tempHome = join(tempRoot, "home");
	const effectLog = join(tempRoot, "effects.jsonl");
	const savedEnv = {
		home: process.env[AGENT_WORKFLOW_HOME_ENV],
		index: process.env[RUN_INDEX_DIR_ENV],
		rehearsal: process.env[REHEARSAL_ENV],
	};
	let unregister: (() => void) | undefined;
	let outcome: RehearsalResult | undefined;
	let leftover: string | undefined;
	// Everything after the temp root exists runs inside the try, so a failure here still restores the
	// environment and removes the temp root (review 2026-11-22).
	try {
		mkdirSync(tempHome, { recursive: true });
		linkReadOnlyHomeEntries(realHome, tempHome);
		// R3: a workflow that can write runs in a shadow clone of the project inside the temporary root, so
		// the engine's worktrees and `agent-workflow/<run>-<task>` branches never reach the user's repository.
		const runCwd =
			(canWrite ? createShadowProject(cwd, tempRoot) : undefined) ?? cwd;
		unregister = registerWorkflowExecutor({
			id: REHEARSAL_EXECUTOR_ID,
			version: REHEARSAL_EXECUTOR_VERSION,
			contractVersion: EXECUTOR_CONTRACT_VERSION,
			module: new URL("./rehearsal-executor.js", import.meta.url).href,
			config: {
				id: REHEARSAL_EXECUTOR_ID,
				effectLog,
				projectCwd: runCwd,
				items: settings.items,
				loop: settings.loop,
				foreach: foreachHints(loaded.spec.artifactGraph?.stages ?? []).map(
					foreachHintToJson,
				),
			},
		});
		process.env[AGENT_WORKFLOW_HOME_ENV] = tempHome;
		process.env[RUN_INDEX_DIR_ENV] = join(tempHome, "run-index");
		process.env[REHEARSAL_ENV] = "1";
		const started = await runWorkflowSpec(loaded.specPath, runCwd, {
			task,
			executor: REHEARSAL_EXECUTOR_ID,
			...(options.signal === undefined ? {} : { launchSignal: options.signal }),
		});
		let run: WorkflowRunRecord;
		try {
			run = await waitForRun(runCwd, started.runId, RUN_WAIT_MS);
		} catch {
			run = await readRunRecord(runCwd, started.runId);
		}
		const runDir = workflowRunDir(runCwd, run.runId);
		const report = buildRehearsalReport({
			workflow: options.workflow,
			options: settings,
			run,
			effects: readRehearsalEffects(effectLog),
			declared: declaredSourcesByStage(loaded.spec.artifactGraph?.stages ?? []),
			maxRounds: loopRoundCaps(loaded.spec.artifactGraph?.stages ?? []),
			warnings,
			gateReasons: new Map(
				[...readGateReasons(runDir, run)].map(([id, reasons]) => [
					id,
					reasons.map(normalizer(run.runId, [tempRoot, runDir])),
				]),
			),
			normalize: normalizer(run.runId, [tempRoot, runDir]),
		});
		outcome = {
			report,
			...(options.keep === true ? { stateRoot: tempRoot } : {}),
		};
	} finally {
		unregister?.();
		for (const [name, previous] of [
			[AGENT_WORKFLOW_HOME_ENV, savedEnv.home],
			[RUN_INDEX_DIR_ENV, savedEnv.index],
			[REHEARSAL_ENV, savedEnv.rehearsal],
		] as const) {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
		// The engine can see the run end while a durable worker or its detached terminal finalizer is
		// still writing under the root: wait for every process that names it, then remove it. Cleanup
		// never throws; what it cannot remove is reported.
		const quiet = await waitForRootProcesses(tempRoot, SETTLE_WAIT_MS);
		if (options.keep !== true) {
			leftover = removeRehearsalRoot(tempRoot);
			if (leftover === undefined && !quiet) leftover = tempRoot;
		}
	}
	return leftover === undefined
		? (outcome as RehearsalResult)
		: { ...(outcome as RehearsalResult), leftover };
}
