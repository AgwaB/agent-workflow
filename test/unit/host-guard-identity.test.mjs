// test-tier: integration
// New in agent-workflow (WP19, stage-2 review #8): the duplicate-launch fingerprint is the resolved
// execution identity. The same request from a Claude Code host and a Codex host (each with its own
// default executor) starts two runs; a changed workflow definition starts a new run; a changed
// saved user profile starts a new run. The workflow executor fixture makes no model/CLI calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const runs = await import("../../dist/hosts/runs.js");

let root;
let counter = 0;
const unregister = [];
const launched = [];

const spec = (prompt) => ({
	schemaVersion: 1,
	name: "wp19-identity",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: { stages: [{ id: "a", type: "single", prompt }] },
});

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-identity-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const { ctx, runId } of launched)
		await api.stopAction(ctx, { runId }).catch(() => undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), JSON.stringify(spec("Collect facts.")));
	const ids = [`wp19-id-a-${counter}`, `wp19-id-b-${counter}`];
	for (const id of ids)
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					stepDelayMs: 3_000,
					effectLog: join(root, `${id}-effects.jsonl`),
				}),
			),
		);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, ids };
}

async function run(ctx, extra = {}) {
	const result = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "identity task",
		...extra,
	});
	if (result.data?.runId) launched.push({ ctx, runId: result.data.runId });
	// CI 2026-11-09 (42577149353): a run that failed at start showed no cause; the assertion text now
	// carries each failed task's status and message.
	if (
		result.data?.runId &&
		result.outcome !== "running" &&
		result.outcome !== "existing"
	) {
		const inspect = await runs
			.inspectAction(ctx, { runId: result.data.runId, failures: true })
			.catch((error) => ({ text: `inspect failed: ${error.message}` }));
		return { ...result, text: `${result.text}\n${inspect.text}` };
	}
	return result;
}

test("review #8: the same request from claude-code and codex hosts starts two runs", async () => {
	const { cwd, env, ids } = await project();
	// Each host's default executor (stands in for claude / codex, which a unit test cannot run).
	const claudeHost = { cwd, env, host: "claude-code", defaultExecutor: ids[0] };
	const codexHost = { cwd, env, host: "codex", defaultExecutor: ids[1] };
	const first = await run(claudeHost);
	assert.equal(first.outcome, "running", first.text);
	const second = await run(codexHost);
	assert.notEqual(second.outcome, "existing", second.text);
	assert.notEqual(second.data.runId, first.data.runId);
	// The same host again is still a duplicate.
	const retry = await run(claudeHost);
	assert.equal(retry.outcome, "existing");
	assert.equal(retry.data.runId, first.data.runId);
});

test("review #8: a changed workflow definition starts a new run", async () => {
	const { cwd, env, ids } = await project();
	const ctx = { cwd, env, host: "cli", defaultExecutor: ids[0] };
	const first = await run(ctx);
	assert.equal(first.outcome, "running", first.text);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify(spec("Collect different facts.")),
	);
	const second = await run(ctx);
	assert.notEqual(second.outcome, "existing", second.text);
	assert.notEqual(second.data.runId, first.data.runId);
});

test("review #8: a changed default user profile starts a new run", async () => {
	const { cwd, env, ids } = await project();
	const ctx = { cwd, env, host: "cli" };
	await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values: { executor: ids[0] },
		makeDefault: true,
	});
	const first = await run(ctx);
	assert.equal(first.outcome, "running", first.text);
	await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values: { executor: ids[1] },
		makeDefault: true,
	});
	const second = await run(ctx);
	assert.notEqual(second.outcome, "existing", second.text);
});
