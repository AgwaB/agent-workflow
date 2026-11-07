// Editable executor default profiles: a saved profile named after an executor holds the user's
// changes to that executor's default profile. Fixture executors are registered as `codex`, `claude`
// and `pi` (no CLI or model call); the fixture probes list no models, so codex/claude start from
// their built-in preset. Checks what each worker is sent, what the run records, what `profile show`
// reports, and that a saved `pi` profile replaces the Pi host's current model/effort field by field.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";
import { runDiagnostics } from "../helpers/run-diagnostics.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");
const presets = await import("../../dist/core/executor-presets.js");

let root;
let counter = 0;
const undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-exec-profiles-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const restore of undo.splice(0)) restore();
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

/** Registers fixtures as codex, claude and pi (replacing the built-ins in this process). */
function executors() {
	for (const restore of undo.splice(0)) restore();
	counter += 1;
	const logs = {};
	for (const id of ["codex", "claude", "pi"]) {
		logs[id] = join(root, `${id}-${counter}.jsonl`);
		undo.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({ id, effectLog: logs[id] }),
			),
		);
	}
	return logs;
}

const STAGES = [
	{ id: "plan", type: "single", profileRole: "planning", prompt: "Plan." },
	{
		id: "check",
		type: "single",
		profileRole: "verification",
		prompt: "Check.",
		from: "plan",
	},
	{ id: "note", type: "single", prompt: "Note.", from: "check" },
];

