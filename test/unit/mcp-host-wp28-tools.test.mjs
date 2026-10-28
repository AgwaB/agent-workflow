// New in agent-workflow (WP28, owner decision Q7): every CLI command is a host MCP tool. Through the
// fake MCP client against an in-process server (runs on the workflow executor fixture; no model or
// agent-CLI calls): the nine new tools (resume, show, roles, agents, notices, doctor, prune, profile,
// supervise) equal the host API and CLI --json results; the changing calls (prune without dry run,
// profile set/delete/default/clear-default, notices acknowledge/clear) are refused with the terminal
// command when the client has no elicitation, change nothing on decline/cancel/error and act on
// accept; a dry-run prune and the read-only calls never ask.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { inProcessHostServer, waitLoop } from "../helpers/mcp-host-client.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const cli = await import("../../dist/hosts/cli/index.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const hostServer = await import("../../dist/mcp/host-server/index.js");

const ONE_STAGE = {
	schemaVersion: 1,
	name: "mcp-wp28-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

const NEW_TOOLS = [
	"workflow_resume",
	"workflow_show",
	"workflow_roles",
	"workflow_agents",
	"workflow_notices",
	"workflow_doctor",
	"workflow_prune",
	"workflow_profile",
	"workflow_supervise",
];

let root;
let counter = 0;
const unregister = [];
const clients = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-mcp-wp28-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const client of clients.splice(0))
		await client.close().catch(() => undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(ONE_STAGE, null, 2)}\n`,
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, ctx: { cwd, env } };
}

function fixture(config = {}) {
	counter += 1;
	const id = `test-wp28-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				...config,
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	return id;
}

async function connect(options, protocolVersion = "2025-06-18", capabilities) {
	const client = await inProcessHostServer(options);
	clients.push(client);
	const init = await client.initialize(protocolVersion, capabilities);
	assert.equal(init.error, undefined, JSON.stringify(init));
	return client;
}

/** A client that answers every elicitation with `answer()` and records the requests. */
async function elicitingClient(options, answer) {
	const requests = [];
	const client = await connect(
		{
			...options,
			onRequest: async (message) => {
				requests.push(message);
				return answer();
			},
		},
		"2025-06-18",
		{ elicitation: {} },
	);
	return { client, requests };
}

async function cliJson(cwd, env, argv) {
	const out = [];
	const code = await cli.runAgentWorkflowCli([...argv, "--json"], {
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: () => undefined,
		isTTY: false,
	});
	return { code, json: JSON.parse(out.join("")) };
}

const text = (result) => result.content[0].text;

/** Make the run's supervisor heartbeat stale (as if its last lease holder had exited). */
async function staleSupervisor(cwd, runId) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await rm(join(dir, "supervisor-lease.json"), { force: true });
	await writeFile(
		join(dir, "supervisor.json"),
		JSON.stringify({
			schemaVersion: 1,
			pid: 2 ** 22 - 3,
			updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
		}),
	);
}

/** An interrupted run (a slow fixture run stopped right after launch). */
async function interruptedRun(ctx) {
	const executor = fixture({ stepDelayMs: 2_000 });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: `interrupted ${counter}`,
		executor,
	});
	const runId = launched.data.runId;
	const stopped = await api.stopAction(ctx, { runId });
	assert.equal(stopped.data.status, "interrupted", stopped.text);
	return { runId, executor };
}

