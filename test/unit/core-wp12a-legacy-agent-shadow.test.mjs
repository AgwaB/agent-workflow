// New in agent-workflow (WP12a, live bundle 3 open problem 2), changed 2026-10-30 (owner decision):
// a Pi user agent (`~/.pi/agent/agents/<name>.md`, written for pi-workflow's tool/model names) no
// longer replaces the bundled agent of the same name on any host; it only fills in names
// agent-workflow does not ship. With nothing shadowed there is no shadow notice any more.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const agents = await import("../../dist/core/agents.js");
const slots = await import("../../dist/core/launch-slots.js");
const home = await import("../../dist/core/home-dir.js");

let root;
const unregister = [];
const legacyAgentsDir = join(home.legacyPiAgentDir(), "agents");

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-shadow-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	await rm(join(legacyAgentsDir, "scout.md"), { force: true });
	await rm(join(legacyAgentsDir, "wp12a-only-in-pi.md"), { force: true });
	// Durable workers/finalizers may still be closing files: retry like host-cli.test.mjs.
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function runWithScout(name) {
	const cwd = join(root, name);
	await mkdir(cwd, { recursive: true });
	const specPath = join(cwd, "wf.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "wp12a-shadow",
			defaults: { agent: "scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const id = `wf-wp12a-shadow-${name}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog: join(root, `${id}.jsonl`) }),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "shadow",
		executor: id,
	});
	return engine.waitForRun(cwd, started.runId, 60_000);
}

test("without a legacy agent the bundled agent resolves and no notice is recorded", async () => {
	const agent = await agents.loadAgentByName("scout", root);
	assert.equal(agent.scope, "bundled");
	assert.equal(agent.shadowsBundledAgent, undefined);
	const run = await runWithScout("clean");
	assert.equal(run.status, "completed");
	assert.equal(run.capabilityNegotiation.notices, undefined);
	assert.doesNotMatch(
		run.capabilityNegotiation.preview,
		/shadows the bundled agent/,
	);
});

test("a legacy ~/.pi/agent/agents/<name>.md does not replace the bundled agent; other legacy names still resolve", async () => {
	await mkdir(legacyAgentsDir, { recursive: true });
	await writeFile(
		join(legacyAgentsDir, "scout.md"),
		"---\nname: scout\ndescription: my old scout\ntools: read\n---\nLegacy scout.\n",
	);
	await writeFile(
		join(legacyAgentsDir, "wp12a-only-in-pi.md"),
		"---\nname: wp12a-only-in-pi\ndescription: only in pi\ntools: read\n---\nPi only.\n",
	);
	const agent = await agents.loadAgentByName("scout", root);
	assert.equal(agent.scope, "bundled");
	assert.equal(agent.legacySource, undefined);
	assert.doesNotMatch(agent.sourcePath, /\.pi\/agent\/agents/);
	const registry = await agents.discoverAgents(root);
	assert.equal(registry.byAlias.get("scout").scope, "bundled");
	const piOnly = await agents.loadAgentByName("wp12a-only-in-pi", root);
	assert.equal(piOnly.legacySource, "pi");
	assert.equal(registry.byAlias.get("wp12a-only-in-pi").legacySource, "pi");
	const run = await runWithScout("shadowed");
	assert.equal(run.status, "completed");
	assert.equal(run.capabilityNegotiation.notices, undefined);
	assert.doesNotMatch(
		run.capabilityNegotiation.preview,
		/shadows the bundled agent/,
	);
});
