// New in agent-workflow (WP19, stage-2 review #2): retention never turns a launched attempt into
// "absent". For every adapter an old launched attempt record is pruned, then a fresh executor
// reconciles the attemptKey: it is never `absent` (that would let an orphaned workflow record
// not_started and retry it automatically), submit refuses before consuming the authority, and a
// second retention pass keeps the tombstone. Never-launched (revoked) records still go.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	classifyClaudeAttemptRecord,
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import {
	createCodexExecutor,
	attemptDigest as codexDigest,
} from "../../dist/executors/codex/index.js";
import { createPiExecutor } from "../../dist/executors/pi/index.js";
import {
	classifyPiAttemptRecord,
	attemptDigest as piDigest,
} from "../../dist/executors/pi/state.js";
import { classifyCodexAttemptRecord } from "../../dist/executors/codex/state.js";
import { pruneAdapterAttemptState } from "../../dist/executors/state-retention.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

const OLD = Date.now() - 30 * 86_400_000;
const DEAD_PID = 2 ** 22 + 4_321;

const ADAPTERS = {
	claude: {
		create: (stateDir) =>
			createClaudeExecutor({
				config: parseClaudeConfig({
					claudePath: "/nonexistent/claude",
					stateDir,
					claudeConfigDir: join(stateDir, "claude-config"),
				}),
			}),
		base: (key) => createHash("sha256").update(key).digest("hex").slice(0, 40),
		classify: () => classifyClaudeAttemptRecord,
		digest: 40,
		launched: (key) => ({
			schema: "agent-workflow-claude-attempt-v1",
			attemptKey: key,
			phase: "spawned",
			sessionId: null,
			keepSession: false,
			pid: DEAD_PID,
			ref: { executorId: "claude", attemptKey: key, handle: `pid:${DEAD_PID}` },
			updatedAt: new Date(OLD).toISOString(),
		}),
		revoked: (key) => ({
			schema: "agent-workflow-claude-attempt-v1",
			attemptKey: key,
			phase: "revoked",
			sessionId: null,
			keepSession: false,
			updatedAt: new Date(OLD).toISOString(),
		}),
	},
	codex: {
		create: (stateDir) =>
			createCodexExecutor({ codexPath: "/nonexistent/codex", stateDir }),
		base: (key) => codexDigest(key),
		classify: () => classifyCodexAttemptRecord,
		digest: 32,
		launched: (key) => ({
			schema: "agent-workflow-codex-attempt-v1",
			attemptKey: key,
			phase: "terminal",
			terminal: "completed",
			pid: DEAD_PID,
			ref: { executorId: "codex", attemptKey: key, handle: "thread-1" },
			updatedAt: OLD,
		}),
		revoked: (key) => ({
			schema: "agent-workflow-codex-attempt-v1",
			attemptKey: key,
			phase: "revoked",
			updatedAt: OLD,
		}),
	},
	pi: {
		create: (stateDir) =>
			createPiExecutor({ piCommand: "/nonexistent/pi", stateDir }),
		base: (key) => piDigest(key),
		digest: 64,
		classify: (stateDir) => (record) =>
			classifyPiAttemptRecord(stateDir, record),
		launched: (key) => ({
			schema: "agent-workflow-pi-attempt-v1",
			attemptKey: key,
			phase: "exited",
			pid: DEAD_PID,
			exit: { exitCode: 0, signal: null, cancelled: false },
			ref: { executorId: "pi", attemptKey: key, handle: `pid:${DEAD_PID}` },
			updatedAt: new Date(OLD).toISOString(),
		}),
		revoked: (key) => ({
			schema: "agent-workflow-pi-attempt-v1",
			attemptKey: key,
			phase: "revoked",
			updatedAt: new Date(OLD).toISOString(),
		}),
	},
};

