// WP1b replay acceptance: every recorded pi-workflow fixture runs its ORIGINAL workflow spec through
// the agent-workflow engine → core task backend → runtime durable worker → replay executor
// (test/replay/replay-executor.mjs; no model, no agent CLI), and the run directory is compared with
// the recording (test/replay/compare.mjs). Each variant runs in its own Node process.
// See docs/replay.md for the match key, the classification rules and the per-fixture results.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runFixture } from "../replay/acceptance.mjs";
import { loadFixture } from "../replay/replay-driver.mjs";
import { listFixtureNames } from "../replay/replay-executor.mjs";
import { FIXTURES_ROOT } from "../replay/replay-driver.mjs";

const WEB_TOOLS_REVIEW =
	"unknown/custom tools require explicit review: workflow_web_search, workflow_web_fetch_source, workflow_web_source_read";

/** Variants that record an expected different outcome (divergence entries assert the cause here). */
const DIVERGENT = new Set(["spec-review:original", "deep-research:original"]);

function assertFullReplay(name, report) {
	const label = `${name}:${report.variant}`;
	assert.equal(
		report.counts.unexplained,
		0,
		`${label}: ${JSON.stringify(
			report.differences.filter((row) => row.class === "unexplained"),
		).slice(0, 4000)}`,
	);
	assert.deepEqual(report.exactMatchViolations, [], label);
	assert.deepEqual(report.exactMatchDivergences, [], label);
	assert.equal(report.replayedStatus, report.recordedStatus, label);
	assert.equal(
		report.worker.servedLaunches,
		report.worker.recordedLaunches,
		label,
	);
	assert.deepEqual(report.worker.unservedLaunches, [], label);
	assert.deepEqual(report.worker.misses, [], label);
	assert.deepEqual(report.worker.adapterRefusals, [], label);
	assert.equal(report.worker.reissuedReads, report.worker.recordedReads, label);
	assert.deepEqual(report.worker.readErrors, [], label);
	assert.deepEqual(report.worker.unreproducibleReads, [], label);
}

/** WP37 per-executor variants: executor and launches whose rendered task prompt differs from Pi's. */
const PER_EXECUTOR = {
	"minimal:codex": { executor: "codex", rendered: 1 },
	"deep-research:engine-only-claude": { executor: "claude", rendered: 9 },
};

function divergentRows(report, rule) {
	return report.differences.filter(
		(row) => row.class === "explained" && row.rule === rule,
	);
}

const CHECKS = {
	"spec-review:original"(report) {
		// The original helper cannot read upstream state from the legacy path: the task-6 evidence
		// gate reports a missing requirement source, and the task-7 prompt (which quotes the task-6
		// control digest) has no recording.
		assert.equal(report.replayedStatus, "failed");
		assert.equal(report.recordedStatus, "failed");
		const rows = divergentRows(
			report,
			"original-spec-review-legacy-state-read",
		);
		assert.ok(
			rows.some(
				(row) =>
					row.file === "tasks/task-6/control.json" &&
					/^evidenceGate\.requirementReconciliation\.issues\[\d+\]$/u.test(
						row.path ?? "",
					) &&
					row.replayed === "missing_requirement_source_proof",
			),
		);
		const touched = new Set(
			rows.map(
				(row) =>
					/^tasks\/(task-\d+)\//u.exec(row.file)?.[1] ?? row.taskId ?? "run",
			),
		);
		assert.deepEqual([...touched].sort(), [
			"run",
			"task-6",
			"task-7",
			"task-8",
		]);
		assert.deepEqual(
			report.worker.misses.map((miss) => miss.taskId),
			["task-7"],
		);
		assert.match(report.worker.misses[0].closest.diff.a, /"taskId":"task-6"/u);
		assert.deepEqual(report.worker.unservedLaunches, [
			{ taskId: "task-7", seq: report.worker.unservedLaunches[0].seq },
		]);
		const task7 = report.tasks.find((task) => task.taskId === "task-7");
		assert.equal(task7.status, "failed");
		assert.match(
			task7.lastMessage,
			/before the durable launch barrier READY: executor refused the attempt before launch: replay miss for task-7/u,
		);
		assert.deepEqual(report.worker.adapterRefusals, []);
		assert.equal(report.counts.unexplained, 0);
		assert.deepEqual(report.exactMatchViolations, []);
	},
	"deep-research:original"(report) {
		// C2: the original spec asks for pi-workflow's workflow_web_* tools, which agent-workflow does
		// not know (2026-11-02: no built-in classification). They stay on the readOnly stages, so those
		// tasks need review before any launch; nothing runs without the tools it asked for.
		assert.equal(report.replayedStatus, "blocked");
		assert.deepEqual(report.worker.adapterRefusals, []);
		assert.equal(report.worker.servedLaunches, 1);
		assert.deepEqual(report.worker.misses, []);
		const byId = new Map(report.tasks.map((task) => [task.taskId, task]));
		for (const taskId of ["task-2", "task-4", "task-6", "task-9"]) {
			assert.equal(byId.get(taskId).status, "blocked", taskId);
			assert.equal(byId.get(taskId).statusDetail, "needs_attention", taskId);
			assert.ok(
				byId.get(taskId).lastMessage.endsWith(WEB_TOOLS_REVIEW),
				taskId,
			);
		}
		assert.equal(report.counts.unexplained, 0);
		assert.deepEqual(report.exactMatchViolations, []);
	},
};

for (const name of listFixtureNames(FIXTURES_ROOT)) {
	test(`replay acceptance: ${name}`, async (t) => {
		const loaded = loadFixture(name);
		const result = await runFixture(name);
		assert.equal(result.committedNormalizedMatches, true, name);
		for (const report of result.variants) {
			const key = `${name}:${report.variant}`;
			if (report.skipped) {
				t.diagnostic(`${key} skipped: ${report.skipped}`);
				continue;
			}
			assert.equal(report.platform, process.platform);
			assert.equal(
				report.recordedStatus,
				loaded.fixture.expectedStatus ?? "completed",
			);
			if (DIVERGENT.has(key)) CHECKS[key](report);
			else assertFullReplay(name, report);
			if (Object.hasOwn(PER_EXECUTOR, key)) {
				// WP37: the task prompts went out in the executor's vocabulary and still matched.
				const rows = divergentRows(report, "wp37-per-executor-task-prompt");
				assert.equal(rows.length, PER_EXECUTOR[key].rendered, key);
				for (const row of rows) {
					assert.equal(row.kind, "executor-rendered", key);
					assert.match(row.recorded, /^pi sha256:[0-9a-f]{64}$/u, key);
					assert.match(
						row.replayed,
						new RegExp(
							`^${PER_EXECUTOR[key].executor} sha256:[0-9a-f]{64}$`,
							"u",
						),
						key,
					);
				}
			}
		}
		if (result.variants.every((report) => report.skipped))
			t.skip(`fixture pins a ${loaded.fixture.replayRootPlatform} replay root`);
	});
}
