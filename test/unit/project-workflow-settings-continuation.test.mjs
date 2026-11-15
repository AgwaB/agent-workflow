// test-tier: integration
// Native engine persistence/Resume/materialization, with an API-only fake worker.
// No installed executor is launched: the registered SDK fake negotiates capabilities,
// and every worker dispatch terminates at setTaskRuntimeApiForTests.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
	runWorkflowSpec,
	resumeRun,
	stopRun,
	waitForRun,
} from "../../dist/core/engine.js";
import { registerWorkflowExecutor } from "../../dist/core/executor-registry.js";
import { setTaskRuntimeApiForTests as setRawApi } from "../../dist/core/runtime-port.js";
import { setWorkerLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import {
	readRunRecord,
	compiledWorkflowPath,
	flushPendingIndexUpdatesForTests,
} from "../../dist/core/store.js";
import { projectWorkflowSettingsPath } from "../../dist/hosts/project-workflow-settings.js";
import {
	workflowFixtureDescriptor,
	workflowControlText,
} from "../helpers/workflow-executor-fixture.mjs";
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import { drainWorkflowFixture } from "../helpers/workflow-fixture-lifecycle.mjs";
import { stateDir } from "../helpers/state-dir.mjs";

const root = fs.realpathSync(
	fs.mkdtempSync(join(tmpdir(), "aw-settings-continuation-")),
);
process.env.HOME = join(root, "isolated-user");
process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, ".pi", "agent");
process.env.AGENT_WORKFLOW_HOME = join(root, "home");
const executor = "continuation-fake";
const unregister = registerWorkflowExecutor(
	workflowFixtureDescriptor({
		id: executor,
		effectLog: join(root, "unused-sdk-effects.jsonl"),
	}),
);
const setApi = withMaterializedRawHost(setRawApi);
setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
let failed = false;
after(async () => {
	setApi(undefined);
	unregister();
	await flushPendingIndexUpdatesForTests();
	if (failed) console.error(`continuation fixture retained at ${root}`);
	else fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name, stages, intent) {
	const cwd = join(root, name);
	fs.mkdirSync(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	fs.writeFileSync(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		'---\ndescription: isolated reader\ntools: ["read"]\nreadOnly: true\n---\nUse fixture data only.\n',
	);
	const specPath = join(cwd, "workflow.json");
	fs.writeFileSync(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: { maxConcurrency: 1, stages },
		}),
	);
	const capture = {
		identity: { scope: "project-shared", relativeSpec: "workflow.json" },
		key: "a".repeat(64),
		definitionFingerprint: "b".repeat(64),
		revision: "captured-revision",
		storeEpoch: "captured-epoch",
		intent,
	};
	// Host-boundary fixture: seed the real isolated store path and take one capture.
	// This is not testing host discovery/CAS; Resume receives neither this object nor live intent.
	const settingsPath = projectWorkflowSettingsPath(cwd);
	fs.mkdirSync(dirname(settingsPath), { recursive: true });
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			schema: "agent-workflow-project-workflow-settings-v1",
			storeEpoch: capture.storeEpoch,
			workflows: {
				[capture.key]: {
					identity: capture.identity,
					revision: capture.revision,
					definitionFingerprint: capture.definitionFingerprint,
					intent,
				},
			},
		}),
		{ mode: 0o600 },
	);
	const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	capture.intent = stored.workflows[capture.key].intent;
	return { cwd, specPath, settingsPath, capture };
}

const single = (id, prompt, extra = {}) => ({
	id,
	type: "single",
	prompt,
	output: { analysis: { required: true }, refs: { required: true } },
	...extra,
});
const binding = (model, effort) => ({ executor, model, effort });
const defaults = binding("captured-common", "medium");

