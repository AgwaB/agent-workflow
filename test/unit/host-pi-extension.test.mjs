// New in agent-workflow (WP11b): the minimal Pi host (src/hosts/pi). A fake Pi ExtensionAPI captures
// the registrations; a recording wrapper around the real host API checks that every `/aw` action
// and `aw_*` tool delegates to the right handler with the right arguments. Runs use the WP11a
// guarded test-executor hook (AGENT_WORKFLOW_TEST_EXECUTOR_MODULE + ACK) and the workflow executor
// fixture: no model or agent-CLI calls.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const HOOK_MODULE = join(repo, "test", "helpers", "host-test-executor.mjs");
const HOOK_EXECUTOR = "test-pi-host";

let root;
const unregister = [];
let counter = 0;

// The hook module reads its config from process.env when it is imported (once per process).
const hookRoot = await realpath(
	await mkdtemp(join(tmpdir(), "aw-host-pi-hook-")),
);
process.env.AW_HOST_TEST_EFFECT_LOG = join(hookRoot, "effects.jsonl");
process.env.AW_HOST_TEST_EXECUTOR_ID = HOOK_EXECUTOR;

const ext = await import("../../dist/hosts/pi/extension.js");
const names = await import("../../dist/hosts/pi/names.js");
const realApi = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-host-pi-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	for (const dir of [root, hookRoot])
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
});

const ONE_STAGE = {
	schemaVersion: 1,
	name: "pi-host-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(ONE_STAGE, null, 2)}\n`,
	);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
	};
	return { cwd, env };
}

/** Recording wrapper over the real host API: every call is logged, then delegated. */
function recordingApi() {
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
	return { api, calls };
}

/** Fake ExtensionAPI: captures commands, tools and event handlers; duplicate names throw. */
function fakePi({ thinking = "medium" } = {}) {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	return {
		commands,
		tools,
		handlers,
		registerCommand(name, options) {
			if (commands.has(name)) throw new Error(`duplicate command ${name}`);
			commands.set(name, options);
		},
		registerTool(tool) {
			if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		getThinkingLevel: () => thinking,
	};
}

/** Fake ExtensionContext with a dialog-capable UI (or none). */
function fakeCtx(cwd, { hasUI = true, confirm = true } = {}) {
	const notes = [];
	const confirms = [];
	return {
		cwd,
		hasUI,
		mode: hasUI ? "rpc" : "json",
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { getAvailable: () => [] },
		notes,
		confirms,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async (title, message) => {
				confirms.push({ title, message });
				return confirm;
			},
			select: async () => undefined,
		},
	};
}

function install({ env, now } = {}) {
	const pi = fakePi();
	const { api, calls } = recordingApi();
	ext.createAgentWorkflowPiExtension({ api, env, ...(now ? { now } : {}) })(pi);
	return { pi, calls, command: pi.commands.get("aw") };
}

const actionCalls = (calls) =>
	calls.filter((call) => call.name !== "registerTestExecutorFromEnv");
const lastNote = (ctx) => ctx.notes.at(-1);

async function waitUntilSettled(pi, ctx, runId) {
	const wait = pi.tools.get("aw_wait");
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const result = await wait.execute(
			"w",
			{ runId, timeoutMs: 10_000 },
			undefined,
			undefined,
			ctx,
		);
		if (!result.details.stillRunning) return result;
	}
	throw new Error(`run ${runId} did not settle`);
}

