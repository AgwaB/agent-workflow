// New in agent-workflow (WP18b): retention of the executor adapters' durable attempt state. Every
// adapter writes one record per attempt under `<stateDir>/attempts/` (Claude: `<h>.json` plus an
// `<h>/` files dir when the runtime gave no artifactsDir; Codex: `<h>.json`, `<h>.events.jsonl`
// and an `<h>.log/` dir; Pi: `<h>.json`, its raw stream under `<stateDir>/runs/<h>/` without an
// artifactsDir) and nothing removed them (live bundles 4/4b: Claude 56 → 112 records, Codex 354
// entries). Terminal attempts whose record is older than the retention window are removed with
// their companions; records of non-terminal attempts, unreadable records and anything newer stay.
// Kept-session ownership records (`<stateDir>/sessions/`) are not touched: releasing a session
// already forgets its record, and an unreleased one is the evidence that allows deleting it.
//
// WP19 (stage-2 review #2): pruning never destroys launch evidence. A record of an attempt that was
// launched (the adapter's classify says `launched`) is replaced by a compact tombstone at the same
// path (`agent-workflow-attempt-tombstone-v1`: attemptKey, terminal outcome when known, finishedAt,
// prunedAt; ~250 bytes) instead of being removed, and its bulky companions (raw stream, event log,
// files dir) go. Every adapter's attempt lookup reads a tombstone as "launched, record pruned":
// submit never relaunches that attemptKey (the exclusive first-record create still fails), and
// reconcile answers `unknown` with the known outcome in its reason (the runtime records
// failed/needs_decision, never not_started). Only never-launched records (`revoked`) are removed.
// Tombstones are never removed by retention (they are counted in `tombstones`): one small file per
// launched attempt, which is the price of "an attempt that ran is never reported as absent".
import {
	lstat,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Terminal attempt records older than this are pruned (7 days). */
export const ADAPTER_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Background pruning on submit runs at most this often per state dir (6 h). */
export const ADAPTER_STATE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_STAMP_FILE = ".prune-stamp";

/** WP19: schema of the compact record that replaces a pruned launched-attempt record. */
export const ATTEMPT_TOMBSTONE_SCHEMA = "agent-workflow-attempt-tombstone-v1";

export interface AttemptTombstone {
	schema: typeof ATTEMPT_TOMBSTONE_SCHEMA;
	attemptKey: string | null;
	/** Terminal outcome when the adapter recorded one (`completed`, `failed`, `exit 0`, ...). */
	outcome: string | null;
	/** When the attempt finished (or its record was last updated). */
	finishedAt: string | null;
	prunedAt: string;
}

/** The tombstone when `value` is one. */
export function parseAttemptTombstone(
	value: unknown,
): AttemptTombstone | undefined {
	const record = value as Partial<AttemptTombstone> | null;
	if (
		record === null ||
		typeof record !== "object" ||
		record.schema !== ATTEMPT_TOMBSTONE_SCHEMA
	)
		return undefined;
	return {
		schema: ATTEMPT_TOMBSTONE_SCHEMA,
		attemptKey:
			typeof record.attemptKey === "string" ? record.attemptKey : null,
		outcome: typeof record.outcome === "string" ? record.outcome : null,
		finishedAt:
			typeof record.finishedAt === "string" ? record.finishedAt : null,
		prunedAt: typeof record.prunedAt === "string" ? record.prunedAt : "",
	};
}

/**
 * Why a tombstoned attempt is ambiguous: it was launched, its record was pruned, so it is never
 * reported absent (reconcile `unknown`, no relaunch).
 */
export function attemptTombstoneReason(tombstone: AttemptTombstone): string {
	return `attempt was launched and its record was pruned by retention${
		tombstone.prunedAt ? ` at ${tombstone.prunedAt}` : ""
	} (last known outcome: ${tombstone.outcome ?? "unknown"}${
		tombstone.finishedAt ? `, ${tombstone.finishedAt}` : ""
	}); not relaunched, needs an owner decision`;
}

/** An adapter's view of one parsed attempt record. */
export interface AttemptRecordClass {
	/** The attempt can never progress again (finished, revoked, or its process is gone). */
	terminal: boolean;
	/** Record time (ms); the file mtime is used when absent, and the later of both counts. */
	updatedAtMs?: number;
	/** More per-attempt paths to remove with the record; only paths inside the state dir count. */
	extraPaths?: string[];
	/**
	 * WP19: the attempt was launched (a process ran). Its record is replaced by a tombstone instead
	 * of being removed. Only never-launched attempts (e.g. `revoked`) may leave no trace.
	 */
	launched?: boolean;
	/** WP19: terminal outcome kept in the tombstone, when the record knows it. */
	outcome?: string;
}

export interface AdapterStatePruneOptions {
	/** Adapter state dir (`<home>/executors/<id>`). */
	stateDir: string;
	/**
	 * Classify a parsed record whose file is `<attempts>/<base>.json`; `undefined` = unrecognized
	 * (kept).
	 */
	classify: (record: unknown, base: string) => AttemptRecordClass | undefined;
	retentionMs?: number;
	nowMs?: number;
	/** Report what would be removed without removing it. */
	dryRun?: boolean;
}

export interface AdapterStatePruneSummary {
	stateDir: string;
	dryRun: boolean;
	retentionMs: number;
	/** Attempt records looked at. */
	records: number;
	/** Terminal attempt records removed (or, in a dry run, that would be removed). */
	prunedRecords: number;
	/** Records kept because the attempt is not terminal (or the record is unreadable). */
	keptActive: number;
	/** WP19: launched-attempt records replaced by a tombstone in this pass (subset of prunedRecords). */
	tombstoned: number;
	/** WP19: tombstones found (kept forever, they are the launch evidence). */
	tombstones: number;
	/** Every removed (or removable) path, records and companions and stale orphans. */
	removedPaths: string[];
	errors: string[];
}

/** True while `pid` names a live process (EPERM counts as alive). */
export function processAlive(pid: number | null | undefined): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
		return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

async function mtimeMs(path: string): Promise<number | undefined> {
	try {
		return (await lstat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * WP19 round 7: a file or directory an adapter writes under `attempts/` — the attemptKey digest
 * (hex: Claude 40, Codex 32, Pi 64 characters) alone (per-attempt directory) or with a companion
 * suffix (`.events.jsonl`, `.log`) or an atomic-write temp suffix (`.json.<pid>[.<hex>].tmp`).
 */
const ADAPTER_ATTEMPT_FILE =
	/^[0-9a-f]{32,64}(?:\.events\.jsonl|\.log|\.json\.\d+(?:\.[0-9a-f]+)?\.tmp)?$/u;

/**
 * Remove terminal attempt records older than the retention window, with their companion files
 * and dirs, and stale orphans (companions or temp files without a record, older than the window).
 */
export async function pruneAdapterAttemptState(
	options: AdapterStatePruneOptions,
): Promise<AdapterStatePruneSummary> {
	const retentionMs = options.retentionMs ?? ADAPTER_STATE_RETENTION_MS;
	const nowMs = options.nowMs ?? Date.now();
	const cutoff = nowMs - retentionMs;
	const dryRun = options.dryRun === true;
	const stateDir = resolve(options.stateDir);
	const attemptsDir = join(stateDir, "attempts");
	const summary: AdapterStatePruneSummary = {
		stateDir,
		dryRun,
		retentionMs,
		records: 0,
		prunedRecords: 0,
		keptActive: 0,
		tombstoned: 0,
		tombstones: 0,
		removedPaths: [],
		errors: [],
	};
	// WP19 (review #3): containment is physical, not lexical. The state dir's real path is the
	// root; `attempts/` must be a real directory (not a symlink), and every path removed must have
	// only real directories between the root and itself, with a parent whose real path is still
	// inside the root. A symlinked ancestor (`attempts/`, Pi `runs/`, a per-attempt dir) is refused.
	let stateReal: string;
	try {
		stateReal = await realpath(stateDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			summary.errors.push(`${stateDir}: ${String(error)}`);
		return summary;
	}
	const attemptsInfo = await lstat(attemptsDir).catch(() => undefined);
	if (!attemptsInfo) return summary;
	if (attemptsInfo.isSymbolicLink() || !attemptsInfo.isDirectory()) {
		summary.errors.push(
			`${attemptsDir}: refused, not a real directory inside the state dir (symlink or other file type)`,
		);
		return summary;
	}
	let entries: string[];
	try {
		entries = await readdir(attemptsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			summary.errors.push(`${attemptsDir}: ${String(error)}`);
		return summary;
	}
	const physicallyInside = async (path: string): Promise<string | true> => {
		if (!isInside(stateDir, path)) return "outside the state dir";
		const segments = relative(stateDir, resolve(path)).split(sep);
		let current = stateDir;
		for (const segment of segments.slice(0, -1)) {
			current = join(current, segment);
			const info = await lstat(current).catch(() => undefined);
			if (!info) return `ancestor ${current} is gone`;
			if (info.isSymbolicLink()) return `ancestor ${current} is a symlink`;
			if (!info.isDirectory()) return `ancestor ${current} is not a directory`;
		}
		const parentReal = await realpath(dirname(resolve(path))).catch(
			() => undefined,
		);
		if (parentReal === undefined) return "parent is gone";
		if (parentReal !== stateReal && !isInside(stateReal, parentReal))
			return `parent resolves outside the state dir (${parentReal})`;
		return true;
	};
	const remove = async (path: string) => {
		if ((await mtimeMs(path)) === undefined) return;
		const contained = await physicallyInside(path);
		if (contained !== true) {
			summary.errors.push(`${path}: refused, ${contained}`);
			return;
		}
		summary.removedPaths.push(path);
		if (dryRun) return;
		try {
			await rm(path, { recursive: true, force: true });
		} catch (error) {
			summary.errors.push(`${path}: ${String(error)}`);
		}
	};
	const recordBases = new Set(
		entries
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length)),
	);
	for (const base of recordBases) {
		summary.records += 1;
		const recordPath = join(attemptsDir, `${base}.json`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(recordPath, "utf8"));
		} catch {
			summary.keptActive += 1;
			continue;
		}
		if (parseAttemptTombstone(parsed)) {
			summary.tombstones += 1;
			continue;
		}
		const verdict = options.classify(parsed, base);
		if (!verdict?.terminal) {
			summary.keptActive += 1;
			continue;
		}
		const fileMs = (await mtimeMs(recordPath)) ?? nowMs;
		const at = Math.max(fileMs, verdict.updatedAtMs ?? 0);
		if (at > cutoff) continue;
		for (const companion of [
			join(attemptsDir, `${base}.events.jsonl`),
			join(attemptsDir, `${base}.log`),
			join(attemptsDir, base),
			...(verdict.extraPaths ?? []),
		])
			await remove(companion);
		summary.prunedRecords += 1;
		if (verdict.launched) {
			// WP19: the launch evidence stays as a tombstone (companions first, so a crash in
			// between leaves the full record, which the next pass tombstones).
			summary.tombstoned += 1;
			if (dryRun) continue;
			const key = (parsed as { attemptKey?: unknown } | null)?.attemptKey;
			const tombstone: AttemptTombstone = {
				schema: ATTEMPT_TOMBSTONE_SCHEMA,
				attemptKey: typeof key === "string" ? key : null,
				outcome: verdict.outcome ?? null,
				finishedAt: new Date(at).toISOString(),
				prunedAt: new Date(nowMs).toISOString(),
			};
			try {
				const temp = `${recordPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
				await writeFile(temp, `${JSON.stringify(tombstone)}\n`, {
					mode: 0o600,
				});
				await rename(temp, recordPath);
			} catch (error) {
				summary.errors.push(`${recordPath}: ${String(error)}`);
			}
			continue;
		}
		await remove(recordPath);
	}
	// Orphans: companions of an already removed record, interrupted temp files. WP19 round 7:
	// only names an adapter writes (hex attemptKey digest + a known suffix) are candidates;
	// anything else in `attempts/` (notes, other tools' files, directories) is never touched.
	for (const name of entries) {
		if (name.endsWith(".json")) continue;
		if (!ADAPTER_ATTEMPT_FILE.test(name)) continue;
		const base = name
			.replace(/\.events\.jsonl$/, "")
			.replace(/\.log$/, "")
			.replace(/\.json\.[^/]*\.tmp$/, "");
		if (recordBases.has(base) && !name.endsWith(".tmp")) continue;
		const path = join(attemptsDir, name);
		const at = await mtimeMs(path);
		if (at === undefined || at > cutoff) continue;
		await remove(path);
	}
	return summary;
}

/**
 * Prune in the background at most once per `ADAPTER_STATE_PRUNE_INTERVAL_MS` per state dir
 * (stamp file `<stateDir>/.prune-stamp`). Never throws and never blocks the caller; adapters call
 * it on submit.
 */
export function schedulePeriodicAdapterStatePrune(
	options: Omit<AdapterStatePruneOptions, "dryRun">,
): void {
	void (async () => {
		const stamp = join(resolve(options.stateDir), PRUNE_STAMP_FILE);
		const nowMs = options.nowMs ?? Date.now();
		const last = await stat(stamp).then(
			(info) => info.mtimeMs,
			() => undefined,
		);
		if (last !== undefined && nowMs - last < ADAPTER_STATE_PRUNE_INTERVAL_MS)
			return;
		try {
			const now = new Date(nowMs);
			await utimes(stamp, now, now).catch(async () => {
				await writeFile(stamp, "", { mode: 0o600 });
			});
		} catch {
			return; // no state dir yet: nothing to prune
		}
		await pruneAdapterAttemptState(options);
	})().catch(() => undefined);
}
