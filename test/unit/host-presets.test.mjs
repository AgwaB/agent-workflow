// test-tier: integration
// Built-in executor presets codex, codex-high, claude and mixed. Each is a valid role profile
// whose executors exist and whose efforts each executor accepts. `profile set <name> --preset <id>` saves one (explicit flags win), `profile presets`
// lists them, and `--profile <id>` selects one directly.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";
import { runDiagnostics } from "../helpers/run-diagnostics.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const presets = await import("../../dist/core/executor-presets.js");
const roles = await import("../../dist/core/role-profiles.js");
const types = await import("../../dist/core/types.js");
const slots = await import("../../dist/core/launch-slots.js");
const { CODEX_EFFORT_LEVELS } = await import(
	"../../dist/executors/codex/capabilities.js"
);
const { CLAUDE_EFFORT_LEVELS } = await import(
	"../../dist/executors/claude/argv.js"
);

let root;
let counter = 0;
const undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp31-presets-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const restore of undo.splice(0)) restore();
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
			name: `wp31-presets-${counter}`,
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{
						id: "plan",
						type: "single",
						profileRole: "planning",
						prompt: "Plan.",
					},
					{
						id: "research",
						type: "single",
						profileRole: "research-execution",
						prompt: "Research.",
						from: "plan",
					},
					{
						id: "verify",
						type: "single",
						profileRole: "verification",
						prompt: "Verify.",
						from: "research",
					},
				],
			},
		}),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, ctx: { cwd, env } };
}

const EFFORTS = {
	codex: CODEX_EFFORT_LEVELS,
	claude: CLAUDE_EFFORT_LEVELS,
	pi: types.EFFORT_LEVELS,
};

test("every preset is a valid role profile with executor-valid reference values", () => {
	assert.deepEqual(
		[...presets.EXECUTOR_PRESET_IDS],
		["codex", "codex-high", "claude", "mixed"],
	);
	for (const id of presets.EXECUTOR_PRESET_IDS) {
		const preset = presets.executorPreset(id);
		assert.deepEqual(
			roles.parseWorkflowRoleMap(preset.roles, id),
			preset.roles,
		);
		assert.deepEqual(
			Object.keys(preset.roles).sort(),
			["default", ...types.WORKFLOW_PROFILE_ROLES].sort(),
		);
		assert.equal(preset.executor, preset.roles["research-execution"].executor);
		for (const [role, assignment] of Object.entries(preset.roles)) {
			assert.ok(
				core.workflowExecutorRegistration(assignment.executor)?.descriptor,
				`${id}.${role} executor`,
			);
			assert.ok(
				EFFORTS[assignment.executor].includes(assignment.effort),
				`${id}.${role}: ${assignment.effort}`,
			);
			assert.ok(
				(assignment.executor === "codex"
					? ["gpt-6.1-sol", "gpt-6-luna"]
					: ["claude-opus-5-5"]
				).includes(assignment.model),
			);
		}
	}
	assert.equal(
		presets.executorPreset("mixed").roles.verification.executor,
		"codex",
	);
	assert.equal(
		presets.executorPreset("mixed").roles.planning.executor,
		"claude",
	);
	assert.throws(() => presets.executorPreset("pi"), /unknown preset "pi"/);
	assert.throws(
		() => presets.executorPreset("gemini"),
		/unknown preset "gemini"/,
	);
});

