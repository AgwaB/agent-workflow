// WP6: Pi executor adapter units — argv, tool mapping, readOnly, isolation, MCP/secret plumbing,
// sessions (D3), Pi-only options, probe parsing, the per-run extension, fresh-process replay.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
	applyFastServiceTier,
	buildPiArgv,
	createExecutor,
	PI_EXECUTOR_TOOL_MAPPING,
	PI_RUN_SECRETS_ENV,
	parsePiExecutorConfig,
	parsePiModelList,
	parsePiWebAccessPath,
	piCapabilities,
	piMcpServerPattern,
	piMcpToolName,
	readOnlyTools,
} from "../../dist/executors/pi/index.js";
import { registerPiRun } from "../../dist/executors/pi/run-extension.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	isSdkError,
	mapTools,
	validateCapabilities,
} from "../../dist/sdk/index.js";
import {
	loadTranscript,
	PI_MODULE,
	PROBE_SCRIPTS,
	replaySteps,
} from "../fixtures/executors/pi/harness.mjs";

const execFileAsync = promisify(execFile);

async function stage(steps, extra = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-adapter-"));
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: [
			...PROBE_SCRIPTS,
			{ name: "run", when: { argvIncludes: ["--mode", "json"] }, steps },
		],
	});
	const config = {
		piCommand: cli.path,
		stateDir: join(dir, "state"),
		...extra,
	};
	return { dir, cli, config, executor: createExecutor(config) };
}

let counter = 0;
function request(overrides = {}) {
	counter += 1;
	const attemptKey =
		overrides.attemptKey ?? `pi-adapter-${process.pid}-${counter}`;
	const gate = createAuthorityGate({ attemptKey });
	return {
		gate,
		req: {
			attemptKey,
			authority: gate.authority,
			cwd: tmpdir(),
			prompt: "hello",
			tools: [],
			readOnly: true,
			mcpServers: [],
			deadlineMs: Date.now() + 60_000,
			env: {},
			isolation: { inherit: false },
			approvalPolicy: defaultApprovalPolicy(),
			...overrides,
		},
	};
}

async function drain(executor, ref) {
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	return events;
}

const completeSteps = async () =>
	replaySteps(await loadTranscript("complete-read"));

test("buildPiArgv: isolation flags, sessions, system prompt, model/thinking, tools", () => {
	const isolated = buildPiArgv({
		piCommand: "pi",
		isolated: true,
		systemPromptPath: "/r/sp.md",
		model: "google/gemini-2.5-flash-lite",
		thinking: "minimal",
		tools: ["read", "mcp__workflow_artifact__*"],
		extensions: ["/r/pi-extension.mjs"],
	});
	assert.deepEqual(isolated, [
		"pi",
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--exclude-tools",
		"subagent",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-approve",
		"--system-prompt",
		"/r/sp.md",
		"--model",
		"google/gemini-2.5-flash-lite",
		"--thinking",
		"minimal",
		"--tools",
		"read,mcp__workflow_artifact__*",
		"-e",
		"/r/pi-extension.mjs",
	]);
	const inherit = buildPiArgv({
		piCommand: "pi",
		isolated: false,
		session: { dir: "/s/x", id: "x" },
		tools: [],
		extensions: [],
	});
	assert.deepEqual(inherit, [
		"pi",
		"--mode",
		"json",
		"--print",
		"--session-dir",
		"/s/x",
		"--session-id",
		"x",
		"--exclude-tools",
		"subagent",
		"--no-tools",
	]);
	const resume = buildPiArgv({
		piCommand: "pi",
		isolated: true,
		session: { dir: "/s/x", id: "x", resumePath: "/s/x/a.jsonl" },
		tools: ["read"],
		extensions: [],
	});
	assert.deepEqual(resume.slice(4, 8), [
		"--session-dir",
		"/s/x",
		"--session",
		"/s/x/a.jsonl",
	]);
});

