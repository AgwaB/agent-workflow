// test-tier: integration
// WP8: worker session cleanup (D3/R#10), probe parsing (D1: no account data), raw-log redaction.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	attemptSessionId,
	createClaudeExecutor,
	modelsFromInitialize,
	parseAuthStatus,
	parseClaudeConfig,
	parseCliVersion,
	removeClaudeSessionFiles,
} from "../../dist/executors/claude/index.js";
import { createStubCli, drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { stubScripts } from "../fixtures/executors/claude/harness.mjs";

const ID = "6c5135b7-3668-4f3a-b3d2-a2fb0ec7a40a";

async function setup(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-sessions-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const claudeConfigDir = join(dir, "claude-config");
	const cli = await createStubCli({
		dir,
		name: "claude",
		scripts: stubScripts("complete"),
	});
	const config = parseClaudeConfig({
		claudePath: cli.path,
		stateDir: join(dir, "state"),
		claudeConfigDir,
		killGraceMs: 200,
	});
	return {
		dir,
		claudeConfigDir,
		cli,
		config,
		executor: createClaudeExecutor({ config }),
	};
}

function request(cwd, overrides = {}) {
	const attemptKey =
		overrides.attemptKey ?? `s-${Math.random().toString(16).slice(2)}`;
	return {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd,
		prompt: "hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		...overrides,
	};
}

test("removeClaudeSessionFiles removes only the named session entries", async (t) => {
	const { claudeConfigDir } = await setup(t);
	const project = join(claudeConfigDir, "projects", "-tmp-x");
	await mkdir(join(project, ID, "tool-results"), { recursive: true });
	await writeFile(join(project, `${ID}.jsonl`), "{}\n");
	await writeFile(join(project, "other.jsonl"), "{}\n");
	assert.equal(
		await removeClaudeSessionFiles(claudeConfigDir, "../x", {
			transcript: true,
		}),
		0,
	);
	assert.equal(
		await removeClaudeSessionFiles(claudeConfigDir, ID, { transcript: false }),
		1,
	);
	assert.deepEqual((await readdir(project)).sort(), [
		`${ID}.jsonl`,
		"other.jsonl",
	]);
	assert.equal(
		await removeClaudeSessionFiles(claudeConfigDir, ID, { transcript: true }),
		1,
	);
	assert.deepEqual(await readdir(project), ["other.jsonl"]);
});

test("deleteOwnedSession deletes recorded sessions only", async (t) => {
	const { dir, claudeConfigDir, executor } = await setup(t);
	const cwd = await mkdtemp(join(dir, "cwd-"));
	const ref = await executor.submit(request(cwd, { sessionId: ID }));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.deepEqual(terminal.ownedSession, {
		kind: "claude-session",
		locator: ID,
	});
	const project = join(claudeConfigDir, "projects", "-tmp-cwd");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, `${ID}.jsonl`), "{}\n");
	const stranger = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	await writeFile(join(project, `${stranger}.jsonl`), "{}\n");
	assert.equal(
		await executor.deleteOwnedSession({
			kind: "claude-session",
			locator: stranger,
		}),
		"refused",
	);
	assert.equal(
		await executor.deleteOwnedSession({ kind: "codex-thread", locator: ID }),
		"refused",
	);
	assert.equal(
		await executor.deleteOwnedSession({ kind: "claude-session", locator: ID }),
		"deleted",
	);
	assert.deepEqual(await readdir(project), [`${stranger}.jsonl`]);
	assert.equal(
		await executor.deleteOwnedSession({ kind: "claude-session", locator: ID }),
		"refused",
	);
});

test("an ephemeral attempt's spilled tool results are removed after exit (D3)", async (t) => {
	const { dir, claudeConfigDir, executor } = await setup(t);
	const cwd = await mkdtemp(join(dir, "cwd-"));
	const attemptKey = "ephemeral-1";
	const spill = join(
		claudeConfigDir,
		"projects",
		"-tmp-y",
		attemptSessionId(attemptKey),
		"tool-results",
	);
	await mkdir(spill, { recursive: true });
	await writeFile(join(spill, "mcp-x.txt"), "spilled");
	const ref = await executor.submit(request(cwd, { attemptKey }));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "completed");
	assert.equal(terminal.ownedSession, undefined);
	const deadline = Date.now() + 5000;
	let left = ["?"];
	while (Date.now() < deadline) {
		left = await readdir(join(claudeConfigDir, "projects")).catch(() => []);
		if (left.length === 0) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.deepEqual(left, []);
});

