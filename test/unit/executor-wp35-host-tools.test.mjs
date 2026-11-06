import { stateDir } from "../helpers/state-dir.mjs";
import { drainWorkflowProject } from "../helpers/workflow-fixture-lifecycle.mjs";
// New in agent-workflow (WP35, feature-parity row 40): host-tool inheritance from a Pi host. A Pi 1.1
// session with native codemode/MCP lends codemode, tool_search, `mcp__*` and the MCP resource tools
// to Pi workers: the Pi host captures it (piNativeHostTools), the launch sets the run option
// inheritHostTools and records the host context, the engine honors it only for the pi executor,
// readOnly stages never inherit, the preview/record carries a notice, and the Pi executor turns the
// per-task descriptor config into argv. Engine runs use the workflow executor fixture registered as
// "pi"; the Pi executor runs against a stub CLI. No model or agent-CLI calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";
import {
	PROBE_SCRIPTS,
	loadTranscript,
	replaySteps,
} from "../fixtures/executors/pi/harness.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const hostApi = await import("../../dist/hosts/api.js");
const piHost = await import("../../dist/hosts/pi/host.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const { createHostContext, withHostContext } = await import(
	"../../dist/core/host-context.js"
);
const { createRunRecord } = await import("../../dist/core/store.js");
const { createLaunchBootstrapProvenance } = await import(
	"../../dist/core/launch-bootstrap-provenance.js"
);
const { prepareDagTask } = await import(
	"../../dist/core/artifact-graph-runtime.js"
);
const { resolveWorkflowResourcePolicy } = await import(
	"../../dist/core/resource-inheritance.js"
);
const { hostToolInheritanceNotice } = await import(
	"../../dist/core/capability-negotiation.js"
);
const pi = await import("../../dist/executors/pi/index.js");
const sdk = await import("../../dist/sdk/index.js");
const { createStubCli } = await import("../../dist/sdk/conformance/index.js");

let root;
const unregister = [];
const projects = new Set();
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp35-host-tools-")));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR ??= join(root, "run-index");
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const cwd of projects) await drainWorkflowProject(cwd);
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const SPEC = {
	schemaVersion: 1,
	name: "wp35-host-tools",
	defaults: { agent: "writer", worktreePolicy: "off" },
	artifactGraph: {
		stages: [
			{
				id: "change",
				type: "single",
				readOnly: false,
				tools: ["read", "bash"],
				prompt: "Change things.",
			},
			{
				id: "look",
				type: "single",
				after: "change",
				readOnly: true,
				tools: ["read"],
				prompt: "Look at things.",
			},
		],
	},
};

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	projects.add(cwd);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "writer.md"),
		"---\nname: writer\ndescription: writer\ntools: read, bash\n---\nYou do the task and report.\n",
	);
	const specPath = join(cwd, "wf.json");
	await writeFile(specPath, `${JSON.stringify(SPEC, null, 2)}\n`);
	return { cwd, specPath };
}

