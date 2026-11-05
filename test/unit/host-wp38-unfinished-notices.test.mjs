// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/unit-engine-store.test.mjs (2 tests) and
// test/unit/unit-authoring-interface.test.mjs (4 tests): the `notifyUnfinishedRuns` tests (WP38; the
// rest of both files is ported as core-unit-engine-store / core-unit-authoring-interface). MIT, same
// author. Changes: `notifyUnfinishedRuns(cwd, notify, now)` → the Pi host's session-start notice
// `unfinishedRunNotice(hostApi, ctx, now)` (src/hosts/pi/notices.ts, over the host API `notices
// list`; one notice text, level warning at the call site); harness from test/helpers/; run root
// .agent-workflow/workflows; the hint is `/aw resume` (was `/workflow resume`); a project without
// a run store returns no notice; the prune keeps only runs that are still unfinished notices (WP11b;
// pi-workflow also kept recently notified runs that were still indexed).
import {
	assert,
	formatStatus,
	join,
	makeProject,
	mkdirSync,
	readFileSync,
	rmSync,
	test,
	writeFileSync,
	writeUnfinishedNoticeIndex,
	writeUnfinishedNoticeIndexRun,
	writeUnfinishedNoticeRunRecord,
} from "../helpers/unit-test-support.mjs";
import * as hostApi from "../../dist/hosts/api.js";
import { unfinishedRunNotice } from "../../dist/hosts/pi/notices.js";

const env = { ...process.env, AGENT_WORKFLOW_ROLE: "supervisor" };

/** pi-workflow's notifier signature over the Pi host's session-start notice. */
async function notifyUnfinishedRuns(cwd, notify, nowMs) {
	const text = await unfinishedRunNotice(hostApi, { cwd, env }, nowMs);
	if (text) notify(text, "warning");
}

test("notifyUnfinishedRuns reports recent failed root runs with resume hint", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const indexDir = join(cwd, ".agent-workflow", "workflows");
		mkdirSync(indexDir, { recursive: true });
		const summary = {
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 1,
			failed: 1,
			skipped: 3,
			interrupted: 0,
			total: 5,
		};
		writeFileSync(
			join(indexDir, "index.json"),
			JSON.stringify({
				schemaVersion: 1,
				updatedAt: "2026-06-12T11:00:00.000Z",
				runs: [
					{
						runId: "workflow_recent",
						name: "deep-research",
						type: "artifact-graph",
						status: "failed",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_old",
						name: "stale",
						type: "artifact-graph",
						status: "failed",
						taskSummary: summary,
						createdAt: "2026-05-01T00:00:00.000Z",
						updatedAt: "2026-05-01T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_child",
						name: "loop-child",
						type: "artifact-graph",
						status: "failed",
						parentRunId: "workflow_recent",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_done",
						name: "ok",
						type: "artifact-graph",
						status: "completed",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
				],
			}),
		);
		writeUnfinishedNoticeIndex(
			cwd,
			JSON.parse(readFileSync(join(indexDir, "index.json"))).runs,
		);

		const notices = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => notices.push({ message, type }),
			nowMs,
		);
		assert.equal(notices.length, 1);
		assert.equal(notices[0].type, "warning");
		assert.match(notices[0].message, /deep-research workflow_recent: failed/);
		assert.match(notices[0].message, /\/aw resume workflow_recent/);
		assert.doesNotMatch(
			notices[0].message,
			/workflow_old|workflow_child|workflow_done/,
		);

		const duplicate = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => duplicate.push({ message, type }),
			nowMs + 60_000,
		);
		assert.equal(duplicate.length, 0);

		const later = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => later.push({ message, type }),
			nowMs + 7 * 60 * 60 * 1000,
		);
		assert.equal(later.length, 1);

		const silent = [];
		await notifyUnfinishedRuns(
			join(cwd, "no-such"),
			(message) => silent.push(message),
			nowMs,
		);
		assert.equal(silent.length, 0);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

test("notifyUnfinishedRuns prunes stale and orphaned notice entries on write", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const indexDir = writeUnfinishedNoticeIndex(cwd, [
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_active",
				name: "active",
			}),
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_done",
				name: "done",
				status: "completed",
			}),
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_ancient",
				name: "ancient",
				status: "completed",
			}),
		]);
		writeFileSync(
			join(indexDir, "unfinished-notices.json"),
			JSON.stringify({
				notices: {
					workflow_gone: {
						status: "failed",
						updatedAt: "2026-06-11T00:00:00.000Z",
						lastNotifiedAt: new Date(nowMs - 60_000).toISOString(),
					},
					workflow_ancient: {
						status: "failed",
						updatedAt: "2026-06-01T00:00:00.000Z",
						lastNotifiedAt: new Date(
							nowMs - 8 * 24 * 60 * 60 * 1000,
						).toISOString(),
					},
					workflow_done: {
						status: "failed",
						updatedAt: "2026-06-11T00:00:00.000Z",
						lastNotifiedAt: new Date(nowMs - 60_000).toISOString(),
					},
				},
			}),
		);

		const notices = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => notices.push({ message, type }),
			nowMs,
		);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /workflow_active/);

		const state = JSON.parse(
			readFileSync(join(indexDir, "unfinished-notices.json")),
		);
		// WP11b: entries of runs that are no longer unfinished notices (here the completed
		// workflow_done) are pruned too; pi-workflow kept them while the run was indexed.
		assert.deepEqual(Object.keys(state.notices).sort(), ["workflow_active"]);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