test("profile set --preset saves the preset; explicit flags win; profile presets lists them", async () => {
	const { cwd, env } = await project();
	const io = () => {
		const out = [];
		return {
			out,
			io: {
				cwd,
				env,
				stdout: (text) => out.push(text),
				stderr: (text) => out.push(text),
				isTTY: false,
			},
		};
	};
	let run = io();
	assert.equal(
		await cli.runAgentWorkflowCli(
			[
				"profile",
				"set",
				"team",
				"--preset",
				"mixed",
				"--role",
				"verification=codex:gpt-5.6-luna:high",
				"--permission-mode",
				"safe",
				"--default",
				"--json",
			],
			run.io,
		),
		0,
		run.out.join(""),
	);
	const saved = JSON.parse(run.out.join("")).data.profile;
	assert.equal(saved.executor, "codex");
	assert.equal(saved.permissionMode, "safe");
	assert.deepEqual(saved.roles.verification, {
		executor: "codex",
		model: "gpt-5.6-luna",
		effort: "high",
	});
	assert.deepEqual(saved.roles.planning, {
		executor: "claude",
		model: "claude-opus-5-5",
		effort: "high",
	});
	// A preset replaces executor and roles; other fields stay.
	run = io();
	assert.equal(
		await cli.runAgentWorkflowCli(
			["profile", "set", "team", "--preset", "codex", "--json"],
			run.io,
		),
		0,
	);
	const replaced = JSON.parse(run.out.join("")).data.profile;
	assert.equal(replaced.executor, "codex");
	assert.equal(replaced.permissionMode, "safe");
	assert.deepEqual(
		[...new Set(Object.values(replaced.roles).map((role) => role.executor))],
		["codex"],
	);
	// --unset roles.<role> removes one role.
	run = io();
	await cli.runAgentWorkflowCli(
		["profile", "set", "team", "--unset", "roles.planning", "--json"],
		run.io,
	);
	assert.equal(
		JSON.parse(run.out.join("")).data.profile.roles.planning,
		undefined,
	);
	run = io();
	assert.equal(
		await cli.runAgentWorkflowCli(["profile", "show", "team"], run.io),
		0,
	);
	assert.match(
		run.out.join(""),
		/roles:\n {4}default +codex:gpt-6-luna:medium/,
	);
	run = io();
	assert.equal(
		await cli.runAgentWorkflowCli(["profile", "presets"], run.io),
		0,
	);
	assert.match(run.out.join(""), /^codex — every role on codex/m);
	assert.match(
		run.out.join(""),
		/^mixed — planning, synthesis and final judgment on claude/m,
	);
	// Usage errors exit 2 with the reason.
	for (const argv of [
		["profile", "set", "x", "--preset", "gemini"],
		["profile", "set", "x", "--role", "boss=codex"],
		["profile", "set", "x", "--role", "verification=gemini"],
		[
			"profile",
			"set",
			"x",
			"--role",
			"verification=codex",
			"--role",
			"verification=claude",
		],
	]) {
		run = io();
		assert.equal(
			await cli.runAgentWorkflowCli(argv, run.io),
			2,
			argv.join(" "),
		);
	}
});

test("--profile <preset> runs a workflow with the preset when no declared or saved profile has that name", async () => {
	const logs = {};
	for (const id of ["claude", "codex"]) {
		logs[id] = join(root, `${id}-${counter}.jsonl`);
		undo.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({ id, effectLog: logs[id] }),
			),
		);
	}
	const { ctx } = await project();
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "preset run",
		profile: "mixed",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.deepEqual(launched.data.profile, {
		name: "mixed",
		kind: "preset",
		source: "request",
	});
	assert.deepEqual(
		launched.data.roles.stages.map((stage) => [
			stage.stage,
			stage.executor,
			stage.model,
		]),
		[
			["plan", "claude", "claude-opus-5-5"],
			["research", "codex", "gpt-6-luna"],
			["verify", "codex", "gpt-6-luna"],
		],
	);
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	assert.equal(waited.outcome, "completed");
	const submits = (log) =>
		readFixtureLog(log).filter((entry) => entry.type === "submit");
	assert.equal(submits(logs.claude).length, 1);
	assert.equal(submits(logs.codex).length, 2);
	await assert.rejects(
		api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "x",
			profile: "nope",
		}),
		/built-in presets: codex, codex-high, claude, mixed/,
	);
});