test("tool mapping: identity for Pi tools, workflow_artifact via MCP, readOnly drops mutating tools", () => {
	const mapped = mapTools(
		[
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
			"web_search",
			"fetch_content",
			"workflow_artifact",
			"nope",
		],
		PI_EXECUTOR_TOOL_MAPPING,
	);
	assert.deepEqual(mapped.executorTools, [
		"read",
		"grep",
		"find",
		"ls",
		"bash",
		"edit",
		"write",
		"web_search",
		"fetch_content",
	]);
	assert.deepEqual(mapped.mcpTools, [
		{ server: "workflow_artifact", tool: "workflow_artifact" },
	]);
	assert.deepEqual(mapped.unmapped, ["nope"]);
	assert.equal(
		piMcpToolName("workflow_artifact", "workflow_artifact"),
		"mcp__workflow_artifact__workflow_artifact",
	);
	assert.equal(piMcpToolName("my-server", "a.b"), "mcp__my_server__a_b");
	assert.equal(
		piMcpServerPattern("workflow_artifact"),
		"mcp__workflow_artifact__*",
	);
	assert.deepEqual(
		readOnlyTools(["read", "bash", "edit", "write", "codemode", "grep"]),
		{
			kept: ["read", "grep"],
			dropped: ["bash", "edit", "write", "codemode"],
		},
	);
});

