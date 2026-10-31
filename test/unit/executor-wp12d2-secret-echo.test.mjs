// WP12d-2 review #5: request env values and injected MCP env values echoed by the worker CLI never
// reach a persisted transcript, event or error path — including stderr where a value is split
// across two chunks — while the CLI still receives them unchanged.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createCodexExecutor } from "../../dist/executors/codex/index.js";
import { createPiExecutor } from "../../dist/executors/pi/index.js";
import { drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

const FAKE_CODEX = fileURLToPath(
	new URL(
		"../fixtures/executors/codex/fake-echo-app-server.mjs",
		import.meta.url,
	),
);
const ENV_SECRET = "env-secret-7f3a9c1e2b";
const MCP_SECRET = "mcp-secret-4d8e6b2a91";

function request(cwd, attemptKey, overrides = {}) {
	return {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd,
		prompt: "say hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: { ECHO_SECRET: ENV_SECRET },
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		...overrides,
	};
}

function listFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path));
		else out.push(path);
	}
	return out;
}

async function assertNoSecrets(label, dirs, events) {
	const text = JSON.stringify(events);
	for (const secret of [ENV_SECRET, MCP_SECRET])
		assert.ok(!text.includes(secret), `${label}: events hold ${secret}`);
	for (const dir of dirs)
		for (const file of listFiles(dir)) {
			const content = await readFile(file, "utf8");
			for (const secret of [ENV_SECRET, MCP_SECRET]) {
				assert.ok(
					!content.includes(secret),
					`${label}: ${file} holds ${secret}`,
				);
				// Neither half of a value split across stderr chunks survives on its own line.
				const half = secret.slice(0, Math.floor(secret.length / 2));
				assert.ok(
					!content.includes(`token ${half}`),
					`${label}: ${file} holds a split prefix of ${secret}`,
				);
			}
		}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("review #5 (codex): echoed env and MCP env values are redacted everywhere", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-codex-echo-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const codexPath = join(dir, "codex");
	await writeFile(
		codexPath,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CODEX)} "$@"\n`,
		{ mode: 0o755 },
	);
	const log = join(dir, "server-log.jsonl");
	process.env.FAKE_CODEX_LOG = log;
	t.after(() => {
		delete process.env.FAKE_CODEX_LOG;
	});
	const stateDir = join(dir, "state");
	const artifactsDir = join(dir, "artifacts");
	const executor = createCodexExecutor({ codexPath, stateDir });
	const ref = await executor.submit(
		request(dir, "codex-echo-1", {
			artifactsDir,
			readOnly: false,
			mcpServers: [
				{
					name: "echo_mcp",
					command: "true",
					args: [],
					env: { MCP_TOKEN: MCP_SECRET },
				},
			],
		}),
	);
	const { events, terminal } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	assert.equal(terminal.type, "completed");
	await sleep(200);
	// The echo happened (redaction markers), and the CLI got the real values.
	assert.match(JSON.stringify(events), /redacted/);
	const sent = await readFile(log, "utf8");
	assert.ok(
		sent.includes(MCP_SECRET),
		"thread/start still carries the MCP env value",
	);
	await assertNoSecrets("codex", [stateDir, artifactsDir], events);
});

async function echoScript(dir, name, stdoutLines) {
	// A fake CLI that prints the given stdout lines (with the env value substituted) and echoes
	// the value on stderr split across two writes.
	const path = join(dir, name);
	const source = `#!${process.execPath}
const secret = process.env.ECHO_SECRET ?? "";
const half = Math.floor(secret.length / 2);
const lines = ${JSON.stringify(stdoutLines)};
process.stdin.resume();
process.stdin.on("end", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
	process.stderr.write("warn: token " + secret.slice(0, half));
	await sleep(60);
	process.stderr.write(secret.slice(half) + " leaked\\n");
	await sleep(20);
	for (const line of lines) process.stdout.write(line.split("@SECRET@").join(secret) + "\\n");
	await sleep(20);
	process.exit(0);
})();
`;
	await writeFile(path, source, { mode: 0o755 });
	return path;
}

test("review #5 (claude): a value split across stderr chunks is redacted", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-echo-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const claudePath = await echoScript(dir, "claude", [
		JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "x",
			tools: [],
			mcp_servers: [],
			model: "fake",
		}),
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done @SECRET@",
			session_id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
	]);
	const stateDir = join(dir, "state");
	const artifactsDir = join(dir, "artifacts");
	const executor = createClaudeExecutor({
		config: parseClaudeConfig({
			claudePath,
			stateDir,
			claudeConfigDir: join(dir, "claude-config"),
			killGraceMs: 200,
		}),
	});
	const ref = await executor.submit(
		request(dir, "claude-echo-1", { artifactsDir }),
	);
	const { events } = await drain(executor, ref, { timeoutMs: 15_000 });
	await sleep(200);
	assert.match(
		await readFile(join(artifactsDir, "claude-stderr.log"), "utf8"),
		/<redacted:ECHO_SECRET>/,
	);
	await assertNoSecrets("claude", [stateDir, artifactsDir], events);
});

test("review #5 (pi): a value split across stderr chunks is redacted", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-echo-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const piCommand = await echoScript(dir, "pi", [
		JSON.stringify({ type: "session", id: "s" }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done @SECRET@" }],
				stopReason: "stop",
			},
		}),
		JSON.stringify({ type: "agent_end", messages: [] }),
	]);
	const stateDir = join(dir, "state");
	const artifactsDir = join(dir, "artifacts");
	const executor = createPiExecutor({ piCommand, stateDir });
	const ref = await executor.submit(
		request(dir, "pi-echo-1", { artifactsDir }),
	);
	const { events } = await drain(executor, ref, { timeoutMs: 15_000 });
	await sleep(200);
	assert.match(
		await readFile(join(artifactsDir, "pi-stderr.log"), "utf8"),
		/\[redacted\]/,
	);
	await assertNoSecrets("pi", [stateDir, artifactsDir], events);
});
