// 2026-11-01: `prune --run <id>` removes exactly the named terminal runs (owner asked to clean up
// specific check runs; the retention filters could not select them). Unknown or still-active ids
// delete nothing; the run protections (live lease, retained children) still apply.
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWorkflow } from "../../dist/core/schema.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import * as store from "../../dist/core/store.js";
import { pruneWorkflowRuns } from "../../dist/core/run-retention.js";
import { parseWorkflowPruneArgs } from "../../dist/hosts/args.js";

const exists = (path) =>
	access(path).then(
		() => true,
		() => false,
	);

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-prune-named-"));
	t.after(async () => {
		await store.flushPendingIndexUpdatesForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	await writeFile(
		join(cwd, "helper.mjs"),
		"export default()=>({control:{schema:'fixture',digest:'done'},analysis:'fixture',refs:[]});",
	);
	const spec = parseWorkflow({
		schemaVersion: 1,
		name: "prune-named",
		artifactGraph: {
			stages: [{ id: "local", support: { uses: "./helper.mjs" } }],
		},
	});
	const specPath = join(cwd, "spec.json");
	await writeFile(specPath, JSON.stringify(spec));
	const make = async (finished) => {
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Local record only.",
		});
		const { run } = await store.createWorkflowRunRecord(
			cwd,
			compiled,
			specPath,
		);
		await store.writeStaticRunArtifacts(cwd, run, compiled, spec);
		if (finished) for (const task of run.tasks) task.status = "completed";
		await store.writeRunRecord(cwd, run);
		return { runId: run.runId, dir: store.workflowRunDir(cwd, run.runId) };
	};
	return {
		cwd,
		a: await make(true),
		b: await make(true),
		c: await make(false),
	};
}

test("--run parses exact ids, repeats, and refuses prefixes or retention filters alongside", () => {
	assert.deepEqual(
		parseWorkflowPruneArgs([
			"--run",
			"workflow_a1_b",
			"--run",
			"workflow_c2_d",
			"--run",
			"workflow_a1_b",
			"--yes",
		]),
		{ runIds: ["workflow_a1_b", "workflow_c2_d"], yes: true },
	);
	for (const argv of [
		["--run"],
		["--run", "mvx4"],
		["--run", "workflow_a; rm -rf /"],
		["--run", "workflow_a", "--keep", "3"],
		["--older-than", "2", "--run", "workflow_a"],
	])
		assert.throws(() => parseWorkflowPruneArgs(argv), /--run/, argv.join(" "));
});

test("named prune previews and deletes exactly the named terminal runs", async (t) => {
	const { cwd, a, b, c } = await project(t);
	const preview = await pruneWorkflowRuns(cwd, { runIds: [a.runId] });
	assert.equal(preview.dryRun, true);
	assert.deepEqual(
		preview.runs.map((run) => run.runId),
		[a.runId],
	);
	assert.equal(await exists(a.dir), true, "a preview deletes nothing");

	const done = await pruneWorkflowRuns(cwd, { runIds: [a.runId], yes: true });
	assert.equal(done.error, undefined);
	assert.deepEqual(
		done.runs.map((run) => [run.runId, run.deleted]),
		[[a.runId, true]],
	);
	assert.deepEqual(
		done.autoRouterRuns,
		[],
		"auto-router requests are not swept",
	);
	assert.equal(await exists(a.dir), false);
	assert.equal(await exists(b.dir), true, "an unnamed terminal run stays");
	assert.equal(await exists(c.dir), true);
	const index = await store.readIndex(cwd);
	assert.equal(
		index.runs.some((run) => run.runId === a.runId),
		false,
	);
});

test("an unknown or still-active id fails the whole call and deletes nothing", async (t) => {
	const { cwd, b, c } = await project(t);
	for (const runIds of [
		[b.runId, "workflow_missing_x"],
		[b.runId, c.runId],
	]) {
		const result = await pruneWorkflowRuns(cwd, { runIds, yes: true });
		assert.match(
			result.error,
			/not a terminal run in this project: .*nothing was deleted/,
		);
		assert.deepEqual(result.runs, []);
		assert.equal(await exists(b.dir), true);
		assert.equal(await exists(c.dir), true);
	}
});