test("--profile pi is unknown without a declared or saved profile; saved pi and declared pi still work", async () => {
	const { ctx, cwd } = await project();
	await assert.rejects(
		api.checkWorkflowAction(ctx, { workflow: "wf.json", profile: "pi" }),
		/unknown profile "pi"/,
	);
	await api.profileAction(ctx, {
		op: "set",
		name: "pi",
		values: { executor: "codex", model: "saved-model" },
	});
	const saved = await api.checkWorkflowAction(ctx, {
		workflow: "wf.json",
		profile: "pi",
	});
	assert.equal(saved.data.profile.kind, "user");
	assert.equal(saved.data.profile.name, "pi");
	const file = join(cwd, "wf.json");
	const spec = JSON.parse(
		await (await import("node:fs/promises")).readFile(file, "utf8"),
	);
	spec.executionProfiles = { pi: {} };
	await writeFile(file, JSON.stringify(spec));
	const declared = await api.checkWorkflowAction(ctx, {
		workflow: "wf.json",
		profile: "pi",
	});
	assert.equal(declared.data.profile.kind, "declared");
	assert.equal(declared.data.profile.name, "pi");
});

test("in the Pi host a preset on another executor resolves models without Pi's model registry", async () => {
	const { ctx } = await project();
	const piCtx = {
		...ctx,
		host: "pi",
		availableModels: [
			{
				provider: "openai-codex",
				id: "gpt-5.6-luna",
				fullId: "openai-codex/gpt-5.6-luna",
				reasoning: true,
			},
		],
		runtimeDefaults: {
			model: "anthropic/claude-test",
			effort: "low",
			executor: "pi",
		},
	};
	const launched = await api.runWorkflowAction(piCtx, {
		workflow: "wf.json",
		task: "codex preset in pi",
		profile: "codex",
	});
	assert.equal(launched.outcome, "running", launched.text);
	let waited;
	do
		waited = await api.waitAction(piCtx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	const run = await (await import("../../dist/core/store.js")).readRunRecord(
		ctx.cwd,
		launched.data.runId,
	);
	if (waited.outcome !== "completed")
		assert.fail(await runDiagnostics(ctx.cwd, launched.data.runId));
	for (const task of run.tasks) {
		assert.equal(
			task.runtime.model,
			task.stageId === "plan" ? "gpt-6.1-sol" : "gpt-6-luna",
			"not the Pi registry id",
		);
		assert.notEqual(task.runtime.model, "anthropic/claude-test");
	}
});

test("in the Pi host a plain --executor codex --model <id> launch (no profile) also skips Pi's registry (WP43b live finding)", async () => {
	const { ctx } = await project();
	const piCtx = {
		...ctx,
		host: "pi",
		// Two registry entries match the bare id: Pi alone would call it ambiguous and the
		// qualified id "openai-codex/gpt-5.6-luna" would then reach the codex CLI, which rejects it.
		availableModels: [
			{
				provider: "openai-codex",
				id: "gpt-5.6-luna",
				fullId: "openai-codex/gpt-5.6-luna",
				reasoning: true,
			},
			{
				provider: "openai",
				id: "gpt-5.6-luna",
				fullId: "openai/gpt-5.6-luna",
				reasoning: true,
			},
		],
		runtimeDefaults: {
			model: "anthropic/claude-test",
			effort: "low",
			executor: "pi",
		},
	};
	const launched = await api.runWorkflowAction(piCtx, {
		workflow: "wf.json",
		task: "codex executor with a bare model id in pi",
		executor: "codex",
		model: "gpt-5.6-luna",
	});
	assert.equal(launched.outcome, "running", launched.text);
	let waited;
	do
		waited = await api.waitAction(piCtx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	assert.equal(waited.outcome, "completed", waited.text);
	const run = await (await import("../../dist/core/store.js")).readRunRecord(
		ctx.cwd,
		launched.data.runId,
	);
	for (const task of run.tasks)
		assert.equal(
			task.runtime.model,
			"gpt-5.6-luna",
			"the bare id reaches the executor untouched",
		);
});
