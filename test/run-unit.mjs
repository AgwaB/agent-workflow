#!/usr/bin/env node
// Runs the unit suite hermetically: every test FILE gets its own temporary home directory, so test
// files never read or write the developer's real `~/.agent-workflow` / `~/.pi/agent` and never see
// each other's run index, saved user profiles or notices while running in parallel. Child processes
// (durable workers, finalizers) inherit the file's environment.
//
// Unit runs must never reach a real agent CLI or model provider (the default executor is the real
// Pi adapter): `pi`, `codex` and `claude` are shadowed by fail-fast shims that log their invocation,
// and provider credentials are removed from the environment. Live tiers opt out with
// AGENT_WORKFLOW_LIVE=1.
//
// `node test/run-unit.mjs [node --test flags] [test files]`; no files = the whole unit suite.
// AGENT_WORKFLOW_TEST_CONCURRENCY bounds parallel files; AGENT_WORKFLOW_KEEP_TEST_HOME=1 keeps homes.
import { spawn } from "node:child_process";
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
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

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
const keep = process.env.AGENT_WORKFLOW_KEEP_TEST_HOME === "1";
const concurrency = Math.max(
	1,
	Number.parseInt(process.env.AGENT_WORKFLOW_TEST_CONCURRENCY ?? "", 10) ||
		Math.max(2, availableParallelism() - 1),
);

function isolatedEnv(home) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_WORKFLOW_HOME: join(home, ".agent-workflow"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
	};
	if (live) return env;
	const shimLog = join(home, "agent-cli-shims.log");
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
	return env;
}

const SUMMARY_KEYS = [
	"tests",
	"suites",
	"pass",
	"fail",
	"cancelled",
	"skipped",
	"todo",
];
const totals = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, 0]));
const failedFiles = [];
const shimUses = [];

function runFile(file) {
	return new Promise((resolveRun) => {
		const home = mkdtempSync(join(tmpdir(), "aw-unit-home-"));
		const child = spawn(process.execPath, ["--test", ...flags, file], {
			env: isolatedEnv(home),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => chunks.push(chunk));
		child.on("close", (code, signal) => {
			const output = Buffer.concat(chunks).toString("utf8");
			process.stdout.write(output);
			for (const key of SUMMARY_KEYS) {
				const match = new RegExp(`^ℹ ${key} (\\d+)$`, "mu").exec(output);
				if (match) totals[key] += Number(match[1]);
			}
			if (code !== 0) failedFiles.push(`${file} (exit ${code ?? signal})`);
			const shimLog = join(home, "agent-cli-shims.log");
			if (existsSync(shimLog))
				shimUses.push(`${file}:\n${readFileSync(shimLog, "utf8")}`);
			if (keep) console.error(`test home kept: ${home}`);
			else rmSync(home, { recursive: true, force: true, maxRetries: 5 });
			resolveRun();
		});
	});
}

const queue = [...files];
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		for (let file = queue.shift(); file !== undefined; file = queue.shift())
			await runFile(file);
	}),
);

// Aggregated summary in node:test's own format (callers grep "ℹ pass N").
console.log("\n# agent-workflow unit summary");
for (const key of SUMMARY_KEYS) console.log(`ℹ ${key} ${totals[key]}`);
if (shimUses.length > 0)
	console.error(
		`unit tests invoked agent CLI shims (no real CLI ran):\n${shimUses.join("\n")}`,
	);
if (failedFiles.length > 0) {
	console.error(`\n✖ failing test files:\n${failedFiles.join("\n")}`);
	process.exit(1);
}