// Live bundle 4: the durable worker calls process.exit right after the terminal event, so a removal
// that starts after the event is cut (3 of 3 concurrent CLI runs left `<uuid>/tool-results/`).
// The spill must be gone when the terminal event is delivered, without polling.
test("an ephemeral attempt's spilled tool results are gone before the terminal event (D3, live 4)", async (t) => {
	const { dir, claudeConfigDir, executor } = await setup(t);
	const cwd = await mkdtemp(join(dir, "cwd-"));
	const attemptKey = "ephemeral-before-terminal";
	const projects = join(claudeConfigDir, "projects");
	// Unrelated project dirs make the removal take several fs round trips, like a real config dir.
	for (let i = 0; i < 40; i++)
		await mkdir(join(projects, `-tmp-other-${i}`), { recursive: true });
	const spill = join(
		projects,
		"-tmp-z",
		attemptSessionId(attemptKey),
		"tool-results",
	);
	await mkdir(spill, { recursive: true });
	await writeFile(join(spill, "toolu_x.txt"), "spilled");
	const ref = await executor.submit(request(cwd, { attemptKey }));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "completed");
	const left = await readdir(projects);
	assert.ok(!left.includes("-tmp-z"), `spill left at terminal: ${left.length}`);
	assert.equal(left.length, 40, "unrelated project dirs are kept");
});

test("raw stream, stderr and invocation files are kept in artifactsDir without env values", async (t) => {
	const { dir, executor } = await setup(t);
	const cwd = await mkdtemp(join(dir, "cwd-"));
	const artifactsDir = await mkdtemp(join(dir, "artifacts-"));
	const secret = "alpha-content-91"; // appears in the recorded Read result
	const ref = await executor.submit(
		request(cwd, { artifactsDir, env: { FIXTURE_SECRET: secret } }),
	);
	await drain(executor, ref, { timeoutMs: 15_000 });
	const names = (await readdir(artifactsDir)).sort();
	assert.deepEqual(names, [
		"claude-invocation.json",
		"claude-stderr.log",
		"claude-stream.jsonl",
	]);
	for (const name of names) {
		const text = await readFile(join(artifactsDir, name), "utf8");
		assert.ok(!text.includes(secret), `${name} holds an env value`);
	}
	assert.match(
		await readFile(join(artifactsDir, "claude-stream.jsonl"), "utf8"),
		/<redacted:FIXTURE_SECRET>/,
	);
	const invocation = JSON.parse(
		await readFile(join(artifactsDir, "claude-invocation.json"), "utf8"),
	);
	assert.ok(invocation.envKeys.includes("FIXTURE_SECRET"));
});

test("probe parsing keeps no account data", () => {
	assert.equal(parseCliVersion("2.1.310 (Claude Code)"), "2.1.310");
	assert.equal(parseCliVersion("garbage"), null);
	const status = JSON.stringify({
		loggedIn: true,
		email: "a@b.c",
		orgName: "Org",
	});
	assert.equal(parseAuthStatus({ code: 0, stdout: status }), "ok");
	assert.equal(
		parseAuthStatus({ code: 1, stdout: '{"loggedIn":false}' }),
		"missing",
	);
	assert.equal(parseAuthStatus({ code: 1, stdout: "" }), "unknown");
	const init = JSON.stringify({
		type: "control_response",
		response: {
			request_id: "probe-initialize",
			response: {
				models: [{ value: "haiku", displayName: "Haiku" }],
				account: { email: "a@b.c" },
			},
		},
	});
	assert.deepEqual(modelsFromInitialize(init), ["haiku"]);
	// 2026-11-01: aliases resolve to full ids (claude 2.1.314); both are known model names.
	const withResolved = JSON.stringify({
		type: "control_response",
		response: {
			request_id: "probe-initialize",
			response: {
				models: [
					{ value: "default", resolvedModel: "claude-opus-5-5" },
					{ value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
					{ value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5" },
					{ value: "opus", resolvedModel: "claude-opus-5-5" },
				],
			},
		},
	});
	assert.deepEqual(modelsFromInitialize(withResolved), [
		"default",
		"sonnet",
		"claude-sonnet-5",
		"opus",
		"claude-opus-5-5",
		"claude-sonnet-5-5",
	]);
});

test("probe against the stub: version, auth, models, MCP limit; no effect", async (t) => {
	const { cli, executor } = await setup(t);
	const probe = await executor.probe();
	assert.equal(probe.installed, true);
	assert.equal(probe.cliVersion, "2.1.310");
	assert.equal(probe.auth, "ok");
	assert.equal(probe.mcpOutputLimitChars, 22_500);
	assert.ok(
		probe.notes.some((note) => note === "models: default, haiku, sonnet"),
	);
	assert.ok(!JSON.stringify(probe).includes("REDACTED"));
	assert.equal(await cli.effectCount(), 0);
	const missing = createClaudeExecutor({
		config: parseClaudeConfig({
			claudePath: "/nonexistent/claude",
			stateDir: "/tmp/aw-x",
		}),
	});
	const absent = await missing.probe();
	assert.equal(absent.installed, false);
});
