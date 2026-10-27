// WP8: SubmitRequest → claude argv/env (isolation B5, permissions D2, tools, MCP, sessions D3),
// config parsing and the tool mapping table.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	attemptSessionId,
	buildClaudeInvocation,
	claudeSessionUuid,
	buildMcpConfig,
	CLAUDE_TOOL_MAPPING,
	claudeCapabilities,
	claudeToolKind,
	createExecutor,
	mcpOutputLimitChars,
	parseClaudeConfig,
	userMessageLine,
} from "../../dist/executors/claude/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	describeExecutor,
	mapTools,
	PI_TOOL_NAMES,
	validateCapabilities,
	validateExecutorDescriptor,
} from "../../dist/sdk/index.js";
import { artifactToolVisibleName } from "../../dist/mcp/artifact-server/index.js";

const config = parseClaudeConfig({ stateDir: "/tmp/aw-claude-argv-state" });

function req(overrides = {}) {
	const attemptKey = overrides.attemptKey ?? "argv-1";
	return {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd: "/tmp",
		prompt: "hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 1000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		...overrides,
	};
}
const plan = (overrides, options = { mcpConfigPath: "/tmp/mcp.json" }) =>
	buildClaudeInvocation(req(overrides), config, options);
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("transport and permission flags are always present; safe (explicit or absent): no bypass/auto modes", () => {
	// WP4e: explicit safe and an absent permissionMode (SDK default) give the same argv.
	assert.deepEqual(
		plan({ readOnly: false, tools: ["bash", "edit"], permissionMode: "safe" })
			.argv,
		plan({ readOnly: false, tools: ["bash", "edit"] }).argv,
	);
	const { argv } = plan({
		readOnly: false,
		tools: ["bash", "edit"],
		permissionMode: "safe",
	});
	for (const flag of [
		"-p",
		"--verbose",
		"--include-partial-messages",
		"--permission-prompt-tool",
	])
		assert.ok(argv.includes(flag), flag);
	assert.equal(flagValue(argv, "--input-format"), "stream-json");
	assert.equal(flagValue(argv, "--output-format"), "stream-json");
	assert.equal(flagValue(argv, "--permission-mode"), "default");
	assert.equal(flagValue(argv, "--permission-prompt-tool"), "stdio");
	const joined = argv.join(" ");
	for (const forbidden of [
		"dangerously",
		"bypassPermissions",
		"acceptEdits",
		"--bare",
		"dontAsk",
		"--permission-mode auto",
	])
		assert.ok(!joined.includes(forbidden), forbidden);
	// Mutating tools are offered but never pre-allowed: they go through the approval channel.
	assert.equal(flagValue(argv, "--tools"), "Bash,Edit");
	assert.ok(!argv.includes("--allowedTools"));
});

test("permission mode (WP4e): free → bypassPermissions; a readOnly stage gets the safe argv in free mode", () => {
	const free = plan({
		readOnly: false,
		tools: ["bash", "edit"],
		permissionMode: "free",
	});
	assert.equal(flagValue(free.argv, "--permission-mode"), "bypassPermissions");
	assert.equal(free.permissionMode, "bypassPermissions");
	assert.ok(!free.argv.join(" ").includes("dangerously"));
	// The prompt tool stays: a request that still arrives reaches the engine (free → allow).
	assert.equal(flagValue(free.argv, "--permission-prompt-tool"), "stdio");
	assert.equal(flagValue(free.argv, "--tools"), "Bash,Edit");
	// B5 isolation is unchanged by the mode.
	assert.equal(flagValue(free.argv, "--setting-sources"), "");
	assert.ok(free.argv.includes("--strict-mcp-config"));
	const readOnly = (mode) =>
		plan({
			readOnly: true,
			tools: ["read", "bash", "edit"],
			permissionMode: mode,
		});
	assert.deepEqual(readOnly("free").argv, readOnly("safe").argv);
	assert.equal(
		flagValue(readOnly("free").argv, "--permission-mode"),
		"default",
	);
	assert.equal(flagValue(readOnly("free").argv, "--tools"), "Read");
	assert.ok(readOnly("free").argv.includes("--disallowedTools"));
	assert.equal(
		flagValue(
			plan({ readOnly: false, permissionMode: "safe" }).argv,
			"--permission-mode",
		),
		"default",
	);
});