test("registration: /aw command, four aw_* tools with executor-neutral schemas, session handlers", async () => {
	const { env } = await project();
	const { pi } = install({ env });
	assert.deepEqual([...pi.commands.keys()], ["aw"]);
	assert.deepEqual(
		[...pi.tools.keys()],
		["aw_list", "aw_run", "aw_dynamic", "aw_wait"],
	);
	assert.deepEqual(names.AW_TOOL_NAMES, [
		"aw_list",
		"aw_run",
		"aw_dynamic",
		"aw_wait",
	]);
	assert.ok(pi.handlers.get("session_start")?.length === 1);
	assert.ok(pi.handlers.get("session_shutdown")?.length === 1);
	for (const tool of pi.tools.values()) {
		assert.equal(tool.parameters.type, "object");
		assert.equal(tool.parameters.additionalProperties, false);
		assert.ok(tool.description.length > 0 && tool.promptGuidelines.length > 0);
		const prose = [
			tool.description,
			tool.promptSnippet,
			...tool.promptGuidelines,
		].join("\n");
		assert.doesNotMatch(
			prose,
			/pi-workflow|workflow_(list|run|dynamic|wait)|\/workflow\b/,
		);
	}
	for (const name of ["aw_run", "aw_dynamic"]) {
		const props = pi.tools.get(name).parameters.properties;
		for (const key of [
			"task",
			"executor",
			"profile",
			"permissionMode",
			"allowUnverified",
			"model",
			"effort",
			"detach",
			"forceNew",
		])
			assert.ok(props[key], `${name}.${key}`);
		assert.deepEqual(props.permissionMode.enum, ["free", "safe"]);
		assert.match(props.executor.description, /codex/);
	}
	assert.deepEqual(pi.tools.get("aw_run").parameters.required, [
		"workflow",
		"task",
	]);
	// WP28 (Q9): pi-workflow's long waits (max 4 h).
	assert.equal(
		pi.tools.get("aw_wait").parameters.properties.timeoutMs.maximum,
		14_400_000,
	);
	assert.equal(pi.tools.get("aw_list").parameters.properties.limit.maximum, 20);
	assert.deepEqual(pi.commands.get("aw").getArgumentCompletions("re"), [
		{ value: "resume", label: "resume" },
	]);
});

test("worker role: no agent tools and no notices; /aw help and validate still work", async () => {
	const { cwd, env } = await project();
	const { pi, command } = install({
		env: { ...env, AGENT_WORKFLOW_ROLE: "worker" },
	});
	assert.deepEqual([...pi.tools.keys()], []);
	const ctx = fakeCtx(cwd);
	await command.handler("help", ctx);
	assert.match(lastNote(ctx).message, /^\/aw — agent-workflow in Pi/);
	await command.handler("validate wf.json", ctx);
	assert.match(
		lastNote(ctx).message,
		/^Workflow spec valid: pi-host-one-stage/,
	);
	await command.handler("list", ctx);
	assert.equal(lastNote(ctx).type, "error");
	assert.match(
		lastNote(ctx).message,
		/not allowed when AGENT_WORKFLOW_ROLE=worker/,
	);
});

