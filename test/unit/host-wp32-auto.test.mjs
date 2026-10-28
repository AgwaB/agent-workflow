// New in agent-workflow (WP32, owner decision Q5, parity row 21): the host API `auto` action.
// pi-workflow's `/workflow auto` consent semantics on every host: a local routing-only shortlist
// without any model call; one classifier call only after explicit consent, on the run's default
// executor (Claude Code → claude, Codex → codex, Pi → pi, the terminal CLI → the first installed and
// logged-in of pi → claude → codex); the user's final choice starts the workflow through the normal
// launch path, and the launch capture (`agent-workflow-run-launch-v2`) records the selection.
// Fakes only: the built-in executor ids are shadowed by the workflow executor fixture, whose
// `autoRecommend` answers the classifier call (no agent CLI, no model call).
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
	slots.setSubagentLaunchControlsForTests({
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

test("no consent hook: local routing-only shortlist, no classifier call, nothing started", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const out = await api.autoAction(
		{ cwd, env, host: "claude-code" },
		{ task: TASK },
	);
	assert.equal(out.action, "auto");
	assert.equal(out.outcome, "refused");
	assert.equal(out.data.phase, "consent-unavailable");
	assert.equal(out.data.classifierCalled, false);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	const labels = out.data.shortlist.map((candidate) => candidate.label);
	assert.equal(labels[0], "Dynamic workflow");
	// The routing hints rank the careful-review workflow above the lint one.
	assert.ok(labels.indexOf("wp32-alpha") < labels.indexOf("wp32-beta"));
	assert.match(out.text, /could not ask for your consent/);
	assert.match(
		out.text,
		/workflow_run \{"workflow":"wp32-alpha","task":"<task>"\}/,
	);
	assert.match(out.text, /claude \(host-default\)/);
	assert.doesNotMatch(out.text, new RegExp(SECRET), "the task is not echoed");
	assert.equal(await runCount(cwd), 0);
});

test("consent declined: zero classifier submits; the preview shows task, candidates and executor/model", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	let seen;
	const out = await api.autoAction(
		{ cwd, env, host: "codex" },
		{
			task: TASK,
			model: "gpt-test-mini",
			consent: {
				source: "prompt",
				confirm: async (title, message, preview) => {
					seen = { title, message, preview };
					return false;
				},
			},
		},
	);
	assert.equal(out.data.phase, "consent-declined");
	assert.equal(out.data.classifierCalled, false);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	assert.match(seen.title, /Send this task to codex/);
	assert.match(seen.message, /codex \(host-default\), model gpt-test-mini/);
	assert.ok(seen.message.includes(TASK), "the preview shows the task text");
	assert.match(seen.message, /wp32-alpha/);
	assert.equal(seen.preview.classifier.executor, "codex");
	assert.equal(seen.preview.taskCharacters, Array.from(TASK).length);
	assert.match(out.text, /did not agree/);
});

test("consent accepted: exactly one classifier submit on the host's default executor", async (t) => {
	const cases = [
		{
			host: "claude-code",
			probes: { pi: READY, claude: READY, codex: READY },
			expect: "claude",
		},
		{
			host: "codex",
			probes: { pi: READY, claude: READY, codex: READY },
			expect: "codex",
		},
		{
			host: "pi",
			probes: { pi: READY, claude: READY, codex: READY },
			expect: "pi",
		},
		// The terminal CLI: the first installed and logged-in of pi → claude → codex.
		{
			host: "cli",
			probes: { pi: NOT_INSTALLED, claude: READY, codex: READY },
			expect: "claude",
		},
	];
	for (const item of cases)
		await t.test(item.host, async () => {
			const { cwd, env } = await project();
			const logs = shadow(item.probes);
			try {
				const out = await api.autoAction(
					{ cwd, env, host: item.host },
					{
						task: TASK,
						consent: { source: "prompt", confirm: async () => true },
					},
				);
				assert.equal(out.data.phase, "ranked", out.text);
				assert.equal(out.outcome, "success");
				assert.equal(out.data.classifierCalled, true);
				assert.equal(out.data.classifier.executor, item.expect);
				const submits = allClassifierSubmits(logs);
				for (const id of Object.keys(submits))
					assert.equal(
						submits[id],
						id === item.expect ? 1 : 0,
						`${item.host}: ${JSON.stringify(submits)}`,
					);
				const [submit] = classifierSubmits(logs[item.expect]);
				assert.deepEqual(submit.tools, []);
				assert.equal(submit.readOnly, true);
				assert.equal(out.data.recommendation?.label, "wp32-alpha");
				assert.equal(out.data.ranked[0].label, "wp32-alpha");
				assert.equal(out.data.ranked[0].recommended, true);
				assert.match(out.text, /Recommended: wp32-alpha/);
				assert.match(out.text, /Reason: wp32-alpha fits the supplied task\./);
				assert.match(out.text, /No workflow has been started\./);
			} finally {
				for (const undo of unregister.splice(0).reverse()) undo();
				core.resetExecutorProbeCacheForTests();
			}
		});
});

