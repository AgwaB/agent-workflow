// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-launch-cancellation.test.mjs.
// MIT, same author. Changes: imports from dist/core; setSubagentApiForTests→setTaskRuntimeApiForTests;
// paths .pi/…→.agent-workflow/…. WP38b: the four "auto … cancellation fences first dispatch while
// durable stop publication is delayed" cases are ported at the core level: agent-workflow's
// `/aw auto` (WP32), like `/aw run|dynamic`, returns once the run started (no "Starting …" loader),
// so the engine's in-memory launch fence (`launchSignal`, the signal pi-workflow's start loader
// aborted on Escape) is driven directly through `runWorkflowSpec`/`runDynamicTask`; the
// `auto-router` comparison call and the Pi handler are not involved. In the deadline case the
// pi-workflow Pi warning ("cancellation is still pending" after the 1500 ms stop budget) is a host
// notice agent-workflow has no counterpart for; the port asserts the durable stop intent survives
// past that budget while the competing supervisor holds the lease. The other ten `auto …` cases run
// against `/aw auto` in host-wp38b-auto-launch-cancellation.test.mjs.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import "../helpers/register-default-executor.mjs";
import { setSupportHelperPreparedHookForTests } from "../../dist/core/artifact-graph-runtime.js";
import {
	resumeRun,
	runDynamicTask,
	runWorkflowSpec,
	setDynamicControllerHooksForTests,
	stopRun,
} from "../../dist/core/engine.js";
import { setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import {
	readRunRecord,
	setRunLeaseTestHooksForTests,
	withRunLease,
} from "../../dist/core/store.js";
import {
	bindWorkflowLaunchSignal,
	throwIfWorkflowStopRequested,
} from "../../dist/core/workflow-stop.js";

function writeAgent(cwd, name, tools = ["read"]) {
	const directory = join(cwd, ".agent-workflow", "agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${name}.md`),
		`---\ndescription: ${name}\ntools: ${JSON.stringify(tools)}\nreadOnly: true\n---\n# ${name}\n`,
	);
}

function writeNamedSupportWorkflow(cwd, markerPath) {
	const directory = join(cwd, "workflows", "bound-support");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "helper.mjs"),
		`import { writeFileSync } from "node:fs";\nexport default () => { writeFileSync(${JSON.stringify(markerPath)}, "executed"); return { control: {} }; };\n`,
	);
	writeFileSync(
		join(directory, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "bound-support",
			description: "A local support-only cancellation witness.",
			routing: {
				useWhen: ["Use for a bounded local support witness."],
				avoidWhen: ["Avoid when no workflow is needed."],
				outputs: ["A local witness."],
			},
			defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "first", support: { uses: "./helper.mjs" } }],
			},
		}),
	);
	return join(directory, "spec.json");
}

/** The fake runtime API: any provider action is a cancellation-fence violation. */
function installRuntimeApi(calls) {
	setTaskRuntimeApiForTests({
		async runSubagent() {
			calls.execution += 1;
			throw new Error("a cancelled launch must not create a provider action");
		},
	});
}

async function waitFor(predicate, message, attempts = 200) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(message);
}

/** The single run directory of the project (agent-workflow runs live directly under workflows/). */
function onlyRunDirectory(cwd) {
	const root = join(cwd, ".agent-workflow", "workflows");
	const runs = existsSync(root)
		? readdirSync(root).filter((name) => name.startsWith("workflow_"))
		: [];
	assert.equal(runs.length, 1, `runs: ${runs.join(", ")}`);
	return join(root, runs[0]);
}

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "aw-launch-cancellation-"));
	const markerPath = join(cwd, "first-support-action.txt");
	writeAgent(cwd, "unit-agent");
	writeAgent(cwd, "researcher", [
		"read",
		"grep",
		"find",
		"ls",
		"workflow_web_search",
		"workflow_web_fetch_source",
		"workflow_web_source_read",
	]);
	const specPath = writeNamedSupportWorkflow(cwd, markerPath);
	const calls = { execution: 0 };
	installRuntimeApi(calls);
	return { cwd, markerPath, specPath, calls };
}

