// New in agent-workflow (WP31 items 1-2, owner decision Q4): one run can mix executors by role. Two
// fixture executors are registered as `claude` and `codex` (no CLI or model call). A saved profile
// maps roles to executors/models/efforts; every task goes to its own executor, each stage is
// negotiated against its executor (refusal names the stage), resume keeps per-task executors, owned
// sessions are released through the executor that reported them, and status/inspect show the
// executor per task. Role models are checked against each executor's probe model list.
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
const retention = await import("../../dist/core/run-retention.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
let undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp31-mixed-")));
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

const WEB = {
	level: "native",
	source: "probed",
	detail: "search+fetch",
	safetyPolicy: "cli",
};

/** Registers fixtures as `claude` and `codex` (replacing the built-ins in this process). */
function executors(config = {}) {
	for (const restore of undo.splice(0)) restore();
	counter += 1;
	const logs = {};
	for (const id of ["claude", "codex"]) {
		logs[id] = join(root, `${id}-${counter}.jsonl`);
		undo.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					effectLog: logs[id],
					...(config.common ?? {}),
					...(config[id] ?? {}),
				}),
			),
		);
	}
	return logs;
}

async function project(stages, extra = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const agents = join(cwd, ".agent-workflow", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(agents, "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(agents, "webber.md"),
		"---\nname: webber\ndescription: searches\ntools: read, web_search\n---\nSearch.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				name: `wp31-mixed-${counter}`,
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: { stages },
				...extra,
			},
			null,
			2,
		)}\n`,
	);
	return {
		cwd,
		ctx: {
			cwd,
			env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		},
	};
}

const TWO_STAGES = [
	{ id: "plan", type: "single", profileRole: "planning", prompt: "Plan." },
	{
		id: "check",
		type: "single",
		profileRole: "verification",
		prompt: "Check.",
		from: "plan",
	},
];

const MIXED_ROLES = {
	default: { executor: "claude", model: "sonnet", effort: "high" },
	verification: { executor: "codex", model: "gpt-5.6-luna", effort: "medium" },
};

async function saveProfile(ctx, values) {
	const saved = await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values,
		makeDefault: true,
	});
	assert.equal(saved.outcome, "success", saved.text);
}

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

const submits = (log) =>
	readFixtureLog(log).filter((entry) => entry.type === "submit");
const label = (entry) => entry.attemptKey.split(":")[2];
/** Stage spec ids of the submits in `log` (attempt keys carry the task id). */
async function stagesOf(cwd, runId, log) {
	const run = await store.readRunRecord(cwd, runId);
	const specs = Object.fromEntries(
		run.tasks.map((task) => [task.taskId, task.specId.split(".")[0]]),
	);
	return submits(log).map((entry) => specs[label(entry)] ?? label(entry));
}

test("a mixed run sends every task to its role's executor with its model and effort", async () => {
	const logs = executors();
	const { ctx, cwd } = await project(TWO_STAGES);
	await saveProfile(ctx, { roles: MIXED_ROLES });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "mixed run",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.deepEqual(launched.data.executor, {
		id: "claude",
		source: "user-profile",
		profile: "mine",
	});
	assert.equal(launched.data.roles.mixed, true);
	assert.deepEqual(launched.data.roles.executors, ["claude", "codex"]);
	assert.deepEqual(
		launched.data.roles.stages.map((stage) => [
			stage.stage,
			stage.executor,
			stage.model,
			stage.effort,
			stage.role,
		]),
		[
			["plan", "claude", "sonnet", "high", "default"],
			["check", "codex", "gpt-5.6-luna", "medium", "verification"],
		],
	);
	assert.match(
		launched.text,
		/Capability check \(mixed: claude@0\.1\.0 ×1 \+ codex@0\.1\.0 ×1/,
	);
	assert.match(
		launched.text,
		/check → codex gpt-5\.6-luna medium \(role verification, user-profile\)/,
	);
	// The fixture probes list no models: the role models are noted as unverified, not refused.
	assert.match(launched.text, /model "sonnet" for plan is not verified/);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");

	const claude = submits(logs.claude);
	const codex = submits(logs.codex);
	assert.deepEqual(await stagesOf(cwd, launched.data.runId, logs.claude), [
		"plan",
	]);
	assert.deepEqual(await stagesOf(cwd, launched.data.runId, logs.codex), [
		"check",
	]);
	assert.equal(claude[0].model, "sonnet");
	assert.equal(claude[0].effort, "high");
	assert.equal(codex[0].model, "gpt-5.6-luna");
	assert.equal(codex[0].effort, "medium");

	const run = await store.readRunRecord(cwd, launched.data.runId);
	assert.equal(run.roleExecution.schema, "agent-workflow-role-execution-v1");
	assert.deepEqual(Object.keys(run.roleExecution.executors).sort(), [
		"claude",
		"codex",
	]);
	assert.equal(run.roleExecution.executors.codex.descriptor.id, "codex");
	assert.deepEqual(
		Object.fromEntries(
			run.tasks.map((task) => [task.specId, task.runtime.executor]),
		),
		{ "plan.main": "claude", "check.main": "codex" },
	);
	// One negotiation per stage against its own executor; the other executor's probe is recorded.
	assert.equal(run.capabilityNegotiation.executorId, "claude");
	assert.ok(run.capabilityNegotiation.executors.codex.capabilities);
	assert.deepEqual(
		Object.fromEntries(
			run.capabilityNegotiation.stages.map((stage) => [
				stage.label,
				stage.report.executorId,
			]),
		),
		{ "plan.main": "claude", "check.main": "codex" },
	);

	const status = await api.statusAction(ctx, { runId: launched.data.runId });
	assert.deepEqual(status.data.run.executors, ["claude", "codex"]);
	assert.deepEqual(
		status.data.run.tasks.map((task) => [
			task.specId,
			task.executor,
			task.model,
			task.effort,
		]),
		[
			["plan.main", "claude", "sonnet", "high"],
			["check.main", "codex", "gpt-5.6-luna", "medium"],
		],
	);
	const inspected = await api.inspectAction(ctx, {
		runId: launched.data.runId,
	});
	assert.match(
		inspected.text,
		/- task-2 \[codex gpt-5\.6-luna medium\]: completed/,
	);
	assert.match(inspected.text, /- task-1 \[claude sonnet high\]: completed/);
	const shown = await api.showRunAction(ctx, {
		runId: launched.data.runId,
		raw: true,
	});
	assert.match(
		shown.text,
		/spec=check\.main .*executor=codex model=gpt-5\.6-luna thinking=medium/,
	);
});

test("--executor puts every stage on one executor; a role model of another executor is not used", async () => {
	const logs = executors();
	const { ctx, cwd } = await project(TWO_STAGES);
	await saveProfile(ctx, { roles: MIXED_ROLES });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "flag wins",
		executor: "codex",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.equal(launched.data.roles.mixed, false);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.deepEqual(submits(logs.claude), []);
	const codex = submits(logs.codex);
	const stages = await stagesOf(cwd, launched.data.runId, logs.codex);
	assert.deepEqual([...stages].sort(), ["check", "plan"]);
	const byLabel = Object.fromEntries(
		codex.map((entry, index) => [stages[index], entry]),
	);
	// plan's role entry (default) belongs to claude: neither its model nor its effort applies.
	assert.equal(byLabel.plan.model, null);
	assert.equal(byLabel.check.model, "gpt-5.6-luna");
});

test("declared executionProfileRoles beat the saved profile's roles", async () => {
	const logs = executors();
	const { ctx } = await project(TWO_STAGES, {
		executionProfiles: { split: {} },
		executionProfileRoles: {
			split: { planning: { executor: "codex", effort: "low" } },
		},
	});
	await saveProfile(ctx, { roles: MIXED_ROLES });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "declared roles",
		profile: "split",
	});
	assert.equal(launched.outcome, "running", launched.text);
	const stages = Object.fromEntries(
		launched.data.roles.stages.map((stage) => [stage.stage, stage]),
	);
	assert.equal(stages.plan.executor, "codex");
	assert.equal(stages.plan.source, "workflow-profile");
	assert.equal(stages.plan.effort, "low");
	// The declared profile says nothing about verification: the saved profile decides.
	assert.equal(stages.check.executor, "codex");
	assert.equal(stages.check.source, "user-profile");
	// No stage uses claude any more: the run's executor is the first stage's.
	assert.equal(launched.data.executor.id, "codex");
	assert.equal(launched.data.roles.mixed, false);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.deepEqual(submits(logs.claude), []);
	assert.equal(submits(logs.codex).length, 2);
});

test("a stage whose executor lacks a required capability is refused before launch, naming the stage", async () => {
	const logs = executors({ claude: { capabilities: { webTools: WEB } } });
	const stages = [
		{ id: "plan", type: "single", profileRole: "planning", prompt: "Plan." },
		{
			id: "search",
			type: "single",
			profileRole: "research-execution",
			agent: "webber",
			tools: ["web_search"],
			prompt: "Search.",
		},
	];
	const { ctx } = await project(stages);
	await saveProfile(ctx, {
		roles: {
			default: { executor: "claude" },
			"research-execution": { executor: "codex" },
		},
	});
	const refused = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "web on codex",
	});
	assert.equal(refused.outcome, "refused", refused.text);
	assert.equal(refused.data.refusal.code, "CAPABILITY_REFUSED");
	assert.equal(refused.data.refusal.executorId, "codex");
	assert.match(
		refused.text,
		/stage "search\.main" on codex: webTools — CAPABILITY_MISSING:webTools/,
	);
	assert.doesNotMatch(refused.text, /stage "plan\.main"/);
	assert.deepEqual(submits(logs.claude), []);
	assert.deepEqual(submits(logs.codex), []);

	// The same stage on the executor that has web tools is accepted.
	const unset = await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		unset: ["roles.research-execution"],
	});
	assert.deepEqual(unset.data.profile.roles, {
		default: { executor: "claude" },
	});
	const accepted = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "web on claude",
	});
	assert.equal(accepted.outcome, "running", accepted.text);
	assert.equal((await settle(ctx, accepted.data.runId)).outcome, "completed");
	assert.equal(submits(logs.claude).length, 2);
});

test("role models are checked against the executor's probe list: unknown is refused", async () => {
	// WP31 follow-up: a missing model is refused only when the probe declares its list exhaustive.
	const probe = (models, modelListComplete) => ({
		installed: true,
		cliVersion: "fake-cli 1.0.0",
		auth: "ok",
		modelListComplete,
		notes: [`models: ${models.join(", ")}`],
	});
	const logs = executors({
		claude: { probe: probe(["default", "haiku", "sonnet"], false) },
		codex: { probe: probe(["gpt-5.6-luna"], true) },
	});
	const { ctx } = await project(TWO_STAGES);
	await saveProfile(ctx, {
		roles: {
			default: { executor: "claude", model: "sonnet" },
			verification: { executor: "codex", model: "gpt-9-unknown" },
		},
	});
	const refused = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "unknown model",
	});
	assert.equal(refused.outcome, "refused", refused.text);
	assert.equal(refused.data.refusal.code, "MODEL_UNKNOWN");
	assert.match(
		refused.text,
		/stage "check": model "gpt-9-unknown" is unknown to executor codex \(its probe lists: gpt-5\.6-luna\)/,
	);
	assert.deepEqual(submits(logs.codex), []);
	await saveProfile(ctx, {
		roles: { verification: { executor: "codex", model: "gpt-5.6-luna" } },
	});
	const ok = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "known models",
	});
	assert.equal(ok.outcome, "running", ok.text);
	assert.doesNotMatch(ok.text, /not verified/);
	assert.equal((await settle(ctx, ok.data.runId)).outcome, "completed");
});

test("unknown executor ids in a profile are refused when it is saved", async () => {
	executors();
	const { ctx } = await project(TWO_STAGES);
	await assert.rejects(
		api.profileAction(ctx, {
			op: "set",
			name: "bad",
			values: { roles: { verification: { executor: "gemini" } } },
		}),
		/roles\.verification\.executor "gemini" is an unknown executor/,
	);
	await assert.rejects(
		api.profileAction(ctx, {
			op: "set",
			name: "bad",
			values: { executor: "nope" },
		}),
		/executor "nope" is an unknown executor/,
	);
});

test("resume after stop keeps every task on its executor", async () => {
	const logs = executors({ common: { stepDelayMs: 1_500 } });
	const stages = [
		{ id: "plan", type: "single", profileRole: "planning", prompt: "Plan." },
		{
			id: "check",
			type: "single",
			profileRole: "verification",
			prompt: "Check.",
		},
	];
	const { cwd, ctx } = await project(stages);
	await saveProfile(ctx, { roles: MIXED_ROLES });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "stop and resume",
	});
	assert.equal(launched.outcome, "running", launched.text);
	const runId = launched.data.runId;
	const deadline = Date.now() + 30_000;
	while (
		(submits(logs.claude).length === 0 || submits(logs.codex).length === 0) &&
		Date.now() < deadline
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	const stopped = await engine.stopRun(cwd, runId);
	assert.equal(stopped.run.status, "interrupted");
	const before = {
		claude: submits(logs.claude).length,
		codex: submits(logs.codex).length,
	};
	engine.setResumeAfterStopLeaseWaitForTests({ timeoutMs: 20_000, pollMs: 50 });
	let resumed;
	try {
		resumed = await engine.resumeRun(cwd, runId);
	} finally {
		engine.setResumeAfterStopLeaseWaitForTests(undefined);
	}
	assert.ok(resumed.resetTaskIds.length >= 1);
	const run = await engine.waitForRun(cwd, runId, 60_000);
	assert.equal(run.status, "completed");
	// Every task reset by resume was relaunched on its own executor, never on the other one.
	for (const taskId of resumed.resetTaskIds) {
		const task = run.tasks.find((candidate) => candidate.taskId === taskId);
		const own = task.runtime.executor;
		const other = own === "claude" ? "codex" : "claude";
		assert.ok(
			submits(logs[own]).filter((entry) => label(entry) === taskId).length >= 2,
			`${taskId} relaunched on ${own}`,
		);
		assert.equal(
			submits(logs[other]).filter((entry) => label(entry) === taskId).length,
			0,
		);
	}
	assert.ok(
		submits(logs.claude).length + submits(logs.codex).length >
			before.claude + before.codex,
	);
	assert.deepEqual(
		[...new Set(await stagesOf(cwd, runId, logs.claude))],
		["plan"],
	);
	assert.deepEqual(
		[...new Set(await stagesOf(cwd, runId, logs.codex))],
		["check"],
	);
});

test("owned sessions are released, and pruned, through the executor that reported them", async () => {
	const logs = executors({ common: { ownSessions: "always" } });
	const { cwd, ctx } = await project(TWO_STAGES);
	await saveProfile(ctx, { roles: MIXED_ROLES });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "sessions",
	});
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	const run = await store.readRunRecord(cwd, launched.data.runId);
	for (const task of run.tasks) {
		assert.ok(task.ownedSessions?.length, `${task.specId} owns a session`);
		for (const session of task.ownedSessions) {
			assert.equal(session.executorId, task.runtime.executor);
			assert.equal(session.release?.outcome, "deleted");
		}
	}
	const deletions = (log) =>
		readFixtureLog(log)
			.filter((entry) => entry.type === "delete-owned-session")
			.map((entry) => entry.locator);
	const claudeSessions = run.tasks
		.filter((task) => task.runtime.executor === "claude")
		.flatMap((task) => task.ownedSessions.map((session) => session.locator));
	const codexSessions = run.tasks
		.filter((task) => task.runtime.executor === "codex")
		.flatMap((task) => task.ownedSessions.map((session) => session.locator));
	assert.deepEqual(deletions(logs.claude), claudeSessions);
	assert.deepEqual(deletions(logs.codex), codexSessions);

	// Prune: sessions not yet released are deleted through their own executor too.
	for (const task of run.tasks)
		for (const session of task.ownedSessions) delete session.release;
	const pruned = await retention.deleteRunOwnedSessions(run);
	assert.deepEqual(pruned, { deleted: 2, notFound: 0, unsupported: 0 });
	assert.deepEqual(deletions(logs.claude), [
		...claudeSessions,
		...claudeSessions,
	]);
	assert.deepEqual(deletions(logs.codex), [...codexSessions, ...codexSessions]);
	// A session of an executor the run never used is refused.
	run.tasks[0].ownedSessions[0].executorId = "pi";
	await assert.rejects(
		retention.deleteRunOwnedSessions(run),
		/belongs to executor pi, not claude/,
	);
});

test("bundled workflows compile with every task on its role's executor (single and foreach stages)", async () => {
	for (const restore of undo.splice(0)) restore();
	const { compileWorkflow } = await import("../../dist/core/compiler.js");
	const { parseWorkflow } = await import("../../dist/core/schema.js");
	const { planRoleExecution } = await import(
		"../../dist/core/role-execution.js"
	);
	const { readFile } = await import("node:fs/promises");
	const cwd = await mkdtemp(join(root, "bundled-"));
	const repo = new URL("../../", import.meta.url).pathname;
	for (const name of [
		"deep-research",
		"deep-review",
		"impact-review",
		"spec-review",
	]) {
		const specPath = join(repo, "workflows", name, "spec.json");
		const spec = parseWorkflow(JSON.parse(await readFile(specPath, "utf8")));
		const plan = planRoleExecution({
			spec,
			layers: [
				{
					tier: "user-profile",
					name: "mine",
					roles: {
						default: { executor: "claude", model: "sonnet" },
						"research-execution": { executor: "codex", model: "gpt-5.6-luna" },
					},
				},
			],
			executor: core.resolveRunExecutorSelection({ defaultExecutor: "pi" }),
		});
		assert.equal(plan.executor.id, "claude", name);
		assert.equal(plan.roleExecution.mixed, true, name);
		const compiled = await compileWorkflow(plan.spec, {
			cwd,
			specPath,
			task: "WP31 compile",
			// Host defaults of the run's executor never reach the codex stages.
			runtimeDefaults: { model: "host-claude-model", executor: "claude" },
		});
		const slots = plan.roleExecution.stages;
		for (const task of compiled.tasks) {
			if (task.support || task.kind === "loop" || task.loopPlaceholder)
				continue;
			const slot = slots[task.stageId];
			assert.ok(slot, `${name}: ${task.id} has a role assignment`);
			assert.equal(task.runtime.executor, slot.executor, `${name}: ${task.id}`);
			assert.equal(
				task.runtime.model,
				slot.executor === "codex" ? "gpt-5.6-luna" : "sonnet",
				`${name}: ${task.id} model`,
			);
		}
		assert.ok(
			compiled.tasks.some((task) => task.runtime.executor === "codex"),
			`${name} has codex stages`,
		);
	}
});
