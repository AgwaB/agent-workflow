// test-tier: integration
// Role-profile picker tests cover probed model lists, previews, and scripted editing.
// Back/cancel writes nothing; Save writes a user profile or workflow preference via
// the host API. Fake TUI integration covers Custom launch choices; RPC keeps text.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const realApi = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const picker = await import("../../dist/hosts/pi/profile-picker.js");
const tui = await import("../../dist/hosts/pi/profile-tui.js");
const host = await import("../../dist/hosts/pi/host.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

const ENTER = "\r";
const DOWN = "\u001b[B";

const MODELS = [
	{
		id: "pi",
		usable: true,
		state: "ready",
		models: ["anthropic/claude-test", "openai/gpt-x"],
		modelListComplete: false,
		note: realApi.modelListNote(
			["anthropic/claude-test", "openai/gpt-x"],
			false,
		),
	},
	{
		id: "claude",
		usable: true,
		state: "ready",
		models: ["sonnet", "opus", "haiku"],
		modelListComplete: false,
		note: realApi.modelListNote(["sonnet", "opus", "haiku"], false),
	},
	{
		id: "codex",
		usable: false,
		state: "not-installed",
		models: null,
		modelListComplete: false,
		note: realApi.modelListNote(null, false),
	},
];

let root;
let counter = 0;
const unregister = [];
const instances = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp34-profile-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const { pi } of instances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const SPEC = {
	schemaVersion: 1,
	name: "wp34-profile",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

async function project(spec = SPEC) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(spec)}\n`);
	const id = `test-wp34-profile-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				stepDelayMs: 50,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, executor: id, ctx: { cwd, env, host: "pi" } };
}

/** The real host API, with executorModelsAction answering MODELS (no probe). */
function fakeModelsApi() {
	const calls = [];
	const api = {};
	for (const [name, value] of Object.entries(realApi)) {
		if (
			typeof value !== "function" ||
			!/Action$|^registerTestExecutorFromEnv$/.test(name)
		)
			continue;
		api[name] = (...args) => {
			calls.push({ name, request: args[1] });
			return value(...args);
		};
	}
	api.executorModelsAction = async () => {
		calls.push({ name: "executorModelsAction" });
		return {
			action: "profile",
			ok: true,
			outcome: "success",
			data: { executors: MODELS },
			text: "",
		};
	};
	return { api, calls };
}

/** A scripted picker UI: each step is [kind, answer(payload)]. */
function scripted(steps) {
	const calls = [];
	const next = (kind, payload) => {
		calls.push({ kind, ...payload });
		const step = steps.shift();
		if (!step) return undefined;
		assert.equal(
			step[0],
			kind,
			`expected ${step[0]}, got ${kind}: ${JSON.stringify(payload).slice(0, 300)}`,
		);
		return step[1](payload);
	};
	return {
		calls,
		steps,
		ui: {
			select: async (title, options) => next("select", { title, options }),
			preview: async (preview) => next("preview", { preview }),
			input: async (title, placeholder) =>
				next("input", { title, placeholder }),
			confirm: async (title, message) => next("confirm", { title, message }),
			notify: (message, level) =>
				calls.push({ kind: "notify", message, level }),
		},
	};
}

const pick =
	(pattern) =>
	({ options }) => {
		const found = options.find((option) =>
			typeof pattern === "string"
				? option.startsWith(pattern)
				: pattern.test(option),
		);
		assert.ok(found, `no option ${pattern} in ${options.join(" | ")}`);
		return found;
	};
const answer = (value) => () => value;

// --- executorModelsAction ------------------------------------------------------------------------

