// New in agent-workflow (WP2a-1). Zero-dependency replacement for the subset of
// `proper-lockfile` that @agwab/pi-subagent 0.7.2 src/artifacts/registry.ts used:
// `lock(path, { realpath: false, lockfilePath: path, stale: Number.MAX_SAFE_INTEGER,
// retries: { retries, factor: 1, minTimeout, maxTimeout, randomize: true } })`.
//
// Semantics kept:
// - the lock is an atomically created directory (`mkdir`, EEXIST = held);
// - a held lock is never stolen on elapsed time (stale stealing was disabled);
// - contention retries every `retryMs` up to `retries` times (the original
//   `retry` options randomized x1..x2 but capped at maxTimeout == minTimeout,
//   i.e. a fixed delay), then fails with `Lock file is already being held`
//   (`code: "ELOCKED"`), the same message/code proper-lockfile produced;
// - release removes the directory (ENOENT ignored);
// - locks still held when the process exits, or is terminated by SIGINT,
//   SIGTERM or SIGHUP, are removed (proper-lockfile used `signal-exit`).
//
// Not kept: the 1 s mtime refresh and the "compromised lock" crash.
//
// WP2c — owner-aware stealing. A SIGKILLed holder used to leave the directory
// behind forever (every later reconcile failed ELOCKED). Now:
// - the holder records itself inside the lock directory as
//   `owner-<token>.json` = { schema, token, pid, birthIdentity, host, acquiredAt }
//   (birth identity from process-identity.ts). The record is staged beside the
//   lock and renamed into the directory right after `mkdir`;
// - on contention the record is inspected. The lock is stolen only when the
//   owner is provably dead: same host, a birth identity was recorded, and
//   process identity says the pid is gone or now has a different birth identity
//   (pid reused). Anything else — no record, an unreadable or ambiguous record,
//   a record whose token does not match its file name (a steal in progress),
//   another host, no birth identity, an unknown liveness answer — is treated as
//   held, and the reason is appended to the ELOCKED message;
// - stealing never replaces the directory. The stealer atomically renames the
//   dead owner's uniquely named record `owner-<dead>.json` to
//   `owner-<mine>.json` inside the same directory, then renames its own staged
//   record over it. Owner tokens are never reused, so of several concurrent
//   stealers exactly one rename succeeds; the losers get ENOENT and retry
//   normally (they then see a live owner or a claim in progress). Because the
//   directory never disappears during a steal, a fresh `mkdir` cannot slip in
//   and create a second owner;
// - create (mkdir + record rename), claim (two renames) and release (unlink +
//   rmdir) use synchronous fs calls back to back. A `process.exit` (the durable
//   worker exits while a heartbeat may still be acquiring) can then never land
//   between them, so exit cleanup always sees either no lock or a recorded one.
//   With async calls an exit during an in-flight `mkdir` left an ownerless
//   directory that is never stolen.
// Residual: a holder SIGKILLed between `mkdir` and the record rename (two
// adjacent syscalls) leaves a lock with no owner record, which is never stolen
// (operator removal, as before WP2c).
//
// WP2b: release raises ECOMPROMISED only when another owner record replaced ours (a steal). A
// lock directory with no owner record at all is being removed from outside; release treats it
// as gone instead of failing (see releaseHeldLockSync).
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	captureProcessIdentity,
	inspectProcessIdentity,
} from "../process-identity.js";

export interface DirectoryLockOptions {
	/** Retry attempts after the first failed acquisition. */
	retries: number;
	/** Fixed delay between attempts. */
	retryMs: number;
}

export type ReleaseDirectoryLock = () => Promise<void>;

/** Schema id of the owner record inside a lock directory. */
export const DIRECTORY_LOCK_OWNER_SCHEMA = "agent-workflow-dir-lock-owner-v1";

export interface DirectoryLockOwner {
	schema: typeof DIRECTORY_LOCK_OWNER_SCHEMA;
	token: string;
	pid: number;
	/** process-identity birth identity; null when it could not be captured (never stolen). */
	birthIdentity: string | null;
	host: string;
	acquiredAt: string;
}

const OWNER_FILE = /^owner-([A-Za-z0-9_-]{1,64})\.json$/u;
/** Locks this process holds: lock directory → our owner record file name. */
const held = new Map<string, string>();
/** Staged owner records beside lock directories, removed at exit. */
const staging = new Set<string>();
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let cleanupInstalled = false;
let selfBirthIdentity: Promise<string | null> | undefined;

function ownBirthIdentity(): Promise<string | null> {
	selfBirthIdentity ??= captureProcessIdentity(process.pid).then(
		(identity) => identity.birthIdentity,
		() => null,
	);
	return selfBirthIdentity;
}

