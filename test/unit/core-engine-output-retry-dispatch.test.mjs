// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { refreshRun, runWorkflow, waitForRun } from "../../dist/core/engine.js";
import {
	formatHumanRunOutcome,
	formatHumanRunStatus,
	formatRun,
} from "../../dist/core/engine-format.js";
import { ARTIFACT_OUTPUT_RETRIES_ENV } from "../../dist/core/retry-policy.js";
import { setTaskRuntimeApiForTests as setRawApi } from "../../dist/core/runtime-port.js";

import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import "../helpers/register-default-executor.mjs";
const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);

const UNIT_TEST_HOME = mkdtempSync(
	join(tmpdir(), "workflow-retry-dispatch-home-"),
);
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

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-retry-dispatch-"));
}

function writeAgent(cwd, name) {
	const dir = join(cwd, ".agent-workflow", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function writeWorkflow(cwd, name, stages) {
	const workflowDir = join(cwd, "workflows", name);
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: stages ?? [
					{
						id: "main",
						type: "single",
						output: {
							analysis: { required: true },
							refs: { required: true },
						},
						prompt: "Do the work.",
					},
				],
			},
		}),
	);
}

const TWO_STAGE_SPEC = [
	{
		id: "first",
		type: "single",
		output: { analysis: { required: true }, refs: { required: true } },
		prompt: "Do the first stage.",
	},
	{
		id: "second",
		type: "single",
		after: ["first"],
		output: { analysis: { required: true }, refs: { required: true } },
		prompt: "Do the second stage.",
	},
];

const VALID_OUTPUT = [
	"<control>",
	JSON.stringify({ schema: "stage-control-v1", digest: "done" }),
	"</control>",
	"<analysis>",
	"Completed with a valid workflow output contract.",
	"</analysis>",
	"<refs>",
	"[]",
	"</refs>",
].join("\n");

// Malformed control JSON: process exits 0, but workflow output validation
// must reject it and schedule a bounded output retry (the July-4 signature).
const INVALID_OUTPUT = [
	"<control>",
	'{"schema": "stage-control-v1", "digest": }',
	"</control>",
	"<analysis>",
	"Completed at the process level but the control JSON is malformed.",
	"</analysis>",
	"<refs>",
	"[]",
	"</refs>",
].join("\n");

function writeWorkerArtifacts(cwd, runsDir, runId, attemptId, outputText) {
	const artifactDir = join(
		stateDir(cwd),
		runsDir,
		runId,
		"attempts",
		attemptId,
	);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "output.log"), outputText);
	writeFileSync(join(artifactDir, "stderr.log"), "");
	writeFileSync(
		join(artifactDir, "result.json"),
		JSON.stringify({
			status: "completed",
			completedAt: new Date().toISOString(),
			startedAt: new Date(Date.now() - 1000).toISOString(),
			exitCode: 0,
		}),
	);
	return artifactDir;
}

function makeFakeWorkerApi({ cwd, runs, outputsByLaunch, onLaunch }) {
	return {
		async runWorker(options) {
			const launchIndex = onLaunch();
			const runId = `run_retry_dispatch_${launchIndex}`;
			const attemptId = `attempt_retry_dispatch_${launchIndex}`;
			const runsDir = String(options.runsDir ?? ".agent-workflow/runs");
			const outputText =
				outputsByLaunch[launchIndex - 1] ??
				outputsByLaunch[outputsByLaunch.length - 1];
			const artifactDir = writeWorkerArtifacts(
				cwd,
				runsDir,
				runId,
				attemptId,
				outputText,
			);
			runs.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileWorkerRun() {
			return {};
		},
		async getWorkerStatus({ runId }) {
			const run = runs.get(runId);
			assert.ok(run, `missing worker run ${runId}`);
			return {
				runId,
				attemptId: run.attemptId,
				executorId: "headless",
				status: "completed",
				failureKind: null,
				startedAt: new Date(Date.now() - 1000).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: run.attemptId, status: "completed" }],
			};
		},
		async interruptWorker() {
			return {};
		},
	};
}

