// test-tier: integration
// WP12d-2 review #6: injected MCP servers do not bypass readOnly tool restrictions. Only the
// engine's artifact tool is exposed by exact name; a readOnly request that injects any other server
// (whose tools' non-mutation the adapter cannot enforce) is refused before the authority is consumed.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildClaudeInvocation,
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createCodexExecutor } from "../../dist/executors/codex/index.js";
import { createPiExecutor } from "../../dist/executors/pi/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import {
	PROBE_SCRIPTS,
	replaySteps,
	loadTranscript,
} from "../fixtures/executors/pi/harness.mjs";

const RW = { name: "rw", command: "node", args: ["rw-server.js"] };
const ARTIFACT = {
	name: "workflow_artifact",
	command: "node",
	args: ["artifact-server.js"],
};

function request(overrides = {}) {
	const attemptKey = `mcp-ro-${Math.random().toString(16).slice(2)}`;
	const gate = createAuthorityGate({ attemptKey });
	return {
		gate,
		req: {
			attemptKey,
			authority: gate.authority,
			cwd: tmpdir(),
			prompt: "hi",
			tools: ["read"],
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

const flagValue = (argv, flag) => {
	const index = argv.indexOf(flag);
	return index < 0 ? undefined : argv[index + 1];
};

test("review #6 (claude): readOnly never pre-allows a whole injected server", () => {
	const config = parseClaudeConfig({ stateDir: "/tmp/aw-claude-mcp-ro" });
	assert.throws(
		() =>
			buildClaudeInvocation(request({ mcpServers: [RW] }).req, config, {
				mcpConfigPath: "/tmp/mcp.json",
			}),
		(error) => error.code === "CAPABILITY_MISSING",
	);
	const { argv, allowedTools } = buildClaudeInvocation(
		request({ mcpServers: [ARTIFACT] }).req,
		config,
		{ mcpConfigPath: "/tmp/mcp.json" },
	);
	assert.deepEqual(allowedTools, ["mcp__workflow_artifact__workflow_artifact"]);
	assert.equal(
		flagValue(argv, "--allowedTools"),
		"mcp__workflow_artifact__workflow_artifact",
	);
});

test("review #6 (claude): submit refuses before consuming the authority", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-mcp-ro-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const executor = createClaudeExecutor({
		config: parseClaudeConfig({
			claudePath: "/nonexistent/claude",
			stateDir: join(dir, "state"),
		}),
	});
	const { gate, req } = request({ mcpServers: [RW] });
	await assert.rejects(
		executor.submit(req),
		(error) => error.code === "CAPABILITY_MISSING",
	);
	assert.equal(gate.state(), "pending");
});

test("review #6 (pi): readOnly declares only the artifact tool, refuses other servers", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-mcp-ro-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: [
			...PROBE_SCRIPTS,
			{
				name: "run",
				when: { argvIncludes: ["--mode", "json"] },
				steps: replaySteps(await loadTranscript("complete-read")),
			},
		],
	});
	const executor = createPiExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	});
	const refused = request({ mcpServers: [RW] });
	await assert.rejects(
		executor.submit(refused.req),
		(error) => error.code === "CAPABILITY_MISSING",
	);
	assert.equal(refused.gate.state(), "pending");
	const { req } = request({ mcpServers: [ARTIFACT] });
	const ref = await executor.submit(req);
	for await (const _event of executor.observe(ref));
	const [launch] = (await cli.invocations()).filter((entry) => entry.effect);
	assert.equal(
		flagValue(launch.argv, "--tools"),
		"read,mcp__workflow_artifact__workflow_artifact",
	);
});

test("review #6 (codex): a readOnly request with another server is refused", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-codex-mcp-ro-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const executor = createCodexExecutor({
		codexPath: "/nonexistent/codex",
		stateDir: join(dir, "state"),
	});
	const { gate, req } = request({ mcpServers: [RW] });
	await assert.rejects(
		executor.submit(req),
		(error) => error.code === "CAPABILITY_MISSING",
	);
	assert.equal(gate.state(), "pending");
});

test("review #6: non-readOnly requests keep injected servers usable", () => {
	const config = parseClaudeConfig({ stateDir: "/tmp/aw-claude-mcp-rw" });
	const { allowedTools } = buildClaudeInvocation(
		request({ readOnly: false, mcpServers: [RW, ARTIFACT] }).req,
		config,
		{ mcpConfigPath: "/tmp/mcp.json" },
	);
	assert.deepEqual(allowedTools, [
		"mcp__rw",
		"mcp__workflow_artifact__workflow_artifact",
	]);
});
