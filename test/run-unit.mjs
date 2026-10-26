#!/usr/bin/env node
// Runs the unit suite with an isolated home directory so tests never read or write the
// developer's real `~/.agent-workflow` or legacy `~/.pi/agent` (run index, profiles, legacy
// spec/agent discovery). Child processes (durable workers, finalizers) inherit the same env.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const live = process.env.AGENT_WORKFLOW_LIVE === "1";
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	AGENT_WORKFLOW_HOME: join(home, ".agent-workflow"),
	PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
};
// Unit runs must never reach a real agent CLI or model provider (the default executor is the
// real Pi adapter). Real CLIs are shadowed by fail-fast shims that log their invocation, and
// provider credentials are removed from the environment. Live tiers opt out explicitly.
const shimLog = join(home, "agent-cli-shims.log");
if (!live) {
	const bin = join(home, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["pi", "codex", "claude"]) {
		const path = join(bin, name);
		writeFileSync(
			path,
			`#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(shimLog)}\necho "real ${name} CLI is disabled in unit tests (set AGENT_WORKFLOW_LIVE=1 for live tiers)" >&2\nexit 127\n`,
		);
		chmodSync(path, 0o755);
	}
	env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	for (const key of Object.keys(env))
		if (/(?:API_KEY|_TOKEN|_SECRET|ACCESS_KEY)$/u.test(key)) delete env[key];
}
const result = spawnSync(process.execPath, ["--test", ...flags, ...files], {
	env,
	stdio: "inherit",
});
if (existsSync(shimLog))
	console.error(
		`unit tests invoked agent CLI shims (no real CLI ran):\n${readFileSync(shimLog, "utf8")}`,
	);
if (process.env.AGENT_WORKFLOW_KEEP_TEST_HOME !== "1")
	rmSync(home, { recursive: true, force: true });
else console.error(`test home kept: ${home}`);
process.exit(result.status ?? 1);
