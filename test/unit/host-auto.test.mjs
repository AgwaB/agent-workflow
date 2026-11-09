// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// Auto builds a local shortlist without model calls and asks consent before one
// classifier call on the default executor. Only the final user choice launches;
// capture records the selection. Fixture executors supply classifier answers.
import assert from "node:assert/strict";
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
import { after, afterEach, before, test } from "node:test";

import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const SECRET = "supersecretvalue123";
const READY = { installed: true, cliVersion: "1.0.0", auth: "ok" };
const NOT_INSTALLED = { installed: false, cliVersion: null, auth: "unknown" };

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp32-auto-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function spec(name, useWhen) {
	return {
		schemaVersion: 1,
		name,
		description: `${name} reviews code`,
		routing: { useWhen: [useWhen], outputs: ["A review report."] },
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
		},
	};
}

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	for (const [name, useWhen] of [
		["wp32-alpha", "Use for a careful code review of a module."],
		["wp32-beta", "Use for a quick lint-style review."],
	]) {
		await mkdir(join(cwd, "workflows", name), { recursive: true });
		await writeFile(
			join(cwd, "workflows", name, "spec.json"),
			`${JSON.stringify(spec(name, useWhen))}\n`,
		);
	}
	const env = {
		...process.env,
		HOME: join(root, `home${counter}`),
		AGENT_WORKFLOW_HOME: join(cwd, "aw-home"),
		MY_API_KEY: SECRET,
	};
	return { cwd, env };
}

/** Shadow the built-in executors with fixtures; returns id → effect log path. */
function shadow(probes, recommend = "wp32-alpha") {
	const logs = {};
	for (const [id, probe] of Object.entries(probes)) {
		counter += 1;
		logs[id] = join(root, `${id}-${counter}.jsonl`);
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					effectLog: logs[id],
					autoRecommend: recommend,
					...(recommend === "missing-candidate"
						? { autoStatus: "no-fit" }
						: {}),
					stepDelayMs: 20,
					probe,
				}),
			),
		);
	}
	return logs;
}

function classifierSubmits(log) {
	return readFixtureLog(log).filter(
		(entry) => entry.type === "submit" && entry.autoClassifier === true,
	);
}

function allClassifierSubmits(logs) {
	return Object.fromEntries(
		Object.entries(logs).map(([id, log]) => [
			id,
			classifierSubmits(log).length,
		]),
	);
}

