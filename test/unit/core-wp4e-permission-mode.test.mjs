// New in agent-workflow (WP4e, owner decision "D2 개정 — 권한 모드"): permission mode `free`
// (default) and `safe`. Engine runs use the fixture executor (test/helpers/workflow-executor-
// fixture.mjs); approvals run through the runtime with the SDK fake. No model or agent-CLI calls.
// Safe-mode behavior (R#5, B4 refusal, fail-closed approvals) keeps its own tests, which now set
// `permissionMode: "safe"` explicitly (core-wp4b-seeds, core-wp4d-capability-negotiation,
// runtime-execute, runtime-control-channel).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const profiles = await import("../../dist/core/execution-profile.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const { prepareWorkflowTaskToolPolicy } = await import(
	"../../dist/core/tool-policy.js"
);
const { runSubagent } = await import("../../dist/runtime/index.js");
const sdk = await import("../../dist/sdk/index.js");
const { createFakeExecutorModule } = await import(
	"../../dist/sdk/testing/index.js"
);

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp4e-")));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR ??= join(root, "run-index");
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	for (const [name, tools] of [
		["reader", "read"],
		["writer", "read, bash"],
	])
		await writeFile(
			join(cwd, ".agent-workflow", "agents", `${name}.md`),
			[
				"---",
				`name: ${name}`,
				`description: ${name}`,
				`tools: ${tools}`,
				"---",
				"You do the task and report.",
				"",
			].join("\n"),
		);
	return cwd;
}

const READ_ONLY = {
	schemaVersion: 1,
	name: "wp4e-read-only",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};
const WRITABLE_OFF = {
	...READ_ONLY,
	name: "wp4e-writable",
	defaults: {
		agent: "writer",
		readOnly: false,
		tools: ["read", "bash"],
		worktreePolicy: "off",
	},
};

async function writeSpec(cwd, spec, name = "workflow.json") {
	const path = join(cwd, name);
	await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`);
	return path;
}

function fixture(config = {}) {
	counter += 1;
	const id = config.id ?? `wf-wp4e-${counter}`;
	const effectLog = join(root, `${id}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ ...config, id, effectLog }),
		),
	);
	return { id, effectLog };
}

const submits = (effectLog) =>
	readFixtureLog(effectLog).filter((entry) => entry.type === "submit");

async function persisted(cwd, runId) {
	return JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
}

async function finish(cwd, started) {
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	return run;
}

test("default is free: recorded on the run, first preview line, every SubmitRequest", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture();
	const started = await engine.runWorkflowSpec(
		await writeSpec(cwd, READ_ONLY),
		cwd,
		{ task: "t", executor: id },
	);
	assert.deepEqual(started.permissionMode, { mode: "free", source: "default" });
	assert.match(
		started.capabilityNegotiation.preview.split("\n")[0],
		/^Capability check \(wf-wp4e-\d+@0\.1\.0, 1 stage, permission mode: free\): accepted$/,
	);
	assert.equal(started.capabilityNegotiation.policy.permissionMode, "free");
	const run = await finish(cwd, started);
	assert.deepEqual((await persisted(cwd, run.runId)).permissionMode, {
		mode: "free",
		source: "default",
	});
	const [submit] = submits(effectLog);
	assert.equal(submit.permissionMode, "free");
	// readOnly is kept in free mode.
	assert.equal(submit.readOnly, true);
	assert.ok(!submit.approvalAllowKinds.includes("execute"));
});

test("precedence: run flag > workflow-declared profile > saved user profile > default", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture();
	const spec = {
		...READ_ONLY,
		executionProfiles: { careful: {}, plain: {} },
		executionProfilePermissionModes: { careful: "safe" },
	};
	const specPath = await writeSpec(cwd, spec);
	const saved = (mode) => ({
		name: "mine",
		...(mode === undefined ? {} : { permissionMode: mode }),
		definitionFingerprint: profiles.workflowDefinitionFingerprint(spec),
		stageOverrides: {},
	});
	const cases = [
		[
			{ executionProfile: "careful" },
			{ mode: "safe", source: "workflow-profile", profile: "careful" },
		],
		[
			{ executionProfile: "careful", permissionMode: "free" },
			{ mode: "free", source: "run-flag" },
		],
		[{ executionProfile: "plain" }, { mode: "free", source: "default" }],
		[
			{ executionProfileOverride: saved("safe") },
			{ mode: "safe", source: "user-profile", profile: "mine" },
		],
		[
			{ executionProfileOverride: saved("safe"), permissionMode: "free" },
			{ mode: "free", source: "run-flag" },
		],
		[
			{ executionProfileOverride: saved() },
			{ mode: "free", source: "default" },
		],
		[{ permissionMode: "safe" }, { mode: "safe", source: "run-flag" }],
	];
	for (const [options, expected] of cases) {
		const started = await engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			...options,
		});
		assert.deepEqual(started.permissionMode, expected, JSON.stringify(options));
		assert.match(
			started.capabilityNegotiation.preview,
			new RegExp(`permission mode: ${expected.mode}\\)`),
		);
		await finish(cwd, started);
	}
	assert.deepEqual(
		submits(effectLog).map((entry) => entry.permissionMode),
		cases.map(([, expected]) => expected.mode),
	);
});

