#!/usr/bin/env node
// run-bundled.mjs <workflow> <projectDir> <recordDir> --task <text>
//                 [--profile <name>] [--input key=value ...] [--fake] [--timeout-min N]
//
// Drives one pi-workflow run of a bundled workflow (<checkout>/workflows/<workflow>/spec.json)
// in-process using THIS checkout's built engine (dist/), with the
// PI_WORKFLOW_RECORD_DIR recording seam enabled, then captures the run record
// into <recordDir> and writes <recordDir>/driver.json (status, profile, inputs,
// wall time, run usage, resolved model per task).
//
// Execution profile: like a headless launch, the spec's defaultExecutionProfile
// is applied unless --profile names another declared profile. No model or
// thinking override is passed: workers use Pi's default model.
//   --input key=value  inputOverrides for keys the spec declares (e.g. depth=quick)
//   --fake             inject a canned subagent API (no Pi, no model) to dry-run the driver
//   --snapshot-web-cache  record through an injected recording API whose getSubagentStatus
//                      copies <run>/web-source-cache into <recordDir>/worker-snapshots/<subagentRunId>/
//                      the first time a subagent run is reported terminal. Workers write that
//                      shared cache during their run and support helpers read it later, so the
//                      replay needs its state at each terminal observation, not only the final
//                      one. The injected API is the same recorder (subagent-api-recorder.js)
//                      around the real @agwab/pi-subagent/api; runSubagent first runs the
//                      engine's extension preflight (assertSubagentExtensionsLoadable), which
//                      the engine skips for injected APIs.
//
// PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES is pinned to 6 unless already set
// (the default is CPU-derived; replay must apply the same value).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const argv = process.argv.slice(2);
const positional = [];
const inputOverrides = {};
let task;
let profile;
let fake = false;
let snapshotWebCache = false;
let timeoutMin = 90;
for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	if (arg === "--task") task = argv[++index];
	else if (arg === "--profile") profile = argv[++index];
	else if (arg === "--input") {
		const [key, ...rest] = String(argv[++index]).split("=");
		inputOverrides[key] = rest.join("=");
	} else if (arg === "--fake") fake = true;
	else if (arg === "--snapshot-web-cache") snapshotWebCache = true;
	else if (arg === "--timeout-min") timeoutMin = Number(argv[++index]);
	else positional.push(arg);
}
const [workflow, projectArg, recordArg] = positional;
if (!workflow || !projectArg || !recordArg || !task) {
	process.stderr.write(
		"usage: run-bundled.mjs <workflow> <projectDir> <recordDir> --task <text> [--profile p] [--input k=v] [--fake]\n",
	);
	process.exit(2);
}
const projectDir = resolve(projectArg);
const recordDir = resolve(recordArg);
const specPath = join(pkgRoot, "workflows", workflow, "spec.json");
if (!existsSync(specPath)) {
	process.stderr.write(`bundled spec not found: ${specPath}\n`);
	process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (profile === undefined) profile = spec.defaultExecutionProfile;
mkdirSync(recordDir, { recursive: true });
process.env.PI_WORKFLOW_RECORD_DIR = recordDir;
process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES ??= "6";

const dist = (name) => pathToFileURL(join(pkgRoot, "dist", name)).href;
const engine = await import(dist("engine.js"));
const store = await import(dist("store.js"));
if (fake) {
	const backend = await import(dist("subagent-backend.js"));
	const recorder = await import(dist("subagent-api-recorder.js"));
	let polls = 0;
	const api = {
		async runSubagent() {
			return {
				runId: "fake_run",
				attemptId: "fake_attempt",
				status: "running",
			};
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
				attempts: [
					{
						attemptId: "fake_attempt",
						status: polls < 2 ? "running" : "failed",
					},
				],
				logs: [],
			};
		},
		async interruptSubagent() {
			return {
				status: "already-terminal",
				runId: "fake_run",
				interruptedAttempts: [],
				unsupportedAttempts: [],
			};
		},
	};
	backend.setSubagentApiForTests(
		recorder.createRecordingSubagentApi(api, recordDir),
	);
} else if (snapshotWebCache) {
	const { cpSync } = await import("node:fs");
	const { createRequire } = await import("node:module");
	const backend = await import(dist("subagent-backend.js"));
	const recorder = await import(dist("subagent-api-recorder.js"));
	const real = await import(
		pathToFileURL(
			createRequire(join(pkgRoot, "package.json")).resolve(
				"@agwab/pi-subagent/api",
			),
		).href
	);
	const terminal = new Set([
		"completed",
		"failed",
		"cancelled",
		"interrupted",
		"timed_out",
		"timeout",
	]);
	const snapshotted = new Set();
	const api = { ...real };
	api.runSubagent = async (options, ...rest) => {
		await backend.assertSubagentExtensionsLoadable(options);
		return real.runSubagent(options, ...rest);
	};
	api.getSubagentStatus = async (options, ...rest) => {
		const result = await real.getSubagentStatus(options, ...rest);
		const runId = result?.runId ?? options?.runId;
		if (
			terminal.has(result?.status) &&
			runId &&
			!snapshotted.has(runId) &&
			options?.runsDir &&
			options?.cwd
		) {
			snapshotted.add(runId);
			const workflowRunId = options.runsDir.split("/").at(-2);
			const cache = join(
				options.cwd,
				".pi",
				"workflows",
				workflowRunId,
				"web-source-cache",
			);
			if (existsSync(cache))
				cpSync(
					cache,
					join(recordDir, "worker-snapshots", runId, "web-source-cache"),
					{ recursive: true, verbatimSymlinks: true },
				);
		}
		return result;
	};
	delete process.env.PI_WORKFLOW_RECORD_DIR;
	backend.setSubagentApiForTests(
		recorder.createRecordingSubagentApi(api, recordDir),
	);
}

