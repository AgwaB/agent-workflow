// test-tier: integration
// New in agent-workflow (WP19 round 3, review R5): the declared-profile chooser picks from the
// definition the launch was resolved from (and fingerprinted by the duplicate guard), but the engine
// re-read the workflow file. Changing `fast`'s model while the chooser was open silently launched the
// changed model under the earlier definition's fingerprint. Now the engine compares its final load
// with the host's definition fingerprint and the launch is refused (`WORKFLOW_DEFINITION_CHANGED`).
// Based on the reviewer's probes /tmp/aw-wp19r3-{extra,followup}.test.mjs. The workflow executor
// fixture makes no model or agent-CLI calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const store = await import("../../dist/core/store.js");

before(() => {
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});

let counter = 0;
async function project(t) {
	const cwd = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "aw-wp19r3-chooser-")),
	);
	counter += 1;
	const id = `wp19r3-chooser-${counter}`;
	const launched = [];
	const undo = core.registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id,
			stepDelayMs: 50,
			effectLog: join(cwd, "effects.jsonl"),
		}),
	);
	const ctx = { cwd, env: process.env, host: "pi", defaultExecutor: id };
	const spec = {
		schemaVersion: 1,
		name: "wp19r3-chooser",
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
		},
		executionProfiles: { fast: { a: { model: "chosen-model" } } },
	};
	await fs.mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await fs.writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const specPath = join(cwd, "wf.json");
	await fs.writeFile(specPath, JSON.stringify(spec));
	const launch = async (extra = {}) => {
		const result = await api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "same task",
			...extra,
		});
		if (result.data.runId) launched.push(result.data.runId);
		return result;
	};
	t.after(async () => {
		for (const runId of launched)
			await api.stopAction(ctx, { runId }).catch(() => undefined);
		undo();
		await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	});
	return { cwd, ctx, spec, specPath, launch };
}

test("R5: changing the chosen profile's model while the chooser is open refuses the launch", async (t) => {
	const { ctx, spec, specPath, launch } = await project(t);
	const result = await launch({
		selectProfile: async () => {
			spec.executionProfiles.fast.a.model = "changed-while-choosing";
			await fs.writeFile(specPath, JSON.stringify(spec));
			return "Profile: fast";
		},
	});
	assert.equal(result.outcome, "refused", result.text);
	assert.equal(result.data.refusal?.code, "WORKFLOW_DEFINITION_CHANGED");
	assert.equal(result.data.runId, undefined);
	assert.match(result.text, /changed while the launch was being prepared/);
	assert.match(result.text, /Launch again/);
	assert.deepEqual(await store.listRunRecords(ctx.cwd), [], "no run started");
	// The refusal frees the duplicate guard: launching again runs the current definition.
	const again = await launch({ selectProfile: async () => "Profile: fast" });
	assert.equal(again.outcome, "running", again.text);
	const run = (await api.showAction(ctx, { ref: again.data.runId })).data.run;
	assert.equal(
		run.executionProfile.stageOverrides.a.model,
		"changed-while-choosing",
	);
});

test("R5: an unchanged definition launches the chosen profile", async (t) => {
	const { ctx, launch } = await project(t);
	const result = await launch({ selectProfile: async () => "Profile: fast" });
	assert.equal(result.outcome, "running", result.text);
	const run = (await api.showAction(ctx, { ref: result.data.runId })).data.run;
	assert.equal(run.executionProfile.stageOverrides.a.model, "chosen-model");
});