/**
 * Remove a lock this process holds: our record first, then the directory. A directory that no
 * longer holds our record is not ours any more and is left alone. Synchronous on purpose (see
 * the header).
 *
 * WP2b: our record missing is "not-ours" (a steal) only when another owner record is in the
 * directory — a steal always renames a record in, never leaves the directory without one. A
 * directory without any owner record is being removed from outside (prune, a test fixture
 * cleanup `rm -r` of the runs dir) or was just re-created by a new holder that has not renamed
 * its record in yet: either way nothing of ours is left to release ("gone"), and it is left
 * alone. Before WP2b this raised ECOMPROMISED, so a finalizer that had already published its
 * terminal events exited 1 when its run directory was removed concurrently.
 */
function releaseHeldLockSync(
	path: string,
	ownerFile: string,
): "released" | "gone" | "not-ours" {
	try {
		unlinkSync(join(path, ownerFile));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		let entries: string[];
		try {
			entries = readdirSync(path);
		} catch (readError) {
			if (errorCode(readError) === "ENOENT") return "gone";
			throw readError;
		}
		return entries.some((entry) => OWNER_FILE.test(entry))
			? "not-ours"
			: "gone";
	}
	rmSync(path, { recursive: true, force: true });
	return "released";
}

function removeHeldLocksSync(): void {
	for (const [path, ownerFile] of held) {
		try {
			releaseHeldLockSync(path, ownerFile);
		} catch {
			// Not removable; nothing else to do at exit.
		}
	}
	held.clear();
	for (const staged of staging) {
		try {
			unlinkSync(staged);
		} catch {
			// Already moved into a lock or removed.
		}
	}
	staging.clear();
}

function installCleanup(): void {
	if (cleanupInstalled) return;
	cleanupInstalled = true;
	process.once("exit", removeHeldLocksSync);
	for (const signal of CLEANUP_SIGNALS) {
		const onSignal = (): void => {
			removeHeldLocksSync();
			// Like signal-exit: when nobody else handles the signal, restore the
			// default disposition and re-raise it so the process still terminates.
			if (process.listeners(signal).length === 1) {
				process.removeListener(signal, onSignal);
				process.kill(process.pid, signal);
			}
		};
		process.on(signal, onSignal);
	}
}