test("tools/list: the nine CLI-command tools follow the original nine; schemas, annotations and instructions", async () => {
	const { cwd, env } = await project();
	const client = await connect({ root: cwd, env });
	const { tools } = (await client.request("tools/list")).result;
	// WP29: workflow_approve follows them (mcp-host-wp29-approve.test.mjs).
	assert.deepEqual(tools.map((tool) => tool.name).slice(9, 18), NEW_TOOLS);
	assert.equal(tools.length, 19);
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	for (const name of NEW_TOOLS) {
		const tool = byName[name];
		assert.equal(tool.inputSchema.additionalProperties, false, name);
		assert.ok(tool.inputSchema.properties.cwd, `${name} takes cwd`);
		assert.equal(typeof tool.title, "string");
	}
	// Model calls are named in the descriptions of the tools that start them.
	assert.match(byName.workflow_resume.description, /model calls .*\(cost\)/);
	assert.match(byName.workflow_supervise.description, /model calls \(cost\)/);
	assert.deepEqual(byName.workflow_resume.inputSchema.required, ["runId"]);
	for (const name of [
		"workflow_show",
		"workflow_roles",
		"workflow_agents",
		"workflow_doctor",
	])
		assert.equal(byName[name].annotations.readOnlyHint, true, name);
	for (const name of ["workflow_prune", "workflow_profile", "workflow_resume"])
		assert.equal(byName[name].annotations.destructiveHint, true, name);
	assert.deepEqual(byName.workflow_profile.inputSchema.properties.op.enum, [
		"list",
		"show",
		"set",
		"delete",
		"default",
		"clear-default",
		// WP31: built-in executor presets (read-only) and per-workflow preferences.
		"presets",
		"workflow-list",
		"workflow-show",
		"workflow-set",
		"workflow-clear",
	]);
	assert.match(byName.workflow_prune.description, /dry run by default/i);
	const instructions = hostServer.HOST_MCP_INSTRUCTIONS;
	assert.match(instructions, /workflow_resume continues/);
	assert.match(instructions, /confirmation in an MCP dialog/);
	for (const change of hostServer.CONFIRMED_CHANGES)
		assert.ok(instructions.includes(change), change);
});

test("read-only tools equal the host API and CLI --json; no elicitation is sent", async () => {
	const { cwd, env, ctx } = await project();
	const { runId } = await interruptedRun(ctx);
	const prober = async (descriptor) => ({
		probe:
			descriptor.id === "claude"
				? { installed: true, cliVersion: "2.1.310", auth: "ok" }
				: { installed: false, cliVersion: null, auth: "unknown" },
		capabilities: {},
	});
	const { client, requests } = await elicitingClient(
		{
			root: cwd,
			env,
			host: "codex",
			api: {
				...api,
				doctorAction: (callCtx) => api.doctorAction(callCtx, { prober }),
			},
		},
		() => ({ action: "accept" }),
	);

	const spec = await client.call("workflow_show", { ref: "wf.json" });
	assert.equal(spec.isError, false, text(spec));
	const apiSpec = await api.showAction(ctx, { ref: "wf.json" });
	assert.deepEqual(spec.structuredContent.data, apiSpec.data);
	assert.equal(text(spec), apiSpec.text);
	assert.deepEqual(
		spec.structuredContent.data,
		(await cliJson(cwd, env, ["show", "wf.json"])).json.data,
	);

	// A run: summary + task rows instead of the full record; the text is the host API's.
	const shown = await client.call("workflow_show", { ref: runId, raw: true });
	const apiShown = await api.showAction(
		{ ...ctx, host: "codex" },
		{ ref: runId, raw: true },
	);
	assert.equal(text(shown), apiShown.text);
	assert.equal(shown.structuredContent.data.kind, "run");
	assert.equal(shown.structuredContent.data.run.runId, runId);
	assert.equal(shown.structuredContent.data.run.status, "interrupted");
	assert.deepEqual(
		shown.structuredContent.data.run.tasks.map((task) => task.taskId),
		apiShown.data.run.tasks.map((task) => task.taskId),
	);

	const roles = await client.call("workflow_roles", { workflow: "wf.json" });
	assert.deepEqual(
		roles.structuredContent.data,
		(await cliJson(cwd, env, ["roles", "wf.json"])).json.data,
	);
	const agents = await client.call("workflow_agents", {});
	assert.deepEqual(
		agents.structuredContent.data,
		(await cliJson(cwd, env, ["agents"])).json.data,
	);
	assert.ok(
		agents.structuredContent.data.agents.some(
			(agent) => agent.name === "reader",
		),
	);

	const doctor = await client.call("workflow_doctor", {});
	assert.equal(doctor.isError, false, text(doctor));
	assert.equal(doctor.structuredContent.data.host, "codex");
	assert.equal(
		doctor.structuredContent.data.executors.find(
			(entry) => entry.id === "claude",
		).installed,
		true,
	);

	const notices = await client.call("workflow_notices", {});
	assert.deepEqual(
		notices.structuredContent.data,
		(await api.noticesAction(ctx, { argv: ["list"] })).data,
	);
	assert.ok(
		notices.structuredContent.data.notices.some(
			(notice) => notice.runId === runId,
		),
	);

	const profiles = await client.call("workflow_profile", {});
	assert.deepEqual(
		profiles.structuredContent.data,
		(await cliJson(cwd, env, ["profile", "list"])).json.data,
	);
	const shownProfile = await client.call("workflow_profile", { op: "show" });
	assert.equal(shownProfile.structuredContent.data.op, "show");

	// prune: a dry run by default, also with dryRun: true; nothing is removed.
	const dry = await client.call("workflow_prune", { keep: 0 });
	assert.equal(dry.isError, false, text(dry));
	assert.equal(dry.structuredContent.data.dryRun, true);
	assert.deepEqual(
		dry.structuredContent.data,
		(await cliJson(cwd, env, ["prune", "--keep", "0"])).json.data,
	);
	const explicitDry = await client.call("workflow_prune", {
		keep: 0,
		dryRun: true,
	});
	assert.equal(explicitDry.structuredContent.data.dryRun, true);
	assert.equal((await api.statusAction(ctx, { runId })).data.run.runId, runId);

	assert.equal(requests.length, 0, "read-only calls never ask");
});

