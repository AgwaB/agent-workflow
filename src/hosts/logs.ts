// New in agent-workflow (WP16): the `logs` host action, a bounded and redacted tail of a run's task
// output, stderr and executor events. Port in spirit of pi-workflow 0.16.4 (b83cc4f)
// `/workflow logs <run> [task] [lines]` (core `formatLogs`: one task's output tail), extended to
// stderr and the latest attempt's `exec-events.jsonl`, every started task by default, and bounds on
// lines per stream, characters per line, tasks and total text. Every line goes through the shared
// redaction (`redactSensitiveWorkflowText`: credential assignments, bearer tokens, URL secrets, home
// paths) and the values of sensitive host environment variables (`*_KEY`, `*TOKEN*`, `*SECRET*`, …,
// via the executors' `createSecretRedactor`) are replaced, so a tail never echoes a secret.
// WP19 (review #4): every path read here (task `files.*` from the persisted run record, the
// attempt dirs under `workflow-subagents/`) must resolve canonically inside the project's artifact
// root (`resolveContainedRunFile`); absolute paths, traversal and symlink escapes are refused and the
// stream says why instead of showing the file.
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { refreshRun } from "../core/engine.js";
import { readRunRecord, toProjectPath, workflowsRoot } from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import { readFileLinesBounded } from "../core/workflow-preview.js";
import { HostUsageError } from "./args.js";
import { hostTextRedactor } from "./redaction.js";
import { resolveContainedRunFile } from "./run-files.js";
import {
	assertActionAllowed,
	type HostApiContext,
	type HostResult,
	hostEnv,
	result,
} from "./types.js";

export const LOGS_DEFAULT_LINES = 20;
export const LOGS_MAX_LINES = 400;
/** Characters kept of one log line. */
export const LOGS_MAX_LINE_CHARS = 400;
/** Tasks shown without `task` (the most recently started ones). */
export const LOGS_MAX_TASKS = 6;
/** Bound of the whole text rendering (and of the lines kept in `data`). */
export const LOGS_MAX_TEXT_CHARS = 48_000;

export const LOG_STREAMS = ["output", "stderr", "events"] as const;
export type LogStreamKind = (typeof LOG_STREAMS)[number];

export interface LogsRequest {
	runId: string;
	/** Task id or spec id; omitted = every started task (at most 6, most recent first). */
	task?: string;
	/** Lines per stream (1-400, default 20). */
	lines?: number;
	/** One stream or all (default). */
	stream?: LogStreamKind | "all";
}

export interface LogStream {
	kind: LogStreamKind;
	/** Project-relative path (redacted like the lines). */
	path: string;
	lines: string[];
	/** The file had more lines than shown (or a line was cut). */
	truncated: boolean;
	/** WP19: why the path was not read (outside the artifact root, traversal, symlink escape). */
	refused?: string;
}

export interface LogsTask {
	taskId: string;
	specId: string;
	status: string;
	statusDetail: string;
	streams: LogStream[];
}

export interface LogsData {
	runId: string;
	name?: string;
	status: WorkflowRunRecord["status"];
	lines: number;
	streams: LogStreamKind[];
	tasks: LogsTask[];
	/** Started tasks not shown (without `task`, only the most recent 6 are). */
	omittedTasks: number;
	/** The total text bound cut the rendering. */
	truncated: boolean;
}

function logLines(value: unknown): number {
	if (value === undefined) return LOGS_DEFAULT_LINES;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > LOGS_MAX_LINES
	)
		throw new HostUsageError(
			`logs lines must be an integer from 1 to ${LOGS_MAX_LINES}`,
		);
	return value;
}

function logStreams(value: unknown): LogStreamKind[] {
	if (value === undefined || value === "all") return [...LOG_STREAMS];
	if (
		typeof value === "string" &&
		(LOG_STREAMS as readonly string[]).includes(value)
	)
		return [value as LogStreamKind];
	throw new HostUsageError(
		`logs stream must be one of ${[...LOG_STREAMS, "all"].join(", ")}`,
	);
}

