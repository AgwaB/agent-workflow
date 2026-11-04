// Atomic JSON state writes shared by the executors' state files (moved here unchanged from their
// copies, refactor 2026-11-04).
import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

export async function writeAtomic(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}
