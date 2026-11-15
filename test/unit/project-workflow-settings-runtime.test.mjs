import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { buildDynamicGeneratedCompiledTask } from "../../dist/core/dynamic-generated-task-runtime.js";
import {
	createRunRecord,
	writeRunRecord,
	readRunRecord,
	compiledWorkflowPath,
	flushPendingIndexUpdatesForTests,
} from "../../dist/core/store.js";
import {
	planRoleExecution,
	workflowRoleLayers,
} from "../../dist/core/role-execution.js";
import { applyWorkflowExecutionProfile } from "../../dist/core/execution-profile.js";
import {
	registerWorkflowExecutor,
	resolveRunExecutorSelection,
} from "../../dist/core/executor-registry.js";
import {
	freezeProjectSettingsCapture,
	freezeConfiguration,
} from "../../dist/core/project-settings-runtime.js";
import {
	runWorkflowSpec,
	WorkflowPreflightPassed,
	waitForRun,
} from "../../dist/core/engine.js";
import { drainWorkflowProject } from "../helpers/workflow-fixture-lifecycle.mjs";
import {
	workflowFixtureDescriptor,
	readFixtureLog,
} from "../helpers/workflow-executor-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "aw-local-runtime-"));
process.env.AGENT_WORKFLOW_HOME = join(root, "home");
const cwd = join(root, "project");
mkdirSync(join(cwd, ".agent-workflow", "agents"), { recursive: true });
writeFileSync(
	join(cwd, ".agent-workflow", "agents", "reader.md"),
	'---\ndescription: reader\ntools: ["read"]\nreadOnly: true\n---\nRead.\n',
);
writeFileSync(
	join(cwd, "fixture.mjs"),
	"export default async function controller() { throw new Error('preflight fixture must not execute'); }\n",
);
const unregister = ["local-a", "local-b"].map((id) =>
	registerWorkflowExecutor(
		workflowFixtureDescriptor({ id, effectLog: join(root, `${id}.jsonl`) }),
	),
);
after(async () => {
	await flushPendingIndexUpdatesForTests();
	unregister.forEach((fn) => fn());
	if (!process.exitCode) rmSync(root, { recursive: true, force: true });
	else console.error(`retained ${root}`);
});
const stage = (id, extra = {}) => ({
	id,
	type: "single",
	prompt: "Read",
	output: { analysis: { required: true } },
	...extra,
});
const spec = (stages) => ({
	schemaVersion: 1,
	name: "local-runtime",
	defaults: { agent: "reader", tools: ["read"], readOnly: true },
	artifactGraph: { stages },
});
const capture = (intent) => ({
	identity: { scope: "project-shared", relativeSpec: "fixture/spec.json" },
	key: "a".repeat(64),
	definitionFingerprint: "b".repeat(64),
	revision: "fixture-revision",
	storeEpoch: "fixture-epoch",
	intent,
});
const executor = () => resolveRunExecutorSelection({ runFlag: "local-a" });
async function prepared(authored, intent, options = {}) {
	const frozen =
		intent === undefined
			? undefined
			: freezeProjectSettingsCapture(capture(intent));
	const applied = applyWorkflowExecutionProfile(
		authored,
		options.executionProfile,
		options.executionProfileOverride,
		true,
	);
	const plan = planRoleExecution({
		spec: applied.spec,
		executor: executor(),
		layers: workflowRoleLayers({ spec: authored, ...options }),
		projectSettings: frozen?.intent,
		trace: true,
		runFlagExecutor: options.executor,
		runFlagModel: options.runtimeOverrides?.model,
	});
	const configuration = {
		schema: "agent-workflow-configuration-v1",
		...(frozen ? { capture: frozen } : {}),
		slots: {},
		shadowed: [],
	};
	const compiled = await compileWorkflow(plan.spec, {
		cwd,
		runExecutor: plan.executor.id,
		configuration,
		roleAssignments: plan.roleExecution.stages,
		runtimeOverrides: options.runtimeOverrides,
		runtimeDefaults: options.runtimeDefaults,
		availableModels: options.availableModels,
		executorDefaults: options.executorDefaults,
	});
	return { compiled, plan, configuration };
}
const task = (result, id) =>
	result.compiled.tasks.find(
		(t) =>
			t.stageId === id ||
			t.artifactGraph?.stageId === id ||
			t.key?.startsWith(`${id}.`),
	);

test("per-field flag > slot > common > author, reset and role peers stay isolated", async () => {
	const s = spec([
		stage("work", {
			model: "author",
			effort: "low",
			profileRole: "verification",
		}),
		stage("check", { effort: "xhigh", profileRole: "verification" }),
	]);
	const intent = {
		defaults: { executor: "local-a", model: "common", effort: "medium" },
		slots: { check: { executor: "local-a", model: "slot", effort: "high" } },
	};
	const r = await prepared(s, intent);
	assert.equal(task(r, "check").runtime.model, "slot");
	assert.equal(task(r, "work").runtime.model, "common");
	assert.equal(r.configuration.slots.check.effort.source, "project-slot");
	delete intent.slots.check.model;
	const reset = await prepared(s, intent);
	assert.equal(task(reset, "check").runtime.model, "common");
	assert.equal(task(reset, "check").runtime.effort, "high");
	const flagged = await prepared(s, intent, {
		runtimeOverrides: { model: "flag", effort: "off" },
	});
	assert.equal(task(flagged, "check").runtime.model, "flag");
	assert.equal(flagged.configuration.slots.check.effort.source, "run-flag");
	assert.equal(r.configuration.capture.intent.slots.check.model, "slot");
	assert.ok(Object.isFrozen(r.configuration.capture.intent.slots.check));
});