// Reuse the output-retry-dispatch/raw-host pattern: write actual worker artifacts,
// report their terminal status through the runtime port, and let the engine parse,
// persist and schedule them. No manual task completion or fabricated compiled JSON.
function fakeRuntime(cwd, { hold = false } = {}) {
	const dispatches = [],
		workers = new Map();
	let checkCount = 0;
	const runtime = {
		hold,
		dispatches,
		async runWorker(options) {
			const n = dispatches.length + 1;
			const runId = `run_continuation_${n}`,
				attemptId = `attempt_continuation_${n}`;
			dispatches.push(structuredClone(options));
			fs.writeFileSync(
				join(cwd, "dispatches.json"),
				JSON.stringify(dispatches, null, 2),
			);
			const prompt = String(options.task ?? "");
			const control = {
				schema: "stage-control-v1",
				digest: "fixture completed",
				...(prompt.includes("SEED_ITEMS")
					? { items: [{ id: "one" }, { id: "two" }] }
					: {}),
				...(prompt.includes("LOOP_CHECK") ? { done: ++checkCount === 2 } : {}),
			};
			const artifactDir = join(
				stateDir(cwd),
				String(options.runsDir),
				runId,
				"attempts",
				attemptId,
			);
			fs.mkdirSync(artifactDir, { recursive: true });
			fs.writeFileSync(
				join(artifactDir, "output.log"),
				workflowControlText(control),
			);
			fs.writeFileSync(join(artifactDir, "stderr.log"), "");
			fs.writeFileSync(
				join(artifactDir, "result.json"),
				JSON.stringify({
					runId,
					attemptId,
					status: "completed",
					exitCode: 0,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				}),
			);
			workers.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async getWorkerStatus({ runId }) {
			const worker = workers.get(runId);
			assert.ok(worker, `unknown fake worker ${runId}`);
			return {
				runId,
				attemptId: worker.attemptId,
				executorId: executor,
				status: worker.interrupted
					? "cancelled"
					: runtime.hold
						? "running"
						: "completed",
				failureKind: null,
				startedAt: new Date().toISOString(),
				completedAt: runtime.hold ? null : new Date().toISOString(),
				logs: ["output", "stderr", "result"].map((type) => ({
					type,
					path: type === "result" ? "result.json" : `${type}.log`,
					artifactCwd: worker.artifactDir,
				})),
				metadata: { contextLengthExceeded: false },
				attempts: [
					{
						attemptId: worker.attemptId,
						status: worker.interrupted
							? "cancelled"
							: runtime.hold
								? "running"
								: "completed",
					},
				],
			};
		},
		async reconcileWorkerRun() {
			return {};
		},
		async interruptWorker({ runId }) {
			const worker = workers.get(runId);
			assert.ok(worker, `cannot interrupt unknown fake worker ${runId}`);
			worker.interrupted = true;
			return {
				status: "interrupt-requested",
				runId,
				interruptedAttempts: [worker.attemptId],
				unsupportedAttempts: [],
			};
		},
	};
	return runtime;
}

async function compiled(cwd, runId) {
	return JSON.parse(
		await fsp.readFile(compiledWorkflowPath(cwd, runId), "utf8"),
	);
}

// Fail closed if the native continuation tries either node filesystem read API
// on the live settings file. The guards are installed only after launch/capture.
function forbidSettingsReads(path) {
	const restores = [],
		reads = [];
	for (const [object, key] of [
		[fs, "readFileSync"],
		[fs, "readFile"],
		[fsp, "readFile"],
		[fsp, "open"],
		[fs, "openSync"],
		[fs, "open"],
	]) {
		const original = object[key];
		object[key] = function (file, ...args) {
			const filename =
				file instanceof URL
					? fileURLToPath(file)
					: Buffer.isBuffer(file)
						? file.toString()
						: file;
			if (typeof filename === "string" && resolve(filename) === path) {
				reads.push(key);
				throw new Error(`Resume read live settings via ${key}`);
			}
			return Reflect.apply(original, this, [file, ...args]);
		};
		restores.push(() => {
			object[key] = original;
		});
	}
	syncBuiltinESMExports();
	return {
		reads,
		restore() {
			restores.reverse().forEach((fn) => fn());
			syncBuiltinESMExports();
		},
	};
}

for (const form of ["string", "url", "buffer"]) {
	test(`settings read guard rejects the actual file via ${form}`, () => {
		const file = join(root, `guard-${form}.json`);
		fs.writeFileSync(file, "fixture");
		const guard = forbidSettingsReads(file);
		try {
			const input =
				form === "url"
					? pathToFileURL(file)
					: form === "buffer"
						? Buffer.from(file)
						: file;
			assert.throws(() => fs.readFileSync(input), /Resume read live settings/);
			assert.deepEqual(guard.reads, ["readFileSync"]);
		} finally {
			guard.restore();
		}
	});
}

function assertRuntime(runtime, model, effort, source, originSlot) {
	// A homogeneous run leaves the per-task executor unset; dispatch resolves the
	// captured run executor. An explicit task override, if present, must agree.
	if (runtime.executor !== undefined) assert.equal(runtime.executor, executor);
	assert.equal(runtime.model, model);
	assert.equal(runtime.effort, effort);
	for (const field of ["model", "effort"]) {
		assert.equal(runtime.provenance[field].source, source);
		if (originSlot)
			assert.equal(runtime.provenance[field].originSlot, originSlot);
		else
			assert.equal(runtime.provenance[field].inheritedFrom, "workflow-default");
	}
}
function assertDispatch(dispatch, model, effort) {
	assert.equal(dispatch.executor.id, executor);
	assert.equal(
		dispatch.executor.module,
		new URL("../helpers/workflow-executor-fixture.mjs", import.meta.url)
			.pathname,
	);
	assert.equal(dispatch.model, model);
	assert.equal(dispatch.effort, effort);
}

for (const mutation of ["edit", "remove", "corrupt"]) {
	test(`native persisted stopped Run resumes captured defaults/slot after live settings ${mutation}`, async () => {
		const f = fixture(
			`resume-${mutation}`,
			[
				single("common", "COMMON_WORK"),
				single("bound", "BOUND_WORK", { after: ["common"] }),
			],
			{ defaults, slots: { bound: binding("captured-slot", "high") } },
		);
		const api = fakeRuntime(f.cwd, { hold: true });
		setApi(api);
		let runId, guard;
		try {
			const started = await runWorkflowSpec(f.specPath, f.cwd, {
				task: "Fixture continuation",
				projectWorkflowSettings: f.capture,
			});
			runId = started.runId;
			assert.equal(api.dispatches.length, 1);
			const stopped = await stopRun(f.cwd, runId);
			assert.equal(stopped.run.status, "interrupted");
			await drainWorkflowFixture(f.cwd, runId);
			const before = await readRunRecord(f.cwd, runId);
			const beforeCompiled = await compiled(f.cwd, runId);
			assert.deepEqual(before.configuration.capture, f.capture);
			assert.deepEqual(beforeCompiled.configuration, before.configuration);
			assert.equal(before.executor.id, executor);
			assert.equal(before.executor.source, "project-default");
			assert.equal(
				before.configuration.slots.common.executor.source,
				"project-default",
			);
			assert.equal(
				before.configuration.slots.common.model.source,
				"project-default",
			);
			assert.equal(
				before.configuration.slots.common.effort.source,
				"project-default",
			);
			assert.equal(
				before.configuration.slots.bound.executor.source,
				"project-slot",
			);
			assert.equal(before.configuration.slots.bound.model.originSlot, "bound");
			assert.equal(before.configuration.slots.bound.effort.originSlot, "bound");
			if (mutation === "remove") fs.unlinkSync(f.settingsPath);
			else if (mutation === "corrupt")
				fs.writeFileSync(f.settingsPath, "{BROKEN_SETTINGS");
			else {
				const changed = JSON.parse(fs.readFileSync(f.settingsPath, "utf8"));
				changed.workflows[f.capture.key].intent = {
					defaults: binding("changed-live", "off"),
				};
				fs.writeFileSync(f.settingsPath, JSON.stringify(changed));
			}
			const mutatedBytes =
				mutation === "remove"
					? undefined
					: fs.readFileSync(f.settingsPath, "utf8");
			// Also detach the caller-owned capture: the persisted snapshot must be authoritative.
			f.capture.intent.defaults.model = "mutated-caller";
			guard = forbidSettingsReads(f.settingsPath);
			api.hold = false;
			const resumed = await resumeRun(f.cwd, runId);
			assert.ok(resumed.resetTaskIds.length > 0);
			const done = await waitForRun(f.cwd, runId, 20_000);
			assert.equal(done.status, "completed", JSON.stringify(done.tasks));
			assert.deepEqual(done.executor, before.executor);
			assert.deepEqual(done.configuration, before.configuration);
			const saved = await compiled(f.cwd, runId);
			assert.deepEqual(saved.configuration, beforeCompiled.configuration);
			assertRuntime(
				saved.tasks.find((t) => t.stageId === "common").runtime,
				"captured-common",
				"medium",
				"project-default",
			);
			assertRuntime(
				saved.tasks.find((t) => t.stageId === "bound").runtime,
				"captured-slot",
				"high",
				"project-slot",
				"bound",
			);
			assert.equal(api.dispatches.length, 3);
			assertDispatch(api.dispatches[1], "captured-common", "medium");
			assertDispatch(api.dispatches[2], "captured-slot", "high");
			assert.deepEqual(guard.reads, []);
			guard.restore();
			guard = undefined;
			if (mutation === "remove")
				assert.equal(fs.existsSync(f.settingsPath), false);
			else assert.equal(fs.readFileSync(f.settingsPath, "utf8"), mutatedBytes);
		} catch (error) {
			failed = true;
			console.error("primary continuation failure", error);
			throw error;
		} finally {
			guard?.restore();
			if (runId) await drainWorkflowFixture(f.cwd, runId);
			setApi(undefined);
		}
	});
}

test("native foreach workers and second loop round materialize captured canonical template runtimes", async () => {
	const f = fixture(
		"materialization",
		[
			single("source", "SEED_ITEMS"),
			{
				id: "fan",
				type: "foreach",
				from: { source: "source", path: "$.items" },
				inputPolicy: { artifactAccess: "none" },
				each: { prompt: "FOREACH_WORK ${item}" },
				output: { analysis: { required: true }, refs: { required: true } },
			},
			{
				id: "cycle",
				type: "loop",
				after: ["fan"],
				maxRounds: 2,
				stages: [single("work", "LOOP_WORK"), single("check", "LOOP_CHECK")],
				until: { stage: "check", path: "$.done", equals: true },
			},
		],
		{
			defaults,
			slots: {
				fan: binding("captured-fan", "high"),
				"cycle.check": binding("captured-check", "low"),
			},
		},
	);
	const api = fakeRuntime(f.cwd, { hold: true });
	setApi(api);
	let runId, guard;
	try {
		const started = await runWorkflowSpec(f.specPath, f.cwd, {
			task: "Fixture materialization",
			projectWorkflowSettings: f.capture,
		});
		runId = started.runId;
		assert.equal(api.dispatches.length, 1);
		const initial = await compiled(f.cwd, runId);
		assert.equal(
			initial.tasks.some((t) => ["fan.one", "fan.two"].includes(t.id)),
			false,
		);
		assert.equal(
			initial.tasks.some((t) => t.id.includes(".r02.")),
			false,
		);
		assert.equal(
			initial.configuration.slots.fan.executor.source,
			"project-slot",
		);
		assert.equal(initial.configuration.slots.fan.model.originSlot, "fan");
		assert.equal(initial.configuration.slots.fan.effort.originSlot, "fan");
		assert.equal(
			initial.configuration.slots["cycle.check"].model.originSlot,
			"cycle.check",
		);
		// Corrupt before source completion: all fan workers and loop rounds are runtime generated.
		fs.writeFileSync(f.settingsPath, "{BROKEN_AFTER_CAPTURE");
		guard = forbidSettingsReads(f.settingsPath);
		api.hold = false;
		const done = await waitForRun(f.cwd, runId, 20_000);
		assert.equal(done.status, "completed", JSON.stringify(done.tasks));
		const saved = await compiled(f.cwd, runId);
		assert.deepEqual(saved.configuration, initial.configuration);
		assert.deepEqual(done.configuration, initial.configuration);
		assert.equal(done.executor.id, executor);
		assert.equal(done.executor.source, "project-default");
		const fan = saved.tasks.filter((t) => t.id.startsWith("fan."));
		const rounds = saved.tasks.filter((t) => t.loopChild);
		assert.equal(fan.length, 2);
		assert.deepEqual(fan.map((t) => t.id).sort(), ["fan.one", "fan.two"]);
		assert.equal(rounds.length, 4);
		for (const worker of fan)
			assertRuntime(
				worker.runtime,
				"captured-fan",
				"high",
				"project-slot",
				"fan",
			);
		for (const worker of rounds) {
			const check = worker.id.endsWith(".check");
			assertRuntime(
				worker.runtime,
				check ? "captured-check" : "captured-common",
				check ? "low" : "medium",
				check ? "project-slot" : "project-default",
				check ? "cycle.check" : undefined,
			);
		}
		assert.ok(rounds.some((t) => t.id.includes(".r02.")));
		assert.equal(done.loopResults[0].roundsUsed, 2);
		const fans = api.dispatches.filter((d) =>
			String(d.task).includes("FOREACH_WORK"),
		);
		const works = api.dispatches.filter((d) =>
			String(d.task).includes("LOOP_WORK"),
		);
		const checks = api.dispatches.filter((d) =>
			String(d.task).includes("LOOP_CHECK"),
		);
		assert.equal(fans.length, 2);
		assert.equal(works.length, 2);
		assert.equal(checks.length, 2);
		fans.forEach((d) => assertDispatch(d, "captured-fan", "high"));
		works.forEach((d) => assertDispatch(d, "captured-common", "medium"));
		checks.forEach((d) => assertDispatch(d, "captured-check", "low"));
		assert.deepEqual(guard.reads, []);
		guard.restore();
		guard = undefined;
		assert.equal(
			fs.readFileSync(f.settingsPath, "utf8"),
			"{BROKEN_AFTER_CAPTURE",
		);
	} catch (error) {
		failed = true;
		console.error("primary materialization failure", error);
		throw error;
	} finally {
		guard?.restore();
		if (runId) await drainWorkflowFixture(f.cwd, runId);
		setApi(undefined);
	}
});

for (const fallbackId of [undefined, "fallback"]) {
	test(`native exhaustion dispatch keeps canonical captured binding (${fallbackId})`, async () => {
		const slot = "cycle.$onExhausted";
		const f = fixture(
			`exhaustion-${fallbackId}`,
			[
				{
					id: "cycle",
					type: "loop",
					maxRounds: 1,
					stages: [single("work", "LOOP_WORK"), single("check", "LOOP_CHECK")],
					until: { stage: "check", path: "$.done", equals: true },
					onExhausted: single(fallbackId, "EXHAUSTION_WORK"),
				},
			],
			{ defaults, slots: { [slot]: binding("captured-exhaustion", "high") } },
		);
		const api = fakeRuntime(f.cwd, { hold: true });
		setApi(api);
		let runId, guard;
		try {
			const started = await runWorkflowSpec(f.specPath, f.cwd, {
				task: "Fixture exhaustion",
				projectWorkflowSettings: f.capture,
			});
			runId = started.runId;
			assert.equal(api.dispatches.length, 1);
			const initial = await compiled(f.cwd, runId);
			assert.deepEqual(
				Object.keys(initial.configuration.slots).sort(),
				[slot, "cycle.check", "cycle.work"].sort(),
			);
			assert.equal(
				initial.configuration.slots[slot].model.value,
				"captured-exhaustion",
			);
			assert.equal(initial.configuration.slots[slot].model.originSlot, slot);
			fs.writeFileSync(f.settingsPath, "{BROKEN_BEFORE_EXHAUSTION");
			f.capture.intent.slots[slot].model = "mutated-caller";
			guard = forbidSettingsReads(f.settingsPath);
			api.hold = false;
			const done = await waitForRun(f.cwd, runId, 20_000);
			assert.equal(done.status, "completed", JSON.stringify(done.tasks));
			assert.equal(done.loopResults[0].status, "exhausted");
			assert.equal(done.loopResults[0].roundsUsed, 1);
			const saved = await compiled(f.cwd, runId);
			assert.deepEqual(saved.configuration, initial.configuration);
			assert.deepEqual(done.configuration, initial.configuration);
			const exhausted = saved.tasks.filter(
				(task) => task.runtime?.provenance?.model?.originSlot === slot,
			);
			assert.equal(exhausted.length, 1);
			assertRuntime(
				exhausted[0].runtime,
				"captured-exhaustion",
				"high",
				"project-slot",
				slot,
			);
			const dispatched = api.dispatches.filter((d) =>
				String(d.task).includes("EXHAUSTION_WORK"),
			);
			assert.equal(dispatched.length, 1);
			assertDispatch(dispatched[0], "captured-exhaustion", "high");
			assert.equal(api.dispatches.length, 3);
			assert.deepEqual(guard.reads, []);
			guard.restore();
			guard = undefined;
			assert.equal(
				fs.readFileSync(f.settingsPath, "utf8"),
				"{BROKEN_BEFORE_EXHAUSTION",
			);
		} catch (error) {
			failed = true;
			console.error("primary exhaustion failure", error);
			throw error;
		} finally {
			guard?.restore();
			if (runId) await drainWorkflowFixture(f.cwd, runId);
			setApi(undefined);
		}
	});
}