test("resume continues a run (detach default true); supervise starts nothing for a finished or live-driven run", async () => {
	const { cwd, env, ctx } = await project();
	const { runId } = await interruptedRun(ctx);
	const client = await connect({ root: cwd, env, host: "codex" });

	const resumed = await client.call("workflow_resume", {
		runId,
		detach: false,
	});
	assert.equal(resumed.isError, false, text(resumed));
	assert.equal(resumed.structuredContent.action, "resume");
	assert.equal(resumed.structuredContent.data.runId, runId);
	assert.equal(resumed.structuredContent.data.status, "running");
	assert.ok(resumed.structuredContent.data.resetTaskIds.length > 0);
	assert.equal(resumed.structuredContent.data.detached, undefined);
	assert.match(text(resumed), /Next: call workflow_wait/);

	// While this server's in-process watcher drives the resumed run, supervise starts nothing.
	const live = await client.call("workflow_supervise", { runId });
	assert.equal(live.isError, false, text(live));
	assert.equal(live.structuredContent.data.started, false);
	assert.equal(live.structuredContent.data.reason, "live-supervisor");

	const waits = await waitLoop(client, runId);
	assert.equal(waits.at(-1).structuredContent.outcome, "completed");
	const done = await client.call("workflow_supervise", { runId });
	assert.equal(done.structuredContent.data.started, false);
	assert.equal(done.structuredContent.data.reason, "not-running");
	assert.equal(done.structuredContent.outcome, "completed");

	// detach defaults to true for resume (recorded, not spawned).
	const calls = [];
	const stub = await connect({
		root: cwd,
		env,
		api: {
			...api,
			resumeAction: async (_ctx, request) => {
				calls.push(request);
				return {
					action: "resume",
					ok: true,
					outcome: "running",
					data: {
						runId: "workflow_stub",
						status: "running",
						resetTaskIds: ["a"],
						taskSummary: {},
					},
					text: "Resumed",
				};
			},
		},
	});
	await stub.call("workflow_resume", { runId: "workflow_stub" });
	assert.deepEqual(calls, [{ runId: "workflow_stub", detach: true }]);
});

