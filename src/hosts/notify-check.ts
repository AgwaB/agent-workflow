import { stateBase } from "../core/state-location.js";
// New in agent-workflow (WP36, owner decision E2: the common completion mechanism): `agent-workflow
// notify-check` prints one short line per run of this project that finished (or now needs the
// user) since the last check — "workflow X finished — verdict Y, report Z" — and prints each
// settled state once. Hosts without a completion push call it from a hook that adds its output to
// the model's context (Claude Code's `UserPromptSubmit`, shipped by the plugin; Codex's
// `UserPromptSubmit`, configured by the user; host UX investigation record), so a run that
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
// WP42 (review round 1, finding 4): the plugin's prompt hook only reads in shell (a `find -newer`
// against its stamp); the stamp itself (`hook-<host>.stamp`) is written here (`--stamp <name>`),
// through the same contained directory as the receipts, after a successful check, with the check's
// start time as its mtime (a `run.json` changed during the check is looked at again next time).
// A check that deferred runs (the cap of five) removes the stamp instead (finding 5), so the next
// prompt checks again until the backlog is drained.
import { createHash, randomBytes } from "node:crypto";
import {
	access,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
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

/**
 * 2026-11-05: the run's current settled state was already reported (by a check, a Monitor or
 * `workflow_wait`): a follower of this one run has nothing left to wait for. False while it runs.
 */
export async function runSettledStateSeen(
	cwd: string,
	runId: string,
): Promise<boolean> {
	const run = await readRunRecord(cwd, runId).catch(() => undefined);
	if (!run || !isSettledRun(run)) return false;
	const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, false);
	if (!dir) return false;
	const existing = new Set(await readdir(dir).catch(() => [] as string[]));
	return existing.has(markerName(run));
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
		// Receipts, and (2026-11-05) the session links of runs that are gone.
		const match =
			/^(.+)\.[0-9a-f]{24}\.json$/u.exec(name) ??
			/^session-[A-Za-z0-9_-]+\.(.+)\.link$/u.exec(name);
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

const STAMP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/**
 * 2026-11-05 (owner: wait in code, wake the host once): the Claude Code plugin's completion monitor
 * runs `notify-check --follow --session <id>` for its session (`CLAUDE_CODE_SESSION_ID`). It reports
 * only the runs that session launched — the MCP server records `session-<id>.<runId>.link` after a
 * launch — and refreshes `monitor-<id>.stamp` on every check, so the server can tell that this
 * session has a live monitor and let the agent end its turn instead of calling workflow_wait.
 * Another session's monitor in the same project never takes the run.
 */
const HOST_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/u;
/** A monitor refreshes its stamp every check (5 s by default); older means it is gone. */
export const MONITOR_ALIVE_MS = 20_000;

export function isHostSessionId(value: unknown): value is string {
	return typeof value === "string" && HOST_SESSION_PATTERN.test(value);
}

function sessionLinkName(session: string, runId: string): string {
	return `session-${session}.${runId}.link`;
}

function monitorStampName(session: string): string {
	return `monitor-${session}`;
}

/** The MCP server, after a launch: this host session started the run (best effort). */
export async function recordRunHostSession(
	cwd: string,
	runId: string,
	session: string,
): Promise<void> {
	if (!isHostSessionId(session) || !isSafeRunId(runId)) return;
	try {
		const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, true);
		if (!dir) return;
		// O_EXCL never follows a symlink at the link path.
		const handle = await open(
			join(dir, sessionLinkName(session, runId)),
			"wx",
			0o600,
		);
		await handle.close();
	} catch {
		// Present already, or no state directory: the run is then reported by the prompt hook.
	}
}

/** The host sessions that launched the run (their links). */
export async function runHostSessions(
	cwd: string,
	runId: string,
): Promise<string[]> {
	if (!isSafeRunId(runId)) return [];
	const dir = await containedProjectStateDir(
		cwd,
		NOTIFY_CHECK_DIR,
		false,
	).catch(() => undefined);
	if (!dir) return [];
	const suffix = `.${runId}.link`;
	return (await readdir(dir).catch(() => [] as string[]))
		.filter((name) => name.startsWith("session-") && name.endsWith(suffix))
		.map((name) => name.slice("session-".length, -suffix.length))
		.filter(isHostSessionId)
		.sort();
}

/** 2026-11-05: how long a launch waits for a monitor that starts with the project's first run. */
export const MONITOR_FIRST_RUN_WAIT_MS = 5_000;

/**
 * 2026-11-05 (the first run of a project): the plugin's monitor waits in its shell until
 * `<CLAUDE_PROJECT_DIR>/.agent-workflow/workflows` exists, so it has no stamp before the project's
 * first run. True when that directory holds no run but `runId`: this launch has just created it,
 * and the session's monitor, if it has one, starts at its next shell poll (2 s).
 */
export async function monitorStartsWithRun(
	projectDir: string,
	runId: string,
): Promise<boolean> {
	const entries = await readdir(
		join(stateBase(projectDir), ".agent-workflow", "workflows"),
		{
			withFileTypes: true,
		},
	).catch(() => undefined);
	const runs = entries?.filter(
		(entry) => entry.isDirectory() && !entry.name.startsWith("."),
	);
	return runs?.length === 1 && runs[0]?.name === runId;
}

/** Waits up to `timeoutMs` for this session's monitor stamp (polls every 200 ms). */
export async function awaitHostSessionMonitor(
	cwd: string,
	session: string,
	timeoutMs = MONITOR_FIRST_RUN_WAIT_MS,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!signal?.aborted) {
		if (await hostSessionMonitorAlive(cwd, session)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((done) => setTimeout(done, 200));
	}
	return false;
}

