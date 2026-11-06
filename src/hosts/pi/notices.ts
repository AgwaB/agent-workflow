import { stateBase } from "../../core/state-location.js";
// Session-start notices use host API eligibility: top-level failed/interrupted runs
// and resumable executor-decision blocks, excluding mocks.
// Valid acknowledgements suppress notices; malformed sidecars suppress none. Skip runs
// older than seven days and list at most five. Re-notify on status/update changes,
// stale acknowledgements, or after six hours; prune notice state on write.
// Name the workflow, mark degraded rendered failures, and point hints at /aw.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readRunRecord } from "../../core/store.js";
import { listUnfinishedNoticesIgnoringInvalidAcknowledgements } from "../../core/workflow-notices.js";
import type { HostApiContext } from "../api.js";
import type { PiHostApi } from "./host.js";
import { AW_COMMAND } from "./names.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 5;
const DEDUPE_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = "unfinished-notices.json";

interface ListedNotice {
	runId: string;
	status: string;
	updatedAt: string;
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

function noticesFromData(data: {
	notices?: unknown;
	acknowledgements?: unknown;
}): {
	notices: ListedNotice[];
	acknowledgements: ListedAcknowledgement[];
} {
	const notices = Array.isArray(data.notices)
		? (data.notices as ListedNotice[]).filter(
				(entry) =>
					typeof entry?.runId === "string" &&
					typeof entry.status === "string" &&
					typeof entry.updatedAt === "string",
			)
		: [];
	const acknowledgements = Array.isArray(data.acknowledgements)
		? (data.acknowledgements as ListedAcknowledgement[]).filter(
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

/**
 * The notice text for this session start, or undefined when nothing needs a notice. Records the
 * notified runs so the next session within 6 hours stays quiet about unchanged runs.
 */
export async function unfinishedRunNotice(
	api: Pick<PiHostApi, "noticesAction">,
	ctx: HostApiContext,
	nowMs: number,
): Promise<string | undefined> {
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
	const needing: ListedNotice[] = [];
	for (const run of candidates) {
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
			nowMs - lastNotifiedMs < DEDUPE_MS
		)
			continue;
		needing.push(run);
		state[run.runId] = {
			status: run.status,
			updatedAt: run.updatedAt,
			lastNotifiedAt: new Date(nowMs).toISOString(),
		};
	}
	if (needing.length === 0) return undefined;

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
			return `- ${name}${run.runId}: ${status} (updated ${run.updatedAt}) — /${AW_COMMAND} resume ${run.runId}`;
		}),
	);
	if (needing.length > MAX_RUNS)
		lines.push(
			`- … and ${needing.length - MAX_RUNS} more (/${AW_COMMAND} notices list)`,
		);
	return [
		`Unfinished agent-workflow run${needing.length > 1 ? "s" : ""} in this project:`,
		...lines,
		`Inspect with /${AW_COMMAND} inspect <run> --failures; silence one with /${AW_COMMAND} notices acknowledge <run> --state <sha256> --reason <text>.`,
	].join("\n");
}
