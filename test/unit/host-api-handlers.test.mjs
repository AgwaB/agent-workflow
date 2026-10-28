// New in agent-workflow (WP11a): per-action tests of the host API handlers (src/hosts/api.ts). Each
// handler returns structured data plus a text rendering. Runs use the workflow executor fixture (no
// model or agent-CLI calls); the default executor is never reached.
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
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-host-api-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

export const ONE_STAGE = {
	schemaVersion: 1,
	name: "host-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

/** Project with a reader agent, a one-stage spec and its own user home. */
async function project(spec = ONE_STAGE) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(spec, null, 2)}\n`);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
	};
	return { cwd, ctx: { cwd, env } };
}

function fixture(config = {}) {
	counter += 1;
	const id = config.id ?? `test-host-${counter}`;
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

function assertResult(result, action, outcome) {
	assert.equal(result.action, action);
	assert.equal(result.outcome, outcome, result.text);
	assert.equal(typeof result.text, "string");
	assert.ok(result.text.length > 0);
	assert.equal(typeof result.data, "object");
}

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

test("list: bundled workflows with structured rows, query filter and bounded paging", async () => {
	const { ctx } = await project();
	const all = await api.listWorkflowsAction(ctx);
	assertResult(all, "list", "success");
	const names = all.data.workflows.map((row) => row.name);
	for (const name of ["deep-research", "deep-review", "spec-review"])
		assert.ok(names.includes(name), name);
	assert.equal(all.data.total, all.data.workflows.length);
	assert.match(all.text, /deep-review: .*\n {2}spec: /);
	const filtered = await api.listWorkflowsAction(ctx, { query: "DEEP-RE" });
	assert.deepEqual(filtered.data.workflows.map((row) => row.name).sort(), [
		"deep-research",
		"deep-review",
	]);
	const page = await api.listWorkflowsAction(ctx, { limit: 1 });
	assert.equal(page.data.workflows.length, 1);
	assert.equal(page.data.nextOffset, 1);
	assert.match(page.text, /workflows omitted\. Continue with offset=1/);
	await assert.rejects(
		api.listWorkflowsAction(ctx, { limit: 21 }),
		api.HostUsageError,
	);
});

test("validate, roles, agents and show <workflow>: data and text", async () => {
	const { ctx } = await project();
	const valid = await api.validateWorkflowAction(ctx, { workflow: "wf.json" });
	assertResult(valid, "validate", "success");
	assert.equal(valid.data.name, "host-one-stage");
	assert.equal(valid.data.specPath, "wf.json");
	assert.equal(valid.data.tasks, 1);
	assert.match(
		valid.text,
		/^Workflow spec valid: host-one-stage\nSpec: wf\.json/,
	);
	assert.doesNotMatch(valid.text, /local-pi/);

	await writeFile(
		join(ctx.cwd, "bad.json"),
		JSON.stringify({ schemaVersion: 1, artifactGraph: { stages: [] } }),
	);
	await assert.rejects(
		api.validateWorkflowAction(ctx, { workflow: "bad.json" }),
		(error) =>
			/Workflow validation failed|stages/.test(api.formatHostError(error)),
	);

	const roles = await api.workflowRolesAction(ctx, { workflow: "deep-review" });
	assertResult(roles, "roles", "success");
	assert.ok(Array.isArray(roles.data.roles));

	const agents = await api.listAgentsAction(ctx);
	assertResult(agents, "agents", "success");
	const reader = agents.data.agents.find((agent) => agent.name === "reader");
	assert.deepEqual(reader.tools, ["read"]);
	assert.match(agents.text, /reader\n {2}reads and reports/);

	const shown = await api.showAction(ctx, { ref: "wf.json" });
	assert.equal(shown.data.kind, "workflow");
	assert.deepEqual(JSON.parse(shown.text), ONE_STAGE);
});

test("profile: set/show/list/default/delete round trip under the isolated home", async () => {
	const { ctx, cwd } = await project();
	const path = join(cwd, "home", "user-profiles", "v1", "profiles.json");
	const empty = await api.profileAction(ctx, { op: "list" });
	assertResult(empty, "profile", "success");
	assert.deepEqual(empty.data.profiles, []);
	assert.equal(empty.data.path, path);
	assert.equal(existsSync(path), false, "listing creates nothing");

	const saved = await api.profileAction(ctx, {
		op: "set",
		name: "fast",
		values: {
			executor: "codex",
			model: "gpt-x",
			effort: "high",
			permissionMode: "safe",
			strictCapabilities: ["readOnly", "contextIsolation"],
		},
		makeDefault: true,
	});
	assert.equal(saved.data.default, "fast");
	assert.match(
		saved.text,
		/Saved profile:\nfast \(default\)\n {2}executor: codex/,
	);
	const shown = await api.profileAction(ctx, { op: "show" });
	assert.deepEqual(
		{ ...shown.data.profile, updatedAt: undefined },
		{
			name: "fast",
			executor: "codex",
			model: "gpt-x",
			effort: "high",
			permissionMode: "safe",
			strictCapabilities: ["readOnly", "contextIsolation"],
			updatedAt: undefined,
		},
	);
	const updated = await api.profileAction(ctx, {
		op: "set",
		name: "fast",
		values: { effort: "low" },
		unset: ["model", "strictCapabilities"],
	});
	assert.equal(updated.data.profile.effort, "low");
	assert.equal(updated.data.profile.executor, "codex");
	assert.equal(updated.data.profile.model, undefined);
	assert.equal(updated.data.profile.strictCapabilities, undefined);
	await api.profileAction(ctx, {
		op: "set",
		name: "other",
		values: { executor: "claude" },
	});
	const listed = await api.profileAction(ctx, { op: "list" });
	assert.deepEqual(
		listed.data.profiles.map((profile) => profile.name),
		["fast", "other"],
	);
	assert.equal(listed.data.default, "fast");
	const stored = JSON.parse(await readFile(path, "utf8"));
	assert.equal(stored.schema, "agent-workflow-user-profiles-v1");
	await api.profileAction(ctx, { op: "default", name: "other" });
	assert.equal(
		(await api.profileAction(ctx, { op: "show" })).data.profile.name,
		"other",
	);
	const deleted = await api.profileAction(ctx, { op: "delete", name: "other" });
	assert.match(deleted.text, /it was the default/);
	assert.equal(
		(await api.profileAction(ctx, { op: "show" })).text,
		"No default profile is set.",
	);

	for (const values of [
		{ effort: "turbo" },
		{ permissionMode: "yolo" },
		{ strictCapabilities: ["noSuchCapability"] },
		{ executor: "has space" },
		{ unknownField: 1 },
	])
		await assert.rejects(
			api.profileAction(ctx, { op: "set", name: "bad", values }),
			api.HostUsageError,
			JSON.stringify(values),
		);
	await assert.rejects(
		api.profileAction(ctx, { op: "set", name: "../escape", values: {} }),
		api.HostUsageError,
	);
	await assert.rejects(
		api.profileAction(ctx, { op: "show", name: "missing" }),
		/no saved profile named "missing"/,
	);
});

test("run → wait → status/show/inspect: launch data, capability preview and terminal preview", async () => {
	const { ctx } = await project();
	const { id, effectLog } = fixture();
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "collect facts",
		executor: id,
	});
	assertResult(launched, "run", "running");
	assert.equal(launched.ok, true);
	const runId = launched.data.runId;
	assert.match(runId, /^workflow_/);
	assert.equal(launched.data.mode, "named-workflow");
	assert.equal(launched.data.specPath, "wf.json");
	assert.deepEqual(launched.data.executor, { id, source: "run-flag" });
	assert.deepEqual(launched.data.permissionMode, {
		mode: "free",
		source: "default",
	});
	assert.equal(launched.data.capability.confirmation, "not-needed");
	assert.match(
		launched.text,
		new RegExp(
			`^Capability check \\(${id}@0\\.1\\.0, 1 stage, permission mode: free\\): accepted`,
		),
	);
	assert.match(launched.text, /Workflow started: host-one-stage/);

	const waited = await settle(ctx, runId);
	assertResult(waited, "wait", "completed");
	assert.equal(waited.data.terminal, true);
	assert.equal(waited.data.actionRequired, false);
	assert.equal(waited.data.stillRunning, false);
	assert.equal(waited.data.semanticStatus, "completed");
	assert.match(
		waited.data.preview,
		/task-1 analysis|a\.main analysis|analysis/,
	);
	assert.equal(submits(effectLog).length, 1);

	const one = await api.statusAction(ctx, { runId: runId.slice(0, 18) });
	assertResult(one, "status", "success");
	assert.equal(one.data.run.runId, runId);
	assert.equal(one.data.run.status, "completed");
	assert.equal(one.data.run.executor, id);
	const all = await api.statusAction(ctx);
	assert.deepEqual(
		all.data.runs.map((run) => run.runId),
		[runId],
	);
	const shown = await api.showAction(ctx, { ref: runId });
	assert.equal(shown.data.kind, "run");
	assert.equal(shown.data.run.runId, runId);
	const raw = await api.showAction(ctx, { ref: runId, raw: true });
	assert.equal(raw.data.kind, "run");
	const inspected = await api.inspectAction(ctx, { runId, results: true });
	assertResult(inspected, "inspect", "success");
	assert.equal(inspected.data.reliability.health, "clean");
	assert.match(inspected.text, /completion: clean/);
});

test("run: executor precedence run flag > declared profile > saved user profile > default", async () => {
	const declaredExec = fixture();
	const userExec = fixture();
	const flagExec = fixture();
	const spec = {
		...ONE_STAGE,
		name: "host-precedence",
		executionProfiles: { declared: {} },
		executionProfileExecutors: { declared: declaredExec.id },
	};
	const { ctx } = await project(spec);
	await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values: { executor: userExec.id, permissionMode: "safe", effort: "low" },
		makeDefault: true,
	});
	const byDefaultUser = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t1",
	});
	assert.deepEqual(byDefaultUser.data.executor, {
		id: userExec.id,
		source: "user-profile",
		profile: "mine",
	});
	assert.deepEqual(byDefaultUser.data.permissionMode, {
		mode: "safe",
		source: "user-profile",
		profile: "mine",
	});
	assert.deepEqual(byDefaultUser.data.profile, {
		name: "mine",
		kind: "user",
		source: "user-default",
	});
	const byDeclared = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t2",
		profile: "declared",
	});
	assert.deepEqual(byDeclared.data.executor, {
		id: declaredExec.id,
		source: "workflow-profile",
		profile: "declared",
	});
	const byFlag = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t3",
		profile: "mine",
		executor: flagExec.id,
		permissionMode: "free",
	});
	assert.deepEqual(byFlag.data.executor, {
		id: flagExec.id,
		source: "run-flag",
	});
	assert.deepEqual(byFlag.data.permissionMode, {
		mode: "free",
		source: "run-flag",
	});
	await assert.rejects(
		api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "t4",
			profile: "nope",
		}),
		/unknown profile "nope": the workflow declares declared; saved user profiles: mine/,
	);
	for (const launched of [byDefaultUser, byDeclared, byFlag])
		assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.equal(submits(userExec.effectLog)[0].effort, "low");
	assert.equal(submits(userExec.effectLog)[0].permissionMode, "safe");
});

test("run: refusals return `refused` without creating a run", async () => {
	const { ctx, cwd } = await project();
	const unknown = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t",
		executor: "no-such-executor",
	});
	assertResult(unknown, "run", "refused");
	assert.equal(unknown.ok, false);
	assert.equal(unknown.data.refusal.code, "EXECUTOR_UNAVAILABLE");
	assert.match(
		unknown.text,
		/^Not started: executor "no-such-executor" from run flag is unknown/,
	);

	const { id, effectLog } = fixture({
		capabilities: { readOnly: { level: "none", source: "declared" } },
	});
	const refused = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t",
		executor: id,
	});
	assertResult(refused, "run", "refused");
	assert.equal(refused.data.refusal.code, "CAPABILITY_REFUSED");
	assert.equal(refused.data.refusal.executorId, id);
	assert.match(refused.data.refusal.preview, /Capability check/);
	assert.deepEqual(submits(effectLog), []);
	const runs = join(cwd, ".agent-workflow", "workflows");
	assert.equal(
		existsSync(runs) &&
			readdirSync(runs).some((name) => name.startsWith("workflow_")),
		false,
	);
	await assert.rejects(
		api.runWorkflowAction(ctx, { workflow: "wf.json", task: "  " }),
		api.HostUsageError,
	);
	await assert.rejects(
		api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "t",
			permissionMode: "yolo",
		}),
		api.HostUsageError,
	);
	const dynamicRefused = await api.runDynamicAction(ctx, {
		task: "explore",
		executor: "no-such-executor",
	});
	assertResult(dynamicRefused, "dynamic", "refused");
	assert.equal(dynamicRefused.data.mode, "direct-dynamic");
	await assert.rejects(
		api.runDynamicAction(ctx, { task: "" }),
		api.HostUsageError,
	);
});

test("run: interactive confirmation (accept, decline, missing hook) and non-interactive degradations", async () => {
	const { ctx } = await project();
	const { id, effectLog } = fixture({
		capabilities: {
			contextIsolation: {
				level: "emulated",
				source: "probed",
				warning: "global AGENTS.md loaded",
			},
		},
	});
	const base = { workflow: "wf.json", executor: id, permissionMode: "safe" };
	const declined = await api.runWorkflowAction(ctx, {
		...base,
		task: "declined",
		interactive: true,
		confirmDegradations: async () => false,
	});
	assertResult(declined, "run", "refused");
	assert.equal(declined.data.refusal.code, "CAPABILITY_DEGRADATION_DECLINED");
	await assert.rejects(
		api.runWorkflowAction(ctx, { ...base, task: "no hook", interactive: true }),
		api.HostUsageError,
	);
	assert.deepEqual(submits(effectLog), []);

	const seen = [];
	const confirmed = await api.runWorkflowAction(ctx, {
		...base,
		task: "confirmed",
		interactive: true,
		confirmDegradations: async (preview) => {
			seen.push(preview.text);
			return true;
		},
	});
	assert.equal(seen.length, 1);
	assert.match(seen[0], /global AGENTS\.md loaded/);
	assert.equal(confirmed.data.capability.confirmation, "confirmed");
	assert.deepEqual(confirmed.data.capability.degradations, [
		"a.main: CAPABILITY_WARNING:contextIsolation",
	]);
	const quiet = await api.runWorkflowAction(ctx, { ...base, task: "headless" });
	assert.equal(quiet.data.capability.confirmation, "non-interactive");
	for (const launched of [confirmed, quiet])
		await settle(ctx, launched.data.runId);
});

test("run: duplicate-launch guard returns the identical active run (WP16 outcome existing) unless forceNew", async () => {
	const { ctx } = await project();
	const { id } = fixture({ stepDelayMs: 300 });
	const first = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "same task",
		executor: id,
	});
	const second = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "same task",
		executor: id,
	});
	assertResult(second, "run", "existing");
	assert.equal(second.ok, true);
	assert.equal(second.data.duplicateOf, first.data.runId);
	assert.equal(second.data.runId, first.data.runId);
	assert.match(second.text, /Duplicate launch guard/);
	const forced = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "same task",
		executor: id,
		forceNew: true,
	});
	assert.equal(forced.outcome, "running");
	for (const launched of [first, forced])
		await settle(ctx, launched.data.runId);
});

test("wait is bounded (45 s cap, still-running result); stop then resume completes the run", async () => {
	const { ctx } = await project();
	assert.equal(api.HOST_WAIT_MAX_TIMEOUT_MS, 45_000);
	assert.equal(api.boundedWaitTimeout(undefined), 45_000);
	assert.equal(api.boundedWaitTimeout(3_600_000), 45_000);
	assert.equal(api.boundedWaitTimeout(10), 1_000);
	const { id } = fixture({ stepDelayMs: 1_500 });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "slow",
		executor: id,
	});
	const started = Date.now();
	const pending = await api.waitAction(ctx, {
		runId: launched.data.runId,
		timeoutMs: 1_000,
	});
	assert.ok(Date.now() - started < 10_000);
	assertResult(pending, "wait", "running");
	assert.equal(pending.data.stillRunning, true);
	assert.equal(pending.data.terminal, false);
	assert.equal(pending.data.actionRequired, false);
	assert.equal(pending.data.timeoutMs, 1_000);
	assert.match(pending.text, /^Workflow still running/);

	const stopped = await api.stopAction(ctx, { runId: launched.data.runId });
	assertResult(stopped, "stop", "success");
	assert.equal(stopped.data.status, "interrupted");
	assert.match(stopped.text, /^Workflow stopped/);
	const after = await api.waitAction(ctx, { runId: launched.data.runId });
	assertResult(after, "wait", "interrupted");
	assert.equal(after.ok, false);
	assert.equal(after.data.terminal, true);

	// The stopped (attached, in-process) supervisor may still hold its lease for a moment under
	// load; resume refuses with "another supervisor may be active" until it is released.
	let resumed;
	for (let attempt = 0; ; attempt += 1) {
		try {
			resumed = await api.resumeAction(ctx, { runId: launched.data.runId });
			break;
		} catch (error) {
			if (attempt >= 50 || !/supervisor lease/.test(String(error?.message)))
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	assertResult(resumed, "resume", "running");
	assert.ok(resumed.data.resetTaskIds.length >= 1);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
});

test("prune, notices, supervise and help: data, text and usage errors", async () => {
	const { ctx } = await project();
	const dry = await api.pruneAction(ctx, { argv: ["--keep", "0"] });
	assertResult(dry, "prune", "success");
	assert.equal(dry.data.dryRun, true);
	assert.match(dry.text, /Workflow prune \(dry run\)/);
	const parsed = await api.pruneAction(ctx, { keep: 0 });
	assert.equal(parsed.data.dryRun, true);
	await assert.rejects(
		api.pruneAction(ctx, { argv: ["--keep", "x"] }),
		api.HostUsageError,
	);

	const notices = await api.noticesAction(ctx, { argv: ["list"] });
	assertResult(notices, "notices", "success");
	assert.deepEqual(notices.data, {
		notices: [],
		acknowledgements: [],
		warnings: [],
	});
	assert.match(notices.text, /No eligible notices or acknowledgements/);
	await assert.rejects(
		api.noticesAction(ctx, { argv: ["clear", "../escape"] }),
		api.HostUsageError,
	);

	const lines = [];
	const supervised = await api.superviseAction(ctx, {
		all: true,
		onLog: (line) => lines.push(line),
	});
	assertResult(supervised, "supervise", "completed");
	assert.equal(supervised.data.result, "completed");
	assert.match(lines.at(-1), /done: no running runs remain/);
	await assert.rejects(api.superviseAction(ctx, {}), api.HostUsageError);
	await assert.rejects(
		api.superviseAction(ctx, { all: true, runId: "workflow_x" }),
		api.HostUsageError,
	);

	assert.match(api.helpAction().text, /^agent-workflow — /);
	assert.match(api.helpAction("wait").text, /bounded to 45 s/);
	assert.throws(() => api.helpAction("nope"), api.HostUsageError);
});

test("process role guard: workers may validate but not launch", async () => {
	const { ctx } = await project();
	const worker = { ...ctx, env: { ...ctx.env, AGENT_WORKFLOW_ROLE: "worker" } };
	assert.equal(
		(await api.validateWorkflowAction(worker, { workflow: "wf.json" })).outcome,
		"success",
	);
	await assert.rejects(
		api.runWorkflowAction(worker, { workflow: "wf.json", task: "t" }),
		/not allowed when AGENT_WORKFLOW_ROLE=worker/,
	);
	await assert.rejects(api.statusAction(worker), /not allowed/);
});
