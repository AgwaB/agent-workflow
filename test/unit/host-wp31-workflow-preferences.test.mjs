// New in agent-workflow (WP31 item 4, feature-parity row 25): saved per-workflow preferences without
// the Pi UI. `agent-workflow profile workflow set <workflow> --profile <name> --role …` (and the
// `workflow_profile` MCP tool's workflow-* ops, with elicitation for writes) save a preference keyed by
// the workflow name; every launch of that workflow — CLI, MCP and Pi — applies it: its profile when
// the launch names none, its role overrides just below the run flags. pi-workflow's legacy
// `~/.pi/agent/workflow-profiles` is never read (owner decision Q2).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const undo = [];
const clients = [];
const logs = {};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp31-prefs-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	for (const id of ["claude", "codex"]) {
		logs[id] = join(root, `${id}.jsonl`);
		undo.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({ id, effectLog: logs[id] }),
			),
		);
	}
	// Q2: a legacy pi-workflow preference store is never read (garbage here must not matter).
	const legacy = join(homedir(), ".pi", "agent", "workflow-profiles", "v1");
	await mkdir(legacy, { recursive: true });
	await writeFile(join(legacy, `${"0".repeat(64)}.json`), "{ not json");
});
after(async () => {
	for (const client of clients.splice(0))
		await client.close().catch(() => undefined);
	for (const restore of undo.splice(0)) restore();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const name = `wp31-prefs-${counter}`;
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			executionProfiles: { careful: {} },
			artifactGraph: {
				stages: [
					{
						id: "plan",
						type: "single",
						profileRole: "planning",
						prompt: "Plan.",
					},
					{
						id: "check",
						type: "single",
						profileRole: "verification",
						prompt: "Check.",
						from: "plan",
					},
				],
			},
		}),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, name, ctx: { cwd, env } };
}

async function cliRun(cwd, env, argv) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
}

function stagesOf(run) {
	return Object.fromEntries(
		Object.entries(run.roleExecution?.stages ?? {}).map(([stage, a]) => [
			stage,
			[a.executor, a.model ?? null, a.effort ?? null, a.source],
		]),
	);
}

const EXPECTED = {
	plan: ["claude", "sonnet", "high", "workflow-preference"],
	check: ["codex", "gpt-5.6-luna", "high", "workflow-preference"],
};

test("a preference saved with the CLI applies to CLI, MCP and Pi launches", async () => {
	const { cwd, env, name, ctx } = await project();
	const saved = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"set",
		"wf.json",
		"--profile",
		"mixed",
		"--role",
		"verification=codex:gpt-5.6-luna:high",
		"--json",
	]);
	assert.equal(saved.code, 0, saved.out + saved.err);
	const preference = JSON.parse(saved.out).data.preference;
	assert.equal(preference.workflow, name);
	assert.equal(preference.profile, "mixed");
	assert.deepEqual(preference.roles, {
		verification: { executor: "codex", model: "gpt-5.6-luna", effort: "high" },
	});

	// CLI launch (attached).
	const viaCli = await cliRun(cwd, env, [
		"run",
		"wf.json",
		"cli task",
		"--json",
	]);
	assert.equal(viaCli.code, 0, viaCli.out + viaCli.err);
	const cliData = JSON.parse(viaCli.out).data;
	assert.deepEqual(cliData.profile, {
		name: "mixed",
		kind: "preset",
		source: "workflow-preference",
	});
	const cliRunRecord = await store.readRunRecord(cwd, cliData.runId);
	const cliStages = stagesOf(cliRunRecord);
	// plan comes from the preset (selected by the preference); check from the preference roles.
	assert.deepEqual(cliStages.plan.slice(0, 3), EXPECTED.plan.slice(0, 3));
	assert.equal(cliStages.plan[3], "user-profile");
	assert.deepEqual(cliStages.check, EXPECTED.check);
	assert.deepEqual(cliRunRecord.roleExecution.layers, [
		{ tier: "workflow-preference", name },
		{ tier: "user-profile", name: "mixed" },
	]);

	// MCP launch.
	const client = await inProcessHostServer({ root: cwd, env });
	clients.push(client);
	await client.initialize("2025-06-18");
	const viaMcp = await client.call("workflow_run", {
		workflow: "wf.json",
		task: "mcp task",
		detach: false,
	});
	assert.equal(viaMcp.isError, false, viaMcp.content[0].text);
	const mcpData = viaMcp.structuredContent.data;
	assert.equal(mcpData.profile.source, "workflow-preference");
	const mcpRun = await store.readRunRecord(cwd, mcpData.runId);
	assert.deepEqual(stagesOf(mcpRun).check, EXPECTED.check);

	// Pi launch (aw_run tool, real host API).
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ api, env })(pi);
	const started = await pi.tools
		.get("aw_run")
		.execute(
			"r",
			{ workflow: "wf.json", task: "pi task" },
			undefined,
			undefined,
			fakeCtx(cwd),
		);
	assert.equal(started.details.outcome, "running", started.content[0].text);
	const piRun = await store.readRunRecord(cwd, started.details.runId);
	assert.deepEqual(stagesOf(piRun).check, EXPECTED.check);
	assert.equal(stagesOf(piRun).plan[0], "claude");

	for (const runId of [cliData.runId, mcpData.runId, started.details.runId]) {
		let waited;
		do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
		while (waited.data.stillRunning);
		assert.equal(waited.outcome, "completed", runId);
	}
	const codexSubmits = readFixtureLog(logs.codex).filter(
		(e) => e.type === "submit",
	);
	assert.ok(codexSubmits.length >= 3);
	assert.ok(
		codexSubmits.every(
			(entry) => entry.model === "gpt-5.6-luna" && entry.effort === "high",
		),
	);
});

