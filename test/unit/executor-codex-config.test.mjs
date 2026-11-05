// WP7: codex adapter request mapping — error table, tool mapping/sandbox, isolation thread config,
// argv/transcript hygiene, login status parsing, capabilities and descriptor config.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createAuthorityGate,
	defaultApprovalPolicy,
	loadExecutor,
	validateCapabilities,
} from "../../dist/sdk/index.js";
import {
	CODEX_ERROR_RULES,
	CODEX_MCP_OUTPUT_LIMIT_CHARS,
	CODEX_TOOL_MAPPING_ROWS,
	buildThreadConfig,
	classifyCodexFailure,
	codexCapabilities,
	createExecutor,
	parseLoginStatus,
	planCodexTools,
	redactForTranscript,
} from "../../dist/executors/codex/index.js";
import { DEFAULT_MCP_OUTPUT_LIMIT_CHARS } from "../../dist/mcp/artifact-server/index.js";
import { CODEX_MODULE_PATH } from "../fixtures/executors/codex/harness.mjs";

test("error table: structured codexErrorInfo first, then the recorded and protocol texts", () => {
	const cases = [
		// recorded live (#3, #4)
		[
			{
				message:
					'{"status":400,"error":{"message":"The \'gpt-nope-0\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
				codexErrorInfo: "other",
			},
			"config",
		],
		[
			{
				message:
					"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
				codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
			},
			"auth",
		],
		// protocol enum
		[{ message: "x", codexErrorInfo: "usageLimitExceeded" }, "rate_limit"],
		[
			{
				message: "x",
				codexErrorInfo: {
					responseTooManyFailedAttempts: { httpStatusCode: 429 },
				},
			},
			"rate_limit",
		],
		[
			{
				message: "x",
				codexErrorInfo: {
					responseStreamDisconnected: { httpStatusCode: null },
				},
			},
			"transient",
		],
		[{ message: "x", codexErrorInfo: "serverOverloaded" }, "transient"],
		[{ message: "x", codexErrorInfo: "contextWindowExceeded" }, "permanent"],
		[{ message: "x", codexErrorInfo: "sandboxError" }, "config"],
		[{ message: "malformed", codexErrorInfo: "badRequest" }, "config"],
		// process / config text
		[{ message: "Error: invalid transport\nin `mcp_servers.aside`" }, "config"],
		[
			{
				message: "failed to load configuration: url is not supported for stdio",
			},
			"config",
		],
		[{ message: "Not logged in" }, "auth"],
		[
			{
				message:
					"isolation guard: MCP servers outside the request are active (aside)",
			},
			"config",
		],
		[{ message: "codex app-server exited (signal SIGSEGV)" }, "unknown"],
		[{ message: "something new", codexErrorInfo: "other" }, "unknown"],
	];
	for (const [input, expected] of cases)
		assert.equal(classifyCodexFailure(input), expected, input.message);
	assert.ok(CODEX_ERROR_RULES.length > 10);
});

test("tool mapping: coarse sandbox, readOnly always wins, web → live web_search, artifact → MCP", () => {
	assert.deepEqual(
		planCodexTools(["read", "grep"], false).sandbox,
		"read-only",
	);
	assert.deepEqual(
		planCodexTools(["read", "bash"], false).sandbox,
		"workspace-write",
	);
	assert.deepEqual(planCodexTools(["edit"], true).sandbox, "read-only");
	assert.deepEqual(planCodexTools([], false).sandbox, "workspace-write");
	assert.deepEqual(planCodexTools([], true).sandbox, "read-only");
	assert.equal(planCodexTools(["web_search"], true).webSearch, "live");
	assert.equal(planCodexTools(["read"], true).webSearch, "disabled");
	assert.deepEqual(planCodexTools(["read", "my_custom_tool"], true).unmapped, [
		"my_custom_tool",
	]);
	for (const tool of [
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
	])
		assert.ok(
			CODEX_TOOL_MAPPING_ROWS.some((row) => row.workflowName === tool),
			tool,
		);
	assert.deepEqual(
		CODEX_TOOL_MAPPING_ROWS.find(
			(row) => row.workflowName === "workflow_artifact",
		).entry,
		{ type: "mcp", server: "workflow_artifact", tool: "workflow_artifact" },
	);
	// Safe (explicit or absent, WP4e): never danger-full-access, approvals on-request.
	for (const mode of ["safe", undefined])
		for (const readOnly of [true, false])
			for (const tools of [[], ["bash"], ["edit", "write", "web_search"]]) {
				const planned = planCodexTools(tools, readOnly, mode);
				assert.notEqual(planned.sandbox, "danger-full-access");
				assert.equal(planned.approvalPolicy, "on-request");
			}
});

