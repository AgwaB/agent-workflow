// New in agent-workflow (WP18b): stage-2 polish from live bundles 4/4b. Host-aware next-step hints
// in the core run texts (CLI `agent-workflow …`, Pi `/aw …`, MCP tool calls; never pi-workflow's
// `/workflow …`). Runs use the workflow executor fixture (no model or agent-CLI calls).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const hints = await import("../../dist/hosts/hints.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp18b-polish",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp18b-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	return {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
	};
}

function fixture(config = {}) {
	counter += 1;
	const id = `wp18b-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				...config,
				id,
				effectLog: join(root, `${id}.jsonl`),
			}),
		),
	);
	return id;
}

/** A launched, then stopped (interrupted) run: its texts carry Open/Resume hints. */
async function interruptedRun() {
	const { cwd, env } = await project();
	const executor = fixture({ stepDelayMs: 1_500 });
	const ctx = { cwd, env, host: "cli" };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "slow",
		executor,
	});
	const runId = launched.data.runId;
	const stopped = await api.stopAction(ctx, { runId });
	assert.equal(stopped.data.status, "interrupted", stopped.text);
	return { cwd, env, runId };
}

test("hints: every host gets its own vocabulary, MCP hints name real tools", () => {
	assert.equal(
		hints.hostCommandHints("cli").status("r1"),
		"agent-workflow status r1",
	);
	assert.equal(
		hints.hostCommandHints(undefined).resume("r1"),
		"agent-workflow resume r1",
	);
	assert.equal(
		hints.hostCommandHints("pi").logs("r1", "t"),
		"/aw logs r1 --task t",
	);
	for (const host of ["claude-code", "codex", "generic"]) {
		const h = hints.hostCommandHints(host);
		assert.equal(h.status("r1"), 'workflow_status {"runId":"r1"}');
		assert.equal(h.wait("r1"), 'workflow_wait {"runId":"r1"}');
	}
	const toolNames = new Set(mcpTools.HOST_MCP_TOOLS.map((tool) => tool.name));
	const h = hints.MCP_COMMAND_HINTS;
	for (const text of [
		h.status("r"),
		h.wait("r"),
		h.logs("r", "t"),
		h.raw("r"),
		h.inspectFailures("r"),
		h.stop("r"),
	])
		assert.ok(toolNames.has(text.split(" ")[0]), text);
});

test("status/show/stop/resume/wait texts carry the calling host's hints, never /workflow", async () => {
	const { cwd, env, runId } = await interruptedRun();
	const expectations = {
		cli: [
			`Open: agent-workflow status ${runId}`,
			`Resume: agent-workflow resume ${runId}`,
		],
		pi: [`Open: /aw status ${runId}`, `Resume: /aw resume ${runId}`],
		codex: [
			`Open: workflow_status {"runId":"${runId}"}`,
			`Resume: agent-workflow resume ${runId}`,
		],
	};
	for (const [host, expected] of Object.entries(expectations)) {
		const ctx = { cwd, env, host };
		const texts = [
			(await api.statusAction(ctx, { runId })).text,
			(await api.showRunAction(ctx, { runId })).text,
			(await api.showRunAction(ctx, { runId, raw: true })).text,
			(await api.waitAction(ctx, { runId, timeoutMs: 1_000 })).text,
			(await api.statusAction(ctx)).text,
		];
		for (const text of texts)
			assert.doesNotMatch(text, /\/workflow\b/, `${host}: ${text}`);
		const status = texts[0];
		for (const line of expected)
			assert.ok(status.includes(line), `${host}: ${status}`);
		assert.ok(texts[4].includes(expected[0].slice("Open: ".length)), texts[4]);
		const details = texts[1];
		assert.match(details, /Logs: /);
	}
	const resumed = await api.resumeAction({ cwd, env, host: "pi" }, { runId });
	assert.doesNotMatch(resumed.text, /\/workflow\b/);
	assert.ok(resumed.text.includes(`Open: /aw status ${runId}`), resumed.text);
	const stopped = await api.stopAction({ cwd, env, host: "codex" }, { runId });
	assert.doesNotMatch(stopped.text, /\/workflow\b/);
	assert.ok(
		stopped.text.includes(`workflow_status {"runId":"${runId}"}`),
		stopped.text,
	);
});