test("local bindings participate in mixed executor plan/modelChecks and exclude foreign common values", async () => {
	const r = await prepared(
		spec([stage("a"), stage("b", { model: "author-b", effort: "low" })]),
		{
			defaults: { executor: "local-a", model: "foreign", effort: "high" },
			slots: { b: { executor: "local-b" } },
		},
	);
	assert.equal(r.plan.roleExecution.mixed, true);
	assert.equal(task(r, "b").runtime.executor, "local-b");
	assert.equal(task(r, "b").runtime.model, "author-b");
	assert.equal(task(r, "b").runtime.effort, "low");
	assert.deepEqual(r.plan.modelChecks, [
		{ slot: "a", executor: "local-a", model: "foreign" },
	]);
	const flagged = await prepared(
		spec([stage("a", { model: "author" })]),
		{ slots: { a: { executor: "local-b", model: "bound" } } },
		{ executor: "local-a", runtimeOverrides: { model: "flag" } },
	);
	assert.equal(task(flagged, "a").runtime.model, "flag");
	assert.equal(flagged.plan.modelChecks.length, 0);
});

test("dynamic leaves refuse incompatible parent without pinning it or siblings; absent profiles remain absent", async () => {
	const s = spec([
		{
			id: "d",
			type: "dynamic",
			prompt: "Plan",
			dynamic: {
				uses: "fixture.mjs",
				decisionLoop: {
					planner: { agent: "reader" },
					verifier: { agent: "reader" },
				},
			},
		},
	]);
	await assert.rejects(
		prepared(s, {
			slots: { "d.$verifier": { executor: "local-b", model: "v" } },
		}),
		/must match parent/,
	);
	assert.equal(
		s.artifactGraph.stages[0].dynamic.decisionLoop.verifier.model,
		undefined,
	);
	const r = await prepared(s, {
		defaults: { executor: "local-a", model: "common" },
		slots: { "d.$verifier": { executor: "local-a", model: "verify" } },
	});
	const d = task(r, "d").dynamic.decisionLoop;
	assert.equal(d.planner.model, "common");
	assert.equal(d.verifier.model, "verify");
	assert.equal(d.workerDefaults, undefined);
	assert.equal(
		r.configuration.slots["d.$verifier"].model.originSlot,
		"d.$verifier",
	);
	for (const id of ["d", "d.$workerDefaults", "missing"])
		await assert.rejects(
			prepared(s, { slots: { [id]: { executor: "local-a" } } }),
			/unknown or non-editable/,
		);
});

test("canonical nested DAG, foreach and loop targeting", async () => {
	const s = spec([
		{ id: "dag", type: "dag", stages: [stage("one"), stage("two")] },
		{
			id: "items",
			type: "foreach",
			from: "dag",
			each: { prompt: "Read", model: "old" },
			output: { analysis: { required: true } },
		},
		{
			id: "loop",
			type: "loop",
			maxIterations: 2,
			stages: [stage("work"), stage("check")],
			until: { stage: "check", path: "$.done", equals: true },
		},
	]);
	const r = await prepared(s, {
		slots: {
			"dag.two": { executor: "local-a", model: "nested" },
			items: { executor: "local-a", model: "template" },
			"loop.check": { executor: "local-a", effort: "high" },
		},
	});
	assert.equal(r.configuration.slots["dag.two"].model.value, "nested");
	assert.equal(r.configuration.slots.items.model.value, "template");
	assert.equal(r.configuration.slots["loop.check"].effort.requested, "high");
	await assert.rejects(
		prepared(s, { slots: { dag: { executor: "local-a" } } }),
		/non-editable/,
	);
});

test("effort requested/resolved comes from actual model clamp", async () => {
	const r = await prepared(
		spec([stage("one")]),
		{ defaults: { executor: "local-a", model: "provider/m", effort: "xhigh" } },
		{
			availableModels: [
				{
					provider: "provider",
					id: "m",
					fullId: "provider/m",
					reasoning: false,
				},
			],
		},
	);
	assert.equal(task(r, "one").runtime.effort, "off");
	assert.equal(r.configuration.slots.one.effort.requested, "xhigh");
	assert.equal(r.configuration.slots.one.effort.resolved, "off");
});

test("no-local compiled serialized shape unchanged unless tracing is requested", async () => {
	const s = spec([stage("one", { model: "author", effort: "high" })]);
	const baseline = await compileWorkflow(s, { cwd, runExecutor: "local-a" });
	const plan = planRoleExecution({
		spec: s,
		executor: executor(),
		layers: [],
		projectSettings: {},
	});
	const empty = await compileWorkflow(plan.spec, {
		cwd,
		runExecutor: "local-a",
	});
	assert.deepEqual(
		JSON.parse(JSON.stringify(empty)),
		JSON.parse(JSON.stringify(baseline)),
	);
	assert.equal(baseline.configuration, undefined);
	assert.equal(baseline.tasks[0].runtime.provenance, undefined);
	const traced = await prepared(s);
	assert.equal(traced.configuration.slots.one.model.source, "author-stage");
	assert.equal(traced.configuration.slots.one.executor.source, "run-flag");
});

