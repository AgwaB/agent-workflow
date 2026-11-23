// test-tier: integration
// settleIndexUpdatesForRun (store.ts): a caller settling one run waits only for the in-flight index batches that
// name that run, not for every update in the process.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { stateDir } from "../helpers/state-dir.mjs";

import {
	artifactGraphWorkflowSpec,
	compileWorkflow,
	createRunRecord,
	flushPendingIndexUpdatesForTests,
	makeProject,
	setIndexUpdateDebounceMsForTests,
	withRunLease,
	writeAgent,
	writeRunRecord,
} from "../helpers/unit-test-support.mjs";
import {
	setRunLeaseTestHooksForTests,
	settleIndexUpdatesForRun,
} from "../../dist/core/store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function indexedRun(cwd, runId) {
	writeAgent(cwd, "unit-scout", "read");
	const compiled = await compileWorkflow(artifactGraphWorkflowSpec(), {
		cwd,
		task: "Index settle",
	});
	const { run } = await createRunRecord(
		cwd,
		compiled,
		join(cwd, `${runId}.json`),
		{
			runId,
		},
	);
	await withRunLease(cwd, runId, async () => {
		await writeRunRecord(cwd, run);
	});
	return {
		run,
		/** A nonterminal rewrite: queues the debounced index update. */
		dirty: (name) =>
			withRunLease(cwd, runId, async () => {
				run.name = name;
				await writeRunRecord(cwd, run);
			}),
	};
}

test("R4-3: settling one run does not wait for another project's in-flight index batch", async () => {
	const a = makeProject();
	const b = makeProject();
	setIndexUpdateDebounceMsForTests(5);
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	let armed = false;
	let aHeld = false;
	setRunLeaseTestHooksForTests({
		onBeforeAtomicRename: async ({ file }) => {
			if (
				!armed ||
				!file.endsWith("index.json") ||
				!file.startsWith(stateDir(a))
			)
				return;
			aHeld = true;
			await held;
		},
	});
	try {
		const runA = await indexedRun(a, "workflow_settle_a");
		const runB = await indexedRun(b, "workflow_settle_b");
		armed = true;
		await runA.dirty("A renamed");
		for (let i = 0; i < 300 && !aHeld; i += 1) await sleep(10);
		assert.ok(aHeld, "project A's index update is in flight and held");
		await runB.dirty("B renamed");
		const outcome = await Promise.race([
			settleIndexUpdatesForRun(b, "workflow_settle_b").then(() => "settled"),
			sleep(1500).then(() => "waited"),
		]);
		assert.equal(outcome, "settled");
		// The same call for the held project's own run does wait for its batch.
		const own = await Promise.race([
			settleIndexUpdatesForRun(a, "workflow_settle_a").then(() => "settled"),
			sleep(200).then(() => "waited"),
		]);
		assert.equal(own, "waited");
	} finally {
		release();
		setRunLeaseTestHooksForTests(undefined);
		setIndexUpdateDebounceMsForTests(undefined);
		await flushPendingIndexUpdatesForTests().catch(() => undefined);
		for (const cwd of [a, b])
			rmSync(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
	}
});