/** Register the workflow fixture under `id` (pi = stands in for the Pi executor). */
function fixture(id) {
	counter += 1;
	const effectLog = join(root, `${id}-${counter}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor({ id, effectLog })),
	);
	return effectLog;
}

const submits = (effectLog) =>
	readFixtureLog(effectLog).filter((entry) => entry.type === "submit");
// Task ids follow the stage order: task-1 = change, task-2 = look.
const stageOf = (entry) =>
	({ "task-1": "change", "task-2": "look" })[entry.attemptKey.split(":")[2]];

function fakePi({ native }) {
	return {
		registerCommand() {},
		registerTool() {},
		on: () => () => undefined,
		...(native ? { getMcpServers: () => [] } : {}),
	};
}
function fakeCtx(cwd, { trusted } = {}) {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		ui: {
			notify() {},
			confirm: async () => true,
			select: async () => undefined,
		},
		...(trusted === undefined ? {} : { isProjectTrusted: () => trusted }),
	};
}

async function launch(ctx, specPath, executor) {
	const result = await hostApi.runWorkflowAction(ctx, {
		workflow: specPath,
		task: "t",
		executor,
		forceNew: true,
	});
	assert.ok(result.data.runId, result.text);
	const run = await engine.waitForRun(ctx.cwd, result.data.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	return { result, run };
}

test("Pi host capture: a native codemode/MCP session lends its tools; an older Pi lends nothing", () => {
	const cwd = "/tmp/wp35";
	const native = piHost.createPiHostDeps(fakePi({ native: true }));
	assert.deepEqual(
		piHost.hostContext(native, fakeCtx(cwd, { trusted: true })).hostTools,
		{ projectTrusted: true },
	);
	assert.deepEqual(
		piHost.hostContext(native, fakeCtx(cwd, { trusted: false })).hostTools,
		{ projectTrusted: false },
	);
	// No isProjectTrusted (pre-1.1 context) or no getMcpServers (pre-1.1 API): unchanged launches.
	assert.equal(
		Object.hasOwn(piHost.hostContext(native, fakeCtx(cwd)), "hostTools"),
		false,
	);
	const legacy = piHost.createPiHostDeps(fakePi({ native: false }));
	assert.equal(
		Object.hasOwn(
			piHost.hostContext(legacy, fakeCtx(cwd, { trusted: true })),
			"hostTools",
		),
		false,
	);
});

test("compile: a readOnly stage never inherits host tools; a writable stage does (mutation-capable)", async () => {
	const { cwd } = await project();
	const compiled = await compileWorkflow(SPEC, {
		cwd,
		task: "t",
		inheritHostTools: true,
	});
	const [change, look] = compiled.tasks;
	assert.equal(change.runtime.inheritHostTools, true);
	assert.equal(change.safety.capability, "mutation-capable");
	assert.equal(look.runtime.inheritHostTools, false);
	assert.equal(look.safety.capability, "read-only");
	assert.equal(look.safety.requiresWorktree, false);
	assert.match(
		hostToolInheritanceNotice(compiled.tasks),
		/inherited by change\.main \(mutation-capable.*not by readOnly stage look\.main$/u,
	);
	const plain = await compileWorkflow(SPEC, { cwd, task: "t" });
	assert.equal(hostToolInheritanceNotice(plain.tasks), undefined);
});

test("Pi host + pi executor: the worker gets inheritHostTools, readOnly stages do not; recorded in the preview", async () => {
	const { cwd, specPath } = await project();
	const effectLog = fixture("pi");
	const ctx = {
		cwd,
		env: process.env,
		host: "pi",
		hostTools: { projectTrusted: false },
	};
	const { result, run } = await launch(ctx, specPath, "pi");
	assert.equal(run.inheritHostTools, true);
	assert.equal(run.hostContext.cwd, cwd);
	assert.equal(run.hostContext.projectTrusted, false);
	const notice = run.capabilityNegotiation.notices.find((entry) =>
		entry.startsWith("host tools:"),
	);
	assert.ok(notice, JSON.stringify(run.capabilityNegotiation.notices));
	assert.match(notice, /inherited by change\b.*not by readOnly stage look/u);
	assert.match(run.capabilityNegotiation.preview, /Notice: host tools:/u);
	assert.ok(result.data.capability.notices.includes(notice));
	const byStage = Object.fromEntries(
		submits(effectLog).map((entry) => [stageOf(entry), entry]),
	);
	assert.ok(byStage.change, JSON.stringify(submits(effectLog)));
	assert.equal(byStage.change.inheritHostTools, true);
	assert.equal(byStage.change.readOnly, false);
	assert.equal(Object.hasOwn(byStage.look, "inheritHostTools"), false);
	assert.equal(byStage.look.readOnly, true);
});

test("Pi executor: the per-task descriptor config adds the host tools to the worker argv; readOnly excludes them", async () => {
	const dir = await mkdtemp(join(root, "pi-argv-"));
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: [
			...PROBE_SCRIPTS,
			{
				name: "run",
				when: { argvIncludes: ["--mode", "json"] },
				steps: replaySteps(await loadTranscript("complete-read")),
			},
		],
	});
	// The config the engine sends for an inheriting task (descriptor config + inheritHostTools).
	const executor = pi.createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
		inheritHostTools: true,
	});
	const submit = async (overrides) => {
		counter += 1;
		const attemptKey = `wp35-host-tools-${process.pid}-${counter}`;
		const gate = sdk.createAuthorityGate({ attemptKey });
		const ref = await executor.submit({
			attemptKey,
			authority: gate.authority,
			cwd: dir,
			prompt: "hello",
			tools: ["read", "bash"],
			readOnly: false,
			mcpServers: [],
			deadlineMs: Date.now() + 60_000,
			env: {},
			isolation: { inherit: false },
			approvalPolicy: sdk.defaultApprovalPolicy(),
			...overrides,
		});
		for await (const _event of executor.observe(ref));
		const launches = (await cli.invocations()).filter((entry) => entry.effect);
		return launches.at(-1).argv;
	};
	const tools = (argv) => argv[argv.indexOf("--tools") + 1].split(",");
	const writable = await submit({});
	for (const tool of pi.INHERITED_HOST_TOOLS)
		assert.ok(tools(writable).includes(tool), tool);
	for (const builtin of [
		"builtin:mcp",
		"builtin:codemode",
		"builtin:tool-search",
	])
		assert.ok(writable.includes(builtin), builtin);
	// readOnly (authored or forced): mutation-capable inherited tools never reach the worker.
	const readOnly = await submit({ tools: ["read"], readOnly: true });
	assert.deepEqual(tools(readOnly), ["read"]);
	for (const tool of ["codemode", "tool_search", "mcp__*"])
		assert.ok(!tools(readOnly).includes(tool), tool);
	assert.ok(!readOnly.includes("builtin:mcp"));
});

test("non-Pi host or non-pi executor: nothing changes", async () => {
	// A host without hostTools (CLI, MCP): no inheritance, no host context.
	{
		const { cwd, specPath } = await project();
		const effectLog = fixture("pi");
		const { run } = await launch(
			{ cwd, env: process.env, host: "cli" },
			specPath,
			"pi",
		);
		assert.equal(Object.hasOwn(run, "inheritHostTools"), false);
		assert.equal(Object.hasOwn(run, "hostContext"), false);
		assert.equal(
			(run.capabilityNegotiation.notices ?? []).some((entry) =>
				entry.startsWith("host tools:"),
			),
			false,
		);
		for (const entry of submits(effectLog))
			assert.equal(Object.hasOwn(entry, "inheritHostTools"), false);
	}
	// The Pi host lends its tools but the run uses another executor: ignored.
	{
		const { cwd, specPath } = await project();
		const effectLog = fixture("wf-wp35-other");
		const { run } = await launch(
			{
				cwd,
				env: process.env,
				host: "pi",
				hostTools: { projectTrusted: true },
			},
			specPath,
			"wf-wp35-other",
		);
		assert.equal(Object.hasOwn(run, "inheritHostTools"), false);
		for (const task of run.tasks) assert.notEqual(task.inheritHostTools, true);
		for (const entry of submits(effectLog))
			assert.equal(Object.hasOwn(entry, "inheritHostTools"), false);
	}
});

test("launch provenance: inheriting host tools needs the run's pi executor (fails closed otherwise)", async () => {
	const { cwd } = await project();
	const compiled = await compileWorkflow(SPEC, {
		cwd,
		task: "t",
		inheritHostTools: true,
	});
	const context = createHostContext({ cwd, projectTrusted: false });
	const { run } = await withHostContext(context, () =>
		createRunRecord(cwd, compiled, join(cwd, "wf.json")),
	);
	const prepared = await prepareDagTask(cwd, run, compiled, 0);
	const launch = {
		captureToolCalls: false,
		hostContext: { ...context },
		resourcePolicy: resolveWorkflowResourcePolicy(prepared),
	};
	const provenance = (executorId) =>
		createLaunchBootstrapProvenance(
			cwd,
			{ ...run, executor: { ...(run.executor ?? {}), id: executorId } },
			run.tasks[0],
			prepared,
			"unit",
			launch,
		);
	const record = await provenance("pi");
	assert.equal(record.effectivePolicy.inheritHostTools, true);
	await assert.rejects(provenance("codex"), /needs the pi executor/u);
});

// WP39b (live bundle 5, O8): a worker that inherits the host tools was told "Only these tools are
// enabled: read, bash … unavailable tools cannot be called" and answered "tool_search is not
// available". Its Effective Tool Policy now lists the inherited host tools as available; a readOnly
// stage's policy is unchanged.
test("the Effective Tool Policy of a worker that inherits host tools lists them as available", async () => {
	const { readFile } = await import("node:fs/promises");
	const { cwd, specPath } = await project();
	fixture("pi");
	const ctx = {
		cwd,
		env: process.env,
		host: "pi",
		hostTools: { projectTrusted: true },
	};
	const { run } = await launch(ctx, specPath, "pi");
	const prompt = async (specId) =>
		readFile(
			join(
				stateDir(cwd),
				run.tasks.find((task) => task.taskId === specId).files.systemPrompt,
			),
			"utf8",
		);
	// Task ids follow the stage order: task-1 = change, task-2 = look.
	const change = await prompt("task-1");
	assert.match(
		change,
		/Host tools inherited from the Pi session are also available: codemode, tool_search, mcp__\* \(matching MCP tools\), list_mcp_resources, list_mcp_resource_templates, read_mcp_resource;/u,
	);
	assert.match(
		change,
		/Only these workflow tools are enabled for this workflow task: [^\n]*read[^\n]*bash/u,
	);
	assert.doesNotMatch(change, /unavailable tools cannot be called/u);
	assert.match(change, /use them when the task needs them/u);
	const look = await prompt("task-2");
	assert.doesNotMatch(look, /Host tools inherited/u);
	assert.match(
		look,
		/unavailable tools cannot be called in this workflow run/u,
	);
});
