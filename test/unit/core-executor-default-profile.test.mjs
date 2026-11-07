// Built-in executor default profiles: codex and claude stages that nothing else gives a model or
// effort take the executor's preset; a preset model the probe does not list falls back to the user's
// own CLI settings for every stage. Pi keeps its own defaults. No model or agent-CLI calls: probes are
// injected, user settings live in temporary CODEX_HOME / CLAUDE_CONFIG_DIR directories.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const policy = await import("../../dist/core/executor-policy.js");
const presets = await import("../../dist/core/executor-presets.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const engine = await import("../../dist/core/engine.js");
const { fakeCapabilities } = await import("../../dist/sdk/testing/index.js");

let root;
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-exec-defaults-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function dir(name) {
	counter += 1;
	const path = join(root, `${name}-${counter}`);
	await mkdir(path, { recursive: true });
	return path;
}

async function codexHome(toml) {
	const home = await dir("codex");
	if (toml !== undefined) await writeFile(join(home, "config.toml"), toml);
	return { CODEX_HOME: home };
}

async function claudeHome(settings) {
	const home = await dir("claude");
	if (settings !== undefined)
		await writeFile(join(home, "settings.json"), JSON.stringify(settings));
	return { CLAUDE_CONFIG_DIR: home };
}

const PRESET_EFFORTS = {
	default: "medium",
	planning: "high",
	"research-execution": "medium",
	synthesis: "medium",
	verification: "high",
	"final-judgment": "high",
};

function presetRoles(model) {
	return Object.fromEntries(
		Object.entries(PRESET_EFFORTS).map(([role, effort]) => [
			role,
			{ model, effort },
		]),
	);
}

test("the preset applies when its model is listed or the probe lists none; pi has no default profile", async () => {
	const env = await codexHome('model = "gpt-6.1-sol"\n');
	for (const listed of [[presets.PRESET_CODEX_MODEL, "gpt-6.1-sol"], null]) {
		const profile = policy.resolveExecutorDefaultProfile("codex", listed, env);
		assert.deepEqual(profile, {
			roles: presetRoles(presets.PRESET_CODEX_MODEL),
		});
	}
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile(
			"claude",
			["default", "sonnet", "opus"],
			await claudeHome({ model: "opus" }),
		),
		{ roles: presetRoles(presets.PRESET_CLAUDE_MODEL) },
	);
	assert.equal(
		policy.resolveExecutorDefaultProfile("pi", ["anything"], {}),
		undefined,
	);
});

test("codex: an unlisted preset model falls back to config.toml for every stage, active profile first", async () => {
	const top = await codexHome(
		[
			'model = "gpt-6.1-sol" # current',
			'model_reasoning_effort = "high"',
			"",
			"[mcp_servers.x]",
			'model = "not-this"',
			"",
		].join("\n"),
	);
	const profile = policy.resolveExecutorDefaultProfile(
		"codex",
		["gpt-6.1-sol"],
		top,
	);
	assert.deepEqual(profile.roles, {
		default: { model: "gpt-6.1-sol", effort: "high" },
	});
	assert.match(
		profile.notice,
		/^codex default profile: model "gpt-5\.6-luna" is not offered here; stages without a model\/effort use your codex settings \(gpt-6\.1-sol, high\) from .*config\.toml$/,
	);
	const withProfile = await codexHome(
		[
			'profile = "work"',
			'model = "gpt-6.1-sol"',
			'model_reasoning_effort = "high"',
			"",
			'[profiles."work"]',
			'model = "gpt-6-luna"',
			"",
			"[profiles.other]",
			'model_reasoning_effort = "low"',
			"",
		].join("\n"),
	);
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile("codex", ["gpt-6-luna"], withProfile)
			.roles,
		{ default: { model: "gpt-6-luna", effort: "high" } },
	);
});

test("claude: an unlisted preset model falls back to settings.json; an effort outside the vocabulary is dropped", async () => {
	const env = await claudeHome({ model: "opus", effortLevel: "xhigh" });
	const profile = policy.resolveExecutorDefaultProfile(
		"claude",
		["default", "opus"],
		env,
	);
	assert.deepEqual(profile.roles, {
		default: { model: "opus", effort: "xhigh" },
	});
	assert.match(
		profile.notice,
		/your claude settings \(opus, xhigh\) from .*settings\.json$/,
	);
	const odd = await claudeHome({ model: "opus", effortLevel: "turbo" });
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile("claude", ["opus"], odd).roles,
		{ default: { model: "opus" } },
	);
});

test("no user settings: no default for the stages and the notice says the CLI's own defaults apply", async () => {
	for (const [id, env] of [
		["codex", await codexHome()],
		["codex", await codexHome("# empty\n")],
		["claude", await claudeHome()],
		["claude", await claudeHome({ theme: "dark" })],
	]) {
		const profile = policy.resolveExecutorDefaultProfile(id, ["other"], env);
		assert.deepEqual(profile.roles, {});
		assert.match(
			profile.notice,
			new RegExp(
				`no ${id} model/effort is configured; stages without one use ${id}'s own defaults$`,
			),
		);
	}
});

