#!/usr/bin/env node
// New in agent-workflow (WP12b; replaces the Pi-session workflow runs of pi-workflow's E2E): the
// installed `agent-workflow` bin runs a bundled-style workflow end to end against the E2E test
// executor (guarded test-executor hook; no model or agent CLI):
//   triage (single, control schema) → reviewers (foreach over triage lenses) → merge (bundle-local
//   support helper) → report (reduce with a projected required read through the packed
//   workflow_artifact MCP server).
// Then the same workflow in `safe` mode, detached, waited for from a fresh process; status and
// inspect; and a stop of a slow detached run.
//
//   node test/e2e/cases/packed-cli-run.mjs <installed-package-root> <consumer-project>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [packageRootArg, consumerArg] = process.argv.slice(2);
if (!packageRootArg || !consumerArg)
	throw new Error(
		"usage: packed-cli-run.mjs <installed-package-root> <consumer-project>",
	);
const packageRoot = await realpath(packageRootArg);
const consumer = await realpath(resolve(consumerArg));
const fixtures = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);
const bin = join(consumer, "node_modules", ".bin", "agent-workflow");
const effectLog = join(consumer, "e2e-effects.jsonl");

// The executor module and the workflow bundle live in the consumer project, so the executor
// imports @agwab/agent-workflow from the installed tarball and the workflow resolves by name from
// the project-private root.
const executorModule = join(consumer, "e2e-executor.mjs");
await cp(join(fixtures, "e2e-executor.mjs"), executorModule);
await mkdir(join(consumer, ".agent-workflow", "workflows"), {
	recursive: true,
});
await cp(
	join(fixtures, "e2e-review"),
	join(consumer, ".agent-workflow", "workflows", "e2e-review"),
	{ recursive: true },
);

const hookEnv = {
	AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: executorModule,
	AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
	AW_E2E_EFFECT_LOG: effectLog,
	AW_E2E_EXECUTOR_ID: "test-e2e",
	AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
};

function aw(args, extra = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(bin, args, {
			cwd: consumer,
			env: { ...process.env, ...hookEnv, ...extra },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolveRun({ code, stdout, stderr });
		});
	});
}