test("a run flag and a saved user profile select the classifier executor (Q5: the run's rule)", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const flagged = await api.resolveAutoClassifier(
		{ cwd, env, host: "pi", runtimeDefaults: { model: "p/m", executor: "pi" } },
		{ executor: "codex" },
	);
	assert.deepEqual(
		[flagged.executor, flagged.source, flagged.model],
		["codex", "run-flag", null],
		"the Pi model belongs to pi only",
	);
	const pi = await api.resolveAutoClassifier(
		{
			cwd,
			env,
			host: "pi",
			runtimeDefaults: { model: "p/m", thinking: "low", executor: "pi" },
		},
		{},
	);
	assert.deepEqual([pi.executor, pi.model, pi.effort], ["pi", "p/m", "low"]);
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

test("the final choice launches the selected workflow and the launch capture records the selection", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	let prompt;
	const out = await api.autoAction(
		{ cwd, env, host: "claude-code" },
		{
			task: TASK,
			consent: { source: "elicitation", confirm: async () => true },
			choose: async (shown) => {
				prompt = shown;
				// Not the recommendation: a manual choice among the ranked candidates.
				return shown.choices.find((choice) => choice.label === "wp32-beta")
					.candidateId;
			},
			launchOrigin: {
				kind: "tool",
				name: "workflow_auto",
				arguments: { task: TASK },
			},
		},
	);
	assert.equal(out.data.phase, "launched", out.text);
	assert.equal(out.outcome, "running");
	assert.equal(prompt.recommendedId, out.data.recommendation.candidateId);
	assert.equal(prompt.choices[0].label, "wp32-alpha");
	assert.equal(classifierSubmits(logs.claude).length, 1);
	const runId = out.data.launch.runId;
	assert.ok(runId);
	assert.equal(out.data.launch.executor.id, "claude");
	await settle(cwd, env, runId);
	const run = JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	assert.equal(run.name, "wp32-beta");
	const launch = run.launch;
	assert.equal(launch.schema, "agent-workflow-run-launch-v2");
	assert.equal(launch.source, "mcp:claude-code");
	assert.deepEqual(launch.entry, { kind: "tool", name: "workflow_auto" });
	assert.equal(launch.routingMode, "auto-confirmed");
	assert.equal(launch.requestKind, "named-workflow");
	const selection = launch.selection;
	assert.equal(selection.selected.label, "wp32-beta");
	assert.equal(selection.choseRecommendation, false);
	assert.equal(
		selection.candidates.find(
			(c) => c.candidateId === selection.recommendation.candidateId,
		).label,
		"wp32-alpha",
	);
	assert.deepEqual(selection.classifier, { executor: "claude", model: null });
	assert.equal(selection.consent, "elicitation");
	assert.match(selection.taskSha256, /^[0-9a-f]{64}$/);
	assert.ok(store.isWorkflowRunLaunchMetadata(launch));
	const runJson = JSON.stringify(run.launch);
	assert.doesNotMatch(runJson, new RegExp(SECRET));
	assert.ok(
		!runJson.includes("parser module"),
		"no task text in the selection",
	);
	const command = await readFile(
		join(cwd, ".agent-workflow", "workflows", runId, "launch-command.txt"),
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
		/Auto selection: wp32-beta \(recommended was wp32-alpha; \d+ candidates; classifier claude; consent elicitation\)/,
	);
});

