import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP12a, live bundle 3 open problem 1): `agent-workflow run|dynamic` and
// Pi `/aw run|dynamic` set workflow inputs with `--input key=value` (repeatable). Values are typed
// by the spec's declared `input` defaults (string / number / boolean / JSON); an undeclared key or
// a value of the wrong type is a usage error before anything starts.
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

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const args = await import("../../dist/hosts/args.js");
const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-input-")));
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
			name: "wp12a-input",
			input: { depth: "standard", count: 1, strict: false, tags: ["a"] },
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const id = `wf-wp12a-input-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog: join(root, `${id}.jsonl`) }),
		),
	);
	return { cwd, id };
}

async function runCli(cwd, argv) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
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

test("CLI run --input key=value (repeatable) sets typed workflow inputs", async () => {
	const { cwd, id } = await project();
	const result = await runCli(cwd, [
		"run",
		"wf.json",
		"input task",
		"--executor",
		id,
		"--input",
		"depth=quick",
		"--input=count=3",
		"--input",
		"strict=true",
		"--input",
		'tags=["x","y"]',
		"--json",
	]);
	assert.equal(result.code, 0, result.err + result.out);
	const runId = JSON.parse(result.out).data.runId;
	assert.deepEqual(await compiledInput(cwd, runId), {
		depth: "quick",
		count: 3,
		strict: true,
		tags: ["x", "y"],
	});
});

test("CLI --input usage errors: undeclared key, wrong type, missing '=', duplicate key (exit 2, nothing starts)", async () => {
	const { cwd, id } = await project();
	for (const [input, pattern] of [
		["nope=1", /nope.*not declared.*depth, count, strict, tags/s],
		["count=many", /count.*number/],
		["strict=maybe", /strict.*true or false/],
		["depth", /key=value/],
		["=x", /key=value/],
	]) {
		const result = await runCli(cwd, [
			"run",
			"wf.json",
			"bad input",
			"--executor",
			id,
			"--input",
			input,
		]);
		assert.equal(result.code, 2, `${input}: ${result.err}${result.out}`);
		assert.match(result.err, pattern, input);
	}
	const duplicate = await runCli(cwd, [
		"run",
		"wf.json",
		"dup",
		"--executor",
		id,
		"--input",
		"depth=quick",
		"--input",
		"depth=max",
	]);
	assert.equal(duplicate.code, 2);
	assert.match(duplicate.err, /depth.*more than once/);
	assert.equal(
		existsSync(join(stateDir(cwd), ".agent-workflow", "workflows")),
		false,
	);
});

test("host API: string inputs are typed by the declared default; typed values pass through", async () => {
	const { cwd, id } = await project();
	const launched = await api.runWorkflowAction(
		{ cwd, env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") } },
		{
			workflow: "wf.json",
			task: "api input",
			executor: id,
			inputOverrides: { depth: "max", count: "7", strict: false },
		},
	);
	assert.equal(launched.ok, true, launched.text);
	await engine.waitForRun(cwd, launched.data.runId, 60_000);
	assert.deepEqual(await compiledInput(cwd, launched.data.runId), {
		depth: "max",
		count: 7,
		strict: false,
		tags: ["a"],
	});
});

test("Pi /aw run|dynamic parsing: --input key=value is repeatable, leading or trailing", () => {
	const parsed = args.parseWorkflowRunArgs(
		'run --input depth=quick deep-research "a task" --input count=2',
	);
	assert.equal(parsed.specPath, "deep-research");
	assert.equal(parsed.task, "a task");
	assert.deepEqual(parsed.inputs, { depth: "quick", count: "2" });
	const dynamic = args.parseWorkflowDynamicArgs(
		'dynamic "do it" --input=mode=fast',
	);
	assert.deepEqual(dynamic.inputs, { mode: "fast" });
	assert.throws(
		() => args.parseWorkflowRunArgs("run wf t --input depth"),
		/key=value/,
	);
	assert.throws(
		() => args.parseWorkflowRunArgs("run wf t --input a=1 --input a=2"),
		/more than once/,
	);
});