test("executorModelsAction reports each probe's models and the modelListComplete note", async () => {
	const probes = {
		pi: {
			installed: true,
			auth: "ok",
			models: ["a/one", "b/two"],
			modelListComplete: true,
		},
		claude: {
			installed: true,
			auth: "unknown",
			notes: ["models: sonnet, opus"],
		},
		codex: { installed: false, auth: "missing" },
	};
	const result = await realApi.executorModelsAction(
		{ cwd: root },
		{
			executors: ["pi", "claude", "codex", "nope"],
			prober: async (descriptor) => ({
				capabilities: {},
				probe: probes[descriptor.id],
			}),
		},
	);
	const [pi, claude, codex, nope] = result.data.executors;
	assert.deepEqual(pi.models, ["a/one", "b/two"]);
	assert.equal(pi.modelListComplete, true);
	assert.match(
		pi.note,
		/complete \(modelListComplete\): another id is refused/,
	);
	assert.deepEqual(claude.models, ["sonnet", "opus"]);
	assert.equal(claude.modelListComplete, false);
	assert.match(
		claude.note,
		/partial \(modelListComplete: false\): another id is only noted/,
	);
	assert.equal(codex.usable, false);
	assert.equal(codex.state, "not-installed");
	assert.equal(nope.state, "unavailable");
	const failing = await realApi.executorModelsAction(
		{ cwd: root },
		{
			executors: ["pi"],
			prober: async () => {
				throw new Error("boom");
			},
		},
	);
	assert.equal(failing.data.executors[0].state, "probe-failed");
	assert.match(failing.data.executors[0].note, /probe failed: boom/);
	assert.deepEqual(failing.data.executors[0].effortLevels, []);
});

test("executorModelsAction reports the adapter's effort levels and per-model levels (2026-11-11)", async () => {
	const result = await realApi.executorModelsAction(
		{ cwd: root },
		{
			executors: ["codex", "claude"],
			prober: async (descriptor) => ({
				capabilities:
					descriptor.id === "codex"
						? { effortLevels: ["low", "medium", "high", "ultra"] }
						: {},
				probe: {
					installed: true,
					auth: "ok",
					...(descriptor.id === "codex"
						? { modelEfforts: { "gpt-x": ["low", "medium"] } }
						: {}),
				},
			}),
		},
	);
	const [codex, claude] = result.data.executors;
	assert.deepEqual(codex.effortLevels, ["low", "medium", "high", "ultra"]);
	assert.deepEqual(codex.modelEfforts, { "gpt-x": ["low", "medium"] });
	assert.deepEqual(claude.effortLevels, []);
	assert.equal("modelEfforts" in claude, false);
});

// --- preview -------------------------------------------------------------------------------------

test("preview rows: effective values per role, inherited roles, model-list warnings", () => {
	const { rows, notes } = picker.profilePreviewRows(
		{
			default: { executor: "claude", model: "gpt-x", effort: "medium" },
			verification: { executor: "codex", effort: "high" },
		},
		[{ ...MODELS[1], modelListComplete: true, note: "claude note" }, MODELS[2]],
	);
	const byRole = Object.fromEntries(rows.map((row) => [row.role, row]));
	assert.deepEqual(
		rows.map((row) => row.role),
		[
			"default",
			"planning",
			"research-execution",
			"synthesis",
			"verification",
			"final-judgment",
		],
	);
	assert.match(
		byRole.default.warning,
		/not in claude's complete model list: refused at launch/,
	);
	assert.equal(byRole.planning.inherited, true);
	assert.equal(byRole.planning.executor, "claude");
	assert.equal(byRole.verification.executor, "codex");
	assert.equal(byRole.verification.model, "(executor default)");
	assert.match(byRole.verification.warning, /codex is not-installed/);
	assert.deepEqual(notes, ["claude: claude note", `codex: ${MODELS[2].note}`]);
	const partial = picker.profilePreviewRows(
		{ default: { executor: "claude", model: "gpt-x" } },
		[MODELS[1]],
	);
	assert.match(
		partial.rows[0].warning,
		/probe list \(partial\): noted at launch/,
	);
});

