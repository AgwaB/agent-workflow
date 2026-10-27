// WP12d-2 review #9: worker session deletion requires durable ownership evidence. The Codex adapter
// deletes only threads it created and recorded; resuming a thread it did not create never marks
// it owned. The Claude adapter follows the same rule for resumed sessions.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
import { createStubCli, drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { stubScripts } from "../fixtures/executors/claude/harness.mjs";

const FAKE_CODEX = fileURLToPath(
	new URL(
		"../fixtures/executors/codex/fake-echo-app-server.mjs",
		import.meta.url,
	),
);

function request(cwd, attemptKey, overrides = {}) {
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

async function codexSetup(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-codex-owner-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
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
	const config = { codexPath, stateDir: join(dir, "state") };
	const deletes = async () => {
		if (!existsSync(log)) return [];
		return (await readFile(log, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((message) => message.method === "thread/delete")
			.map((message) => message.params.threadId);
	};
	return { dir, config, deletes };
}

test("review #9 (codex): an unrecorded thread is never deleted", async (t) => {
	const { config, deletes } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	assert.equal(
		await executor.deleteOwnedSession({
			kind: "codex-thread",
			locator: "unrelated-user-thread",
		}),
		"refused",
	);
	assert.deepEqual(await deletes(), []);
});

test("review #9 (codex): resuming a foreign thread does not make it owned", async (t) => {
	const { dir, config, deletes } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const ref = await executor.submit(
		request(dir, "codex-resume-foreign", {
			resumeSessionId: "user-thread-1",
		}),
	);
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "completed");
	assert.equal(terminal.ownedSession, undefined);
	const fresh = createCodexExecutor(config);
	assert.equal(
		await fresh.deleteOwnedSession({
			kind: "codex-thread",
			locator: "user-thread-1",
		}),
		"refused",
	);
	assert.deepEqual(await deletes(), []);
});

test("review #9 (codex): a kept thread the adapter created is deletable once", async (t) => {
	const { dir, config, deletes } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const ref = await executor.submit(
		request(dir, "codex-keep-own", { sessionId: "keep-1" }),
	);
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "completed");
	const owned = terminal.ownedSession;
	assert.equal(owned?.kind, "codex-thread");
	// Resuming an owned thread keeps it owned.
	const resumed = await executor.submit(
		request(dir, "codex-resume-own", { resumeSessionId: owned.locator }),
	);
	const second = await drain(executor, resumed, { timeoutMs: 15_000 });
	assert.deepEqual(second.terminal.ownedSession, owned);
	const fresh = createCodexExecutor(config);
	assert.equal(await fresh.deleteOwnedSession(owned), "deleted");
	assert.deepEqual(await deletes(), [owned.locator]);
	assert.equal(await fresh.deleteOwnedSession(owned), "refused");
});

test("review #9 (claude): resuming a foreign session does not make it owned", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-owner-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cli = await createStubCli({
		dir,
		name: "claude",
		scripts: stubScripts("complete"),
	});
	const config = parseClaudeConfig({
		claudePath: cli.path,
		stateDir: join(dir, "state"),
		claudeConfigDir: join(dir, "claude-config"),
		killGraceMs: 200,
	});
	const executor = createClaudeExecutor({ config });
	const foreign = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	const ref = await executor.submit(
		request(dir, "claude-resume-foreign", { resumeSessionId: foreign }),
	);
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.ownedSession, undefined);
	assert.equal(
		await executor.deleteOwnedSession({
			kind: "claude-session",
			locator: foreign,
		}),
		"refused",
	);
});