test("invalid modes fail before any run record: run flag, saved profile, spec field", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture();
	const specPath = await writeSpec(cwd, READ_ONLY);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			permissionMode: "yolo",
		}),
		/permission mode "yolo" from run flag is invalid; use "free" or "safe"/,
	);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			executionProfileOverride: {
				name: "mine",
				permissionMode: "open",
				definitionFingerprint:
					profiles.workflowDefinitionFingerprint(READ_ONLY),
				stageOverrides: {},
			},
		}),
		/permission mode "open" from saved user profile "mine" is invalid/,
	);
	const bad = await writeSpec(
		cwd,
		{
			...READ_ONLY,
			executionProfiles: { a: {} },
			executionProfilePermissionModes: { a: "wild", ghost: "safe" },
		},
		"bad.json",
	);
	await assert.rejects(
		engine.runWorkflowSpec(bad, cwd, { task: "t", executor: id }),
		(error) =>
			/executionProfilePermissionModes\.a/.test(error.message) &&
			/must be "free" or "safe"/.test(error.message) &&
			/unknown execution profile "ghost"/.test(error.message),
	);
	const runs = join(cwd, ".agent-workflow", "workflows");
	assert.equal(existsSync(runs) && readdirSync(runs).length > 0, false);
	assert.deepEqual(submits(effectLog), []);
});

test("free: coarse allowlist is a recorded degradation (no refusal, no forced readOnly, no confirmation); worktreePolicy off honored", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: {
			toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
			contextIsolation: {
				level: "emulated",
				source: "probed",
				warning: "global AGENTS.md loaded",
			},
		},
	});
	const specPath = await writeSpec(cwd, WRITABLE_OFF);
	let hookCalls = 0;
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		interactive: true,
		confirmDegradations: async () => {
			hookCalls += 1;
			return false;
		},
	});
	assert.equal(hookCalls, 0, "free mode never asks for these degradations");
	const negotiation = started.capabilityNegotiation;
	assert.deepEqual(negotiation.forcedReadOnly, []);
	assert.deepEqual(negotiation.degradations.sort(), [
		"a.main: CAPABILITY_MISSING:toolAllowlist.fine",
		"a.main: CAPABILITY_WARNING:contextIsolation",
	]);
	assert.equal(negotiation.confirmation, "not-needed");
	assert.match(
		negotiation.preview,
		/toolAllowlist\.fine: degraded \(accepted: free mode\)/,
	);
	const run = await finish(cwd, started);
	// No R#5 override: the spec's worktreePolicy "off" runs in the shared checkout.
	assert.equal(run.tasks[0].worktree?.enabled === true, false);
	const [submit] = submits(effectLog);
	assert.equal(submit.permissionMode, "free");
	assert.equal(submit.readOnly, false);
	assert.equal(submit.cwd, cwd);
	assert.ok(submit.approvalAllowKinds.includes("execute"));
	// The same spec in safe mode is refused before launch (B4, unchanged).
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			permissionMode: "safe",
		}),
		(error) =>
			error instanceof core.WorkflowCapabilityError &&
			/CAPABILITY_MISSING:toolAllowlist\.fine.*permissionMode "free"/s.test(
				error.message,
			),
	);
	assert.equal(submits(effectLog).length, 1);
});

