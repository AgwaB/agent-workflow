// New in agent-workflow (WP36, owner decision E1: the "watch" of Codex, usable next to any host): a
// terminal live view of the project's active runs or of one run, refreshed every 1–2 s: tasks,
// status, elapsed time, pending dynamic-controller approvals (WP29) and, when the run is done, the
// verdict and the report paths. Plain ANSI (clear screen + redraw on a terminal; on a pipe a new
// frame only when something changed). Read-only: it never drives a run (a missing supervisor is
// reported with the `supervise` command), takes no lease and calls no model.
import {
	type PendingDynamicApproval,
	pendingDynamicApprovals,
} from "../core/dynamic-approval.js";
import {
	isTerminalWorkflowStatus,
	isWorkflowRunLeaseLive,
	readRunRecord,
} from "../core/store.js";
import type { WorkflowRunRecord } from "../core/types.js";
import { summarizeWorkflowTerminal } from "../core/workflow-terminal.js";
import { CLI_COMMAND_HINTS, pendingApprovalLines } from "./hints.js";
import { isSettledRun } from "./notify-check.js";
import { hostTextRedactor } from "./redaction.js";
import { readWorkflowResultPresentation } from "./result-presentation.js";
import { formatElapsed, listActiveRuns, shortRunName } from "./run-progress.js";

export const WATCH_DEFAULT_INTERVAL_MS = 2_000;
export const WATCH_MIN_INTERVAL_MS = 1_000;
export const WATCH_MAX_INTERVAL_MS = 10_000;
/** Task rows of one run in a frame when the terminal height is unknown. */
export const WATCH_DEFAULT_TASK_ROWS = 40;

export interface WatchRunView {
	run: WorkflowRunRecord;
	live: boolean;
	settled: boolean;
	terminal: boolean;
	semanticStatus?: string;
	verdict?: string;
	verdictGate?: true;
	reportPaths: string[];
	pendingApprovals: PendingDynamicApproval[];
}

function timeMs(value: string | undefined): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** One run as the watch shows it (fresh from `run.json`). */
export async function readWatchRun(
	cwd: string,
	runRef: string,
): Promise<WatchRunView> {
	const run = await readRunRecord(cwd, runRef);
	const settled = isSettledRun(run);
	const terminal = isTerminalWorkflowStatus(run.status);
	const live =
		run.status === "running"
			? await isWorkflowRunLeaseLive(cwd, run.runId).catch(() => false)
			: false;
	const view: WatchRunView = {
		run,
		live,
		settled,
		terminal,
		reportPaths: [],
		pendingApprovals: [],
	};
	if (terminal) {
		const summary = await summarizeWorkflowTerminal(cwd, run);
		view.semanticStatus = summary.semanticStatus;
		const presentation = await readWorkflowResultPresentation(
			cwd,
			run,
			summary.outputTaskIds,
		).catch(() => undefined);
		if (presentation?.verdict) view.verdict = presentation.verdict;
		if (presentation?.verdictGate) view.verdictGate = true;
		view.reportPaths = (presentation?.artifacts ?? []).map(
			(artifact) => `${artifact.label}: ${artifact.path}`,
		);
	} else if (run.status === "blocked") {
		view.pendingApprovals = await pendingDynamicApprovals(cwd, run).catch(
			() => [],
		);
	}
	return view;
}

interface Style {
	bold: (text: string) => string;
	dim: (text: string) => string;
	green: (text: string) => string;
	red: (text: string) => string;
	yellow: (text: string) => string;
}

function style(color: boolean): Style {
	const wrap = (code: string) => (text: string) =>
		color ? `\u001b[${code}m${text}\u001b[0m` : text;
	return {
		bold: wrap("1"),
		dim: wrap("2"),
		green: wrap("32"),
		red: wrap("31"),
		yellow: wrap("33"),
	};
}

const TASK_ICONS: Record<string, string> = {
	completed: "✓",
	running: "▶",
	pending: "·",
	blocked: "■",
	failed: "✗",
	interrupted: "!",
	skipped: "-",
};

function cut(text: string, max: number): string {
	const chars = Array.from(text.replace(/\s+/gu, " ").trim());
	return chars.length > max
		? `${chars.slice(0, max - 1).join("")}…`
		: chars.join("");
}

function pad(text: string, width: number): string {
	const length = Array.from(text).length;
	return length >= width ? text : `${text}${" ".repeat(width - length)}`;
}