test("engine consumes capture before real role planning and exposes frozen post-compile sink without Run creation", async () => {
	const path = join(cwd, "spec.json");
	writeFileSync(path, JSON.stringify(spec([stage("one")])));
	let configuration;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			defaultExecutor: "local-b",
			projectWorkflowSettings: capture({
				defaults: { executor: "local-a", model: "local-model", effort: "high" },
			}),
			configurationSink: (value) => {
				configuration = value;
			},
		}),
		(error) => error instanceof WorkflowPreflightPassed,
	);
	assert.equal(configuration.slots.one.executor.value, "local-a");
	assert.equal(configuration.slots.one.executor.source, "project-default");
	assert.equal(configuration.slots.one.model.value, "local-model");
	assert.ok(Object.isFrozen(configuration.slots.one));
	assert.equal(
		existsSync(join(root, "local-a.jsonl")),
		false,
		"probe does not submit a model call",
	);
});

test("actual profile/role/author/host/agent/executor sources are distinct", async () => {
	const s = spec([stage("one")]);
	s.executionProfiles = { declared: { one: { model: "profile-model" } } };
	const profile = await prepared(s, undefined, {
		executionProfile: "declared",
	});
	assert.equal(
		profile.configuration.slots.one.model.source,
		"workflow-profile",
	);
	const role = await prepared(spec([stage("one")]), undefined, {
		workflowPreference: {
			name: "fixture",
			roles: { default: { effort: "high" } },
		},
	});
	assert.equal(
		role.configuration.slots.one.effort.source,
		"workflow-preference",
	);
	const host = await prepared(spec([stage("one")]), undefined, {
		runtimeDefaults: { model: "host", executor: "local-a" },
	});
	assert.equal(host.configuration.slots.one.model.source, "host-default");
	const exec = await prepared(spec([stage("one")]), undefined, {
		executorDefaults: { "local-a": { default: { model: "executor" } } },
	});
	assert.equal(exec.configuration.slots.one.model.source, "executor-default");
	assert.equal(exec.configuration.slots.one.effort.source, "unresolved");
});

test("generated tasks consume frozen profile snapshot, keep request priority and origin", async () => {
	const s = spec([
		{
			id: "d",
			type: "dynamic",
			prompt: "Plan",
			dynamic: {
				uses: "fixture.mjs",
				permissions: { allowDynamicRoles: true, allowDynamicTools: true },
				decisionLoop: { workerDefaults: { agent: "reader", tools: ["read"] } },
			},
		},
	]);
	const intent = {
		defaults: { executor: "local-a", model: "common" },
		slots: {
			"d.$workerDefaults": {
				executor: "local-a",
				model: "frozen-worker",
				effort: "high",
			},
		},
	};
	const result = await prepared(s, intent);
	const snapshot = JSON.parse(JSON.stringify(result.compiled));
	intent.slots["d.$workerDefaults"].model = "later-live-value";
	const controller = snapshot.tasks.find((t) => t.dynamic);
	const base = {
		cwd,
		run: { runId: "workflow_fixture", tasks: [], executor: executor() },
		compiledFlow: snapshot,
		controllerCompiledTask: controller,
		controllerSpecId: controller.id,
		controllerStageId: "d",
		generatedSpecId: "d.worker",
		opId: "op",
		requestHash: "hash",
		dynamic: controller.dynamic,
	};
	const worker = await buildDynamicGeneratedCompiledTask({
		...base,
		request: {
			id: "worker",
			profile: "worker",
			prompt: "Read",
			inputs: [],
			requiredReads: [],
		},
	});
	assert.equal(worker.runtime.model, "frozen-worker");
	assert.equal(worker.runtime.provenance.model.originSlot, "d.$workerDefaults");
	assert.equal(
		worker.runtime.provenance.model.inheritedFrom,
		"d.$workerDefaults",
	);
	const requested = await buildDynamicGeneratedCompiledTask({
		...base,
		request: {
			id: "worker",
			profile: "worker",
			model: "frozen-worker",
			effort: "high",
			prompt: "Read",
			inputs: [],
			requiredReads: [],
		},
	});
	assert.equal(requested.runtime.provenance.model.source, "generated-request");
});

test("separate parentRunId child ignores local capture and keeps inherited executor", async () => {
	const s = spec([stage("one", { model: "child-author" })]);
	const path = join(cwd, "child.json");
	writeFileSync(path, JSON.stringify(s));
	const compiled = await compileWorkflow(s, { cwd, runExecutor: "local-b" });
	const { run } = await createRunRecord(cwd, compiled, path, {
		runId: "workflow_local_parent",
		initialize: false,
	});
	run.executor = resolveRunExecutorSelection({ runFlag: "local-b" });
	await writeRunRecord(cwd, run);
	let configuration;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			parentRunId: run.runId,
			preflightOnly: true,
			projectWorkflowSettings: capture({
				defaults: { executor: "local-a", model: "not-child" },
			}),
			configurationSink: (value) => {
				configuration = value;
			},
		}),
		(error) => error instanceof WorkflowPreflightPassed,
	);
	assert.equal(configuration.capture, undefined);
	assert.equal(configuration.slots.one.executor.value, "local-b");
	assert.equal(configuration.slots.one.model.value, "child-author");
});

