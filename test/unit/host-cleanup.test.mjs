// test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

for (const mode of ["assertion", "timeout"]) {
	test(`dashboard fixture cleans up on ${mode} failure`, {
		timeout: 60_000,
	}, async () => {
		const env = { ...process.env, CLEANUP_MODE: mode };
		// A nested node --test needs its own runner, not the parent's internal IPC context.
		delete env.NODE_TEST_CONTEXT;
		const result = await promisify(execFile)(
			process.execPath,
			[
				"--test",
				"--test-reporter=tap",
				"test/helpers/dashboard-cleanup-fixture.mjs",
			],
			{
				env,
				timeout: 45_000,
			},
		).then(
			() => assert.fail("fixture must fail"),
			(error) => error,
		);
		assert.equal(result.code, 1, result.stderr);
		assert.match(
			result.stdout,
			mode === "timeout"
				? /testTimeoutFailure/
				: /intentional assertion failure/,
		);
		if (mode === "assertion") assert.match(result.stdout, /DASHBOARD \d+/);
		const cwd = /PROJECT (.+)/.exec(result.stdout)?.[1]?.trim();
		assert.ok(cwd, result.stdout);
		await assert.rejects(stat(cwd), { code: "ENOENT" });
		if (process.platform !== "win32") {
			const { stdout } = await promisify(execFile)("ps", ["-axo", "command="]);
			assert.ok(
				!stdout
					.split("\n")
					.some(
						(line) => line.includes("cli.mjs dashboard") && line.includes(cwd),
					),
				"failed fixture left no detached dashboard",
			);
		}
	});
}
