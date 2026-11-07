// Pi user agents are not read, either as bundled-agent replacements or fallbacks.
// No agent is shadowed, so no shadow notice is needed.
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

let root;
const unregister = [];
// The unit runner points PI_CODING_AGENT_DIR at a scratch home; never the real ~/.pi.
const legacyAgentsDir = join(process.env.PI_CODING_AGENT_DIR, "agents");

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-shadow-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setWorkerLaunchControlsForTests({});
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
	const run = await runWithScout("clean");
	assert.equal(run.status, "completed");
	assert.equal(run.capabilityNegotiation.notices, undefined);
	assert.doesNotMatch(
		run.capabilityNegotiation.preview,
		/shadows the bundled agent/,
	);
});

test("a ~/.pi/agent/agents/<name>.md is ignored: the bundled agent resolves and Pi-only names do not", async () => {
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
	assert.doesNotMatch(agent.sourcePath, /\.pi\/agent\/agents/);
	const registry = await agents.discoverAgents(root);
	assert.equal(registry.byAlias.get("scout").scope, "bundled");
	assert.equal(
		await agents.loadAgentByName("wp12a-only-in-pi", root),
		undefined,
	);
	assert.equal(registry.byAlias.has("wp12a-only-in-pi"), false);
	const run = await runWithScout("shadowed");
	assert.equal(run.status, "completed");
	assert.equal(run.capabilityNegotiation.notices, undefined);
	assert.doesNotMatch(
		run.capabilityNegotiation.preview,
		/shadows the bundled agent/,
	);
});
