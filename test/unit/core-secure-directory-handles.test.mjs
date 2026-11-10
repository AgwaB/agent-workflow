import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { ensurePrivateDirectory } from "../../dist/core/secure-atomic-write.js";

// agent-workflow 2026-11-10 (regression audit G1): a newly opened directory leaked when its identity check failed — 99d1c9e
test("a directory handle that fails validation and its ancestors close exactly once", async (t) => {
	const info = {
		dev: 1,
		ino: 1,
		isDirectory: () => true,
		isSymbolicLink: () => false,
	};
	const handles = [];
	const mocks = [
		t.mock.method(fs, "lstat", async () => info),
		t.mock.method(fs, "realpath", async (path) => path),
		t.mock.method(fs, "mkdir", async () => {}),
		t.mock.method(fs, "open", async (path) => {
			const handle = {
				stat: async () => ({ ...info, ino: path === "/" ? 1 : 2 }),
				close: t.mock.fn(async () => {}),
			};
			handles.push({ path, handle });
			return handle;
		}),
	];
	syncBuiltinESMExports();
	t.after(() => {
		for (const mock of mocks) mock.mock.restore();
		syncBuiltinESMExports();
	});
	await assert.rejects(
		ensurePrivateDirectory("/regression"),
		/secure directory changed during write/,
	);
	assert.deepEqual(
		handles.map(({ path }) => path),
		["/", "/regression"],
	);
	for (const { path, handle } of handles)
		assert.equal(
			handle.close.mock.callCount(),
			1,
			`${path}: opened handle must close exactly once`,
		);
});