test("notifyUnfinishedRuns labels degraded failed runs as final rendered", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const indexDir = join(cwd, ".agent-workflow", "workflows");
		mkdirSync(indexDir, { recursive: true });
		writeFileSync(
			join(indexDir, "index.json"),
			JSON.stringify({
				schemaVersion: 1,
				updatedAt: "2026-06-12T11:00:00.000Z",
				runs: [
					{
						runId: "workflow_degraded",
						name: "deep-research",
						type: "artifact-graph",
						status: "failed",
						degradation: {
							finalOutputRendered: true,
							failedTaskIds: ["task-3"],
							degradedHelperTaskIds: [],
							summary: "final rendered, 1/15 tasks failed",
						},
						taskSummary: {
							pending: 0,
							running: 0,
							blocked: 0,
							completed: 14,
							failed: 1,
							skipped: 0,
							interrupted: 0,
							total: 15,
						},
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
				],
			}),
		);
		writeUnfinishedNoticeIndex(
			cwd,
			JSON.parse(readFileSync(join(indexDir, "index.json"))).runs,
		);

		const notices = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => notices.push({ message, type }),
			nowMs,
		);
		assert.equal(notices.length, 1);
		assert.match(
			notices[0].message,
			/deep-research workflow_degraded: failed \(final rendered — degraded\)/,
		);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

test("notifyUnfinishedRuns never notifies runs with mock provenance and formatStatus annotates them", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		writeUnfinishedNoticeIndex(cwd, [
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_mockrun",
				name: "mock-fixture",
			}),
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_realrun",
				name: "real-run",
			}),
		]);
		writeUnfinishedNoticeRunRecord(cwd, "workflow_mockrun", {
			mode: "mock-screenshot",
		});
		writeUnfinishedNoticeRunRecord(cwd, "workflow_realrun", {
			mode: "direct-dynamic",
		});

		const notices = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => notices.push({ message, type }),
			nowMs,
		);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /workflow_realrun/);
		assert.doesNotMatch(notices[0].message, /workflow_mockrun/);

		const state = JSON.parse(
			readFileSync(
				join(cwd, ".agent-workflow", "workflows", "unfinished-notices.json"),
			),
		);
		assert.deepEqual(Object.keys(state.notices), ["workflow_realrun"]);

		const status = await formatStatus(cwd);
		assert.match(status, /mock-fixture — failed mock\(mock-screenshot\)/);
		assert.doesNotMatch(status, /real-run — failed mock/);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

test("notifyUnfinishedRuns re-notifies only runs whose own state changed", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const runA = writeUnfinishedNoticeIndexRun({
			runId: "workflow_alpha",
			name: "alpha",
		});
		writeUnfinishedNoticeIndex(cwd, [runA]);

		const first = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => first.push({ message, type }),
			nowMs,
		);
		assert.equal(first.length, 1);
		assert.match(first[0].message, /workflow_alpha/);

		writeUnfinishedNoticeIndex(cwd, [
			runA,
			writeUnfinishedNoticeIndexRun({
				runId: "workflow_beta",
				name: "beta",
				updatedAt: "2026-06-12T11:30:00.000Z",
			}),
		]);

		const second = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => second.push({ message, type }),
			nowMs + 60_000,
		);
		assert.equal(second.length, 1);
		assert.match(second[0].message, /workflow_beta/);
		assert.doesNotMatch(second[0].message, /workflow_alpha/);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

for (const invalid of [
	"{",
	"null",
	JSON.stringify({ notices: [] }),
	JSON.stringify({ notices: 42 }),
	JSON.stringify({ notices: { workflow_recent: "bad" } }),
]) {
	test(`malformed notice state never suppresses a current notice: ${invalid}`, async () => {
		const cwd = makeProject();
		try {
			const indexDir = writeUnfinishedNoticeIndex(cwd, [
				writeUnfinishedNoticeIndexRun({
					runId: "workflow_recent",
					name: "deep-research",
				}),
			]);
			writeFileSync(join(indexDir, "unfinished-notices.json"), invalid);
			const notices = [];
			await notifyUnfinishedRuns(
				cwd,
				(message, type) => notices.push({ message, type }),
				Date.parse("2026-06-12T12:00:00.000Z"),
			);
			assert.equal(notices.length, 1);
			assert.match(notices[0].message, /workflow_recent/);
		} finally {
			rmSync(cwd, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 10,
			});
		}
	});
}
