// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// `agent-workflow check` (2026-10-30, owner): the launch preflight without the launch, and the short
// preflight text a launch prints. Fixture executor only; no model or agent-CLI calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
	const state = join(stateDir(ctx.cwd), ".agent-workflow", "workflows");
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

// 2026-11-24: a write-capable stage runs in a managed git worktree, which needs a repository with a
// commit. `check` says so at preflight instead of the writer failing at launch (worktree.ts).
async function writeProject(t) {
	const made = await project(t);
	await writeFile(
		join(made.ctx.cwd, ".agent-workflow/agents/writer.md"),
		"---\nname: writer\ndescription: writes\ntools: read, edit, write\nreadOnly: false\n---\nWrite.\n",
	);
	await writeFile(
		join(made.ctx.cwd, "wfw.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "check-writer",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "read", type: "single", prompt: "Read." },
					{
						id: "write",
						type: "single",
						prompt: "Write OUTPUT.md.",
						after: ["read"],
						agent: "writer",
						readOnly: false,
						worktreePolicy: "on",
						tools: ["read", "edit", "write"],
					},
				],
			},
		}),
	);
	return made;
}

const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});

test("check: a write-capable workflow outside a git repository is refused at preflight, naming the stage", async (t) => {
	const { ctx, executor, effects } = await writeProject(t);
	const checked = await checkWorkflowAction(ctx, {
		workflow: "wfw.json",
		executor,
	});
	assert.equal(checked.outcome, "refused", checked.text);
	assert.match(checked.text, /^Not started: /);
	assert.match(checked.text, /✗ write\.main: .*not inside a git repository/);
	assert.match(checked.text, /git init/);
	assert.equal(checked.data.runId, undefined);
	assert.equal(existsSync(effects), false, "the executor was never asked");
});

test("check: a repository without a commit is refused; with a commit the write workflow passes", async (t) => {
	const { ctx, executor } = await writeProject(t);
	git(ctx.cwd, "init", "-q");
	const empty = await checkWorkflowAction(ctx, {
		workflow: "wfw.json",
		executor,
	});
	assert.equal(empty.outcome, "refused", empty.text);
	assert.match(empty.text, /✗ write\.main: .*has no commit yet/);
	git(ctx.cwd, "commit", "-q", "--allow-empty", "-m", "init");
	const committed = await checkWorkflowAction(ctx, {
		workflow: "wfw.json",
		executor,
	});
	assert.equal(committed.outcome, "success", committed.text);
});

test("check: a read-only workflow needs no git repository", async (t) => {
	const { ctx, executor } = await writeProject(t);
	const checked = await checkWorkflowAction(ctx, {
		workflow: "wf.json",
		executor,
	});
	assert.equal(checked.outcome, "success", checked.text);
});

// 2026-11-25: `check` negotiated against the executor the spec pins, while `run --executor <other>`
// overrides the pin and can refuse (a2-N2-1). `check` names the pinned executor and says which other
// installed executors would refuse, without any model call.
async function pinnedProject(t) {
	const made = await writeProject(t);
	git(made.ctx.cwd, "init", "-q");
	git(made.ctx.cwd, "commit", "-q", "--allow-empty", "-m", "init");
	const refusing = `check-coarse-${++counter}`;
	const accepting = `check-fine-${++counter}`;
	const effects = join(made.ctx.cwd, "effects-other.jsonl");
	const undoRefusing = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: refusing,
			effectLog: effects,
			capabilities: {
				toolAllowlist: {
					level: "native",
					source: "declared",
					detail: "coarse",
				},
			},
		}),
	);
	const undoAccepting = registerWorkflowExecutor(
		workflowFixtureDescriptor({ id: accepting, effectLog: effects }),
	);
	t.after(() => {
		undoRefusing();
		undoAccepting();
	});
	await writeFile(
		join(made.ctx.cwd, "wfpin.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "check-pinned",
			executionProfiles: { "isolated-safe": {} },
			executionProfileExecutors: { "isolated-safe": made.executor },
			executionProfilePermissionModes: { "isolated-safe": "safe" },
			defaultExecutionProfile: "isolated-safe",
			defaults: { agent: "writer", readOnly: false, tools: ["read", "edit"] },
			artifactGraph: {
				stages: [
					{
						id: "write",
						type: "single",
						prompt: "Write OUTPUT.md.",
						worktreePolicy: "on",
					},
				],
			},
		}),
	);
	return {
		...made,
		refusing,
		accepting,
		ctx: { ...made.ctx, checkAlternativeExecutors: [refusing, accepting] },
	};
}

test("check: a pinned executor is named, and the other installed executors that would refuse it get one hint line", async (t) => {
	const { ctx, executor, refusing, effects } = await pinnedProject(t);
	const checked = await checkWorkflowAction(ctx, { workflow: "wfpin.json" });
	assert.equal(checked.outcome, "success", checked.text);
	const lines = checked.text.split("\n");
	assert.equal(
		lines[0],
		`Preflight passed: check-pinned on ${executor} (pinned by workflow execution profile "isolated-safe") — no run was started.`,
	);
	assert.equal(checked.data.executor.id, executor);
	assert.equal(checked.data.executor.source, "workflow-profile");
	const hints = lines.filter((line) => line.startsWith("Hint: "));
	assert.equal(hints.length, 1, checked.text);
	assert.match(
		hints[0],
		new RegExp(`checked on ${executor} only; ${refusing} would refuse`),
	);
	assert.match(hints[0], /toolAllowlist\.fine/);
	assert.match(hints[0], new RegExp(`check wfpin.json --executor ${refusing}`));
	assert.deepEqual(
		checked.data.wouldRefuse.map((entry) => entry.executor),
		[refusing],
	);
	assert.equal(existsSync(effects), false, "no executor was asked");
	// The refusal the hint predicts is what `run --executor` gives.
	const explicit = await checkWorkflowAction(ctx, {
		workflow: "wfpin.json",
		executor: refusing,
	});
	assert.equal(explicit.outcome, "refused", explicit.text);
	assert.equal(explicit.data.refusal.code, "CAPABILITY_REFUSED");
});