function taskRow(
	task: WorkflowRunRecord["tasks"][number],
	now: number,
	s: Style,
): string {
	const icon = TASK_ICONS[task.status] ?? "?";
	const paint =
		task.status === "completed"
			? s.green
			: task.status === "running"
				? s.yellow
				: task.status === "failed" ||
						task.status === "blocked" ||
						task.status === "interrupted"
					? s.red
					: s.dim;
	const started = timeMs(task.startedAt);
	const elapsed =
		task.elapsedMs !== undefined
			? formatElapsed(task.elapsedMs)
			: started
				? formatElapsed((timeMs(task.completedAt) || now) - started)
				: "";
	const runtime = task.runtime?.executor
		? `${task.runtime.executor}${task.runtime.model ? `/${task.runtime.model}` : ""}`
		: "";
	const problem =
		task.status === "failed" ||
		task.status === "blocked" ||
		task.status === "interrupted"
			? cut(String(task.lastMessage ?? task.statusDetail ?? ""), 70)
			: "";
	const name = cut(task.displayName || task.specId, 30);
	return `  ${paint(icon)} ${pad(name, 30)} ${paint(pad(task.status, 11))} ${pad(elapsed, 7)} ${[runtime, problem].filter(Boolean).join("  ")}`.trimEnd();
}

/** Task rows within `maxRows`: completed tasks fold into one line first, then the tail is cut. */
function taskRows(
	run: WorkflowRunRecord,
	now: number,
	s: Style,
	maxRows: number,
): string[] {
	const tasks = run.tasks;
	if (tasks.length <= maxRows)
		return tasks.map((task) => taskRow(task, now, s));
	const open = tasks.filter((task) => task.status !== "completed");
	const done = tasks.length - open.length;
	const rows = [
		...(done ? [s.dim(`  ✓ ${done} completed tasks (hidden)`)] : []),
	];
	const room = Math.max(1, maxRows - rows.length - 1);
	rows.push(...open.slice(0, room).map((task) => taskRow(task, now, s)));
	if (open.length > room)
		rows.push(s.dim(`  … ${open.length - room} more tasks`));
	return rows;
}

/** Lines of one run: header, progress, tasks, then the result or the action it needs. */
export function renderRunView(
	view: WatchRunView,
	options: { now: number; color?: boolean; maxTaskRows?: number },
): string[] {
	const s = style(options.color === true);
	const { run } = view;
	const summary = run.taskSummary;
	const end = view.terminal ? timeMs(run.updatedAt) : options.now;
	const elapsed = formatElapsed(end - timeMs(run.createdAt));
	const statusText =
		run.status === "completed"
			? s.green(run.status)
			: run.status === "running"
				? s.yellow(run.status)
				: s.red(run.status);
	const lines = [
		`${s.bold(shortRunName(run, 60))} ${s.dim(`(${run.runId})`)}`,
		`Status: ${statusText} · ${summary.completed}/${summary.total} completed · ${summary.running} running · ${summary.failed} failed${summary.blocked ? ` · ${summary.blocked} blocked` : ""} · elapsed ${elapsed}`,
	];
	if (run.status === "running" && !view.live)
		lines.push(
			s.yellow(
				`⚠ No live supervisor is driving this run. Start one with: agent-workflow supervise ${run.runId}`,
			),
		);
	lines.push(
		"",
		...taskRows(
			run,
			options.now,
			s,
			options.maxTaskRows ?? WATCH_DEFAULT_TASK_ROWS,
		),
	);
	if (view.terminal) {
		const outcome = view.verdict
			? `verdict ${view.verdict}${view.verdictGate ? " (report ready; only the final verdict gate did not pass)" : ""}`
			: `status ${view.semanticStatus ?? run.status}`;
		lines.push(
			"",
			s.bold(`Finished: ${run.status} — ${outcome}`),
			...view.reportPaths,
		);
		if (!view.reportPaths.length)
			lines.push(`Details: ${CLI_COMMAND_HINTS.status(run.runId)}`);
	} else if (view.settled) {
		if (view.pendingApprovals.length)
			lines.push(
				...pendingApprovalLines("cli", run.runId, view.pendingApprovals),
			);
		else
			lines.push(
				"",
				s.red(
					`Needs action: ${summary.blocked} blocked task(s). Inspect: ${CLI_COMMAND_HINTS.inspectFailures(run.runId)} · Resume: ${CLI_COMMAND_HINTS.resume(run.runId)}`,
				),
			);
	}
	return lines;
}

/** The compact line of one run in the project view. */
export function renderRunLine(
	view: WatchRunView,
	options: { now: number; color?: boolean },
): string[] {
	const s = style(options.color === true);
	const { run } = view;
	const summary = run.taskSummary;
	const end = view.terminal ? timeMs(run.updatedAt) : options.now;
	const head = `${s.bold(shortRunName(run, 40))} ${s.dim(run.runId)} ${summary.completed}/${summary.total} ${formatElapsed(end - timeMs(run.createdAt))}`;
	if (view.terminal) {
		const outcome = view.verdict
			? `verdict ${view.verdict}`
			: `status ${view.semanticStatus ?? run.status}`;
		return [
			`${run.status === "completed" ? s.green("✓") : s.red("✗")} ${head} finished — ${outcome}`,
			...view.reportPaths.map((path) => `    ${path}`),
		];
	}
	if (view.settled)
		return [
			`${s.red("■")} ${head} ${view.pendingApprovals.length ? `awaiting approval: agent-workflow approve ${run.runId}` : `needs action: ${CLI_COMMAND_HINTS.inspectFailures(run.runId)}`}`,
		];
	const running = run.tasks
		.filter((task) => task.status === "running")
		.map((task) => task.displayName || task.specId);
	return [
		`${s.yellow("▶")} ${head} running${view.live ? "" : s.yellow(" (no live supervisor)")}${running.length ? ` — ${cut(running.join(", "), 80)}` : ""}`,
	];
}

