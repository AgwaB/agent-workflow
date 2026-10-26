#!/usr/bin/env node
// build-fixture.mjs <name> <attemptDir> <projectDir> --files a,b --agent scout[,..] [--meta extra.json]
// Builds (1) the agent-workflow fixture  <AW>/test/replay/fixtures/<name>/ and
//        (2) the pi-workflow fixture     <PW>/test/replay/fixtures/<name>/
// from a raw capture made by run-bundled.mjs. Paths are made portable, calls.jsonl is
// compacted (compact-calls.mjs), normalized/ is produced by normalize.mjs.
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// PW: the pi-workflow seam checkout (branch work/wp1a-recording-seam-20261026).
// AW: this agent-workflow checkout. The original lived in PW/internal/record/.
const PW = process.env.PI_WORKFLOW_ROOT
	? resolve(process.env.PI_WORKFLOW_ROOT)
	: resolve(here, "../..");
const AW = process.env.AGENT_WORKFLOW_ROOT
	? resolve(process.env.AGENT_WORKFLOW_ROOT)
	: resolve(here, "../../..");
const argv = process.argv.slice(2);
const pos = [];
let files = [];
let agents = [];
let extraMeta = {};
let replayRoot = false;
let packageRoot = false;
for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--files") files = argv[++i].split(",").filter(Boolean);
	else if (argv[i] === "--agent") agents = argv[++i].split(",").filter(Boolean);
	else if (argv[i] === "--replay-root") replayRoot = true;
	else if (argv[i] === "--package-root") packageRoot = true;
	else if (argv[i] === "--meta")
		extraMeta = JSON.parse(readFileSync(argv[++i], "utf8"));
	else pos.push(argv[i]);
}
const [name, attemptArg, projectArg] = pos;
const attempt = resolve(attemptArg);
const project = resolve(projectArg);
const node = (...args) =>
	execFileSync(process.execPath, args, { encoding: "utf8" });

const staging = join(attempt, "..", `${name}-portable`);
node(
	join(here, "make-portable.mjs"),
	attempt,
	staging,
	"--root",
	project,
	"--pkg",
	PW,
);

