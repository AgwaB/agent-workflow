import { type SubagentRunStatusSnapshot } from "./runtime-port.js";
import {
	copyFile,
	link,
	mkdir,
	readFile,
	readdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { workflowTaskSessionId } from "./launch-session.js";
import { elapsedSince } from "./task-observability.js";
import { type WorkflowRunRecord, type WorkflowTaskRunRecord } from "./types.js";
import { type WorkflowTaskFailedToolCallSummary } from "./workflow-output-artifacts.js";
import { isInsidePath } from "./physical-paths.js";

/** Runtime runs directory root for workflow tasks (was `.pi/workflow-subagents`). */
export const DEFAULT_SUBAGENT_RUNS_ROOT = ".agent-workflow/workflow-subagents";
/**
 * Backend id recorded in launch authorities and launch-bootstrap provenance
 * for the core task backend on the agent-workflow runtime API.
 */
export const WORKFLOW_TASK_BACKEND_ID = "agent-workflow/runtime";
const MAX_FAILED_TOOL_CALL_RECORDS = 20;
export interface SubagentBackendHandle extends Record<string, unknown> {
	engine: "agent-workflow";
	backend: "runtime";
	runId: string;
	attemptId: string;
	cwd: string;
	runsDir: string;
	display: string;
	sessionId?: string;
}

export interface SubagentArtifactRef {
	type: string;
	path: string;
	artifactCwd?: string;
}

export type SubagentRunLogRef = SubagentArtifactRef & {
	type: "stdout" | "stderr" | "output" | "result";
};
export type SubagentResultArtifactRef = SubagentArtifactRef & {
	type: "tool-calls" | "tool-calls-summary" | SubagentRunLogRef["type"];
};

export function findLog(
	snapshot: SubagentRunStatusSnapshot,
	type: SubagentRunLogRef["type"],
): SubagentRunLogRef | undefined {
	return snapshot.logs.find((log) => log.type === type);
}

export async function readToolCallsSummary(
	snapshot: SubagentRunStatusSnapshot,
	subagentResult: Record<string, unknown> | undefined,
	artifactRoot: string | undefined,
): Promise<{ ref: SubagentArtifactRef; summary: unknown } | undefined> {
	const artifactRef = toolCallArtifactRef(subagentResult, "tool-calls-summary");
	if (!artifactRef) return undefined;
	const summary = await readJsonLoose<unknown>(
		safeArtifactPath(snapshot, artifactRef, artifactRoot),
	);
	return summary === undefined ? undefined : { ref: artifactRef, summary };
}

export async function readFailedToolCalls(
	snapshot: SubagentRunStatusSnapshot,
	subagentResult: Record<string, unknown> | undefined,
	artifactRoot: string | undefined,
): Promise<
	| { ref: SubagentArtifactRef; records: WorkflowTaskFailedToolCallSummary[] }
	| undefined
> {
	const artifactRef = toolCallArtifactRef(subagentResult, "tool-calls");
	if (!artifactRef) return undefined;
	const text = await readFile(
		safeArtifactPath(snapshot, artifactRef, artifactRoot),
		"utf8",
	).catch(() => "");
	const records: WorkflowTaskFailedToolCallSummary[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (records.length >= MAX_FAILED_TOOL_CALL_RECORDS) break;
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const record = failedToolCallSummary(parsed);
		if (record) records.push(record);
	}
	return { ref: artifactRef, records };
}

function toolCallArtifactRef(
	subagentResult: Record<string, unknown> | undefined,
	type: "tool-calls" | "tool-calls-summary",
): SubagentArtifactRef | undefined {
	const artifacts = Array.isArray(subagentResult?.artifacts)
		? subagentResult.artifacts
		: [];
	const resultCwd =
		typeof subagentResult?.cwd === "string" ? subagentResult.cwd : undefined;
	const ref = artifacts.find((artifact): artifact is SubagentArtifactRef => {
		return (
			typeof artifact === "object" &&
			artifact !== null &&
			(artifact as SubagentArtifactRef).type === type &&
			typeof (artifact as SubagentArtifactRef).path === "string"
		);
	});
	return ref
		? { ...ref, artifactCwd: ref.artifactCwd ?? resultCwd }
		: undefined;
}

function failedToolCallSummary(
	value: unknown,
): WorkflowTaskFailedToolCallSummary | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const status = stringValue(record.status);
	const isError = record.isError === true;
	if (status !== "failed" && status !== "incomplete" && !isError)
		return undefined;
	return {
		toolCallId: stringValue(record.toolCallId),
		toolName: stringValue(record.toolName),
		category: stringValue(record.category),
		status,
		startedAt: stringValue(record.startedAt),
		completedAt:
			record.completedAt === null ? null : stringValue(record.completedAt),
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : undefined,
		isError,
		argsSummary: record.argsSummary,
		resultSummary: record.resultSummary,
		failedArgs: record.failedArgs,
		failedResult: record.failedResult,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export type TaskArtifactLinkTestHook = (
	source: string,
	target: string,
) => void | Promise<void>;

let taskArtifactLinkForTests: TaskArtifactLinkTestHook | undefined;

export function setTaskArtifactLinkForTests(
	hook: TaskArtifactLinkTestHook | undefined,
): void {
	taskArtifactLinkForTests = hook;
}

async function linkTaskArtifact(source: string, target: string): Promise<void> {
	await taskArtifactLinkForTests?.(source, target);
	await unlinkExistingTaskArtifact(target);
	await link(source, target);
}

async function unlinkExistingTaskArtifact(target: string): Promise<void> {
	try {
		await unlink(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
}

export async function copyLogOrEmpty(
	snapshot: SubagentRunStatusSnapshot,
	ref: SubagentRunLogRef | undefined,
	target: string,
	artifactRoot: string | undefined,
): Promise<number> {
	await mkdir(dirname(target), { recursive: true });
	if (!ref) {
		await writeFile(target, "", "utf8");
		return 0;
	}
	let source: string;
	try {
		source = safeArtifactPath(snapshot, ref, artifactRoot);
	} catch {
		await writeFile(target, "", "utf8");
		return 0;
	}
	let copied = true;
	try {
		await linkTaskArtifact(source, target);
	} catch {
		await copyFile(source, target).catch(async () => {
			copied = false;
			await writeFile(target, "", "utf8");
		});
	}
	if (!copied) return 0;
	return stat(target)
		.then((value) => value.size)
		.catch(() => 0);
}

export async function copyLogOrEmptyMeasured(
	snapshot: SubagentRunStatusSnapshot,
	ref: SubagentRunLogRef | undefined,
	target: string,
	artifactRoot: string | undefined,
): Promise<{ durationMs: number; bytes: number }> {
	const startedAtMs = Date.now();
	const bytes = await copyLogOrEmpty(snapshot, ref, target, artifactRoot);
	return { durationMs: elapsedSince(startedAtMs), bytes };
}

export function safeArtifactPath(
	snapshot: SubagentRunStatusSnapshot,
	artifact: Pick<SubagentRunLogRef, "path" | "artifactCwd">,
	artifactRoot: string | undefined,
): string {
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		throw new Error("subagent artifact path must be relative and safe");
	const artifactCwd = resolve(
		artifact.artifactCwd ??
			snapshot.logs.find((log) => log.artifactCwd)?.artifactCwd ??
			".",
	);
	const artifactPath = resolve(artifactCwd, artifact.path.split("/").join(sep));
	if (artifactRoot && !isInsidePath(resolve(artifactRoot), artifactPath)) {
		throw new Error("subagent artifact path must stay inside the task runsDir");
	}
	return artifactPath;
}

export async function readJsonLoose<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface SubagentRunRecordLike {
	runId?: string;
	correlationId?: string;
	activeAttemptId?: string | null;
	latestAttemptId?: string | null;
	startedAt?: string;
	updatedAt?: string;
	attempts?: Array<{
		attemptId?: string;
		startedAt?: string;
		updatedAt?: string;
	}>;
}

export async function recoverSubagentHandle(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	projectCwd?: string,
): Promise<SubagentBackendHandle | undefined> {
	const runsDir = subagentRunsDir(run, task);
	const expectedCorrelationId = `${run.runId}:${task.taskId}`;
	const claimStartedAtMs = timestampMs(task.startedAt);
	const candidates: Array<{
		handle: SubagentBackendHandle;
		updatedAtMs: number;
	}> = [];
	// WP39b: the project for a worktree task (its state cwd); before WP39b, inside the worktree.
	const stateCwds = [
		...new Set([
			...(projectCwd === undefined
				? []
				: [workflowTaskStateCwd(projectCwd, task)]),
			task.cwd,
		]),
	];
	for (const stateCwd of stateCwds) {
		const absoluteRunsDir = resolve(stateCwd, runsDir);
		const entries = await readdir(absoluteRunsDir, {
			withFileTypes: true,
		}).catch(() => []);
		await collectRecoveredHandles(entries, absoluteRunsDir, stateCwd);
		if (candidates.length > 0) break;
	}

	async function collectRecoveredHandles(
		entries: Array<import("node:fs").Dirent>,
		absoluteRunsDir: string,
		stateCwd: string,
	): Promise<void> {
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
			const record = await readJsonLoose<SubagentRunRecordLike>(
				join(absoluteRunsDir, entry.name, "run.json"),
			);
			if (!record || record.correlationId !== expectedCorrelationId) continue;
			if (isPreClaimSubagentRecord(record, claimStartedAtMs)) continue;
			const attemptId =
				record.activeAttemptId ??
				record.latestAttemptId ??
				record.attempts?.at(-1)?.attemptId;
			if (typeof attemptId !== "string" || attemptId.length === 0) continue;
			candidates.push({
				handle: makeSubagentHandle(
					task,
					record.runId ?? entry.name,
					attemptId,
					runsDir,
					workflowTaskSessionId(run, task),
					stateCwd,
				),
				updatedAtMs:
					timestampMs(record.updatedAt) ??
					timestampMs(record.startedAt) ??
					timestampMs(record.attempts?.at(-1)?.updatedAt) ??
					timestampMs(record.attempts?.at(-1)?.startedAt) ??
					0,
			});
		}
	}

	candidates.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
	return candidates[0]?.handle;
}

function isPreClaimSubagentRecord(
	record: SubagentRunRecordLike,
	claimStartedAtMs: number | undefined,
): boolean {
	if (claimStartedAtMs === undefined) return false;
	const recordStartedAtMs =
		timestampMs(record.startedAt) ??
		timestampMs(record.attempts?.[0]?.startedAt) ??
		timestampMs(record.updatedAt);
	return (
		recordStartedAtMs !== undefined && recordStartedAtMs < claimStartedAtMs
	);
}

export function timestampMs(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : undefined;
}

/**
 * WP39b (live bundle 5, O7): where a task's runtime attempt state (`runsDir`) lives. A task in a
 * managed worktree runs there, but its attempt state stays in the project's own `.agent-workflow/`
 * (the runtime runs it with `cwd` = the project and the worktree as its execution directory);
 * every other task keeps it under its cwd.
 */
export function workflowTaskStateCwd(
	projectCwd: string,
	task: Pick<WorkflowTaskRunRecord, "cwd" | "worktree">,
): string {
	const worktree = task.worktree;
	return worktree?.enabled === true &&
		typeof worktree.path === "string" &&
		resolve(task.cwd) === resolve(worktree.path)
		? resolve(projectCwd)
		: task.cwd;
}

/**
 * The state cwd of a launched task: the recorded handle's (attempts launched before WP39b kept a
 * worktree task's state inside the worktree), else `workflowTaskStateCwd`.
 */
export function recordedTaskStateCwd(
	projectCwd: string,
	task: WorkflowTaskRunRecord,
): string {
	return getSubagentHandle(task)?.cwd ?? workflowTaskStateCwd(projectCwd, task);
}

export function makeSubagentHandle(
	task: WorkflowTaskRunRecord,
	runId: string,
	attemptId: string,
	runsDir: string,
	sessionId?: string,
	stateCwd: string = task.cwd,
): SubagentBackendHandle {
	return {
		engine: "agent-workflow",
		backend: "runtime",
		runId,
		attemptId,
		cwd: stateCwd,
		runsDir,
		display: `agent-workflow/runtime ${runId}/${attemptId}`,
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

export function getSubagentHandle(
	task: WorkflowTaskRunRecord,
): SubagentBackendHandle | undefined {
	const handle = task.backendHandle;
	if (!handle || typeof handle !== "object") return undefined;
	const candidate = handle as Partial<SubagentBackendHandle>;
	if (candidate.engine !== "agent-workflow" || candidate.backend !== "runtime")
		return undefined;
	if (
		typeof candidate.runId !== "string" ||
		typeof candidate.attemptId !== "string" ||
		typeof candidate.cwd !== "string" ||
		typeof candidate.runsDir !== "string"
	)
		return undefined;
	return {
		...(candidate as SubagentBackendHandle),
		...(typeof candidate.sessionId === "string"
			? { sessionId: candidate.sessionId }
			: {}),
	};
}

export function subagentRunsDir(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string {
	return `${DEFAULT_SUBAGENT_RUNS_ROOT}/${run.runId}/${task.taskId}`;
}