function signature(views: readonly WatchRunView[]): string {
	return JSON.stringify(
		views.map((view) => [
			view.run.runId,
			view.run.status,
			view.live,
			view.run.tasks.map((task) => task.status),
			view.pendingApprovals.length,
			view.reportPaths,
		]),
	);
}

export interface WatchOptions {
	cwd: string;
	/** One run (id or prefix); absent: every active run of the project. */
	runRef?: string;
	/** Keep watching after the run (or every run) ended. */
	follow?: boolean;
	/** Print one frame and exit. */
	once?: boolean;
	intervalMs?: number;
	/** Ring the terminal bell when the watched run ends. */
	bell?: boolean;
	isTTY: boolean;
	color?: boolean;
	/** Terminal height (bounds the task rows). */
	rows?: number;
	env?: NodeJS.ProcessEnv;
	write: (text: string) => void;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveSleep) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolveSleep();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

const CLEAR = "\u001b[H\u001b[2J";

/**
 * `agent-workflow watch [run]`: redraw until the watched run settles (terminal, or blocked and
 * needing the user), or every active run of the project has; `follow` keeps going, `once` draws one
 * frame. Exit code: one run → 0 when it completed, 1 otherwise; project view → 0.
 */
export async function runWatch(options: WatchOptions): Promise<number> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const interval = Math.min(
		WATCH_MAX_INTERVAL_MS,
		Math.max(
			WATCH_MIN_INTERVAL_MS,
			options.intervalMs ?? WATCH_DEFAULT_INTERVAL_MS,
		),
	);
	const redact = hostTextRedactor(options.env ?? process.env);
	const color = options.color === true;
	const maxTaskRows = options.rows
		? Math.max(5, options.rows - 12)
		: WATCH_DEFAULT_TASK_ROWS;
	// Project view: runs seen active stay in the view (with their result) after they end.
	const tracked = new Map<string, WatchRunView | undefined>();
	let lastSignature: string | undefined;
	let runId = options.runRef;
	for (;;) {
		const at = now();
		let views: WatchRunView[];
		let body: string[];
		let ended: boolean;
		let exitCode = 0;
		if (options.runRef !== undefined) {
			const view = await readWatchRun(options.cwd, runId!);
			runId = view.run.runId;
			views = [view];
			body = renderRunView(view, { now: at, color, maxTaskRows });
			ended = view.settled;
			exitCode = view.run.status === "completed" ? 0 : 1;
		} else {
			const active = await listActiveRuns(options.cwd, { now: at });
			for (const item of active)
				if (!tracked.has(item.run.runId))
					tracked.set(item.run.runId, undefined);
			views = [];
			for (const runIdKey of [...tracked.keys()]) {
				const previous = tracked.get(runIdKey);
				if (previous?.settled && previous.terminal) {
					views.push(previous);
					continue;
				}
				const view = await readWatchRun(options.cwd, runIdKey).catch(
					() => undefined,
				);
				if (!view) {
					tracked.delete(runIdKey);
					continue;
				}
				tracked.set(runIdKey, view);
				views.push(view);
			}
			ended = views.every((view) => view.settled);
			body = views.length
				? views.flatMap((view) => renderRunLine(view, { now: at, color }))
				: [
						"No active workflow runs in this project (.agent-workflow/workflows).",
					];
		}
		const header = style(color).dim(
			`agent-workflow watch · ${new Date(at).toISOString().slice(11, 19)} · ${options.once ? "one frame" : ended && !options.follow ? "done" : `every ${interval / 1000}s, Ctrl-C to quit (runs continue)`}`,
		);
		const frame = redact([header, "", ...body].join("\n"));
		if (options.isTTY) options.write(`${CLEAR}${frame}\n`);
		else {
			const current = signature(views);
			if (
				current !== lastSignature ||
				options.once ||
				(ended && !options.follow)
			)
				options.write(`${frame}\n\n`);
			lastSignature = current;
		}
		if (options.once) return exitCode;
		if (ended && !options.follow) {
			if (options.bell && options.isTTY) options.write("\u0007");
			return exitCode;
		}
		if (options.signal?.aborted) return 0;
		await sleep(interval, options.signal);
		if (options.signal?.aborted) return 0;
	}
}
