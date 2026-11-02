// ACP executor pilot (design note acp-pilot-20261102): the adapter against a scripted ACP v1 agent
// (test/fixtures/executors/acp/fake-acp-agent.mjs). No agent CLI, no model call.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	acpPromptText,
	antigravityLaunchEnv,
	authenticateAcpAgent,
	createAcpExecutor,
	parseAcpConfig,
	replayAcpLog,
	selectPermissionOption,
} from "../../dist/executors/acp/index.js";
import { drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	validateEventSequence,
	validateExecEvent,
} from "../../dist/sdk/index.js";

const FAKE_AGENT = fileURLToPath(
	new URL("../fixtures/executors/acp/fake-acp-agent.mjs", import.meta.url),
);
const SECRET = "acp-secret-5c1d9e7a33";

async function setup(t, scenario) {
	const dir = await mkdtemp(join(tmpdir(), "aw-acp-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const command = join(dir, "fake-agent");
	const logFile = join(dir, "agent-log.jsonl");
	await writeFile(
		command,
		`#!/bin/sh\nFAKE_ACP_SCENARIO=${scenario} FAKE_ACP_LOG=${JSON.stringify(logFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@"\n`,
		{ mode: 0o755 },
	);
	const config = parseAcpConfig({
		preset: "gemini",
		command,
		stateDir: join(dir, "state"),
		killGraceMs: 200,
		handshakeTimeoutMs: 5_000,
	});
	const executor = createAcpExecutor({ config });
	const agentLog = async () =>
		(await readFile(logFile, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return { dir, command, config, executor, agentLog };
}

function request(dir, attemptKey, overrides = {}) {
	return {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd: dir,
		prompt: "Say hello.",
		systemPrompt: "You are a workflow worker.",
		tools: ["read"],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: { AGENT_WORKFLOW_ROLE: "worker" },
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		permissionMode: "free",
		artifactsDir: join(dir, "artifacts", attemptKey),
		...overrides,
	};
}

function checkSequence(events) {
	for (const event of events)
		assert.deepEqual(validateExecEvent(event), [], JSON.stringify(event));
	assert.deepEqual(validateEventSequence(events), []);
}

test("acp: a prompt streams text, tool reports and usage, then completes", async (t) => {
	const { dir, executor, agentLog } = await setup(t, "complete");
	const ref = await executor.submit(
		request(dir, "acp-complete-1", {
			mcpServers: [
				{
					name: "workflow_artifact",
					command: "/bin/echo",
					args: ["x"],
					env: { ARTIFACT_TOKEN: SECRET },
				},
			],
		}),
	);
	assert.equal(ref.executorId, "gemini");
	const { events, terminal } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	checkSequence(events);
	assert.equal(terminal.type, "completed");
	assert.equal(terminal.finalText, "Hello world");
	assert.deepEqual(
		events.filter((e) => e.type === "message_delta").map((e) => e.text),
		["Hello ", "world"],
	);
	const tools = events.filter((e) => e.type === "tool_call");
	assert.deepEqual(
		tools.map((e) => [e.name, e.kind, e.status]),
		[
			["ReadFile a.ts", "read", "running"],
			["ReadFile a.ts", "read", "completed"],
		],
	);
	// No raw fields from this agent: display fields stand in (design note D5/D6).
	assert.deepEqual(tools[1].input, {
		title: "ReadFile a.ts",
		locations: [{ path: "/x/a.ts", line: 3 }],
	});
	assert.equal(tools[1].output, "file text");
	const usage = events.find((e) => e.type === "usage");
	assert.deepEqual(
		{
			input: usage.input,
			cached: usage.cached,
			output: usage.output,
			cost: usage.cost,
			source: usage.source,
		},
		{ input: 60, cached: 40, output: 25, cost: null, source: "unknown" },
	);

	const log = await agentLog();
	const argv = log[0].argv;
	assert.deepEqual(argv, [
		"--acp",
		"--allowed-mcp-server-names",
		"workflow_artifact",
		"--approval-mode",
		"plan",
	]);
	// The request env reaches the agent (on top of the inherited environment).
	assert.ok(
		log[0].envKeys.includes("AGENT_WORKFLOW_ROLE"),
		JSON.stringify(log[0].envKeys),
	);
	const session = log.find((entry) => entry.method === "session/new");
	assert.equal(session.cwd, dir);
	assert.equal(session.meta, undefined, "the gemini preset sends no _meta");
	assert.deepEqual(session.mcpServers, [
		{
			name: "workflow_artifact",
			command: "/bin/echo",
			args: ["x"],
			envNames: ["ARTIFACT_TOKEN"],
		},
	]);
	const prompt = log.find((entry) => entry.method === "session/prompt");
	assert.equal(
		prompt.text,
		acpPromptText({
			prompt: "Say hello.",
			systemPrompt: "You are a workflow worker.",
		}),
	);
	// The MCP env value reaches the agent only on the wire, never the adapter's files.
	const artifacts = join(dir, "artifacts", "acp-complete-1");
	for (const name of [
		"acp-invocation.json",
		"acp-stream.jsonl",
		"acp-stderr.log",
	])
		assert.ok(
			!(await readFile(join(artifacts, name), "utf8")).includes(SECRET),
			name,
		);
});

test("acp: launch flags follow readOnly and the permission mode; no engine server still isolates", async (t) => {
	const { dir, executor, agentLog } = await setup(t, "complete");
	const write = await executor.submit(
		request(dir, "acp-flags-1", { readOnly: false, model: "gemini-3.5-flash" }),
	);
	await drain(executor, write, { timeoutMs: 15_000 });
	const safe = await executor.submit(
		request(dir, "acp-flags-2", { readOnly: false, permissionMode: "safe" }),
	);
	await drain(executor, safe, { timeoutMs: 15_000 });
	const argvs = (await agentLog())
		.filter((entry) => entry.argv)
		.map((entry) => entry.argv);
	assert.deepEqual(argvs, [
		[
			"--acp",
			"--model",
			"gemini-3.5-flash",
			"--allowed-mcp-server-names",
			"agent-workflow-none",
			"--approval-mode",
			"yolo",
		],
		[
			"--acp",
			"--allowed-mcp-server-names",
			"agent-workflow-none",
			"--approval-mode",
			"default",
		],
	]);
});

test("acp: raw tool input/output are kept when the agent sends them", async (t) => {
	const { dir, executor } = await setup(t, "raw");
	const ref = await executor.submit(request(dir, "acp-raw-1"));
	const { events, terminal } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	assert.equal(terminal.type, "completed");
	const done = events.filter((e) => e.type === "tool_call").at(-1);
	assert.deepEqual(done.input, { path: "a.ts" });
	assert.deepEqual(done.output, { content: "1: line" });
});

test("acp: permission requests go through respond(); allow picks allow_once, deny reject_once", async (t) => {
	const { dir, executor, agentLog } = await setup(t, "permission");
	for (const [key, decision, expected] of [
		["acp-perm-allow", "allow", "proceed_once"],
		["acp-perm-deny", "deny", "cancel"],
	]) {
		const ref = await executor.submit(
			request(dir, key, { readOnly: false, permissionMode: "safe" }),
		);
		const { events, terminal } = await drain(executor, ref, {
			timeoutMs: 15_000,
			onApproval: async (event) => {
				assert.equal(event.kind, "edit");
				assert.equal(event.detail, "WriteFile b.ts");
				assert.equal(
					await executor.respond(ref, event.requestId, decision),
					"accepted",
				);
				assert.equal(
					await executor.respond(ref, event.requestId, decision),
					"too_late",
				);
			},
		});
		checkSequence(events);
		assert.equal(terminal.type, "completed");
		assert.equal(terminal.finalText, `permission: ${expected}`);
		const last = events.filter((e) => e.type === "tool_call").at(-1);
		assert.equal(last.status, decision === "allow" ? "completed" : "denied");
	}
	const answers = (await agentLog())
		.filter((entry) => entry.permissionAnswer)
		.map((e) => e.permissionAnswer);
	assert.deepEqual(answers, [
		{ outcome: { outcome: "selected", optionId: "proceed_once" } },
		{ outcome: { outcome: "selected", optionId: "cancel" } },
	]);
	assert.equal(
		selectPermissionOption([{ optionId: "a", kind: "allow_always" }], "allow"),
		undefined,
	);
});

test("acp: an unanswered permission request is denied after the policy timeout", async (t) => {
	const { dir, executor } = await setup(t, "permission");
	const ref = await executor.submit(
		request(dir, "acp-perm-timeout", {
			readOnly: false,
			permissionMode: "safe",
			approvalPolicy: defaultApprovalPolicy({ timeoutMs: 100 }),
		}),
	);
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.finalText, "permission: cancel");
});

test("acp: cancel sends session/cancel and ends as cancelled", async (t) => {
	const { dir, executor, agentLog } = await setup(t, "hang");
	const ref = await executor.submit(request(dir, "acp-cancel-1"));
	const { terminal, events } = await drain(executor, ref, {
		timeoutMs: 15_000,
		onApproval: async () => {},
		until: (event) => event.type === "message_delta",
	});
	assert.equal(terminal, undefined);
	assert.equal(events.at(-1).text, "working");
	assert.equal(await executor.cancel(ref, "turn"), "cancelled");
	const end = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(end.terminal.type, "failed");
	assert.equal(end.terminal.class, "cancelled");
	assert.ok(
		(await agentLog()).some((entry) => entry.method === "session/cancel"),
	);
	assert.equal(await executor.cancel(ref, "turn"), "too_late");
});

test("acp: a prompt error is classified; the agent's fs requests are refused", async (t) => {
	const failing = await setup(t, "error");
	const ref = await failing.executor.submit(
		request(failing.dir, "acp-error-1"),
	);
	const { terminal } = await drain(failing.executor, ref, {
		timeoutMs: 15_000,
	});
	assert.equal(terminal.type, "failed");
	assert.equal(terminal.class, "auth");
	assert.match(terminal.message, /Authentication required/);

	const fs = await setup(t, "fs");
	const fsRef = await fs.executor.submit(request(fs.dir, "acp-fs-1"));
	const done = await drain(fs.executor, fsRef, { timeoutMs: 15_000 });
	assert.equal(done.terminal.type, "completed");
	assert.match(done.terminal.finalText, /^fs: /);
	const refused = (await fs.agentLog()).find((entry) => entry.responseError);
	assert.equal(refused.responseError.code, -32601);
});

test("acp: an agent that dies mid-prompt fails; request env values are redacted from logs", async (t) => {
	const crash = await setup(t, "crash");
	const ref = await crash.executor.submit(request(crash.dir, "acp-crash-1"));
	const { terminal } = await drain(crash.executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "failed");
	assert.notEqual(terminal.class, "cancelled");

	const secret = await setup(t, "secret");
	const secretRef = await secret.executor.submit(
		request(secret.dir, "acp-secret-1", {
			env: { AGENT_WORKFLOW_ROLE: "worker", ECHO_SECRET: SECRET },
		}),
	);
	const done = await drain(secret.executor, secretRef, { timeoutMs: 15_000 });
	assert.equal(done.terminal.type, "completed");
	const artifacts = join(secret.dir, "artifacts", "acp-secret-1");
	for (const name of ["acp-stream.jsonl", "acp-stderr.log"]) {
		const text = await readFile(join(artifacts, name), "utf8");
		assert.ok(!text.includes(SECRET), name);
		assert.match(text, /<redacted:ECHO_SECRET>/);
	}
});

test("acp: submit is idempotent; another instance reconciles and replays from the durable record", async (t) => {
	const { dir, config, executor, agentLog } = await setup(t, "complete");
	const req = request(dir, "acp-durable-1");
	const [a, b] = await Promise.all([
		executor.submit(req),
		executor.submit(req),
	]);
	assert.deepEqual(a, b);
	await drain(executor, a, { timeoutMs: 15_000 });
	assert.deepEqual(await executor.submit(req), a);
	assert.equal((await agentLog()).filter((entry) => entry.argv).length, 1);

	const fresh = createAcpExecutor({ config });
	assert.deepEqual(await fresh.reconcile("acp-durable-1"), { found: a });
	assert.deepEqual(await fresh.reconcile("acp-never-launched"), {
		absent: true,
	});
	const replayed = await drain(fresh, a, { timeoutMs: 5_000 });
	assert.equal(replayed.terminal.type, "completed");
	assert.equal(replayed.terminal.finalText, "Hello world");
	assert.equal(await fresh.cancel(a, "turn"), "uncertain");
	const raw = (
		await readFile(
			join(dir, "artifacts", "acp-durable-1", "acp-stream.jsonl"),
			"utf8",
		)
	).split("\n");
	assert.equal(replayAcpLog(raw).settled, true);
});

test("acp: probe reads the version; a missing agent is not installed", async (t) => {
	const { executor, config } = await setup(t, "complete");
	const probe = await executor.probe();
	assert.equal(probe.installed, true);
	assert.equal(probe.cliVersion, "0.99.0");
	assert.equal(probe.auth, "unknown");
	const missing = createAcpExecutor({
		config: { ...config, command: join(config.stateDir, "no-such-agent") },
	});
	assert.equal((await missing.probe()).installed, false);
	assert.equal(executor.capabilities().mcpInjection.level, "native");
	assert.equal(executor.capabilities().contextIsolation.level, "none");
	assert.throws(() => parseAcpConfig({ preset: "nope" }), /unknown preset/);
});

test("acp: a readOnly request that injects a server other than the artifact server is refused before any effect", async (t) => {
	const { dir, executor, agentLog } = await setup(t, "complete");
	const gate = createAuthorityGate({ attemptKey: "acp-foreign-1" });
	await assert.rejects(
		executor.submit({
			...request(dir, "acp-foreign-1"),
			authority: gate.authority,
			mcpServers: [{ name: "other", command: "/bin/echo", args: [] }],
		}),
		/may mutate \(other\)/,
	);
	assert.deepEqual(await agentLog(), []);
	assert.deepEqual(await executor.reconcile("acp-foreign-1"), { absent: true });
});

test("acp antigravity preset: no launch flags; mode, model and effort are set on the session; an unknown model is refused", async (t) => {
	const { dir, command, agentLog } = await setup(t, "complete");
	const config = parseAcpConfig({
		preset: "antigravity",
		command,
		stateDir: join(dir, "agy-state"),
		killGraceMs: 200,
		handshakeTimeoutMs: 5_000,
	});
	const executor = createAcpExecutor({ config });
	assert.equal(executor.id, "antigravity");
	const readOnly = await executor.submit(
		request(dir, "agy-1", { model: "fake-model-b", effort: "xhigh" }),
	);
	assert.equal(
		(await drain(executor, readOnly, { timeoutMs: 15_000 })).terminal.type,
		"completed",
	);
	const writing = await executor.submit(
		request(dir, "agy-2", { readOnly: false }),
	);
	assert.equal(
		(await drain(executor, writing, { timeoutMs: 15_000 })).terminal.type,
		"completed",
	);
	const log = await agentLog();
	assert.deepEqual(
		log.filter((entry) => entry.argv).map((entry) => entry.argv),
		process.platform === "linux" ? [["--uid="], ["--uid="]] : [[], []],
	);
	// Built-in run_workflow/schedule are disabled per session (no startup SKILL.md write, no agents
	// or timers outside the engine).
	assert.deepEqual(
		log
			.filter((entry) => entry.method === "session/new")
			.map((entry) => entry.meta),
		[
			{
				agy: {
					disabledTools: [
						"run_workflow",
						"schedule",
						"invoke_subagent",
						"define_subagent",
						"send_message",
					],
				},
			},
			{
				agy: {
					disabledTools: [
						"run_workflow",
						"schedule",
						"invoke_subagent",
						"define_subagent",
						"send_message",
					],
				},
			},
		],
	);
	assert.deepEqual(
		log
			.filter(
				(entry) => entry.method?.startsWith("session/set_") && entry.params,
			)
			.map((entry) => [entry.method, entry.params]),
		[
			["session/set_mode", { sessionId: "fake-session-1", modeId: "default" }],
			[
				"session/set_config_option",
				{
					sessionId: "fake-session-1",
					configId: "model",
					value: "fake-model-b",
				},
			],
			[
				"session/set_config_option",
				{
					sessionId: "fake-session-1",
					configId: "thinking_level",
					value: "high",
				},
			],
			["session/set_mode", { sessionId: "fake-session-1", modeId: "yolo" }],
		],
	);
	const unknown = await executor.submit(
		request(dir, "agy-3", { model: "gemini-9" }),
	);
	const failed = await drain(executor, unknown, { timeoutMs: 15_000 });
	assert.equal(failed.terminal.type, "failed");
	assert.equal(failed.terminal.class, "config");
	assert.match(
		failed.terminal.message,
		/invalid model gemini-9 for antigravity; offered: fake-model-a, fake-model-b/,
	);
	// Probe through ACP initialize (agentInfo.version); no session, no model.
	const probe = await executor.probe();
	assert.equal(probe.installed, true);
	assert.equal(probe.cliVersion, "9.9.9");
	assert.equal(executor.capabilities().contextIsolation.level, "emulated");
});

test("acp antigravity: workers run in the engine-owned GEMINI_HOME unless they inherit; login is recorded there", async (t) => {
	const { dir, command, agentLog } = await setup(t, "complete");
	const config = parseAcpConfig({
		preset: "antigravity",
		command,
		stateDir: join(dir, "agy-state"),
		killGraceMs: 200,
		handshakeTimeoutMs: 5_000,
	});
	assert.equal(config.agentHome, join(dir, "agy-state", "antigravity-home"));
	const executor = createAcpExecutor({ config });
	// No login recorded in the worker home yet: auth missing, with the way to log in.
	const before = await executor.probe();
	assert.equal(before.auth, "missing");
	assert.ok(before.notes.some((note) => note.includes("authenticateAcpAgent")));
	const lines = [];
	await authenticateAcpAgent(
		config,
		"oauth-personal",
		(line) => lines.push(line),
		10_000,
	);
	assert.ok(
		lines.some((line) => line.includes("https://example.invalid/login")),
	);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(config.agentHome, "antigravity-acp"), { recursive: true });
	await writeFile(
		join(config.agentHome, "antigravity-acp", "settings.json"),
		JSON.stringify({ auth: { type: "oauth-personal" } }),
	);
	assert.equal((await executor.probe()).auth, "ok");

	const isolated = await executor.submit(request(dir, "agy-home-1"));
	await drain(executor, isolated, { timeoutMs: 15_000 });
	const inherited = await executor.submit(
		request(dir, "agy-home-2", { isolation: { inherit: true } }),
	);
	await drain(executor, inherited, { timeoutMs: 15_000 });
	const homes = (await agentLog())
		.filter((entry) => entry.argv)
		.map((entry) => entry.geminiHome);
	// probe ×2 and the login launch also ran in the worker home; the inheriting attempt did not.
	assert.equal(homes.at(-2), config.agentHome);
	assert.equal(homes.at(-1), process.env.GEMINI_HOME ?? null);
	assert.ok(
		(await agentLog()).some((entry) => entry.method === "authenticate"),
	);
});

test("acp antigravity: held MCP summaries get the transcript results; shell rawOutput stays; replay releases the same", async (t) => {
	const { dir, command } = await setup(t, "agy_transcript");
	const config = parseAcpConfig({
		preset: "antigravity",
		command,
		stateDir: join(dir, "agy-state"),
		killGraceMs: 200,
		handshakeTimeoutMs: 5_000,
	});
	const executor = createAcpExecutor({ config });
	const mcpServers = [{ name: "aw_stub", command: "/bin/echo", args: ["x"] }];
	const ref = await executor.submit(
		request(dir, "agy-tr-1", { mcpServers, readOnly: false }),
	);
	const { events, terminal } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	assert.equal(terminal.type, "completed");
	checkSequence(events);
	const closing = (id) =>
		events.filter(
			(e) =>
				e.type === "tool_call" && e.callId === id && e.status === "completed",
		);
	// One closing report per call: the summary is never emitted as an output.
	for (const id of ["t1", "t2", "t3", "t4"])
		assert.equal(closing(id).length, 1, id);
	assert.equal(closing("t1")[0].output, "hi-result");
	assert.equal(closing("t2")[0].output, `big ${"x".repeat(5000)}`);
	assert.deepEqual(closing("t3")[0].output, {
		combinedOutput: "1\n2\n3\n",
		exitCode: 0,
	});
	// A saved-file path outside the session is not read: the notice stays as the text.
	assert.equal(
		closing("t4")[0].output,
		"The output was large and was saved to: file:///etc/hosts",
	);
	const raw = (
		await readFile(
			join(dir, "artifacts", "agy-tr-1", "acp-stream.jsonl"),
			"utf8",
		)
	).split("\n");
	const replayed = replayAcpLog(raw).events.filter(
		(e) => e.type === "tool_call" && e.status === "completed",
	);
	assert.deepEqual(
		replayed.map((e) => [e.callId, e.output]),
		events
			.filter((e) => e.type === "tool_call" && e.status === "completed")
			.map((e) => [e.callId, e.output]),
	);

	// Inheriting the user's home: no transcript is read, the summary stays as it was reported.
	const inherited = await executor.submit(
		request(dir, "agy-tr-2", {
			mcpServers,
			readOnly: false,
			isolation: { inherit: true },
		}),
	);
	const second = await drain(executor, inherited, { timeoutMs: 15_000 });
	assert.equal(
		second.events.find(
			(e) =>
				e.type === "tool_call" && e.callId === "t1" && e.status === "completed",
		).output,
		"Echo tool",
	);
});

test("acp antigravity: inherited account/project variables are dropped for an isolated worker; a quota answer fails", async (t) => {
	const { dir, command, agentLog } = await setup(t, "agy_quota");
	const saved = {
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
		AGY_ACP_TEST: process.env.AGY_ACP_TEST,
	};
	process.env.GEMINI_API_KEY = "fake-key-not-used";
	process.env.GOOGLE_CLOUD_PROJECT = "fake-project";
	process.env.AGY_ACP_TEST = "1";
	t.after(() => {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});
	const config = parseAcpConfig({
		preset: "antigravity",
		command,
		stateDir: join(dir, "agy-state"),
		killGraceMs: 200,
		handshakeTimeoutMs: 5_000,
	});
	const executor = createAcpExecutor({ config });
	const ref = await executor.submit(request(dir, "agy-env-1"));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "failed");
	assert.equal(terminal.class, "rate_limit");
	assert.match(
		terminal.message,
		/usage limit reached: Your quota resets in 3 days/i,
	);
	const invocation = JSON.parse(
		await readFile(
			join(dir, "artifacts", "agy-env-1", "acp-invocation.json"),
			"utf8",
		),
	);
	assert.deepEqual(invocation.envRemoved, [
		"AGY_ACP_TEST",
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_PROJECT",
	]);
	const inherited = await executor.submit(
		request(dir, "agy-env-2", { isolation: { inherit: true } }),
	);
	await drain(executor, inherited, { timeoutMs: 15_000 });
	const launches = (await agentLog()).filter((e) => e.argv);
	assert.deepEqual(launches.at(-2).blockedPresent, []);
	assert.deepEqual(launches.at(-1).blockedPresent, [
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_PROJECT",
		"AGY_ACP_TEST",
	]);
});

test("acp antigravity: the server path can come from AGENT_WORKFLOW_AGY_ACP_SERVER; a symlinked server gets its harness path", async (t) => {
	const { mkdir, symlink } = await import("node:fs/promises");
	const dir = await mkdtemp(join(tmpdir(), "aw-agy-cmd-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const saved = process.env.AGENT_WORKFLOW_AGY_ACP_SERVER;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_WORKFLOW_AGY_ACP_SERVER;
		else process.env.AGENT_WORKFLOW_AGY_ACP_SERVER = saved;
	});
	delete process.env.AGENT_WORKFLOW_AGY_ACP_SERVER;
	assert.equal(
		parseAcpConfig({ preset: "antigravity" }).command,
		"agy_acp_server",
	);
	process.env.AGENT_WORKFLOW_AGY_ACP_SERVER = "/opt/agy/agy_acp_server.par";
	assert.equal(
		parseAcpConfig({ preset: "antigravity" }).command,
		"/opt/agy/agy_acp_server.par",
	);
	// An explicit config command wins; the gemini preset ignores the variable.
	assert.equal(
		parseAcpConfig({ preset: "antigravity", command: "/x/agy" }).command,
		"/x/agy",
	);
	assert.equal(parseAcpConfig({ preset: "gemini" }).command, "gemini");

	const install = join(dir, "install");
	await mkdir(install);
	await writeFile(join(install, "agy_acp_server.par"), "", { mode: 0o755 });
	await writeFile(join(install, "localharness_external"), "", { mode: 0o755 });
	const bin = join(dir, "bin");
	await mkdir(bin);
	await symlink(
		join(install, "agy_acp_server.par"),
		join(bin, "agy_acp_server"),
	);
	const { realpath } = await import("node:fs/promises");
	const harness = join(await realpath(install), "localharness_external");
	assert.deepEqual(await antigravityLaunchEnv(join(bin, "agy_acp_server")), {
		ANTIGRAVITY_HARNESS_PATH: harness,
	});
	assert.deepEqual(
		await antigravityLaunchEnv(
			join(await realpath(install), "agy_acp_server.par"),
		),
		{},
	);
	const path = process.env.PATH;
	t.after(() => {
		process.env.PATH = path;
	});
	process.env.PATH = `${bin}:${path}`;
	assert.deepEqual(await antigravityLaunchEnv("agy_acp_server"), {
		ANTIGRAVITY_HARNESS_PATH: harness,
	});
	assert.deepEqual(await antigravityLaunchEnv("not-there-agy"), {});
});