test("renderProfilePreview: responsive table and executor colours", () => {
	const colors = [];
	const theme = {
		bold: (text) => text,
		fg: (color, text) => {
			colors.push(color);
			return text;
		},
	};
	const { rows, notes } = picker.profilePreviewRows(
		{
			default: { executor: "claude", model: "sonnet", effort: "medium" },
			"research-execution": {
				executor: "codex",
				model: "gpt-5.6-luna",
				effort: "medium",
			},
			planning: { executor: "pi", effort: "high" },
		},
		MODELS,
	);
	const preview = {
		title: "Mixed",
		subtitle: "role preview",
		rows,
		notes,
		actions: [],
	};
	const wide = tui.renderProfilePreview(preview, theme, 100);
	assert.match(wide[0], /Mixed {2}role preview/);
	assert.match(wide[1], /ROLE\s+EXECUTOR\s+MODEL\s+EFFORT/);
	assert.match(
		wide.join("\n"),
		/research-execution\s+codex\s+gpt-5\.6-luna\s+medium/,
	);
	assert.match(wide.join("\n"), /synthesis\s+claude\s+sonnet\s+medium/);
	assert.ok(wide.every((line) => [...line].length <= 100));
	for (const color of [
		"accent",
		"mdLink",
		"mdHeading",
		"dim",
		"muted",
		"borderMuted",
		"warning",
	])
		assert.ok(colors.includes(color), `missing ${color}`);
	const narrow = tui.renderProfilePreview(preview, theme, 48);
	assert.ok(narrow.every((line) => [...line].length <= 48));
	assert.match(narrow.join("\n"), /research-execution \[codex\]/);
	assert.match(narrow.join("\n"), / {3}gpt-5\.6-luna · medium/);
});

// --- flow ----------------------------------------------------------------------------------------

test("Back and cancel write nothing", async () => {
	const { ctx } = await project();
	const { api } = fakeModelsApi();
	const script = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick("Codex —")],
		["preview", answer("back")],
		["select", answer(undefined)],
	]);
	const result = await picker.runProfilePicker(script.ui, api, ctx);
	assert.deepEqual(result, { status: "cancelled" });
	assert.equal(script.steps.length, 0);
	const profileList = script.calls.find(
		(call) => call.kind === "select" && /every workflow/.test(call.title),
	);
	assert.deepEqual(
		profileList.options.map((option) => option.split(" ")[0]),
		["Codex", "Claude", "Pi", "Mixed", "Custom…"],
	);
	assert.deepEqual(
		(await realApi.profileAction(ctx, { op: "list" })).data.profiles,
		[],
	);
	assert.deepEqual(
		(await realApi.workflowPreferenceAction(ctx, { op: "list" })).data
			.preferences,
		[],
	);
});

test("a preset saved as a new default user profile", async () => {
	const { ctx } = await project();
	const { api } = fakeModelsApi();
	let shown;
	const script = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick("Mixed —")],
		[
			"preview",
			({ preview }) => {
				shown = preview;
				return "save";
			},
		],
		["select", pick(picker.NEW_PROFILE)],
		["input", answer("team")],
		["confirm", answer(true)],
	]);
	const result = await picker.runProfilePicker(script.ui, api, ctx);
	assert.equal(result.status, "saved");
	assert.match(result.text, /Saved profile:/);
	assert.equal(shown.title, "Mixed");
	const research = shown.rows.find((row) => row.role === "research-execution");
	assert.equal(research.executor, "codex");
	assert.match(research.warning, /codex is not-installed/);
	const saved = await realApi.profileAction(ctx, { op: "show", name: "team" });
	assert.equal(saved.data.default, "team");
	assert.equal(saved.data.profile.executor, "claude");
	assert.equal(
		saved.data.profile.roles["research-execution"].executor,
		"codex",
	);
});

