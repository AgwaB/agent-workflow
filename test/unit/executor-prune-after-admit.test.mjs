// test-tier: integration
// The periodic adapter-state prune (WP18b) is background work that writes `<stateDir>/.prune-stamp`. A submit that is
// refused before launch must schedule none (it would write into the state dir after the call already threw, racing
// the caller's cleanup); an admitted launch still schedules it. Refused tests create the state dir first: without it
// the old early prune found no dir and wrote nothing, which hid the race.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createAcpExecutor,
	parseAcpConfig,
} from "../../dist/executors/acp/index.js";
import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createCodexExecutor } from "../../dist/executors/codex/index.js";
import { AppServerConnection } from "../../dist/executors/codex/rpc.js";
import { createExecutor as createPiExecutor } from "../../dist/executors/pi/index.js";
import { createStubCli, drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { stubScripts } from "../fixtures/executors/claude/harness.mjs";
import {
	loadTranscript,
	PROBE_SCRIPTS,
	replaySteps,
} from "../fixtures/executors/pi/harness.mjs";

const FAKE_AGENT = fileURLToPath(
	new URL("../fixtures/executors/acp/fake-acp-agent.mjs", import.meta.url),
);

async function tempDir(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-prune-admit-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	return dir;
}

function request(dir, attemptKey, overrides = {}) {
	return {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd: dir,
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

/**
 * Let a scheduled background prune reach its stamp write: it chains stat -> utimes -> writeFile on the fs threadpool,
 * which event-loop turns alone do not wait for, so round-trip real fs calls (and a short timer) a few dozen times.
 */
async function settleBackground() {
	for (let i = 0; i < 40; i++) {
		await stat(tmpdir());
		await new Promise((r) => setImmediate(r));
	}
	await new Promise((r) => setTimeout(r, 25));
}

async function stampAppears(stateDir) {
	const deadline = Date.now() + 30_000;
	while (!existsSync(join(stateDir, ".prune-stamp")) && Date.now() < deadline)
		await new Promise((r) => setTimeout(r, 5));
	return existsSync(join(stateDir, ".prune-stamp"));
}

function mockSpawn(t, implementation) {
	const mock = t.mock.method(childProcess, "spawn", implementation);
	syncBuiltinESMExports();
	t.after(() => {
		mock.mock.restore();
		syncBuiltinESMExports();
	});
	return mock;
}

// --- codex -----------------------------------------------------------------------------------------------

async function codexSetup(t) {
	const dir = await tempDir(t);
	const userHome = join(dir, "user");
	await mkdir(userHome);
	await writeFile(join(userHome, "auth.json"), "{}");
	const stateDir = join(dir, "state");
	await mkdir(stateDir);
	return {
		dir,
		stateDir,
		req: (attemptKey, overrides = {}) =>
			request(dir, attemptKey, {
				env: { CODEX_HOME: userHome },
				...overrides,
			}),
		executor: createCodexExecutor({ stateDir }),
	};
}

test("codex: a submit refused before launch schedules no background prune", async (t) => {
	const { stateDir, req, executor } = await codexSetup(t);
	const launch = mockSpawn(t, () => {
		throw new Error("unexpected app-server launch");
	});
	await assert.rejects(
		executor.submit(req("refused", { resumeSessionId: "foreign-thread" })),
		{ code: "CAPABILITY_MISSING" },
	);
	await settleBackground();
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(existsSync(join(stateDir, ".prune-stamp")), false);
});

test("codex: an admitted launch schedules the background prune", async (t) => {
	const { stateDir, req, executor } = await codexSetup(t);
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		pid: 4242,
		kill: t.mock.fn(() => {
			child.exitCode = 0;
			setImmediate(() => child.emit("exit", 0, null));
			return true;
		}),
	});
	mockSpawn(t, () => child);
	t.mock.method(AppServerConnection.prototype, "request", async () => {
		throw new Error("handshake stub");
	});
	const ref = await executor.submit(req("admitted"));
	assert.equal(await stampAppears(stateDir), true);
	await drain(executor, ref, { timeoutMs: 15_000 });
	child.stdout.end();
	child.stderr.end();
	child.emit("close", 0, null);
	await settleBackground();
});

// --- claude ----------------------------------------------------------------------------------------------

async function claudeSetup(t) {
	const dir = await tempDir(t);
	const cli = await createStubCli({
		dir,
		name: "claude",
		scripts: stubScripts("complete"),
	});
	const stateDir = join(dir, "state");
	const config = parseClaudeConfig({
		claudePath: cli.path,
		stateDir,
		claudeConfigDir: join(dir, "claude-config"),
		killGraceMs: 200,
	});
	return { dir, cli, stateDir, executor: createClaudeExecutor({ config }) };
}

test("claude: a submit refused before launch schedules no background prune", async (t) => {
	const { dir, cli, stateDir, executor } = await claudeSetup(t);
	await mkdir(stateDir, { recursive: true });
	await assert.rejects(
		executor.submit(request(dir, "refused", { tools: ["telepathy"] })),
		{ code: "CAPABILITY_MISSING" },
	);
	await settleBackground();
	assert.equal(await cli.effectCount(), 0);
	assert.equal(existsSync(join(stateDir, ".prune-stamp")), false);
});

test("claude: an admitted launch schedules the background prune", async (t) => {
	const { dir, stateDir, executor } = await claudeSetup(t);
	const ref = await executor.submit(request(dir, "admitted"));
	await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(await stampAppears(stateDir), true);
});

// --- pi --------------------------------------------------------------------------------------------------

async function piSetup(t) {
	const dir = await tempDir(t);
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
	const stateDir = join(dir, "state");
	return {
		dir,
		cli,
		stateDir,
		executor: createPiExecutor({ piCommand: cli.path, stateDir }),
	};
}

test("pi: a submit refused (revoked authority) before launch schedules no background prune", async (t) => {
	const { dir, cli, stateDir, executor } = await piSetup(t);
	await mkdir(stateDir, { recursive: true });
	const gate = createAuthorityGate({ attemptKey: "refused" });
	gate.revoke("test");
	await assert.rejects(
		executor.submit(request(dir, "refused", { authority: gate.authority })),
		{ code: "AUTHORITY_REVOKED" },
	);
	await settleBackground();
	assert.equal(await cli.effectCount(), 0);
	assert.equal(existsSync(join(stateDir, ".prune-stamp")), false);
});

test("pi: an admitted launch schedules the background prune", async (t) => {
	const { dir, stateDir, executor } = await piSetup(t);
	const ref = await executor.submit(request(dir, "admitted"));
	await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(await stampAppears(stateDir), true);
});

// --- acp -------------------------------------------------------------------------------------------------

async function acpSetup(t) {
	const dir = await tempDir(t);
	const command = join(dir, "fake-agent");
	await writeFile(
		command,
		`#!/bin/sh\nFAKE_ACP_SCENARIO=complete exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@"\n`,
		{ mode: 0o755 },
	);
	const stateDir = join(dir, "state");
	const config = parseAcpConfig({
		preset: "gemini",
		command,
		stateDir,
		killGraceMs: 200,
		handshakeTimeoutMs: 60_000,
	});
	return { dir, stateDir, executor: createAcpExecutor({ config }) };
}

test("acp: a submit refused before launch schedules no background prune", async (t) => {
	const { dir, stateDir, executor } = await acpSetup(t);
	await mkdir(stateDir, { recursive: true });
	await assert.rejects(
		executor.submit(
			request(dir, "refused", {
				permissionMode: "safe",
				mcpServers: [{ name: "other", command: "/bin/echo", args: [] }],
			}),
		),
		/may mutate \(other\)/,
	);
	await settleBackground();
	assert.equal(existsSync(join(stateDir, ".prune-stamp")), false);
});

test("acp: an admitted launch schedules the background prune", async (t) => {
	const { dir, stateDir, executor } = await acpSetup(t);
	const ref = await executor.submit(
		request(dir, "admitted", {
			permissionMode: "free",
			artifactsDir: join(dir, "artifacts", "admitted"),
		}),
	);
	await drain(executor, ref, { timeoutMs: 90_000 });
	assert.equal(await stampAppears(stateDir), true);
});
