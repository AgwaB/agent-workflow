#!/usr/bin/env node
// WP6 live check through the durable runtime (manual; one model call): a detached durable worker
// reloads the Pi executor from its descriptor, runs `pi`, and the run settles with its artifacts.
//   node runtime-live.mjs <model>
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const rt = await import(join(root, "dist/runtime/index.js"));
const { PI_EXECUTOR_VERSION } = await import(
	join(root, "dist/executors/pi/index.js")
);
const model = process.argv[2] ?? "google/gemini-3.1-flash-lite";
const base = mkdtempSync("/tmp/aw-live-pi-runtime-");
const cwd = join(base, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "notes.txt"), "alpha bravo charlie\n");
const started = Date.now();
const run = await rt.runSubagent({
	cwd,
	executor: {
		id: "pi",
		version: PI_EXECUTOR_VERSION,
		contractVersion: "0.1.0",
		module: join(root, "dist/executors/pi/index.js"),
		config: { stateDir: join(base, "state") },
	},
	task: "Use the read tool to read notes.txt, then reply with only the third word of that file.",
	model,
	effort: "minimal",
	tools: ["read"],
	readOnly: true,
	async: true,
	timeoutMs: 240_000,
});
const waited = await rt.waitForSubagent({
	cwd,
	runId: run.runId,
	attemptId: run.attemptId,
	timeoutMs: 240_000,
	pollIntervalMs: 200,
});
const attemptDir = join(
	cwd,
	".agent-workflow/runs",
	run.runId,
	"attempts",
	run.attemptId,
);
const result = JSON.parse(
	readFileSync(join(attemptDir, "result.json"), "utf8"),
);
const events = readFileSync(join(attemptDir, "exec-events.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const summary = {
	model,
	durationMs: Date.now() - started,
	status: waited.snapshot?.status,
	failureKind: waited.snapshot?.failureKind,
	output: readFileSync(join(attemptDir, "output.log"), "utf8").slice(0, 200),
	usage: result.metadata?.usage,
	executor: {
		id: result.metadata?.executor?.id,
		authority: result.metadata?.executor?.authority,
		ref: result.metadata?.executor?.ref,
	},
	eventTypes: events.map((event) => event.type),
	rawStreamLines: readFileSync(join(attemptDir, "pi-stdout.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean).length,
	base,
};
mkdirSync("/tmp/aw-live-pi-rec/live-runtime", { recursive: true });
writeFileSync(
	"/tmp/aw-live-pi-rec/live-runtime/summary.json",
	`${JSON.stringify(summary, null, 1)}\n`,
);
console.log(JSON.stringify(summary, null, 1));