test("permission mode (WP4e): free → danger-full-access + approvals never; readOnly stays read-only/on-request", () => {
	for (const tools of [
		[],
		["read"],
		["read", "bash"],
		["edit", "web_search"],
	]) {
		const free = planCodexTools(tools, false, "free");
		assert.equal(free.sandbox, "danger-full-access", tools.join());
		assert.equal(free.approvalPolicy, "never");
		const readOnly = planCodexTools(tools, true, "free");
		assert.equal(readOnly.sandbox, "read-only");
		assert.equal(readOnly.approvalPolicy, "on-request");
		assert.deepEqual(readOnly, planCodexTools(tools, true, "safe"));
	}
	assert.equal(planCodexTools(["web_search"], false, "free").webSearch, "live");
});

test("isolation thread config switches off user context and keeps injected MCP env off argv", () => {
	const base = {
		tools: ["read"],
		readOnly: true,
		mcpServers: [
			{
				name: "workflow_artifact",
				command: "node",
				args: ["server.js", "--config", "/x/artifact-access.json"],
				env: { TOKEN: "s3cret-value" },
			},
		],
	};
	const isolated = buildThreadConfig({
		req: { ...base, isolation: { inherit: false } },
		userMcpServers: ["aside", "workflow_artifact"],
		toolOutputTokenLimit: 10000,
		mcpToolTimeoutSec: 300,
		mcpStartupTimeoutSec: 30,
	});
	assert.equal(isolated.project_doc_max_bytes, 0);
	assert.equal(isolated["skills.include_instructions"], false);
	for (const feature of ["plugins", "apps", "hooks", "memories", "multi_agent"])
		assert.equal(isolated[`features.${feature}`], false, feature);
	assert.equal(isolated["mcp_servers.aside.enabled"], false);
	assert.equal(isolated["mcp_servers.workflow_artifact.enabled"], true);
	assert.deepEqual(isolated["mcp_servers.workflow_artifact.env"], {
		TOKEN: "s3cret-value",
	});
	assert.equal(isolated["mcp_servers.workflow_artifact.tool_timeout_sec"], 300);
	assert.equal(isolated.web_search, "disabled");
	assert.equal(isolated.tool_output_token_limit, 10000);
	const inherited = buildThreadConfig({
		req: { ...base, isolation: { inherit: true } },
		userMcpServers: ["aside"],
		toolOutputTokenLimit: 10000,
		mcpToolTimeoutSec: 300,
		mcpStartupTimeoutSec: 30,
	});
	assert.equal(inherited.project_doc_max_bytes, undefined);
	assert.equal(inherited["mcp_servers.aside.enabled"], undefined);
	// The raw transcript never holds the env values.
	const logged = redactForTranscript(
		{ id: 3, method: "thread/start", params: { config: isolated } },
		"out",
		() => undefined,
	);
	assert.ok(!JSON.stringify(logged).includes("s3cret-value"));
	assert.deepEqual(logged.params.config["mcp_servers.workflow_artifact.env"], {
		TOKEN: "<redacted>",
	});
	const config = redactForTranscript(
		{
			id: 2,
			result: { config: { mcp_servers: { aside: { env: { K: "v" } } } } },
		},
		"in",
		() => "config/read",
	);
	assert.deepEqual(config.result, {
		omitted: "user config (may hold secrets)",
		mcpServers: ["aside"],
	});
	const account = redactForTranscript(
		{ method: "account/rateLimits/updated", params: { balance: "1" } },
		"in",
		() => undefined,
	);
	assert.deepEqual(account, {
		method: "account/rateLimits/updated",
		params: "<redacted>",
	});
});

