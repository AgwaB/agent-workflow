// New in agent-workflow (WP2a-1): covers the zero-dependency directory lock
// that replaces proper-lockfile in artifacts/registry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDirectoryLock } from "../../dist/runtime/artifacts/dir-lock.js";

const lockModule = new URL(
	"../../dist/runtime/artifacts/dir-lock.js",
	import.meta.url,
).href;

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

test("dir-lock: exclusive, fails closed with ELOCKED, releases once", async () => {
	const root = await mkdtemp(join(tmpdir(), "aw-dir-lock-"));
	try {
		const lockPath = join(root, "run.lock");
		const release = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		assert.equal((await stat(lockPath)).isDirectory(), true);
		await assert.rejects(
			acquireDirectoryLock(lockPath, { retries: 3, retryMs: 5 }),
			(error) =>
				error.code === "ELOCKED" &&
				/Lock file is already being held/.test(error.message),
		);
		await release();
		assert.equal(await exists(lockPath), false);
		await assert.rejects(release(), (error) => error.code === "ERELEASED");
		// A waiter acquires once the holder releases within its retry budget.
		const first = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		setTimeout(() => void first(), 30);
		const second = await acquireDirectoryLock(lockPath, {
			retries: 100,
			retryMs: 5,
		});
		await second();
		// Missing parent directories are an error, not a silent success.
		await assert.rejects(
			acquireDirectoryLock(join(root, "missing", "x.lock"), {
				retries: 0,
				retryMs: 5,
			}),
			(error) => error.code === "ENOENT",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// WP2b (5b flake root cause): a fixture cleanup `rm -r` of the runs directory can unlink the
// holder's owner record and leave the lock directory momentarily empty while the holder (the
// terminal finalizer, after publishing its events) releases. That is an external removal, not a
// steal: release must not raise ECOMPROMISED. A real steal (another owner record replaced ours)
// still does.
test("dir-lock: release after an external removal is not a compromise; a replaced record is", async () => {
	const root = await mkdtemp(join(tmpdir(), "aw-dir-lock-release-"));
	try {
		const lockPath = join(root, "run.lock");
		const release = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		const [record] = await readdir(lockPath);
		assert.match(record, /^owner-.+\.json$/u);
		// Mid-way through `rm -r`: our record is gone, the directory is still there and empty.
		await unlink(join(lockPath, record));
		await release();
		assert.equal(
			await exists(lockPath),
			true,
			"an empty foreign directory is left alone",
		);
		await rm(lockPath, { recursive: true, force: true });

		// The whole lock directory already removed: nothing to release.
		const second = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		await rm(lockPath, { recursive: true, force: true });
		await second();

		// Our record replaced by another owner's: compromised.
		const third = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		const [ours] = await readdir(lockPath);
		await rename(
			join(lockPath, ours),
			join(lockPath, "owner-someoneelse.json"),
		);
		await assert.rejects(third(), (error) => error.code === "ECOMPROMISED");
		assert.equal(await exists(join(lockPath, "owner-someoneelse.json")), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const [label, script, expectSignal] of [
	["normal exit", "process.exit(0);", null],
	[
		"SIGTERM without other handlers",
		"process.kill(process.pid, 'SIGTERM');",
		"SIGTERM",
	],
]) {
	test(`dir-lock: held lock is removed on ${label}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "aw-dir-lock-exit-"));
		try {
			const lockPath = join(root, "held.lock");
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`const { acquireDirectoryLock } = await import(${JSON.stringify(lockModule)});
await acquireDirectoryLock(${JSON.stringify(lockPath)}, { retries: 0, retryMs: 5 });
setInterval(() => {}, 1000);
${script}`,
				],
				{ stdio: "ignore" },
			);
			const [code, signal] = await once(child, "exit");
			assert.equal(signal, expectSignal);
			if (expectSignal === null) assert.equal(code, 0);
			assert.equal(await exists(lockPath), false, "lock directory removed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
