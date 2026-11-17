// test-tier: integration
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import { stateDir } from "../helpers/state-dir.mjs";
import {
	assert,
	compileWorkflow,
	createWorkflowRunRecord,
	dirname,
	existsSync,
	join,
	makeProject,
	mkdirSync,
	readRunRecord,
	refreshRunFromWorkerArtifacts,
	rmSync,
	setTaskRuntimeApiForTests as setRawApi,
	test,
	workflowSpec,
	writeAgent,
	writeFileSync,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../helpers/unit-test-support.mjs";

const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);
const ARTIFACT_TOOL = "mcp__workflow_artifact__workflow_artifact";
const BUSY =
	'503: {"message":"The model is busy. Retry shortly.","type":"server_error","code":"upstream_busy"}';

function summaryOf(callsByTool, extra = {}) {
	const totalCalls = Object.values(callsByTool).reduce((a, b) => a + b, 0);
	return {
		schemaVersion: 1,
		enabled: true,
		totalCalls,
		callsByTool,
		droppedRecords: 0,
		...extra,
	};
}

/** Runs one failed worker attempt with partial output through refresh; returns the refreshed task. */
async function refreshFailedAttempt({
	failureKind = "transient",
	output = "I'll start by examining the source files.",
	summary,
	contextLengthExceeded = false,
	configuredTools,
	bootstrapTools = configuredTools, // null: no launch record
	inheritHostTools,
}) {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Do work." }],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		if (configuredTools !== undefined) task.tools = configuredTools;
		if (bootstrapTools !== undefined && bootstrapTools !== null)
			task.launchBootstrap = {
				version: 1,
				records: [
					{
						effectivePolicy: {
							tools: bootstrapTools,
							...(inheritHostTools ? { inheritHostTools: true } : {}),
						},
					},
				],
			};
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.workerHandle = {
			runId: "run_partial",
			attemptId: "attempt_partial",
			cwd,
			runsDir: ".agent-workflow/worker-runs/partial",
			display: "worker run run_partial/attempt_partial",
		};
		const artifactDir = join(cwd, ".fake-model-worker");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "output.log"), output);
		writeFileSync(join(artifactDir, "stderr.log"), `${BUSY}\n`);
		const artifacts = [
			{
				type: "output",
				path: ".fake-model-worker/output.log",
				artifactCwd: cwd,
			},
			{
				type: "stderr",
				path: ".fake-model-worker/stderr.log",
				artifactCwd: cwd,
			},
			{
				type: "result",
				path: ".fake-model-worker/result.json",
				artifactCwd: cwd,
			},
		];
		if (summary !== undefined) {
			writeFileSync(
				join(artifactDir, "tool-calls-summary.json"),
				JSON.stringify(summary),
			);
			artifacts.push({
				type: "tool-calls-summary",
				path: ".fake-model-worker/tool-calls-summary.json",
				artifactCwd: cwd,
			});
		}
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "failed",
				failureKind,
				exitCode: 0,
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				errorMessage: BUSY,
				metadata: { contextLengthExceeded, stopReason: "error" },
				artifacts,
			}),
		);
		setTaskRuntimeApiForTests({
			async runWorker() {
				throw new Error("not expected");
			},
			async reconcileWorkerRun() {
				return {};
			},
			async getWorkerStatus() {
				return {
					runId: "run_partial",
					attemptId: "attempt_partial",
					executorId: "headless",
					status: "failed",
					failureKind,
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: artifacts.filter((a) =>
						["output", "stderr", "result"].includes(a.type),
					),
					artifacts,
					metadata: { contextLengthExceeded, stopReason: "error" },
					attempts: [
						{ attemptId: "attempt_partial", status: "failed", pid: 99999999 },
					],
				};
			},
			async interruptWorker() {
				return {};
			},
		});
		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromWorkerArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		const refreshedTask = refreshed.tasks[0];
		const attemptFile = join(
			stateDir(cwd),
			dirname(refreshedTask.files.result),
			"result.transient-model-failure-1.json",
		);
		return { task: refreshedTask, retryFileExists: existsSync(attemptFile) };
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
}

function assertRetried({ task, retryFileExists }) {
	assert.equal(task.status, "pending");
	assert.equal(task.statusDetail, "retry_model_failure");
	assert.equal(task.launchRetry?.attempts, 1);
	assert.equal(retryFileExists, true);
}

