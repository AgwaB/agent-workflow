// `agent-workflow check` (2026-10-30, owner): the launch preflight without the launch, and the short
// preflight text a launch prints. Fixture executor only; no model or agent-CLI calls.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import {
	checkWorkflowAction,
	runWorkflowAction,
	waitAction,
} from "../../dist/hosts/api.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import { compactCapabilityText } from "../../dist/hosts/launch.js";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

let counter = 0;
async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-check-"));
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		AGENT_WORKFLOW_ROLE: "supervisor",
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
	};
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "check-fixture",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "One." },
					{ id: "b", type: "single", prompt: "Two.", after: ["a"] },
				],
			},
		}),
	);
	const executor = `check-fixture-${++counter}`;
	const effects = join(cwd, "effects.jsonl");
	const undo = registerWorkflowExecutor(
		workflowFixtureDescriptor({ id: executor, effectLog: effects }),
	);
	t.after(async () => {
		undo();
		await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	});
	return { ctx: { cwd, env, host: "cli" }, executor, effects };
}

test("check: the launch preflight passes without creating a run, claiming a launch or calling the executor", async (t) => {
	const { ctx, executor, effects } = await project(t);
	const checked = await checkWorkflowAction(ctx, {
		workflow: "wf.json",
		executor,
	});
	assert.equal(checked.outcome, "success", checked.text);
	assert.match(
		checked.text,
		/^Preflight passed: check-fixture on check-fixture-\d+ — no run was started\.\nCapability check \(/,
	);
	assert.equal(checked.data.runId, undefined);
	assert.ok(checked.data.capability.preview.startsWith("Capability check"));
	const state = join(ctx.cwd, ".agent-workflow", "workflows");
	assert.equal(
		existsSync(state) &&
			readdirSync(state).some((name) => name.startsWith("workflow_")),
		false,
		"no run directory",
	);
	assert.equal(existsSync(effects), false, "the executor was never asked");
	// No duplicate-launch claim was left behind: the same launch starts right away.
	const run = await runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "preflight check",
		executor,
	});
	assert.equal(run.outcome, "running", run.text);
	await waitAction(ctx, { runId: run.data.runId, timeoutMs: 15_000 });
});

test("check CLI: exit 0 and the short check; unknown workflow is a usage error", async (t) => {
	const { ctx, executor } = await project(t);
	let out = "";
	let err = "";
	const io = {
		cwd: ctx.cwd,
		env: ctx.env,
		isTTY: false,
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
	};
	assert.equal(
		await runAgentWorkflowCli(["check", "wf.json", "--executor", executor], io),
		0,
		err,
	);
	assert.match(out, /^Preflight passed: check-fixture/);
	out = "";
	assert.notEqual(await runAgentWorkflowCli(["check"], io), 0);
	assert.match(err, /Usage: agent-workflow check <workflow>/);
});

test("the launch's capability text is short: each warning once, with the stages it affects", () => {
	const entry = (key, note) => ({
		key,
		need: "required",
		onMissing: "refuse",
		observed: null,
		outcome: "degraded",
		code: `CAPABILITY_WARNING:${key}`,
		note,
	});
	const stage = (label, entries) => ({
		label,
		stageId: label,
		negotiatedAt: "pre-launch",
		report: { entries, refusals: [], degradations: [] },
	});
	const text = compactCapabilityText({
		preview:
			"Capability check (codex@0.1.0, 3 stages, permission mode: free): accepted with 4 degradations\n  a.main: …long per-stage block…",
		stages: [
			stage("a.main", [
				entry("readOnly", "allow rules"),
				entry("cost", "tokens only"),
			]),
			stage("b.main", [entry("readOnly", "allow rules")]),
			stage("c.main", [
				entry("readOnly", "allow rules"),
				{ key: "resume", outcome: "native" },
			]),
		],
		forcedReadOnly: [],
		notices: ['effort "minimal" is "low" on codex (all 3 stages)'],
	});
	assert.equal(
		text,
		[
			"Capability check (codex@0.1.0, 3 stages, permission mode: free): accepted with 4 degradations",
			"  ⚠ readOnly — allow rules (all 3 stages)",
			"  ⚠ cost — tokens only (a.main)",
			'  ⚠ effort "minimal" is "low" on codex (all 3 stages)',
		].join("\n"),
	);
});