test("capabilities: valid table with honest sources; web safety never engine", () => {
	const caps = piCapabilities();
	assert.deepEqual(validateCapabilities(caps), []);
	assert.equal(caps.toolLoop, "agent");
	assert.equal(caps.sessionBound, true);
	assert.equal(caps.toolResultBudget.level, "native");
	assert.equal(caps.fastTier.source, "unverified");
	assert.equal(caps.nativeSchema.level, "none");
	assert.equal(caps.readOnly.level, "emulated");
	assert.notEqual(caps.webTools.safetyPolicy, "engine");
	assert.deepEqual(caps.effortLevels, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	for (const name of [
		"mcpInjection",
		"contextIsolation",
		"toolAllowlist",
		"resume",
		"cancel",
		"usage",
	])
		assert.match(caps[name].verifiedWith ?? "", /pi 1\.1\.0/u, name);
});

test("config: defaults, validation, refuses unknown keys", () => {
	assert.deepEqual(parsePiExecutorConfig(null), { piCommand: "pi" });
	assert.throws(
		() => parsePiExecutorConfig({ apiKey: "x" }),
		/unknown key apiKey/u,
	);
	assert.throws(
		() => parsePiExecutorConfig({ stateDir: "rel/dir" }),
		/absolute/u,
	);
	assert.throws(
		() => parsePiExecutorConfig({ toolResultBudget: { maxTotalChars: 0 } }),
		/toolResultBudget/u,
	);
	assert.deepEqual(
		parsePiExecutorConfig({
			fast: "on",
			fastApi: "openai-responses",
			inheritHostTools: true,
		}),
		{
			piCommand: "pi",
			fast: "on",
			fastApi: "openai-responses",
			inheritHostTools: true,
		},
	);
});

test("probe helpers: model list and pi-web-access discovery parse Pi's own output", () => {
	assert.deepEqual(
		parsePiModelList(
			"provider  model  context\ngoogle  gemini-2.5-flash-lite  1.0M\nopenai gpt-5-nano 400K\n",
		),
		["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"],
	);
	assert.equal(
		parsePiWebAccessPath(
			"User packages:\n  npm:pi-lens\n    /x/pi-lens\n  npm:pi-web-access@0.44.0\n    /x/node_modules/pi-web-access\n",
		),
		"/x/node_modules/pi-web-access",
	);
	assert.equal(parsePiWebAccessPath("User packages:\n"), null);
});

test("probe: version, models, auth via `pi auth check` (non-secret enum), limits; no effect", async () => {
	const { cli, executor } = await stage([], {
		authCheckModel: "google/gemini-2.5-flash-lite",
	});
	const probe = await executor.probe();
	assert.equal(probe.installed, true);
	assert.equal(probe.cliVersion, "1.1.0");
	assert.equal(probe.auth, "ok");
	assert.equal(probe.mcpOutputLimitChars, 20480);
	assert.equal(probe.mcpOutputNoticeChars, 1024);
	assert.deepEqual(probe.models, ["google/gemini-2.5-flash-lite"]);
	assert.equal(probe.webAccessExtension, null);
	assert.equal(probe.capabilities.webTools.level, "none");
	assert.equal(await cli.effectCount(), 0);
	const invocations = await cli.invocations();
	assert.ok(
		invocations.some(
			(entry) =>
				entry.argv.join(" ") ===
				"auth check --model google/gemini-2.5-flash-lite --json --no-refresh",
		),
	);
	assert.ok(!invocations.some((entry) => entry.argv.includes("--credentials")));
	const missing = createExecutor({ piCommand: "/nonexistent/pi-binary" });
	const absent = await missing.probe();
	assert.equal(absent.installed, false);
	assert.equal(absent.cliVersion, null);
});

test("submit: argv/tools/readOnly, prompt on stdin, extension per run, secrets off argv and disk, redaction", async () => {
	const secret = "s3cret-value-for-redaction";
	const mcpSecret = "mcp-secret-0123456789";
	const steps = [
		{
			stdout: JSON.stringify({
				type: "session",
				version: 3,
				id: "x",
				cwd: "/tmp",
			}),
		},
		{
			stdout: JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "bash",
				result: { content: [{ type: "text", text: `token=${secret}` }] },
				isError: false,
			}),
		},
		{
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
				},
			}),
		},
		{ stderr: `warning ${secret}` },
	];
	const { cli, executor, dir } = await stage(steps);
	const artifactsDir = join(dir, "attempt");
	const { req } = request({
		tools: ["read", "bash", "write", "workflow_artifact"],
		readOnly: true,
		systemPrompt: "be brief",
		model: "google/gemini-2.5-flash-lite",
		effort: "low",
		prompt: "the prompt goes to stdin",
		env: { MY_TOKEN: secret },
		mcpServers: [
			{
				name: "workflow_artifact",
				command: process.execPath,
				args: ["server.js", "--config", "/x.json"],
				env: { ART_TOKEN: mcpSecret },
			},
		],
		artifactsDir,
	});
	const ref = await executor.submit(req);
	const events = await drain(executor, ref);
	assert.equal(events.at(-1).type, "completed");
	const [launch] = await cli
		.invocations()
		.then((all) => all.filter((entry) => entry.effect));
	const argv = launch.argv;
	assert.equal(
		argv[argv.indexOf("--tools") + 1],
		"read,mcp__workflow_artifact__*",
	);
	assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
	assert.equal(
		argv[argv.indexOf("--system-prompt") + 1],
		join(artifactsDir, "pi-system-prompt.md"),
	);
	assert.equal(
		argv[argv.indexOf("-e") + 1],
		join(artifactsDir, "pi-extension.mjs"),
	);
	assert.ok(
		argv.includes("--no-context-files") && argv.includes("--no-extensions"),
	);
	assert.ok(
		!argv.includes("the prompt goes to stdin"),
		"prompt must not be on argv",
	);
	assert.ok(
		!argv.some((arg) => arg.includes(secret) || arg.includes(mcpSecret)),
	);
	assert.ok(launch.envKeys.includes(PI_RUN_SECRETS_ENV));
	assert.ok(launch.envKeys.includes("MY_TOKEN"));
	assert.ok(launch.envKeys.includes("PI_SKIP_VERSION_CHECK"));
	for (const name of await readdir(artifactsDir)) {
		const text = await readFile(join(artifactsDir, name), "utf8");
		assert.ok(
			!text.includes(secret) && !text.includes(mcpSecret),
			`${name} leaks a secret`,
		);
	}
	assert.match(
		await readFile(join(artifactsDir, "pi-stdout.jsonl"), "utf8"),
		/token=\[redacted\]/u,
	);
	assert.match(
		await readFile(join(artifactsDir, "pi-stderr.log"), "utf8"),
		/warning \[redacted\]/u,
	);
	const tool = events.find((event) => event.type === "tool_call");
	assert.equal(tool.output, "token=[redacted]");
	const extension = await readFile(
		join(artifactsDir, "pi-extension.mjs"),
		"utf8",
	);
	assert.match(extension, /createMcpExtension/u);
	assert.match(extension, /"envKeys":\["ART_TOKEN"\]/u);
});

