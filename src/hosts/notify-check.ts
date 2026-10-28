// New in agent-workflow (WP36, owner decision E2: the common completion mechanism): `agent-workflow
// notify-check` prints one short line per run of this project that finished (or now needs the
// user) since the last check — "workflow X finished — verdict Y, report Z" — and prints each
// settled state once. Hosts without a completion push call it from a hook that adds its output to
// the model's context (Claude Code's `UserPromptSubmit`, shipped by the plugin; Codex's
// `UserPromptSubmit`, configured by the user; docs/host-ux-investigation.md), so a run that
// finished after the host stopped waiting reaches the conversation at the user's next message.
//
// Receipts (the WP16/WP19 receipt idea, host-neutral): `.agent-workflow/notify-check/` holds
// `baseline.json` (runs settled before it are never reported) and one marker per reported settled
// state, `<runId>.<epoch>.json`, created with O_EXCL so two concurrent checks never print the same
// state twice. The epoch is a digest of the run status and its task states, so a resumed run that
// settles again is reported again. `wait` (CLI, MCP `workflow_wait`, Pi) marks a settled state it
// returned as seen (creating the directory and baseline when needed, WP39b), so a result the host
// already showed is not repeated.
// No model call, no lease; markers of pruned runs are removed.
import { createHash } from "node:crypto";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pendingDynamicApprovals } from "../core/dynamic-approval.js";
import { hasActiveSchedulerWork } from "../core/engine-wait.js";
import {
	isSafeRunId,
	isTerminalWorkflowStatus,
	readRunRecord,
	workflowRunDir,
} from "../core/store.js";
import type { WorkflowHostId, WorkflowRunRecord } from "../core/types.js";
import { summarizeWorkflowTerminal } from "../core/workflow-terminal.js";
import { hostApproveHint, hostCommandHints } from "./hints.js";
import { hostTextRedactor } from "./redaction.js";
import { readWorkflowResultPresentation } from "./result-presentation.js";
import { containedProjectStateDir } from "./run-files.js";
import { readProjectRunEntries } from "./run-progress.js";

export const NOTIFY_CHECK_DIR = "notify-check";
export const NOTIFY_CHECK_BASELINE_FILE = "baseline.json";
/** The first check of a project also reports runs that settled in the hour before it. */
export const NOTIFY_CHECK_FIRST_LOOKBACK_MS = 60 * 60 * 1000;
/** At most this many runs per check; the rest are named by count and reported next time. */
export const NOTIFY_CHECK_MAX_RUNS = 5;

export interface RunNotification {
	runId: string;
	name?: string;
	status: WorkflowRunRecord["status"];
	/** Terminal (completed, failed, interrupted); otherwise the run needs the user (blocked). */
	terminal: boolean;
	verdict?: string;
	verdictGate?: true;
	reportPaths: string[];
	pendingApprovals: number;
	text: string;
}

export interface NotifyCheckData {
	notifications: RunNotification[];
	/** Settled runs left for the next check (over NOTIFY_CHECK_MAX_RUNS). */
	deferred: number;
}

/** Digest of a settled state: the run status and every task's status. */
export function notifyEpoch(run: WorkflowRunRecord): string {
	const state = {
		status: run.status,
		tasks: [...run.tasks]
			.sort((left, right) => left.taskId.localeCompare(right.taskId))
			.map((task) => [
				task.taskId,
				task.status,
				String(task.statusDetail ?? ""),
				task.completedAt ?? "",
			]),
	};
	return createHash("sha256")
		.update(JSON.stringify(state))
		.digest("hex")
		.slice(0, 24);
}

/** A run is settled when it is terminal or blocked with nothing left to schedule. */
export function isSettledRun(run: WorkflowRunRecord): boolean {
	return isTerminalWorkflowStatus(run.status) || !hasActiveSchedulerWork(run);
}

function markerName(run: WorkflowRunRecord): string {
	return `${run.runId}.${notifyEpoch(run)}.json`;
}

/** Create the marker; false when it exists (already reported or seen). */
async function claimMarker(
	dir: string,
	run: WorkflowRunRecord,
	via: "notify-check" | "wait",
	now: number,
): Promise<boolean> {
	try {
		await writeFile(
			join(dir, markerName(run)),
			`${JSON.stringify({
				runId: run.runId,
				epoch: notifyEpoch(run),
				status: run.status,
				via,
				at: new Date(now).toISOString(),
			})}\n`,
			{ flag: "wx" },
		);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/**
 * `wait` returned this settled run to a user or host: mark it seen so notify-check does not repeat
 * it. WP39b (O5): also in a fresh project: the receipts directory and the baseline are created
 * when missing (as the first notify-check would), so the hook's first check does not announce a run
 * the host already showed. Best effort.
 */
export async function markRunNotifySeen(
	cwd: string,
	run: WorkflowRunRecord,
	now = Date.now(),
): Promise<void> {
	if (run.parentRunId || !isSettledRun(run)) return;
	const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, true);
	if (!dir) return;
	await readBaseline(dir, now).catch(() => undefined);
	await claimMarker(dir, run, "wait", now).catch(() => false);
}

async function readBaseline(dir: string, now: number): Promise<number> {
	const file = join(dir, NOTIFY_CHECK_BASELINE_FILE);
	const since = now - NOTIFY_CHECK_FIRST_LOOKBACK_MS;
	try {
		await writeFile(
			file,
			`${JSON.stringify({ since: new Date(since).toISOString() })}\n`,
			{ flag: "wx" },
		);
		return since;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as {
			since?: unknown;
		};
		const value =
			typeof parsed.since === "string" ? Date.parse(parsed.since) : Number.NaN;
		return Number.isFinite(value) ? value : since;
	} catch {
		return since;
	}
}

/** Remove markers of runs that no longer exist (pruned). Best effort. */
async function pruneMarkers(cwd: string, dir: string): Promise<void> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const exists = new Map<string, boolean>();
	for (const name of names) {
		const match = /^(.+)\.[0-9a-f]{24}\.json$/u.exec(name);
		if (!match) continue;
		const runId = match[1]!;
		if (!isSafeRunId(runId)) continue;
		let present = exists.get(runId);
		if (present === undefined) {
			present = await access(join(workflowRunDir(cwd, runId), "run.json"))
				.then(() => true)
				.catch(
					(error: NodeJS.ErrnoException) =>
						!(error.code === "ENOENT" || error.code === "ENOTDIR"),
				);
			exists.set(runId, present);
		}
		if (!present) await rm(join(dir, name), { force: true }).catch(() => {});
	}
}

