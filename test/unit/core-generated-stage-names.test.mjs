import { stateDir } from "../helpers/state-dir.mjs";
// 2026-10-31 edge cases: a stage a dynamic controller generates (`ctx.agent`) gets the model and
// effort names of the executor that runs it, like a planned stage. The real engine runs a dynamic
// workflow on a fixture executor registered as `codex`; the SubmitRequest shows what reached it.
// Rewriting happens where the task is built: rewriting it at launch broke its sealed launch
// ("workflow launch authority sealed launch mismatch"). A name codex cannot run is refused to the
// controller (ctx.agent throws), with nothing submitted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-generated-names-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

/** Run a workflow whose controller asks `ctx.agent(request)`; report what came back and ran. */
async function generate(request, probe = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, "helpers/controller.mjs"),
		`export default async function controller(ctx) {
	let outcome;
	try {
		await ctx.agent(${JSON.stringify({ id: "w1", agent: "reader", tools: ["read"], prompt: "Work.", ...request })});
		outcome = { ok: true };
	} catch (error) {
		outcome = { ok: false, error: String(error?.message ?? error) };
	}
	return { control: { schema: "dynamic-controller-result-v1", summary: "done" }, analysis: JSON.stringify(outcome), refs: [] };
}
`,
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "generated-names",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "prep", type: "single", prompt: "Collect facts." },
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: {
								allowDynamicRoles: true,
								allowDynamicTools: true,
							},
						},
					},
				],
			},
		}),
	);
	const effectLog = join(cwd, "effects.jsonl");
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "codex",
				effectLog,
				probe: { installed: true, cliVersion: "1.0.0", auth: "ok", ...probe },
			}),
		),
	);
	const started = await engine.runWorkflowSpec(join(cwd, "wf.json"), cwd, {
		task: "generate",
		executor: "codex",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	const controller = run.tasks.find(
		(task) => task.specId === "adaptive.controller",
	);
	const output = readFileSync(
		join(stateDir(cwd), controller.files.output),
		"utf8",
	);
	const outcome = JSON.parse(
		/<analysis>\s*([\s\S]*?)\s*<\/analysis>/u.exec(output)[1],
	);
	const generatedSubmits = readFixtureLog(effectLog)
		.filter((entry) => entry.type === "submit")
		.slice(1); // the first submit is the planned `prep` stage
	return { run, outcome, generatedSubmits };
}

const LUNA = {
	models: ["gpt-6.1-sol", "gpt-6-luna"],
	modelEfforts: { "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"] },
};

test("a generated stage's Pi-qualified model and ultra reach codex as its id and the model's top level", async () => {
	const { run, outcome, generatedSubmits } = await generate(
		{ model: "openai-codex/gpt-6-luna", effort: "ultra" },
		LUNA,
	);
	assert.deepEqual(outcome, { ok: true });
	assert.equal(run.status, "completed");
	assert.deepEqual(
		generatedSubmits.map((submit) => [submit.model, submit.effort]),
		[["gpt-6-luna", "max"]],
	);
	assert.ok(
		run.capabilityNegotiation.notices.some((notice) =>
			/effort "ultra" is "max" for gpt-6-luna on codex .*\(adaptive\.w1\)/.test(
				notice,
			),
		),
		JSON.stringify(run.capabilityNegotiation.notices),
	);
});

test("a generated stage with only a model to rewrite launches (no sealed-launch mismatch)", async () => {
	const { run, outcome, generatedSubmits } = await generate(
		{ model: "openai-codex/gpt-6-luna" },
		LUNA,
	);
	assert.deepEqual(outcome, { ok: true });
	assert.equal(run.status, "completed");
	assert.deepEqual(
		generatedSubmits.map((submit) => submit.model),
		["gpt-6-luna"],
	);
});

test("ctx.agent accepts ultra (the workflow vocabulary) and refuses an unknown level with the list", async () => {
	const ultra = await generate({ effort: "ultra" });
	assert.deepEqual(ultra.outcome, { ok: true });
	assert.deepEqual(
		ultra.generatedSubmits.map((submit) => submit.effort),
		["ultra"],
	);
	const unknown = await generate({ effort: "extreme" });
	assert.equal(unknown.outcome.ok, false);
	assert.match(
		unknown.outcome.error,
		/effort has an unsupported value \(use one of: off, minimal, low, medium, high, xhigh, max, ultra\)/,
	);
	assert.deepEqual(unknown.generatedSubmits, []);
});

test("a model codex cannot run, or a malformed one, is refused to the controller; nothing is submitted", async () => {
	for (const [model, reason] of [
		["anthropic/claude-opus-5-5", /is an Anthropic model; codex cannot run it/],
		["openai-codex/", /is malformed/],
	]) {
		const { outcome, generatedSubmits } = await generate({ model });
		assert.equal(outcome.ok, false, model);
		assert.match(
			outcome.error,
			/executor codex refused generated task adaptive\.w1 before launch/,
		);
		assert.match(outcome.error, reason);
		assert.deepEqual(generatedSubmits, [], model);
	}
});
