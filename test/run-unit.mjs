#!/usr/bin/env node
// Runs the unit suite with an isolated home directory so tests never read or write the
// developer's real `~/.agent-workflow` or legacy `~/.pi/agent` (run index, profiles, legacy
// spec/agent discovery). Child processes (durable workers, finalizers) inherit the same env.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aw-unit-home-"));
// `node test/run-unit.mjs [node --test flags] [test files]`; no files = the whole unit suite.
const args = process.argv.slice(2);
const explicit = args.filter((arg) => arg.endsWith(".mjs"));
const flags = args.filter((arg) => !arg.endsWith(".mjs"));
const files =
	explicit.length > 0
		? explicit
		: readdirSync("test/unit")
				.filter((name) => name.endsWith(".test.mjs"))
				.sort()
				.map((name) => join("test/unit", name));
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	AGENT_WORKFLOW_HOME: join(home, ".agent-workflow"),
	PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
};
const result = spawnSync(process.execPath, ["--test", ...flags, ...files], {
	env,
	stdio: "inherit",
});
if (process.env.AGENT_WORKFLOW_KEEP_TEST_HOME !== "1")
	rmSync(home, { recursive: true, force: true });
else console.error(`test home kept: ${home}`);
process.exit(result.status ?? 1);
