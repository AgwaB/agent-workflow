// 2026-11-12 (owner: "Pi-specific — solve it generally"): the unfinished-run reminder of every host.
// It was Pi's session-start notice (src/hosts/pi/notices.ts, which now calls this with host "pi");
// Claude Code and Codex get the same reminder through `notify-check` in their prompt hook, and the
// dashboard dismisses through the same acknowledgements. One list, one dismissal, every host.
//
// Eligibility is the host API's notice list: top-level failed/interrupted runs and resumable
// executor-decision blocks, excluding mocks. Valid acknowledgements suppress a run; malformed
// sidecars suppress none. Runs older than seven days are skipped and at most five are listed.
// A run is reminded again after its status/update changes, after a stale acknowledgement, or six
// hours after the last reminder (the state file is shared by every host of the project, so one
// host's reminder quiets the others for that window). The workflow is named, degraded rendered
// failures are marked, and hints use the host's own commands.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stateBase } from "../core/state-location.js";
import { readRunRecord } from "../core/store.js";
import type { WorkflowHostId } from "../core/types.js";
import { listUnfinishedNoticesIgnoringInvalidAcknowledgements } from "../core/workflow-notices.js";
import type { HostApiContext } from "./api.js";
import { hostCommandHints } from "./hints.js";
import type { HostResult } from "./types.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 5;
export const UNFINISHED_REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = "unfinished-notices.json";

interface ListedNotice {
	runId: string;
	status: string;
	updatedAt: string;
	sha256?: string;
}

interface ListedAcknowledgement {
	runId: string;
	acknowledgedAt: string;
	active: boolean;
}

interface NoticeState {
	status?: string;
	updatedAt?: string;
	lastNotifiedAt?: string;
}

export interface UnfinishedNoticeApi {
	noticesAction(
		ctx: HostApiContext,
		request: { argv: string[] },
	): Promise<Pick<HostResult<unknown>, "data">>;
}

function noticesFromData(data: unknown): {
	notices: ListedNotice[];
	acknowledgements: ListedAcknowledgement[];
} {
	const value = (data ?? {}) as {
		notices?: unknown;
		acknowledgements?: unknown;
	};
	const notices = Array.isArray(value.notices)
		? (value.notices as ListedNotice[]).filter(
				(entry) =>
					typeof entry?.runId === "string" &&
					typeof entry.status === "string" &&
					typeof entry.updatedAt === "string",
			)
		: [];
	const acknowledgements = Array.isArray(value.acknowledgements)
		? (value.acknowledgements as ListedAcknowledgement[]).filter(
				(entry) => typeof entry?.runId === "string",
			)
		: [];
	return { notices, acknowledgements };
}

async function readState(file: string): Promise<Record<string, NoticeState>> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as {
			notices?: unknown;
		};
		if (
			!parsed.notices ||
			typeof parsed.notices !== "object" ||
			Array.isArray(parsed.notices)
		)
			return {};
		const state: Record<string, NoticeState> = {};
		for (const [runId, entry] of Object.entries(parsed.notices)) {
			if (entry && typeof entry === "object" && !Array.isArray(entry))
				state[runId] = entry as NoticeState;
		}
		return state;
	} catch {
		return {};
	}
}

/** How the reminder tells a host to dismiss a run (its own command, with the exact state). */
function dismissHint(host: WorkflowHostId): string {
	if (host === "pi")
		return "/aw notices acknowledge <run> --state <sha256> --reason <text>";
	if (host === "claude-code" || host === "codex" || host === "generic")
		return 'workflow_notices {"action":"acknowledge","runId":"<run>","state":"<sha256>","reason":"<text>"}';
	return "agent-workflow notices acknowledge <run> --state <sha256> --reason <text>";
}

/**
 * The reminder text for this host now, or undefined when nothing needs one. Records the reminded
 * runs (and `exclude`: runs this host just reported another way, e.g. notify-check's completion
 * line) so a reminder within six hours stays quiet about unchanged runs.
 */
