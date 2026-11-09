// test-tier: integration
// 2026-11-05 (first CI run, Node 22): the probe timeout timer was unref'd, so while a probe hung
// nothing kept the event loop alive and the process could end with the probe still pending. In a
// plain module (any Node version) that shows as exit code 13 (unsettled top-level await); with the
// timer kept, the wait ends with the timeout error.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("a hanging probe ends with the timeout error, not with an empty event loop", async () => {
	const module = pathToFileURL(
		join(process.cwd(), "dist/core/executor-default.js"),
	).href;
	const script = `import { withTimeout } from ${JSON.stringify(module)};
await withTimeout(new Promise(() => {}), 50).then(
	() => console.log("resolved"),
	(error) => console.log("rejected: " + error.message),
);`;
	const { stdout } = await run(
		process.execPath,
		["--input-type=module", "-e", script],
		{
			timeout: 20_000,
		},
	);
	assert.equal(stdout.trim(), "rejected: probe did not finish within 50 ms");
});