test("choosing the recommendation records it; cancelling the choice starts nothing", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const cancelled = await api.autoAction(
		{ cwd, env, host: "pi" },
		{
			task: TASK,
			consent: { source: "prompt", confirm: async () => true },
			choose: async () => undefined,
		},
	);
	assert.equal(cancelled.data.phase, "cancelled");
	assert.equal(cancelled.outcome, "refused");
	assert.equal(await runCount(cwd), 0);
	const out = await api.autoAction(
		{ cwd, env, host: "pi" },
		{
			task: TASK,
			consent: { source: "prompt", confirm: async () => true },
			choose: async (shown) => shown.recommendedId,
			launchOrigin: { kind: "command", text: `/aw auto ${TASK}` },
		},
	);
	assert.equal(out.data.phase, "launched", out.text);
	assert.equal(classifierSubmits(logs.pi).length, 2);
	await settle(cwd, env, out.data.launch.runId);
	const record = await store.readRunRecord(cwd, out.data.launch.runId);
	assert.equal(record.launch.source, "pi");
	assert.deepEqual(record.launch.entry, { kind: "command", action: "auto" });
	assert.equal(record.launch.selection.choseRecommendation, true);
	assert.equal(record.launch.selection.selected.label, "wp32-alpha");
	assert.equal(record.launch.selection.consent, "prompt");
});

test("a workflow changed after the comparison is refused as stale; nothing starts", async () => {
	const { cwd, env } = await project();
	shadow({ pi: READY, claude: READY, codex: READY });
	const out = await api.autoAction(
		{ cwd, env, host: "codex" },
		{
			task: TASK,
			consent: { source: "flag" },
			choose: async (shown) => {
				const changed = spec("wp32-alpha", "Use for something else entirely.");
				await writeFile(
					join(cwd, "workflows", "wp32-alpha", "spec.json"),
					`${JSON.stringify(changed)}\n`,
				);
				return shown.recommendedId;
			},
		},
	);
	assert.equal(out.data.phase, "stale");
	assert.equal(out.data.consent, "flag");
	assert.equal(await runCount(cwd), 0);
});

test("launch metadata v2 validation rejects a selection outside the offered candidates", () => {
	const valid = {
		schema: "agent-workflow-run-launch-v2",
		source: "cli",
		entry: { kind: "command", action: "auto" },
		requestKind: "named-workflow",
		routingMode: "auto-confirmed",
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
			consent: "prompt",
			taskSha256: "0".repeat(64),
			confirmed: true,
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

test("CLI without a terminal: no classifier call, the shortlist and how to run it (exit 1)", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: NOT_INSTALLED, claude: READY, codex: READY });
	const { io, out, questions } = cliIo(cwd, env, { isTTY: false });
	const code = await cli.runAgentWorkflowCli(["auto", TASK], io);
	assert.equal(code, 1);
	assert.deepEqual(questions, []);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	const text = out.join("");
	assert.match(text, /could not ask for your consent/);
	assert.match(text, /agent-workflow run wp32-alpha "<task>"/);
	assert.match(text, /--yes/);
	assert.equal(await runCount(cwd), 0);
});

test("CLI --yes without a terminal: one classifier call on the installed default, ranking only", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: NOT_INSTALLED, claude: READY, codex: READY });
	const { io, out } = cliIo(cwd, env, { isTTY: false });
	const code = await cli.runAgentWorkflowCli(
		["auto", TASK, "--yes", "--json"],
		io,
	);
	assert.equal(code, 0, out.join(""));
	const json = JSON.parse(out.join(""));
	assert.equal(json.action, "auto");
	assert.equal(json.data.phase, "ranked");
	assert.equal(json.data.consent, "flag");
	assert.equal(json.data.classifier.executor, "claude");
	assert.equal(json.data.classifier.source, "installed-default");
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 1, codex: 0 });
	assert.equal(await runCount(cwd), 0);
});

test("CLI on a terminal: declining the consent question sends nothing", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { io, err, questions } = cliIo(cwd, env, {
		isTTY: true,
		answers: ["n"],
	});
	const code = await cli.runAgentWorkflowCli(["auto", TASK], io);
	assert.equal(code, 1);
	assert.equal(questions.length, 1);
	assert.match(
		questions[0],
		/Send this task to pi to compare workflows\? \[y\/N\]/,
	);
	assert.ok(err.join("").includes(TASK), "the consent preview shows the task");
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
});

