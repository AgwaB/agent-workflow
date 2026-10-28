// New in agent-workflow (WP42 review round 1, finding 3): the cross-process transaction lock of the
// small host stores that are read, modified and replaced as a whole (saved workflow preferences,
// saved user profiles). The atomic rename of the writer prevents torn JSON, not lost updates: two
// callers (CLI, MCP, Pi) that read the same file and each replace it lose one acknowledged change,
// and a set/clear race resurrects a cleared entry. Every mutation therefore runs its whole
// read–modify–write under the runtime's directory lock (dir-lock.ts, as the launch guard does:
// owner-aware, a dead holder is stolen, never on elapsed time) beside the store file.
import { basename, dirname, join } from "node:path";

import { ensurePrivateDirectory } from "../core/secure-atomic-write.js";
import { acquireDirectoryLock } from "../runtime/artifacts/dir-lock.js";

const STORE_LOCK_RETRIES = 250;
const STORE_LOCK_RETRY_MS = 20;

/** The lock directory of a store file (`preferences.json` → `.preferences.lock`). */
export function storeLockPath(file: string): string {
	return join(dirname(file), `.${basename(file).replace(/\.json$/u, "")}.lock`);
}

/**
 * Run `body` (the complete read–modify–write of `file`) while holding the store's lock. A lock held
 * for the whole retry budget (~5 s) fails with a clear message; nothing was changed then.
 */
export async function withStoreLock<T>(
	file: string,
	body: () => Promise<T>,
): Promise<T> {
	await ensurePrivateDirectory(dirname(file));
	let release: () => Promise<void>;
	try {
		release = await acquireDirectoryLock(storeLockPath(file), {
			retries: STORE_LOCK_RETRIES,
			retryMs: STORE_LOCK_RETRY_MS,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED")
			throw new Error(
				`${file} is being changed by another agent-workflow process (${error instanceof Error ? error.message : String(error)}); nothing was changed, try again`,
			);
		throw error;
	}
	try {
		return await body();
	} finally {
		await release().catch(() => undefined);
	}
}