test("engine local default beats declared/saved/default, explicit executor shadows bindings and records why", async () => {
	const s = spec([stage("one", { model: "author" })]);
	s.executionProfiles = { declared: { one: { model: "declared-model" } } };
	s.executionProfileExecutors = { declared: "local-b" };
	const path = join(cwd, "precedence.json");
	writeFileSync(path, JSON.stringify(s));
	let configuration;
	const options = {
		preflightOnly: true,
		executionProfile: "declared",
		savedUserProfile: {
			name: "saved",
			executor: "local-b",
			model: "saved-model",
		},
		defaultExecutor: "local-b",
		projectWorkflowSettings: capture({
			defaults: { executor: "local-a", model: "local-model" },
		}),
		configurationSink: (value) => {
			configuration = value;
		},
	};
	await assert.rejects(
		runWorkflowSpec(path, cwd, options),
		(error) => error instanceof WorkflowPreflightPassed,
	);
	assert.equal(configuration.slots.one.executor.source, "project-default");
	assert.equal(configuration.slots.one.model.value, "local-model");
	await assert.rejects(
		runWorkflowSpec(path, cwd, { ...options, executor: "local-b" }),
		(error) => error instanceof WorkflowPreflightPassed,
	);
	assert.equal(configuration.slots.one.executor.source, "run-flag");
	assert.equal(configuration.slots.one.model.value, "declared-model");
	assert.ok(
		configuration.shadowed.some(
			(row) => row.field === "model" && /incompatible binding/.test(row.reason),
		),
	);
});

test("post-compile configuration is available even when later negotiation refuses", async () => {
	const path = join(cwd, "refusal.json");
	writeFileSync(path, JSON.stringify(spec([stage("one")])));
	let configuration;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			defaultExecutor: "local-a",
			projectWorkflowSettings: capture({
				defaults: { executor: "local-a", model: "fixture" },
			}),
			configurationSink: (value) => {
				configuration = value;
			},
			executorProber: async () => {
				throw new Error("fixture probe refusal");
			},
		}),
		/fixture probe refusal/,
	);
	assert.equal(configuration.slots.one.model.value, "fixture");
	assert.ok(Object.isFrozen(configuration));
});

// Independent review regressions: run against the original built B1 before corrections.
test("F1 loop containers never become configuration rows", async () => {
	const r = await prepared(
		spec([
			{
				id: "cycle",
				type: "loop",
				maxIterations: 2,
				stages: [stage("check")],
				until: { stage: "check", path: "$.done", equals: true },
			},
		]),
		{ defaults: { executor: "local-a", model: "common" } },
	);
	assert.equal(Object.hasOwn(r.configuration.slots, "cycle"), false);
	for (const row of Object.values(r.configuration.slots))
		assert.ok(
			row.executor.source !== "unresolved" || row.executor.value === undefined,
		);
});
for (const fallbackId of [undefined, "fallback"])
	test(`F2 canonical exhaustion slot (${fallbackId})`, async () => {
		const r = await prepared(
			spec([
				{
					id: "cycle",
					type: "loop",
					maxIterations: 1,
					stages: [stage("check")],
					until: { stage: "check", path: "$.done", equals: true },
					onExhausted: stage(fallbackId, { model: "authored-fallback" }),
				},
			]),
			{
				slots: {
					"cycle.$onExhausted": { executor: "local-a", effort: "high" },
				},
			},
		);
		assert.equal(
			r.configuration.slots["cycle.$onExhausted"]?.executor.source,
			"project-slot",
		);
		assert.equal(
			r.configuration.slots["cycle.$onExhausted"].model.originSlot,
			"cycle.$onExhausted",
		);
		assert.equal(
			Object.hasOwn(r.configuration.slots, `cycle.${fallbackId}`),
			false,
		);
	});
for (const tier of ["project-default", "project-slot"])
	for (const id of ["ghost", "constructor", "toString", "hasOwnProperty"])
		test(`F3 ${tier} ${id} error names local source and slot`, async () => {
			const path = join(cwd, `error-${tier}-${id}.json`);
			writeFileSync(path, JSON.stringify(spec([stage("one")])));
			await assert.rejects(
				runWorkflowSpec(path, cwd, {
					preflightOnly: true,
					defaultExecutor: "local-a",
					projectWorkflowSettings: capture(
						tier === "project-default"
							? { defaults: { executor: id } }
							: { slots: { one: { executor: id } } },
					),
				}),
				(error) => {
					assert.equal(error.source, tier);
					assert.match(error.message, /project/);
					assert.doesNotMatch(error.message, /from run flag/);
					assert.match(
						error.message,
						tier === "project-slot" ? /one/ : /workflow default/,
					);
					return true;
				},
			);
		});
