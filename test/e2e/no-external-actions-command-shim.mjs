#!/usr/bin/env node
// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/e2e/no-external-actions-command-shim.mjs. MIT, same author. Changes: env PI_WORKFLOW_E2E_*→AGENT_WORKFLOW_E2E_*; shims also stand in for the codex and claude CLIs; classification shared with the guard.
//
// `test/e2e/run.mjs` copies this file under the names npm, npx, pnpm, yarn, bun, curl, wget, pi,
// codex and claude into a directory it puts first on PATH. Every invocation is logged; only allowed
// npm subcommands (run, pack, …) are passed on to the real npm. Anything else exits 97.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { classifyCommand } from "./no-external-actions-guard.mjs";

const invoked = basename(process.argv[1]);
const args = process.argv.slice(2);
const logPath = process.env.AGENT_WORKFLOW_E2E_PROCESS_LOG;

if (!logPath || process.env.AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS !== "1") {
	throw new Error("E2E command shim requires the no-external-actions guard");
}

const classification =
	invoked === "npm" ? classifyCommand("npm", args) : shimOnly(invoked);
appendFileSync(
	logPath,
	`${JSON.stringify({
		type: "command-shim",
		at: new Date().toISOString(),
		pid: process.pid,
		command: invoked,
		args: args.slice(0, 12).map((value) => String(value).slice(0, 240)),
		classification,
	})}\n`,
	"utf8",
);

if (classification !== "allowed") {
	appendFileSync(
		logPath,
		`${JSON.stringify({
			type: "blocked-command",
			at: new Date().toISOString(),
			pid: process.pid,
			command: invoked,
			classification,
		})}\n`,
		"utf8",
	);
	console.error(`E2E external-action shim blocked ${classification}`);
	process.exit(97);
}

const realNpm = process.env.AGENT_WORKFLOW_E2E_REAL_NPM;
if (!realNpm) throw new Error("AGENT_WORKFLOW_E2E_REAL_NPM is required");
const result = spawnSync(realNpm, args, {
	stdio: "inherit",
	env: process.env,
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

/** Every shimmed name except npm is blocked outright. */
function shimOnly(command) {
	const classification = classifyCommand(command, []);
	return classification === "allowed"
		? "network-or-package-executable"
		: classification;
}