test("/aw catalog actions delegate to the host API and show the handler text", async () => {
	const { cwd, env } = await project();
	const { calls, command } = install({ env });
	const ctx = fakeCtx(cwd);
	const run = async (args) => {
		const before = calls.length;
		await command.handler(args, ctx);
		const made = actionCalls(calls.slice(before));
		assert.equal(made.length, 1, `${args}: ${made.map((call) => call.name)}`);
		return made[0];
	};

	await command.handler("help", ctx);
	assert.match(lastNote(ctx).message, /\/aw run <workflow> <task> \[options\]/);
	assert.match(lastNote(ctx).message, /aw_list, aw_run, aw_dynamic, aw_wait/);
	const help = await run("help run");
	assert.equal(help.name, "helpAction");
	assert.deepEqual(help.args, ["run"]);
	assert.match(
		lastNote(ctx).message,
		/^Usage: \/aw run <workflow-name-or-path>/,
	);

	const list = await run("list --query deep --limit 2");
	assert.equal(list.name, "listWorkflowsAction");
	assert.equal(list.args[0].cwd, cwd);
	assert.equal(list.args[0].env, env);
	assert.deepEqual(list.args[0].availableModels, []);
	// Tagged as Pi defaults: the engine applies them only when the run's executor is pi.
	assert.deepEqual(list.args[0].runtimeDefaults, {
		model: "anthropic/claude-test",
		thinking: "medium",
		executor: "pi",
	});
	assert.deepEqual(list.args[1], { query: "deep", limit: 2 });
	const listed = await realApi.listWorkflowsAction(
		{ cwd, env },
		{ query: "deep", limit: 2 },
	);
	assert.deepEqual(lastNote(ctx), {
		message: listed.text,
		type: "info",
	});

	const validate = await run("validate wf.json");
	assert.deepEqual(
		[validate.name, validate.args[1]],
		["validateWorkflowAction", { workflow: "wf.json" }],
	);
	assert.match(
		lastNote(ctx).message,
		/^Workflow spec valid: pi-host-one-stage\nSpec: wf\.json/,
	);
	const roles = await run("roles wf.json");
	assert.deepEqual(
		[roles.name, roles.args[1]],
		["workflowRolesAction", { workflow: "wf.json" }],
	);
	// /aw check: the launch preflight (run options, task optional).
	const check = await run("check wf.json --executor codex --model gpt-6.1-sol");
	assert.deepEqual(
		[check.name, check.args[1]],
		[
			"checkWorkflowAction",
			{
				workflow: "wf.json",
				task: "preflight check",
				executor: "codex",
				model: "gpt-6.1-sol",
			},
		],
	);
	assert.equal((await run("agents")).name, "listAgentsAction");
	assert.match(lastNote(ctx).message, /reader/);
	const showSpec = await run("show wf.json");
	assert.deepEqual(
		[showSpec.name, showSpec.args[1]],
		["showAction", { ref: "wf.json" }],
	);

	const set = await run(
		"profile set fast --executor codex --effort low --default",
	);
	assert.equal(set.name, "profileAction");
	assert.deepEqual(set.args[1], {
		op: "set",
		name: "fast",
		values: { executor: "codex", effort: "low" },
		makeDefault: true,
	});
	assert.deepEqual((await run("profile")).args[1], { op: "list" });
	assert.match(lastNote(ctx).message, /fast/);
	assert.deepEqual((await run("profile show fast")).args[1], {
		op: "show",
		name: "fast",
	});
	assert.deepEqual((await run("profile default --clear")).args[1], {
		op: "default",
		name: null,
	});
	assert.deepEqual((await run("profile delete fast")).args[1], {
		op: "delete",
		name: "fast",
	});

	const notices = await run("notices list");
	assert.deepEqual(
		[notices.name, notices.args[1]],
		["noticesAction", { argv: ["list"] }],
	);
	assert.match(lastNote(ctx).message, /No eligible notices/);
	const prune = await run("prune --keep 3");
	assert.deepEqual(
		[prune.name, prune.args[1]],
		["pruneAction", { argv: ["--keep", "3"] }],
	);

	for (const [args, pattern] of [
		["frobnicate", /Unknown \/aw action "frobnicate"/],
		["validate", /Usage: \/aw validate/],
		["check", /Usage: \/aw check/],
		["list --bogus", /Unknown option --bogus/],
		["supervise --all", /Unknown \/aw action "supervise"/],
	]) {
		await command.handler(args, ctx);
		assert.equal(lastNote(ctx).type, "error", args);
		assert.match(lastNote(ctx).message, pattern);
	}
});