test("a task whose attempt passed output validation is never re-dispatched by later refreshes", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "valid-once");
		setTaskRuntimeApiForTests(
			makeFakeWorkerApi({
				cwd,
				runs,
				outputsByLaunch: [VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("valid-once", cwd, {
			task: "Exercise the completed-task dispatch invariant.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.equal(completed.tasks[0].status, "completed");
		assert.equal(completed.tasks[0].outputRetry, undefined);
		assert.equal(launchCount, 1);

		// Invariant under test: refresh/reconcile after completion must never
		// launch another worker run for a task with a valid completed attempt.
		for (let i = 0; i < 3; i += 1) {
			const refreshed = await refreshRun(cwd, started.runId);
			assert.equal(refreshed.status, "completed");
			assert.equal(refreshed.tasks[0].status, "completed");
		}
		assert.equal(launchCount, 1);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a completed upstream task is not re-dispatched while downstream stages still schedule", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "two-stage", TWO_STAGE_SPEC);
		setTaskRuntimeApiForTests(
			makeFakeWorkerApi({
				cwd,
				runs,
				outputsByLaunch: [VALID_OUTPUT, VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("two-stage", cwd, {
			task: "Exercise completed-task invariance across later scheduler ticks.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		for (const task of completed.tasks) {
			assert.equal(task.status, "completed");
		}

		// The scheduler ticks that launch stage "second" must not re-dispatch
		// the already-completed stage "first": exactly one launch per stage.
		assert.equal(launchCount, 2);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("zero output retry override fails the first invalid workflow output", async () => {
	const cwd = makeProject();
	const runs = new Map();
	const previous = process.env[ARTIFACT_OUTPUT_RETRIES_ENV];
	let launchCount = 0;
	process.env[ARTIFACT_OUTPUT_RETRIES_ENV] = "0";
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "invalid-no-retry");
		setTaskRuntimeApiForTests(
			makeFakeWorkerApi({
				cwd,
				runs,
				outputsByLaunch: [INVALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("invalid-no-retry", cwd, {
			task: "Exercise disabled output-invalid retry dispatch.",
		});
		const failed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(failed.status, "failed");
		assert.equal(failed.tasks[0].status, "failed");
		assert.equal(failed.tasks[0].outputRetry?.attempts, 1);
		assert.equal(failed.tasks[0].outputRetry?.maxAttempts, 0);
		assert.equal(launchCount, 1);
	} finally {
		if (previous === undefined) delete process.env[ARTIFACT_OUTPUT_RETRIES_ENV];
		else process.env[ARTIFACT_OUTPUT_RETRIES_ENV] = previous;
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("workflow-invalid output triggers exactly one bounded repair launch, then no further dispatch", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "invalid-then-valid");
		setTaskRuntimeApiForTests(
			makeFakeWorkerApi({
				cwd,
				runs,
				outputsByLaunch: [INVALID_OUTPUT, VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("invalid-then-valid", cwd, {
			task: "Exercise bounded output-invalid retry dispatch.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		const task = completed.tasks[0];
		assert.equal(task.status, "completed");

		// The July-4 evidence signature: the first process-level success failed
		// workflow output validation and was retried as a bounded repair, recorded
		// in outputRetry. This fake worker does not confirm a resumable session,
		// so it exercises the new-session fallback path.
		assert.equal(launchCount, 2);
		assert.ok(task.outputRetry, "outputRetry record must be preserved");
		assert.equal(task.outputRetry.attempts, 1);
		assert.equal(task.outputRetry.reason, "workflow_output_invalid");
		assert.equal(task.outputRetry.repairMode, "new_session");

		// Once the repair attempt validates, the task is terminal: further
		// refreshes must not dispatch a third run.
		for (let i = 0; i < 3; i += 1) {
			const refreshed = await refreshRun(cwd, started.runId);
			assert.equal(refreshed.status, "completed");
			assert.equal(refreshed.tasks[0].status, "completed");
		}
		assert.equal(launchCount, 2);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function runEmptyInventory(
	control,
	check,
	{ closedSchema = false } = {},
) {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout");
		const name = "empty-inventory";
		writeWorkflow(cwd, name, [
			{
				id: "inventory",
				type: "single",
				output: {
					analysis: { required: true },
					controlSchema: "./schemas/inventory.schema.json",
				},
				prompt: "List the items.",
			},
			{
				id: "work",
				type: "foreach",
				from: { source: "inventory", path: "$.items" },
				output: { analysis: { required: true } },
				each: { itemIdentityPath: "$.id", prompt: "Work ${item}." },
			},
			{
				id: "report",
				type: "reduce",
				from: ["inventory", "work"],
				output: { analysis: { required: true } },
				prompt: "Report.",
			},
		]);
		mkdirSync(join(cwd, "workflows", name, "schemas"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", name, "schemas", "inventory.schema.json"),
			JSON.stringify({
				type: "object",
				required: ["digest", "items"],
				...(closedSchema ? { additionalProperties: false } : {}),
				properties: {
					...(closedSchema ? { schema: { type: "string" } } : {}),
					digest: { type: "string" },
					items: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							required: ["id"],
							properties: { id: { type: "string" } },
						},
					},
				},
			}),
		);
		const emptyAnswer = [
			"<control>",
			JSON.stringify(control),
			"</control>",
			"<analysis>",
			"Nothing to inventory.",
			"</analysis>",
			"<refs>[]</refs>",
		].join("\n");
		const api = makeFakeWorkerApi({
			cwd,
			runs,
			outputsByLaunch: [emptyAnswer],
			onLaunch: () => {
				launchCount += 1;
				return launchCount;
			},
		});
		const runWorker = api.runWorker;
		api.runWorker = async (options) => {
			prompts.push(String(options.prompt ?? options.task ?? ""));
			return runWorker(options);
		};
		setTaskRuntimeApiForTests(api);

		const started = await runWorkflow(name, cwd, {
			task: "Exercise an empty required list.",
		});
		const failed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(failed.status, "failed");
		if (check) {
			check(failed, { launchCount, prompts });
			return;
		}
		assert.equal(launchCount, 3, "default 2 retries = 3 attempts");
		const inventory = failed.tasks.find((t) => t.specId === "inventory.main");
		assert.equal(inventory.status, "failed");
		const message = inventory.lastMessage;
		assert.match(message, /^inventory returned an empty `items` list/);
		assert.match(message, /\(at least 1 required\) after 3 attempts/);
		assert.match(message, /The model said: "There are no items to list\."/);
		assert.doesNotMatch(message, /array length must be/);
		// Later stages never ran on nothing.
		const downstream = failed.tasks.filter((t) => t !== inventory);
		assert.deepEqual(
			downstream.map((t) => [t.specId, t.status]),
			[
				["work.item", "skipped"],
				["report.main", "skipped"],
			],
		);
		assert.equal(launchCount, 3, "no launch for the skipped stages");
		for (const text of [
			formatRun(failed),
			formatHumanRunStatus(failed),
			formatHumanRunOutcome(failed),
		])
			assert.ok(text.includes(message), text);
		// The retry prompt tells the model the list must not be empty.
		assert.match(
			inventory.outputRetry?.message ?? "",
			/must contain at least 1 item\(s\)\. Do not invent items\./,
		);
		assert.doesNotMatch(
			inventory.outputRetry?.message ?? "",
			/answer with \[\]/,
		);
		assert.match(
			inventory.outputRetry?.message ?? "",
			/inputIntegrity \{status: "blocked", reason: "inconsistent_input", detail:/,
		);
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}

test("an empty required list fails the task in plain words and skips later stages", () =>
	runEmptyInventory({
		schema: "inventory-v1",
		digest: "There are no items to list.",
		items: [],
	}));

test("an empty list next to another output problem keeps the full validation message", () =>
	runEmptyInventory(
		{ schema: "inventory-v1", digest: 42, items: [] },
		(failed) => {
			const inventory = failed.tasks.find((t) => t.specId === "inventory.main");
			assert.equal(inventory.status, "failed");
			assert.doesNotMatch(inventory.lastMessage, /returned an empty/);
			assert.match(inventory.lastMessage, /digest/);
		},
	));

const BLOCK = {
	status: "blocked",
	reason: "inconsistent_input",
	detail: "src/ has no exported functions to list",
};

function assertHonestBlock(failed, { launchCount }) {
	const inventory = failed.tasks.find((t) => t.specId === "inventory.main");
	assert.equal(launchCount, 1, "an accepted block is not retried");
	assert.equal(inventory.status, "failed");
	assert.equal(inventory.statusDetail, "input_integrity_blocked");
	assert.equal(inventory.outputRetry, undefined);
	assert.match(
		inventory.lastMessage,
		/^inventory stopped: the model reported it could not do the task: "src\/ has no exported functions to list"/,
	);
	assert.doesNotMatch(inventory.lastMessage, /inputIntegrity\.status/);
	assert.deepEqual(
		failed.tasks
			.filter((t) => t !== inventory)
			.map((t) => [t.specId, t.status]),
		[
			["work.item", "skipped"],
			["report.main", "skipped"],
		],
	);
	for (const text of [
		formatRun(failed),
		formatHumanRunStatus(failed),
		formatHumanRunOutcome(failed),
	])
		assert.ok(text.includes(inventory.lastMessage), text);
}

test("empty items plus an accepted inputIntegrity block under minItems fails once, no retry", () =>
	runEmptyInventory(
		{
			schema: "inventory-v1",
			digest: "none",
			items: [],
			inputIntegrity: BLOCK,
		},
		assertHonestBlock,
	));

test("a closed schema without inputIntegrity still honours the block", () =>
	runEmptyInventory(
		{
			schema: "inventory-v1",
			digest: "none",
			items: [],
			inputIntegrity: BLOCK,
		},
		assertHonestBlock,
		{ closedSchema: true },
	));