test("CLI on a terminal: consent, then the pick-list; Enter starts the recommendation in the foreground", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { io, out, err, questions } = cliIo(cwd, env, {
		isTTY: true,
		answers: ["y", ""],
	});
	const code = await cli.runAgentWorkflowCli(["auto", TASK], io);
	assert.equal(code, 0, out.join("") + err.join(""));
	assert.equal(questions.length, 2);
	assert.match(
		questions[1],
		/Start which workflow\? \[1-\d+, Enter = 1, n = cancel\]/,
	);
	assert.match(err.join(""), /1\. wp32-alpha · recommended/);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 1, claude: 0, codex: 0 });
	const text = out.join("");
	assert.match(text, /Selected: wp32-alpha \(recommended\)/);
	const runId = /(workflow_[A-Za-z0-9_]+)/.exec(text)[1];
	const record = await store.readRunRecord(cwd, runId);
	assert.equal(record.status, "completed");
	assert.equal(record.launch.schema, "agent-workflow-run-launch-v2");
	assert.equal(record.launch.source, "cli");
	assert.equal(record.launch.selection.consent, "prompt");
	const command = await readFile(
		join(cwd, ".agent-workflow", "workflows", runId, "launch-command.txt"),
		"utf8",
	);
	assert.match(command, /^agent-workflow auto /);
	assert.doesNotMatch(command, new RegExp(SECRET));
});

test("CLI on a terminal: n at the pick-list starts nothing", async () => {
	const { cwd, env } = await project();
	shadow({ pi: READY, claude: READY, codex: READY });
	const { io, out } = cliIo(cwd, env, { isTTY: true, answers: ["yes", "n"] });
	const code = await cli.runAgentWorkflowCli(["auto", TASK], io);
	assert.equal(code, 1);
	assert.match(
		out.join(""),
		/Auto selection cancelled\. No workflow has been started\./,
	);
	assert.equal(await runCount(cwd), 0);
});

// Item 3: Pi `/aw auto <task>` (pi-workflow had no auto tool, so there is no aw_auto).
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

test("Pi /aw auto: consent dialog, ranked select, final confirm; the run is launched and tracked", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { pi, ctx, confirms } = piSession(cwd, env, { confirms: [true, true] });
	assert.equal(pi.tools.has("aw_auto"), false);
	await pi.commands.get("aw").handler(`auto "${TASK}"`, ctx);
	assert.equal(confirms.length, 2, JSON.stringify(ctx.notes));
	assert.match(
		confirms[0].title,
		/Send this task to pi to compare workflows\?/,
	);
	assert.match(
		confirms[0].message,
		/model anthropic\/claude-test, effort medium/,
	);
	assert.equal(confirms[1].title, "Confirm selected workflow launch");
	const [shown] = ctx.selects;
	assert.match(shown.options[0], /^1\. wp32-alpha · recommended — /);
	assert.equal(shown.options.at(-1), "Cancel (start nothing)");
	const submits = classifierSubmits(logs.pi);
	assert.equal(submits.length, 1);
	assert.equal(submits[0].model, "anthropic/claude-test");
	assert.deepEqual(allClassifierSubmits(logs), { pi: 1, claude: 0, codex: 0 });
	const [listed] = (await api.statusAction({ cwd, env })).data.runs;
	assert.ok(listed, JSON.stringify(ctx.notes));
	await settle(cwd, env, listed.runId);
	const record = await store.readRunRecord(cwd, listed.runId);
	assert.equal(record.launch.source, "pi");
	assert.deepEqual(record.launch.entry, { kind: "command", action: "auto" });
	assert.deepEqual(record.launch.selection.classifier, {
		executor: "pi",
		model: "anthropic/claude-test",
	});
	assert.equal(record.launch.selection.consent, "prompt");
	assert.ok(
		ctx.notes.some((note) =>
			/Selected: wp32-alpha \(recommended\)/.test(note.message),
		),
	);
});

test("Pi /aw auto: declining consent or the final confirmation starts nothing", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const declined = piSession(cwd, env, { confirms: [false] });
	await declined.pi.commands.get("aw").handler(`auto "${TASK}"`, declined.ctx);
	assert.equal(declined.ctx.selects.length, 0);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	assert.ok(
		declined.ctx.notes.some((note) => /did not agree/.test(note.message)),
	);
	const unconfirmed = piSession(cwd, env, { confirms: [true, false] });
	await unconfirmed.pi.commands
		.get("aw")
		.handler(`auto "${TASK}"`, unconfirmed.ctx);
	assert.equal(classifierSubmits(logs.pi).length, 1);
	assert.ok(
		unconfirmed.ctx.notes.some((note) =>
			/Auto selection cancelled/.test(note.message),
		),
	);
	const cancelled = piSession(cwd, env, {
		confirms: [true],
		select: (choices) => choices.at(-1),
	});
	await cancelled.pi.commands
		.get("aw")
		.handler(`auto "${TASK}"`, cancelled.ctx);
	assert.equal(
		cancelled.confirms.length,
		1,
		"Cancel asks no final confirmation",
	);
	assert.equal(await runCount(cwd), 0);
});