test("permission mode (WP4e): Pi has no approvals or sandbox, so free and safe launch the same argv; readOnly drops mutating tools in both", async () => {
	const launched = [];
	for (const [permissionMode, readOnly] of [
		["free", false],
		["safe", false],
		[undefined, false],
		["free", true],
		["safe", true],
	]) {
		const { cli, executor, dir } = await stage(await completeSteps());
		const { req } = request({
			tools: ["read", "bash", "edit"],
			readOnly,
			...(permissionMode === undefined ? {} : { permissionMode }),
			artifactsDir: join(dir, "attempt"),
		});
		const ref = await executor.submit(req);
		assert.equal((await drain(executor, ref)).at(-1).type, "completed");
		const [launch] = (await cli.invocations()).filter((entry) => entry.effect);
		// The per-run extension path differs by attempt dir; compare everything else.
		const argv = launch.argv.map((arg) =>
			arg.startsWith(dir) ? "<attempt>" : arg,
		);
		launched.push({ readOnly, argv });
	}
	const writable = launched.filter((entry) => !entry.readOnly);
	for (const entry of writable) assert.deepEqual(entry.argv, writable[0].argv);
	assert.equal(
		writable[0].argv[writable[0].argv.indexOf("--tools") + 1],
		"read,bash,edit",
	);
	const readOnly = launched.filter((entry) => entry.readOnly);
	assert.deepEqual(readOnly[0].argv, readOnly[1].argv);
	assert.equal(
		readOnly[0].argv[readOnly[0].argv.indexOf("--tools") + 1],
		"read",
	);
});

test("submit: refusals happen before consume (no effect); session ids validated", async () => {
	const { executor, cli } = await stage(await completeSteps());
	const cases = [
		[{ tools: ["telepathy"] }, "CAPABILITY_MISSING"],
		[{ tools: ["workflow_artifact"] }, "CAPABILITY_MISSING"],
		[{ effort: "ultra" }, "INVALID_REQUEST"],
		[{ sessionId: "-bad id-" }, "INVALID_REQUEST"],
		[{ resumeSessionId: "never-kept" }, "INVALID_REQUEST"],
		[{ sessionId: "a", resumeSessionId: "b" }, "INVALID_REQUEST"],
	];
	for (const [overrides, code] of cases) {
		const { req, gate } = request(overrides);
		await assert.rejects(executor.submit(req), (error) =>
			isSdkError(error, code),
		);
		assert.equal(gate.state(), "pending", JSON.stringify(overrides));
		assert.deepEqual(await executor.reconcile(req.attemptKey), {
			absent: true,
		});
	}
	assert.equal(await cli.effectCount(), 0);
	const fast = createExecutor({ piCommand: "pi", fast: "on" });
	const { req, gate } = request({ model: "google/gemini-2.5-flash-lite" });
	await assert.rejects(
		fast.submit(req),
		(error) =>
			isSdkError(error, "INVALID_REQUEST") && /fast:on/u.test(error.message),
	);
	assert.equal(gate.state(), "pending");
});

test("Pi-only options: fast tier, tool-result budget, inheritHostTools go into the per-run extension/argv", async () => {
	const { executor, cli, dir } = await stage(await completeSteps(), {
		fast: "on",
		fastApi: "openai-responses",
		toolResultBudget: { maxTotalChars: 1000 },
		inheritHostTools: true,
	});
	const artifactsDir = join(dir, "attempt");
	const { req } = request({
		model: "openai/gpt-5.5",
		tools: ["read"],
		readOnly: false,
		artifactsDir,
	});
	await drain(executor, await executor.submit(req));
	const extension = await readFile(
		join(artifactsDir, "pi-extension.mjs"),
		"utf8",
	);
	const config = JSON.parse(/^const config = (.*);$/mu.exec(extension)[1]);
	assert.deepEqual(config.fastTier, {
		provider: "openai",
		model: "gpt-5.5",
		api: "openai-responses",
		serviceTier: "priority",
	});
	assert.deepEqual(config.toolResultBudget, {
		maxTotalChars: 1000,
		statePath: join(artifactsDir, "tool-result-budget.json"),
	});
	assert.equal(config.privateMcp, false);
	const [launch] = (await cli.invocations()).filter((entry) => entry.effect);
	assert.equal(
		launch.argv[launch.argv.indexOf("--tools") + 1],
		"read,codemode,tool_search,mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
	);
	for (const builtin of [
		"builtin:mcp",
		"builtin:codemode",
		"builtin:tool-search",
	])
		assert.ok(launch.argv.includes(builtin), builtin);
	// readOnly ignores inheritHostTools (codemode could reach mutating tools).
	const { req: ro } = request({
		model: "openai/gpt-5.5",
		tools: ["read"],
		readOnly: true,
	});
	await drain(executor, await executor.submit(ro));
	const second = (await cli.invocations()).filter((entry) => entry.effect)[1];
	assert.equal(second.argv[second.argv.indexOf("--tools") + 1], "read");
	assert.ok(!second.argv.includes("builtin:mcp"));
});

