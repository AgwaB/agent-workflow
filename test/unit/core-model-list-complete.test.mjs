// test-tier: integration
// New in agent-workflow (WP31 follow-up): a probe declares whether its model list is exhaustive
// (`ExecutorProbe.modelListComplete`). A role model missing from an exhaustive list is refused before
// launch (MODEL_UNKNOWN); missing from a partial list (Claude Code's aliases) it is noted as "not
// verified by probe" and the run proceeds. The adapters' probes run against stub CLIs; the engine
// runs use the workflow executor fixture with those probe results. No agent CLI or model call.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";
import { stubScripts as claudeStubScripts } from "../fixtures/executors/claude/harness.mjs";
import { PROBE_SCRIPTS as PI_PROBE_SCRIPTS } from "../fixtures/executors/pi/harness.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");
const { createStubCli } = await import("../../dist/sdk/conformance/index.js");
const claude = await import("../../dist/executors/claude/index.js");
const codex = await import("../../dist/executors/codex/index.js");
const pi = await import("../../dist/executors/pi/index.js");

let root;
let counter = 0;
const undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp31-model-list-")));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR ??= join(root, "run-index");
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

async function scratch(name) {
	counter += 1;
	const dir = join(root, `${name}-${counter}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function claudeProbe() {
	const dir = await scratch("claude");
	const cli = await createStubCli({
		dir,
		name: "claude",
		scripts: claudeStubScripts("complete"),
	});
	const executor = claude.createClaudeExecutor({
		config: claude.parseClaudeConfig({
			claudePath: cli.path,
			stateDir: join(dir, "state"),
			claudeConfigDir: join(dir, "claude-config"),
		}),
	});
	return { probe: await executor.probe(), cli };
}

async function codexProbe() {
	const dir = await scratch("codex");
	const cli = await createStubCli({
		dir,
		name: "codex",
		scripts: [
			{
				name: "version",
				when: { argvIncludes: ["--version"] },
				effect: false,
				steps: [{ stdout: "codex-cli 0.159.2" }],
			},
			{
				name: "login",
				when: { argvIncludes: ["login", "status"] },
				effect: false,
				steps: [{ stderr: "Logged in using ChatGPT" }],
			},
			{
				name: "models",
				when: { argvIncludes: ["debug", "models"] },
				effect: false,
				steps: [
					{
						stdout: {
							models: [
								{
									slug: "gpt-5.6-luna",
									visibility: "list",
									supported_reasoning_levels: [
										{ effort: "low" },
										{ effort: "medium" },
										{ effort: "high" },
									],
								},
								{ slug: "codex-auto-review", visibility: "hide" },
							],
						},
					},
				],
			},
		],
	});
	const executor = codex.createExecutor({
		codexPath: cli.path,
		stateDir: join(dir, "state"),
	});
	return { probe: await executor.probe(), cli };
}

async function piProbe() {
	const dir = await scratch("pi");
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: PI_PROBE_SCRIPTS,
	});
	const executor = pi.createExecutor({
		piCommand: cli.path,
		stateDir: join(dir, "state"),
	});
	return { probe: await executor.probe(), cli };
}

test("adapter probes declare their model lists: Claude aliases and Codex catalog partial, Pi exhaustive", async () => {
	const claudeResult = await claudeProbe();
	assert.ok(
		claudeResult.probe.notes.includes("models: default, haiku, sonnet"),
		JSON.stringify(claudeResult.probe.notes),
	);
	assert.equal(claudeResult.probe.modelListComplete, false);
	assert.equal(await claudeResult.cli.effectCount(), 0);

	const codexResult = await codexProbe();
	assert.ok(codexResult.probe.notes.includes("models: gpt-5.6-luna"));
	assert.equal(codexResult.probe.modelListComplete, false);
	assert.equal(await codexResult.cli.effectCount(), 0);

	const piResult = await piProbe();
	assert.deepEqual(piResult.probe.models, ["google/gemini-2.5-flash-lite"]);
	assert.equal(piResult.probe.modelListComplete, false);
	assert.equal(await piResult.cli.effectCount(), 0);
});

/** The fixture registered as `id`, answering with (the JSON part of) an adapter's probe. */
function register(id, probe) {
	counter += 1;
	const effectLog = join(root, `${id}-${counter}.jsonl`);
	undo.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog,
				probe: {
					installed: probe.installed,
					cliVersion: probe.cliVersion,
					auth: probe.auth,
					...(probe.modelListComplete === undefined
						? {}
						: { modelListComplete: probe.modelListComplete }),
					...(probe.models === undefined ? {} : { models: probe.models }),
					notes: [...(probe.notes ?? [])],
				},
			}),
		),
	);
	return effectLog;
}

async function project(executor, model) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const agents = join(cwd, ".agent-workflow", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(agents, "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				name: `wp31-model-list-${counter}`,
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [
						{
							id: "plan",
							type: "single",
							profileRole: "planning",
							prompt: "Plan.",
						},
					],
				},
			},
			null,
			2,
		)}\n`,
	);
	const ctx = {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
	};
	const saved = await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values: { roles: { default: { executor, model } } },
		makeDefault: true,
	});
	assert.equal(saved.outcome, "success", saved.text);
	return { cwd, ctx };
}

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

