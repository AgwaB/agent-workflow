// test-tier: integration
// WP12d-2 review #2: Claude attempt claims are exclusive across executor instances. Two instances
// with one stateDir and attemptKey (separate released authorities) must launch at most once, and
// an existing claim is resolved (same ref / named refusal) instead of overwritten.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { createStubCli, drain } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { stubScripts } from "../fixtures/executors/claude/harness.mjs";

async function setup(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-claude-claim-"));
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
	return { dir, cli, config };
}

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

test("review #2: concurrent submits from two instances launch once", async (t) => {
	const { dir, cli, config } = await setup(t);
	const a = createClaudeExecutor({ config });
	const b = createClaudeExecutor({ config });
	const attemptKey = "claim-race-1";
	const settled = await Promise.allSettled([
		a.submit(request(dir, attemptKey)),
		b.submit(request(dir, attemptKey)),
	]);
	const refs = settled.filter((entry) => entry.status === "fulfilled");
	assert.ok(refs.length >= 1, "one submit launches");
	for (const entry of settled)
		if (entry.status === "rejected")
			assert.equal(entry.reason.code, "AUTHORITY_ALREADY_CONSUMED");
	const winner = settled.findIndex((entry) => entry.status === "fulfilled");
	await drain(winner === 0 ? a : b, refs[0].value, { timeoutMs: 15_000 });
	assert.equal(await cli.effectCount(), 1, "exactly one CLI launch");
});

test("review #2: an existing claim is never overwritten by a later instance", async (t) => {
	const { dir, cli, config } = await setup(t);
	const attemptKey = "claim-existing-1";
	const a = createClaudeExecutor({ config });
	const ref = await a.submit(request(dir, attemptKey));
	await drain(a, ref, { timeoutMs: 15_000 });
	const store = join(config.stateDir, "attempts");
	const recordPath = join(
		store,
		readdirSync(store).find((name) => name.endsWith(".json")),
	);
	const before = await readFile(recordPath, "utf8");
	const b = createClaudeExecutor({ config });
	assert.deepEqual(await b.submit(request(dir, attemptKey)), ref);
	assert.deepEqual(await b.reconcile(attemptKey), { found: ref });
	assert.equal(await readFile(recordPath, "utf8"), before);
	assert.equal(await cli.effectCount(), 1);
});
