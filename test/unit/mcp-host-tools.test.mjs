// New in agent-workflow (WP13): the `agent-workflow` host MCP server's tools through a fake MCP
// client against an in-process server (serveHostMcpStdio over PassThrough streams). Runs use the
// workflow executor fixture registered in-process (no model or agent-CLI calls). Covers every tool,
// equality with the host API and the CLI's --json results, the bounded wait + loop, degradation
// confirmation through elicitation (accept / decline / absent / unsupported revision), the cwd
// restriction, usage errors, host identity, cancellation and progress.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
	name: "mcp-host-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

const DEGRADED = {
	contextIsolation: {
		level: "emulated",
		source: "probed",
		warning: "global AGENTS.md loaded",
	},
};

let root;
let counter = 0;
const unregister = [];
const clients = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-mcp-host-")));
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

async function writeProject(cwd) {
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(ONE_STAGE, null, 2)}\n`,
	);
}

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await writeProject(cwd);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, ctx: { cwd, env } };
}

function fixture(config = {}) {
	counter += 1;
	const id = `test-mcp-${counter}`;
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

async function connect(options, protocolVersion, capabilities) {
	const client = await inProcessHostServer(options);
	clients.push(client);
	const init = await client.initialize(protocolVersion, capabilities);
	assert.equal(init.error, undefined, JSON.stringify(init));
	return client;
}

/** Recording host API: passes through unless a stub is given. */
function recordingApi(stubs = {}) {
	const calls = [];
	const wrapped = {};
	for (const name of [
		"listWorkflowsAction",
		"runWorkflowAction",
		"runDynamicAction",
		"statusAction",
		"waitAction",
		"stopAction",
		"inspectAction",
		"logsAction",
		"validateWorkflowAction",
	])
		wrapped[name] = async (ctx, request) => {
			calls.push({ name, ctx, request });
			return stubs[name] ? stubs[name](ctx, request) : api[name](ctx, request);
		};
	return { calls, api: wrapped };
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

test("initialize and tools/list: server name, instructions, every tool gated per revision", async () => {
	const { cwd, env } = await project();
	const client = await inProcessHostServer({ root: cwd, env });
	clients.push(client);
	const init = await client.initialize("2025-06-18");
	assert.equal(init.result.serverInfo.name, "agent-workflow");
	assert.deepEqual(init.result.capabilities, {
		tools: { listChanged: false },
	});
	const instructions = init.result.instructions;
	assert.equal(instructions, hostServer.HOST_MCP_INSTRUCTIONS);
	for (const pattern of [
		/workflow_wait \{runId\} waits at most 45 s/,
		/While stillRunning is true, call workflow_wait again/,
		/do not paraphrase/,
		/"free" by default/,
		/omit executor/,
	])
		assert.match(instructions, pattern);
	const { tools } = (await client.request("tools/list")).result;
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[
			"workflow_list",
			"workflow_run",
			"workflow_dynamic",
			"workflow_status",
			"workflow_wait",
			"workflow_stop",
			"workflow_inspect",
			"workflow_logs",
			"workflow_validate",
			// WP28: the CLI commands (mcp-host-wp28-tools.test.mjs).
			"workflow_resume",
			"workflow_show",
			"workflow_roles",
			"workflow_agents",
			"workflow_notices",
			"workflow_doctor",
			"workflow_prune",
			"workflow_profile",
			"workflow_supervise",
			// WP29: dynamic-controller approvals (mcp-host-wp29-approve.test.mjs).
			"workflow_approve",
			// WP32: auto workflow selection with consent (host-wp32-auto.test.mjs).
			"workflow_auto",
			"workflow_dashboard",
			// 2026-10-30: the launch preflight without the launch (host-check-preflight.test.mjs).
			"workflow_check",
		],
	);
	for (const tool of tools) {
		assert.equal(typeof tool.title, "string");
		assert.equal(tool.inputSchema.type, "object");
		assert.equal(tool.inputSchema.additionalProperties, false);
		assert.ok(tool.inputSchema.properties.cwd, `${tool.name} takes cwd`);
		assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
	}
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	assert.deepEqual(byName.workflow_run.inputSchema.required, [
		"workflow",
		"task",
	]);
	for (const key of [
		"executor",
		"profile",
		"permissionMode",
		"allowUnverified",
		"model",
		"effort",
		"inputs",
		"detach",
		"forceNew",
	]) {
		assert.ok(byName.workflow_run.inputSchema.properties[key], key);
		assert.ok(byName.workflow_dynamic.inputSchema.properties[key], key);
	}
	assert.match(
		byName.workflow_run.inputSchema.properties.detach.description,
		/default true/,
	);
	assert.equal(
		byName.workflow_wait.inputSchema.properties.timeoutMs.maximum,
		45_000,
	);
	assert.match(byName.workflow_wait.description, /call workflow_wait again/);
	assert.match(byName.workflow_wait.description, /quote the preview/);
	await client.close();

	// 2024-11-05: no title/annotations and no structuredContent.
	const old = await connect({ root: cwd, env }, "2024-11-05");
	const oldTools = (await old.request("tools/list")).result.tools;
	assert.equal(oldTools[0].title, undefined);
	assert.equal(oldTools[0].annotations, undefined);
	const listed = await old.call("workflow_list", { limit: 1 });
	assert.equal(listed.structuredContent, undefined);
	assert.equal(listed.isError, false);
});

test("WP18b: --host claude-code gets the text content only (no structuredContent); codex and generic keep it", async () => {
	const { cwd, env } = await project();
	assert.deepEqual(hostServer.HOST_MCP_TEXT_ONLY_HOSTS, ["claude-code"]);
	for (const [host, structured] of [
		["claude-code", false],
		["codex", true],
		["generic", true],
	]) {
		assert.equal(
			hostServer.hostMcpSendsStructuredContent(host, "2025-06-18"),
			structured,
		);
		const client = await connect({ root: cwd, env, host }, "2025-06-18");
		const listed = await client.call("workflow_list", { limit: 1 });
		assert.equal(listed.isError, false);
		assert.match(text(listed), /wf|deep-review|workflow/i);
		assert.equal(listed.structuredContent !== undefined, structured, host);
		// Error results follow the same rule; the text keeps the error kind.
		const refused = await client.call("workflow_status", { runId: "-x" });
		assert.equal(refused.isError, true);
		assert.match(text(refused), /^Usage error:/);
		assert.equal(refused.structuredContent !== undefined, structured, host);
	}
	// No revision gives Claude Code structuredContent.
	assert.equal(
		hostServer.hostMcpSendsStructuredContent("claude-code", "2025-11-25"),
		false,
	);
});

test("every tool through the fake client equals the host API and CLI --json results", async () => {
	const { cwd, env, ctx } = await project();
	const executor = fixture();
	const client = await connect({ root: cwd, env, host: "codex" });

	// list
	const listed = await client.call("workflow_list", {});
	const apiList = await api.listWorkflowsAction(ctx, { limit: 20 });
	assert.equal(listed.isError, false);
	assert.deepEqual(listed.structuredContent.data, apiList.data);
	assert.equal(listed.structuredContent.text, apiList.text);
	assert.equal(text(listed), apiList.text);
	const cliList = await cliJson(cwd, env, ["list", "--limit", "20"]);
	assert.deepEqual(listed.structuredContent.data, cliList.json.data);

	// validate
	const validated = await client.call("workflow_validate", {
		workflow: "wf.json",
	});
	const apiValidate = await api.validateWorkflowAction(ctx, {
		workflow: "wf.json",
	});
	assert.deepEqual(validated.structuredContent.data, apiValidate.data);
	assert.equal(text(validated), apiValidate.text);
	assert.deepEqual(
		validated.structuredContent.data,
		(await cliJson(cwd, env, ["validate", "wf.json"])).json.data,
	);

	// check: the launch preflight without a run (same data as the host API and the CLI)
	const checked = await client.call("workflow_check", {
		workflow: "wf.json",
		executor,
	});
	assert.equal(checked.isError, false, text(checked));
	assert.match(text(checked), /^Preflight passed: .* no run was started\./);
	assert.equal(checked.structuredContent.data.runId, undefined);
	assert.ok(
		checked.structuredContent.data.capability.preview.startsWith(
			"Capability check",
		),
	);
	const refusedCheck = await client.call("workflow_check", {
		workflow: "wf.json",
		executor: "no-such-executor",
	});
	assert.equal(refusedCheck.isError, true);

	// run (in-process: detach false) → wait loop
	const launched = await client.call("workflow_run", {
		workflow: "wf.json",
		task: "collect facts",
		executor,
		detach: false,
	});
	assert.equal(launched.isError, false, text(launched));
	const launch = launched.structuredContent;
	assert.equal(launch.action, "run");
	assert.equal(launch.outcome, "running");
	assert.equal(launch.data.executor.id, executor);
	assert.equal(launch.data.permissionMode.mode, "free");
	assert.equal(launch.data.detached, undefined);
	const runId = launch.data.runId;
	assert.match(runId, /^workflow_/);
	assert.match(text(launched), new RegExp(`Run: ${runId}`));
	assert.match(
		launch.next,
		new RegExp(`call workflow_wait \\{"runId":"${runId}"\\}`),
	);
	assert.ok(text(launched).endsWith(launch.next));
	const waits = await waitLoop(client, runId);
	const final = waits.at(-1).structuredContent;
	assert.equal(final.outcome, "completed");
	assert.equal(final.data.terminal, true);
	assert.equal(final.data.actionRequired, false);
	assert.equal(final.data.stillRunning, false);
	assert.match(
		final.next,
		/terminal=true actionRequired=false stillRunning=false/,
	);
	assert.match(final.next, /do not paraphrase the report/);
	const apiWait = await api.waitAction(ctx, { runId });
	assert.deepEqual(final.data, apiWait.data);
	assert.equal(final.text, apiWait.text);
	const cliWait = await cliJson(cwd, env, ["wait", runId]);
	assert.deepEqual(final.data, cliWait.json.data);

	// status (one run, every run)
	const status = await client.call("workflow_status", { runId });
	assert.deepEqual(
		status.structuredContent.data,
		(await api.statusAction(ctx, { runId })).data,
	);
	assert.deepEqual(
		status.structuredContent.data,
		(await cliJson(cwd, env, ["status", runId])).json.data,
	);
	const all = await client.call("workflow_status", {});
	assert.deepEqual(
		all.structuredContent.data,
		(await api.statusAction(ctx, {})).data,
	);

	// inspect: the run record is projected to a summary; reliability, listed and text are equal.
	const inspected = await client.call("workflow_inspect", {
		runId,
		results: true,
	});
	const apiInspect = await api.inspectAction(ctx, { runId, results: true });
	assert.equal(inspected.structuredContent.text, apiInspect.text);
	assert.deepEqual(
		inspected.structuredContent.data.reliability,
		apiInspect.data.reliability,
	);
	assert.deepEqual(
		inspected.structuredContent.data.listed,
		apiInspect.data.listed,
	);
	assert.deepEqual(inspected.structuredContent.data.run, {
		...api.summarizeRun(apiInspect.data.run),
		tasks: apiInspect.data.run.tasks.map((task) => ({
			taskId: task.taskId,
			specId: task.specId,
			status: task.status,
			statusDetail: String(task.statusDetail),
			...(task.lastMessage ? { lastMessage: task.lastMessage } : {}),
		})),
	});
	const cliInspect = await cliJson(cwd, env, ["inspect", runId, "--results"]);
	assert.deepEqual(
		inspected.structuredContent.data.reliability,
		cliInspect.json.data.reliability,
	);

	// logs (WP18b): the host API logs action; equal to the CLI --json data.
	const logs = await client.call("workflow_logs", {
		runId,
		lines: 5,
		stream: "output",
	});
	assert.equal(logs.isError, false, text(logs));
	const apiLogs = await api.logsAction(ctx, {
		runId,
		lines: 5,
		stream: "output",
	});
	assert.deepEqual(logs.structuredContent.data, apiLogs.data);
	assert.equal(text(logs), apiLogs.text);
	assert.deepEqual(
		logs.structuredContent.data,
		(
			await cliJson(cwd, env, [
				"logs",
				runId,
				"--lines",
				"5",
				"--stream",
				"output",
			])
		).json.data,
	);
	const taskLogs = await client.call("workflow_logs", {
		runId,
		task: apiLogs.data.tasks[0].specId,
	});
	assert.equal(taskLogs.structuredContent.data.tasks.length, 1);
	for (const [args, pattern] of [
		[
			{ runId, stream: "nope" },
			/stream must be one of output, stderr, events, all/,
		],
		[{ runId, lines: 0 }, /lines must be an integer from 1 to 400/],
		[{ runId, task: "no-such-task" }, /no-such-task/],
	]) {
		const bad = await client.call("workflow_logs", args);
		assert.equal(bad.isError, true);
		assert.match(text(bad), pattern);
	}

	// dynamic with an unavailable executor: refused, nothing launched, isError.
	const refused = await client.call("workflow_dynamic", {
		task: "explore",
		executor: "no-such-executor",
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.structuredContent.outcome, "refused");
	assert.equal(
		refused.structuredContent.data.refusal.code,
		"EXECUTOR_UNAVAILABLE",
	);
	const apiRefused = await api.runDynamicAction(ctx, {
		task: "explore",
		executor: "no-such-executor",
	});
	assert.deepEqual(refused.structuredContent.data, apiRefused.data);

	// stop a slow running run
	const slow = fixture({ stepDelayMs: 2_000 });
	const slowRun = await client.call("workflow_run", {
		workflow: "wf.json",
		task: "slow facts",
		executor: slow,
		detach: false,
	});
	const slowId = slowRun.structuredContent.data.runId;
	const stopped = await client.call("workflow_stop", { runId: slowId });
	assert.equal(stopped.isError, false, text(stopped));
	assert.equal(stopped.structuredContent.data.status, "interrupted");
	assert.equal(stopped.structuredContent.data.pending, false);
	const afterStop = await waitLoop(client, slowId);
	assert.equal(afterStop.at(-1).structuredContent.outcome, "interrupted");
	assert.equal(afterStop.at(-1).structuredContent.data.terminal, true);
});

test("host identity, detach default true, launch options and cwd reach the host API", async () => {
	const { cwd, env } = await project();
	await mkdir(join(cwd, "sub"), { recursive: true });
	const recorded = recordingApi({
		runWorkflowAction: async () => ({
			action: "run",
			ok: true,
			outcome: "running",
			data: {
				mode: "named-workflow",
				runId: "workflow_stub",
				status: "running",
			},
			text: "Workflow started: stub",
		}),
		runDynamicAction: async () => ({
			action: "dynamic",
			ok: true,
			outcome: "running",
			data: {
				mode: "direct-dynamic",
				runId: "workflow_dyn",
				status: "running",
			},
			text: "Dynamic workflow started",
		}),
	});
	const client = await connect({
		root: cwd,
		env,
		host: "claude-code",
		api: recorded.api,
	});
	await client.call("workflow_run", {
		workflow: "deep-review",
		task: "review this",
		executor: "codex",
		profile: "fast",
		permissionMode: "safe",
		allowUnverified: ["mcp.stdio"],
		model: "m",
		effort: "high",
		forceNew: true,
		inputs: { depth: "quick" },
		cwd: "sub",
	});
	await client.call("workflow_dynamic", { task: "explore", detach: false });
	await client.call("workflow_list", {});
	const [run, dynamic, list] = recorded.calls;
	assert.equal(run.ctx.host, "claude-code");
	assert.equal(run.ctx.cwd, join(cwd, "sub"));
	assert.equal(run.ctx.env, env);
	const { confirmDegradations, interactive, ...request } = run.request;
	assert.equal(interactive, undefined, "no elicitation capability");
	assert.equal(confirmDegradations, undefined);
	assert.deepEqual(request, {
		workflow: "deep-review",
		task: "review this",
		executor: "codex",
		profile: "fast",
		permissionMode: "safe",
		allowUnverifiedCapabilities: ["mcp.stdio"],
		model: "m",
		effort: "high",
		detach: true,
		forceNew: true,
		inputOverrides: { depth: "quick" },
		// WP33: launch capture: the tool call's arguments (redacted by the host API).
		launchOrigin: {
			kind: "tool",
			name: "workflow_run",
			arguments: {
				workflow: "deep-review",
				task: "review this",
				executor: "codex",
				profile: "fast",
				permissionMode: "safe",
				allowUnverified: ["mcp.stdio"],
				model: "m",
				effort: "high",
				forceNew: true,
				inputs: { depth: "quick" },
				cwd: "sub",
			},
		},
	});
	assert.equal(dynamic.ctx.host, "claude-code");
	assert.deepEqual(dynamic.request, {
		task: "explore",
		launchOrigin: {
			kind: "tool",
			name: "workflow_dynamic",
			arguments: { task: "explore", detach: false },
		},
	});
	assert.equal(list.ctx.cwd, cwd);
	assert.equal(list.ctx.host, "claude-code");
});

test("wait: bounded per call (cap 45 s), stillRunning until the loop reaches terminal; progress; cancel", async () => {
	const { cwd, env, ctx } = await project();
	const slow = fixture({ stepDelayMs: 1_500 });
	const client = await connect({ root: cwd, env });
	const launched = await client.call("workflow_run", {
		workflow: "wf.json",
		task: "slow",
		executor: slow,
		detach: false,
	});
	const runId = launched.structuredContent.data.runId;
	const first = await client.call(
		"workflow_wait",
		{ runId, timeoutMs: 1_000 },
		{ progressToken: "p-1" },
	);
	assert.equal(first.isError, false);
	assert.equal(first.structuredContent.outcome, "running");
	assert.equal(first.structuredContent.data.stillRunning, true);
	assert.equal(first.structuredContent.data.terminal, false);
	assert.equal(first.structuredContent.data.timeoutMs, 1_000);
	assert.match(text(first), /stillRunning=true/);
	assert.match(
		text(first),
		new RegExp(`call workflow_wait \\{"runId":"${runId}"\\} again`),
	);
	const progress = client.messages.filter(
		(message) => message.method === "notifications/progress",
	);
	assert.ok(progress.length > 0, "progress notifications for the token");
	for (const [index, message] of progress.entries()) {
		assert.equal(message.params.progressToken, "p-1");
		assert.equal(message.params.progress, index + 1);
	}

	// A cancelled wait gets no response; the run keeps going.
	const id = client.nextId();
	client.sendJson({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "workflow_wait", arguments: { runId } },
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
	client.notify("notifications/cancelled", { requestId: id });
	assert.deepEqual((await client.request("ping")).result, {});
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		client.messages.some((message) => message.id === id),
		false,
		"no response for a cancelled call",
	);

	const rest = await waitLoop(client, runId, { timeoutMs: 1_000 });
	assert.ok(rest.length >= 1);
	assert.equal(rest.at(-1).structuredContent.outcome, "completed");

	// A larger bound is capped at 45 s (the run is terminal, so the call returns at once).
	const capped = await client.call("workflow_wait", {
		runId,
		timeoutMs: 10_000_000,
	});
	assert.equal(capped.structuredContent.data.timeoutMs, 45_000);
	const floor = await client.call("workflow_wait", { runId, timeoutMs: 1 });
	assert.equal(floor.structuredContent.data.timeoutMs, 1_000);
	assert.deepEqual(
		capped.structuredContent.data,
		(await api.waitAction(ctx, { runId })).data,
	);
});

test("degradation confirmation: elicitation accept / decline / error; absent or unsupported → non-interactive", async () => {
	const { cwd, env } = await project();
	const executor = fixture({ capabilities: DEGRADED });
	const base = {
		workflow: "wf.json",
		executor,
		permissionMode: "safe",
		detach: false,
	};
	const elicitations = [];
	let answer = { action: "accept", content: {} };
	const client = await connect(
		{
			root: cwd,
			env,
			onRequest: async (message) => {
				elicitations.push(message);
				return answer;
			},
		},
		"2025-06-18",
		{ elicitation: {} },
	);

	const accepted = await client.call("workflow_run", {
		...base,
		task: "accepted",
	});
	assert.equal(accepted.isError, false, text(accepted));
	assert.equal(
		accepted.structuredContent.data.capability.confirmation,
		"confirmed",
	);
	assert.equal(elicitations.length, 1);
	const request = elicitations[0];
	assert.equal(request.method, "elicitation/create");
	assert.equal(request.params.mode, undefined, "2025-06-18 has no mode");
	assert.match(
		request.params.message,
		/^Proceed with these executor capability degradations\?\n\n/,
	);
	assert.match(request.params.message, /global AGENTS\.md loaded/);
	assert.deepEqual(request.params.requestedSchema, {
		type: "object",
		properties: {},
	});

	for (const reply of [
		{ action: "decline" },
		{ action: "cancel" },
		{ error: { code: -32603, message: "no UI" } },
	]) {
		answer = reply;
		const declined = await client.call("workflow_run", {
			...base,
			task: `declined ${JSON.stringify(reply)}`,
		});
		assert.equal(declined.isError, true);
		assert.equal(declined.structuredContent.outcome, "refused");
		assert.equal(
			declined.structuredContent.data.refusal.code,
			"CAPABILITY_DEGRADATION_DECLINED",
		);
	}
	assert.equal(elicitations.length, 4);
	assert.ok(client.logs.some((line) => /treated as declined/.test(line)));
	await waitLoop(client, accepted.structuredContent.data.runId);

	// 2025-11-25 form mode carries mode: "form".
	const formRequests = [];
	const modern = await connect(
		{
			root: cwd,
			env,
			onRequest: async (message) => {
				formRequests.push(message);
				return { action: "accept" };
			},
		},
		"2025-11-25",
		{ elicitation: { form: {} } },
	);
	const modernRun = await modern.call("workflow_run", {
		...base,
		task: "modern",
	});
	assert.equal(formRequests[0].params.mode, "form");
	assert.equal(
		modernRun.structuredContent.data.capability.confirmation,
		"confirmed",
	);
	await waitLoop(modern, modernRun.structuredContent.data.runId);

	// No elicitation capability, URL-only elicitation, or a pre-2025-06-18 revision: recorded and
	// the run proceeds (non-interactive); nothing is asked.
	for (const [version, capabilities] of [
		["2025-06-18", {}],
		["2025-11-25", { elicitation: { url: {} } }],
		["2025-03-26", { elicitation: {} }],
	]) {
		const asked = [];
		const headless = await connect(
			{
				root: cwd,
				env,
				onRequest: async (message) => {
					asked.push(message);
					return { action: "decline" };
				},
			},
			version,
			capabilities,
		);
		const quiet = await headless.call("workflow_run", {
			...base,
			task: `headless ${version} ${JSON.stringify(capabilities)}`,
		});
		assert.equal(quiet.isError, false, text(quiet));
		assert.deepEqual(asked, []);
		const data =
			quiet.structuredContent?.data ??
			// 2025-03-26 has no structuredContent: the text carries the capability preview.
			undefined;
		if (data) assert.equal(data.capability.confirmation, "non-interactive");
		else assert.match(text(quiet), /Capability check/);
		const runId = data?.runId ?? /Run: (workflow_\S+)/.exec(text(quiet))?.[1];
		assert.ok(runId);
		let waited;
		do waited = await headless.call("workflow_wait", { runId });
		while (/stillRunning=true/.test(text(waited)));
	}
	assert.equal(
		hostServer.clientSupportsFormElicitation("2025-06-18", {
			elicitation: {},
		}),
		true,
	);
});

test("cwd: the root or a directory below it; outside, symlink escapes, missing and files are refused", async () => {
	const { cwd, env } = await project();
	const outside = await realpath(await mkdtemp(join(tmpdir(), "aw-mcp-out-")));
	try {
		await writeProject(join(cwd, "nested"));
		await symlink(outside, join(cwd, "escape"));
		await writeFile(join(cwd, "file.txt"), "x");
		const client = await connect({ root: cwd, env });
		const ok = await client.call("workflow_validate", {
			workflow: "wf.json",
			cwd: "nested",
		});
		assert.equal(ok.isError, false, text(ok));
		assert.equal(ok.structuredContent.data.specPath, "wf.json");
		const absoluteInside = await client.call("workflow_validate", {
			workflow: "wf.json",
			cwd: join(cwd, "nested"),
		});
		assert.equal(absoluteInside.isError, false);
		const dot = await client.call("workflow_list", { cwd: "." });
		assert.equal(dot.isError, false);
		for (const [bad, pattern] of [
			["..", /outside the server's project root/],
			[outside, /outside the server's project root/],
			["escape", /outside the server's project root/],
			["nested/../..", /outside the server's project root/],
			["missing", /does not exist/],
			["file.txt", /is not a directory/],
			["", /cwd must be a non-empty string/],
		]) {
			const refused = await client.call("workflow_status", { cwd: bad });
			assert.equal(refused.isError, true, bad);
			assert.match(text(refused), pattern, bad);
			assert.equal(refused.structuredContent.error.kind, "usage");
		}
		// A run launched with cwd lives in that directory's run store.
		const executor = fixture();
		const launched = await client.call("workflow_run", {
			workflow: "wf.json",
			task: "nested run",
			executor,
			detach: false,
			cwd: "nested",
		});
		const runId = launched.structuredContent.data.runId;
		await waitLoop(client, runId, { cwd: "nested" });
		const rootStatus = await client.call("workflow_status", { runId });
		assert.equal(rootStatus.isError, true, "not in the root's run store");
		const nestedStatus = await client.call("workflow_status", {
			runId,
			cwd: "nested",
		});
		assert.equal(nestedStatus.structuredContent.data.run.status, "completed");
	} finally {
		await rm(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("usage and handler errors are isError tool results; protocol errors are JSON-RPC errors", async () => {
	const { cwd, env } = await project();
	await writeFile(
		join(cwd, "bad.json"),
		JSON.stringify({ schemaVersion: 1, name: "bad", artifactGraph: {} }),
	);
	const client = await connect({ root: cwd, env });
	for (const [name, args, pattern] of [
		["workflow_list", { bogus: 1 }, /unknown parameter bogus/],
		["workflow_list", { limit: 0 }, /limit must be an integer from 1 to 20/],
		["workflow_run", { workflow: "wf.json" }, /task is required/],
		["workflow_run", { task: "t" }, /workflow is required/],
		[
			"workflow_run",
			{ workflow: "wf.json", task: "t", permissionMode: "yolo" },
			/permissionMode/,
		],
		[
			"workflow_run",
			{ workflow: "wf.json", task: "t", effort: "max!" },
			/effort|thinking/i,
		],
		[
			"workflow_run",
			{ workflow: "wf.json", task: "t", inputs: [1] },
			/inputs must be an object/,
		],
		[
			"workflow_run",
			{ workflow: "wf.json", task: "t", detach: "yes" },
			/detach must be a boolean/,
		],
		[
			"workflow_run",
			{ workflow: "wf.json", task: "t", inputs: { nope: 1 } },
			/input nope is not declared/,
		],
		["workflow_dynamic", { task: "  " }, /task must be a non-empty string/],
		["workflow_wait", {}, /runId is required/],
		[
			"workflow_wait",
			{ runId: "x", timeoutMs: "1" },
			/timeoutMs must be a number/,
		],
		[
			"workflow_inspect",
			{ runId: "r", failures: 1 },
			/failures must be a boolean/,
		],
		["workflow_stop", {}, /runId is required/],
		["workflow_validate", {}, /workflow is required/],
	]) {
		const result = await client.call(name, args);
		assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
		assert.match(text(result), /^Usage error: /);
		assert.match(text(result), pattern, `${name} ${JSON.stringify(args)}`);
		assert.equal(result.structuredContent.ok, false);
		assert.equal(result.structuredContent.error.kind, "usage");
	}
	const invalid = await client.call("workflow_validate", {
		workflow: "bad.json",
	});
	assert.equal(invalid.isError, true);
	assert.equal(invalid.structuredContent.error.kind, "validation");
	assert.match(text(invalid), /Workflow validation failed/);
	const missing = await client.call("workflow_status", {
		runId: "workflow_missing",
	});
	assert.equal(missing.isError, true);
	assert.equal(missing.structuredContent.error.kind, "error");

	const unknown = await client.request("tools/call", {
		name: "workflow_bogus",
		arguments: {},
	});
	assert.equal(unknown.error.code, -32602);
	assert.match(unknown.error.message, /Unknown tool: workflow_bogus/);
	const arrayArgs = await client.request("tools/call", {
		name: "workflow_list",
		arguments: [1],
	});
	assert.equal(arrayArgs.error.code, -32602);
	assert.equal((await client.request("bogus/method")).error.code, -32601);
});

test("worker-role processes may only validate (role check of the host API)", async () => {
	const { cwd, env } = await project();
	const client = await connect({
		root: cwd,
		env: { ...env, AGENT_WORKFLOW_ROLE: "worker" },
	});
	const listed = await client.call("workflow_list", {});
	assert.equal(listed.isError, true);
	const validated = await client.call("workflow_validate", {
		workflow: "wf.json",
	});
	assert.equal(validated.isError, false, text(validated));
});