export async function unfinishedRunReminder(
	api: UnfinishedNoticeApi,
	ctx: HostApiContext,
	nowMs: number,
	options: {
		host?: WorkflowHostId;
		exclude?: Iterable<string>;
		/** Only record `exclude` (and print nothing): a check that still has reports queued. */
		recordOnly?: boolean;
	} = {},
): Promise<string | undefined> {
	const host = options.host ?? ctx.host ?? "cli";
	const hints = hostCommandHints(host);
	const exclude = new Set(options.exclude ?? []);
	// Malformed or invalid acknowledgements never suppress notices. The strict list
	// refuses them, so retry treating them as no acknowledgements.
	const data = await api
		.noticesAction(ctx, { argv: ["list"] })
		.then((listed) => listed.data)
		.catch(async (error: unknown) => {
			const lenient =
				await listUnfinishedNoticesIgnoringInvalidAcknowledgements(
					ctx.cwd,
				).catch(() => undefined);
			if (!lenient) throw error;
			return lenient;
		});
	const { notices, acknowledgements } = noticesFromData(data);
	if (notices.length === 0) return undefined;
	const acknowledged = new Map(
		acknowledgements.map((entry) => [entry.runId, entry]),
	);
	const candidates = notices.filter((run) => {
		if (acknowledged.get(run.runId)?.active) return false;
		const updatedAtMs = Date.parse(run.updatedAt);
		return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= MAX_AGE_MS;
	});
	if (candidates.length === 0) return undefined;

	const dir = join(stateBase(ctx.cwd), ".agent-workflow", "workflows");
	const file = join(dir, STATE_FILE);
	const state = await readState(file);
	const remember = (run: ListedNotice) => {
		state[run.runId] = {
			status: run.status,
			updatedAt: run.updatedAt,
			lastNotifiedAt: new Date(nowMs).toISOString(),
		};
	};
	const needing: ListedNotice[] = [];
	let changed = false;
	for (const run of candidates) {
		if (exclude.has(run.runId)) {
			remember(run);
			changed = true;
			continue;
		}
		if (options.recordOnly) continue;
		const entry = state[run.runId];
		const lastNotifiedMs = Date.parse(entry?.lastNotifiedAt ?? "");
		const unchanged =
			entry !== undefined &&
			entry.status === run.status &&
			(entry.updatedAt ?? "") === run.updatedAt;
		const staleAck = acknowledged.get(run.runId);
		const ackChangedSinceNotice =
			staleAck !== undefined &&
			!(lastNotifiedMs > Date.parse(staleAck.acknowledgedAt));
		if (
			unchanged &&
			!ackChangedSinceNotice &&
			Number.isFinite(lastNotifiedMs) &&
			nowMs - lastNotifiedMs < UNFINISHED_REMINDER_INTERVAL_MS
		)
			continue;
		needing.push(run);
		remember(run);
		changed = true;
	}
	if (!changed) return undefined;

	const listedIds = new Set(notices.map((run) => run.runId));
	for (const [runId, entry] of Object.entries(state)) {
		const lastNotifiedMs = Date.parse(entry.lastNotifiedAt ?? "");
		if (
			!listedIds.has(runId) ||
			!Number.isFinite(lastNotifiedMs) ||
			lastNotifiedMs < nowMs - MAX_AGE_MS
		)
			delete state[runId];
	}
	await mkdir(dir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify({ notices: state }, null, 2)}\n`);
	await rename(temp, file);
	if (needing.length === 0) return undefined;

	// Name the workflow and mark failed runs with degraded rendered output.
	// Unreadable run records add no detail.
	const lines = await Promise.all(
		needing.slice(0, MAX_RUNS).map(async (run) => {
			const record = await readRunRecord(ctx.cwd, run.runId).catch(
				() => undefined,
			);
			const name = record?.name ? `${record.name} ` : "";
			const status = record?.degradation?.finalOutputRendered
				? `${run.status} (final rendered — degraded)`
				: run.status;
			const state =
				host === "pi" || !run.sha256 ? "" : ` [state ${run.sha256}]`;
			return `- ${name}${run.runId}: ${status} (updated ${run.updatedAt})${state} — ${hints.resume(run.runId)}`;
		}),
	);
	if (needing.length > MAX_RUNS)
		lines.push(
			`- … and ${needing.length - MAX_RUNS} more (${host === "pi" ? "/aw notices list" : host === "cli" ? "agent-workflow notices list" : 'workflow_notices {"action":"list"}'})`,
		);
	return [
		`Unfinished agent-workflow run${needing.length > 1 ? "s" : ""} in this project:`,
		...lines,
		`Inspect with ${hints.inspectFailures("<run>")}; silence one with ${dismissHint(host)}${host === "pi" ? "" : " or dismiss it in the dashboard (Maintenance)"}.`,
	].join("\n");
}