function request(cwd, attemptKey, gate) {
	return {
		attemptKey,
		authority: gate.authority,
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

for (const [name, adapter] of Object.entries(ADAPTERS)) {
	test(`review #2 (${name}): a pruned launched attempt never reconciles absent`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), `aw-wp19-tomb-${name}-`));
		t.after(() =>
			rm(dir, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		const stateDir = join(dir, "state");
		const attempts = join(stateDir, "attempts");
		await mkdir(attempts, { recursive: true });
		const key = `${name}-launched-1`;
		const revokedKey = `${name}-revoked-1`;
		const recordPath = join(attempts, `${adapter.base(key)}.json`);
		const revokedPath = join(attempts, `${adapter.base(revokedKey)}.json`);
		await writeFile(recordPath, JSON.stringify(adapter.launched(key)));
		await writeFile(revokedPath, JSON.stringify(adapter.revoked(revokedKey)));
		await writeFile(
			join(attempts, `${adapter.base(key)}.events.jsonl`),
			"{}\n",
		);
		for (const path of [
			recordPath,
			revokedPath,
			join(attempts, `${adapter.base(key)}.events.jsonl`),
		])
			await utimes(path, new Date(OLD), new Date(OLD));

		const before = await adapter.create(stateDir).reconcile(key);
		assert.equal("absent" in before, false, "launched record is found");

		const pruned = await pruneAdapterAttemptState({
			stateDir,
			classify: adapter.classify(stateDir),
			attemptDigestLength: adapter.digest,
		});
		assert.equal(pruned.prunedRecords, 2, JSON.stringify(pruned));
		assert.equal(
			existsSync(join(attempts, `${adapter.base(key)}.events.jsonl`)),
			false,
			"bulky companions go",
		);
		assert.equal(existsSync(revokedPath), false, "never-launched record goes");

		// A fresh process (new executor instance) reconciles after the prune.
		const executor = adapter.create(stateDir);
		const after = await executor.reconcile(key);
		assert.equal(
			"absent" in after,
			false,
			`pruned launched attempt reconciled absent: ${JSON.stringify(after)}`,
		);
		assert.equal(after.unknown, true, JSON.stringify(after));
		assert.match(after.reason, /pruned by retention/);
		// No automatic relaunch: submit refuses before consuming the authority.
		const gate = createAuthorityGate({ attemptKey: key });
		await assert.rejects(
			executor.submit(request(dir, key, gate)),
			(error) => error.code === "AUTHORITY_ALREADY_CONSUMED",
		);
		assert.equal(gate.state(), "pending");

		// The tombstone is compact and survives later passes.
		const tombstone = JSON.parse(await readFile(recordPath, "utf8"));
		assert.equal(tombstone.attemptKey, key);
		assert.ok(JSON.stringify(tombstone).length < 400);
		const again = await pruneAdapterAttemptState({
			stateDir,
			classify: adapter.classify(stateDir),
			attemptDigestLength: adapter.digest,
			nowMs: Date.now() + 365 * 86_400_000,
		});
		assert.equal(again.tombstones, 1);
		assert.ok(existsSync(recordPath));
		assert.deepEqual(await executor.reconcile(revokedKey), { absent: true });
	});
}

test("review #2 (codex): the tombstone keeps the known terminal outcome", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aw-wp19-tomb-outcome-"));
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const stateDir = join(dir, "state");
	const attempts = join(stateDir, "attempts");
	await mkdir(attempts, { recursive: true });
	const key = "codex-outcome-1";
	const path = join(attempts, `${codexDigest(key)}.json`);
	await writeFile(path, JSON.stringify(ADAPTERS.codex.launched(key)));
	await utimes(path, new Date(OLD), new Date(OLD));
	await pruneAdapterAttemptState({
		stateDir,
		classify: classifyCodexAttemptRecord,
		attemptDigestLength: 32,
	});
	const result = await ADAPTERS.codex.create(stateDir).reconcile(key);
	assert.equal(result.unknown, true);
	assert.match(result.reason, /last known outcome: completed/);
});