test("an explicit --profile beats the preference's profile; its role overrides still apply below run flags", async () => {
	const { ctx } = await project();
	// The run's executor where no layer decides (no installed-default probe in unit tests).
	ctx.defaultExecutor = "claude";
	await api.workflowPreferenceAction(ctx, {
		op: "set",
		workflow: "wf.json",
		profile: "codex",
		roles: { planning: { executor: "claude", effort: "low" } },
	});
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "explicit profile",
		profile: "careful",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.deepEqual(launched.data.profile, {
		name: "careful",
		kind: "declared",
		source: "request",
	});
	const stages = Object.fromEntries(
		launched.data.roles.stages.map((stage) => [stage.stage, stage]),
	);
	assert.equal(stages.plan.executor, "claude");
	assert.equal(stages.plan.effort, "low");
	assert.equal(stages.plan.source, "workflow-preference");
	// --executor (run flag) wins over the preference's planning role.
	const flagged = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "run flag",
		executor: "codex",
	});
	assert.equal(flagged.outcome, "running", flagged.text);
	for (const stage of flagged.data.roles.stages)
		assert.equal(stage.executor, "codex");
	for (const runId of [launched.data.runId, flagged.data.runId]) {
		let waited;
		do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
		while (waited.data.stillRunning);
	}
});

test("profile workflow list/show/clear and validation", async () => {
	const { cwd, env, name } = await project();
	let result = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"show",
		"wf.json",
	]);
	assert.equal(result.code, 0);
	assert.match(
		result.out,
		new RegExp(`No saved preference for workflow ${name}`),
	);
	result = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"set",
		"wf.json",
		"--profile",
		"nope",
	]);
	assert.equal(result.code, 2);
	assert.match(
		result.err,
		/unknown profile "nope".*built-in presets: codex, claude, pi, mixed/s,
	);
	result = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"set",
		"wf.json",
		"--role",
		"verification=gemini",
	]);
	assert.equal(result.code, 2);
	assert.match(result.err, /"gemini" is an unknown executor/);
	result = await cliRun(cwd, env, ["profile", "workflow", "set", "wf.json"]);
	assert.equal(result.code, 2);
	assert.match(result.err, /needs a profile or at least one role/);
	result = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"set",
		"wf.json",
		"--profile",
		"careful",
		"--role",
		"default=claude::low",
		"--role",
		"verification=codex",
	]);
	assert.equal(result.code, 0, result.err);
	result = await cliRun(cwd, env, [
		"profile",
		"workflow",
		"set",
		"wf.json",
		"--unset",
		"roles.default",
	]);
	assert.equal(result.code, 0, result.err);
	result = await cliRun(cwd, env, ["profile", "workflow", "list"]);
	assert.match(
		result.out,
		new RegExp(
			`${name}\\n  profile: careful\\n  roles:\\n    verification  codex:-:-`,
		),
	);
	result = await cliRun(cwd, env, ["profile", "workflow", "clear", "wf.json"]);
	assert.match(result.out, /Cleared the saved preference/);
	result = await cliRun(cwd, env, ["profile", "workflow", "list", "--json"]);
	assert.deepEqual(JSON.parse(result.out).data.preferences, []);
});

test("workflow_profile workflow-* ops: reads are free, writes ask through elicitation", async () => {
	const { cwd, env, name, ctx } = await project();
	const requests = [];
	const client = await inProcessHostServer({
		root: cwd,
		env,
		onRequest: async (message) => {
			requests.push(message);
			return { action: "accept" };
		},
	});
	clients.push(client);
	await client.initialize("2025-06-18", { elicitation: {} });
	const set = await client.call("workflow_profile", {
		op: "workflow-set",
		workflow: "wf.json",
		profile: "mixed",
		roles: { verification: { executor: "codex", model: "gpt-5.6-luna" } },
	});
	assert.equal(set.isError, false, set.content[0].text);
	assert.equal(requests.length, 1);
	assert.match(
		JSON.stringify(requests[0]),
		/Save the agent-workflow preference of workflow wf\.json\?.*profile: mixed.*role verification: codex:gpt-5\.6-luna/,
	);
	const shown = await client.call("workflow_profile", {
		op: "workflow-show",
		workflow: "wf.json",
	});
	assert.equal(shown.structuredContent.data.preference.profile, "mixed");
	assert.equal(requests.length, 1, "reads ask nothing");
	const listed = await client.call("workflow_profile", { op: "workflow-list" });
	assert.deepEqual(
		listed.structuredContent.data.preferences.map((entry) => entry.workflow),
		[name],
	);
	const bad = await client.call("workflow_profile", {
		op: "workflow-show",
		workflow: "wf.json",
		executor: "codex",
	});
	assert.equal(bad.isError, true);
	const cleared = await client.call("workflow_profile", {
		op: "workflow-clear",
		workflow: "wf.json",
	});
	assert.equal(cleared.isError, false);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		(await api.workflowPreferenceAction(ctx, { op: "list" })).data.preferences,
		[],
	);
	// Without elicitation support a write is refused with the terminal command.
	const plain = await inProcessHostServer({ root: cwd, env });
	clients.push(plain);
	await plain.initialize("2025-06-18");
	const refused = await plain.call("workflow_profile", {
		op: "workflow-set",
		workflow: "wf.json",
		profile: "codex",
	});
	assert.equal(refused.isError, true);
	assert.equal(
		refused.structuredContent.data.command,
		"agent-workflow profile workflow set wf.json --profile codex",
	);
});

function fakePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		commands,
		tools,
		registerCommand(commandName, options) {
			commands.set(commandName, options);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on() {
			return () => undefined;
		},
		getThinkingLevel: () => "medium",
	};
}

function fakeCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: () => undefined,
			confirm: async () => true,
			select: async () => undefined,
		},
	};
}
