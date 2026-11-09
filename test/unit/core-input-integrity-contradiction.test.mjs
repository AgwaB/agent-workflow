// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// 2026-11-01: deep-research's final audit (Codex, gpt-6.1-terra) withheld its synthesis as "packet
// truncated" although every required read was delivered complete. A worker's
// control.inputIntegrity = {status: "blocked", reason: "truncated_read" | "missing_read"} after the
// required-read check passed contradicts the read ledger: the engine retries with that evidence,
// and fails the task if the claim persists. Claims the ledger cannot judge are accepted.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const { acceptedInputIntegrityBlock, inputIntegrityContradiction } =
	await import("../../dist/core/required-reads.js");

let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-integrity-")));
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("only a blocked truncated/missing-read claim with required reads is contradicted", () => {
	const blocked = (reason, extra = {}) => ({
		schema: "x",
		digest: "d",
		inputIntegrity: { status: "blocked", reason, ...extra },
	});
	const truncated = inputIntegrityContradiction(
		blocked("truncated_read", { detail: "pages 3-4 cut" }),
		17,
	);
	assert.match(truncated, /reason="truncated_read" \("pages 3-4 cut"\)/);
	assert.match(truncated, /all 17 required workflow_artifact reads/);
	assert.match(truncated, /inconsistent_input/);
	assert.ok(inputIntegrityContradiction(blocked("missing_read"), 2));
	for (const [control, count] of [
		[blocked("truncated_read"), 0], // no required reads: nothing to contradict
		[blocked("inconsistent_input"), 3],
		[blocked("budget_block"), 3],
		[{ inputIntegrity: { status: "complete" } }, 3],
		[{ inputIntegrity: "blocked" }, 3],
		[{ inputIntegrity: ["blocked"] }, 3],
		[{}, 3],
		[undefined, 3],
	])
		assert.equal(inputIntegrityContradiction(control, count), undefined);
	// A long detail is quoted bounded, not echoed whole.
	assert.ok(
		inputIntegrityContradiction(
			blocked("truncated_read", { detail: "x".repeat(5000) }),
			1,
		).length < 1200,
	);
});

test("a block the ledger cannot disprove is accepted as the worker's blocked handoff", () => {
	const block = acceptedInputIntegrityBlock({
		inputIntegrity: {
			status: "blocked",
			reason: "inconsistent_input",
			detail: "header.fields[claimVerdictLedger].count=18 but 17 entries",
		},
	});
	assert.equal(block.reason, "inconsistent_input");
	assert.match(block.message, /reason="inconsistent_input" \("header\.fields/);
	assert.match(block.message, /not completed on this output/);
	assert.equal(
		acceptedInputIntegrityBlock({ inputIntegrity: { status: "blocked" } })
			.reason,
		"unspecified",
	);
	assert.ok(
		acceptedInputIntegrityBlock({
			inputIntegrity: { status: "blocked", reason: "budget_block" },
		}),
	);
	for (const control of [
		{ inputIntegrity: { status: "complete" } },
		{ inputIntegrity: "blocked" },
		{ inputIntegrity: ["blocked"] },
		{},
		undefined,
	])
		assert.equal(acceptedInputIntegrityBlock(control), undefined);
	assert.ok(
		acceptedInputIntegrityBlock({
			inputIntegrity: {
				status: "blocked",
				reason: "inconsistent_input",
				detail: "x".repeat(5000),
			},
		}).detail.length <= 600,
	);
});

async function project(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read workflow artifacts and report.\n",
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "integrity",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "Collect facts." },
					{
						id: "b",
						type: "single",
						prompt: "Summarize stage a.",
						from: "a",
						inputPolicy: { requiredReads: ["a.control"], enforcement: "fail" },
					},
				],
			},
		}),
	);
	return { cwd, specPath };
}

