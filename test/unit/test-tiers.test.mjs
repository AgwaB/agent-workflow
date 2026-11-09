// 2026-11-10: unit-tier tests must not depend on the clock. A file without the integration marker may not sleep for
// a fixed time, assert on elapsed time, run workflow engines, Chrome or HTTP servers, or start long-lived child
// processes directly (test/helpers/unit-tier-guard.mjs also refuses those at run time, including through helpers).
// Move such a test to the integration tier by making `// test-tier: integration` its first line.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const UNIT_DIR = fileURLToPath(new URL(".", import.meta.url));
const MARKER = "// test-tier: integration";
const SELF = "test-tiers.test.mjs";

const UNIT_TIER_FORBIDDEN = [
	[
		"long-lived child processes",
		/\b(spawn|fork|execFile)\(|createStubCli\(|runtimeWorkerPath\(|fake-[\w-]*app-server|helpers\/mcp-host-client\.mjs/,
	],
	[
		"workflow engine runs",
		/\b(runWorkflowSpec|resumeRun|waitForRun|runWorkflowAction|runDynamicWorkflow)\(/,
	],
	["Chrome", /\b(createBrowser|findChrome)\(/],
	[
		"HTTP servers",
		/\.listen\(|fetch\(\s*`http:\/\/127\.0\.0\.1|createServer\(|helpers\/dashboard-ui-fixture-server\.mjs/,
	],
	[
		"fixed sleeps",
		/setTimeout\(\s*[^,()]+,\s*[1-9]\d+\s*\)|\bsleep\(\s*[1-9]\d+\s*\)/,
	],
	[
		"elapsed-time assertions",
		/(Date\.now\(\)|performance\.now\(\))\s*-\s*\w+\s*[<>]=?\s*[\d_]+|\belapsed\w*\s*[<>]=?\s*[\d_]+/,
	],
];

const files = readdirSync(UNIT_DIR)
	.filter((name) => name.endsWith(".test.mjs") && name !== SELF)
	.sort();

test("unit-tier files do not depend on the clock, processes or servers", () => {
	const offenders = [];
	for (const name of files) {
		const text = readFileSync(join(UNIT_DIR, name), "utf8");
		if (text.split("\n", 1)[0].trim() === MARKER) continue;
		for (const [label, pattern] of UNIT_TIER_FORBIDDEN) {
			const match = pattern.exec(text);
			if (!match) continue;
			const line = text.slice(0, match.index).split("\n").length;
			offenders.push(`${name}:${line} ${label}: ${match[0].trim()}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`these unit-tier files depend on time or processes; mark them \`${MARKER}\` or remove the dependency:\n${offenders.join("\n")}`,
	);
});

test("the integration marker is exactly the first line", () => {
	for (const name of files) {
		const lines = readFileSync(join(UNIT_DIR, name), "utf8").split("\n");
		const elsewhere = lines.findIndex(
			(line, index) => index > 0 && line.trim() === MARKER,
		);
		assert.equal(elsewhere, -1, `${name}: the marker must be the first line`);
	}
});