// Output-retry reconstruction. pi-subagent hard-links an attempt's output.log to
// the workflow task output file; the engine truncates that file before relaunching
// the task, so an earlier attempt's captured output.log is empty although its
// result.json lists the bytes. The engine preserved those bytes verbatim as
// tasks/<task>/raw.invalid-attempt-<n>.md. Restore them (only when the byte count
// matches exactly) so the replay sees what the engine saw at that attempt's end.
const reconstructed = [];
{
	const { readdirSync, statSync } = await import("node:fs");
	const subRoot = join(attempt, "subagent-runs");
	for (const taskId of existsSync(subRoot) ? readdirSync(subRoot) : []) {
		const runs = readdirSync(join(subRoot, taskId))
			.filter((runId) => runId.startsWith("run_"))
			.map((runId) => ({
				runId,
				run: JSON.parse(
					readFileSync(join(subRoot, taskId, runId, "run.json"), "utf8"),
				),
			}))
			.sort((a, b) =>
				String(a.run.createdAt ?? a.run.startedAt).localeCompare(
					String(b.run.createdAt ?? b.run.startedAt),
				),
			);
		let invalidIndex = 0;
		for (const { runId } of runs) {
			for (const attemptId of readdirSync(
				join(subRoot, taskId, runId, "attempts"),
			)) {
				const dir = join(subRoot, taskId, runId, "attempts", attemptId);
				const result = JSON.parse(
					readFileSync(join(dir, "result.json"), "utf8"),
				);
				const out = (result.artifacts ?? []).find(
					(artifact) => artifact.type === "output",
				);
				if (!out?.bytes || statSync(join(dir, "output.log")).size !== 0)
					continue;
				invalidIndex += 1;
				const source = join(
					attempt,
					"run",
					"tasks",
					taskId,
					`raw.invalid-attempt-${invalidIndex}.md`,
				);
				if (!existsSync(source) || statSync(source).size !== out.bytes)
					throw new Error(
						`cannot reconstruct ${taskId}/${runId}/${attemptId} output (${out.bytes} bytes) from ${source}`,
					);
				const rel = join(
					"subagent-runs",
					taskId,
					runId,
					"attempts",
					attemptId,
					"output.log",
				);
				copyFileSync(
					join(
						staging,
						"run",
						"tasks",
						taskId,
						`raw.invalid-attempt-${invalidIndex}.md`,
					),
					join(staging, rel),
				);
				const stderr = (result.artifacts ?? []).find(
					(artifact) => artifact.type === "stderr",
				);
				reconstructed.push({
					file: rel,
					from: `run/tasks/${taskId}/raw.invalid-attempt-${invalidIndex}.md`,
					bytes: out.bytes,
					stderrBytesLost:
						stderr?.bytes && statSync(join(dir, "stderr.log")).size === 0
							? stderr.bytes
							: 0,
				});
			}
		}
	}
}
const driver = JSON.parse(readFileSync(join(staging, "driver.json"), "utf8"));
rmSync(join(staging, "driver.json"));
node(
	join(here, "compact-calls.mjs"),
	join(staging, "calls.jsonl"),
	join(staging, "calls.compact.jsonl"),
);
const fullCalls = readFileSync(join(staging, "calls.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean).length;
const compactCalls = readFileSync(join(staging, "calls.compact.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean).length;

const fixtureJson = {
	schema: "pi-workflow-replay-fixture-v1",
	name,
	workflowRunId: driver.runId,
	task: driver.task,
	bundledWorkflow: driver.workflow,
	spec: `<PKG>/workflows/${driver.workflow}/spec.json`,
	...(driver.executionProfile
		? { executionProfile: driver.executionProfile }
		: {}),
	...(Object.keys(driver.inputOverrides ?? {}).length
		? { inputOverrides: driver.inputOverrides }
		: {}),
	expectedStatus: driver.status,
	projectFiles: files,
	...(packageRoot
		? { projectIsPackageRoot: true }
		: { rootPathLength: project.length }),
	...(replayRoot
		? { replayRoot: project, replayRootPlatform: process.platform }
		: {}),
	projectAgents: Object.fromEntries(
		agents.map((agent) => [agent, `project/agents/${agent}.md`]),
	),
	env: driver.env,
	recordedWith: {
		piWorkflowBase: "b83cc4f",
		seamBranch: "work/wp1a-recording-seam-20261026",
		driver:
			"internal/record/run-bundled.mjs (in-process dist/engine.js runWorkflow + waitForRun)",
	},
};

const sumUsage = driver.usage ?? {};
const finalTask = [...driver.tasks]
	.reverse()
	.find((task) => /(^|\.)final$/.test(task.stageId ?? ""));
let finalControl = {};
try {
	finalControl = JSON.parse(
		readFileSync(
			join(attempt, "run", "tasks", finalTask.taskId, "control.json"),
			"utf8",
		),
	);
} catch {
	/* no final control */
}
const models = {};
for (const task of driver.tasks)
	if (task.model)
		models[`${task.provider}/${task.model}`] =
			(models[`${task.provider}/${task.model}`] ?? 0) + 1;
const meta = {
	schema: "agent-workflow-replay-fixture-meta-v1",
	fixture: name,
	recordedAt: driver.startedAt,
	piWorkflow: {
		package: "@agwab/pi-workflow",
		version: JSON.parse(readFileSync(join(PW, "package.json"), "utf8")).version,
		baseCommit: "b83cc4f297eca6df9e684d0a17fcd4475ee53ae9",
		seamBranch: "work/wp1a-recording-seam-20261026",
		seamCommit: execFileSync("git", ["-C", PW, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
	},
	piVersion: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(),
	piSubagentVersion: JSON.parse(
		readFileSync(
			join(PW, "node_modules/@agwab/pi-subagent/package.json"),
			"utf8",
		),
	).version,
	node: process.version,
	platform: process.platform,
	model: {
		resolvedModels: models,
		source:
			"Pi default (settings.json defaultProvider/defaultModel); no model override passed by driver or spec. Thinking comes from the spec/profile when declared, else Pi default (settings defaultThinkingLevel xhigh).",
	},
	workflow: {
		name: driver.workflow,
		spec: fixtureJson.spec,
		executionProfile: driver.executionProfile,
		inputOverrides: driver.inputOverrides,
		task: driver.task,
		agents: Object.fromEntries(
			agents.map((agent) => [
				agent,
				`project/agents/${agent}.md: copy of pi-workflow agents/${agent}.md installed as <ROOT>/.pi/agents/${agent}.md (project scope) so the user's ~/.pi/agent/agents/${agent}.md does not shadow the bundled agent`,
			]),
		),
		projectFiles: files,
	},
	run: {
		workflowRunId: driver.runId,
		status: driver.status,
		finalRender: {
			taskId: finalTask?.taskId ?? null,
			status: finalControl.status ?? null,
			verdict: finalControl.verdict ?? null,
			blockers: finalControl.blockers ?? [],
		},
		tasks: driver.tasks.length,
		modelTasks: driver.tasks.filter((task) => task.model).length,
		recordedCalls: fullCalls,
		committedCalls: compactCalls,
		wallMs: driver.wallMs,
		perTask: driver.tasks.map(
			({
				taskId,
				stageId,
				kind,
				status,
				provider,
				model,
				totalTokens,
				costUsd,
			}) => ({
				taskId,
				stageId,
				kind,
				status,
				model: model ? `${provider}/${model}` : null,
				totalTokens: totalTokens ?? null,
				costUsd: costUsd ?? null,
			}),
		),
	},
	usage: { source: "run/run.json usage (task-rollup)", ...sumUsage },
	env: driver.env,
	hostPins: {
		PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES:
			driver.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES,
		...(packageRoot
			? {
					projectIsPackageRoot: true,
					packageRootNote:
						"The project cwd was the pi-workflow checkout itself (<ROOT> == <PKG>; portable paths use <ROOT>). Replay must run with the engine checkout as project cwd.",
				}
			: { rootPathLength: project.length }),
		...(replayRoot
			? { replayRoot: project, replayRootPlatform: process.platform }
			: {}),
		note: "Applied by the self-replay test (test/unit/replay-self-consistency.test.mjs in the pi-workflow seam branch): the concurrency env value; rootPathLength = replay project path padded to the recorded absolute project path length (the engine truncates worker text that embeds absolute paths by character count, e.g. output-retry excerpts); replayRoot = replay at this exact absolute path (workers embed absolute paths in outputs whose digests the engine records); projectIsPackageRoot = replay with the engine checkout as project cwd.",
	},
	launch: `node internal/record/run-bundled.mjs ${driver.workflow} <project> <recordDir> --task <task>${driver.executionProfile ? ` (profile ${driver.executionProfile})` : ""}${
		Object.keys(driver.inputOverrides ?? {}).length
			? ` --input ${Object.entries(driver.inputOverrides)
					.map(([k, v]) => `${k}=${v}`)
					.join(" ")}`
			: ""
	}`,
	callsCompaction: `calls.jsonl keeps every effectful call and drops observation polls whose normalized response equals the previous one for the same replay key (tools/compact-calls.mjs; mirrors replay-subagent-api.mjs queue construction). ${fullCalls} recorded -> ${compactCalls} committed; the full portable file lives under internal/raw-recordings/${name}/.`,
	pathForm:
		"calls.jsonl, run/, subagent-runs/ are the raw capture with absolute host roots rewritten to <ROOT> (project), <PKG> (pi-workflow checkout), <HOME>, <TMP> by tools/make-portable.mjs.",
	normalized: `normalized/ = node test/replay/normalize.mjs fixtures/${name}/run fixtures/${name}/normalized`,
	...(reconstructed.length
		? {
				reconstructedAttemptOutputs: {
					note: "pi-subagent hard-links an attempt's output.log/stderr.log to the workflow task output/stderr file, and the engine truncates those files before an output retry relaunches the task, so the earlier attempt's captured output.log was empty. Its exact bytes (matching result.json artifact bytes) were restored from the engine's raw.invalid-attempt-<n>.md copy. The truncated stderr.log of that attempt is not preserved anywhere and stays empty.",
					files: reconstructed,
				},
			}
		: {}),
	...extraMeta,
};

function writeProject(target) {
	for (const file of files) {
		mkdirSync(dirname(join(target, file)), { recursive: true });
		copyFileSync(join(project, file), join(target, file));
	}
	for (const agent of agents) {
		mkdirSync(join(target, "agents"), { recursive: true });
		copyFileSync(
			join(project, ".pi", "agents", `${agent}.md`),
			join(target, "agents", `${agent}.md`),
		);
	}
}

// agent-workflow layout
const aw = join(AW, "test/replay/fixtures", name);
rmSync(aw, { recursive: true, force: true });
mkdirSync(aw, { recursive: true });
copyFileSync(join(staging, "calls.compact.jsonl"), join(aw, "calls.jsonl"));
copyFileSync(join(staging, "api-surface.json"), join(aw, "api-surface.json"));
cpSync(join(staging, "run"), join(aw, "run"), { recursive: true });
for (const dir of ["subagent-runs", "worker-snapshots"])
	if (existsSync(join(staging, dir)))
		cpSync(join(staging, dir), join(aw, dir), { recursive: true });
node(
	join(PW, "test/replay/normalize.mjs"),
	join(aw, "run"),
	join(aw, "normalized"),
);
writeProject(join(aw, "project"));
writeFileSync(
	join(aw, "fixture.json"),
	`${JSON.stringify(fixtureJson, null, 2)}\n`,
);
writeFileSync(join(aw, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

// pi-workflow layout
const pw = join(PW, "test/replay/fixtures", name);
rmSync(pw, { recursive: true, force: true });
mkdirSync(join(pw, "record"), { recursive: true });
for (const entry of [
	"calls.jsonl",
	"api-surface.json",
	"run",
	"subagent-runs",
	"worker-snapshots",
])
	if (existsSync(join(aw, entry)))
		cpSync(join(aw, entry), join(pw, "record", entry), { recursive: true });
cpSync(join(aw, "normalized"), join(pw, "normalized"), { recursive: true });
cpSync(join(aw, "project"), join(pw, "project"), { recursive: true });
writeFileSync(
	join(pw, "fixture.json"),
	`${JSON.stringify(fixtureJson, null, 2)}\n`,
);
console.log(
	`fixture ${name}: ${fullCalls} -> ${compactCalls} calls; ${aw} ; ${pw}`,
);
