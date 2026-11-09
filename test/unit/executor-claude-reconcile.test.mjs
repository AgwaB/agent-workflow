// test-tier: integration
// New in agent-workflow (WP37 item 3, parity §3.2 "Claude sessionBound reconcile"): when the worker
// process that owns a Claude CLI dies, the CLI's stdio and control protocol die with it. A fresh
// process cannot re-attach (sessionBound) and, unless the raw stream recorded a result, cannot know
// how the attempt ended. Per B3 the adapter reports that as `unknown` with a reason, and the runtime
// records failed/needs_decision (never an automatic relaunch). A launched attempt whose raw stream
// holds a result stays `found` (the kit's reconcile.found), and the owning instance reports `found`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { RAW_STREAM_FILE } from "../../dist/executors/claude/executor.js";
import {
	createStubCli,
	drain,
	runConformance,
} from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import {
	createClaudeStubHarness,
	stubScripts,
} from "../fixtures/executors/claude/harness.mjs";
import { UNIT_CONFORMANCE_TIMEOUTS } from "../fixtures/conformance-timeouts.mjs";

async function setup(t, scenario) {
	const dir = await mkdtemp(join(tmpdir(), "aw-wp37-claude-reconcile-"));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
	const cli = await createStubCli({
		dir,
		name: "claude",
		scripts: stubScripts(scenario),
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
		artifactsDir: join(cwd, "artifacts"),
	};
}

test("a running attempt seen from another process reconciles unknown with a reason (B3)", async (t) => {
	const { dir, config } = await setup(t, "slow");
	const owner = createClaudeExecutor({ config });
	const attemptKey = "wp37-reconcile-running";
	const ref = await owner.submit(request(dir, attemptKey));
	try {
		// The owning instance holds the stdio: found.
		assert.deepEqual(await owner.reconcile(attemptKey), { found: ref });
		// A fresh process (the worker that owned the CLI is gone): no result recorded → unknown.
		const fresh = createClaudeExecutor({ config });
		const reconciled = await fresh.reconcile(attemptKey);
		assert.equal(reconciled.unknown, true, JSON.stringify(reconciled));
		assert.equal("found" in reconciled, false);
		assert.match(reconciled.reason, new RegExp(ref.handle, "u"));
		assert.match(reconciled.reason, /session-bound/u);
		assert.match(reconciled.reason, /no result was recorded/u);
		assert.match(
			reconciled.reason,
			/needs an owner decision, no automatic relaunch \(B3\)/u,
		);
	} finally {
		await owner.cancel(ref, "owned");
		await drain(owner, ref, { timeoutMs: 15_000 }).catch(() => undefined);
	}
});

test("a launched attempt whose raw stream recorded a result stays found in a fresh process", async (t) => {
	const { dir, config } = await setup(t, "complete");
	const owner = createClaudeExecutor({ config });
	const attemptKey = "wp37-reconcile-complete";
	const ref = await owner.submit(request(dir, attemptKey));
	// The raw stream is flushed before the terminal event: a worker that exits right after it
	// leaves a result that another process can see (else this reconcile raced the flush).
	const artifactsDir = join(dir, "artifacts");
	let rawAtTerminal;
	for await (const event of owner.observe(ref))
		if (event.type === "completed" || event.type === "failed") {
			rawAtTerminal = readFileSync(join(artifactsDir, RAW_STREAM_FILE), "utf8");
			break;
		}
	assert.match(rawAtTerminal, /"type":"result"/u);
	const fresh = createClaudeExecutor({ config });
	assert.deepEqual(await fresh.reconcile(attemptKey), { found: ref });
	assert.deepEqual(await fresh.reconcile("wp37-never-submitted"), {
		absent: true,
	});
});

test("runtime: a killed Claude worker is marked needs_decision with the adapter's reason, never relaunched", {
	timeout: 600_000,
}, async () => {
	const report = await runConformance(createClaudeStubHarness(), {
		tiers: ["runtime"],
		only: ["runtime.durable_authority"],
		timeouts: UNIT_CONFORMANCE_TIMEOUTS,
	});
	const result = report.results.find(
		(entry) => entry.id === "runtime.durable_authority",
	);
	assert.equal(result.status, "pass", JSON.stringify(result.violations));
	assert.equal(result.details.kill, "marked-needs-decision/unknown");
});
