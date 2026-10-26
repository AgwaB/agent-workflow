#!/usr/bin/env node
// run-minimal.mjs <projectDir> <recordDir> [--fake]
//
// Drives one pi-workflow run of <projectDir>/workflow.json in-process using THIS
// checkout's built engine (dist/), with the PI_WORKFLOW_RECORD_DIR recording seam
// enabled, then captures the run record into <recordDir>.
//   --fake  inject a canned subagent API (no Pi, no model) to dry-run the driver.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const args = process.argv.slice(2);
const fake = args.includes("--fake");
const [projectArg, recordArg] = args.filter((arg) => !arg.startsWith("--"));
if (!projectArg || !recordArg) {
	process.stderr.write("usage: run-minimal.mjs <projectDir> <recordDir> [--fake]\n");
	process.exit(2);
}
const projectDir = resolve(projectArg);
const recordDir = resolve(recordArg);
mkdirSync(recordDir, { recursive: true });
process.env.PI_WORKFLOW_RECORD_DIR = recordDir;

const dist = (name) => pathToFileURL(join(pkgRoot, "dist", name)).href;
const engine = await import(dist("engine.js"));
const store = await import(dist("store.js"));
if (fake) {
	const backend = await import(dist("subagent-backend.js"));
	const recorder = await import(dist("subagent-api-recorder.js"));
	let polls = 0;
	const api = {
		async runSubagent() {
			return { runId: "fake_run", attemptId: "fake_attempt", status: "running" };
		},
		async reconcileSubagentRun() {
			return { status: "noop" };
		},
		async getSubagentStatus(options) {
			polls += 1;
			return {
				runId: "fake_run",
				status: polls < 2 ? "running" : "failed",
				failureKind: "fake",
				cwd: options.cwd,
				attempts: [{ attemptId: "fake_attempt", status: polls < 2 ? "running" : "failed" }],
				logs: [],
			};
		},
		async interruptSubagent() {
			return { status: "already-terminal", runId: "fake_run", interruptedAttempts: [], unsupportedAttempts: [] };
		},
	};
	backend.setSubagentApiForTests(recorder.createRecordingSubagentApi(api, recordDir));
}

const startedAt = new Date();
const task = "Read NOTES.md and report its first heading.";
const run = await engine.runWorkflow(join(projectDir, "workflow.json"), projectDir, { task });
process.stdout.write(`run ${run.runId} started (${run.status})\n`);
let final = run;
const deadline = Date.now() + 20 * 60_000;
while (final.status === "running" && Date.now() < deadline) {
	try {
		final = await engine.waitForRun(projectDir, run.runId, 60_000);
	} catch (error) {
		process.stdout.write(`wait: ${error?.message ?? error}\n`);
		final = await store.readRunRecord(projectDir, run.runId);
		if (!/still running/.test(String(error?.message))) break;
	}
}
const endedAt = new Date();
process.stdout.write(`run ${run.runId} finished: ${final.status}\n`);
writeFileSync(
	join(recordDir, "driver.json"),
	`${JSON.stringify(
		{
			runId: run.runId,
			status: final.status,
			task,
			fake,
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString(),
			wallMs: endedAt.getTime() - startedAt.getTime(),
		},
		null,
		2,
	)}\n`,
);
const capture = spawnSync(
	process.execPath,
	[join(here, "capture-run.mjs"), run.runId, recordDir, "--cwd", projectDir],
	{ stdio: "inherit" },
);
process.exit(capture.status ?? 1);