test("isolation (inherit: false) uses the verified combination; inherit drops it", () => {
	const isolated = plan({}).argv;
	assert.equal(flagValue(isolated, "--setting-sources"), "");
	assert.equal(
		flagValue(isolated, "--settings"),
		'{"autoMemoryEnabled":false}',
	);
	assert.ok(isolated.includes("--strict-mcp-config"));
	assert.ok(isolated.includes("--disable-slash-commands"));
	const inherit = plan({ isolation: { inherit: true } }).argv;
	for (const flag of [
		"--setting-sources",
		"--strict-mcp-config",
		"--disable-slash-commands",
	])
		assert.ok(!inherit.includes(flag), flag);
	assert.equal(flagValue(inherit, "--permission-mode"), "default");
});

test("readOnly removes and denies mutating tools; read tools are not pre-allowed", () => {
	const { argv, builtinTools } = plan({
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	});
	assert.deepEqual(builtinTools, ["Read", "Grep", "Glob"]);
	assert.equal(flagValue(argv, "--tools"), "Read,Grep,Glob");
	assert.equal(
		flagValue(argv, "--disallowedTools"),
		"Bash,Edit,Write,NotebookEdit",
	);
	assert.ok(!argv.includes("--allowedTools"));
	assert.equal(flagValue(plan({ tools: [] }).argv, "--tools"), "");
});

test("web tools and injected MCP servers are pre-allowed", () => {
	const { argv } = plan({
		tools: ["web_search", "fetch_content", "workflow_artifact"],
		mcpServers: [
			{ name: "workflow_artifact", command: "node", args: ["s.js"] },
		],
	});
	assert.equal(
		flagValue(argv, "--allowedTools"),
		"WebSearch,WebFetch,mcp__workflow_artifact",
	);
	assert.equal(flagValue(argv, "--mcp-config"), "/tmp/mcp.json");
});

test("MCP env values never reach argv or the config file (${VAR} expansion)", () => {
	const secret = "s3cret-value-0123456789";
	const servers = [
		{
			name: "workflow_artifact",
			command: "node",
			args: ["s.js"],
			env: { TOKEN: secret },
		},
	];
	const built = plan({ mcpServers: servers });
	assert.ok(!built.argv.some((arg) => arg.includes(secret)));
	assert.ok(!JSON.stringify(built.mcpConfig).includes(secret));
	assert.equal(
		built.mcpConfig.mcpServers.workflow_artifact.env.TOKEN,
		"${AW_CLAUDE_MCP_0_TOKEN}",
	);
	assert.equal(built.env.AW_CLAUDE_MCP_0_TOKEN, secret);
	assert.throws(
		() =>
			buildMcpConfig([{ name: "x", command: "node", args: ["${HOME}/s.js"] }]),
		/would be expanded/,
	);
	assert.throws(() =>
		buildMcpConfig([{ name: "bad name", command: "c", args: [] }]),
	);
});