test("compile: R#5 forced worktree applies only in safe; free honors worktreePolicy as written", async () => {
	const cwd = await project();
	const spec = (worktreePolicy) => ({
		...WRITABLE_OFF,
		defaults: { ...WRITABLE_OFF.defaults, worktreePolicy },
	});
	const free = await compileWorkflow(spec("off"), {
		cwd,
		permissionMode: "free",
		allowSharedCheckoutWrites: true,
	});
	assert.equal(free.permissionMode, "free");
	assert.equal(free.tasks[0].safety.requiresWorktree, false);
	assert.equal(
		Object.hasOwn(free.tasks[0].safety, "allowSharedCheckoutWrites"),
		false,
	);
	assert.equal(
		free.warnings.some((w) => w.includes("still required")),
		false,
	);
	const freeAuto = await compileWorkflow(spec("auto"), {
		cwd,
		permissionMode: "free",
	});
	assert.equal(
		freeAuto.tasks[0].safety.requiresWorktree,
		true,
		"auto: pi-workflow behavior",
	);
	const freeOn = await compileWorkflow(
		{ ...READ_ONLY, defaults: { ...READ_ONLY.defaults, worktreePolicy: "on" } },
		{ cwd, permissionMode: "free" },
	);
	assert.equal(freeOn.tasks[0].safety.requiresWorktree, true);
	for (const options of [{ cwd, permissionMode: "safe" }, { cwd }]) {
		const safe = await compileWorkflow(spec("off"), options);
		assert.equal(
			safe.tasks[0].safety.requiresWorktree,
			true,
			"safe/absent: R#5",
		);
		assert.ok(safe.warnings.some((w) => w.includes("still required")));
	}
	// Inherited host tools: free keeps a spec "off", safe forces the worktree.
	const task = {
		id: "t",
		kind: "single",
		runtime: { approvalMode: "non-interactive", tools: ["read"] },
		safety: {
			readOnlyDeclared: true,
			capability: "read-only",
			sharedCwdSafe: true,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
	};
	for (const [mode, expected] of [
		["free", false],
		["safe", true],
	])
		assert.equal(
			prepareWorkflowTaskToolPolicy(task, {
				inheritHostTools: true,
				permissionMode: mode,
			}).safety.requiresWorktree,
			expected,
			mode,
		);
});

const APPROVAL_SCRIPT = (kind) => [
	{ type: "started", sessionId: null },
	{
		approval: {
			type: "approval_request",
			requestId: `${kind}-1`,
			kind,
			detail: kind,
		},
		ifAllowed: [{ type: "completed", finalText: "allowed" }],
		ifDenied: [{ type: "completed", finalText: "denied" }],
	},
];

async function approvalRun(kind, request) {
	const module = `inline:wp4e-approval-${kind}-${(counter += 1)}`;
	const registry = sdk.createExecutorRegistry();
	registry.register(
		module,
		createFakeExecutorModule({ script: APPROVAL_SCRIPT(kind) }),
	);
	const dir = join(root, `approval-${counter}`);
	await mkdir(dir, { recursive: true });
	const result = await runSubagent({
		cwd: dir,
		executor: {
			id: "fake",
			version: "0.1.0",
			contractVersion: sdk.EXECUTOR_CONTRACT_VERSION,
			module,
			config: null,
		},
		task: "needs approval",
		registry,
		...request,
	});
	const resultPath = result.artifacts.find((a) => a.type === "result").path;
	const audit = (
		await readFile(
			join(result.cwd, dirname(resultPath), "approvals.jsonl"),
			"utf8",
		)
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { result, audit };
}

test("free: approvals that still arrive are allowed by engine policy and audited engine-policy:free; readOnly mutations stay denied", async () => {
	const allowed = await approvalRun("execute", {
		permissionMode: "free",
		approvalPolicy: { allowKinds: [], interactive: false },
	});
	assert.equal(allowed.result.status, "completed");
	assert.deepEqual(allowed.result.metadata.executor.approvals, [
		{
			requestId: "execute-1",
			kind: "execute",
			decision: "allow",
			by: "engine-policy:free",
			response: "accepted",
		},
	]);
	const decided = allowed.audit.find((record) => record.phase === "decided");
	assert.equal(decided.by, "engine-policy:free");
	assert.match(decided.reason, /free permission mode allows execute/);

	const readOnly = await approvalRun("edit", {
		permissionMode: "free",
		readOnly: true,
		approvalPolicy: { allowKinds: ["edit"] },
	});
	assert.equal(readOnly.result.metadata.executor.approvals[0].decision, "deny");
	assert.equal(
		readOnly.result.metadata.executor.approvals[0].by,
		"engine-policy:free",
	);

	// Same request in safe: fail-closed policy answer.
	const safe = await approvalRun("execute", {
		permissionMode: "safe",
		approvalPolicy: { allowKinds: [], interactive: false },
	});
	assert.equal(safe.result.metadata.executor.approvals[0].decision, "deny");
	assert.equal(safe.result.metadata.executor.approvals[0].by, "engine-policy");
});

test("runtime input: permissionMode is validated, carried into the request and executor record", async () => {
	const { validateRuntimeRunInput, buildSubmitRequestFields } = await import(
		"../../dist/runtime/index.js"
	);
	const executor = {
		id: "fake",
		version: "0.1.0",
		contractVersion: sdk.EXECUTOR_CONTRACT_VERSION,
		module: "inline:x",
		config: null,
	};
	const bad = validateRuntimeRunInput({
		executor,
		task: "t",
		permissionMode: "on",
	});
	assert.equal(bad.ok, false);
	assert.match(bad.failure.error, /permissionMode must be "free" or "safe"/);
	const ok = validateRuntimeRunInput({
		executor,
		task: "t",
		permissionMode: "free",
	});
	assert.equal(ok.ok, true);
	const fields = buildSubmitRequestFields({
		input: ok.input,
		runId: "r",
		attemptId: "a",
		cwd: "/tmp",
		startedAt: new Date(0),
	});
	assert.equal(fields.permissionMode, "free");
	const absent = buildSubmitRequestFields({
		input: { task: "t" },
		runId: "r",
		attemptId: "a",
		cwd: "/tmp",
		startedAt: new Date(0),
	});
	assert.equal(
		Object.hasOwn(absent, "permissionMode"),
		false,
		"absent = SDK default safe",
	);
});