test("saving under an executor's name says it is that executor's default profile; declining saves nothing", async () => {
	const { ctx } = await project();
	const { api } = fakeModelsApi();
	let warned;
	const declined = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick("Codex —")],
		["preview", answer("save")],
		["select", pick(picker.NEW_PROFILE)],
		[
			"input",
			({ placeholder }) => {
				assert.equal(placeholder, "codex");
				return "codex";
			},
		],
		[
			"confirm",
			({ title, message }) => {
				warned = { title, message };
				return false;
			},
		],
	]);
	const first = await picker.runProfilePicker(declined.ui, api, ctx);
	assert.equal(first.status, "cancelled");
	assert.equal(warned.title, '"codex" is the default profile of codex stages');
	assert.match(
		warned.message,
		/profile delete codex restores the built-in one/,
	);
	assert.equal(
		(await realApi.profileAction(ctx, { op: "show", name: "codex" })).data
			.builtIn,
		true,
	);
	const accepted = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick("Codex —")],
		["preview", answer("save")],
		["select", pick(picker.NEW_PROFILE)],
		["input", answer("codex")],
		["confirm", answer(true)],
		["confirm", answer(false)],
	]);
	const second = await picker.runProfilePicker(accepted.ui, api, ctx);
	assert.equal(second.status, "saved");
	assert.match(second.text, /codex \(default profile of codex stages\)/);
	const listed = scripted([
		["select", pick(picker.SCOPE_USER)],
		[
			"select",
			({ options }) => {
				assert.ok(
					options.includes("Saved: codex (default profile of codex stages)"),
					options.join(" | "),
				);
				return undefined;
			},
		],
	]);
	assert.equal(
		(await picker.runProfilePicker(listed.ui, api, ctx)).status,
		"cancelled",
	);
	// Other names are saved without the extra question.
	const team = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick("Codex —")],
		["preview", answer("save")],
		["select", pick(picker.NEW_PROFILE)],
		["input", answer("team")],
		["confirm", answer(false)],
	]);
	assert.equal(
		(await picker.runProfilePicker(team.ui, api, ctx)).status,
		"saved",
	);
});

test("Custom: per-role executor, model from the probe list and effort; saved as a user profile", async () => {
	const { ctx } = await project();
	const { api } = fakeModelsApi();
	const script = scripted([
		["select", pick(picker.SCOPE_USER)],
		["select", pick(picker.CUSTOM_CHOICE)],
		["select", pick(/^verification — /)],
		["select", pick("Executor:")],
		[
			"select",
			({ options }) => {
				assert.deepEqual(options, [
					"(the default role's executor)",
					"pi",
					"claude",
					"codex (not-installed)",
				]);
				return "claude";
			},
		],
		["select", pick("Model:")],
		[
			"select",
			({ title, options }) => {
				assert.match(title, /Model for verification on claude/);
				assert.match(title, /partial \(modelListComplete: false\)/);
				assert.deepEqual(options, [
					"(executor default)",
					"sonnet",
					"opus",
					"haiku",
					"Other model id…",
				]);
				return "opus";
			},
		],
		["select", pick("Effort:")],
		["select", pick("low")],
		["select", pick("Done")],
		["select", pick("Done")],
		[
			"preview",
			({ preview }) => {
				assert.equal(preview.title, "Custom (from Pi)");
				const row = preview.rows.find((entry) => entry.role === "verification");
				assert.deepEqual(
					[row.executor, row.model, row.effort, row.inherited],
					["claude", "opus", "low", false],
				);
				return "save";
			},
		],
		[
			"select",
			({ options }) => {
				assert.deepEqual(options, [picker.NEW_PROFILE]);
				return options[0];
			},
		],
		["input", answer("custom1")],
		["confirm", answer(false)],
	]);
	const result = await picker.runProfilePicker(script.ui, api, ctx);
	assert.equal(result.status, "saved");
	const saved = await realApi.profileAction(ctx, {
		op: "show",
		name: "custom1",
	});
	assert.equal(saved.data.default, undefined, "not made the default");
	assert.equal(saved.data.profile.executor, "pi");
	assert.deepEqual(saved.data.profile.roles.verification, {
		executor: "claude",
		model: "opus",
		effort: "low",
	});
	assert.equal(saved.data.profile.roles.default.executor, "pi");
});

