// agent-workflow 2026-11-08 (found by the L4 live check): deep-research's renderer declares itself blocked when the
// final audit failed; the run then refused `resume` ("non-resumable blocked task(s): final.main
// statusDetail=support_declared_blocked") although rerunning the failed stage is what unblocks it. A support block
// is resumable exactly when one of its dependencies is resumable; with every source completed it stays a blocker.
import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-resume-blocked-")));
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

async function writeUnderLease(cwd, runId, run) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const written = await store.withRunLease(cwd, runId, async () => {
			await store.writeRunRecord(cwd, store.deriveRunStatus(run));
			return true;
		});
		if (written === true) return;
		await new Promise((done) => setTimeout(done, 20));
	}
	throw new Error(`could not take the lease of ${runId}`);
}

// setTaskTerminal never rewrites a terminal task; the recorded shape is written directly.
function markTerminal(task, status, statusDetail, lastMessage) {
	Object.assign(task, { status, statusDetail, exitCode: 1, lastMessage });
}

const task = (specId, status, statusDetail, dependsOn = []) => ({
	taskId: `t-${specId}`,
	specId,
	status,
	statusDetail,
	dependsOn,
});

test("a declared support block is resumable only through a resumable dependency", () => {
	const ids = (tasks) =>
		[...store.dependencyResumableSupportBlockIds({ tasks })].sort();
	// final ← audit (failed): resumable.
	assert.deepEqual(
		ids([
			task("audit.main", "failed", "workflow_output_invalid_exhausted"),
			task("final.main", "blocked", "support_declared_blocked", ["audit.main"]),
		]),
		["t-final.main"],
	);
	// Chain: report ← final (declared blocked, resumable) ← audit (failed).
	assert.deepEqual(
		ids([
			task("audit.main", "failed", "x"),
			task("final.main", "blocked", "support_declared_blocked", ["audit.main"]),
			task("report.main", "blocked", "support_declared_blocked", [
				"final.main",
			]),
		]),
		["t-final.main", "t-report.main"],
	);
	// Every source completed: the block is the helper's verdict on good inputs — stays a blocker.
	assert.deepEqual(
		ids([
			task("audit.main", "completed", "completed"),
			task("final.main", "blocked", "support_declared_blocked", ["audit.main"]),
		]),
		[],
	);
	// Review 2026-11-09 (gpt-6-astra): failed A → completed partial consumer B that is invalidated on a
	// dependency resume → blocked C: C reruns with B. Without the declaration B stays and so does C's block.
	const consumer = (invalidates) => ({
		...task("sanitize.main", "completed", "completed", ["audit.main"]),
		...(invalidates
			? {
					artifactGraph: {
						enabled: true,
						inputPolicy: { invalidateOnDependencyResume: true },
					},
				}
			: {}),
	});
	for (const [invalidates, expected] of [
		[true, ["t-final.main"]],
		[false, []],
	])
		assert.deepEqual(
			ids([
				task("audit.main", "failed", "x"),
				consumer(invalidates),
				task("final.main", "blocked", "support_declared_blocked", [
					"sanitize.main",
				]),
			]),
			expected,
		);
	// Other blocked kinds are not widened (attention blockers keep their own rule).
	assert.deepEqual(
		ids([
			task("audit.main", "failed", "x"),
			task("worker.main", "blocked", "needs_attention", ["audit.main"]),
		]),
		[],
	);
	// reset honours the set; without it the task is untouched.
	const blocked = task("final.main", "blocked", "support_declared_blocked", [
		"audit.main",
	]);
	assert.equal(store.resetTaskForResume({ ...blocked }), false);
	const copy = { ...blocked };
	assert.equal(store.resetTaskForResume(copy, new Set(["t-final.main"])), true);
	assert.equal(copy.status, "pending");
});

async function project(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou report.\n",
	);
	// Blocks when its model source did not complete, like deep-research's renderer.
	await writeFile(
		join(cwd, "helpers", "render.mjs"),
		`export default async function render({ sources }) {
	const audit = Object.entries(sources ?? {}).find(([key]) => key.startsWith("audit"))?.[1];
	return audit
		? { schema: "render-v1", digest: "rendered", status: "passed" }
		: { schema: "render-v1", digest: "audit missing", status: "blocked", blockers: ["missing audit control"] };
}
`,
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "resume-blocked",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "audit", type: "single", prompt: "Audit." },
					{
						id: "final",
						from: ["audit"],
						sourcePolicy: "partial",
						support: { uses: "./helpers/render.mjs" },
					},
				],
			},
		}),
	);
	return { cwd, specPath };
}