async function settle(cwd, env, runId) {
	let waited;
	do waited = await api.waitAction({ cwd, env }, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

/** Runs created in the project (the rebuilt index counts run directories). */
async function runCount(cwd) {
	const index = await store.readFreshIndex(cwd);
	return Object.keys(index?.runs ?? {}).length;
}

const TASK = `Do a careful code review of the parser module (token ${SECRET})`;

test("auto starts the top pick and records command consent on every host", async (t) => {
	for (const host of ["cli", "pi", "claude-code", "codex", "generic"])
		await t.test(host, async () => {
			const { cwd, env } = await project();
			const logs = shadow({ pi: READY, claude: READY, codex: READY });
			const out = await api.autoAction({ cwd, env, host }, { task: TASK });
			assert.equal(out.data.phase, "launched", out.text);
			assert.equal(out.data.classifierCalled, true);
			assert.equal(out.data.selected.label, "wp32-alpha");
			const id = out.data.classifier.executor;
			assert.equal(classifierSubmits(logs[id]).length, 1);
			const [submit] = classifierSubmits(logs[id]);
			assert.deepEqual(submit.tools, []);
			assert.equal(submit.readOnly, true);
			await settle(cwd, env, out.data.launch.runId);
			const run = await store.readRunRecord(cwd, out.data.launch.runId);
			assert.equal(run.launch.selection.consent, "command");
			assert.equal(run.launch.selection.choseRecommendation, true);
			assert.doesNotMatch(JSON.stringify(run.launch), new RegExp(SECRET));
			for (const undo of unregister.splice(0).reverse()) undo();
			core.resetExecutorProbeCacheForTests();
		});
});

test("classifier failure starts nothing without a local fallback", async () => {
	const { cwd, env } = await project();
	shadow({ pi: READY, claude: READY, codex: READY }, "missing-candidate");
	const out = await api.autoAction({ cwd, env, host: "cli" }, { task: TASK });
	assert.equal(out.data.phase, "classifier-unavailable");
	assert.equal(out.outcome, "refused");
	assert.equal(out.data.launch, undefined);
	assert.equal(await runCount(cwd), 0);
});
test("a run flag and a saved user profile select the classifier executor (Q5: the run's rule)", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const flagged = await api.resolveAutoClassifier(
		{ cwd, env, host: "pi", runtimeDefaults: { model: "p/m", executor: "pi" } },
		{ executor: "codex" },
	);
	assert.deepEqual(
		[flagged.executor, flagged.source, flagged.model, flagged.effort],
		["codex", "run-flag", "gpt-5.6-luna", "medium"],
		"the Pi model belongs to pi only; codex uses its default profile",
	);
	const pi = await api.resolveAutoClassifier(
		{
			cwd,
			env,
			host: "pi",
			runtimeDefaults: { model: "p/m", effort: "low", executor: "pi" },
		},
		{},
	);
	assert.deepEqual([pi.executor, pi.model, pi.effort], ["pi", "p/m", "low"]);
	// Saved executor profiles: their default role, over the host's values (pi) or the built-in one.
	await api.profileAction(
		{ cwd, env },
		{ op: "set", name: "pi", values: { effort: "high" } },
	);
	await api.profileAction(
		{ cwd, env },
		{ op: "set", name: "codex", values: { model: "gpt-edit" } },
	);
	const piEdited = await api.resolveAutoClassifier(
		{
			cwd,
			env,
			host: "pi",
			runtimeDefaults: { model: "p/m", effort: "low", executor: "pi" },
		},
		{},
	);
	assert.deepEqual(
		[piEdited.executor, piEdited.model, piEdited.effort],
		["pi", "p/m", "high"],
	);
	const codexEdited = await api.resolveAutoClassifier(
		{ cwd, env, host: "pi" },
		{ executor: "codex", effort: "low" },
	);
	assert.deepEqual(
		[codexEdited.model, codexEdited.effort],
		["gpt-edit", "low"],
		"run flags win field by field",
	);
	await api.profileAction(
		{ cwd, env },
		{
			op: "set",
			name: "mine",
			values: { executor: "codex", model: "gpt-x" },
			makeDefault: true,
		},
	);
	const profiled = await api.resolveAutoClassifier(
		{ cwd, env, host: "claude-code" },
		{},
	);
	assert.deepEqual(
		[profiled.executor, profiled.source, profiled.model],
		["codex", "user-profile", "gpt-x"],
	);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
});

test("the top recommendation launches and the launch capture records the selection", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const out = await api.autoAction(
		{ cwd, env, host: "claude-code" },
		{
			task: TASK,
			launchOrigin: {
				kind: "tool",
				name: "workflow_auto",
				arguments: { task: TASK },
			},
		},
	);
	assert.equal(out.data.phase, "launched", out.text);
	assert.equal(out.outcome, "running");
	assert.equal(classifierSubmits(logs.claude).length, 1);
	const runId = out.data.launch.runId;
	assert.ok(runId);
	assert.equal(out.data.launch.executor.id, "claude");
	await settle(cwd, env, runId);
	const run = JSON.parse(
		await readFile(
			join(stateDir(cwd), ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	assert.equal(run.name, "wp32-alpha");
	const launch = run.launch;
	assert.equal(launch.schema, "agent-workflow-run-launch-v2");
	assert.equal(launch.source, "mcp:claude-code");
	assert.deepEqual(launch.entry, { kind: "tool", name: "workflow_auto" });
	assert.equal(launch.routingMode, "auto");
	assert.equal(launch.requestKind, "named-workflow");
	const selection = launch.selection;
	assert.equal(selection.selected.label, "wp32-alpha");
	assert.equal(selection.choseRecommendation, true);
	assert.equal(
		selection.candidates.find(
			(c) => c.candidateId === selection.recommendation.candidateId,
		).label,
		"wp32-alpha",
	);
	assert.deepEqual(selection.classifier, {
		executor: "claude",
		model: "sonnet",
	});
	assert.equal(selection.consent, "command");
	assert.match(selection.taskSha256, /^[0-9a-f]{64}$/);
	assert.ok(store.isWorkflowRunLaunchMetadata(launch));
	const runJson = JSON.stringify(run.launch);
	assert.doesNotMatch(runJson, new RegExp(SECRET));
	assert.ok(
		!runJson.includes("parser module"),
		"no task text in the selection",
	);
	const command = await readFile(
		join(
			stateDir(cwd),
			".agent-workflow",
			"workflows",
			runId,
			"launch-command.txt",
		),
		"utf8",
	);
	assert.match(command, /^workflow_auto /);
	assert.doesNotMatch(command, new RegExp(SECRET), "credentials are redacted");
	const shown = await api.showAction(
		{ cwd, env, host: "claude-code" },
		{ ref: runId },
	);
	assert.match(
		shown.text,
		/Auto selection: wp32-alpha \(recommended; \d+ candidates; classifier claude sonnet; consent command\)/,
	);
});

test("a workflow changed after the comparison is refused as stale; nothing starts", async () => {
	const { cwd, env } = await project();
	shadow({ pi: READY, claude: READY, codex: READY });
	const out = await api.autoAction(
		{ cwd, env, host: "codex" },
		{
			task: TASK,
			compare: async (operation) => {
				const compared = await operation();
				const changed = spec("wp32-alpha", "Use for something else entirely.");
				await writeFile(
					join(cwd, "workflows", "wp32-alpha", "spec.json"),
					`${JSON.stringify(changed)}\n`,
				);
				return compared;
			},
		},
	);
	assert.equal(out.data.phase, "stale");
	assert.equal(out.data.consent, "command");
	assert.equal(await runCount(cwd), 0);
});

test("launch metadata v2 validation rejects a selection outside the offered candidates", () => {
	const valid = {
		schema: "agent-workflow-run-launch-v2",
		source: "cli",
		entry: { kind: "command", action: "auto" },
		requestKind: "named-workflow",
		routingMode: "auto",
		profile: { kind: "base" },
		task: { characters: 3, lines: 1 },
		selection: {
			candidates: [
				{ candidateId: "a1", kind: "named-workflow", label: "alpha" },
				{
					candidateId: "d1",
					kind: "direct-dynamic",
					label: "Dynamic workflow",
				},
			],
			recommendation: { candidateId: "a1", confidence: "high" },
			selected: { candidateId: "a1", kind: "named-workflow", label: "alpha" },
			choseRecommendation: true,
			classifier: { executor: "claude", model: null },
			consent: "command",
			taskSha256: "0".repeat(64),
		},
		command: {
			state: "captured",
			artifact: "launch-command.txt",
			encoding: "utf-8",
			bytes: 10,
			sha256: "0".repeat(64),
			fidelity: "agent-workflow-host-command-v1",
			sensitivity: "user-input",
			disclosure: "explicit-only",
		},
	};
	assert.equal(store.isWorkflowRunLaunchMetadata(valid), true);
	const variants = [
		{ selected: { candidateId: "zz", kind: "named-workflow", label: "x" } },
		{
			selected: {
				candidateId: "d1",
				kind: "direct-dynamic",
				label: "Dynamic workflow",
			},
		},
		{ choseRecommendation: false },
		{ consent: "implicit" },
		{ classifier: { executor: "claude", model: null, apiKey: "x" } },
		{ taskText: "leak" },
	];
	for (const change of variants)
		assert.equal(
			store.isWorkflowRunLaunchMetadata({
				...valid,
				selection: { ...valid.selection, ...change },
			}),
			false,
			JSON.stringify(change),
		);
	assert.equal(
		store.isWorkflowRunLaunchMetadata({ ...valid, routingMode: "off" }),
		false,
	);
	assert.equal(
		store.isWorkflowRunLaunchMetadata({
			...valid,
			entry: { kind: "command", action: "run" },
		}),
		false,
	);
});

// Item 2: the CLI `agent-workflow auto "<task>"`.
const cli = await import("../../dist/hosts/cli/index.js");

function cliIo(cwd, env, { isTTY, answers = [] }) {
	const out = [];
	const err = [];
	const questions = [];
	return {
		out,
		err,
		questions,
		io: {
			cwd,
			env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY,
			prompt: async (question) => {
				questions.push(question);
				return answers.shift() ?? "";
			},
			waitSliceMs: 2_000,
		},
	};
}

for (const isTTY of [true, false])
	test(`CLI auto starts the top pick without prompts (TTY=${isTTY})`, async () => {
		const { cwd, env } = await project();
		const logs = shadow({ pi: READY, claude: READY, codex: READY });
		const { io, out, err, questions } = cliIo(cwd, env, { isTTY });
		assert.equal(
			await cli.runAgentWorkflowCli(["auto", TASK], io),
			0,
			out.join("") + err.join(""),
		);
		assert.deepEqual(questions, []);
		assert.deepEqual(allClassifierSubmits(logs), {
			pi: 1,
			claude: 0,
			codex: 0,
		});
		const [run] = (await api.statusAction({ cwd, env })).data.runs;
		const record = await store.readRunRecord(cwd, run.runId);
		assert.equal(record.name, "wp32-alpha");
		assert.equal(record.status, "completed");
		assert.equal(record.launch.selection.consent, "command");
		const command = await readFile(
			join(
				stateDir(cwd),
				".agent-workflow",
				"workflows",
				run.runId,
				"launch-command.txt",
			),
			"utf8",
		);
		assert.match(command, /^agent-workflow auto /);
		assert.doesNotMatch(command, new RegExp(SECRET));
	});
test("approve is an unknown CLI command and auto rejects --yes", async () => {
	const { cwd, env } = await project();
	const { io, out, err } = cliIo(cwd, env, { isTTY: true });
	assert.equal(await cli.runAgentWorkflowCli(["approve", "r1"], io), 2);
	assert.match(out.join("") + err.join(""), /unknown command.*approve/i);
	assert.equal(await cli.runAgentWorkflowCli(["auto", TASK, "--yes"], io), 2);
});
const ext = await import("../../dist/hosts/pi/extension.js");
const { fakeCtx, fakePi } = await import("../helpers/pi-host-fake.mjs");
const piInstances = [];
after(async () => {
	for (const pi of piInstances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
});

function piSession(cwd, env, options = {}) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	piInstances.push(pi);
	const confirms = [];
	const answers = [...(options.confirms ?? [])];
	const ctx = fakeCtx(cwd, {
		...options.ctx,
		select: options.select ?? ((choices) => choices[0]),
	});
	ctx.ui.confirm = async (title, message) => {
		confirms.push({ title, message });
		return answers.shift() ?? false;
	};
	return { pi, ctx, confirms };
}

for (const hasUI of [true, false])
	test(`Pi auto starts the top pick without dialogs (UI=${hasUI})`, async () => {
		const { cwd, env } = await project();
		const logs = shadow({ pi: READY, claude: READY, codex: READY });
		const { pi, ctx, confirms } = piSession(cwd, env, { ctx: { hasUI } });
		assert.equal(pi.tools.has("aw_auto"), false);
		const task = "dynamic programming helpers: review off-by-one errors";
		const write = process.stdout.write;
		process.stdout.write = () => true;
		try {
			await pi.commands.get("aw").handler(`auto "${task}"`, ctx);
		} finally {
			process.stdout.write = write;
		}
		assert.deepEqual(confirms, []);
		assert.deepEqual(ctx.selects, []);
		const [run] = (await api.statusAction({ cwd, env })).data.runs;
		assert.ok(run, JSON.stringify(ctx.notes));
		await settle(cwd, env, run.runId);
		const record = await store.readRunRecord(cwd, run.runId);
		assert.equal(record.name, "wp32-alpha");
		const compiled = JSON.parse(
			await readFile(store.compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		assert.equal(compiled.task, task);
		assert.equal(record.launch.selection.consent, "command");
		assert.equal(classifierSubmits(logs.pi).length, 1);
		await pi.commands.get("aw").handler("approve r1", ctx);
		if (hasUI) assert.match(ctx.notes.at(-1).message, /unknown.*approve/i);
		else {
			assert.equal(process.exitCode, 1);
			process.exitCode = undefined;
		}
	});
const { inProcessHostServer } = await import("../helpers/mcp-host-client.mjs");
const mcpClients = [];
after(async () => {
	for (const client of mcpClients.splice(0))
		await client.close().catch(() => undefined);
});

async function mcpConnect(cwd, env, answers) {
	const requests = [];
	const client = await inProcessHostServer({
		root: cwd,
		env,
		host: "codex",
		...(answers
			? {
					onRequest: async (message) => {
						requests.push(message);
						const answer = answers.shift();
						return typeof answer === "function"
							? answer(message)
							: (answer ?? { action: "cancel" });
					},
				}
			: {}),
	});
	mcpClients.push(client);
	const init = await client.initialize(
		"2025-06-18",
		answers ? { elicitation: {} } : {},
	);
	assert.equal(init.error, undefined, JSON.stringify(init));
	return { client, requests };
}

for (const dialogs of [true, false])
	test(`MCP auto starts the top pick without elicitation (dialogs=${dialogs})`, async () => {
		const { cwd, env } = await project();
		const logs = shadow({ pi: READY, claude: READY, codex: READY });
		const { client, requests } = await mcpConnect(
			cwd,
			env,
			dialogs ? [] : undefined,
		);
		const out = await client.call("workflow_auto", {
			task: TASK,
			detach: false,
		});
		const data = out.structuredContent.data;
		assert.equal(data.phase, "launched", out.content[0].text);
		assert.deepEqual(requests, []);
		assert.deepEqual(allClassifierSubmits(logs), {
			pi: 0,
			claude: 0,
			codex: 1,
		});
		await settle(cwd, env, data.launch.runId);
		const record = await store.readRunRecord(cwd, data.launch.runId);
		assert.equal(record.name, "wp32-alpha");
		assert.equal(record.launch.selection.consent, "command");
		await assert.rejects(
			client.call("workflow_approve", { runId: record.runId }),
			/Unknown tool/,
		);
	});
