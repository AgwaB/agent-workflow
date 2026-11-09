// test-tier: integration
// A saved `pi` profile through the real Pi extension: `/aw profile set pi …` edits it, and `aw_run`
// sends Pi's current model/effort (ctx.model, getThinkingLevel) with the profile's changes to each
// pi stage. A fixture executor is registered as `pi` in-process (no CLI or model call).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const ext = await import("../../dist/hosts/pi/extension.js");
const realApi = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const undo = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-pi-exec-profile-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const restore of undo.splice(0)) restore();
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function fakePi(effort) {
	const commands = new Map();
	const tools = new Map();
	return {
		commands,
		tools,
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: (tool) => tools.set(tool.name, tool),
		on: () => () => undefined,
		getThinkingLevel: () => effort,
	};
}

function fakeCtx(cwd) {
	const notes = [];
	return {
		cwd,
		hasUI: true,
		mode: "rpc",
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: {
			getAvailable: () => [
				{ provider: "anthropic", id: "claude-test", reasoning: true },
				{ provider: "other", id: "model", reasoning: true },
			],
		},
		notes,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async () => true,
			select: async () => undefined,
		},
	};
}

test("Pi host: a saved pi profile changes only its roles; other pi stages keep Pi's current model/effort", async () => {
	const cwd = join(root, "p");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			name: "pi-exec-profile",
			defaults: {
				agent: "reader",
				readOnly: true,
				tools: ["read"],
				effort: "medium",
			},
			artifactGraph: {
				stages: [
					{
						id: "plan",
						type: "single",
						profileRole: "planning",
						prompt: "Plan.",
					},
					{
						id: "check",
						type: "single",
						profileRole: "verification",
						prompt: "Check.",
						from: "plan",
					},
				],
			},
		})}\n`,
	);
	const log = join(root, "pi.jsonl");
	undo.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id: "pi", effectLog: log }),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const pi = fakePi("low");
	ext.createAgentWorkflowPiExtension({ api: realApi, env })(pi);
	const ctx = fakeCtx(cwd);
	const command = pi.commands.get("aw");
	const run = async () => {
		const before = readFixtureLog(log).filter(
			(entry) => entry.type === "submit",
		).length;
		const started = await pi.tools
			.get("aw_run")
			.execute(
				"r",
				{ workflow: "wf.json", task: "t", executor: "pi" },
				undefined,
				undefined,
				ctx,
			);
		assert.equal(started.details.outcome, "running", started.content[0].text);
		const runId = started.details.runId;
		let waited;
		do
			waited = await pi.tools
				.get("aw_wait")
				.execute("w", { runId, timeoutMs: 10_000 }, undefined, undefined, ctx);
		while (waited.details.stillRunning);
		const record = await store.readRunRecord(cwd, runId);
		assert.equal(record.status, "completed");
		const stage = Object.fromEntries(
			record.tasks.map((task) => [task.taskId, task.specId.split(".")[0]]),
		);
		return Object.fromEntries(
			readFixtureLog(log)
				.filter((entry) => entry.type === "submit")
				.slice(before)
				.map((entry) => [
					stage[entry.attemptKey.split(":")[2]],
					`${entry.model}/${entry.effort}`,
				]),
		);
	};
	// Without a pi profile: Pi's current model and effort, above the workflow's default effort.
	assert.deepEqual(await run(), {
		plan: "anthropic/claude-test/low",
		check: "anthropic/claude-test/low",
	});
	await command.handler(
		"profile set pi --role planning=pi::minimal --role verification=pi:other/model",
		ctx,
	);
	assert.match(ctx.notes.at(-1).message, /pi \(default profile of pi stages\)/);
	await command.handler("profile show pi", ctx);
	assert.match(ctx.notes.at(-1).message, /planning\s+pi:-:minimal/);
	assert.deepEqual(await run(), {
		plan: "anthropic/claude-test/minimal",
		check: "other/model/low",
	});
	await command.handler("profile delete pi", ctx);
	assert.deepEqual(await run(), {
		plan: "anthropic/claude-test/low",
		check: "anthropic/claude-test/low",
	});
});