/** Shared redaction plus the values of sensitive host environment variables (WP19: redaction.ts). */
export function logRedactor(env: NodeJS.ProcessEnv): (line: string) => string {
	return hostTextRedactor(env);
}

async function latestAttemptDir(
	cwd: string,
	runId: string,
	taskId: string,
): Promise<string | undefined> {
	const taskRoot = join(
		dirname(workflowsRoot(cwd)),
		"workflow-subagents",
		runId,
		taskId,
	);
	let best: { dir: string; mtimeMs: number } | undefined;
	const backendRuns = await readdir(taskRoot).catch(() => [] as string[]);
	for (const backendRun of backendRuns) {
		const attemptsRoot = join(taskRoot, backendRun, "attempts");
		const attempts = await readdir(attemptsRoot).catch(() => [] as string[]);
		for (const attempt of attempts) {
			const dir = join(attemptsRoot, attempt);
			const info = await stat(dir).catch(() => undefined);
			if (!info?.isDirectory()) continue;
			if (!best || info.mtimeMs > best.mtimeMs)
				best = { dir, mtimeMs: info.mtimeMs };
		}
	}
	return best?.dir;
}

async function tail(
	cwd: string,
	projectPath: string,
	count: number,
	redact: (line: string) => string,
): Promise<{
	lines: string[];
	truncated: boolean;
	empty: boolean;
	refused?: string;
}> {
	const contained = await resolveContainedRunFile(cwd, projectPath);
	if (contained.kind === "refused")
		return {
			lines: [],
			truncated: false,
			empty: true,
			refused: contained.reason,
		};
	if (contained.kind === "missing")
		return { lines: [], truncated: false, empty: true };
	// One extra line tells whether the file had more than `count` lines.
	const raw = await readFileLinesBounded(cwd, contained.path, count + 1).catch(
		() => [] as string[],
	);
	while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
	let truncated = raw.length > count;
	const kept = raw.slice(-count).map((line) => {
		const redacted = redact(line);
		if (redacted.length <= LOGS_MAX_LINE_CHARS) return redacted;
		truncated = true;
		return `${redacted.slice(0, LOGS_MAX_LINE_CHARS)}… [${redacted.length - LOGS_MAX_LINE_CHARS} more chars]`;
	});
	return { lines: kept, truncated, empty: raw.length === 0 };
}

async function taskStreams(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowRunRecord["tasks"][number],
	kinds: LogStreamKind[],
	count: number,
	redact: (line: string) => string,
): Promise<LogStream[]> {
	const attempt = await latestAttemptDir(cwd, run.runId, task.taskId);
	const attemptPath = (file: string) =>
		attempt ? toProjectPath(cwd, join(attempt, file)) : undefined;
	const streams: LogStream[] = [];
	for (const kind of kinds) {
		// The task's own stderr is usually empty; the attempt's stderr is the executor's.
		const candidates =
			kind === "output"
				? [task.files?.output]
				: kind === "stderr"
					? [task.files?.stderr, attemptPath("stderr.log")]
					: [attemptPath("exec-events.jsonl")];
		const paths = candidates.filter((path): path is string => Boolean(path));
		let shown: LogStream | undefined;
		for (const path of paths) {
			const read = await tail(cwd, path, count, redact);
			shown = {
				kind,
				path: redact(path),
				lines: read.lines,
				truncated: read.truncated,
				...(read.refused ? { refused: read.refused } : {}),
			};
			if (!read.empty || read.refused) break;
		}
		if (shown) streams.push(shown);
	}
	return streams;
}