const dynamicStage = (id, decisionLoop) => ({
	id,
	type: "dynamic",
	dynamic: {
		uses: "./fixture.mjs",
		permissions: { allowDynamicRoles: true, allowDynamicTools: true },
		...(decisionLoop ? { decisionLoop } : {}),
	},
});
async function generated(result, controllerId, request = {}) {
	const snapshot = JSON.parse(JSON.stringify(result.compiled));
	const controller = task({ compiled: snapshot }, controllerId);
	return buildDynamicGeneratedCompiledTask({
		cwd,
		run: { runId: "workflow_fixture", tasks: [], executor: executor() },
		compiledFlow: snapshot,
		controllerCompiledTask: controller,
		controllerSpecId: controller.id,
		controllerStageId: controllerId,
		generatedSpecId: `${controllerId}.worker`,
		opId: "op",
		requestHash: "hash",
		dynamic: controller.dynamic,
		request: {
			id: "worker",
			profile: "worker",
			prompt: "Read",
			inputs: [],
			requiredReads: [],
			...request,
		},
	});
}
test("F4 no inert dynamic run overrides without flags", async () => {
	const r = await prepared(spec([dynamicStage("d")]), {
		defaults: { executor: "local-a", model: "common" },
	});
	assert.equal(task(r, "d").dynamic.runtimeOverrides, undefined);
});
test("F5 generated common lineage keeps default and template", async () => {
	const r = await prepared(
		spec([
			dynamicStage("d", {
				workerDefaults: { agent: "reader", tools: ["read"] },
			}),
		]),
		{ defaults: { executor: "local-a", model: "common", effort: "high" } },
	);
	const w = await generated(r, "d");
	assert.equal(w.runtime.provenance.model.inheritedFrom, "workflow-default");
	assert.deepEqual(w.runtime.provenance.model.inheritedVia, [
		"d.$workerDefaults",
	]);
});
test("F6 workflow-default real slot does not collide with common shadows", async () => {
	const path = join(cwd, "shadow-special.json");
	writeFileSync(path, JSON.stringify(spec([stage("workflow-default")])));
	let config;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			executor: "local-a",
			projectWorkflowSettings: capture({
				defaults: { executor: "local-b", model: "common" },
				slots: { "workflow-default": { executor: "local-b", model: "slot" } },
			}),
			configurationSink: (c) => {
				config = c;
			},
		}),
		(e) => e instanceof WorkflowPreflightPassed,
	);
	assert.equal(config.shadowed.length, 4);
	assert.deepEqual(
		config.shadowed
			.filter((r) => r.field === "model")
			.map((r) => r.scope)
			.sort(),
		["slot", "workflow-default"],
	);
	const r = await prepared(
		spec([stage("workflow-default"), stage("ordinary")]),
		{
			defaults: { executor: "local-a", model: "common" },
			slots: { "workflow-default": { executor: "local-a", model: "slot" } },
		},
	);
	assert.equal(
		r.configuration.slots["workflow-default"].model.originScope,
		"slot",
	);
	assert.equal(
		r.configuration.slots.ordinary.model.originScope,
		"workflow-default",
	);
});
test("F7 ordinary profile overlays have no new provenance symbols", () => {
	const s = spec([stage("one")]);
	s.executionProfiles = { p: { one: { model: "profile" } } };
	const applied = applyWorkflowExecutionProfile(s, "p");
	assert.deepEqual(
		applied.spec.artifactGraph.stages[0],
		stage("one", { model: "profile" }),
	);
	assert.equal(
		Object.getOwnPropertySymbols(applied.spec.artifactGraph.stages[0]).length,
		0,
	);
});
for (const bound of [false, true])
	for (const id of [
		"__proto__",
		"constructor",
		"hasOwnProperty",
		"workflow-default",
	])
		test(`F8 own slot ${id} bound=${bound}`, async () => {
			const intent = {
				defaults: { executor: "local-a", model: "common" },
				...(bound
					? {
							slots: JSON.parse(
								`{"${id}":{"executor":"local-a","model":"special"}}`,
							),
						}
					: { slots: {} }),
			};
			const r = await prepared(spec([stage(id)]), intent);
			const expected = bound ? "special" : "common";
			assert.equal(task(r, id).runtime.model, expected);
			for (const map of [r.plan.roleExecution.stages, r.configuration.slots]) {
				assert.ok(Object.hasOwn(map, id));
				const saved = JSON.parse(JSON.stringify(map));
				assert.ok(Object.hasOwn(saved, id));
			}
			assert.equal(r.plan.roleExecution.stages[id].executor, "local-a");
			assert.equal(r.configuration.slots[id].model.value, expected);
		});

test("F8 special-name dynamic controller configuration is own data", async () => {
	const r = await prepared(
		spec([dynamicStage("__proto__", { workerDefaults: { agent: "reader" } })]),
		{ defaults: { executor: "local-a", model: "common" } },
	);
	assert.ok(Object.hasOwn(r.configuration.slots, "__proto__"));
	assert.ok(
		Object.hasOwn(
			JSON.parse(JSON.stringify(r.configuration.slots)),
			"__proto__",
		),
	);
});