async function runWith(name, sequence) {
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	const { cwd, specPath } = await project(name);
	const effectLog = join(root, `${name}-effects.jsonl`);
	const id = `wf-integrity-${name}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog,
				reads: [{ source: "a", artifact: "control" }],
				controlSequence: { "task-2": sequence },
			}),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	const run = await engine.waitForRun(cwd, started.runId, 90_000);
	const b = run.tasks.find((task) => task.stageId === "b");
	const taskDir = join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		run.runId,
		"tasks",
		b.taskId,
	);
	const submits = readFixtureLog(effectLog).filter(
		(entry) =>
			entry.type === "submit" && entry.attemptKey.includes(`:${b.taskId}:`),
	).length;
	return { run, b, taskDir, submits, cwd };
}

const claim = (reason) => ({
	schema: "stage-control-v1",
	digest: "withheld",
	inputIntegrity: {
		status: "blocked",
		reason,
		detail: "the combined tool output was cut",
	},
});
const complete = {
	schema: "stage-control-v1",
	digest: "summarized",
	inputIntegrity: { status: "complete" },
};

test("a truncated-read claim the ledger disproves is retried with the evidence, then completes", async () => {
	const { run, b, taskDir, submits } = await runWith("retry", [
		claim("truncated_read"),
		complete,
	]);
	assert.equal(run.status, "completed", JSON.stringify(b, null, 1));
	assert.equal(submits, 2);
	assert.equal(b.outputRetry?.attempts, 1);
	assert.equal(b.outputRetry?.reason, "input_integrity_contradicted");
	const invalid = JSON.parse(
		await readFile(join(taskDir, "result.invalid-attempt-1.json"), "utf8"),
	);
	assert.equal(invalid.failureKind, "input_integrity_contradicted");
	assert.match(invalid.errorMessage, /delivered complete/);
	assert.match(
		await readFile(join(taskDir, "raw.invalid-attempt-1.md"), "utf8"),
		/truncated_read/,
	);
	const control = JSON.parse(
		await readFile(join(taskDir, "control.json"), "utf8"),
	);
	assert.deepEqual(control.inputIntegrity, { status: "complete" });
});

// K3 (2026-11-08): before, this stage completed with the block recorded in its control.
test("an inconsistent-input block fails the stage visibly without automatic retry, and resume reruns it", async () => {
	const { run, b, taskDir, submits, cwd } = await runWith("accept", [
		claim("inconsistent_input"),
		complete,
	]);
	assert.equal(run.status, "failed", JSON.stringify(b, null, 1));
	assert.equal(b.status, "failed");
	assert.equal(b.statusDetail, "input_integrity_blocked");
	assert.match(
		b.lastMessage,
		/reason="inconsistent_input" \("the combined tool output was cut"\)/,
	);
	assert.equal(submits, 1);
	assert.equal(b.outputRetry, undefined);
	assert.equal(existsSync(join(taskDir, "control.json")), false);
	const invalid = JSON.parse(
		await readFile(join(taskDir, "result.invalid-attempt-1.json"), "utf8"),
	);
	assert.equal(invalid.failureKind, "input_integrity_blocked");
	assert.match(
		await readFile(join(taskDir, "raw.invalid-attempt-1.md"), "utf8"),
		/inconsistent_input/,
	);
	const resumed = await engine.resumeRun(cwd, run.runId);
	assert.ok(resumed.resetTaskIds.includes(b.taskId));
	const after = await engine.waitForRun(cwd, run.runId, 90_000);
	assert.equal(after.status, "completed", JSON.stringify(after.tasks, null, 1));
	const control = JSON.parse(
		await readFile(join(taskDir, "control.json"), "utf8"),
	);
	assert.deepEqual(control.inputIntegrity, { status: "complete" });
});

test("a persistent missing-read claim fails the task after the output retries", async () => {
	const { run, b, submits } = await runWith("persist", [claim("missing_read")]);
	assert.notEqual(run.status, "completed");
	assert.equal(b.status, "failed", JSON.stringify(b, null, 1));
	assert.equal(b.outputRetry?.reason, "input_integrity_contradicted_exhausted");
	assert.equal(submits, b.outputRetry.maxAttempts + 1);
});