function selectTasks(
	run: WorkflowRunRecord,
	ref: string | undefined,
): { tasks: WorkflowRunRecord["tasks"]; omitted: number } {
	const tasks = Array.isArray(run.tasks) ? run.tasks : [];
	if (ref !== undefined) {
		const task = tasks.find(
			(item) => item.taskId === ref || item.specId === ref,
		);
		if (!task)
			throw new HostUsageError(
				`task ${ref} not found in ${run.runId} (tasks: ${tasks.map((item) => item.taskId).join(", ") || "none"})`,
			);
		return { tasks: [task], omitted: 0 };
	}
	const started = tasks
		.filter((task) => task.startedAt || task.status !== "pending")
		.sort((left, right) =>
			String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")),
		);
	const shown = started.slice(0, LOGS_MAX_TASKS);
	// Present in run order.
	const order = new Map(tasks.map((task, index) => [task.taskId, index]));
	shown.sort(
		(left, right) =>
			(order.get(left.taskId) ?? 0) - (order.get(right.taskId) ?? 0),
	);
	return { tasks: shown, omitted: started.length - shown.length };
}

/** `logs <run> [--task id] [--lines N] [--stream output|stderr|events|all]`. */
export async function logsAction(
	ctx: HostApiContext,
	request: LogsRequest,
): Promise<HostResult<LogsData>> {
	assertActionAllowed(ctx, "logs");
	if (
		typeof request?.runId !== "string" ||
		!request.runId.trim() ||
		request.runId.startsWith("-")
	)
		throw new HostUsageError("logs needs a run id (or unambiguous prefix)");
	if (
		request.task !== undefined &&
		(typeof request.task !== "string" || !request.task.trim())
	)
		throw new HostUsageError("logs task must be a non-empty string");
	const count = logLines(request.lines);
	const kinds = logStreams(request.stream);
	const resolved = await readRunRecord(ctx.cwd, request.runId.trim());
	const run = await refreshRun(ctx.cwd, resolved.runId).catch(() => resolved);
	const redact = logRedactor(hostEnv(ctx));
	const { tasks, omitted } = selectTasks(run, request.task?.trim());
	const data: LogsData = {
		runId: run.runId,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		lines: count,
		streams: kinds,
		tasks: [],
		omittedTasks: omitted,
		truncated: false,
	};
	const header = [
		`Logs: ${run.name ?? "workflow"} (${run.status})`,
		`Run: ${run.runId}`,
	];
	const body: string[] = [];
	let used = header.join("\n").length;
	const push = (line: string): boolean => {
		if (used + line.length + 1 > LOGS_MAX_TEXT_CHARS) {
			data.truncated = true;
			return false;
		}
		used += line.length + 1;
		body.push(line);
		return true;
	};
	for (const task of tasks) {
		if (data.truncated) break;
		const streams = await taskStreams(ctx.cwd, run, task, kinds, count, redact);
		const entry: LogsTask = {
			taskId: task.taskId,
			specId: task.specId,
			status: task.status,
			statusDetail: String(task.statusDetail),
			streams: [],
		};
		data.tasks.push(entry);
		if (!push("")) break;
		if (
			!push(
				`== ${task.specId || task.taskId} (${task.taskId}): ${task.status}/${String(task.statusDetail)}`,
			)
		)
			break;
		for (const stream of streams) {
			const kept: LogStream = { ...stream, lines: [] };
			entry.streams.push(kept);
			if (
				!push(
					`-- ${stream.kind}: ${stream.path}${stream.truncated ? ` (last ${count} lines)` : ""}`,
				)
			)
				break;
			if (stream.refused) {
				if (!push(`(not read: ${stream.refused})`)) break;
				continue;
			}
			if (stream.lines.length === 0 && !push("(empty)")) break;
			for (const line of stream.lines) {
				if (!push(line)) break;
				kept.lines.push(line);
			}
			if (data.truncated) {
				kept.truncated = true;
				break;
			}
		}
	}
	if (tasks.length === 0) body.push("", "(no task has started yet)");
	if (omitted > 0)
		body.push(
			"",
			`${omitted} earlier task${omitted === 1 ? "" : "s"} not shown; pass a task id.`,
		);
	if (data.truncated)
		body.push("", `[output cut at ${LOGS_MAX_TEXT_CHARS} characters]`);
	return result("logs", "success", data, [...header, ...body].join("\n"));
}