const submits = (log) =>
	readFixtureLog(log).filter((entry) => entry.type === "submit");

test("Claude: a full model id missing from the alias list is noted (not verified by probe) and runs", async () => {
	const { probe } = await claudeProbe();
	const log = register("claude", probe);
	const { ctx } = await project("claude", "claude-opus-4-8");
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "full claude id",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.match(
		launched.text,
		/model "claude-opus-4-8" for plan is not verified by probe: executor claude's probe lists default, haiku, sonnet, which is not exhaustive; the run proceeds/u,
	);
	assert.ok(
		launched.data.capability.notices.some((notice) =>
			notice.startsWith(
				'model "claude-opus-4-8" for plan is not verified by probe',
			),
		),
	);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.deepEqual(
		submits(log).map((entry) => entry.model),
		["claude-opus-4-8"],
	);
	// A listed alias needs no note.
	const alias = await project("claude", "haiku");
	const ok = await api.runWorkflowAction(alias.ctx, {
		workflow: "wf.json",
		task: "alias",
	});
	assert.equal(ok.outcome, "running", ok.text);
	assert.doesNotMatch(ok.text, /not verified/u);
	assert.equal((await settle(alias.ctx, ok.data.runId)).outcome, "completed");
});

test("Codex: a slug outside the visible catalog is noted, not refused", async () => {
	const { probe } = await codexProbe();
	const log = register("codex", probe);
	const { ctx } = await project("codex", "codex-auto-review");
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "hidden codex slug",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.match(
		launched.text,
		/model "codex-auto-review" for plan is not verified by probe: executor codex's probe lists gpt-5\.6-luna/u,
	);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.equal(submits(log).length, 1);
});

test("Pi: the list is not exhaustive (Pi resolves patterns): an unknown model is noted, not refused; a listed one runs without a note", async () => {
	const { probe } = await piProbe();
	register("pi", probe);
	const { ctx } = await project("pi", "google/gemini-9-unknown");
	const noted = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "unknown pi model",
	});
	assert.equal(noted.outcome, "running", noted.text);
	assert.match(
		noted.text,
		/model "google\/gemini-9-unknown" for plan is not verified by probe/u,
	);
	assert.equal((await settle(ctx, noted.data.runId)).outcome, "completed");
	const listed = await project("pi", "gemini-2.5-flash-lite");
	const ok = await api.runWorkflowAction(listed.ctx, {
		workflow: "wf.json",
		task: "listed pi model",
	});
	assert.equal(ok.outcome, "running", ok.text);
	assert.doesNotMatch(ok.text, /not verified/u);
	assert.equal((await settle(listed.ctx, ok.data.runId)).outcome, "completed");
});

test("a probe that says nothing about completeness only notes a missing model", async () => {
	register("claude", {
		installed: true,
		cliVersion: "fake-cli 1.0.0",
		auth: "ok",
		notes: ["models: alpha, beta"],
	});
	const { ctx } = await project("claude", "gamma");
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "undeclared completeness",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.match(
		launched.text,
		/model "gamma" for plan is not verified by probe/u,
	);
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
});

test("probes report effort levels per model when the CLI lists them (Codex catalog, Pi thinking column)", async () => {
	const { probe } = await codexProbe();
	assert.deepEqual(probe.modelEfforts, {
		"gpt-5.6-luna": ["low", "medium", "high"],
	});
	assert.deepEqual(
		pi.parsePiModelEfforts(
			[
				"provider   model          context  max-out  thinking  images",
				"anthropic  claude-opus-5  200K     64K      yes       yes",
				"openai     gpt-4o-mini    128K     16K      no        yes",
			].join("\n"),
		),
		{ "openai/gpt-4o-mini": ["off"] },
	);
});
