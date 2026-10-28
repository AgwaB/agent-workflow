// New in agent-workflow (WP18b): retention of the executor adapters' durable attempt state. Every
// adapter writes one record per attempt under `<stateDir>/attempts/` (Claude: `<h>.json` plus an
// `<h>/` files dir when the runtime gave no artifactsDir; Codex: `<h>.json`, `<h>.events.jsonl`
// and an `<h>.log/` dir; Pi: `<h>.json`, its raw stream under `<stateDir>/runs/<h>/` without an
// artifactsDir) and nothing removed them (live bundles 4/4b: Claude 56 → 112 records, Codex 354
// entries). Terminal attempts whose record is older than the retention window are removed with
// their companions; records of non-terminal attempts, unreadable records and anything newer stay.
// Kept-session ownership records (`<stateDir>/sessions/`) are not touched: releasing a session
// already forgets its record, and an unreleased one is the evidence that allows deleting it.
import {
	lstat,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Terminal attempt records older than this are pruned (7 days). */
export const ADAPTER_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Background pruning on submit runs at most this often per state dir (6 h). */
export const ADAPTER_STATE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_STAMP_FILE = ".prune-stamp";

/** An adapter's view of one parsed attempt record. */
export interface AttemptRecordClass {
	/** The attempt can never progress again (finished, revoked, or its process is gone). */
	terminal: boolean;
	/** Record time (ms); the file mtime is used when absent, and the later of both counts. */
	updatedAtMs?: number;
	/** More per-attempt paths to remove with the record; only paths inside the state dir count. */
	extraPaths?: string[];
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
		removedPaths: [],
		errors: [],
	};
	let entries: string[];
	try {
		entries = await readdir(attemptsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			summary.errors.push(`${attemptsDir}: ${String(error)}`);
		return summary;
	}
	const remove = async (path: string) => {
		if (!isInside(stateDir, path)) return;
		if ((await mtimeMs(path)) === undefined) return;
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
		await remove(recordPath);
		summary.prunedRecords += 1;
	}
	// Orphans: companions of an already removed record, interrupted temp files.
	for (const name of entries) {
		if (name.endsWith(".json")) continue;
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
