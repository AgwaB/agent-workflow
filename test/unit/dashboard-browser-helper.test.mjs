// 2026-11-09 (round-4 validation): a Chrome that failed during startup surfaced as an uncaught EPIPE from the test
// helper's cleanup, hiding why Chrome failed. The helper now reports the original error with Chrome's stderr tail.
// Round-6 review: a Chrome that closed its DevTools pipe but stays alive fails at once, not after the command
// timeout.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowser } from "../helpers/dashboard-browser.mjs";

test("a Chrome that dies during startup is reported with its exit and stderr", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-fake-chrome-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const previousTimeout = process.env.AW_TEST_CDP_TIMEOUT_MS;
	process.env.AW_TEST_CDP_TIMEOUT_MS = "10000";
	t.after(() => {
		if (previousTimeout === undefined)
			delete process.env.AW_TEST_CDP_TIMEOUT_MS;
		else process.env.AW_TEST_CDP_TIMEOUT_MS = previousTimeout;
	});
	for (const [name, script] of [
		["exits", 'echo "fake chrome: cannot open display" >&2\nexit 3\n'],
		[
			"closes-pipes",
			'exec 3<&- 4>&-\necho "fake chrome: cannot open display" >&2\nsleep 1\nexit 3\n',
		],
		[
			"closes-pipes-stays-alive",
			'exec 3<&- 4>&-\necho "fake chrome: cannot open display" >&2\nsleep 30\n',
		],
	]) {
		const executable = join(dir, name);
		await writeFile(executable, `#!/bin/sh\n${script}`, { mode: 0o755 });
		const started = Date.now();
		await assert.rejects(createBrowser(executable), (error) => {
			// Which error comes first (the exit, Chrome closing its pipe, or EPIPE on a write) depends on the
			// platform; the message always says Chrome failed, how it ended and what it printed (CI 42647384816).
			assert.match(error.message, /^Chrome failed to start: /, name);
			assert.match(
				error.message,
				/\[Chrome (exit code 3|stopped by SIG[A-Z]+)\]/,
				name,
			);
			assert.match(error.message, /cannot open display/, name);
			return true;
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 5_000, `${name} took ${elapsed} ms`);
	}
});