test("durable binding env: agent-workflow name always, legacy Pi name only when the worker inherits extensions", async () => {
	const { executor, cli } = await stage(await completeSteps());
	const withBinding = (isolation) => {
		const { req } = request({ isolation });
		const consume = req.authority.consume.bind(req.authority);
		return {
			...req,
			authority: {
				attemptKey: req.attemptKey,
				consume,
				binding: () => ({ schema: "binding", runId: "r" }),
			},
		};
	};
	await drain(executor, await executor.submit(withBinding({ inherit: false })));
	await drain(executor, await executor.submit(withBinding({ inherit: true })));
	const [isolated, inherited] = (await cli.invocations()).filter(
		(entry) => entry.effect,
	);
	assert.ok(
		isolated.envKeys.includes("AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON"),
	);
	assert.ok(
		!isolated.envKeys.includes("PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON"),
	);
	assert.ok(
		inherited.envKeys.includes("PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON"),
	);
	assert.ok(
		!inherited.argv.includes("--no-extensions") &&
			!inherited.argv.includes("--no-context-files"),
	);
});

test("sessions (D3): kept only on request, reported as ownedSession, deletable only under the adapter's state", async () => {
	const { executor, cli, config } = await stage(await completeSteps());
	const { req } = request({ sessionId: "keep-1" });
	const ref = await executor.submit(req);
	assert.equal(ref.sessionId, "keep-1");
	const events = await drain(executor, ref);
	const owned = events.at(-1).ownedSession;
	assert.deepEqual(owned, {
		kind: "pi-session-dir",
		locator: join(config.stateDir, "sessions", "keep-1"),
	});
	assert.deepEqual(events[0], { type: "started", sessionId: "keep-1" });
	const [launch] = (await cli.invocations()).filter((entry) => entry.effect);
	assert.deepEqual(launch.argv.slice(3, 7), [
		"--session-dir",
		owned.locator,
		"--session-id",
		"keep-1",
	]);
	assert.equal(
		await executor.deleteOwnedSession({
			kind: "pi-session-dir",
			locator: "/etc",
		}),
		"refused",
	);
	assert.equal(
		await executor.deleteOwnedSession({
			kind: "other",
			locator: owned.locator,
		}),
		"refused",
	);
	assert.equal(await executor.deleteOwnedSession(owned), "deleted");
	assert.equal(existsSync(owned.locator), false);
	assert.equal(await executor.deleteOwnedSession(owned), "not_found");
	const { req: plain } = request();
	const plainEvents = await drain(executor, await executor.submit(plain));
	assert.equal(plainEvents.at(-1).ownedSession, undefined);
});

test("fresh process: reconcile finds the attempt and observe replays it from the raw stream", async () => {
	const { executor, config } = await stage(await completeSteps());
	const { req } = request();
	const ref = await executor.submit(req);
	const events = await drain(executor, ref);
	const script = `
const { createExecutor } = await import(${JSON.stringify(PI_MODULE)});
const executor = createExecutor(${JSON.stringify(config)});
const reconcile = await executor.reconcile(${JSON.stringify(req.attemptKey)});
const events = [];
for await (const event of executor.observe(reconcile.found)) events.push(event);
const unknown = await executor.observe({ ...reconcile.found, handle: "pid:1" })[Symbol.asyncIterator]().next().then(() => "resolved", (error) => error.code);
const cancel = await executor.cancel(reconcile.found, "owned");
process.stdout.write(JSON.stringify({ reconcile, events, unknown, cancel }));`;
	const { stdout } = await execFileAsync(process.execPath, [
		"--input-type=module",
		"-e",
		script,
	]);
	const fresh = JSON.parse(stdout);
	assert.deepEqual(fresh.reconcile, { found: ref });
	assert.deepEqual(fresh.events, events);
	assert.equal(fresh.unknown, "UNKNOWN_EXEC_REF");
	assert.equal(fresh.cancel, "too_late");
});

test("respond: Pi never asks, so every request id is unknown_request; unknown refs reject", async () => {
	const { executor } = await stage(await completeSteps());
	const { req } = request();
	const ref = await executor.submit(req);
	await drain(executor, ref);
	assert.equal(await executor.respond(ref, "any", "allow"), "unknown_request");
	await assert.rejects(
		executor.respond({ ...ref, attemptKey: "missing" }, "x", "deny"),
		(error) => isSdkError(error, "UNKNOWN_EXEC_REF"),
	);
});

