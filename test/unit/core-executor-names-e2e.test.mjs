// 2026-10-31 edge cases: model and effort names are rewritten for the executor that runs a stage
// before launch (core-pi-vocabulary-crosshost checks the negotiation). Here the real engine runs
// the workflow against fixture executors registered under the real ids, and the SubmitRequest the
// executor receives is checked: first launch, and a resume after a blocked attempt (the relaunch
// must not fall back to the spec's unconverted names).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-names-e2e-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const LUNA_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** A project whose one stage asks for `model`/`effort`, run by fixture `id` with `probe`. */
async function project(id, { model, effort, probe = {}, mode } = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			name: "names-e2e",
			defaults: {
				agent: "reader",
				readOnly: true,
				tools: ["read"],
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			},
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		})}\n`,
	);
	const effectLog = join(cwd, "effects.jsonl");
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog,
				...(mode ? { mode } : {}),
				probe: { installed: true, cliVersion: "1.0.0", auth: "ok", ...probe },
			}),
		),
	);
	const submits = () =>
		readFixtureLog(effectLog).filter((entry) => entry.type === "submit");
	return { cwd, specPath: join(cwd, "wf.json"), submits };
}

test("codex: a Pi-qualified model and ultra reach the executor as its model id and the model's top level", async () => {
	const p = await project("codex", {
		model: "openai-codex/gpt-6-luna",
		effort: "ultra",
		probe: {
			models: ["gpt-6.1-sol", "gpt-6-luna"],
			modelEfforts: {
				"gpt-6.1-sol": [...LUNA_LEVELS, "ultra"],
				"gpt-6-luna": LUNA_LEVELS,
			},
		},
	});
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "codex",
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	const [submit] = p.submits();
	assert.equal(submit.model, "gpt-6-luna");
	assert.equal(submit.effort, "max");
	assert.ok(
		run.capabilityNegotiation.notices.some((notice) =>
			/effort "ultra" is "max" for gpt-6-luna on codex/.test(notice),
		),
		JSON.stringify(run.capabilityNegotiation.notices),
	);
});

test("codex: ultra stays ultra on a model that has it", async () => {
	const p = await project("codex", {
		model: "gpt-6.1-sol",
		effort: "ultra",
		probe: {
			models: ["gpt-6.1-sol"],
			modelEfforts: { "gpt-6.1-sol": [...LUNA_LEVELS, "ultra"] },
		},
	});
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "codex",
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	assert.deepEqual(
		p.submits().map((submit) => [submit.model, submit.effort]),
		[["gpt-6.1-sol", "ultra"]],
	);
});

test("claude: anthropic/… and ultra reach the CLI as its model id and max", async () => {
	const p = await project("claude", {
		model: "anthropic/claude-opus-5-5",
		effort: "ultra",
	});
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "claude",
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	assert.deepEqual(
		p.submits().map((submit) => [submit.model, submit.effort]),
		[["claude-opus-5-5", "max"]],
	);
});

test("pi: ultra reaches Pi as max (Pi has no ultra)", async () => {
	const p = await project("pi", { effort: "ultra" });
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "pi",
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	assert.deepEqual(
		p.submits().map((submit) => submit.effort),
		["max"],
	);
});

test("a launch-time --model/--effort override is converted too", async () => {
	const p = await project("claude");
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "claude",
		runtimeOverrides: { model: "anthropic/claude-opus-5-5", effort: "ultra" },
	});
	const run = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	assert.deepEqual(
		p.submits().map((submit) => [submit.model, submit.effort]),
		[["claude-opus-5-5", "max"]],
	);
});

test("resume relaunches a blocked attempt with the converted names, not the spec's", async () => {
	const p = await project("claude", {
		model: "anthropic/claude-opus-5-5",
		effort: "ultra",
		mode: "crash-after-consume",
	});
	const started = await engine.runWorkflowSpec(p.specPath, p.cwd, {
		task: "names",
		executor: "claude",
	});
	const blocked = await engine.waitForRun(p.cwd, started.runId, 60_000);
	assert.equal(blocked.status, "blocked", JSON.stringify(blocked.tasks));
	const deadline = Date.now() + 30_000;
	let resumed;
	while (resumed === undefined) {
		try {
			resumed = await engine.resumeRun(p.cwd, started.runId);
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	await engine.waitForRun(p.cwd, started.runId, 60_000).catch(() => undefined);
	const submits = p.submits();
	assert.ok(submits.length >= 2, JSON.stringify(submits));
	for (const submit of submits) {
		assert.equal(submit.model, "claude-opus-5-5");
		assert.equal(submit.effort, "max");
	}
});