async function cleanup(cwd) {
	setSupportHelperPreparedHookForTests(undefined);
	setDynamicControllerHooksForTests();
	setRunLeaseTestHooksForTests();
	setTaskRuntimeApiForTests(undefined);
	if (cwd) rmSync(cwd, { recursive: true, force: true });
}

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	for (const contention of selectedKind === "named-workflow"
		? ["none", "temporary", "deadline"]
		: ["none"]) {
		test(`auto ${selectedKind} cancellation fences first dispatch while durable stop publication is delayed (${contention} lease contention)`, async () => {
			let fixture;
			let runDirectory;
			let releaseStop;
			let stopStarted = false;
			let stopCommitted = false;
			let prepared = false;
			let competing = false;
			let competitor;
			let releaseCompetitor;
			let launching;
			const competitorGate = new Promise((resolve) => {
				releaseCompetitor = resolve;
			});
			const stopGate = new Promise((resolve) => {
				releaseStop = resolve;
			});
			// The signal pi-workflow's foreground start loader aborted on Escape.
			const launch = new AbortController();
			try {
				fixture = await setup();
				setRunLeaseTestHooksForTests({
					async onBeforeAtomicRename({ file }) {
						if (basename(file) !== "stop-intent.json") return;
						stopStarted = true;
						await stopGate;
					},
					onAfterStopIntentWrite({ file }) {
						assert.equal(basename(file), "stop-intent.json");
						stopCommitted = true;
					},
				});
				const cancel = async () => {
					prepared = true;
					runDirectory = onlyRunDirectory(fixture.cwd);
					assert.ok(existsSync(join(runDirectory, "run.json")));
					assert.equal(existsSync(fixture.markerPath), false);
					assert.equal(fixture.calls.execution, 0);
					launch.abort();
					await waitFor(
						() => stopStarted,
						"stop write did not reach the delayed rename",
					);
				};
				if (selectedKind === "named-workflow")
					setSupportHelperPreparedHookForTests(cancel);
				else
					setDynamicControllerHooksForTests({
						beforeControllerWorkerLaunch: cancel,
					});
				const options = {
					task: "Cancel at the prepared first action.",
					launchSignal: launch.signal,
				};
				// The launch settles only after the durable stop is published (held below).
				launching = (
					selectedKind === "named-workflow"
						? runWorkflowSpec(fixture.specPath, fixture.cwd, options)
						: runDynamicTask(fixture.cwd, options)
				).catch((error) => error);
				await waitFor(
					async () =>
						fixture.calls.execution > 0 ||
						existsSync(fixture.markerPath) ||
						(runDirectory &&
							(await readRunRecord(fixture.cwd, basename(runDirectory)))
								.status === "interrupted"),
					"dispatch did not observe the synchronous launch cancellation",
					2_000,
				);
				assert.equal(prepared, true);
				assert.equal(stopStarted, true);
				assert.equal(
					stopCommitted,
					false,
					"stop persistence must still be held for the race witness",
				);
				assert.equal(fixture.calls.execution, 0);
				assert.equal(existsSync(fixture.markerPath), false);
				if (contention !== "none") {
					await waitFor(async () => {
						let entered;
						const entry = new Promise((resolve) => {
							entered = resolve;
						});
						competitor = withRunLease(
							fixture.cwd,
							basename(runDirectory),
							async () => {
								competing = true;
								entered();
								await competitorGate;
							},
						);
						await Promise.race([entry, competitor]);
						return competing;
					}, "competing supervisor did not acquire its lease");
				}
				releaseStop();
				await waitFor(() => stopCommitted, "durable stop was not published");
				if (contention === "deadline") {
					// Beyond pi-workflow's unchanged 1500 ms stop budget: the intent stays durable.
					await new Promise((resolve) => setTimeout(resolve, 1_700));
					assert.ok(existsSync(join(runDirectory, "stop-intent.json")));
					assert.notEqual(
						(await readRunRecord(fixture.cwd, basename(runDirectory))).status,
						"completed",
					);
				} else if (contention === "temporary") {
					await new Promise((resolve) => setTimeout(resolve, 100));
					assert.ok(existsSync(join(runDirectory, "stop-intent.json")));
				}
				releaseCompetitor();
				await competitor;
				if (contention === "deadline")
					await stopRun(fixture.cwd, basename(runDirectory));
				await waitFor(
					async () => {
						if (existsSync(join(runDirectory, "stop-intent.json")))
							return false;
						try {
							await throwIfWorkflowStopRequested(
								fixture.cwd,
								basename(runDirectory),
							);
							return true;
						} catch {
							return false;
						}
					},
					"durable stop/fence was not reconciled after the lease was released",
					1_000,
				);
				assert.equal(
					(await readRunRecord(fixture.cwd, basename(runDirectory))).status,
					"interrupted",
				);
				if (contention !== "none") {
					setSupportHelperPreparedHookForTests(undefined);
					setRunLeaseTestHooksForTests();
					await resumeRun(fixture.cwd, basename(runDirectory));
					await waitFor(
						async () =>
							(await readRunRecord(fixture.cwd, basename(runDirectory)))
								.status === "completed",
						"explicit resume remained poisoned by cancellation intent",
						1_000,
					);
					assert.equal(await readFile(fixture.markerPath, "utf8"), "executed");
				}
			} finally {
				releaseStop();
				releaseCompetitor();
				await competitor;
				await launching;
				await cleanup(fixture?.cwd);
			}
		});
	}
}

test("launch cancellation fences are run-scoped and released by their owner", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-launch-signal-scope-"));
	const controller = new AbortController();
	const dispose = bindWorkflowLaunchSignal(
		cwd,
		"workflow_owned",
		controller.signal,
	);
	try {
		controller.abort();
		await assert.rejects(
			() => throwIfWorkflowStopRequested(cwd, "workflow_owned"),
			{
				name: "WorkflowStopRequested",
			},
		);
		await throwIfWorkflowStopRequested(cwd, "workflow_other");
		dispose();
		await throwIfWorkflowStopRequested(cwd, "workflow_owned");
	} finally {
		dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
