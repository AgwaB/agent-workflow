import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../dist/hosts/args.js";
import {
	estimateWorkflowDurationMs,
	findDuplicateActiveRun,
	formatApproxDuration,
} from "../../dist/core/run-estimates.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "run-estimates-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const NOW = Date.parse("2026-07-07T12:00:00.000Z");
const MINUTE_MS = 60_000;

function makeProject() {
	return mkdtempSync(join(tmpdir(), "run-estimates-"));
}

function emptyTaskSummary() {
	return {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
	};
}

function indexRun(runId, overrides = {}) {
	return {
		runId,
		name: "deep-research",
		type: "artifact-graph",
		status: "completed",
		taskSummary: emptyTaskSummary(),
		createdAt: new Date(NOW - 5 * MINUTE_MS).toISOString(),
		updatedAt: new Date(NOW).toISOString(),
		runJson: join(".agent-workflow", "workflows", runId, "run.json"),
		...overrides,
	};
}

function writeIndex(cwd, runs) {
	const dir = join(cwd, ".agent-workflow", "workflows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: new Date(NOW).toISOString(),
			runs,
		}),
	);
}

function writeRunFiles(cwd, runId, { run, compiled } = {}) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	mkdirSync(dir, { recursive: true });
	if (run !== undefined)
		writeFileSync(join(dir, "run.json"), JSON.stringify(run));
	if (compiled !== undefined)
		writeFileSync(join(dir, "compiled.json"), JSON.stringify(compiled));
}

function completedRun(runId, wallMinutes, ageMinutes, overrides = {}) {
	const createdAtMs = NOW - ageMinutes * MINUTE_MS;
	return indexRun(runId, {
		createdAt: new Date(createdAtMs).toISOString(),
		updatedAt: new Date(createdAtMs + wallMinutes * MINUTE_MS).toISOString(),
		...overrides,
	});
}