test("check: no hint when no other executor refuses, with an explicit --executor, or when nothing is pinned", async (t) => {
	const { ctx, executor, accepting } = await pinnedProject(t);
	const quiet = await checkWorkflowAction(
		{ ...ctx, checkAlternativeExecutors: [accepting, "check-not-registered"] },
		{ workflow: "wfpin.json" },
	);
	assert.equal(quiet.outcome, "success", quiet.text);
	assert.doesNotMatch(quiet.text, /Hint:/);
	assert.equal(quiet.data.wouldRefuse, undefined);
	const flagged = await checkWorkflowAction(ctx, {
		workflow: "wfpin.json",
		executor,
	});
	assert.equal(flagged.outcome, "success", flagged.text);
	assert.doesNotMatch(flagged.text, /Hint:|pinned by/);
	const plain = await checkWorkflowAction(ctx, {
		workflow: "wf.json",
		executor,
	});
	assert.doesNotMatch(plain.text, /Hint:|pinned by/);
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

test("compactCapabilityText lists every counted degradation, including entries without a code", () => {
	const entry = (key, note) => ({
		key,
		need: "required",
		onMissing: "refuse",
		observed: null,
		outcome: "degraded",
		note,
	});
	const stage = (label, entries) => ({
		label,
		stageId: label,
		negotiatedAt: "pre-launch",
		report: { entries, refusals: [], degradations: entries.map((e) => e.key) },
	});
	const text = compactCapabilityText({
		preview:
			"Capability check (x@0.1.0, 2 stages): accepted with 2 degradations",
		stages: [
			stage("a.main", [entry("cost", "tokens only")]),
			stage("b.main", [entry("cost", "tokens only"), entry("tools")]),
		],
		forcedReadOnly: [],
	});
	assert.equal(
		text,
		[
			"Capability check (x@0.1.0, 2 stages): accepted with 2 degradations",
			"  ⚠ cost — tokens only (all 2 stages)",
			"  ⚠ tools (b.main)",
		].join("\n"),
	);
});

test("check edge cases: its own action name; no dashboard even when auto-start is on; --detach starts nothing; allowed for workers", async (t) => {
	const { ctx, executor, effects } = await project(t);
	const autostart = { ...ctx, env: { ...ctx.env } };
	delete autostart.env.AGENT_WORKFLOW_DASHBOARD_AUTOSTART;
	const checked = await checkWorkflowAction(autostart, {
		workflow: "wf.json",
		executor,
	});
	assert.equal(checked.action, "check");
	assert.equal(checked.ok, true, checked.text);
	assert.equal(checked.data.dashboard, undefined);
	assert.equal(
		existsSync(join(stateDir(ctx.cwd), ".agent-workflow", "dashboard.json")),
		false,
		"a preflight starts no dashboard",
	);
	// Launch-only flags are accepted and do nothing (no detached supervisor, no run).
	const out = [];
	assert.equal(
		await runAgentWorkflowCli(
			[
				"check",
				"wf.json",
				"--executor",
				executor,
				"--detach",
				"--force-new",
				"--json",
			],
			{
				cwd: ctx.cwd,
				env: autostart.env,
				stdout: (text) => out.push(text),
				stderr: () => {},
				isTTY: false,
			},
		),
		0,
	);
	const json = JSON.parse(out.join(""));
	assert.equal(json.action, "check");
	assert.equal(json.data.detached, undefined);
	assert.equal(json.data.runId, undefined);
	// A worker process may check (it may validate too): same answer, still nothing launched.
	const worker = await checkWorkflowAction(
		{ ...ctx, env: { ...ctx.env, AGENT_WORKFLOW_ROLE: "worker" } },
		{ workflow: "wf.json", executor },
	);
	assert.equal(worker.ok, true, worker.text);
	assert.equal(existsSync(effects), false, "the executor was never asked");
	assert.equal(
		existsSync(join(stateDir(ctx.cwd), ".agent-workflow", "workflows")) &&
			readdirSync(join(stateDir(ctx.cwd), ".agent-workflow", "workflows")).some(
				(name) => name.startsWith("workflow_"),
			),
		false,
	);
});

test("check: every option its help lists is accepted (help named --preset/--role, which no launch command parses)", async (t) => {
	const { ctx, executor } = await project(t);
	const { COMMAND_HELP } = await import("../../dist/hosts/help.js");
	const usage = COMMAND_HELP.check.slice(0, COMMAND_HELP.check.indexOf("\n\n"));
	const options = [...usage.matchAll(/\[(--[a-z-]+)(?: ([^\]]+))?\]/g)].map(
		([, flag, value]) => ({ flag, value }),
	);
	assert.ok(options.length >= 5, usage);
	const sample = {
		"--executor": executor,
		"--profile": "codex",
		"--model": "fixture-model",
		"--effort": "medium",
		"--permission-mode": "free",
	};
	let err = "";
	const io = {
		cwd: ctx.cwd,
		env: ctx.env,
		isTTY: false,
		stdout: () => {},
		stderr: (text) => {
			err += text;
		},
	};
	for (const { flag, value } of options) {
		err = "";
		const args = ["check", "wf.json", "--executor", executor];
		if (flag !== "--executor")
			args.push(flag, ...(value ? [sample[flag] ?? "x"] : []));
		await runAgentWorkflowCli(args, io);
		assert.doesNotMatch(err, /Unknown option/, `${flag}: ${err}`);
	}
});
