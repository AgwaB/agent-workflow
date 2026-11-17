// Timeout salvage: a task that hits its runtime limit stays failed/timeout (fail closed) but the
// worker output it had written is kept as evidence and named in the failure — never as a result.
import { stateDir } from "../helpers/state-dir.mjs";
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import {
	assert,
	compileWorkflow,
	createWorkflowRunRecord,
	dirname,
	existsSync,
	join,
	makeProject,
	mkdirSync,
	readFileSync,
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

const setWorkerApiForTests = withMaterializedRawHost(setRawApi);
const VALID_OUTPUT =
	'<control>{"schema":"stage-control-v1","digest":"late","ok":true}</control><analysis>Complete-looking text.</analysis><refs>[]</refs>';

// `engine`: the engine's own deadline fires while the worker still reports running.
// `executor`: the executor reports the timeout as a terminal failure.
async function timedOutTask({ via, output }) {
	const cwd = makeProject();
	writeAgent(cwd, "unit-scout", "read");
	const spec = workflowSpec("unit-scout", {
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Return output." }],
		},
	});
	const compiled = await compileWorkflow(spec, { cwd, task: "timeout" });
	const { run } = await createWorkflowRunRecord(
		cwd,
		compiled,
		join(cwd, "workflows", "unit.json"),
	);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	const task = run.tasks[0];
	task.status = "running";
	task.statusDetail = "running";
	task.runtime.maxRuntimeMs = 1000;
	task.startedAt = new Date(Date.now() - 60_000).toISOString();
	task.workerHandle = {
		runId: "run_to",
		attemptId: "attempt_to",
		cwd,
		runsDir: ".agent-workflow/worker-runs/to",
		display: "worker run run_to/attempt_to",
	};
	const relative = ".fake-timeout-worker";
	mkdirSync(join(cwd, relative), { recursive: true });
	writeFileSync(join(cwd, relative, "output.log"), output);
	writeFileSync(join(cwd, relative, "stderr.log"), "");
	const terminal = via === "executor";
	writeFileSync(
		join(cwd, relative, "result.json"),
		JSON.stringify({
			status: terminal ? "failed" : "running",
			failureKind: terminal ? "timeout" : null,
			startedAt: task.startedAt,
			completedAt: new Date().toISOString(),
			exitCode: terminal ? 1 : 0,
			cwd,
			metadata: { outputPartial: true },
		}),
	);
	let interrupts = 0;
	setWorkerApiForTests({
		async runWorker() {
			throw new Error("No retry or provider launch permitted");
		},
		async reconcileWorkerRun() {
			return {};
		},
		async interruptWorker() {
			interrupts += 1;
			return {
				runId: "run_to",
				status: "interrupt-requested",
				interruptedAttempts: ["attempt_to"],
				unsupportedAttempts: [],
				record: {
					status: "cancelled",
					attempts: [{ attemptId: "attempt_to", status: "cancelled" }],
				},
			};
		},
		async getWorkerStatus() {
			return {
				runId: "run_to",
				attemptId: "attempt_to",
				executorId: "headless",
				status: terminal ? "failed" : "running",
				failureKind: terminal ? "timeout" : null,
				startedAt: task.startedAt,
				...(terminal ? { completedAt: new Date().toISOString() } : {}),
				logs: [
					{ type: "output", path: `${relative}/output.log`, artifactCwd: cwd },
					{ type: "stderr", path: `${relative}/stderr.log`, artifactCwd: cwd },
					...(terminal
						? [
								{
									type: "result",
									path: `${relative}/result.json`,
									artifactCwd: cwd,
								},
							]
						: []),
				],
				metadata: { outputPartial: true },
				attempts: [
					{
						attemptId: "attempt_to",
						status: terminal ? "failed" : "running",
						pid: 99999999,
					},
				],
			};
		},
	});
	await writeRunRecord(cwd, run);
	const refreshed = await refreshRunFromWorkerArtifacts(
		cwd,
		await readRunRecord(cwd, run.runId),
	);
	const current = refreshed.tasks[0];
	const resultFile = join(stateDir(cwd), current.files.result);
	return {
		cwd,
		current,
		interrupts,
		result: existsSync(resultFile)
			? JSON.parse(readFileSync(resultFile, "utf8"))
			: undefined,
		output: readFileSync(join(stateDir(cwd), current.files.output), "utf8"),
		controlExists: existsSync(join(dirname(resultFile), "control.json")),
	};
}

function cleanup(cwd) {
	setWorkerApiForTests(undefined);
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
}

for (const via of ["engine", "executor"]) {
	test(`timeout (${via}): partial output is kept, named and never a result`, async () => {
		const t = await timedOutTask({
			via,
			output: "read files; findings so far…",
		});
		try {
			assert.equal(t.current.status, "failed");
			assert.equal(t.current.statusDetail, "timeout");
			assert.equal(t.output, "read files; findings so far…");
			assert.match(
				t.current.lastMessage,
				/task exceeded timeout=1000; partial worker output \(\d+ bytes, unvalidated\) kept in .*output\.log/,
			);
			assert.equal(t.result.failureKind, "timeout");
			assert.equal(t.result.status, "failed");
			assert.equal(t.result.timedOutPartial.validated, false);
			assert.equal(t.result.timedOutPartial.outputBytes, 30);
			assert.equal(t.current.timedOutPartial.validated, false);
			assert.equal(t.controlExists, false);
			assert.equal(t.result.outputValidation, undefined);
			if (via === "engine") assert.equal(t.interrupts, 1);
		} finally {
			cleanup(t.cwd);
		}
	});

	test(`timeout (${via}): even complete-looking output stays failed without control`, async () => {
		const t = await timedOutTask({ via, output: VALID_OUTPUT });
		try {
			assert.equal(t.current.status, "failed");
			assert.equal(t.current.statusDetail, "timeout");
			assert.equal(t.controlExists, false);
			assert.equal(t.result.outputValidation, undefined);
		} finally {
			cleanup(t.cwd);
		}
	});

	test(`timeout (${via}): empty output records no partial`, async () => {
		const t = await timedOutTask({ via, output: "" });
		try {
			assert.equal(t.current.status, "failed");
			assert.equal(t.current.statusDetail, "timeout");
			assert.equal(t.current.lastMessage, "task exceeded timeout=1000");
			assert.equal(t.current.timedOutPartial, undefined);
			assert.equal(t.result?.timedOutPartial, undefined);
		} finally {
			cleanup(t.cwd);
		}
	});
}
