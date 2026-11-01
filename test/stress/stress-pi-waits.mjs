#!/usr/bin/env node
// Run after `npm run build`, from the repository root. No real executors/providers are used.
// Usage: node test/stress/stress-pi-waits.mjs [iterations=64] [parallel-files=8]
// Redirect output to a file: it includes every retained home/project path and the unit totals.
// Evidence is retained for EVERY iteration, so callers can inspect successes as well as failures.
import { spawn } from "node:child_process";

const iterations = Number(process.argv[2] ?? 64);
const concurrency = Number(process.argv[3] ?? 8);
if (
	![iterations, concurrency].every(
		(value) => Number.isSafeInteger(value) && value > 0,
	)
)
	throw new Error("iterations and parallel-files must be positive integers");
const capture = new URL("./capture-pi-waits.mjs", import.meta.url).href;
const child = spawn(
	process.execPath,
	[
		"test/run-unit.mjs",
		...Array(iterations).fill("test/unit/host-wp28-pi-waits.test.mjs"),
	],
	{
		stdio: "inherit",
		env: {
			...process.env,
			AGENT_WORKFLOW_KEEP_TEST_HOME: "1",
			AGENT_WORKFLOW_TEST_CONCURRENCY: String(concurrency),
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(capture)}`,
		},
	},
);
child.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.on("close", (code, signal) => {
	if (signal !== null) console.error(`stress runner terminated by ${signal}`);
	process.exitCode = code ?? 1;
});