test("refusals happen before any effect", () => {
	assert.throws(() => plan({ tools: ["nonexistent_tool"] }), {
		code: "CAPABILITY_MISSING",
	});
	assert.throws(() => plan({ tools: ["workflow_artifact"] }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => plan({ effort: "turbo" }), { code: "INVALID_REQUEST" });
	assert.throws(() => plan({ sessionId: " " }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => plan({ resumeSessionId: "../x" }), {
		code: "INVALID_REQUEST",
	});
});

test("model, effort, system prompt", () => {
	const built = plan({
		model: "haiku",
		effort: "minimal",
		systemPrompt: "be terse",
	});
	assert.equal(flagValue(built.argv, "--model"), "haiku");
	assert.equal(flagValue(built.argv, "--effort"), "low");
	assert.equal(flagValue(built.argv, "--append-system-prompt"), "be terse");
	const replace = buildClaudeInvocation(
		req({ systemPrompt: "x" }),
		parseClaudeConfig({ stateDir: "/tmp/s", systemPromptMode: "replace" }),
		{ mcpConfigPath: null },
	);
	assert.equal(flagValue(replace.argv, "--system-prompt"), "x");
});

test("sessions (D3): ephemeral by default, kept only on request, resume continues", () => {
	const ephemeral = plan({ attemptKey: "k-1" });
	assert.equal(ephemeral.keepSession, false);
	assert.equal(ephemeral.sessionId, attemptSessionId("k-1"));
	assert.ok(ephemeral.argv.includes("--no-session-persistence"));
	assert.equal(
		flagValue(ephemeral.argv, "--session-id"),
		attemptSessionId("k-1"),
	);
	assert.match(
		attemptSessionId("k-1"),
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.notEqual(attemptSessionId("k-1"), attemptSessionId("k-2"));
	const id = "6c5135b7-3668-4f3a-b3d2-a2fb0ec7a40a";
	const kept = plan({ sessionId: id });
	assert.equal(kept.keepSession, true);
	assert.ok(!kept.argv.includes("--no-session-persistence"));
	const resumed = plan({ resumeSessionId: id });
	assert.equal(flagValue(resumed.argv, "--resume"), id);
	assert.ok(!resumed.argv.includes("--session-id"));
});

// Live bundle 3: the engine keeps every artifact-graph task's session under a logical id
// (`agent-workflow.<run>.<task>`); Claude's --session-id takes only a UUID, and the old refusal
// stopped every Claude workflow run before launch.
test("a logical engine session id maps to a deterministic Claude session UUID", () => {
	const logical = "agent-workflow.workflow_mvqcmxfu_938ff6.task-1";
	const kept = plan({ sessionId: logical });
	const uuid = claudeSessionUuid(logical);
	assert.match(
		uuid,
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(kept.sessionId, uuid);
	assert.equal(kept.keepSession, true);
	assert.equal(flagValue(kept.argv, "--session-id"), uuid);
	assert.ok(!kept.argv.includes(logical));
	assert.ok(!kept.argv.includes("--no-session-persistence"));
	assert.equal(claudeSessionUuid(logical), uuid);
	assert.notEqual(
		claudeSessionUuid(`${logical}.launch-retry-1`),
		uuid,
		"retry sessions stay distinct",
	);
	assert.notEqual(uuid, attemptSessionId(logical));
	const id = "6c5135b7-3668-4f3a-b3d2-a2fb0ec7a40a";
	assert.equal(claudeSessionUuid(id), id);
});

test("MAX_MCP_OUTPUT_TOKENS is set by the adapter and drives the probe limit", () => {
	assert.equal(plan({}).env.MAX_MCP_OUTPUT_TOKENS, "25000");
	assert.equal(mcpOutputLimitChars(25_000), 22_500);
	const custom = buildClaudeInvocation(
		req({ env: { MAX_MCP_OUTPUT_TOKENS: "1" } }),
		parseClaudeConfig({
			stateDir: "/tmp/s",
			mcpOutputTokens: 10_000,
			mcpToolTimeoutMs: 60_000,
		}),
		{ mcpConfigPath: null },
	);
	assert.equal(custom.env.MAX_MCP_OUTPUT_TOKENS, "10000");
	assert.equal(custom.env.MCP_TOOL_TIMEOUT, "60000");
});

test("prompt goes to stdin as one stream-json user message", () => {
	assert.deepEqual(JSON.parse(userMessageLine("hello")), {
		type: "user",
		message: { role: "user", content: "hello" },
		parent_tool_use_id: null,
		session_id: "",
	});
});

test("tool mapping covers every Pi tool; kinds follow ACP", () => {
	assert.deepEqual(
		mapTools([...PI_TOOL_NAMES], CLAUDE_TOOL_MAPPING).unmapped,
		[],
	);
	assert.equal(claudeToolKind("Bash"), "execute");
	assert.equal(claudeToolKind("Write"), "edit");
	assert.equal(claudeToolKind("Glob"), "search");
	assert.equal(claudeToolKind("WebFetch"), "fetch");
	assert.equal(claudeToolKind(artifactToolVisibleName("claude")), "read");
	assert.equal(claudeToolKind("mcp__other__x"), "other");
});

test("config: defaults, refusals, descriptor without secrets", () => {
	const defaults = parseClaudeConfig(null);
	assert.equal(defaults.claudePath, "claude");
	assert.equal(defaults.mcpOutputTokens, 25_000);
	assert.equal(defaults.systemPromptMode, "append");
	assert.throws(() => parseClaudeConfig({ apiKey: "x" }), {
		code: "DESCRIPTOR_INVALID",
	});
	assert.throws(() => parseClaudeConfig({ stateDir: "relative" }), {
		code: "DESCRIPTOR_INVALID",
	});
	assert.throws(() => parseClaudeConfig([]), { code: "DESCRIPTOR_INVALID" });
	const executor = createExecutor({ stateDir: "/tmp/aw-claude-argv-state" });
	const descriptor = describeExecutor(
		executor,
		"@agwab/agent-workflow/executors/claude",
		{
			stateDir: "/tmp/aw-claude-argv-state",
		},
	);
	assert.deepEqual(validateExecutorDescriptor(descriptor), []);
});

test("capability table is valid and honest", () => {
	for (const mode of ["append", "replace"]) {
		const caps = claudeCapabilities(mode);
		assert.deepEqual(validateCapabilities(caps), []);
		assert.equal(caps.systemPrompt.detail, mode);
		assert.notEqual(caps.webTools.safetyPolicy, "engine");
		assert.equal(caps.toolResultBudget.level, "none");
		assert.equal(caps.sessionBound, true);
		for (const [name, row] of Object.entries(caps))
			if (row?.source === "probed")
				assert.match(row.verifiedWith, /2\.1\.310/, name);
	}
});