async function project(extraEnv = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const agents = join(cwd, ".agent-workflow", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(agents, "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				name: `exec-profiles-${counter}`,
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: { stages: STAGES },
			},
			null,
			2,
		)}\n`,
	);
	return {
		cwd,
		ctx: {
			cwd,
			env: {
				...process.env,
				AGENT_WORKFLOW_HOME: join(cwd, "home"),
				...extraEnv,
			},
		},
	};
}

async function setProfile(ctx, name, values) {
	const saved = await api.profileAction(ctx, { op: "set", name, values });
	assert.equal(saved.outcome, "success", saved.text);
	return saved;
}

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	if (waited.outcome === "blocked")
		waited.diagnostics = await runDiagnostics(ctx.cwd, runId, {
			tailChars: 2500,
		});
	return waited;
}

/** stage id → { model, effort } the worker of that stage was sent. */
async function sent(cwd, runId, log) {
	const run = await store.readRunRecord(cwd, runId);
	const stageOf = Object.fromEntries(
		run.tasks.map((task) => [task.taskId, task.specId.split(".")[0]]),
	);
	return Object.fromEntries(
		readFixtureLog(log)
			.filter((entry) => entry.type === "submit")
			.map((entry) => [
				stageOf[entry.attemptKey.split(":")[2]],
				{ model: entry.model, effort: entry.effort },
			]),
	);
}

async function runOn(ctx, request) {
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "t",
		...request,
	});
	assert.equal(launched.outcome, "running", launched.text);
	const settled = await settle(ctx, launched.data.runId);
	assert.equal(settled.outcome, "completed", settled.diagnostics);
	return launched.data.runId;
}

const LUNA = presets.PRESET_CODEX_MODEL;

test("without a saved profile codex stages run the built-in default profile", async () => {
	const logs = executors();
	const { ctx, cwd } = await project();
	const runId = await runOn(ctx, { executor: "codex" });
	assert.deepEqual(await sent(cwd, runId, logs.codex), {
		plan: { model: LUNA, effort: "high" },
		check: { model: LUNA, effort: "high" },
		note: { model: LUNA, effort: "medium" },
	});
	const run = await store.readRunRecord(cwd, runId);
	assert.deepEqual(run.executorDefaults.codex.planning, {
		model: LUNA,
		effort: "high",
	});
});

test("a saved codex profile changes only what it sets, on top of the built-in one, and is recorded", async () => {
	const logs = executors();
	const { ctx, cwd } = await project();
	await setProfile(ctx, "codex", {
		roles: {
			planning: { executor: "codex", effort: "xhigh" },
			verification: { executor: "codex", model: "gpt-6.1-sol" },
			synthesis: { executor: "claude", model: "opus" },
		},
	});
	const runId = await runOn(ctx, { executor: "codex" });
	assert.deepEqual(await sent(cwd, runId, logs.codex), {
		plan: { model: LUNA, effort: "xhigh" },
		check: { model: "gpt-6.1-sol", effort: "high" },
		note: { model: LUNA, effort: "medium" },
	});
	const run = await store.readRunRecord(cwd, runId);
	assert.deepEqual(run.executorDefaults.codex.planning, {
		model: LUNA,
		effort: "xhigh",
	});
	// The claude entry does not reach codex stages.
	assert.deepEqual(run.executorDefaults.codex.synthesis, {
		model: LUNA,
		effort: "medium",
	});
});

test("flat model/effort replace the built-in ones in every role; --profile runs the same", async () => {
	const logs = executors();
	const { ctx, cwd } = await project();
	await setProfile(ctx, "claude", { model: "opus" });
	const asDefault = await runOn(ctx, { executor: "claude" });
	const expected = {
		plan: { model: "opus", effort: "high" },
		check: { model: "opus", effort: "high" },
		note: { model: "opus", effort: "medium" },
	};
	assert.deepEqual(await sent(cwd, asDefault, logs.claude), expected);
	const logs2 = executors();
	const chosen = await runOn(ctx, { profile: "claude" });
	assert.deepEqual(await sent(cwd, chosen, logs2.claude), expected);
	assert.deepEqual(readFixtureLog(logs2.codex), []);
	// Authored settings and run flags still win.
	const logs3 = executors();
	const flagged = await runOn(ctx, {
		executor: "claude",
		model: "haiku",
		effort: "low",
	});
	assert.deepEqual(await sent(cwd, flagged, logs3.claude), {
		plan: { model: "haiku", effort: "low" },
		check: { model: "haiku", effort: "low" },
		note: { model: "haiku", effort: "low" },
	});
});

test("profile show reports the built-in profile, then the built-in one with the changes; delete restores it", async () => {
	executors();
	const { ctx } = await project();
	const builtIn = await api.profileAction(ctx, { op: "show", name: "codex" });
	assert.equal(builtIn.data.builtIn, true);
	assert.equal(builtIn.data.profile.roles.planning.model, LUNA);
	assert.match(
		builtIn.text,
		/built-in default profile of codex stages; not saved/,
	);
	const pi = await api.profileAction(ctx, { op: "show", name: "pi" });
	assert.equal(pi.data.builtIn, true);
	assert.equal(pi.data.profile, undefined);
	assert.match(pi.text, /in Pi: its current model and effort/);
	await assert.rejects(
		api.profileAction(ctx, { op: "show", name: "nope" }),
		/no saved profile named "nope"/,
	);
	await setProfile(ctx, "codex", {
		roles: { planning: { executor: "codex", effort: "xhigh" } },
	});
	const changed = await api.profileAction(ctx, { op: "show", name: "codex" });
	assert.equal(changed.data.builtIn, undefined);
	assert.deepEqual(changed.data.profile.roles, {
		planning: { executor: "codex", effort: "xhigh" },
	});
	assert.deepEqual(changed.data.effective.roles.planning, {
		executor: "codex",
		model: LUNA,
		effort: "xhigh",
	});
	assert.match(changed.text, /^codex \(default profile of codex stages\)/);
	assert.match(changed.text, /Runs as \(built-in codex default profile/);
	const deleted = await api.profileAction(ctx, {
		op: "delete",
		name: "codex",
	});
	assert.equal(deleted.outcome, "success");
	const back = await api.profileAction(ctx, { op: "show", name: "codex" });
	assert.equal(back.data.builtIn, true);
});

test("a saved pi profile changes only what it sets; other stages keep the Pi host's current model/effort", async () => {
	const host = { model: "host/current", effort: "low", executor: "pi" };
	const logs = executors();
	const { ctx, cwd } = await project();
	// The same stages under workflow defaults: the Pi host's values outrank them, and so do the
	// pi profile's (it sits at the host-defaults layer, not the lowest one).
	await writeFile(
		join(cwd, "wf-defaults.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				name: `exec-profiles-defaults-${counter}`,
				defaults: {
					agent: "reader",
					readOnly: true,
					tools: ["read"],
					model: "spec/model",
					effort: "medium",
				},
				artifactGraph: { stages: STAGES },
			},
			null,
			2,
		)}\n`,
	);
	const piCtx = { ...ctx, host: "pi", runtimeDefaults: host };
	const all = (model, effort) => ({
		plan: { model, effort },
		check: { model, effort },
		note: { model, effort },
	});
	const unchanged = await runOn(piCtx, { executor: "pi" });
	assert.deepEqual(
		await sent(cwd, unchanged, logs.pi),
		all("host/current", "low"),
	);
	assert.equal(
		(await store.readRunRecord(cwd, unchanged)).executorDefaults,
		undefined,
	);
	await setProfile(ctx, "pi", {
		roles: {
			planning: { executor: "pi", effort: "xhigh" },
			verification: { executor: "pi", model: "other/model" },
		},
	});
	const expected = {
		plan: { model: "host/current", effort: "xhigh" },
		check: { model: "other/model", effort: "low" },
		note: { model: "host/current", effort: "low" },
	};
	for (const workflow of ["wf.json", "wf-defaults.json"]) {
		const logsN = executors();
		const runId = await runOn(piCtx, { executor: "pi", workflow });
		assert.deepEqual(await sent(cwd, runId, logsN.pi), expected, workflow);
		assert.deepEqual(
			(await store.readRunRecord(cwd, runId)).executorDefaults.pi,
			{
				default: { model: "host/current", effort: "low" },
				planning: { effort: "xhigh" },
				verification: { model: "other/model" },
			},
		);
	}
	// Flat values replace the host's in every role; role entries still win.
	await setProfile(ctx, "pi", { effort: "high" });
	const logs3 = executors();
	const flat = await runOn(piCtx, { executor: "pi" });
	assert.deepEqual(await sent(cwd, flat, logs3.pi), {
		plan: { model: "host/current", effort: "xhigh" },
		check: { model: "other/model", effort: "high" },
		note: { model: "host/current", effort: "high" },
	});
	// A chosen profile's flat effort outranks the pi default profile.
	await setProfile(ctx, "mine", { executor: "pi", effort: "minimal" });
	const logs4 = executors();
	const chosen = await runOn(piCtx, { profile: "mine" });
	assert.deepEqual(await sent(cwd, chosen, logs4.pi), {
		plan: { model: "host/current", effort: "minimal" },
		check: { model: "other/model", effort: "minimal" },
		note: { model: "host/current", effort: "minimal" },
	});
});