function assertNotRetried({ task, retryFileExists }) {
	assert.equal(task.status, "failed");
	assert.equal(task.launchRetry, undefined);
	assert.equal(retryFileExists, false);
}

test("partial output + transient + only read-only tools is retried", async () => {
	assertRetried(
		await refreshFailedAttempt({
			summary: summaryOf({ read: 3, grep: 2, find: 1, ls: 1 }),
		}),
	);
});

test("partial output + transient + the workflow_artifact tool is retried", async () => {
	assertRetried(
		await refreshFailedAttempt({
			summary: summaryOf({ [ARTIFACT_TOOL]: 2, read: 1 }),
		}),
	);
});

for (const tool of ["write", "edit", "bash", "codemode", "web_search"])
	test(`partial output + transient + a ${tool} call is not retried`, async () => {
		assertNotRetried(
			await refreshFailedAttempt({
				summary: summaryOf({ read: 2, [tool]: 1 }),
			}),
		);
	});

test("partial output + unknown failure is not retried even with read-only tools", async () => {
	assertNotRetried(
		await refreshFailedAttempt({
			failureKind: "unknown",
			summary: summaryOf({ read: 2 }),
		}),
	);
});

test("partial output with no tool-call evidence is not retried (fail closed)", async () => {
	assertNotRetried(await refreshFailedAttempt({ summary: undefined }));
});

test("partial output with dropped tool-call records or an inconsistent total is not retried", async () => {
	assertNotRetried(
		await refreshFailedAttempt({
			summary: summaryOf({ read: 2 }, { droppedRecords: 3 }),
		}),
	);
	assertNotRetried(
		await refreshFailedAttempt({
			summary: summaryOf({ read: 2 }, { totalCalls: 5 }),
		}),
	);
});

test("partial output + read-only tools but context length exceeded is not retried", async () => {
	assertNotRetried(
		await refreshFailedAttempt({
			contextLengthExceeded: true,
			summary: summaryOf({ read: 2 }),
		}),
	);
});

test("zero output is still retried without any tool evidence", async () => {
	assertRetried(await refreshFailedAttempt({ output: "", summary: undefined }));
});

const READ_ONLY = ["read", "grep", "find", "ls"];

test("configured read-only tools prove side-effect freedom without any tool-call capture", async () => {
	assertRetried(
		await refreshFailedAttempt({
			summary: undefined,
			configuredTools: [...READ_ONLY, "workflow_artifact"],
		}),
	);
	assertRetried(
		await refreshFailedAttempt({
			summary: undefined,
			configuredTools: [ARTIFACT_TOOL, "read"],
		}),
	);
});

for (const [name, opts] of [
	["write", { configuredTools: [...READ_ONLY, "write"] }],
	["edit", { configuredTools: ["read", "edit"] }],
	["bash", { configuredTools: ["read", "bash"] }],
	[
		"an unknown provider tool",
		{ configuredTools: ["read", "mcp__other__lookup"] },
	],
	[
		"inherited host tools",
		{ configuredTools: READ_ONLY, inheritHostTools: true },
	],
	[
		"a mutating tool only in the launch record",
		{ configuredTools: READ_ONLY, bootstrapTools: ["read", "bash"] },
	],
	["no configured set", {}],
	["an empty configured set", { configuredTools: [], bootstrapTools: [] }],
	["no launch record", { configuredTools: READ_ONLY, bootstrapTools: null }],
])
	test(`no capture + ${name} is not retried`, async () => {
		assertNotRetried(
			await refreshFailedAttempt({ summary: undefined, ...opts }),
		);
	});

test("the call-summary proof stays an alternative to the configured-set proof", async () => {
	assertRetried(
		await refreshFailedAttempt({
			summary: summaryOf({ read: 1 }),
			configuredTools: ["read", "bash"],
		}),
	);
});
test("negative or fractional counts in the summary are not retried", async () => {
	for (const callsByTool of [
		{ read: -1 },
		{ read: 1.5 },
		{ read: 2, grep: -1 },
	])
		assertNotRetried(
			await refreshFailedAttempt({
				summary: {
					schemaVersion: 1,
					enabled: true,
					totalCalls: Object.values(callsByTool).reduce((a, b) => a + b, 0),
					callsByTool,
					droppedRecords: 0,
				},
			}),
		);
	assertNotRetried(
		await refreshFailedAttempt({
			summary: { ...summaryOf({ read: 1 }), totalCalls: -1 },
		}),
	);
});
