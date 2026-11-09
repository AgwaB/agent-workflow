// WP12d-2 review #9: worker session deletion requires durable ownership evidence. The Codex adapter
// deletes only threads it created and recorded; resuming a thread it did not create never marks
// it owned. The Claude adapter follows the same rule for resumed sessions.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("codex: a kept session keeps a private home that resume reuses and deletion removes", async (t) => {
	// Re-review 2026-11-09 (gpt-6-astra, claude-fable-5-1): the per-attempt private home was removed on close,
	// losing the kept thread; the first fix fell back to the user's home and lost isolation.
	const { dir, config, deletes } = await codexSetup(t);
	const userHome = join(dir, "user-codex");
	await mkdir(userHome, { recursive: true });
	await writeFile(join(userHome, "auth.json"), "{}");
	await writeFile(join(userHome, "AGENTS.md"), "global instructions");
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = userHome;
	t.after(() => {
		if (previous === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previous;
	});
	const homes = async () =>
		(await readFile(process.env.FAKE_CODEX_LOG, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((message) => message.method === "initialize")
			.map((message) => message.codexHome);
	const executor = createCodexExecutor(config);
	const kept = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-home", { sessionId: "keep-home-1" }),
		),
		{ timeoutMs: 15_000 },
	);
	assert.equal(kept.terminal.type, "completed");
	const [keptHome] = await homes();
	assert.ok(
		keptHome && keptHome !== userHome,
		`kept session ran in ${keptHome}`,
	);
	assert.equal(
		existsSync(join(keptHome, "auth.json")),
		true,
		"the private home survives the attempt",
	);
	assert.equal(
		existsSync(join(keptHome, "AGENTS.md")),
		false,
		"no global instructions in it",
	);
	const resumed = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-resume-home", {
				resumeSessionId: kept.terminal.ownedSession.locator,
			}),
		),
		{ timeoutMs: 15_000 },
	);
	assert.equal(resumed.terminal.type, "completed");
	assert.equal((await homes())[1], keptHome, "resume reuses the kept home");
	assert.equal(
		await createCodexExecutor(config).deleteOwnedSession(
			kept.terminal.ownedSession,
		),
		"deleted",
	);
	assert.equal((await homes())[2], keptHome, "deletion runs in the kept home");
	assert.deepEqual(await deletes(), [kept.terminal.ownedSession.locator]);
	assert.equal(
		existsSync(keptHome),
		false,
		"deleting the session removes its home",
	);
	// an ephemeral attempt's private home is still removed when it ends
	const ephemeral = await drain(
		executor,
		await executor.submit(request(dir, "codex-ephemeral-home")),
		{ timeoutMs: 15_000 },
	);
	assert.equal(ephemeral.terminal.type, "completed");
	const ephemeralHome = (await homes())[3];
	assert.ok(ephemeralHome && ephemeralHome !== userHome);
	for (let i = 0; i < 50 && existsSync(ephemeralHome); i += 1)
		await new Promise((r) => setTimeout(r, 20));
	assert.equal(existsSync(ephemeralHome), false);
});

test("review #9 (claude): resuming a foreign session does not make it owned", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-owner-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
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

test("codex: a Pi-qualified model (openai-codex/…) reaches the CLI as its bare id", async (t) => {
	// 2026-10-30 cross-host finding: legacy ~/.pi agents/workflows carry Pi provider prefixes.
	const { dir, config } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const ref = await executor.submit(
		request(dir, "codex-pi-model", { model: "openai-codex/gpt-6.1-sol" }),
	);
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "completed");
	const sent = (await readFile(process.env.FAKE_CODEX_LOG, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((message) =>
			["thread/start", "turn/start"].includes(message.method),
		)
		.map((message) => [message.method, message.params.model]);
	assert.deepEqual(sent, [
		["thread/start", "gpt-6.1-sol"],
		["turn/start", "gpt-6.1-sol"],
	]);
});
