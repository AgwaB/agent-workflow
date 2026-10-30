// New in agent-workflow (WP31 × WP35 merge): host-tool inheritance is decided per task in a mixed
// run. A fake native Pi host (hostTools) launches a role-profile run that mixes the workflow fixture
// registered as `pi` and as `claude` (no CLI or model call): writable pi stages get inheritHostTools
// as per-task descriptor config, claude stages and readOnly pi stages do not, the negotiation record
// and the capability preview say so per stage, and launch provenance checks each task's executor.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const { createHostContext, withHostContext } = await import(
	"../../dist/core/host-context.js"
);
const { createLaunchBootstrapProvenance } = await import(
	"../../dist/core/launch-bootstrap-provenance.js"
);
const { prepareDagTask } = await import(
	"../../dist/core/artifact-graph-runtime.js"
);
const { resolveWorkflowResourcePolicy } = await import(
	"../../dist/core/resource-inheritance.js"
);

let root;
let counter = 0;
const undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp31-wp35-")));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR ??= join(root, "run-index");
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const restore of undo.splice(0)) restore();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

/** Registers the workflow fixture as `pi` and `claude` (replacing the built-ins here). */
function executors() {
	for (const restore of undo.splice(0)) restore();
	counter += 1;
	const logs = {};
	for (const id of ["pi", "claude"]) {
		logs[id] = join(root, `${id}-${counter}.jsonl`);
		undo.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({ id, effectLog: logs[id] }),
			),
		);
	}
	return logs;
}

// change (planning → pi, writable), edit (default → claude, writable), look (verification → pi,
// readOnly). The run's executor is claude (the default role): pi is the mixed run's other executor.
const SPEC = {
	schemaVersion: 1,
	name: "wp31-wp35-mixed-host-tools",
	defaults: { agent: "writer", worktreePolicy: "off" },
	artifactGraph: {
		stages: [
			{
				id: "change",
				type: "single",
				profileRole: "planning",
				readOnly: false,
				tools: ["read", "bash"],
				prompt: "Change things.",
			},
			{
				id: "edit",
				type: "single",
				after: "change",
				readOnly: false,
				tools: ["read", "bash"],
				prompt: "Edit things.",
			},
			{
				id: "look",
				type: "single",
				after: "edit",
				profileRole: "verification",
				readOnly: true,
				tools: ["read"],
				prompt: "Look at things.",
			},
		],
	},
};

const ROLES = {
	default: { executor: "claude" },
	planning: { executor: "pi" },
	verification: { executor: "pi" },
};

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "writer.md"),
		"---\nname: writer\ndescription: writer\ntools: read, bash\n---\nYou do the task and report.\n",
	);
	const specPath = join(cwd, "wf.json");
	await writeFile(specPath, `${JSON.stringify(SPEC, null, 2)}\n`);
	const ctx = {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		host: "pi",
		hostTools: { projectTrusted: false },
	};
	const saved = await api.profileAction(ctx, {
		op: "set",
		name: "mixed",
		values: { roles: ROLES },
		makeDefault: true,
	});
	assert.equal(saved.outcome, "success", saved.text);
	return { cwd, specPath, ctx };
}

async function stageOfSubmits(cwd, runId, log) {
	const run = await store.readRunRecord(cwd, runId);
	const specs = Object.fromEntries(
		run.tasks.map((task) => [task.taskId, task.specId.split(".")[0]]),
	);
	return Object.fromEntries(
		readFixtureLog(log)
			.filter((entry) => entry.type === "submit")
			.map((entry) => [specs[entry.attemptKey.split(":")[2]], entry]),
	);
}