test("resume reruns a failed audit and the support stage it blocked; a block on completed sources still refuses", async () => {
	const { cwd, specPath } = await project("chain");
	const effectLog = join(root, "chain-effects.jsonl");
	const id = "wf-resume-blocked";
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor({ id, effectLog })),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	const done = await engine.waitForRun(cwd, started.runId, 90_000);
	assert.equal(
		done.status,
		"completed",
		JSON.stringify(done.tasks.map((t) => [t.specId, t.status, t.statusDetail])),
	);

	// The live shape: the audit failed (repairs exhausted), the renderer declared blocked.
	const blockedRun = await store.readRunRecord(cwd, started.runId);
	const audit = blockedRun.tasks.find((t) => t.specId === "audit.main");
	const final = blockedRun.tasks.find((t) => t.specId === "final.main");
	markTerminal(
		audit,
		"failed",
		"workflow_output_invalid_exhausted",
		"invalid output",
	);
	markTerminal(
		final,
		"blocked",
		"support_declared_blocked",
		"support declared blocked",
	);
	await writeUnderLease(cwd, started.runId, blockedRun);
	assert.equal(
		(await store.readRunRecord(cwd, started.runId)).status,
		"blocked",
	);

	const submitsBefore = readFixtureLog(effectLog).filter(
		(e) => e.type === "submit",
	).length;
	const resumed = await engine.resumeRun(cwd, started.runId);
	assert.deepEqual(
		resumed.resetTaskIds.sort(),
		[audit.taskId, final.taskId].sort(),
	);
	const again = await engine.waitForRun(cwd, started.runId, 90_000);
	assert.equal(
		again.status,
		"completed",
		JSON.stringify(
			again.tasks.map((t) => [t.specId, t.status, t.statusDetail]),
		),
	);
	assert.equal(
		readFixtureLog(effectLog).filter((e) => e.type === "submit").length,
		submitsBefore + 1,
	);

	// Negative: the renderer blocked although its source completed → still an attention blocker.
	const stuck = await store.readRunRecord(cwd, started.runId);
	markTerminal(
		stuck.tasks.find((t) => t.specId === "final.main"),
		"blocked",
		"support_declared_blocked",
		"support declared blocked",
	);
	await writeUnderLease(cwd, started.runId, stuck);
	await assert.rejects(
		engine.resumeRun(cwd, started.runId),
		/non-resumable blocked task\(s\): final\.main statusDetail=support_declared_blocked/,
	);
	void stateDir;
});

// Review 2026-11-09 (gpt-6-astra): failed audit → completed partial consumer that is invalidated on a dependency
// resume → declared-blocked renderer. resume refused the run ("non-resumable blocked task(s)") although the consumer
// reruns with the audit.
test("resume reaches a declared block behind a completed partial consumer that reruns with its dependency", async () => {
	const cwd = join(root, "intermediary");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou report.\n",
	);
	await writeFile(
		join(cwd, "helpers", "sanitize.mjs"),
		'export default async function sanitize() { return { schema: "sanitize-v1", digest: "sanitized" }; }\n',
	);
	await writeFile(
		join(cwd, "helpers", "render.mjs"),
		'export default async function render() { return { schema: "render-v1", digest: "rendered", status: "passed" }; }\n',
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "resume-intermediary",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "audit", type: "single", prompt: "Audit." },
					{
						id: "sanitize",
						from: ["audit"],
						sourcePolicy: "partial",
						inputPolicy: { invalidateOnDependencyResume: true },
						support: { uses: "./helpers/sanitize.mjs" },
					},
					{
						id: "final",
						from: ["sanitize"],
						sourcePolicy: "partial",
						support: { uses: "./helpers/render.mjs" },
					},
				],
			},
		}),
	);
	const effectLog = join(root, "intermediary-effects.jsonl");
	const id = "wf-resume-intermediary";
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor({ id, effectLog })),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	assert.equal(
		(await engine.waitForRun(cwd, started.runId, 90_000)).status,
		"completed",
	);
	const record = await store.readRunRecord(cwd, started.runId);
	const audit = record.tasks.find((t) => t.specId === "audit.main");
	const final = record.tasks.find((t) => t.specId === "final.main");
	markTerminal(
		audit,
		"failed",
		"workflow_output_invalid_exhausted",
		"invalid output",
	);
	markTerminal(
		final,
		"blocked",
		"support_declared_blocked",
		"support declared blocked",
	);
	await writeUnderLease(cwd, started.runId, record);
	const resumed = await engine.resumeRun(cwd, started.runId);
	assert.ok(resumed.resetTaskIds.includes(audit.taskId));
	assert.ok(resumed.resetTaskIds.includes(final.taskId));
	const again = await engine.waitForRun(cwd, started.runId, 90_000);
	assert.equal(
		again.status,
		"completed",
		JSON.stringify(
			again.tasks.map((t) => [t.specId, t.status, t.statusDetail]),
		),
	);
});