test("run extension: deletes the secret channel, registers injected servers (direct) via private MCP, budget + fast hooks", async () => {
	process.env[PI_RUN_SECRETS_ENV] = JSON.stringify({
		mcpEnv: [{ TOKEN: "v", EXTRA: "ignored" }],
	});
	const handlers = {};
	const servers = [];
	let mcpOptions;
	const pi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		registerMcpServer: (name, config) => servers.push([name, config]),
	};
	await registerPiRun(
		pi,
		{
			schema: "agent-workflow-pi-run-v1",
			privateMcp: true,
			mcpServers: [
				{
					name: "workflow_artifact",
					command: "node",
					args: ["s.js"],
					envKeys: ["TOKEN"],
				},
			],
			toolResultBudget: {
				maxTotalChars: 10,
				statePath: join(tmpdir(), `aw-pi-budget-${process.pid}.json`),
			},
			fastTier: {
				provider: "openai",
				model: "gpt-5.5",
				api: "openai-responses",
				serviceTier: "priority",
			},
			parentWatch: false,
		},
		{
			createMcpExtension: (options) => {
				mcpOptions = options;
				return () => {};
			},
		},
	);
	assert.equal(process.env[PI_RUN_SECRETS_ENV], undefined);
	assert.deepEqual(mcpOptions.loadConfig(), {
		servers: [],
		errors: [],
		autoEnableCodemode: false,
	});
	assert.throws(() => mcpOptions.updateConfig(), /read-only/u);
	assert.deepEqual(servers, [
		[
			"workflow_artifact",
			{
				command: "node",
				args: ["s.js"],
				env: { TOKEN: "v" },
				exposure: "direct",
			},
		],
	]);
	const messages = [
		{
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(20) }],
		},
		{
			role: "toolResult",
			toolCallId: "b",
			toolName: "read",
			content: [{ type: "text", text: "y".repeat(20) }],
		},
	];
	handlers.context({ messages });
	assert.equal(
		messages[0].content[0].text,
		"[evicted tool result: read, 20 chars]",
	);
	const model = { provider: "openai", id: "gpt-5.5", api: "openai-responses" };
	assert.deepEqual(
		handlers.before_provider_request(
			{ payload: { model: "gpt-5.5" } },
			{ model },
		),
		{ model: "gpt-5.5", service_tier: "priority" },
	);
	let aborted = false;
	assert.throws(
		() =>
			handlers.before_provider_request(
				{ payload: { model: "gpt-5.5" } },
				{
					model: { ...model, id: "other" },
					abort: () => {
						aborted = true;
					},
				},
			),
		/binding mismatch/u,
	);
	assert.equal(aborted, true);
	assert.throws(
		() =>
			applyFastServiceTier(
				{ model: "x" },
				{
					provider: "openai",
					model: "gpt-5.5",
					api: "openai-responses",
					serviceTier: "priority",
				},
			),
		/payload binding mismatch/u,
	);
});

test("cancel: SIGTERMs the Pi process group, terminal failed/cancelled; second cancel stays cancelled; after terminal too_late", async () => {
	const transcript = await loadTranscript("complete-read");
	const { executor, cli } = await stage(
		replaySteps(transcript, { hangAfter: 3 }),
		{ killGraceMs: 200 },
	);
	const { req } = request();
	const ref = await executor.submit(req);
	const iterator = executor.observe(ref)[Symbol.asyncIterator]();
	assert.equal((await iterator.next()).value.type, "started");
	// Wait until the stub is running (its signal handlers are installed).
	while (!(await cli.invocations()).some((entry) => entry.effect))
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await executor.cancel(ref, "turn"), "cancelled");
	assert.equal(await executor.cancel(ref, "owned"), "cancelled");
	let terminal;
	for (;;) {
		const step = await iterator.next();
		if (step.done) break;
		terminal = step.value;
	}
	assert.equal(terminal.type, "failed");
	assert.equal(terminal.class, "cancelled");
	assert.equal(await executor.cancel(ref, "owned"), "too_late");
	const [launch] = (await cli.invocations()).filter((entry) => entry.effect);
	assert.deepEqual(launch.signals, ["SIGTERM"]);
});