function lockedError(
	path: string,
	reason: string | undefined,
): Error & { code: "ELOCKED"; file: string; reason?: string } {
	return Object.assign(
		new Error(
			reason === undefined
				? "Lock file is already being held"
				: `Lock file is already being held (${reason})`,
		),
		{
			code: "ELOCKED" as const,
			file: path,
			...(reason === undefined ? {} : { reason }),
		},
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

function ownerText(owner: DirectoryLockOwner): string {
	return `${JSON.stringify(owner)}\n`;
}

type OwnerVerdict =
	| { kind: "gone" }
	| { kind: "held"; reason: string }
	| { kind: "stale"; ownerFile: string; reason: string };

function parseOwner(
	text: string,
	expectedToken: string,
): DirectoryLockOwner | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return `owner record is unreadable: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return "owner record is unreadable: not an object";
	const owner = value as Partial<DirectoryLockOwner>;
	if (owner.schema !== DIRECTORY_LOCK_OWNER_SCHEMA)
		return "owner record is unreadable: unknown schema";
	if (owner.token !== expectedToken)
		return "owner record token does not match its file (claim in progress)";
	if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
		return "owner record is unreadable: invalid pid";
	if (typeof owner.host !== "string")
		return "owner record is unreadable: invalid host";
	if (owner.birthIdentity !== null && typeof owner.birthIdentity !== "string")
		return "owner record is unreadable: invalid birth identity";
	return owner as DirectoryLockOwner;
}

/** How long a "the owner is alive" answer is reused before process identity is asked again. */
const LIVE_OWNER_RECHECK_MS = 500;

/** Decide whether the current holder of `path` is provably dead. */
async function inspectOwner(
	path: string,
	liveCache: Map<string, number>,
): Promise<OwnerVerdict> {
	let entries: string[];
	try {
		entries = await readdir(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "gone" };
		return {
			kind: "held",
			reason: `lock directory is unreadable: ${errorCode(error) ?? String(error)}`,
		};
	}
	const owners = entries.filter((entry) => OWNER_FILE.test(entry));
	if (owners.length === 0)
		return {
			kind: "held",
			reason:
				"no owner record (being acquired, or left by a holder that recorded none); not stolen",
		};
	if (owners.length > 1)
		return { kind: "held", reason: "ambiguous owner records; not stolen" };
	const ownerFile = owners[0] as string;
	const token = OWNER_FILE.exec(ownerFile)?.[1] as string;
	let text: string;
	try {
		text = await readFile(join(path, ownerFile), "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "gone" };
		return {
			kind: "held",
			reason: `owner record is unreadable: ${errorCode(error) ?? String(error)}; not stolen`,
		};
	}
	const owner = parseOwner(text, token);
	if (typeof owner === "string")
		return { kind: "held", reason: `${owner}; not stolen` };
	const here = hostname();
	if (owner.host !== here)
		return {
			kind: "held",
			reason: `owner pid ${owner.pid} is on host ${JSON.stringify(owner.host)}, not ${JSON.stringify(here)}; liveness unknown, not stolen`,
		};
	if (owner.birthIdentity === null)
		return {
			kind: "held",
			reason: `owner pid ${owner.pid} recorded no process birth identity; liveness unknown, not stolen`,
		};
	const liveKey = `${ownerFile}:${owner.pid}:${owner.birthIdentity}`;
	const seenAliveAt = liveCache.get(liveKey);
	if (
		seenAliveAt !== undefined &&
		Date.now() - seenAliveAt < LIVE_OWNER_RECHECK_MS
	)
		return { kind: "held", reason: `owner pid ${owner.pid} is alive` };
	const status = await inspectProcessIdentity(owner.pid);
	if (status.state === "unknown")
		return {
			kind: "held",
			reason: `owner pid ${owner.pid} liveness unknown (${status.reason}); not stolen`,
		};
	if (status.state === "dead")
		return {
			kind: "stale",
			ownerFile,
			reason: `owner pid ${owner.pid} no longer exists`,
		};
	if (status.identity.birthIdentity !== owner.birthIdentity)
		return {
			kind: "stale",
			ownerFile,
			reason: `owner pid ${owner.pid} was reused by another process`,
		};
	liveCache.set(liveKey, Date.now());
	return { kind: "held", reason: `owner pid ${owner.pid} is alive` };
}

/** Create the lock directory with our record (synchronous, see the header). */
function tryCreateSync(
	path: string,
	staged: string,
	ownerFile: string,
): boolean {
	try {
		mkdirSync(path);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		renameSync(staged, join(path, ownerFile));
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
	held.set(path, ownerFile);
	return true;
}

/** Claim a dead owner's lock: rename its record to ours, then put our content in place. */
function tryClaimSync(
	path: string,
	deadOwnerFile: string,
	staged: string,
	ownerFile: string,
): boolean {
	try {
		renameSync(join(path, deadOwnerFile), join(path, ownerFile));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	held.set(path, ownerFile);
	try {
		renameSync(staged, join(path, ownerFile));
	} catch (error) {
		held.delete(path);
		releaseHeldLockSync(path, ownerFile);
		throw error;
	}
	return true;
}

export async function acquireDirectoryLock(
	lockPath: string,
	options: DirectoryLockOptions,
): Promise<ReleaseDirectoryLock> {
	const path = resolve(lockPath);
	const token = randomBytes(12).toString("hex");
	const ownerFile = `owner-${token}.json`;
	const owner: DirectoryLockOwner = {
		schema: DIRECTORY_LOCK_OWNER_SCHEMA,
		token,
		pid: process.pid,
		birthIdentity: await ownBirthIdentity(),
		host: hostname(),
		acquiredAt: new Date().toISOString(),
	};
	// Staged beside the lock so it enters the directory with one rename right after mkdir.
	const staged = join(dirname(path), `.${basename(path)}.${ownerFile}.tmp`);
	installCleanup();
	staging.add(staged);
	let reason: string | undefined;
	let freeRetries = 10;
	const liveCache = new Map<string, number>();
	try {
		writeFileSync(staged, ownerText(owner));
		for (let attempt = 0; ; ) {
			if (tryCreateSync(path, staged, ownerFile)) break;
			const verdict = await inspectOwner(path, liveCache);
			if (verdict.kind === "gone" && freeRetries > 0) {
				// Released between our mkdir and the inspection: try again at once.
				freeRetries -= 1;
				continue;
			}
			if (verdict.kind === "stale") {
				// The race-safe claim: one rename of a never-reused file name.
				if (tryClaimSync(path, verdict.ownerFile, staged, ownerFile)) break;
				reason = `${verdict.reason}; another contender stole it first`;
			} else
				reason =
					verdict.kind === "held" ? verdict.reason : "released and retaken";
			if (attempt >= options.retries) throw lockedError(path, reason);
			attempt += 1;
			await sleep(options.retryMs);
		}
	} finally {
		try {
			unlinkSync(staged);
		} catch {
			// Moved into the lock.
		}
		staging.delete(staged);
	}
	let released = false;
	return async () => {
		if (released)
			throw Object.assign(new Error("Lock is already released"), {
				code: "ERELEASED",
			});
		released = true;
		if (held.get(path) === ownerFile) held.delete(path);
		// Directory gone: nothing to release. Directory present without our record: it was taken
		// from us, which owner-aware stealing never does to a live holder.
		if (releaseHeldLockSync(path, ownerFile) === "not-ours")
			throw Object.assign(
				new Error(`Lock ${path} is no longer owned by this process`),
				{ code: "ECOMPROMISED" },
			);
	};
}
