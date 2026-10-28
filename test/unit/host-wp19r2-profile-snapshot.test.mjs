// New in agent-workflow (WP19 round 2, re-review N5): the saved per-workflow profile preference is
// part of the duplicate-launch identity, and the launch runs from the same resolved snapshot.
// Reviewer scenario: save the Codex preference, launch, change the preference to Claude, repeat the
// same request. Before the fix the guard returned the old Codex-profile run (`existing`). The
// workflow executor fixture makes no model or agent-CLI calls; the settings live in the per-file
// temporary home of test/run-unit.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const profiles = await import("../../dist/core/workflow-profile-settings.js");
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
const MODELS = [
	{
		provider: "openai-codex",
		id: "gpt-6-luna",
		fullId: "openai-codex/gpt-6-luna",
		reasoning: true,
	},
	{
		provider: "anthropic",
		id: "claude-opus-5-5",
		fullId: "anthropic/claude-opus-5-5",
		reasoning: true,
	},
];

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
		availableModels: MODELS,
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

	await profiles.saveWorkflowProfilePreference(
		{ spec: SPEC, specPath },
		{ selectedProfile: "codex" },
	);
	const first = await launch();
	assert.equal(first.outcome, "running", first.text);
	assert.equal(first.data.profile?.kind, "workflow-preference");
	const codexName = first.data.profile?.name;

	// The same request with the same preference is still a duplicate.
	const retry = await launch();
	assert.equal(retry.outcome, "existing", retry.text);
	assert.equal(retry.data.runId, first.data.runId);

	await profiles.saveWorkflowProfilePreference(
		{ spec: SPEC, specPath },
		{ selectedProfile: "claude" },
	);
	const second = await launch();
	assert.notEqual(second.outcome, "existing", second.text);
	assert.notEqual(second.data.runId, first.data.runId);
	assert.equal(second.data.profile?.kind, "workflow-preference");
	assert.equal(second.data.profile?.name, "Claude");
	assert.notEqual(second.data.profile?.name, codexName);
	// The run itself carries the Claude preference (launched from the fingerprinted snapshot).
	const shown = (await api.showAction(ctx, { ref: second.data.runId })).data
		.run;
	assert.equal(shown.executionProfile?.name, "Claude");
});
