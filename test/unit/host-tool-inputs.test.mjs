// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP12c): the Pi agent tools `aw_run` / `aw_dynamic` take an `inputs` object,
// the tool form of `--input key=value` (WP12a). The host API types it by the spec's declared `input`
// defaults (`typedWorkflowInputOverrides`): strings are parsed for number/boolean/JSON inputs, other
// values must already have the declared type, undeclared keys are usage errors before anything
// starts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const ext = await import("../../dist/hosts/pi/extension.js");
const tools = await import("../../dist/hosts/pi/tools.js");
const realApi = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12c-tool-inputs-")));
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

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wp12c-tool-inputs",
			input: { depth: "standard", count: 1, strict: false, tags: ["a"] },
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const id = `wf-wp12c-tool-inputs-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog: join(root, `${id}.jsonl`) }),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, id, env };
}

/** Fake ExtensionAPI + a recording wrapper over the real host API. */
function install(env) {
	const registered = new Map();
	const calls = [];
	const api = {};
	for (const [name, value] of Object.entries(realApi)) {
		if (
			typeof value !== "function" ||
			!/Action$|^registerTestExecutorFromEnv$/.test(name)
		)
			continue;
		api[name] = (...args) => {
			calls.push({ name, args });
			return value(...args);
		};
	}
	const pi = {
		registerCommand() {},
		registerTool(tool) {
			registered.set(tool.name, tool);
		},
		on() {
			return () => undefined;
		},
		getThinkingLevel: () => "medium",
	};
	ext.createAgentWorkflowPiExtension({ api, env })(pi);
	return { tools: registered, calls };
}

function fakeCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify() {},
			confirm: async () => true,
			select: async () => undefined,
		},
	};
}

/** The workflow input as compiled into the first task prompt ("# Workflow Input"). */
async function compiledInput(cwd, runId) {
	const runDir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
	const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
	const task = run.tasks.find((item) => item.files?.taskPrompt);
	const prompt = await readFile(
		join(stateDir(cwd), task.files.taskPrompt),
		"utf8",
	);
	const match = /# Workflow Input\n\n([\s\S]*?)(?:\n\n#|$)/.exec(prompt);
	assert.ok(match, prompt);
	return JSON.parse(match[1]);
}

test("aw_run and aw_dynamic declare an optional inputs object", () => {
	for (const parameters of [
		tools.AW_RUN_PARAMETERS,
		tools.AW_DYNAMIC_PARAMETERS,
	]) {
		assert.equal(parameters.properties.inputs.type, "object");
		assert.match(parameters.properties.inputs.description, /--input/);
		assert.ok(!parameters.required.includes("inputs"));
	}
});

test("aw_run inputs reach the run typed by the declared defaults (strings converted, typed values kept)", async () => {
	const { cwd, id, env } = await project();
	const { tools: registered, calls } = install(env);
	const started = await registered.get("aw_run").execute(
		"r",
		{
			workflow: "wf.json",
			task: "tool inputs",
			executor: id,
			inputs: { depth: "quick", count: "3", strict: true, tags: '["x"]' },
		},
		undefined,
		undefined,
		fakeCtx(cwd),
	);
	assert.equal(started.details.ok, true, started.content[0].text);
	const runCall = calls.filter((call) => call.name === "runWorkflowAction")[0];
	assert.deepEqual(runCall.args[1].inputOverrides, {
		depth: "quick",
		count: "3",
		strict: true,
		tags: '["x"]',
	});
	await engine.waitForRun(cwd, started.details.runId, 60_000);
	assert.deepEqual(await compiledInput(cwd, started.details.runId), {
		depth: "quick",
		count: 3,
		strict: true,
		tags: ["x"],
	});
});

test("aw_run inputs usage errors: not an object, undeclared key, wrong type (nothing starts)", async () => {
	const { cwd, id, env } = await project();
	const { tools: registered } = install(env);
	for (const [inputs, pattern] of [
		[["depth=quick"], /inputs must be an object/],
		["depth=quick", /inputs must be an object/],
		[null, /inputs must be an object/],
		[{ nope: 1 }, /nope.*not declared.*depth, count, strict, tags/s],
		[{ count: "many" }, /count.*number/],
		[{ count: true }, /count must be a number; got boolean/],
		[{ strict: "maybe" }, /strict.*true or false/],
		[{ strict: 1 }, /strict must be a boolean; got number/],
		[{ tags: { a: 1 } }, /tags must be a array; got object/],
	]) {
		await assert.rejects(
			registered
				.get("aw_run")
				.execute(
					"bad",
					{ workflow: "wf.json", task: "bad inputs", executor: id, inputs },
					undefined,
					undefined,
					fakeCtx(cwd),
				),
			pattern,
			JSON.stringify(inputs),
		);
	}
	assert.equal(
		existsSync(join(stateDir(cwd), ".agent-workflow", "workflows")),
		false,
	);
});

test("aw_run with empty inputs uses the spec defaults; aw_dynamic refuses undeclared inputs", async () => {
	const { cwd, id, env } = await project();
	const { tools: registered, calls } = install(env);
	const started = await registered
		.get("aw_run")
		.execute(
			"r",
			{ workflow: "wf.json", task: "defaults", executor: id, inputs: {} },
			undefined,
			undefined,
			fakeCtx(cwd),
		);
	assert.equal(started.details.ok, true, started.content[0].text);
	const runCall = calls.filter((call) => call.name === "runWorkflowAction")[0];
	assert.equal("inputOverrides" in runCall.args[1], false);
	await engine.waitForRun(cwd, started.details.runId, 60_000);
	assert.deepEqual(await compiledInput(cwd, started.details.runId), {
		depth: "standard",
		count: 1,
		strict: false,
		tags: ["a"],
	});

	await assert.rejects(
		registered
			.get("aw_dynamic")
			.execute(
				"d",
				{ task: "explore", executor: id, inputs: { depth: "quick" } },
				undefined,
				undefined,
				fakeCtx(cwd),
			),
		/input depth is not declared/,
	);
	const dynamicCall = calls.filter((call) => call.name === "runDynamicAction");
	assert.deepEqual(dynamicCall.at(-1).args[1].inputOverrides, {
		depth: "quick",
	});
});
