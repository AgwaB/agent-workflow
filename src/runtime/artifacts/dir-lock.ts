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
// - release removes the directory (`rmdir`, ENOENT ignored);
// - locks still held when the process exits, or is terminated by SIGINT,
//   SIGTERM or SIGHUP, are removed (proper-lockfile used `signal-exit`).
//
// Not kept: the 1 s mtime refresh and the "compromised lock" crash. Both only
// matter when stale stealing is enabled, which this runtime never does.
import { rmdirSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface DirectoryLockOptions {
	/** Retry attempts after the first failed acquisition. */
	retries: number;
	/** Fixed delay between attempts. */
	retryMs: number;
}

export type ReleaseDirectoryLock = () => Promise<void>;

const held = new Set<string>();
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let cleanupInstalled = false;

function removeHeldLocksSync(): void {
	for (const path of held) {
		try {
			rmdirSync(path);
		} catch {
			// Already gone or not removable; nothing else to do at exit.
		}
	}
	held.clear();
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

function lockedError(path: string): Error & { code: "ELOCKED"; file: string } {
	return Object.assign(new Error("Lock file is already being held"), {
		code: "ELOCKED" as const,
		file: path,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function acquireDirectoryLock(
	lockPath: string,
	options: DirectoryLockOptions,
): Promise<ReleaseDirectoryLock> {
	const path = resolve(lockPath);
	for (let attempt = 0; ; attempt += 1) {
		try {
			await mkdir(path);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			if (attempt >= options.retries) throw lockedError(path);
			await sleep(options.retryMs);
		}
	}
	installCleanup();
	held.add(path);
	let released = false;
	return async () => {
		if (released)
			throw Object.assign(new Error("Lock is already released"), {
				code: "ERELEASED",
			});
		released = true;
		held.delete(path);
		try {
			await rmdir(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		}
	};
}
