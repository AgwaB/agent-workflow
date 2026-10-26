// WP6 live tier (real `pi`, real model; costs money). Skipped unless AGENT_WORKFLOW_LIVE=1.
// Run it outside test/run-unit.mjs, which isolates HOME (Pi needs the user's own login, D1):
//   AGENT_WORKFLOW_LIVE=1 [AGENT_WORKFLOW_LIVE_PI_MODEL=google/gemini-2.5-flash-lite] \
//   [AGENT_WORKFLOW_LIVE_REPORT=/tmp/pi-live.json] node --test test/unit/executor-pi-live.test.mjs
// One smoke run + the kit's live checks = 7 Pi invocations with a model turn.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createExecutor } from "../../dist/executors/pi/index.js";
import { runConformance } from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
	validateEventSequence,
} from "../../dist/sdk/index.js";
import {
	createPiLiveHarness,
	LIVE_TMP,
} from "../fixtures/executors/pi/harness.mjs";

const MODEL =
	process.env.AGENT_WORKFLOW_LIVE_PI_MODEL ?? "google/gemini-2.5-flash-lite";
const skip =
	process.env.AGENT_WORKFLOW_LIVE !== "1"
		? "set AGENT_WORKFLOW_LIVE=1 to run live Pi checks (model calls)"
		: /aw-unit-home-/u.test(process.env.HOME ?? "")
			? "live Pi checks need the real HOME (run with node --test, not test/run-unit.mjs)"
			: false;

test("live smoke: read tool + answer through the Pi executor", {
	skip,
}, async () => {
	const dir = await mkdtemp(join(LIVE_TMP, "aw-live-pi-smoke-"));
	await writeFile(join(dir, "notes.txt"), "alpha bravo charlie\n");
	const executor = createExecutor({ stateDir: join(dir, ".state") });
	const attemptKey = `live-smoke-${Date.now()}`;
	const gate = createAuthorityGate({ attemptKey });
	const ref = await executor.submit({
		attemptKey,
		authority: gate.authority,
		cwd: dir,
		prompt:
			"Use the read tool to read notes.txt, then reply with only the second word of that file.",
		model: MODEL,
		effort: "minimal",
		tools: ["read"],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 300_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		artifactsDir: join(dir, "attempt"),
	});
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	assert.deepEqual(validateEventSequence(events), []);
	const terminal = events.at(-1);
	assert.equal(terminal.type, "completed", JSON.stringify(terminal));
	assert.match(terminal.finalText.toLowerCase(), /bravo/u);
	assert.ok(
		events.some(
			(event) =>
				event.type === "tool_call" &&
				event.name === "read" &&
				event.status === "completed",
		),
	);
});

test("live conformance checks (kit live tier)", { skip }, async () => {
	const report = await runConformance(createPiLiveHarness({ model: MODEL }), {
		tiers: ["live"],
		only: ["live."],
	});
	if (process.env.AGENT_WORKFLOW_LIVE_REPORT)
		writeFileSync(
			process.env.AGENT_WORKFLOW_LIVE_REPORT,
			`${JSON.stringify(report, null, 1)}\n`,
		);
	assert.deepEqual(
		report.results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
});