test("submit refuses unmapped tools and odd MCP names before consuming authority", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aw-codex-cfg-"));
	const executor = createExecutor({
		codexPath: join(dir, "missing-codex"),
		stateDir: join(dir, "state"),
	});
	for (const patch of [
		{ tools: ["my_custom_tool"] },
		{ mcpServers: [{ name: "bad name", command: "x", args: [] }] },
	]) {
		const gate = createAuthorityGate({ attemptKey: `k-${Math.random()}` });
		const req = {
			attemptKey: gate.authority.attemptKey,
			authority: gate.authority,
			cwd: dir,
			prompt: "p",
			tools: [],
			readOnly: true,
			mcpServers: [],
			deadlineMs: Date.now() + 1000,
			env: {},
			isolation: { inherit: false },
			approvalPolicy: defaultApprovalPolicy(),
			...patch,
		};
		await assert.rejects(
			executor.submit(req),
			(error) => error.code === "INVALID_REQUEST",
		);
		assert.equal(gate.state(), "pending");
	}
});

test("a missing CLI after consume is a config failure with a valid stream, argv carries no secret", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aw-codex-cfg-"));
	const executor = createExecutor({
		codexPath: join(dir, "missing-codex"),
		stateDir: join(dir, "state"),
	});
	const gate = createAuthorityGate({ attemptKey: "missing-cli" });
	const ref = await executor.submit({
		attemptKey: "missing-cli",
		authority: gate.authority,
		cwd: dir,
		prompt: "p",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 1000,
		env: { SECRET_ENV: "value-not-on-argv" },
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		artifactsDir: join(dir, "artifacts"),
	});
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	assert.deepEqual(
		events.map((event) => event.type),
		["started", "failed"],
	);
	assert.equal(events[1].class, "config");
	const raw = readFileSync(
		join(dir, "artifacts", readdirSync(join(dir, "artifacts"))[0]),
		"utf8",
	);
	assert.ok(!raw.includes("value-not-on-argv"));
	assert.match(raw, /"envKeys":\["SECRET_ENV"\]/);
	assert.deepEqual(await executor.reconcile("missing-cli"), { found: ref });
});

test("login status maps to the SDK enum without reading credential files", () => {
	assert.equal(
		parseLoginStatus({
			code: 0,
			stdout: "",
			stderr: "Logged in using ChatGPT\n",
		}),
		"ok",
	);
	assert.equal(
		parseLoginStatus({ code: 1, stdout: "Not logged in\n", stderr: "" }),
		"missing",
	);
	assert.equal(
		parseLoginStatus({ code: 1, stdout: "", stderr: "token expired" }),
		"expired",
	);
	assert.equal(
		parseLoginStatus({ code: 2, stdout: "", stderr: "boom" }),
		"unknown",
	);
});

test("capabilities are valid, honest about web safety and below the artifact server bound", () => {
	const caps = codexCapabilities();
	assert.deepEqual(validateCapabilities(caps), []);
	assert.equal(caps.webTools.safetyPolicy, "unknown");
	assert.equal(caps.toolAllowlist.detail, "coarse");
	assert.equal(caps.usage.detail, "tokens");
	assert.equal(caps.toolResultBudget.level, "none");
	assert.equal(caps.contextIsolation.level, "emulated");
	assert.equal(caps.sessionBound, true);
	for (const [name, entry] of Object.entries(caps))
		if (entry?.source === "probed")
			assert.match(
				entry.verifiedWith,
				/codex-cli 0\.166\.0, WP7 live 2026-10-26, re-verified 2026-11-04/,
				name,
			);
	assert.ok(CODEX_MCP_OUTPUT_LIMIT_CHARS > DEFAULT_MCP_OUTPUT_LIMIT_CHARS);
	assert.ok(CODEX_MCP_OUTPUT_LIMIT_CHARS <= 40_000);
});

test("descriptor convention: loadExecutor rebuilds the adapter; bad config is refused", async () => {
	const executor = await loadExecutor({
		id: "codex",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: CODEX_MODULE_PATH,
		config: { stateDir: join(tmpdir(), "aw-codex-desc-state") },
	});
	assert.equal(executor.id, "codex");
	assert.throws(
		() => createExecutor({ mcpToolTimeoutSec: -1 }),
		/positive number/,
	);
	assert.throws(() => createExecutor("nope"), /must be an object/);
});