test("/aw run, status, show, inspect, wait, resume, stop: delegation with launch options", async () => {
	const { cwd, env } = await project();
	const { calls, command, pi } = install({ env });
	const ctx = fakeCtx(cwd);
	await command.handler(
		`run --executor ${HOOK_EXECUTOR} wf.json "collect the facts --literal" --permission-mode free --effort low --force-new`,
		ctx,
	);
	const launch = actionCalls(calls).at(-1);
	assert.equal(launch.name, "runWorkflowAction");
	const { confirmDegradations, selectProfile, ...request } = launch.args[1];
	assert.deepEqual(request, {
		workflow: "wf.json",
		task: "collect the facts --literal",
		executor: HOOK_EXECUTOR,
		permissionMode: "free",
		effort: "low",
		forceNew: true,
		interactive: true,
		// WP33: launch capture (the host API redacts it before writing).
		launchOrigin: {
			kind: "command",
			text: `/aw run --executor ${HOOK_EXECUTOR} wf.json "collect the facts --literal" --permission-mode free --effort low --force-new`,
		},
	});
	assert.equal(typeof confirmDegradations, "function");
	assert.equal(typeof selectProfile, "function");
	// A non-pi executor does not inherit Pi's current model as a runtime default.
	assert.equal(launch.args[0].runtimeDefaults, undefined);
	assert.match(lastNote(ctx).message, /Workflow started: pi-host-one-stage/);
	const runId = (await realApi.statusAction({ cwd, env })).data.runs[0].runId;

	const waited = await waitUntilSettled(pi, ctx, runId);
	assert.equal(waited.details.status, "completed");

	const sliceFrom = calls.length;
	for (const args of [
		`wait ${runId} --timeout 2m`,
		`status ${runId}`,
		"status",
		`show ${runId} --raw`,
		`inspect ${runId} --failures --results`,
		`resume ${runId}`,
		`stop ${runId}`,
	])
		await command.handler(args, ctx);
	const made = actionCalls(calls.slice(sliceFrom)).map((call) => [
		call.name,
		call.args[1],
	]);
	assert.deepEqual(made, [
		// WP28: a long wait (until terminal or the timeout).
		["waitAction", { runId, longWait: true, timeoutMs: 120_000 }],
		["statusAction", { runId }],
		["statusAction", {}],
		["showAction", { ref: runId, raw: true }],
		["inspectAction", { runId, failures: true, results: true }],
		["resumeAction", { runId }],
		["stopAction", { runId }],
	]);
	const waitNote = ctx.notes.at(-7);
	assert.equal(waitNote.type, "info");
	const direct = await realApi.waitAction(
		{ cwd, env },
		{ runId, timeoutMs: 1_000 },
	);
	assert.equal(waitNote.message, direct.text);
	// Run texts carry /aw hints in the Pi host; no core text names a /workflow command.
	for (const note of ctx.notes)
		assert.doesNotMatch(note.message, /\/workflow /);
	assert.ok(
		ctx.notes.some((note) =>
			/\/aw (status|resume) workflow_/.test(note.message),
		),
	);

	await command.handler(
		`dynamic --executor no-such-executor "explore the repo"`,
		ctx,
	);
	const dynamic = actionCalls(calls).at(-1);
	assert.equal(dynamic.name, "runDynamicAction");
	assert.equal(dynamic.args[1].task, "explore the repo");
	assert.equal(dynamic.args[1].executor, "no-such-executor");
	assert.equal(lastNote(ctx).type, "warning");
});