test("changes without elicitation support are refused with the terminal command; nothing changes", async () => {
	const { cwd, env, ctx } = await project();
	const { runId } = await interruptedRun(ctx);
	const sha = (await api.noticesAction(ctx, { argv: ["list"] })).data.notices[0]
		.sha256;
	await mkdir(join(cwd, "sub"), { recursive: true });
	for (const [version, capabilities] of [
		["2025-06-18", {}],
		["2025-11-25", { elicitation: { url: {} } }],
		["2025-03-26", { elicitation: {} }],
	]) {
		const client = await connect(
			{ root: cwd, env, host: "claude-code" },
			version,
			capabilities,
		);
		const cases = [
			[
				"workflow_profile",
				{
					op: "set",
					name: "fast",
					executor: "codex",
					effort: "high",
					strictCapabilities: ["mcp.stdio"],
					makeDefault: true,
				},
				"agent-workflow profile set fast --executor codex --effort high --strict-capabilities mcp.stdio --default",
			],
			[
				"workflow_profile",
				{ op: "delete", name: "fast" },
				"agent-workflow profile delete fast",
			],
			[
				"workflow_profile",
				{ op: "default", name: "fast" },
				"agent-workflow profile default fast",
			],
			[
				"workflow_profile",
				{ op: "clear-default" },
				"agent-workflow profile default --clear",
			],
			[
				"workflow_prune",
				{ dryRun: false, keep: 0 },
				"agent-workflow prune --yes --keep 0",
			],
			[
				"workflow_prune",
				{ dryRun: false, cwd: "sub" },
				`cd ${join(cwd, "sub")} && agent-workflow prune --yes`,
			],
			[
				"workflow_notices",
				{
					action: "acknowledge",
					runId,
					state: sha,
					reason: "known flaky run",
				},
				`agent-workflow notices acknowledge ${runId} --state ${sha} --reason 'known flaky run'`,
			],
			[
				"workflow_notices",
				{ action: "clear", runId },
				`agent-workflow notices clear ${runId}`,
			],
		];
		for (const [tool, args, command] of cases) {
			const refused = await client.call(tool, args);
			assert.equal(refused.isError, true, `${tool} ${JSON.stringify(args)}`);
			assert.match(text(refused), /does not support confirmation dialogs/);
			assert.ok(text(refused).includes(command), `${text(refused)}`);
			assert.equal(refused.structuredContent, undefined, "claude-code");
		}
	}
	// Structured form (generic host).
	const generic = await connect({ root: cwd, env });
	const refused = await generic.call("workflow_profile", {
		op: "delete",
		name: "fast",
	});
	assert.equal(refused.structuredContent.outcome, "refused");
	assert.deepEqual(refused.structuredContent.data, {
		confirmation: "unsupported",
		command: "agent-workflow profile delete fast",
		changed: false,
	});
	// Nothing changed.
	assert.deepEqual(
		(await api.profileAction(ctx, { op: "list" })).data.profiles,
		[],
	);
	assert.equal((await api.statusAction(ctx, { runId })).data.run.runId, runId);
	assert.equal(
		(await api.noticesAction(ctx, { argv: ["list"] })).data.acknowledgements
			.length,
		0,
	);
});

