// test-tier: integration
// WP12d-2 review #10: child process handlers are attached synchronously after spawn, before any
// await. An immediate spawn error (ENOENT) becomes a classified `failed` event instead of an
// uncaught exception, and a CLI that exits at once is still observed to a terminal event.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	ClaudeStateStore,
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createPiExecutor } from "../../dist/executors/pi/index.js";
import { PiAttemptStore } from "../../dist/executors/pi/state.js";
import { drain } from "../../dist/sdk/conformance/index.js";
import { waitUntil } from "../helpers/wait-until.mjs";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

function request(cwd, attemptKey) {
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
	};
}

function claude(dir, claudePath) {
	return createClaudeExecutor({
		config: parseClaudeConfig({
			claudePath,
			stateDir: join(dir, "state"),
			claudeConfigDir: join(dir, "claude-config"),
			killGraceMs: 200,
		}),
	});
}

test("review #10 (claude): an immediate spawn error is a failed event, not a crash", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-spawn-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const executor = claude(dir, join(dir, "missing-claude"));
	const ref = await executor.submit(request(dir, "claude-enoent-1"));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "failed");
	assert.match(terminal.message, /ENOENT|not found|spawn/iu);
});

test("review #10 (claude): a CLI that exits at once reaches a terminal event", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-fast-exit-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const path = join(dir, "claude");
	await writeFile(path, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
	const executor = claude(dir, path);
	const ref = await executor.submit(request(dir, "claude-fast-exit-1"));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "failed");
});

test("review #10 (pi): a CLI that exits at once reaches a terminal event", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-fast-exit-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const path = join(dir, "pi");
	await writeFile(path, "#!/bin/sh\necho boom >&2\nexit 3\n", { mode: 0o755 });
	const executor = createPiExecutor({
		piCommand: path,
		stateDir: join(dir, "state"),
	});
	const ref = await executor.submit(request(dir, "pi-fast-exit-1"));
	const { terminal } = await drain(executor, ref, { timeoutMs: 15_000 });
	assert.equal(terminal.type, "failed");
	assert.match(JSON.stringify(terminal), /boom/u);
	const reconciled = await createPiExecutor({
		piCommand: path,
		stateDir: join(dir, "state"),
	}).reconcile("pi-fast-exit-1");
	assert.deepEqual(reconciled, { found: ref });
});

/**
 * Hold the durable `spawned` write until the child has exited: handlers attached after it would miss the exit.
 * Resolves once that late write has landed. (2026-11-10: was a fixed 400 ms, then 600 ms for the late write.)
 */
function slowSpawnedWrite(t, proto, method) {
	const original = proto[method];
	let delayed = false;
	let landed;
	const written = new Promise((resolve) => {
		landed = resolve;
	});
	proto[method] = async function (record) {
		if (record.phase !== "spawned" || delayed)
			return original.call(this, record);
		delayed = true;
		await waitUntil(() => {
			try {
				process.kill(record.pid, 0);
				return false;
			} catch {
				return true;
			}
		}, "the child to exit");
		try {
			return await original.call(this, record);
		} finally {
			landed();
		}
	};
	t.after(() => {
		proto[method] = original;
	});
	return written;
}

test("review #10 (claude): an exit during the durable spawned write is observed", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-slow-write-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	slowSpawnedWrite(t, ClaudeStateStore.prototype, "writeAttempt");
	const path = join(dir, "claude");
	await writeFile(path, "#!/bin/sh\necho early-exit >&2\nexit 3\n", {
		mode: 0o755,
	});
	const executor = claude(dir, path);
	const ref = await executor.submit(request(dir, "claude-slow-write-1"));
	// 15 s like the fast-exit tests: a missed exit never ends the drain; a busy machine (the whole
	// suite in parallel) measured over 5 s for an observed one.
	const { terminal, timedOut } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	assert.notEqual(timedOut, true, "terminal event observed");
	assert.equal(terminal?.type, "failed");
	assert.match(JSON.stringify(terminal), /early-exit/u);
});

test("review #10 (pi): an exit during the durable spawned write is observed", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-pi-slow-write-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const lateWrite = slowSpawnedWrite(t, PiAttemptStore.prototype, "write");
	const path = join(dir, "pi");
	await writeFile(path, "#!/bin/sh\necho early-exit >&2\nexit 3\n", {
		mode: 0o755,
	});
	const executor = createPiExecutor({
		piCommand: path,
		stateDir: join(dir, "state"),
	});
	const ref = await executor.submit(request(dir, "pi-slow-write-1"));
	// 15 s like the fast-exit tests: a missed exit never ends the drain; a busy machine (the whole
	// suite in parallel) measured over 5 s for an observed one.
	const { terminal, timedOut } = await drain(executor, ref, {
		timeoutMs: 15_000,
	});
	assert.notEqual(timedOut, true, "terminal event observed");
	assert.equal(terminal?.type, "failed");
	assert.match(JSON.stringify(terminal), /early-exit/u);
	// The exited record is not overwritten by the late spawned write (once that has landed, the record ends exited).
	await lateWrite;
	await waitUntil(
		() => new PiAttemptStore(join(dir, "state")).read("pi-slow-write-1"),
		"the exited record",
		{ accepts: (record) => record?.phase === "exited" },
	);
	const reconciled = await createPiExecutor({
		piCommand: path,
		stateDir: join(dir, "state"),
	}).reconcile("pi-slow-write-1");
	assert.deepEqual(reconciled, { found: ref });
});