test("executorDefaultRuntime picks agent > profileRole > default, field by field", () => {
	const roles = {
		default: { model: "d", effort: "medium" },
		planning: { effort: "high" },
		"agent:scout": { model: "s" },
	};
	assert.deepEqual(policy.executorDefaultRuntime(roles, {}), {
		model: "d",
		effort: "medium",
	});
	assert.deepEqual(
		policy.executorDefaultRuntime(roles, { profileRole: "planning" }),
		{ model: "d", effort: "high" },
	);
	assert.deepEqual(
		policy.executorDefaultRuntime(roles, {
			agent: "scout",
			profileRole: "planning",
		}),
		{ model: "s", effort: "high" },
	);
	assert.equal(policy.executorDefaultRuntime(undefined, {}), undefined);
	assert.equal(policy.executorDefaultRuntime({}, {}), undefined);
});

test("a saved executor profile overlays the built-in one: flat values in every role, entries field by field", async () => {
	const builtIn = presetRoles("preset-model");
	assert.deepEqual(
		policy.overlayExecutorProfile("codex", builtIn, {
			effort: "low",
			roles: {
				planning: { executor: "codex", model: "plan-model" },
				verification: { effort: "max" },
				synthesis: { executor: "claude", model: "opus" },
				"agent:scout": { executor: "codex", model: "scout-model" },
			},
		}),
		{
			default: { model: "preset-model", effort: "low" },
			planning: { model: "plan-model", effort: "low" },
			"research-execution": { model: "preset-model", effort: "low" },
			synthesis: { model: "preset-model", effort: "low" },
			verification: { model: "preset-model", effort: "max" },
			"final-judgment": { model: "preset-model", effort: "low" },
			"agent:scout": { model: "scout-model" },
		},
	);
	// A profile whose executor is another one keeps its flat values off this executor.
	assert.deepEqual(
		policy.overlayExecutorProfile("codex", builtIn, {
			executor: "claude",
			model: "opus",
			roles: { planning: { executor: "codex", effort: "xhigh" } },
		}),
		{ ...builtIn, planning: { model: "preset-model", effort: "xhigh" } },
	);
	// No built-in profile (pi): only the saved values.
	assert.deepEqual(
		policy.overlayExecutorProfile(
			"pi",
			{},
			{
				effort: "high",
				roles: { planning: { effort: "xhigh" } },
			},
		),
		{ default: { effort: "high" }, planning: { effort: "xhigh" } },
	);
	assert.deepEqual(policy.overlayExecutorProfile("pi", {}, {}), {});
});

test("resolve with a saved profile: overlay on the preset or on the fallback (notice kept); pi only with one", async () => {
	const env = await codexHome(
		'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n',
	);
	const saved = { roles: { planning: { executor: "codex", effort: "xhigh" } } };
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile(
			"codex",
			[presets.PRESET_CODEX_MODEL],
			env,
			saved,
		).roles.planning,
		{ model: presets.PRESET_CODEX_MODEL, effort: "xhigh" },
	);
	const fallback = policy.resolveExecutorDefaultProfile(
		"codex",
		["gpt-6.1-sol"],
		env,
		saved,
	);
	assert.deepEqual(fallback.roles, {
		default: { model: "gpt-6.1-sol", effort: "high" },
		planning: { effort: "xhigh" },
	});
	assert.match(fallback.notice, /is not offered here/);
	// The user's own model is used as written (no fallback for it).
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile("codex", ["gpt-6.1-sol"], env, {
			model: "unlisted",
		}).roles.default,
		{ model: "unlisted", effort: "high" },
	);
	assert.deepEqual(
		policy.resolveExecutorDefaultProfile("pi", ["x"], {}, { effort: "high" }),
		{ roles: { default: { effort: "high" } } },
	);
	assert.equal(
		policy.resolveExecutorDefaultProfile("pi", ["x"], {}, {}),
		undefined,
	);
});

async function project() {
	const cwd = await dir("project");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		[
			"---",
			"name: reader",
			"description: reads and reports",
			"tools: read",
			"---",
			"You read and report.",
			"",
		].join("\n"),
	);
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "tuned.md"),
		[
			"---",
			"name: tuned",
			"description: reads with its own model",
			"tools: read",
			"model: agent-model",
			"---",
			"You read and report.",
			"",
		].join("\n"),
	);
	return cwd;
}

const SPEC = {
	schemaVersion: 1,
	name: "executor-defaults",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{
				id: "plan",
				type: "single",
				profileRole: "planning",
				prompt: "Plan.",
			},
			{ id: "work", type: "single", prompt: "Work." },
			{ id: "tuned", type: "single", agent: "tuned", prompt: "Tuned." },
			{
				id: "pinned",
				type: "single",
				profileRole: "verification",
				model: "stage-model",
				effort: "low",
				prompt: "Pinned.",
			},
		],
	},
};

