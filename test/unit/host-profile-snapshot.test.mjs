// New in agent-workflow (WP19 round 2, re-review N5): the saved per-workflow profile preference is
// part of the duplicate-launch identity, and the launch runs from the same resolved snapshot.
// Reviewer scenario: save a preference, launch, change the preference, repeat the same request.
// Before the fix the guard returned the old run (`existing`). 2026-11-02: the preference is the WP31
// per-workflow preference naming a saved user profile (the Pi TUI store it was written against is
// gone). The workflow executor fixture makes no model or agent-CLI calls; the settings live in the
// per-file temporary home of test/run-unit.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

const SPEC = {
	schemaVersion: 1,
	name: "wp19r2-snapshot",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{
				id: "a",
				type: "single",
				profileRole: "research-execution",
				prompt: "Collect facts.",
			},
		],
	},
};
before(() => {
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});

test("N5: a changed saved per-workflow preference starts a new run with the new profile", async (t) => {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "aw-wp19r2-snapshot-")),
	);
	const id = `wp19r2-snapshot-${Date.now()}`;
	const undo = core.registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id,
			stepDelayMs: 3_000,
			effectLog: join(cwd, "effects.jsonl"),
		}),
	);
	const ctx = {
		cwd,
		env: process.env,
		host: "pi",
		defaultExecutor: id,
	};
	const launched = [];
	t.after(async () => {
		for (const runId of launched)
			await api.stopAction(ctx, { runId }).catch(() => undefined);
		undo();
		await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	});
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const specPath = join(cwd, "wf.json");
	await writeFile(specPath, JSON.stringify(SPEC));
	const launch = async () => {
		const result = await api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "same task",
		});
		if (result.data.runId) launched.push(result.data.runId);
		return result;
	};

	for (const [name, effort] of [
		["careful", "high"],
		["quick", "low"],
	]) {
		const saved = await api.profileAction(ctx, {
			op: "set",
			name,
			values: { executor: id, effort },
		});
		assert.equal(saved.outcome, "success", saved.text);
	}
	const prefer = async (profile) => {
		const set = await api.workflowPreferenceAction(ctx, {
			op: "set",
			workflow: "wf.json",
			profile,
		});
		assert.equal(set.outcome, "success", set.text);
	};

	await prefer("careful");
	const first = await launch();
	assert.equal(first.outcome, "running", first.text);
	assert.deepEqual(first.data.profile, {
		name: "careful",
		kind: "user",
		source: "workflow-preference",
	});

	// The same request with the same preference is still a duplicate.
	const retry = await launch();
	assert.equal(retry.outcome, "existing", retry.text);
	assert.equal(retry.data.runId, first.data.runId);

	await prefer("quick");
	const second = await launch();
	assert.notEqual(second.outcome, "existing", second.text);
	assert.notEqual(second.data.runId, first.data.runId);
	assert.deepEqual(second.data.profile, {
		name: "quick",
		kind: "user",
		source: "workflow-preference",
	});
	// The run itself carries the new preference's profile (launched from the snapshot).
	const shown = (await api.showAction(ctx, { ref: second.data.runId })).data
		.run;
	assert.equal(shown.executionProfile?.name, "quick");
});