test("estimateWorkflowDurationMs returns the median of the most recent completed same-name runs", async () => {
	const cwd = makeProject();
	try {
		const runs = [];
		// 10 completed same-name runs; only the 8 most recent may be sampled.
		// Recent walls 2,4,...,16 minutes → median (8+10)/2 = 9 minutes. The two
		// oldest runs have 100-minute walls and must fall outside the sample cap.
		for (let i = 0; i < 8; i += 1) {
			runs.push(completedRun(`workflow_recent_${i}`, 2 * (i + 1), 60 + i * 10));
		}
		runs.push(completedRun("workflow_old_1", 100, 500));
		runs.push(completedRun("workflow_old_2", 100, 510));
		// Noise that must be ignored entirely.
		runs.push(completedRun("workflow_other", 1, 30, { name: "other" }));
		runs.push(
			completedRun("workflow_child", 1, 30, {
				parentRunId: "workflow_recent_0",
			}),
		);
		runs.push(completedRun("workflow_running", 1, 30, { status: "running" }));
		writeIndex(cwd, runs);

		const estimate = await estimateWorkflowDurationMs(cwd, "deep-research");
		assert.deepEqual(estimate, { medianMs: 9 * MINUTE_MS, samples: 8 });
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("estimateWorkflowDurationMs excludes mock runs and needs at least two samples", async () => {
	const cwd = makeProject();
	try {
		writeIndex(cwd, [
			completedRun("workflow_real", 10, 60),
			completedRun("workflow_mock", 50, 30),
		]);
		writeRunFiles(cwd, "workflow_mock", {
			run: {
				schemaVersion: 1,
				runId: "workflow_mock",
				status: "completed",
				provenance: { mode: "mock-screenshot" },
				tasks: [],
			},
		});

		// Mock run filtered out → one sample left → no estimate.
		assert.equal(
			await estimateWorkflowDurationMs(cwd, "deep-research"),
			undefined,
		);
		assert.equal(await estimateWorkflowDurationMs(cwd, "unknown"), undefined);
		assert.equal(await estimateWorkflowDurationMs(cwd, undefined), undefined);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("formatApproxDuration renders compact durations", () => {
	assert.equal(formatApproxDuration(45_000), "45s");
	assert.equal(formatApproxDuration(18 * MINUTE_MS), "18m");
	assert.equal(formatApproxDuration(2 * 60 * MINUTE_MS), "2h");
	assert.equal(formatApproxDuration(125 * MINUTE_MS), "2h 5m");
});

function seedActiveDuplicate(
	cwd,
	{ runId = "workflow_active1", ...rest } = {},
) {
	writeIndex(cwd, [
		indexRun(runId, {
			name: "guard-target",
			status: "running",
			createdAt: new Date(NOW - 2 * MINUTE_MS).toISOString(),
			updatedAt: new Date(NOW - MINUTE_MS).toISOString(),
			...rest,
		}),
	]);
	writeRunFiles(cwd, runId, {
		run: {
			schemaVersion: 1,
			runId,
			name: "guard-target",
			status: "running",
			tasks: [],
		},
		compiled: {
			schemaVersion: 1,
			name: "guard-target",
			task: "Investigate the flaky login test",
			tasks: [],
		},
	});
	return runId;
}

test("findDuplicateActiveRun matches active same-name byte-identical-task runs within the window", async () => {
	const cwd = makeProject();
	try {
		const runId = seedActiveDuplicate(cwd);
		const target = { kind: "spec", name: "guard-target" };

		const match = await findDuplicateActiveRun(
			cwd,
			target,
			"Investigate the flaky login test",
			{ now: NOW },
		);
		assert.equal(match?.runId, runId);

		// Different task text → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(cwd, target, "A different task", {
				now: NOW,
			}),
			undefined,
		);
		// Different workflow name → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "spec", name: "other" },
				"Investigate the flaky login test",
				{ now: NOW },
			),
			undefined,
		);
		// Spec runs never satisfy a dynamic launch.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "dynamic" },
				"Investigate the flaky login test",
				{ now: NOW },
			),
			undefined,
		);
		// Outside the 10-minute window → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				target,
				"Investigate the flaky login test",
				{ now: NOW + 11 * MINUTE_MS },
			),
			undefined,
		);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("findDuplicateActiveRun ignores child, terminal, and mock runs and matches dynamic runs by provenance", async () => {
	const cwd = makeProject();
	try {
		const task = "Dynamic duplicate task";
		writeIndex(cwd, [
			indexRun("workflow_dynamic1", {
				name: "dynamic",
				status: "running",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_child", {
				name: "guard-target",
				status: "running",
				parentRunId: "workflow_dynamic1",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_done", {
				name: "guard-target",
				status: "completed",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_mockrun", {
				name: "guard-target",
				status: "running",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
		]);
		writeRunFiles(cwd, "workflow_dynamic1", {
			run: {
				schemaVersion: 1,
				runId: "workflow_dynamic1",
				status: "running",
				provenance: { mode: "direct-dynamic" },
				tasks: [],
			},
			compiled: { schemaVersion: 1, name: "dynamic", task, tasks: [] },
		});
		for (const runId of [
			"workflow_child",
			"workflow_done",
			"workflow_mockrun",
		]) {
			writeRunFiles(cwd, runId, {
				run: {
					schemaVersion: 1,
					runId,
					status: "running",
					...(runId === "workflow_mockrun"
						? { provenance: { mode: "mock" } }
						: {}),
					tasks: [],
				},
				compiled: { schemaVersion: 1, name: "guard-target", task, tasks: [] },
			});
		}

		const match = await findDuplicateActiveRun(cwd, { kind: "dynamic" }, task, {
			now: NOW,
		});
		assert.equal(match?.runId, "workflow_dynamic1");

		// Child/terminal/mock candidates never block a spec launch.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "spec", name: "guard-target" },
				task,
				{ now: NOW },
			),
			undefined,
		);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("parseWorkflowRunArgs and parseWorkflowDynamicArgs parse --force-new at either boundary", () => {
	assert.equal(
		parseWorkflowRunArgs('run --force-new review "Task"').forceNew,
		true,
	);
	assert.equal(
		parseWorkflowRunArgs('run review "Task" --force-new').forceNew,
		true,
	);
	assert.equal(parseWorkflowRunArgs('run review "Task"').forceNew, undefined);
	const literal = parseWorkflowRunArgs(
		'run review "Keep literal --force-new inside"',
	);
	assert.equal(literal.forceNew, undefined);
	assert.equal(literal.task, "Keep literal --force-new inside");
	assert.equal(
		parseWorkflowDynamicArgs('dynamic --force-new "Task"').forceNew,
		true,
	);
	assert.equal(
		parseWorkflowDynamicArgs('dynamic "Task" --force-new').forceNew,
		true,
	);
});