test("Pi /aw auto in print/JSON mode: no dialog, no classifier call", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { pi, ctx, confirms } = piSession(cwd, env, { ctx: { hasUI: false } });
	const writes = [];
	const write = process.stdout.write;
	process.stdout.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	try {
		await pi.commands.get("aw").handler(`auto "${TASK}"`, ctx);
	} finally {
		process.stdout.write = write;
		process.exitCode = undefined;
	}
	assert.equal(confirms.length, 0);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	const text = writes.join("");
	assert.match(text, /could not ask for your consent/);
	assert.match(text, /\/aw run wp32-alpha "<task>"/);
	assert.equal(await runCount(cwd), 0);
});

// Item 4: the host MCP server's workflow_auto (consent and choice through elicitation).
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

test("MCP workflow_auto without elicitation: no classifier call, the local shortlist", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { client } = await mcpConnect(cwd, env);
	const listed = await client.request("tools/list", {});
	assert.ok(listed.result.tools.some((tool) => tool.name === "workflow_auto"));
	const out = await client.call("workflow_auto", { task: TASK, detach: false });
	assert.equal(out.structuredContent.data.phase, "consent-unavailable");
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
	assert.match(
		out.content[0].text,
		/workflow_run \{"workflow":"wp32-alpha","task":"<task>"\}/,
	);
	assert.match(out.structuredContent.next, /show the user the shortlist/);
	assert.equal(await runCount(cwd), 0);
});

test("MCP workflow_auto: declined consent elicitation sends nothing", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { client, requests } = await mcpConnect(cwd, env, [
		{ action: "decline" },
	]);
	const out = await client.call("workflow_auto", { task: TASK, detach: false });
	assert.equal(out.structuredContent.data.phase, "consent-declined");
	assert.equal(requests.length, 1);
	assert.match(
		requests[0].params.message,
		/Send this task to codex to compare workflows\?/,
	);
	assert.ok(requests[0].params.message.includes(TASK));
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 0 });
});

test("MCP workflow_auto: consent, one classifier call on codex, the choice elicitation launches", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	let choiceSchema;
	const { client, requests } = await mcpConnect(cwd, env, [
		{ action: "accept", content: {} },
		(message) => {
			choiceSchema = message.params.requestedSchema;
			const options = choiceSchema.properties.workflow.enum;
			return {
				action: "accept",
				content: {
					workflow: options.find((option) => /wp32-beta/.test(option)),
				},
			};
		},
	]);
	const out = await client.call("workflow_auto", { task: TASK, detach: false });
	const data = out.structuredContent.data;
	assert.equal(data.phase, "launched", out.content[0].text);
	assert.equal(requests.length, 2);
	assert.deepEqual(choiceSchema.required, ["workflow"]);
	assert.match(
		choiceSchema.properties.workflow.default,
		/wp32-alpha \(recommended\)/,
	);
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 1 });
	assert.match(out.structuredContent.next, /call workflow_wait/);
	await settle(cwd, env, data.launch.runId);
	const record = await store.readRunRecord(cwd, data.launch.runId);
	assert.equal(record.name, "wp32-beta");
	assert.equal(record.launch.source, "mcp:codex");
	assert.deepEqual(record.launch.entry, {
		kind: "tool",
		name: "workflow_auto",
	});
	assert.equal(record.launch.selection.consent, "elicitation");
	assert.equal(record.launch.selection.choseRecommendation, false);
	assert.deepEqual(record.launch.selection.classifier, {
		executor: "codex",
		model: null,
	});
});

test("MCP workflow_auto: declining the choice returns the ranked list and starts nothing", async () => {
	const { cwd, env } = await project();
	const logs = shadow({ pi: READY, claude: READY, codex: READY });
	const { client } = await mcpConnect(cwd, env, [
		{ action: "accept", content: {} },
		{ action: "decline" },
	]);
	const out = await client.call("workflow_auto", { task: TASK, detach: false });
	assert.equal(out.structuredContent.data.phase, "cancelled");
	assert.equal(out.structuredContent.data.ranked[0].label, "wp32-alpha");
	assert.deepEqual(allClassifierSubmits(logs), { pi: 0, claude: 0, codex: 1 });
	assert.match(out.structuredContent.next, /Nothing started/);
	assert.equal(await runCount(cwd), 0);
});
