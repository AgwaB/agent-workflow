// test-tier: integration
// agent-workflow 2026-11-23: with every model task failing, the bundled spec-review and deep-research still end in their
// support renderer, and it reads a skipped source like a failed one: the report and verdict are the same bytes as when
// the partial model stage failed. spec-review's candidate-findings (every source failed) is now skipped with a plain
// reason; deep-research's partial model stages keep running because the support helper before each one completes.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stateDir } from "../helpers/state-dir.mjs";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-partial-bundled-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
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

async function runAllFailing(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow"), { recursive: true });
	await cp(join(repo, "workflows", name), join(cwd, "workflow"), {
		recursive: true,
	});
	const effectLog = join(root, `${name}.jsonl`);
	const id = `wf-bundled-${name}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog,
				failures: { "*": [{ class: "permanent", message: "refused" }] },
				capabilities: {
					webTools: { level: "native", source: "declared" },
				},
			}),
		),
	);
	const started = await engine.runWorkflowSpec(
		join(cwd, "workflow", "spec.json"),
		cwd,
		{ task: "check the bundled renderers", executor: id },
	);
	const run = await engine.waitForRun(cwd, started.runId, 240_000);
	return { cwd, run, effectLog };
}

const bySpec = (run, specId) =>
	run.tasks.find((task) => task.specId === specId);
const summary = (run) =>
	JSON.stringify(
		run.tasks.map((task) => [task.specId, task.status, task.statusDetail]),
	);
const taskFile = (cwd, task, name) =>
	join(dirname(join(stateDir(cwd), task.files.result)), name);

test("spec-review: every model task failing skips candidate-findings and still renders the report and verdict", async () => {
	const { cwd, run, effectLog } = await runAllFailing("spec-review");
	const candidates = bySpec(run, "candidate-findings.main");
	assert.equal(candidates?.status, "skipped", summary(run));
	assert.equal(candidates.statusDetail, "skipped_every_input_failed");
	assert.equal(
		candidates.lastMessage,
		"skipped: every input failed (extract-spec failed, map-implementation failed, inspect-tests failed)",
	);
	assert.equal(
		readFixtureLog(effectLog).some((entry) =>
			JSON.stringify(entry).includes("candidate-findings.main"),
		),
		false,
	);
	// The partition helper counts the skipped source as non-completed, like a failed one.
	const partition = bySpec(run, "partition-findings.main");
	assert.equal(partition?.status, "completed", summary(run));
	const control = JSON.parse(
		await readFile(taskFile(cwd, partition, "control.json"), "utf8"),
	);
	assert.equal(control.sourceStatusSummary.completed, 0);
	assert.ok(
		control.sourceStatusSummary.partialFailures.some(
			(row) => row.stageId === "candidate-findings" && row.status === "skipped",
		),
	);
	// The final renderer declares the review could not finish and still writes the report and verdict.
	const final = bySpec(run, "final.main");
	assert.equal(final?.statusDetail, "support_declared_failed", summary(run));
	const report = await readFile(
		taskFile(cwd, final, "final-report.md"),
		"utf8",
	);
	assert.ok(report.trim().length > 200, "a non-blank report");
	const verdict = JSON.parse(
		await readFile(taskFile(cwd, final, "control.json"), "utf8"),
	);
	assert.ok(verdict && typeof verdict === "object");
});

test("deep-research: every model task failing changes nothing, the helper before each partial model stage still completes", async () => {
	const { cwd, run } = await runAllFailing("deep-research");
	for (const specId of ["normalize-claims.main", "final-audit.main"]) {
		assert.notEqual(
			bySpec(run, specId)?.statusDetail,
			"skipped_every_input_failed",
		);
		assert.equal(bySpec(run, specId)?.status, "failed", summary(run));
	}
	const final = bySpec(run, "final.main");
	assert.equal(final?.statusDetail, "support_declared_blocked", summary(run));
	JSON.parse(await readFile(taskFile(cwd, final, "control.json"), "utf8"));
});