test("mixed run from a native Pi host: pi tasks inherit host tools, claude tasks and readOnly pi stages do not", async () => {
	const logs = executors();
	const { cwd, specPath, ctx } = await project();
	const launched = await api.runWorkflowAction(ctx, {
		workflow: specPath,
		task: "mixed host tools",
		forceNew: true,
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.equal(launched.data.roles.mixed, true);
	assert.equal(launched.data.executor.id, "claude");
	const run = await engine.waitForRun(cwd, launched.data.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	assert.equal(run.inheritHostTools, true);
	assert.equal(run.hostContext.cwd, cwd);
	assert.deepEqual(
		Object.fromEntries(
			run.tasks.map((task) => [task.specId, task.runtime.executor]),
		),
		{ "change.main": "pi", "edit.main": "claude", "look.main": "pi" },
	);

	// argv/config: the pi executor receives inheritHostTools as per-task descriptor config.
	const pi = await stageOfSubmits(cwd, run.runId, logs.pi);
	const claude = await stageOfSubmits(cwd, run.runId, logs.claude);
	assert.deepEqual(Object.keys(pi).sort(), ["change", "look"]);
	assert.deepEqual(Object.keys(claude), ["edit"]);
	assert.equal(pi.change.inheritHostTools, true);
	assert.equal(pi.change.readOnly, false);
	assert.equal(Object.hasOwn(pi.look, "inheritHostTools"), false);
	assert.equal(pi.look.readOnly, true);
	assert.equal(Object.hasOwn(claude.edit, "inheritHostTools"), false);

	// Per-stage negotiation record (the compiled decision per task) and preview.
	const negotiation = run.capabilityNegotiation;
	assert.deepEqual(
		Object.fromEntries(
			negotiation.stages.map((stage) => [stage.label, stage.hostTools]),
		),
		{
			"change.main": "inherited",
			"edit.main": "executor",
			"look.main": "readOnly",
		},
	);
	const notice = negotiation.notices.find((entry) =>
		entry.startsWith("host tools:"),
	);
	assert.match(
		notice,
		/inherited by change\.main .*not by readOnly stage look\.main; not by claude stage edit\.main \(only pi inherits\)$/u,
	);
	const preview = launched.data.capability.preview;
	assert.match(
		preview,
		/change\.main: pi@[^\n]*\n(?: {2}[^\n]*\n)*? {2}host tools: inherited/u,
	);
	assert.match(
		preview,
		/edit\.main: claude@[^\n]*\n(?: {2}[^\n]*\n)*? {2}host tools: not inherited \(claude executor; only pi inherits/u,
	);
	assert.match(
		preview,
		/look\.main: pi@[^\n]*\n(?: {2}[^\n]*\n)*? {2}host tools: not inherited \(readOnly stage\)/u,
	);
	// The launch text is the short preflight (2026-10-30): the per-stage block stays in the record
	// (above); the text carries the one-line host-tools notice.
	assert.match(launched.text, /⚠ host tools: .* inherited by change\.main/u);
});

test("a mixed run with no pi stage: the host's tools are ignored (no notice, no inheritance)", async () => {
	const logs = executors();
	const { cwd, specPath, ctx } = await project();
	const launched = await api.runWorkflowAction(ctx, {
		workflow: specPath,
		task: "all claude",
		executor: "claude",
		forceNew: true,
	});
	assert.equal(launched.outcome, "running", launched.text);
	const run = await engine.waitForRun(cwd, launched.data.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	assert.equal(Object.hasOwn(run, "inheritHostTools"), false);
	assert.equal(
		(run.capabilityNegotiation.notices ?? []).some((entry) =>
			entry.startsWith("host tools:"),
		),
		false,
	);
	assert.doesNotMatch(launched.data.capability.preview, /host tools:/u);
	for (const entry of readFixtureLog(logs.claude))
		assert.equal(Object.hasOwn(entry, "inheritHostTools"), false);
});

test("launch provenance checks the task's executor, not the run's", async () => {
	const { cwd } = await project();
	const compiled = await compileWorkflow(SPEC, {
		cwd,
		task: "t",
		inheritHostTools: true,
		runExecutor: "claude",
	});
	// Without stage executors, runExecutor decides: claude stages never inherit.
	for (const task of compiled.tasks)
		assert.notEqual(task.runtime.inheritHostTools, true, task.id);
	const piCompiled = await compileWorkflow(SPEC, {
		cwd,
		task: "t",
		inheritHostTools: true,
		runExecutor: "pi",
	});
	const context = createHostContext({ cwd, projectTrusted: false });
	const { run } = await withHostContext(context, () =>
		store.createRunRecord(cwd, piCompiled, join(cwd, "wf.json")),
	);
	const prepared = await prepareDagTask(cwd, run, piCompiled, 0);
	assert.equal(prepared.runtime.inheritHostTools, true);
	const launch = {
		extensions: [],
		generatedExtensions: [],
		captureToolCalls: false,
		hostContext: { ...context },
		resourcePolicy: resolveWorkflowResourcePolicy(prepared),
	};
	const provenance = (runExecutor, taskExecutor) =>
		createLaunchBootstrapProvenance(
			cwd,
			{ ...run, executor: { ...(run.executor ?? {}), id: runExecutor } },
			run.tasks[0],
			{
				...prepared,
				runtime: {
					...prepared.runtime,
					...(taskExecutor === undefined ? {} : { executor: taskExecutor }),
				},
			},
			"unit",
			launch,
		);
	// A pi task of a claude-run (mixed) inherits; a claude task of a pi run fails closed.
	const record = await provenance("claude", "pi");
	assert.equal(record.effectivePolicy.inheritHostTools, true);
	await assert.rejects(
		provenance("pi", "claude"),
		/needs the pi executor; task task-1 uses claude/u,
	);
});