test("workflow scope: a preset plus an edited role becomes the workflow's preference", async () => {
	const { ctx } = await project();
	const { api } = fakeModelsApi();
	const script = scripted([
		[
			"select",
			({ title, options }) => {
				assert.match(title, /Execution profile for workflow wp34-profile/);
				return options.find((option) => option.startsWith("Claude —"));
			},
		],
		["preview", answer("edit")],
		["select", pick(/^synthesis — /)],
		["select", pick("Effort:")],
		["select", pick("low")],
		["select", pick("Done")],
		["select", pick("Done")],
		[
			"preview",
			({ preview }) => {
				assert.equal(preview.title, "Custom (from Claude)");
				assert.match(preview.subtitle, /workflow wp34-profile/);
				return "save";
			},
		],
	]);
	const result = await picker.runProfilePicker(script.ui, api, ctx, {
		workflow: "wf.json",
	});
	assert.equal(result.status, "saved");
	assert.equal(result.scope, "workflow");
	const shown = await realApi.workflowPreferenceAction(ctx, {
		op: "show",
		workflow: "wf.json",
	});
	assert.equal(shown.data.preference.profile, "claude");
	assert.deepEqual(shown.data.preference.roles, {
		synthesis: { executor: "claude", model: "sonnet", effort: "low" },
	});
	// Opening it again marks the saved choice.
	const again = scripted([["select", answer(undefined)]]);
	await picker.runProfilePicker(again.ui, api, ctx, { workflow: "wf.json" });
	assert.ok(
		again.calls[0].options.includes(
			"Claude — every role on claude (sonnet) (saved for this workflow)",
		),
	);
});

// --- through the Pi host -------------------------------------------------------------------------

function install(env) {
	const pi = fakePi();
	const { api, calls } = fakeModelsApi();
	ext.createAgentWorkflowPiExtension({ env, api, feedbackPollMs: 50 })(pi);
	instances.push({ pi });
	return { pi, calls, command: pi.commands.get("aw") };
}

test("/aw profile opens the picker in the TUI (colour preview component); RPC keeps the list", async () => {
	const { cwd, env } = await project();
	const { command } = install(env);
	const colors = [];
	const ctx = fakeCtx(cwd, {
		mode: "tui",
		custom: true,
		theme: {
			bold: (text) => text,
			fg: (color, text) => {
				colors.push(color);
				return text;
			},
		},
		select: (options, title) => {
			if (/^Configure execution profiles/.test(title)) return picker.SCOPE_USER;
			if (/^Execution profile for every workflow/.test(title))
				return options.find((option) => option.startsWith("Codex —"));
			if (/^Save the profile as/.test(title)) return picker.NEW_PROFILE;
			return undefined;
		},
		input: () => "cx",
		confirm: () => false,
	});
	const running = command.handler("profile", ctx);
	await eventually(() => ctx.customs.length === 1, "the preview");
	const preview = ctx.customs[0];
	assert.ok(preview instanceof tui.ProfilePreviewComponent);
	const text = preview.render(100).join("\n");
	assert.match(text, /Codex {2}role preview · user profile/);
	assert.match(text, /ROLE\s+EXECUTOR\s+MODEL\s+EFFORT/);
	assert.match(text, /→ Save/);
	assert.ok(colors.includes("mdLink"), "codex colour");
	preview.handleInput(DOWN);
	assert.equal(preview.selected, 1);
	preview.handleInput("k");
	preview.handleInput(ENTER);
	await running;
	assert.match(ctx.notes.at(-1).message, /Saved profile:/);
	assert.equal(ctx.inputs.length, 1);
	const saved = await realApi.profileAction(
		{ cwd, env },
		{ op: "show", name: "cx" },
	);
	assert.equal(saved.data.profile.executor, "codex");

	const rpc = fakeCtx(cwd, { mode: "rpc", custom: true });
	await command.handler("profile", rpc);
	assert.equal(rpc.customs.length, 0);
	assert.equal(rpc.selects.length, 0);
	assert.match(rpc.notes.at(-1).message, /^cx\b/);
});

