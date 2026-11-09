// WP12d-2 review #9: worker session deletion requires durable ownership evidence. The Codex adapter
// deletes only threads it created and recorded; resuming a thread it did not create never marks
// it owned. The Claude adapter follows the same rule for resumed sessions.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
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
	// Round 3: every test runs against a temporary user CODEX_HOME, never the real one.
	const userHome = join(dir, "user-codex");
	await mkdir(userHome, { recursive: true });
	await writeFile(join(userHome, "auth.json"), "{}");
	await writeFile(join(userHome, "AGENTS.md"), "global instructions");
	const previousHome = process.env.CODEX_HOME;
	process.env.CODEX_HOME = userHome;
	t.after(() => {
		if (previousHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousHome;
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
	return { dir, config, deletes, userHome, log };
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
	// A foreign thread lives in the user's home: it resumes with inherited context (round 3).
	const ref = await executor.submit(
		request(dir, "codex-resume-foreign", {
			resumeSessionId: "user-thread-1",
			isolation: { inherit: true },
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
	const { dir, config, deletes, userHome } = await codexSetup(t);
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

test("round 3 (codex): an isolated resume of a thread without a private home is refused before launch", async (t) => {
	// gpt-6-astra: foreign threads, records without a home and removed homes resumed in the user's home, loading
	// the global instructions the probe said isolated workers do not get.
	const { dir, config, log } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	await assert.rejects(
		executor.submit(
			request(dir, "codex-resume-isolated", {
				resumeSessionId: "user-thread-2",
			}),
		),
		(error) =>
			error.code === "CAPABILITY_MISSING" &&
			/isolation\.inherit/.test(error.message),
	);
	assert.equal(existsSync(log), false, "no app-server was started");
	// a kept thread whose private home is gone is refused the same way
	const kept = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-gone", { sessionId: "keep-gone" }),
		),
		{ timeoutMs: 15_000 },
	);
	const homes = join(config.stateDir, "session-homes");
	await rm(homes, { recursive: true, force: true });
	await assert.rejects(
		executor.submit(
			request(dir, "codex-resume-gone", {
				resumeSessionId: kept.terminal.ownedSession.locator,
			}),
		),
		(error) => error.code === "CAPABILITY_MISSING",
	);
});

test("round 3 (codex): a kept-session launch that fails before a thread exists leaves no home", async (t) => {
	const { dir, config } = await codexSetup(t);
	const executor = createCodexExecutor({
		...config,
		codexPath: join(dir, "missing-codex"),
	});
	const { terminal } = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-fails", { sessionId: "keep-fails" }),
		),
		{ timeoutMs: 15_000 },
	);
	assert.equal(terminal.type, "failed");
	const homes = join(config.stateDir, "session-homes");
	for (
		let i = 0;
		i < 50 && existsSync(homes) && readdirSync(homes).length > 0;
		i += 1
	)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(existsSync(homes) ? readdirSync(homes) : [], []);
});

test("round 3 (codex): deleting a session while an app-server runs in its home fails and keeps the home", async (t) => {
	// gpt-6-astra: a fresh executor deleted the home under two running resumes.
	const { dir, config, deletes, log } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const kept = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-busy", { sessionId: "keep-busy" }),
		),
		{ timeoutMs: 15_000 },
	);
	const owned = kept.terminal.ownedSession;
	const keptHome = (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((message) => message.method === "initialize").codexHome;
	const resumed = await executor.submit(
		request(dir, "codex-resume-busy", {
			resumeSessionId: owned.locator,
			env: { FAKE_CODEX_TURN_DELAY_MS: "7000" },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		await createCodexExecutor(config).deleteOwnedSession(owned),
		"failed",
	);
	assert.equal(existsSync(keptHome), true);
	assert.deepEqual(await deletes(), []);
	const second = await drain(executor, resumed, { timeoutMs: 15_000 });
	assert.equal(second.terminal.type, "completed");
	for (
		let i = 0;
		i < 50 &&
		(await createCodexExecutor(config).deleteOwnedSession(owned)) === "failed";
		i += 1
	)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(await deletes(), [owned.locator]);
	assert.equal(existsSync(keptHome), false);
});

test("round 4 (codex): a resume started while the session is being deleted is refused, and deletion completes", async (t) => {
	// gpt-6-astra: a resume that started after thread/delete was sent ran in a home the deletion then removed.
	const { dir, config, deletes, log } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const kept = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-fence", { sessionId: "keep-fence" }),
		),
		{ timeoutMs: 15_000 },
	);
	const owned = kept.terminal.ownedSession;
	const keptHome = (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((message) => message.method === "initialize").codexHome;
	process.env.FAKE_CODEX_DELETE_DELAY_MS = "1500";
	t.after(() => {
		delete process.env.FAKE_CODEX_DELETE_DELAY_MS;
	});
	const deleting = createCodexExecutor(config).deleteOwnedSession(owned);
	for (let i = 0; i < 100 && !(await deletes()).length; i += 1)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(
		await deletes(),
		[owned.locator],
		"thread/delete is pending",
	);
	await assert.rejects(
		executor.submit(
			request(dir, "codex-resume-during-delete", {
				resumeSessionId: owned.locator,
			}),
		),
		(error) =>
			error.code === "INVALID_REQUEST" && /being deleted/.test(error.message),
	);
	assert.equal(await deleting, "deleted");
	assert.equal(existsSync(keptHome), false);
});

test("round 4 (codex): deletion removes the home only after its server exited", async (t) => {
	// gpt-6-astra: after SIGKILL the home went at once, while the server could still be alive.
	const { dir, config, log } = await codexSetup(t);
	const executor = createCodexExecutor(config);
	const kept = await drain(
		executor,
		await executor.submit(
			request(dir, "codex-keep-linger", { sessionId: "keep-linger" }),
		),
		{ timeoutMs: 15_000 },
	);
	process.env.FAKE_CODEX_LINGER_MS = "60000";
	t.after(() => {
		delete process.env.FAKE_CODEX_LINGER_MS;
	});
	assert.equal(
		await createCodexExecutor(config).deleteOwnedSession(
			kept.terminal.ownedSession,
		),
		"deleted",
	);
	const servers = (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((message) => message.method === "initialize");
	const deletionPid = servers.at(-1).pid;
	let alive = true;
	try {
		process.kill(deletionPid, 0);
	} catch {
		alive = false;
	}
	assert.equal(
		alive,
		false,
		"the deletion server had exited when deletion returned",
	);
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