async function effects() {
	try {
		return (await readFile(effectLog, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function runRecord(runId) {
	return JSON.parse(
		await readFile(
			join(consumer, ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
}

const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// 1. Foreground run, default permission mode.
const validate = await aw(["validate", "e2e-review"]);
assert.equal(validate.code, 0, validate.stderr);
const foreground = await aw([
	"run",
	"e2e-review",
	"Review the e2e fixture",
	"--executor",
	"test-e2e",
	"--json",
]);
assert.equal(foreground.code, 0, foreground.stdout + foreground.stderr);
assert.match(
	foreground.stderr,
	/test executor/iu,
	"the CLI warns that the test-executor hook is active",
);
const result = JSON.parse(foreground.stdout);
assert.equal(result.outcome, "completed", foreground.stdout);
const runId = result.data.runId;
assert.match(runId, /^workflow_/u);
assert.match(
	result.data.capability.preview,
	/Capability check \(test-e2e@0\.1\.0, \d+ stages?, permission mode: free\): accepted/u,
);

const run = await runRecord(runId);
assert.equal(run.status, "completed");
assert.equal(run.executor.id, "test-e2e");
assert.equal(run.executor.source, "run-flag");
assert.equal(run.permissionMode.mode, "free");
const byStage = (stage) => run.tasks.filter((task) => task.stageId === stage);
assert.equal(byStage("triage").length, 1);
assert.equal(
	byStage("reviewers").filter((task) => task.specId !== "reviewers.item")
		.length,
	2,
	"one reviewer per triage lens",
);
for (const task of run.tasks)
	assert.equal(task.status, "completed", `${task.specId}: ${task.status}`);
const taskDir = (task) =>
	join(consumer, ".agent-workflow", "workflows", runId, "tasks", task.taskId);
const [merge] = byStage("merge");
const mergeControl = JSON.parse(
	await readFile(join(taskDir(merge), "control.json"), "utf8"),
);
assert.equal(mergeControl.reviewerCount, 2, JSON.stringify(mergeControl));
assert.deepEqual(mergeControl.lensIds, ["correctness", "tests"]);
const [report] = byStage("report");
const ledger = (
	await readFile(join(taskDir(report), "read-ledger.jsonl"), "utf8")
)
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
assert.ok(
	ledger.some(
		(row) =>
			row.source === "merge" &&
			row.artifact === "control" &&
			row.path === "$" &&
			row.truncated === false,
	),
	`the report's required read is in its ledger: ${JSON.stringify(ledger)}`,
);
const reportControl = JSON.parse(
	await readFile(join(taskDir(report), "control.json"), "utf8"),
);
assert.equal(reportControl.verdict, "PASS");

const firstEffects = await effects();
const submits = firstEffects.filter((entry) => entry.type === "submit");
assert.equal(submits.length, 4, "triage, two reviewers, report");
for (const submit of submits) {
	assert.equal(submit.permissionMode, "free");
	assert.equal(submit.readOnly, true);
	const consumes = firstEffects.filter(
		(entry) =>
			entry.type === "consume" && entry.attemptKey === submit.attemptKey,
	);
	assert.deepEqual(
		consumes.map((entry) => entry.outcome),
		["released"],
		"each attempt consumed its authority once",
	);
	assert.equal(
		firstEffects.filter(
			(entry) =>
				entry.type === "effect" && entry.attemptKey === submit.attemptKey,
		).length,
		1,
		"one effect per attempt",
	);
}
const reportSubmit = submits.find((entry) => entry.stage === "report");
assert.deepEqual(reportSubmit.mcpServers, ["workflow_artifact"]);
assert.equal(reportSubmit.systemPromptNamesArtifactTool, true);
const list = firstEffects.find(
	(entry) =>
		entry.type === "artifact-list" &&
		entry.attemptKey === reportSubmit.attemptKey,
);
assert.equal(list?.server, "agent-workflow-artifact");
assert.ok(list.sources.includes("merge"), JSON.stringify(list));
assert.ok(
	firstEffects.some(
		(entry) =>
			entry.type === "artifact-read" &&
			entry.attemptKey === reportSubmit.attemptKey &&
			entry.source === "merge",
	),
);
for (const submit of submits.filter((entry) => entry.stage !== "report"))
	assert.deepEqual(
		submit.mcpServers,
		[],
		`${submit.stage} has no artifact access`,
	);

// 2. status and inspect from fresh processes.
const status = await aw(["status", runId, "--json"]);
assert.equal(status.code, 0, status.stderr);
assert.equal(JSON.parse(status.stdout).data.run.status, "completed");
const inspect = await aw(["inspect", runId, "--results"]);
assert.equal(inspect.code, 0, inspect.stderr);
assert.match(inspect.stdout, /e2e report analysis|report written/u);

// 3. safe mode, detached, waited for from another process.
const detached = await aw([
	"run",
	"e2e-review",
	"Review the e2e fixture in safe mode",
	"--executor",
	"test-e2e",
	"--permission-mode",
	"safe",
	"--detach",
	"--json",
]);
assert.equal(detached.code, 0, detached.stdout + detached.stderr);
const launched = JSON.parse(detached.stdout).data;
assert.equal(launched.status, "running");
assert.equal(launched.permissionMode.mode, "safe");
const waited = await aw([
	"wait",
	launched.runId,
	"--timeout",
	"120s",
	"--json",
]);
assert.equal(waited.code, 0, waited.stdout + waited.stderr);
assert.equal(JSON.parse(waited.stdout).outcome, "completed");
const safeSubmits = (await effects()).filter(
	(entry) =>
		entry.type === "submit" && entry.attemptKey.includes(launched.runId),
);
assert.equal(safeSubmits.length, 4);
for (const submit of safeSubmits) assert.equal(submit.permissionMode, "safe");
await waitForSupervisorDone(launched.detached.logPath, launched.runId);

// 4. stop a slow detached run.
const slow = await aw(
	[
		"run",
		"e2e-review",
		"Review slowly",
		"--executor",
		"test-e2e",
		"--detach",
		"--json",
	],
	{ AW_E2E_STEP_DELAY_MS: "2000" },
);
assert.equal(slow.code, 0, slow.stdout + slow.stderr);
const slowRun = JSON.parse(slow.stdout).data;
const startDeadline = Date.now() + 60_000;
while (
	!(await effects()).some(
		(entry) =>
			entry.type === "consume" &&
			entry.outcome === "released" &&
			entry.attemptKey.includes(slowRun.runId),
	)
) {
	assert.ok(Date.now() < startDeadline, "the slow run's first worker starts");
	await sleep(100);
}
const stopped = await aw(["stop", slowRun.runId, "--json"]);
assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
const afterStop = await aw([
	"wait",
	slowRun.runId,
	"--timeout",
	"60s",
	"--json",
]);
const stoppedStatus = JSON.parse(afterStop.stdout).data.status;
assert.equal(stoppedStatus, "interrupted", afterStop.stdout);
assert.ok(
	(await effects()).some(
		(entry) =>
			entry.type === "cancel" &&
			entry.result === "cancelled" &&
			entry.attemptKey.includes(slowRun.runId),
	),
	"the running worker was cancelled through the durable control mailbox",
);
await waitForSupervisorDone(slowRun.detached.logPath, slowRun.runId);

// Nothing was written outside the project and the isolated home.
const projectState = await readdir(join(consumer, ".agent-workflow"));
assert.ok(projectState.includes("workflows"));
assert.ok(projectState.includes("workflow-subagents"));

/** The detached supervisor logs `done: <run>` when it exits after a terminal run. */
async function waitForSupervisorDone(logPath, id) {
	const deadline = Date.now() + 60_000;
	for (;;) {
		let text = "";
		try {
			text = await readFile(logPath, "utf8");
		} catch {}
		if (text.includes(`done: ${id}`)) return;
		assert.ok(
			Date.now() < deadline,
			`detached supervisor for ${id} did not finish: ${text}`,
		);
		await sleep(100);
	}
}

console.log(
	`packed CLI run: ${runId} completed (${run.tasks.length} tasks, required read through the packed MCP server); safe detached ${launched.runId} completed; ${slowRun.runId} stopped (${stoppedStatus})`,
);