test("tools: aw_list, aw_run, aw_wait (long wait, semantic fields, preview) and aw_dynamic refusal", async () => {
	const { cwd, env } = await project();
	const { calls, pi } = install({ env });
	const ctx = fakeCtx(cwd);
	const listed = await pi.tools
		.get("aw_list")
		.execute("l", { query: "deep", limit: 1 }, undefined, undefined, ctx);
	const listCall = actionCalls(calls).at(-1);
	assert.deepEqual(
		[listCall.name, listCall.args[1]],
		["listWorkflowsAction", { query: "deep", limit: 1 }],
	);
	assert.equal(listed.details.workflows.length, 1);
	assert.equal(listed.details.nextOffset, 1);
	assert.match(listed.content[0].text, /Continue with offset=1/);
	const defaultPage = await pi.tools
		.get("aw_list")
		.execute("l2", {}, undefined, undefined, ctx);
	assert.deepEqual(actionCalls(calls).at(-1).args[1], { limit: 20 });
	assert.ok(defaultPage.details.workflows.length <= 20);

	const started = await pi.tools.get("aw_run").execute(
		"r",
		{
			workflow: "wf.json",
			task: "tool task",
			executor: HOOK_EXECUTOR,
			permissionMode: "free",
			model: "m-1",
			allowUnverified: ["contextIsolation"],
		},
		undefined,
		undefined,
		ctx,
	);
	const runCall = actionCalls(calls).at(-1);
	assert.equal(runCall.name, "runWorkflowAction");
	const {
		confirmDegradations: _c,
		selectProfile: _s,
		...runRequest
	} = runCall.args[1];
	assert.deepEqual(runRequest, {
		workflow: "wf.json",
		task: "tool task",
		executor: HOOK_EXECUTOR,
		permissionMode: "free",
		allowUnverifiedCapabilities: ["contextIsolation"],
		model: "m-1",
		interactive: true,
		// WP33: launch capture: the tool call's arguments.
		launchOrigin: {
			kind: "tool",
			name: "aw_run",
			arguments: {
				workflow: "wf.json",
				task: "tool task",
				executor: HOOK_EXECUTOR,
				permissionMode: "free",
				model: "m-1",
				allowUnverified: ["contextIsolation"],
			},
		},
	});
	assert.equal(started.details.outcome, "running");
	assert.equal(started.details.status, "running");
	assert.equal(started.isError, undefined);
	assert.match(started.details.waitWith, /^aw_wait /);
	const runId = started.details.runId;

	const updates = [];
	const wait = pi.tools.get("aw_wait");
	let result;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		result = await wait.execute(
			"w",
			{ runId, timeoutMs: 90_000 },
			undefined,
			(update) => updates.push(update),
			ctx,
		);
		const waitCall = actionCalls(calls).at(-1);
		assert.equal(waitCall.name, "waitAction");
		assert.equal(waitCall.args[1].runId, runId);
		assert.equal(waitCall.args[1].timeoutMs, 90_000);
		assert.equal(waitCall.args[1].longWait, true);
		assert.equal(typeof waitCall.args[1].onProgress, "function");
		// WP28: Pi waits are long (no 45 s cap).
		assert.equal(result.details.timeoutMs, 90_000);
		if (!result.details.stillRunning) break;
	}
	assert.equal(result.details.outcome, "completed");
	assert.equal(result.details.terminal, true);
	assert.equal(result.details.actionRequired, false);
	assert.equal(result.details.stillRunning, false);
	assert.equal(typeof result.details.semanticStatus, "string");
	assert.ok(
		"preview" in result.details ||
			result.content[0].text.includes("Final result preview"),
	);
	const direct = await realApi.waitAction(
		{ cwd, env },
		{ runId, timeoutMs: 1_000 },
	);
	assert.equal(result.content[0].text, direct.text);
	assert.equal(result.details.preview, direct.data.preview);

	const refused = await pi.tools
		.get("aw_dynamic")
		.execute(
			"d",
			{ task: "explore", executor: "no-such-executor" },
			undefined,
			undefined,
			ctx,
		);
	const dynamicCall = actionCalls(calls).at(-1);
	assert.equal(dynamicCall.name, "runDynamicAction");
	assert.equal(dynamicCall.args[1].task, "explore");
	assert.equal(refused.isError, true);
	assert.equal(refused.details.outcome, "refused");
	assert.equal(refused.details.mode, "direct-dynamic");

	await assert.rejects(
		pi.tools
			.get("aw_run")
			.execute(
				"bad",
				{ workflow: "wf.json", task: "t", permissionMode: "yolo" },
				undefined,
				undefined,
				ctx,
			),
		/permissionMode must be "free" or "safe"/,
	);
	await assert.rejects(
		pi.tools
			.get("aw_wait")
			.execute("bad", { runId: "workflow_nope" }, undefined, undefined, ctx),
		/workflow_nope/,
	);
});

