// 2026-11-09 (round-4 validation): a Chrome that failed during startup surfaced as an uncaught EPIPE from the test
// helper's cleanup, hiding why Chrome failed. The helper now reports the original error with Chrome's stderr tail.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowser } from "../helpers/dashboard-browser.mjs";

test("a Chrome that dies during startup is reported with its exit and stderr", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-fake-chrome-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const [name, script] of [
		["exits", 'echo "fake chrome: cannot open display" >&2\nexit 3\n'],
		[
			"closes-pipes",
			'exec 3<&- 4>&-\necho "fake chrome: cannot open display" >&2\nsleep 1\nexit 3\n',
		],
	]) {
		const executable = join(dir, name);
		await writeFile(executable, `#!/bin/sh\n${script}`, { mode: 0o755 });
		await assert.rejects(createBrowser(executable), (error) => {
			assert.match(
				error.message,
				/Chrome failed to start: Chrome exited \(code 3/,
				name,
			);
			assert.match(error.message, /cannot open display/, name);
			return true;
		});
	}
});