function quote(name: string | undefined): string {
	return name ? `"${name}" ` : "";
}

async function describe(
	cwd: string,
	run: WorkflowRunRecord,
	host: WorkflowHostId,
): Promise<RunNotification> {
	const hints = hostCommandHints(host);
	const summary = await summarizeWorkflowTerminal(cwd, run);
	const label = `agent-workflow: workflow ${quote(run.name)}(run ${run.runId})`;
	if (summary.terminal) {
		const presentation = await readWorkflowResultPresentation(
			cwd,
			run,
			summary.outputTaskIds,
		).catch(() => undefined);
		const reportPaths = (presentation?.artifacts ?? []).map(
			(artifact) => artifact.path,
		);
		const outcome = presentation?.verdict
			? `verdict ${presentation.verdict}${presentation.verdictGate ? " (report ready; only the final verdict gate did not pass)" : ""}`
			: `status ${summary.semanticStatus}`;
		const failed =
			run.status !== "completed" && !presentation?.verdictGate
				? ` (${run.taskSummary.failed} failed, ${run.taskSummary.interrupted} interrupted of ${run.taskSummary.total} tasks)`
				: "";
		const report = reportPaths.length
			? `, report ${reportPaths.join(", ")}`
			: "";
		return {
			runId: run.runId,
			...(run.name ? { name: run.name } : {}),
			status: run.status,
			terminal: true,
			...(presentation?.verdict ? { verdict: presentation.verdict } : {}),
			...(presentation?.verdictGate ? { verdictGate: true as const } : {}),
			reportPaths,
			pendingApprovals: 0,
			text: `${label} finished — ${outcome}${failed}${report}. Details: ${hints.status(run.runId)}`,
		};
	}
	const approvals = await pendingDynamicApprovals(cwd, run).catch(() => []);
	const text = approvals.length
		? `${label} is waiting for the user's approval of dynamic controller ${approvals.map((approval) => approval.controllerSpecId).join(", ")}. Show the question with ${hints.status(run.runId)}; answer only after the user decides: ${hostApproveHint(host, run.runId, approvals[0]!.requestId)}`
		: `${label} is blocked and needs the user (${run.taskSummary.blocked} blocked tasks). Inspect: ${hints.inspectFailures(run.runId)}; resume after the cause is fixed: ${hints.resume(run.runId)}`;
	return {
		runId: run.runId,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		terminal: false,
		reportPaths: [],
		pendingApprovals: approvals.length,
		text,
	};
}

/**
 * `notify-check`: report the runs of `cwd` that settled since the last check, each settled state
 * once. Empty when the project has no runs (nothing is written then).
 */
export async function notifyCheck(
	cwd: string,
	options: {
		host?: WorkflowHostId;
		now?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<{ data: NotifyCheckData; text: string }> {
	const now = options.now ?? Date.now();
	const host = options.host ?? "cli";
	const empty = { data: { notifications: [], deferred: 0 }, text: "" };
	const entries = (await readProjectRunEntries(cwd)).filter(
		(entry) => !entry.parentRunId,
	);
	if (entries.length === 0) return empty;
	const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, true);
	if (!dir) return empty;
	const since = await readBaseline(dir, now);
	const existing = new Set(await readdir(dir).catch(() => [] as string[]));
	const candidates = entries
		.filter((entry) => {
			const updated = Date.parse(entry.updatedAt);
			return !Number.isFinite(updated) || updated >= since;
		})
		.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	const notifications: RunNotification[] = [];
	let deferred = 0;
	for (const entry of candidates) {
		const run = await readRunRecord(cwd, entry.runId).catch(() => undefined);
		if (!run || run.parentRunId || !isSettledRun(run)) continue;
		const updated = Date.parse(run.updatedAt);
		if (Number.isFinite(updated) && updated < since) continue;
		if (existing.has(markerName(run))) continue;
		if (notifications.length >= NOTIFY_CHECK_MAX_RUNS) {
			deferred += 1;
			continue;
		}
		const notification = await describe(cwd, run, host);
		if (!(await claimMarker(dir, run, "notify-check", now))) continue;
		notifications.push(notification);
	}
	await pruneMarkers(cwd, dir);
	const redact = hostTextRedactor(options.env ?? process.env);
	for (const notification of notifications)
		notification.text = redact(notification.text);
	const lines = notifications.map((notification) => notification.text);
	if (deferred > 0)
		lines.push(
			`agent-workflow: ${deferred} more finished run(s); run notify-check again or list them with ${host === "pi" ? "/aw status" : host === "cli" ? "agent-workflow status" : "workflow_status {}"}.`,
		);
	return { data: { notifications, deferred }, text: lines.join("\n") };
}