test("confirmation: Pi UI confirm when interactive (decline/accept); no UI = non-interactive", async () => {
	const { cwd, env } = await project();
	counter += 1;
	const degraded = `test-pi-degraded-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: degraded,
				effectLog: join(root, `${degraded}.jsonl`),
				capabilities: {
					contextIsolation: {
						level: "emulated",
						source: "probed",
						warning: "global AGENTS.md loaded",
					},
				},
			}),
		),
	);
	const { command, pi } = install({ env });
	const args = (task) =>
		`run wf.json "${task}" --executor ${degraded} --permission-mode safe`;

	const declining = fakeCtx(cwd, { confirm: false });
	await command.handler(args("declined"), declining);
	assert.equal(declining.confirms.length, 1);
	assert.equal(
		declining.confirms[0].title,
		"Proceed with these executor capability degradations?",
	);
	assert.match(declining.confirms[0].message, /global AGENTS\.md loaded/);
	assert.equal(lastNote(declining).type, "warning");
	assert.match(
		lastNote(declining).message,
		/CAPABILITY_DEGRADATION_DECLINED|declined/i,
	);

	const accepting = fakeCtx(cwd, { confirm: true });
	const accepted = await pi.tools.get("aw_run").execute(
		"r",
		{
			workflow: "wf.json",
			task: "accepted",
			executor: degraded,
			permissionMode: "safe",
		},
		undefined,
		undefined,
		accepting,
	);
	assert.equal(accepting.confirms.length, 1);
	assert.equal(accepted.details.capability.confirmation, "confirmed");
	await waitUntilSettled(pi, accepting, accepted.details.runId);

	// No dialog-capable UI (print/json mode): no confirm call, degradations recorded, run proceeds.
	const headless = fakeCtx(cwd, { hasUI: false });
	const writes = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk, ...rest) => {
		writes.push(String(chunk));
		return typeof rest.at(-1) === "function" ? (rest.at(-1)(), true) : true;
	};
	try {
		await command.handler(args("headless"), headless);
	} finally {
		process.stdout.write = original;
	}
	assert.equal(headless.confirms.length, 0);
	assert.equal(headless.notes.length, 0);
	assert.match(writes.join(""), /Workflow started: pi-host-one-stage/);
	const headlessRun = (await realApi.statusAction({ cwd, env })).data.runs.find(
		(run) => run.status === "running",
	);
	if (headlessRun) await waitUntilSettled(pi, headless, headlessRun.runId);
	const runs = (await realApi.statusAction({ cwd, env })).data.runs;
	assert.equal(runs.length, 2, "declined launch created no run");
	const records = await Promise.all(
		runs.map((run) =>
			realApi.showAction({ cwd, env }, { ref: run.runId, raw: true }),
		),
	);
	const confirmations = records
		.map((shown) => JSON.stringify(shown.data.run))
		.join("\n");
	assert.match(confirmations, /non-interactive/);
	process.exitCode = undefined;
});

async function writeRun(cwd, runId, fields) {
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await mkdir(dir, { recursive: true });
	const run = {
		runId,
		name: "noticed",
		status: "failed",
		type: "artifact-graph",
		createdAt: fields.updatedAt,
		tasks: [],
		taskSummary: {
			total: 1,
			completed: 0,
			failed: 1,
			interrupted: 0,
			running: 0,
			pending: 0,
			blocked: 0,
		},
		...fields,
	};
	await writeFile(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
	return createHash(await readFile(join(dir, "run.json"), "utf8"));
}

function createHash(text) {
	return import("node:crypto").then(({ createHash: hash }) =>
		hash("sha256").update(text).digest("hex"),
	);
}

test("session start: unfinished-run notice through the host API notices handler, deduplicated, non-blocking", async () => {
	const { cwd, env } = await project();
	const base = Date.parse("2026-10-20T12:00:00.000Z");
	let now = base;
	const { pi, calls, command } = install({ env, now: () => now });
	const start = async (ctx) => {
		const returned = pi.handlers.get("session_start")[0](
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		assert.equal(
			returned,
			undefined,
			"session_start never returns a promise (startup is not delayed)",
		);
		await ext.unfinishedNoticeSettledForTests(pi);
	};

	const empty = fakeCtx(cwd);
	await start(empty);
	assert.deepEqual(empty.notes, []);

	const fresh = "workflow_fresh_failed";
	const sha = await writeRun(cwd, fresh, {
		updatedAt: new Date(base - 60_000).toISOString(),
	});
	await writeRun(cwd, "workflow_old_failed", {
		updatedAt: new Date(base - 8 * 24 * 3600_000).toISOString(),
	});
	await writeRun(cwd, "workflow_done", {
		status: "completed",
		updatedAt: new Date(base).toISOString(),
	});

	const first = fakeCtx(cwd);
	await start(first);
	assert.equal(first.notes.length, 1);
	assert.equal(first.notes[0].type, "warning");
	assert.match(
		first.notes[0].message,
		/^Unfinished agent-workflow run in this project:/,
	);
	assert.match(
		first.notes[0].message,
		/workflow_fresh_failed: failed .*\/aw resume workflow_fresh_failed/,
	);
	assert.doesNotMatch(
		first.notes[0].message,
		/workflow_old_failed|workflow_done/,
	);
	const noticeCalls = calls.filter((call) => call.name === "noticesAction");
	assert.deepEqual(noticeCalls.at(-1).args[1], { argv: ["list"] });
	assert.equal(noticeCalls.at(-1).args[0].cwd, cwd);

	const again = fakeCtx(cwd);
	await start(again);
	assert.deepEqual(
		again.notes,
		[],
		"unchanged run within 6 hours is not re-notified",
	);

	now = base + 7 * 3600_000;
	const later = fakeCtx(cwd);
	await start(later);
	assert.equal(later.notes.length, 1, "re-notified after 6 hours");

	const ackCtx = fakeCtx(cwd);
	await command.handler(
		`notices acknowledge ${fresh} --state ${await sha} --reason "known flaky"`,
		ackCtx,
	);
	assert.equal(lastNote(ackCtx).type, "info", lastNote(ackCtx).message);
	now = base + 20 * 3600_000;
	const acknowledged = fakeCtx(cwd);
	await start(acknowledged);
	assert.deepEqual(
		acknowledged.notes,
		[],
		"an active acknowledgement suppresses the notice",
	);

	const state = JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow", "workflows", "unfinished-notices.json"),
			"utf8",
		),
	);
	assert.deepEqual(Object.keys(state.notices), [fresh]);

	// No UI: no notification attempt; a stale session (shutdown before the notice) stays quiet.
	await writeRun(cwd, "workflow_second", {
		status: "interrupted",
		updatedAt: new Date(now - 1_000).toISOString(),
	});
	const quiet = fakeCtx(cwd, { hasUI: false });
	await start(quiet);
	assert.deepEqual(quiet.notes, []);
});

test("./hosts/pi entry: clear error without Pi; nothing else imports the Pi host", async () => {
	let piAvailable = true;
	try {
		await import(["@earendil-works", "pi-coding-agent"].join("/"));
	} catch {
		piAvailable = false;
	}
	const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	// WP33: plus the aw- named Pi skills (host-wp33-pi-skills.test.mjs).
	assert.deepEqual(pkg.pi, {
		extensions: ["./dist/hosts/pi/index.js"],
		skills: [
			"./plugins/pi/skills/workflow-guide",
			"./plugins/pi/skills/execution-router",
		],
	});
	assert.equal(pkg.exports["./hosts/pi"].default, "./dist/hosts/pi/index.js");
	for (const peer of [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
	]) {
		assert.equal(pkg.peerDependenciesMeta[peer]?.optional, true, peer);
		assert.equal(pkg.dependencies?.[peer], undefined, peer);
	}
	if (piAvailable) {
		const mod = await import("../../dist/hosts/pi/index.js");
		assert.equal(mod.MODULE, "src/hosts/pi");
		assert.equal(typeof mod.default, "function");
	} else {
		await assert.rejects(import("../../dist/hosts/pi/index.js"), (error) => {
			assert.equal(error.name, "PiHostUnavailableError");
			assert.match(
				error.message,
				/is a Pi extension and needs the Pi coding agent/,
			);
			assert.match(error.message, /optional peer dependency/);
			assert.match(error.message, /pi -e /);
			assert.match(error.message, /do not need Pi/);
			return true;
		});
	}

	// No module outside src/hosts/pi (and dist/hosts/pi) imports the Pi host.
	const offenders = [];
	for (const [base, ext] of [
		["src", ".ts"],
		["dist", ".js"],
	]) {
		const piDir = resolve(repo, base, "hosts", "pi");
		for (const file of listFiles(resolve(repo, base)).filter((path) =>
			path.endsWith(ext),
		)) {
			if (file.startsWith(`${piDir}/`)) continue;
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(
				/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g,
			)) {
				const spec = match[1];
				const target = spec.startsWith(".")
					? resolve(dirname(file), spec)
					: spec;
				if (
					target.startsWith(`${piDir}/`) ||
					target === piDir ||
					/hosts\/pi(\/|$)/.test(spec)
				)
					offenders.push(`${relative(repo, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}