test("matrix nested dynamic and foreach sources; positive leaf isolation and executor shadow", async () => {
	const s = spec([
		{
			id: "outer",
			type: "dag",
			stages: [
				dynamicStage("d", {
					planner: { agent: "reader" },
					workerDefaults: { agent: "reader" },
					verifier: { agent: "reader" },
				}),
			],
		},
		{
			id: "fan",
			type: "foreach",
			from: "outer",
			each: { prompt: "Read", model: "authored-each" },
			output: { analysis: { required: true } },
		},
	]);
	const intent = {
		defaults: { executor: "local-a", model: "common" },
		slots: {
			"outer.d.$verifier": { executor: "local-a", model: "verify" },
			fan: { executor: "local-a", effort: "high" },
		},
	};
	const r = await prepared(s, intent);
	const d = task(r, "outer.d");
	assert.equal(d.runtime.model, "common");
	assert.equal(r.plan.roleExecution.stages["outer.d"].executor, "local-a");
	for (const name of ["planner", "workerDefaults"]) {
		assert.equal(d.dynamic.decisionLoop[name].model, "common");
		assert.equal(
			r.plan.roleExecution.stages[`outer.d.$${name}`].executor,
			"local-a",
		);
	}
	assert.equal(d.dynamic.decisionLoop.verifier.model, "verify");
	assert.equal(
		r.configuration.slots["outer.d.$verifier"].model.originSlot,
		"outer.d.$verifier",
	);
	assert.equal(r.configuration.slots.fan.model.source, "project-default");
	assert.equal(r.configuration.slots.fan.effort.source, "project-slot");
	const worker = await generated(r, "outer.d");
	assert.equal(worker.runtime.model, "common");
	assert.equal(
		worker.runtime.provenance.model.originSlot,
		"outer.d.$workerDefaults",
	);
	assert.equal(
		worker.runtime.provenance.model.inheritedFrom,
		"workflow-default",
	);
	assert.deepEqual(worker.runtime.provenance.model.inheritedVia, [
		"outer.d.$workerDefaults",
	]);
	const shadow = await prepared(
		s,
		{
			slots: { "outer.d.$verifier": { executor: "local-b", model: "foreign" } },
		},
		{ executor: "local-a" },
	);
	assert.equal(
		task(shadow, "outer.d").dynamic.decisionLoop.verifier.model,
		undefined,
	);
	for (const a of Object.values(shadow.plan.roleExecution.stages))
		assert.equal(a.executor, "local-a");
});
test("matrix no declared worker profile inherits common and genuinely different request wins", async () => {
	const r = await prepared(spec([dynamicStage("d")]), {
		defaults: { executor: "local-a", model: "common", effort: "low" },
	});
	freezeConfiguration(r.compiled);
	const w = await generated(r, "d", { profile: undefined, agent: "reader" });
	assert.equal(w.runtime.model, "common");
	assert.equal(w.runtime.effort, "low");
	assert.equal(w.runtime.provenance.model.inheritedFrom, "workflow-default");
	assert.equal(w.runtime.provenance.model.originSlot, "d");
	const requested = await generated(r, "d", {
		profile: undefined,
		agent: "reader",
		model: "request-different",
		effort: "high",
	});
	assert.equal(requested.runtime.model, "request-different");
	assert.equal(requested.runtime.effort, "high");
	assert.equal(requested.runtime.provenance.model.source, "generated-request");
	assert.equal(requested.runtime.provenance.effort.source, "generated-request");
});
test("matrix author-default, author-profile, agent and user-profile actual sources", async () => {
	const defaultsSpec = spec([stage("one")]);
	defaultsSpec.defaults.model = "authored-default";
	assert.equal(
		(await prepared(defaultsSpec)).configuration.slots.one.model.source,
		"author-default",
	);
	const profile = await prepared(
		spec([
			dynamicStage("d", {
				workerDefaults: { agent: "reader", model: "authored-profile" },
			}),
		]),
	);
	assert.equal(
		profile.configuration.slots["d.$workerDefaults"].model.source,
		"author-profile",
	);
	writeFileSync(
		join(cwd, ".agent-workflow", "agents", "modeled.md"),
		'---\ndescription: modeled\ntools: ["read"]\nreadOnly: true\nmodel: agent-model\n---\nRead.\n',
	);
	assert.equal(
		(await prepared(spec([stage("one", { agent: "modeled" })]))).configuration
			.slots.one.model.source,
		"agent",
	);
	const user = await prepared(spec([stage("one")]), undefined, {
		executionProfileOverride: {
			name: "saved",
			stageOverrides: { one: { model: "user" } },
		},
	});
	assert.equal(user.configuration.slots.one.model.source, "user-profile");
	assert.equal(user.configuration.slots.one.model.value, "user");
});
for (const flag of ["model", "effort"])
	test(`matrix independent ${flag} flag`, async () => {
		const r = await prepared(
			spec([stage("one")]),
			{
				defaults: { executor: "local-a", model: "common", effort: "low" },
				slots: { one: { executor: "local-a", model: "slot", effort: "high" } },
			},
			{
				runtimeOverrides:
					flag === "model" ? { model: "flag" } : { effort: "off" },
			},
		);
		assert.equal(r.configuration.slots.one[flag].source, "run-flag");
		assert.equal(
			r.configuration.slots.one[flag === "model" ? "effort" : "model"].source,
			"project-slot",
		);
		assert.equal(
			task(r, "one").runtime.model,
			flag === "model" ? "flag" : "slot",
		);
		assert.equal(
			task(r, "one").runtime.effort,
			flag === "effort" ? "off" : "high",
		);
	});