test("launch chooser: Custom… opens the picker, saves the workflow preference and launches with it", async () => {
	const {
		cwd,
		env,
		executor,
		ctx: hostCtx,
	} = await project({
		...SPEC,
		executionProfiles: { fast: {}, deep: {} },
		defaultExecutionProfile: "fast",
	});
	await realApi.profileAction(hostCtx, {
		op: "set",
		name: "fx",
		values: { executor },
	});
	const { command } = install(env);
	const ctx = fakeCtx(cwd, {
		mode: "tui",
		custom: true,
		select: (options, title) => {
			if (/^Choose execution profile/.test(title))
				return host.CUSTOM_PROFILE_OPTION;
			if (/^Execution profile for workflow/.test(title))
				return options.find((option) => option.startsWith("Saved: fx"));
			return undefined;
		},
	});
	const running = command.handler(
		`run wf.json "custom profile" --executor ${executor}`,
		ctx,
	);
	await eventually(() => ctx.customs.length === 1, "the preview");
	ctx.customs[0].handleInput(ENTER); // Save
	await running;
	const chooser = ctx.selects.filter((entry) =>
		/^Choose execution profile/.test(entry.title),
	);
	assert.equal(
		chooser.length,
		1,
		"asked once; the relaunch uses the saved preference",
	);
	assert.deepEqual(chooser[0].options, [
		"Profile: fast",
		"Profile: deep",
		"Base (no profile)",
		host.CUSTOM_PROFILE_OPTION,
	]);
	const note = ctx.notes.at(-1);
	assert.match(note.message, /Saved workflow preference/);
	const shown = await realApi.workflowPreferenceAction(hostCtx, {
		op: "show",
		workflow: "wf.json",
	});
	assert.equal(shown.data.preference.profile, "fx");
	const runs = (await realApi.statusAction(hostCtx)).data.runs;
	assert.equal(
		runs.length,
		1,
		"one run: the cancelled first attempt started nothing",
	);
	await realApi.waitAction(hostCtx, {
		runId: runs[0].runId,
		timeoutMs: 30_000,
	});

	// RPC: the chooser has no Custom… option.
	const rpc = fakeCtx(cwd, {
		mode: "rpc",
		sessionId: "session-r",
		select: (options) => options[0],
	});
	await realApi.workflowPreferenceAction(hostCtx, {
		op: "clear",
		workflow: "wf.json",
	});
	await command.handler(
		`run wf.json "rpc chooser" --executor ${executor}`,
		rpc,
	);
	assert.equal(rpc.selects.length, 1);
	assert.equal(
		rpc.selects[0].options.includes(host.CUSTOM_PROFILE_OPTION),
		false,
	);
	const rpcRun = (await realApi.statusAction(hostCtx)).data.runs[0].runId;
	await realApi.waitAction(hostCtx, { runId: rpcRun, timeoutMs: 30_000 });
});

test("launch chooser: Custom… closed without saving starts nothing", async () => {
	const {
		cwd,
		env,
		executor,
		ctx: hostCtx,
	} = await project({
		...SPEC,
		executionProfiles: { fast: {} },
	});
	const { command } = install(env);
	const ctx = fakeCtx(cwd, {
		mode: "tui",
		custom: true,
		select: (_options, title) =>
			/^Choose execution profile/.test(title)
				? host.CUSTOM_PROFILE_OPTION
				: undefined,
	});
	await command.handler(`run wf.json "cancelled" --executor ${executor}`, ctx);
	assert.match(
		ctx.notes.at(-1).message,
		/^Launch cancelled: the profile picker was closed/,
	);
	assert.deepEqual((await realApi.statusAction(hostCtx)).data.runs, []);
});
