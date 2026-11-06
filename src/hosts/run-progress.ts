// New in agent-workflow (WP36): read-only views of a project's runs for hosts without a session UI
// of their own (owner decision E1): the Claude Code status line (`agent-workflow statusline`), the
// terminal live view next to Codex or Claude Code (`agent-workflow watch`), and the completion check
// (`agent-workflow notify-check`). Nothing here drives a run, takes a lease or calls a model: the
// run index (`.agent-workflow/workflows/index.json`, one file) names the candidates and only the
// non-terminal ones are read from their `run.json`.
import { readFile } from "node:fs/promises";

import {
	isTerminalWorkflowStatus,
	isWorkflowRunLeaseLive,
	listRunRecords,
	readRunRecord,
	workflowIndexPath,
} from "../core/store.js";
import type { WorkflowRunRecord, WorkflowRunStatus } from "../core/types.js";

/** A blocked run stays in the status line and the watch list for a day, then drops out. */
export const BLOCKED_RUN_VISIBLE_MS = 24 * 60 * 60 * 1000;

export interface RunIndexEntry {
	runId: string;
	name?: string;
	status: WorkflowRunStatus;
	createdAt: string;
	updatedAt: string;
	parentRunId?: string;
}

function indexEntry(value: unknown): RunIndexEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Record<string, unknown>;
	if (typeof entry.runId !== "string" || typeof entry.status !== "string")
		return undefined;
	return {
		runId: entry.runId,
		...(typeof entry.name === "string" ? { name: entry.name } : {}),
		status: entry.status as WorkflowRunStatus,
		createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
		updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
		...(typeof entry.parentRunId === "string"
			? { parentRunId: entry.parentRunId }
			: {}),
	};
}

/**
 * Run entries of the project, from the run index when it is readable (first and terminal run
 * writes update it synchronously), else from every `run.json`. Empty when the project has no runs.
 */
export async function readProjectRunEntries(
	cwd: string,
): Promise<RunIndexEntry[]> {
	let text: string | undefined;
	try {
		text = await readFile(workflowIndexPath(cwd), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") text = undefined;
	}
	if (text !== undefined) {
		try {
			const parsed = JSON.parse(text) as { runs?: unknown };
			if (Array.isArray(parsed.runs))
				return parsed.runs
					.map(indexEntry)
					.filter((entry): entry is RunIndexEntry => entry !== undefined);
		} catch {
			// A torn or corrupt index: fall back to the run records below.
		}
	}
	const runs = await listRunRecords(cwd).catch(() => []);
	return runs.map((run) => ({
		runId: run.runId,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
	}));
}

export interface ActiveRun {
	run: WorkflowRunRecord;
	/** A live supervisor (or foreground process) holds the run lease. */
	live: boolean;
}

export function timeMs(value: string | undefined): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Top-level runs that are not terminal, fresh from `run.json`, newest first: running runs, and
 * blocked runs updated within `blockedVisibleMs` (default a day).
 */
export async function listActiveRuns(
	cwd: string,
	options: { now?: number; blockedVisibleMs?: number } = {},
): Promise<ActiveRun[]> {
	const now = options.now ?? Date.now();
	const blockedVisibleMs = options.blockedVisibleMs ?? BLOCKED_RUN_VISIBLE_MS;
	const entries = (await readProjectRunEntries(cwd)).filter(
		(entry) => !entry.parentRunId && !isTerminalWorkflowStatus(entry.status),
	);
	const active = await Promise.all(
		entries.map(async (entry): Promise<ActiveRun | undefined> => {
			const run = await readRunRecord(cwd, entry.runId).catch(() => undefined);
			if (!run || run.parentRunId || isTerminalWorkflowStatus(run.status))
				return undefined;
			if (
				run.status === "blocked" &&
				now - timeMs(run.updatedAt) > blockedVisibleMs
			)
				return undefined;
			const live =
				run.status === "running"
					? await isWorkflowRunLeaseLive(cwd, run.runId).catch(() => false)
					: false;
			return { run, live };
		}),
	);
	return active
		.filter((item): item is ActiveRun => item !== undefined)
		.sort((a, b) => timeMs(b.run.createdAt) - timeMs(a.run.createdAt));
}

/** `45s`, `12m`, `1h05m`, `2d03h`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

/** A run's display name, at most `max` characters (an ellipsis marks a cut). */
export function shortRunName(run: { name?: string; runId: string }, max = 24) {
	const label = Array.from(run.name ?? run.runId);
	return label.length > max
		? `${label.slice(0, max - 1).join("")}…`
		: label.join("");
}

/** The one-word state of an active run: running, unsupervised, blocked. */
export function activeRunState(item: ActiveRun): string {
	const { run } = item;
	if (run.status === "blocked") return "needs action";
	return item.live ? "running" : "running (no supervisor)";
}

/**
 * The status-line text: `aw: deep-review 5/13 running 12m · +1 more`; empty when nothing is
 * active.
 */
export function formatStatusLine(
	active: readonly ActiveRun[],
	now = Date.now(),
): string {
	const [first] = active;
	if (!first) return "";
	const { run } = first;
	const elapsed = formatElapsed(now - timeMs(run.createdAt));
	const more = active.length > 1 ? ` · +${active.length - 1} more` : "";
	return `aw: ${shortRunName(run)} ${run.taskSummary.completed}/${run.taskSummary.total} ${activeRunState(first)} ${elapsed}${more}`;
}