test("matrix mixed local slot excludes foreign host defaults and model registry", async () => {
	const path = join(cwd, "foreign-host.json");
	writeFileSync(
		path,
		JSON.stringify(
			spec([
				stage("host"),
				stage("local", { model: "local-only", effort: "high" }),
			]),
		),
	);
	let config;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			defaultExecutor: "local-a",
			runtimeDefaults: {
				executor: "local-a",
				model: "provider/host",
				effort: "low",
			},
			modelRegistryExecutor: "local-a",
			availableModels: [
				{
					provider: "provider",
					id: "host",
					fullId: "provider/host",
					reasoning: false,
				},
			],
			projectWorkflowSettings: capture({
				slots: { local: { executor: "local-b" } },
			}),
			configurationSink: (c) => {
				config = c;
			},
		}),
		(e) => e instanceof WorkflowPreflightPassed,
	);
	assert.equal(config.slots.host.model.value, "provider/host");
	assert.equal(config.slots.host.effort.resolved, "off");
	assert.equal(config.slots.local.executor.value, "local-b");
	assert.equal(config.slots.local.model.value, "local-only");
	assert.equal(config.slots.local.effort.resolved, "high");
	assert.equal(config.slots.local.model.source, "author-stage");
});

test("F7 foreach and dynamic profile structure stays unchanged without trace", () => {
	const s = spec([
		{ id: "fan", type: "foreach", from: "source", each: { prompt: "Read" } },
		dynamicStage("d", { workerDefaults: { agent: "reader" } }),
	]);
	s.executionProfiles = {
		p: {
			fan: { model: "fan-profile" },
			"d.$workerDefaults": { model: "worker-profile" },
		},
	};
	const result = applyWorkflowExecutionProfile(s, "p");
	const expected = structuredClone(s);
	expected.artifactGraph.stages[0].model = "fan-profile";
	expected.artifactGraph.stages[1].dynamic.decisionLoop.workerDefaults.model =
		"worker-profile";
	assert.deepEqual(result.spec, expected);
	const traced = applyWorkflowExecutionProfile(s, "p", undefined, true);
	assert.equal(
		Object.getOwnPropertySymbols(
			traced.spec.artifactGraph.stages[1].dynamic.decisionLoop.workerDefaults,
		).length,
		1,
	);
});
test("F4 explicitly empty overrides do not persist a provenance-only layer", async () => {
	const r = await prepared(
		spec([dynamicStage("d")]),
		{},
		{ runtimeOverrides: {} },
	);
	assert.equal(task(r, "d").dynamic.runtimeOverrides, undefined);
});

for (const id of [
	"__proto__",
	"constructor",
	"hasOwnProperty",
	"workflow-default",
])
	test(`F8 engine unconfigured ${id} survives frozen configuration roundtrip`, async () => {
		const path = join(cwd, `unconfigured-${id}.json`);
		writeFileSync(
			path,
			JSON.stringify(spec([stage(id, { model: "authored" })])),
		);
		let config;
		await assert.rejects(
			runWorkflowSpec(path, cwd, {
				preflightOnly: true,
				defaultExecutor: "local-a",
				projectWorkflowSettings: capture({ slots: {} }),
				configurationSink: (c) => {
					config = c;
				},
			}),
			(e) => e instanceof WorkflowPreflightPassed,
		);
		assert.ok(Object.hasOwn(config.slots, id));
		assert.ok(Object.isFrozen(config.slots[id]));
		const saved = JSON.parse(JSON.stringify(config));
		assert.ok(Object.hasOwn(saved.slots, id));
		assert.equal(saved.slots[id].model.value, "authored");
		assert.equal(saved.slots[id].executor.value, "local-a");
		assert.equal(saved.slots[id].executor.source, "default");
	});
test("F8 mixed special slot keeps explicit executor and planner overlay own data", async () => {
	const r = await prepared(spec([stage("ordinary"), stage("__proto__")]), {
		defaults: { executor: "local-a", model: "common" },
		slots: JSON.parse('{"__proto__":{"executor":"local-b","model":"special"}}'),
	});
	assert.equal(r.plan.roleExecution.mixed, true);
	assert.equal(task(r, "__proto__").runtime.executor, "local-b");
	assert.equal(task(r, "__proto__").runtime.model, "special");
	assert.equal(task(r, "ordinary").runtime.model, "common");
	assert.deepEqual(r.plan.modelChecks, [
		{ slot: "ordinary", executor: "local-a", model: "common" },
		{ slot: "__proto__", executor: "local-b", model: "special" },
	]);
	const saved = JSON.parse(JSON.stringify(r.compiled));
	assert.ok(Object.hasOwn(saved.configuration.slots, "__proto__"));
	assert.equal(
		saved.configuration.slots.__proto__.executor.source,
		"project-slot",
	);
});

test("F1-F3 ordinary engine trace contains only resolved model slots and canonical exhaustion", async () => {
	const path = join(cwd, "ordinary-loop-trace.json");
	writeFileSync(
		path,
		JSON.stringify(
			spec([
				{
					id: "cycle",
					type: "loop",
					maxRounds: 1,
					stages: [stage("work"), stage("check")],
					until: { stage: "check", path: "$.done", equals: true },
					onExhausted: stage("fallback"),
				},
				dynamicStage("d", { workerDefaults: { agent: "reader" } }),
			]),
		),
	);
	let config;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			defaultExecutor: "local-a",
			configurationSink: (c) => {
				config = c;
			},
		}),
		(e) => e instanceof WorkflowPreflightPassed,
	);
	assert.deepEqual(
		Object.keys(config.slots).sort(),
		[
			"cycle.$onExhausted",
			"cycle.check",
			"cycle.work",
			"d",
			"d.$workerDefaults",
		].sort(),
	);
	for (const row of Object.values(config.slots)) {
		assert.equal(row.executor.source, "default");
		assert.equal(row.executor.value, "local-a");
	}
});
test("matrix engine explicit executor records dynamic leaf shadow without pinning parent or siblings", async () => {
	const path = join(cwd, "leaf-shadow.json");
	writeFileSync(
		path,
		JSON.stringify(
			spec([
				dynamicStage("d", {
					planner: { agent: "reader" },
					verifier: { agent: "reader" },
				}),
			]),
		),
	);
	let config;
	await assert.rejects(
		runWorkflowSpec(path, cwd, {
			preflightOnly: true,
			executor: "local-a",
			projectWorkflowSettings: capture({
				slots: { "d.$verifier": { executor: "local-b", model: "foreign" } },
			}),
			configurationSink: (c) => {
				config = c;
			},
		}),
		(e) => e instanceof WorkflowPreflightPassed,
	);
	assert.deepEqual(
		config.shadowed.map(({ scope, slot, field }) => ({ scope, slot, field })),
		[
			{ scope: "slot", slot: "d.$verifier", field: "executor" },
			{ scope: "slot", slot: "d.$verifier", field: "model" },
		],
	);
	for (const row of Object.values(config.slots)) {
		assert.equal(row.executor.value, "local-a");
		assert.notEqual(row.model.value, "foreign");
	}
});