test("changes ask through elicitation: decline/cancel/error change nothing, accept acts", async () => {
	const { cwd, env, ctx } = await project();
	const { runId } = await interruptedRun(ctx);
	const sha = (await api.noticesAction(ctx, { argv: ["list"] })).data.notices[0]
		.sha256;
	let answer = { action: "decline" };
	const { client, requests } = await elicitingClient(
		{ root: cwd, env, host: "codex" },
		() => answer,
	);
	const changes = [
		["workflow_profile", { op: "set", name: "fast", executor: "codex" }],
		[
			"workflow_notices",
			{ action: "acknowledge", runId, state: sha, reason: "seen" },
		],
		["workflow_prune", { dryRun: false, keep: 0 }],
	];
	for (const reply of [
		{ action: "decline" },
		{ action: "cancel" },
		{ error: { code: -32603, message: "no UI" } },
	]) {
		answer = reply;
		for (const [tool, args] of changes) {
			const before = requests.length;
			const result = await client.call(tool, args);
			assert.equal(requests.length, before + 1, `${tool} asked once`);
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.outcome, "refused");
			assert.equal(result.structuredContent.data.changed, false);
			assert.match(text(result), /Nothing was changed/);
		}
	}
	assert.ok(client.logs.some((line) => /treated as declined/.test(line)));
	assert.deepEqual(
		(await api.profileAction(ctx, { op: "list" })).data.profiles,
		[],
	);
	assert.equal(
		(await api.noticesAction(ctx, { argv: ["list"] })).data.acknowledgements
			.length,
		0,
	);
	assert.equal((await api.statusAction(ctx, { runId })).data.run.runId, runId);

	// The dialogs say what would change (prune shows its dry run first).
	const messages = requests.slice(0, 3).map((request) => request.params);
	assert.match(
		messages[0].message,
		/^Save the agent-workflow user profile "fast"\?/,
	);
	assert.match(messages[0].message, /executor: codex/);
	assert.match(
		messages[1].message,
		new RegExp(
			`^Acknowledge \\(hide\\) the unfinished-run notice for ${runId}\\?`,
		),
	);
	assert.match(messages[1].message, /Reason: seen/);
	assert.match(messages[2].message, /^Delete finished agent-workflow runs/);
	assert.match(messages[2].message, /Dry run of this prune:/);
	for (const params of messages)
		assert.deepEqual(params.requestedSchema, {
			type: "object",
			properties: {},
		});

	// accept: every change acts and equals the CLI's view afterwards.
	answer = { action: "accept", content: {} };
	const set = await client.call("workflow_profile", {
		op: "set",
		name: "fast",
		executor: "codex",
		model: "m",
		permissionMode: "safe",
		makeDefault: true,
	});
	assert.equal(set.isError, false, text(set));
	const listed = (await cliJson(cwd, env, ["profile", "list"])).json.data;
	assert.equal(listed.default, "fast");
	assert.deepEqual(
		listed.profiles.map((profile) => profile.name),
		["fast"],
	);
	const cleared = await client.call("workflow_profile", {
		op: "clear-default",
	});
	assert.equal(cleared.isError, false, text(cleared));
	assert.equal(
		(await api.profileAction(ctx, { op: "list" })).data.default,
		undefined,
	);
	const madeDefault = await client.call("workflow_profile", {
		op: "default",
		name: "fast",
	});
	assert.equal(madeDefault.isError, false, text(madeDefault));
	assert.equal(
		(await api.profileAction(ctx, { op: "list" })).data.default,
		"fast",
	);
	const deleted = await client.call("workflow_profile", {
		op: "delete",
		name: "fast",
	});
	assert.equal(deleted.isError, false, text(deleted));
	assert.deepEqual(
		(await api.profileAction(ctx, { op: "list" })).data.profiles,
		[],
	);

	const acknowledged = await client.call("workflow_notices", {
		action: "acknowledge",
		runId,
		state: sha,
		reason: "seen",
	});
	assert.equal(acknowledged.isError, false, text(acknowledged));
	assert.equal(
		(await api.noticesAction(ctx, { argv: ["list"] })).data.acknowledgements
			.length,
		1,
	);
	const clearedNotice = await client.call("workflow_notices", {
		action: "clear",
		runId,
	});
	assert.equal(clearedNotice.isError, false, text(clearedNotice));
	assert.equal(
		(await api.noticesAction(ctx, { argv: ["list"] })).data.acknowledgements
			.length,
		0,
	);

	// The run's last lease holder (this process) is gone: prune may remove it.
	await staleSupervisor(cwd, runId);
	const pruned = await client.call("workflow_prune", {
		dryRun: false,
		keep: 0,
	});
	assert.equal(pruned.isError, false, text(pruned));
	assert.equal(pruned.structuredContent.data.dryRun, false);
	assert.ok(
		pruned.structuredContent.data.runs.some(
			(entry) => entry.runId === runId && entry.deleted,
		),
		JSON.stringify(pruned.structuredContent.data),
	);
	await assert.rejects(api.statusAction(ctx, { runId }));
});

test("usage errors are refused before any confirmation is asked", async () => {
	const { cwd, env } = await project();
	const { client, requests } = await elicitingClient(
		{ root: cwd, env },
		() => ({ action: "accept" }),
	);
	for (const [tool, args, pattern] of [
		["workflow_profile", { op: "set" }, /name is required with op set/],
		[
			"workflow_profile",
			{ op: "list", executor: "x" },
			/only valid with op set/,
		],
		["workflow_profile", { op: "clear-default", name: "x" }, /not valid/],
		["workflow_profile", { op: "bogus" }, /op must be one of/],
		[
			"workflow_profile",
			{ op: "set", name: "x", effort: "huge" },
			/effort|thinking/i,
		],
		[
			"workflow_notices",
			{ action: "acknowledge", runId: "workflow_x" },
			/state is required/,
		],
		["workflow_notices", { action: "list", runId: "workflow_x" }, /not valid/],
		[
			"workflow_notices",
			{ action: "clear", runId: "workflow_x", reason: "r" },
			/not valid/,
		],
		[
			"workflow_notices",
			{
				action: "acknowledge",
				runId: "workflow_x",
				state: "nothex",
				reason: "r",
			},
			/Usage/,
		],
		["workflow_prune", { olderThanDays: -1, dryRun: false }, /olderThanDays/],
		["workflow_prune", { bogus: 1 }, /unknown parameter bogus/],
		["workflow_show", {}, /ref is required/],
		["workflow_resume", {}, /runId is required/],
		["workflow_supervise", { runId: "-x" }, /run id/],
	]) {
		const result = await client.call(tool, args);
		assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
		assert.match(text(result), pattern, text(result));
	}
	assert.equal(requests.length, 0);
});
