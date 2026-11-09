// CI 2026-11-09 (42577149353, ubuntu Node 26): a dashboard discovery read that opened the file just before an atomic
// rewrite renamed over it held the old, unlinked inode and failed ("not a stable regular file"), so the dashboard
// read as absent. The replace is injected right after the reader's open, so this is deterministic.
import assert from "node:assert/strict";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import {
	readPrivateFileText,
	setSecureReadAfterOpenHookForTests,
	writePrivateFileAtomic,
} from "../../dist/core/secure-atomic-write.js";

let dir;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "aw-secure-read-"));
	await mkdir(join(dir, "p"), { mode: 0o700 });
});
after(() => rm(dir, { recursive: true, force: true }));
afterEach(() => setSecureReadAfterOpenHookForTests(undefined));

test("a file replaced right after the reader opened it is read again", async () => {
	const path = join(dir, "p", "discovery.json");
	await writePrivateFileAtomic(path, "old\n");
	let replaced = 0;
	setSecureReadAfterOpenHookForTests(async () => {
		if (replaced++ === 0) await writePrivateFileAtomic(path, "new\n");
	});
	assert.equal(await readPrivateFileText(path), "new\n");
	assert.equal(replaced, 2, "one retry");
});

test("a file replaced on every read gives up after a bounded number of tries", async () => {
	const path = join(dir, "p", "busy.json");
	await writePrivateFileAtomic(path, "0\n");
	let n = 0;
	setSecureReadAfterOpenHookForTests(() =>
		writePrivateFileAtomic(path, `${++n}\n`),
	);
	await assert.rejects(readPrivateFileText(path), /replaced while it was read/);
	assert.equal(n, 10);
});

test("hard links and symlinks still fail", async () => {
	const path = join(dir, "p", "linked.json");
	await writePrivateFileAtomic(path, "x\n");
	await link(path, join(dir, "p", "other-name.json"));
	await assert.rejects(readPrivateFileText(path), /hard-linked/);
	const target = join(dir, "p", "target.json");
	await writePrivateFileAtomic(target, "t\n");
	await symlink(target, join(dir, "p", "sym.json"));
	await assert.rejects(readPrivateFileText(join(dir, "p", "sym.json")));
});

test("round 4: a swapped parent directory fails instead of being read again", async () => {
	// gpt-6-astra: the retry reopened a replacement directory as trusted.
	const base = join(dir, "swap");
	const parent = join(base, "private");
	const other = join(base, "other");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	await mkdir(other, { mode: 0o700 });
	await writePrivateFileAtomic(join(parent, "f.json"), "original\n");
	await writePrivateFileAtomic(
		join(other, "f.json"),
		"replacement-directory-content\n",
	);
	let n = 0;
	setSecureReadAfterOpenHookForTests(async () => {
		if (n++ === 0) {
			await rename(parent, join(base, "moved"));
			await rename(other, parent);
		}
	});
	await assert.rejects(
		readPrivateFileText(join(parent, "f.json")),
		/directory changed/,
	);
});

test("round 4: ownerOnly checks the file actually read, including a replacement", async () => {
	// gpt-6-astra: loadDiscovery checked 0600 on a path snapshot, then the retry read a 0644 replacement.
	const path = join(dir, "p", "owner-only.json");
	await writePrivateFileAtomic(path, "private\n");
	assert.equal(
		await readPrivateFileText(path, 4096, { ownerOnly: true }),
		"private\n",
	);
	let n = 0;
	setSecureReadAfterOpenHookForTests(async () => {
		if (n++ === 0) {
			const loose = `${path}.loose`;
			await writeFile(loose, "loose\n", { mode: 0o644 });
			await chmod(loose, 0o644);
			await rename(loose, path);
		}
	});
	await assert.rejects(
		readPrivateFileText(path, 4096, { ownerOnly: true }),
		/not owner-only/,
	);
});