for (const bound of [false, true])
	test(`F8 native special-name slots resolve and persist bound=${bound}`, async () => {
		const project = join(root, `native-special-${bound}`);
		mkdirSync(join(project, ".agent-workflow", "agents"), { recursive: true });
		writeFileSync(
			join(project, ".agent-workflow", "agents", "reader.md"),
			readFileSync(join(cwd, ".agent-workflow", "agents", "reader.md")),
		);
		const ids = [
			"__proto__",
			"constructor",
			"hasOwnProperty",
			"workflow-default",
		];
		const path = join(project, "workflow.json");
		writeFileSync(path, JSON.stringify(spec(ids.map((id) => stage(id)))));
		const previousHome = process.env.AGENT_WORKFLOW_HOME;
		process.env.AGENT_WORKFLOW_HOME = join(
			root,
			`native-special-home-${bound}`,
		);
		let runId;
		try {
			const started = await runWorkflowSpec(path, project, {
				defaultExecutor: "local-a",
				projectWorkflowSettings: capture({
					defaults: { executor: "local-a", model: "common" },
					slots: bound
						? Object.fromEntries(
								ids.map((id) => [
									id,
									{ executor: "local-a", model: `bound-${id}` },
								]),
							)
						: {},
				}),
			});
			runId = started.runId;
			const done = await waitForRun(project, runId, 20000);
			assert.equal(done.status, "completed", JSON.stringify(done.tasks));
			const persisted = await readRunRecord(project, runId);
			const compiled = JSON.parse(
				readFileSync(compiledWorkflowPath(project, runId), "utf8"),
			);
			assert.deepEqual(persisted.configuration, compiled.configuration);
			const submits = readFixtureLog(join(root, "local-a.jsonl")).filter(
				(entry) =>
					entry.type === "submit" && entry.attemptKey?.split(":")[1] === runId,
			);
			assert.equal(submits.length, ids.length);
			for (const id of ids) {
				assert.ok(Object.hasOwn(persisted.configuration.slots, id));
				assert.ok(Object.hasOwn(persisted.roleExecution.stages, id));
				assert.equal(persisted.roleExecution.stages[id].executor, "local-a");
				assert.equal(
					persisted.configuration.slots[id].executor.source,
					bound ? "project-slot" : "project-default",
				);
				assert.equal(
					persisted.configuration.slots[id].model.value,
					bound ? `bound-${id}` : "common",
				);
				assert.equal(
					compiled.tasks.find((t) => t.stageId === id).runtime.model,
					bound ? `bound-${id}` : "common",
				);
				const recordedTask = persisted.tasks.find((t) => t.stageId === id);
				assert.ok(recordedTask);
				const dispatched = submits.filter(
					(entry) => entry.attemptKey.split(":")[2] === recordedTask.taskId,
				);
				assert.equal(dispatched.length, 1, `one native SDK submit for ${id}`);
				assert.equal(dispatched[0].cwd, project);
				assert.equal(dispatched[0].model, bound ? `bound-${id}` : "common");
			}
		} finally {
			if (runId) await drainWorkflowProject(project);
			await flushPendingIndexUpdatesForTests();
			process.env.AGENT_WORKFLOW_HOME = previousHome;
		}
	});

test("matrix nested foreach keeps canonical per-field template provenance", async () => {
	const r = await prepared(
		spec([
			{
				id: "outer",
				type: "dag",
				stages: [
					stage("source"),
					{
						id: "fan",
						type: "foreach",
						from: "source",
						each: { prompt: "Read" },
						output: { analysis: { required: true } },
					},
				],
			},
		]),
		{
			defaults: { executor: "local-a", model: "common", effort: "low" },
			slots: { "outer.fan": { executor: "local-a", model: "nested-template" } },
		},
	);
	const row = r.configuration.slots["outer.fan"];
	assert.equal(row.model.value, "nested-template");
	assert.equal(row.model.source, "project-slot");
	assert.equal(row.model.originSlot, "outer.fan");
	assert.equal(row.effort.source, "project-default");
	assert.equal(row.effort.originSlot, "outer.fan");
	assert.equal(row.effort.inheritedFrom, "workflow-default");
	assert.equal(row.effort.originScope, "workflow-default");
});