const options = { task };
if (profile) options.executionProfile = profile;
if (Object.keys(inputOverrides).length > 0)
	options.inputOverrides = inputOverrides;
const startedAt = new Date();
const run = await engine.runWorkflow(specPath, projectDir, options);
process.stdout.write(`run ${run.runId} started (${run.status})\n`);
let final = run;
const deadline = Date.now() + timeoutMin * 60_000;
let lastSummary = "";
while (final.status === "running" && Date.now() < deadline) {
	try {
		final = await engine.waitForRun(projectDir, run.runId, 60_000);
	} catch (error) {
		final = await store.readRunRecord(projectDir, run.runId);
		if (!/still running/.test(String(error?.message))) {
			process.stdout.write(`wait: ${error?.message ?? error}\n`);
			break;
		}
	}
	const counts = {};
	for (const entry of final.tasks ?? [])
		counts[entry.status] = (counts[entry.status] ?? 0) + 1;
	const summary = JSON.stringify(counts);
	if (summary !== lastSummary) {
		process.stdout.write(
			`${new Date().toISOString()} ${final.status} ${summary}\n`,
		);
		lastSummary = summary;
	}
}
await store.flushPendingIndexUpdatesForTests?.();
const endedAt = new Date();
process.stdout.write(`run ${run.runId} finished: ${final.status}\n`);
const tasks = (final.tasks ?? []).map((entry) => ({
	taskId: entry.taskId,
	stageId: entry.stageId,
	kind: entry.kind,
	status: entry.status,
	agent: entry.agent,
	runtime: entry.runtime,
	provider: entry.usage?.provider,
	model: entry.usage?.model,
	totalTokens: entry.usage?.totalTokens,
	costUsd: entry.usage?.costUsd,
}));
writeFileSync(
	join(recordDir, "driver.json"),
	`${JSON.stringify(
		{
			workflow,
			specPath,
			runId: run.runId,
			status: final.status,
			task,
			executionProfile: profile ?? null,
			inputOverrides,
			env: {
				PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES:
					process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES,
			},
			fake,
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString(),
			wallMs: endedAt.getTime() - startedAt.getTime(),
			usage: final.usage ?? null,
			tasks,
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
