// New in agent-workflow (WP31 item 3, owner decisions B2/E4): built-in executor presets codex,
// claude, pi and mixed. Each is a valid role profile whose executors exist and whose efforts each
// executor accepts; mixed puts verification on a different model family than research/
// implementation. `profile set <name> --preset <id>` saves one (explicit flags win), `profile presets`
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
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const restore of undo.splice(0)) restore();
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
	pi: types.THINKING_LEVELS,
};

test("every preset is a valid role profile with conservative, executor-valid values", () => {
	assert.deepEqual(
		[...presets.EXECUTOR_PRESET_IDS],
		["codex", "claude", "pi", "mixed"],
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
			`${id} maps default and every profile role`,
		);
		assert.ok(core.workflowExecutorRegistration(preset.executor)?.descriptor);
		for (const [role, assignment] of Object.entries(preset.roles)) {
			assert.ok(
				core.workflowExecutorRegistration(assignment.executor)?.descriptor,
				`${id}.${role} executor`,
			);
			assert.ok(
				EFFORTS[assignment.executor].includes(assignment.effort),
				`${id}.${role}: ${assignment.effort} is valid for ${assignment.executor}`,
			);
			// Conservative: no max/xhigh/ultra effort in a default preset.
			assert.ok(
				["medium", "high"].includes(assignment.effort),
				`${id}.${role}`,
			);
			if (assignment.executor === "codex")
				assert.equal(assignment.model, "gpt-5.6-luna");
			if (assignment.executor === "claude")
				assert.equal(assignment.model, "sonnet");
			if (assignment.executor === "pi")
				assert.equal(assignment.model, undefined, "Pi's own default model");
		}
	}
	const single = { codex: "codex", claude: "claude", pi: "pi" };
	for (const [id, executor] of Object.entries(single)) {
		const preset = presets.executorPreset(id);
		assert.equal(preset.executor, executor);
		for (const assignment of Object.values(preset.roles))
			assert.equal(assignment.executor, executor);
	}
	const mixed = presets.executorPreset("mixed").roles;
	assert.equal(mixed.planning.executor, "claude");
	assert.equal(mixed.synthesis.executor, "claude");
	assert.equal(mixed["research-execution"].executor, "codex");
	assert.notEqual(
		mixed.verification.executor,
		mixed["research-execution"].executor,
		"E4: verification runs on another family than the producer",
	);
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
	assert.equal(saved.executor, "claude");
	assert.equal(saved.permissionMode, "safe");
	assert.deepEqual(saved.roles.verification, {
		executor: "codex",
		model: "gpt-5.6-luna",
		effort: "high",
	});
	assert.deepEqual(saved.roles.planning, {
		executor: "claude",
		model: "sonnet",
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
		/roles:\n {4}default +codex:gpt-5\.6-luna:medium/,
	);
	run = io();
	assert.equal(
		await cli.runAgentWorkflowCli(["profile", "presets"], run.io),
		0,
	);
	assert.match(run.out.join(""), /^codex — every role on codex/m);
	assert.match(
		run.out.join(""),
		/^mixed — planning, synthesis, verification and final judgment on claude/m,
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
			["plan", "claude", "sonnet"],
			["research", "codex", "gpt-5.6-luna"],
			["verify", "claude", "sonnet"],
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
	assert.equal(submits(logs.claude).length, 2);
	assert.equal(submits(logs.codex).length, 1);
	await assert.rejects(
		api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "x",
			profile: "nope",
		}),
		/built-in presets: codex, claude, pi, mixed/,
	);
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
			thinking: "low",
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
	assert.equal(waited.outcome, "completed");
	const run = await (await import("../../dist/core/store.js")).readRunRecord(
		ctx.cwd,
		launched.data.runId,
	);
	for (const task of run.tasks) {
		assert.equal(task.runtime.model, "gpt-5.6-luna", "not the Pi registry id");
		assert.notEqual(task.runtime.model, "anthropic/claude-test");
	}
});