function runtimes(compiled) {
	return Object.fromEntries(
		compiled.tasks.map((task) => [
			task.stageId,
			{
				...(task.runtime.model === undefined
					? {}
					: { model: task.runtime.model }),
				...(task.runtime.effort === undefined
					? {}
					: { effort: task.runtime.effort }),
			},
		]),
	);
}

test("compile: the executor default profile is the lowest model/effort layer, only for its executor", async () => {
	const cwd = await project();
	const executorDefaults = { codex: presetRoles("preset-model") };
	const compile = (extra) =>
		compileWorkflow(structuredClone(SPEC), {
			cwd,
			task: "t",
			runExecutor: "codex",
			executorDefaults,
			...extra,
		});
	assert.deepEqual(runtimes(await compile({})), {
		plan: { model: "preset-model", effort: "high" },
		work: { model: "preset-model", effort: "medium" },
		tuned: { model: "agent-model", effort: "medium" },
		pinned: { model: "stage-model", effort: "low" },
	});
	// A run override (--model) wins the model; the preset still fills the effort.
	assert.deepEqual(
		runtimes(await compile({ runtimeOverrides: { model: "flag-model" } })),
		{
			plan: { model: "flag-model", effort: "high" },
			work: { model: "flag-model", effort: "medium" },
			tuned: { model: "flag-model", effort: "medium" },
			pinned: { model: "flag-model", effort: "low" },
		},
	);
	// Workflow defaults outrank the executor default profile.
	const withDefaults = structuredClone(SPEC);
	withDefaults.defaults.effort = "minimal";
	assert.deepEqual(
		runtimes(
			await compileWorkflow(withDefaults, {
				cwd,
				task: "t",
				runExecutor: "codex",
				executorDefaults,
			}),
		).work,
		{ model: "preset-model", effort: "minimal" },
	);
	// Another executor's default profile does not reach these stages.
	assert.deepEqual(runtimes(await compile({ runExecutor: "claude" })), {
		plan: {},
		work: {},
		tuned: { model: "agent-model" },
		pinned: { model: "stage-model", effort: "low" },
	});
});

function codexProber(models, calls) {
	return async (descriptor) => {
		calls.push(descriptor.id);
		return {
			probe: {
				installed: true,
				cliVersion: "0.159.2",
				auth: "ok",
				notes: [`models: ${models.join(", ")}`],
			},
			capabilities: fakeCapabilities(),
		};
	};
}

async function preflight(cwd, options) {
	const specPath = join(cwd, "workflow.json");
	await writeFile(specPath, `${JSON.stringify(SPEC, null, 2)}\n`);
	try {
		await engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			preflightOnly: true,
			...options,
		});
	} catch (error) {
		if (error instanceof engine.WorkflowPreflightPassed) return error;
		throw error;
	}
	assert.fail("preflight did not stop the launch");
}

test("engine: a codex run probes once, keeps the listed preset model, else uses config.toml with a notice", async () => {
	const cwd = await project();
	const previous = process.env.CODEX_HOME;
	const env = await codexHome(
		'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n',
	);
	process.env.CODEX_HOME = env.CODEX_HOME;
	try {
		const calls = [];
		const listed = await preflight(cwd, {
			executor: "codex",
			executorProber: codexProber(
				[presets.PRESET_CODEX_MODEL, "gpt-6.1-sol"],
				calls,
			),
		});
		assert.deepEqual(calls, ["codex"]);
		const profileNotices = (passed) =>
			(passed.negotiation.notices ?? []).filter((notice) =>
				notice.includes("default profile"),
			);
		assert.deepEqual(profileNotices(listed), []);
		const unlisted = await preflight(cwd, {
			executor: "codex",
			executorProber: codexProber(["gpt-6.1-sol"], []),
		});
		assert.deepEqual(profileNotices(unlisted), [
			`codex default profile: model "${presets.PRESET_CODEX_MODEL}" is not offered here; stages without a model/effort use your codex settings (gpt-6.1-sol, xhigh) from ${join(env.CODEX_HOME, "config.toml")}`,
		]);
		assert.match(unlisted.negotiation.preview, /Notice: codex default profile/);
	} finally {
		if (previous === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previous;
	}
});

test("engine: a hung probe fails once within the probe timeout", async () => {
	const cwd = await project();
	const started = Date.now();
	await assert.rejects(
		preflight(cwd, {
			executor: "claude",
			executorProbeTimeoutMs: 200,
			executorProber: () => new Promise(() => undefined),
		}),
		/executor "claude" probe did not finish within 200 ms/,
	);
	assert.ok(Date.now() - started < 380, "the probe timeout was waited twice");
});
