#!/usr/bin/env node
// capture-run.mjs <runId> <recordDir> [--cwd <projectDir>]
//
// Copies a finished pi-workflow run record into a recording directory:
//   <projectDir>/.pi/workflows/<runId>/          -> <recordDir>/run/
//   <projectDir>/.pi/workflow-subagents/<runId>/ -> <recordDir>/subagent-runs/  (if present)
// Run records live under `<cwd>/.pi/workflows/<runId>` (pi-workflow src/store.ts
// workflowRunDir) and per-task pi-subagent artifacts under
// `<task.cwd>/.pi/workflow-subagents/<runId>/<taskId>` (src/subagent-backend.ts
// subagentRunsDir). Symlinks are copied verbatim; existing targets are replaced.
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write("usage: capture-run.mjs <runId> <recordDir> [--cwd <projectDir>]\n");
	process.exit(2);
}

const args = process.argv.slice(2);
let cwd = process.cwd();
const positional = [];
for (let index = 0; index < args.length; index += 1) {
	if (args[index] === "--cwd") cwd = args[++index] ?? usage("--cwd needs a value");
	else positional.push(args[index]);
}
const [runId, recordDir] = positional;
if (!runId || !recordDir || positional.length !== 2) usage();
if (!/^[A-Za-z0-9_.-]+$/.test(runId) || runId === "." || runId === "..")
	usage(`unsafe run id: ${runId}`);

const projectDir = resolve(cwd);
const sources = [
	[join(projectDir, ".pi", "workflows", runId), join(resolve(recordDir), "run"), true],
	[join(projectDir, ".pi", "workflow-subagents", runId), join(resolve(recordDir), "subagent-runs"), false],
];
for (const [source, target, required] of sources) {
	if (!existsSync(source) || !statSync(source).isDirectory()) {
		if (required) usage(`run directory not found: ${source}`);
		continue;
	}
	rmSync(target, { recursive: true, force: true });
	cpSync(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
	process.stdout.write(`captured ${source} -> ${target}\n`);
}