/** This session's completion monitor checked within MONITOR_ALIVE_MS. */
export async function hostSessionMonitorAlive(
	cwd: string,
	session: string,
	now = Date.now(),
): Promise<boolean> {
	if (!isHostSessionId(session)) return false;
	try {
		const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, false);
		if (!dir) return false;
		const info = await stat(join(dir, `${monitorStampName(session)}.stamp`));
		return now - info.mtimeMs <= MONITOR_ALIVE_MS;
	} catch {
		return false;
	}
}

/** WP42: a valid `--stamp` name (the hook passes `hook-<host>`); the file is `<name>.stamp`. */
export function assertNotifyStampName(name: string): void {
	if (!STAMP_NAME_PATTERN.test(name))
		throw new Error(
			`invalid notify-check stamp name ${JSON.stringify(name)}: use 1-64 characters [A-Za-z0-9_-], starting with a letter or digit`,
		);
}

/**
 * WP42: replace `<dir>/<name>.stamp` with an empty file whose mtime is `at`: created exclusively
 * (O_EXCL never follows a symlink), timed through its own handle, renamed into the contained
 * directory (a rename replaces a symlink at the stamp path, never its target).
 */
async function writeStamp(
	dir: string,
	name: string,
	at: number,
): Promise<void> {
	const temporary = join(
		dir,
		`.${name}.stamp.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			const time = new Date(at);
			await handle.utimes(time, time);
		} finally {
			await handle.close();
		}
		await rename(temporary, join(dir, `${name}.stamp`));
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
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
 * once. Empty when the project has no runs (nothing is written then, except the `stamp`).
 * WP42: `stamp` (the prompt hook's `--stamp hook-<host>`) is written after the check succeeded.
 */
export async function notifyCheck(
	cwd: string,
	options: {
		host?: WorkflowHostId;
		now?: number;
		env?: NodeJS.ProcessEnv;
		stamp?: string;
		/** 2026-11-05: only this run. */
		runId?: string;
		/** 2026-11-05: only the runs this host session launched; refreshes its monitor stamp. */
		session?: string;
	} = {},
): Promise<{ data: NotifyCheckData; text: string }> {
	if (options.stamp !== undefined) assertNotifyStampName(options.stamp);
	if (options.session !== undefined && !isHostSessionId(options.session))
		throw new Error(
			`invalid host session id ${JSON.stringify(options.session)}`,
		);
	// The stamp's mtime: the wall clock when the check started (the hook compares run.json mtimes).
	const startedAt = Date.now();
	if (options.session !== undefined) {
		const dir = await containedProjectStateDir(
			cwd,
			NOTIFY_CHECK_DIR,
			true,
		).catch(() => undefined);
		if (dir)
			await writeStamp(dir, monitorStampName(options.session), startedAt).catch(
				() => undefined,
			);
	}
	const checked = await checkOnce(cwd, options);
	if (options.stamp !== undefined)
		await updateStamp(cwd, options.stamp, checked.data.deferred > 0, startedAt);
	return checked;
}

/**
 * The hook's stamp after a check. WP42 (review round 1, finding 5): runs left for later (over
 * NOTIFY_CHECK_MAX_RUNS) keep the hook off its idle fast path: no stamp until the backlog is
 * drained (their run.json files may never change again). WP42 (review round 2, N2): best effort,
 * after the receipts were claimed, so it never discards the claimed notifications: a failed
 * replacement removes the stamp instead (the hook's fast path needs a regular stamp file); when
 * even that fails, a warning goes to stderr. Never a recursive removal at the stamp path.
 */
async function updateStamp(
	cwd: string,
	name: string,
	deferred: boolean,
	startedAt: number,
): Promise<void> {
	let dir: string | undefined;
	try {
		dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, true);
		if (!dir) return;
		if (!deferred) {
			await writeStamp(dir, name, startedAt);
			return;
		}
	} catch {
		// Fall through: invalidate the stamp.
	}
	if (!dir) return;
	const file = join(dir, `${name}.stamp`);
	try {
		await rm(file, { force: true });
	} catch (error) {
		process.stderr.write(
			`agent-workflow notify-check: could not update or remove the stamp ${file} (${error instanceof Error ? error.message : String(error)}); remove it so the prompt hook keeps checking\n`,
		);
	}
}

async function checkOnce(
	cwd: string,
	options: {
		host?: WorkflowHostId;
		now?: number;
		env?: NodeJS.ProcessEnv;
		runId?: string;
		session?: string;
	},
): Promise<{ data: NotifyCheckData; text: string }> {
	const now = options.now ?? Date.now();
	const host = options.host ?? "cli";
	const empty = { data: { notifications: [], deferred: 0 }, text: "" };
	const entries = (await readProjectRunEntries(cwd)).filter(
		(entry) =>
			!entry.parentRunId &&
			(options.runId === undefined || entry.runId === options.runId),
	);
	if (entries.length === 0) return empty;
	const dir = await containedProjectStateDir(cwd, NOTIFY_CHECK_DIR, true);
	if (!dir) return empty;
	const since = await readBaseline(dir, now);
	const existing = new Set(await readdir(dir).catch(() => [] as string[]));
	const candidates = entries
		.filter((entry) => {
			if (
				options.session !== undefined &&
				!existing.has(sessionLinkName(options.session, entry.runId))
			)
				return false;
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
