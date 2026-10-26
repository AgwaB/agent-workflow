// Live tier for the codex adapter (WP7). Skipped unless AGENT_WORKFLOW_LIVE=1. Each run costs
// model calls (one smoke + six for the kit's live checks), so run it deliberately and record the
// result in docs/executors/codex.md and test/fixtures/executors/codex/live-calls.md.
//
// Must run with the real environment (the user's codex login): `AGENT_WORKFLOW_LIVE=1 node --test
// test/unit/executor-codex-live.test.mjs` after `npm run build`. Under test/run-unit.mjs the home
// directory is isolated, the CLI reports no login and the test skips.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	createAuthorityGate,
	defaultApprovalPolicy,
	validateEventSequence,
} from "../../dist/sdk/index.js";
import { runConformance } from "../../dist/sdk/conformance/index.js";
import { createExecutor } from "../../dist/executors/codex/index.js";
import { createCodexLiveHarness } from "../fixtures/executors/codex/harness.mjs";

const LIVE = process.env.AGENT_WORKFLOW_LIVE === "1";
const MODEL = process.env.AGENT_WORKFLOW_CODEX_LIVE_MODEL ?? "gpt-5.6-luna";

function loggedIn() {
	const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
	return (
		result.status === 0 &&
		/logged in/i.test(`${result.stdout}${result.stderr}`) &&
		!/not logged in/i.test(`${result.stdout}${result.stderr}`)
	);
}

const skip = !LIVE
	? "set AGENT_WORKFLOW_LIVE=1 to run live codex checks (costs model calls)"
	: !loggedIn()
		? "codex CLI is not logged in for this HOME (run outside test/run-unit.mjs)"
		: false;

test("codex live smoke: read-only turn completes with usage and no cost", {
	skip,
}, async () => {
	const dir = mkdtempSync("/tmp/aw-live-codex-smoke-test-");
	writeFileSync(join(dir, "a.txt"), "live smoke\n");
	const executor = createExecutor({ stateDir: join(dir, ".state") });
	const attemptKey = `live-smoke-${Date.now()}`;
	const gate = createAuthorityGate({ attemptKey });
	const ref = await executor.submit({
		attemptKey,
		authority: gate.authority,
		cwd: dir,
		prompt: "Read a.txt and reply with its exact contents only.",
		model: MODEL,
		effort: "low",
		tools: ["read"],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 300_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		artifactsDir: join(dir, "artifacts"),
	});
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	assert.deepEqual(validateEventSequence(events), []);
	const terminal = events.at(-1);
	assert.equal(terminal.type, "completed", JSON.stringify(terminal));
	assert.match(terminal.finalText, /live smoke/);
	const usage = events.find((event) => event.type === "usage");
	assert.ok(usage !== undefined && usage.input > 0 && usage.cost === null);
	assert.ok(
		readdirSync(join(dir, "artifacts")).includes("codex-app-server.jsonl"),
	);
});

test("codex live: conformance kit live tier", { skip }, async () => {
	const stateDir = mkdtempSync("/tmp/aw-live-codex-kit-state-");
	const report = await runConformance(
		createCodexLiveHarness({ model: MODEL, effort: "low", stateDir }),
		{
			tiers: ["live"],
			only: ["live."],
			timeouts: {
				callMs: 60_000,
				streamMs: 120_000,
				liveStreamMs: 300_000,
				checkMs: 600_000,
			},
		},
	);
	const out = process.env.AGENT_WORKFLOW_CODEX_LIVE_REPORT;
	if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
	// D3: delete the threads the session checks kept (thread/delete, no model turn).
	const executor = createExecutor({ stateDir });
	const deleted = [];
	for (const file of readdirSync(join(stateDir, "attempts")).filter((name) =>
		name.endsWith(".json"),
	)) {
		const record = JSON.parse(
			readFileSync(join(stateDir, "attempts", file), "utf8"),
		);
		if (record.ref?.sessionId !== undefined)
			deleted.push(
				await executor.deleteOwnedSession({
					kind: "codex-thread",
					locator: record.ref.sessionId,
				}),
			);
	}
	console.log(
		JSON.stringify({
			summary: report.summary,
			deleted,
			results: report.results.map((r) => [
				r.id,
				r.status,
				r.violations,
				r.reason ?? null,
			]),
		}),
	);
	assert.deepEqual(
		report.results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
});
