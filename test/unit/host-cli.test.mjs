// New in agent-workflow (WP11a): the `agent-workflow` CLI (src/hosts/cli). In-process tests drive
// runAgentWorkflowCli with a captured io (argv parsing, exit codes, TTY vs non-TTY confirmation,
// the bounded wait loop, profiles); spawned tests run the real bin in fresh processes with the
// guarded test-executor hook (detach + later status/wait, stop of a detached run, hook guards).
// No model or agent-CLI calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

const BIN = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const HOOK_MODULE = fileURLToPath(
	new URL("../helpers/host-test-executor.mjs", import.meta.url),
);

const ONE_STAGE = {
	schemaVersion: 1,
	name: "cli-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-host-cli-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

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
	return cwd;
}

function fixture(config = {}) {
	counter += 1;
	const id = `test-cli-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				...config,
				id,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	return id;
}

/** Captured io for runAgentWorkflowCli. */
function capture(cwd, extra = {}) {
	const out = [];
	const err = [];
	const prompts = [];
	const io = {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
		...extra,
	};
	if (extra.answer !== undefined)
		io.prompt = async (question) => {
			prompts.push(question);
			return extra.answer;
		};
	return {
		io,
		prompts,
		out: () => out.join(""),
		err: () => err.join(""),
	};
}

async function runCli(cwd, argv, extra) {
	const captured = capture(cwd, extra);
	const code = await cli.runAgentWorkflowCli(argv, captured.io);
	return { code, ...captured };
}

test("argv parsing and exit codes: help/version 0, usage errors 2, failures 1", async () => {
	const cwd = await project();
	for (const argv of [
		[],
		["help"],
		["--help"],
		["help", "run"],
		["run", "--help"],
	]) {
		const result = await runCli(cwd, argv);
		assert.equal(result.code, 0, argv.join(" "));
		assert.match(result.out(), /Usage: agent-workflow/);
	}
	assert.match((await runCli(cwd, ["wait", "-h"])).out(), /bounded to 45 s/);
	const version = await runCli(cwd, ["--version"]);
	assert.equal(version.code, 0);
	assert.match(version.out(), /^\d+\.\d+\.\d+/);
	for (const [argv, pattern] of [
		[["bogus"], /Unknown command "bogus"/],
		[["help", "bogus"], /Unknown command "bogus"/],
		[["list", "--bogus"], /Unknown option --bogus/],
		[["list", "--limit", "x"], /--limit requires a non-negative integer/],
		[["validate"], /Usage: validate/],
		[["run"], /Usage: agent-workflow run/],
		[["run", "wf.json"], /Missing task/],
		[["dynamic"], /Missing task/],
		[["run", "wf.json", "t", "--executor"], /--executor requires a value/],
		[
			["run", "wf.json", "t", "--executor", "a", "--executor=b"],
			/Duplicate option --executor/,
		],
		[
			["run", "wf.json", "t", "--permission-mode", "yolo"],
			/must be "free" or "safe"/,
		],
		[["run", "wf.json", "t", "--effort", "turbo"], /Invalid effort level/],
		[
			["run", "wf.json", "t", "--thinking", "low", "--effort", "high"],
			/Duplicate option --effort/,
		],
		[
			["run", "wf.json", "t", "--allow-unverified", "a b"],
			/invalid capability key/,
		],
		[
			["run", "wf.json", "t", "--detach", "--timeout", "5s"],
			/cannot be combined/,
		],
		[
			["wait", "workflow_x", "--timeout", "soon"],
			/--timeout requires a duration/,
		],
		[["wait", "workflow_x", "--timeout", "10ms"], /between 1s/],
		[["supervise"], /Missing run id/],
		[["supervise", "--all", "--poll-ms", "1"], /--poll-ms requires an integer/],
		[["prune", "--keep", "-1"], /--keep requires a numeric value|non-negative/],
		[
			["notices", "clear", "../escape"],
			/Invalid workflow run id|Usage: notices/,
		],
		[["profile", "frob"], /Unknown profile operation/],
		[["profile", "set"], /Usage: profile set/],
	]) {
		const result = await runCli(cwd, argv);
		assert.equal(result.code, 2, `${argv.join(" ")}: ${result.err()}`);
		assert.match(result.err(), pattern, argv.join(" "));
	}
	await writeFile(join(cwd, "bad.json"), "{}");
	const invalid = await runCli(cwd, ["validate", "bad.json"]);
	assert.equal(invalid.code, 1);
	const missing = await runCli(cwd, ["status", "workflow_missing"]);
	assert.equal(missing.code, 1);
	assert.match(missing.err(), /not found/);
	const jsonUsage = await runCli(cwd, ["run", "wf.json", "--json"]);
	assert.equal(jsonUsage.code, 2);
	assert.deepEqual(JSON.parse(jsonUsage.out()), {
		action: "run",
		ok: false,
		outcome: "usage",
		error: 'Missing task. Usage: agent-workflow run <workflow> "<task>"',
	});
	const refused = await runCli(cwd, [
		"run",
		"wf.json",
		"t",
		"--executor",
		"no-such-executor",
	]);
	assert.equal(refused.code, 1);
	assert.match(refused.out(), /^Not started: executor "no-such-executor"/);
	const listed = await runCli(cwd, ["list", "--json"]);
	assert.equal(listed.code, 0);
	const parsed = JSON.parse(listed.out());
	assert.equal(parsed.action, "list");
	assert.equal(parsed.ok, true);
	assert.ok(parsed.data.workflows.some((row) => row.name === "deep-review"));
});

test("run: foreground run waits until terminal; task words join; --json combines launch and wait", async () => {
	const cwd = await project();
	const id = fixture();
	const result = await runCli(cwd, [
		"run",
		"wf.json",
		"collect",
		"the",
		"facts",
		"--executor",
		id,
		"--json",
	]);
	assert.equal(result.code, 0, result.err());
	const parsed = JSON.parse(result.out());
	assert.equal(parsed.action, "run");
	assert.equal(parsed.outcome, "completed");
	assert.equal(parsed.data.wait.terminal, true);
	const compiled = JSON.parse(
		readFileSync(
			join(
				cwd,
				".agent-workflow",
				"workflows",
				parsed.data.runId,
				"compiled.json",
			),
			"utf8",
		),
	);
	assert.equal(compiled.task, "collect the facts");
	const text = await runCli(cwd, [
		"run",
		"wf.json",
		"--executor",
		id,
		"--",
		"--literal task",
	]);
	assert.equal(text.code, 0, text.err());
	assert.match(
		text.out(),
		/Capability check .*accepted[\s\S]*Workflow started: cli-one-stage/,
	);
	assert.match(text.err(), /Waiting for workflow_/);
});

test("confirmation: TTY asks y/N when degradations need it; --yes and non-TTY proceed non-interactively", async () => {
	const cwd = await project();
	const id = fixture({
		capabilities: {
			contextIsolation: {
				level: "emulated",
				source: "probed",
				warning: "global AGENTS.md loaded",
			},
		},
	});
	const argv = (task, ...extra) => [
		"run",
		"wf.json",
		task,
		"--executor",
		id,
		"--permission-mode",
		"safe",
		"--json",
		...extra,
	];
	const declined = await runCli(cwd, argv("declined"), {
		isTTY: true,
		answer: "n",
	});
	assert.equal(declined.code, 1);
	assert.equal(declined.prompts.length, 1);
	assert.match(declined.prompts[0], /\[y\/N\]/);
	assert.match(declined.err(), /global AGENTS\.md loaded/);
	const declinedJson = JSON.parse(declined.out());
	assert.equal(declinedJson.outcome, "refused");
	assert.equal(
		declinedJson.data.refusal.code,
		"CAPABILITY_DEGRADATION_DECLINED",
	);

	const accepted = await runCli(cwd, argv("accepted"), {
		isTTY: true,
		answer: "y",
	});
	assert.equal(accepted.code, 0, accepted.err());
	assert.equal(accepted.prompts.length, 1);
	assert.equal(
		JSON.parse(accepted.out()).data.capability.confirmation,
		"confirmed",
	);

	const yes = await runCli(cwd, argv("yes", "--yes"), {
		isTTY: true,
		answer: "n",
	});
	assert.equal(yes.code, 0, yes.err());
	assert.equal(yes.prompts.length, 0);
	assert.equal(
		JSON.parse(yes.out()).data.capability.confirmation,
		"non-interactive",
	);

	const piped = await runCli(cwd, argv("piped"), { isTTY: false, answer: "n" });
	assert.equal(piped.code, 0, piped.err());
	assert.equal(piped.prompts.length, 0);
	assert.equal(
		JSON.parse(piped.out()).data.capability.confirmation,
		"non-interactive",
	);

	const clean = fixture();
	const quiet = await runCli(
		cwd,
		["run", "wf.json", "clean", "--executor", clean],
		{
			isTTY: true,
			answer: "n",
		},
	);
	assert.equal(quiet.code, 0, quiet.err());
	assert.equal(quiet.prompts.length, 0, "nothing to confirm");
	assert.match(quiet.out(), /^Capability check/);
});

test("wait: --timeout returns still running (exit 1); without it the CLI loops bounded waits until terminal", async () => {
	const cwd = await project();
	const id = fixture({ stepDelayMs: 1_000 });
	const ctx = {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
	};
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "slow",
		executor: id,
	});
	const runId = launched.data.runId;
	const bounded = await runCli(cwd, [
		"wait",
		runId,
		"--timeout",
		"1s",
		"--json",
	]);
	assert.equal(bounded.code, 1);
	const boundedJson = JSON.parse(bounded.out());
	assert.equal(boundedJson.data.stillRunning, true);
	assert.equal(boundedJson.data.terminal, false);
	assert.equal(boundedJson.outcome, "running");

	const looped = await runCli(cwd, ["wait", runId.slice(0, 20)], {
		waitSliceMs: 1_000,
	});
	assert.equal(looped.code, 0, looped.err());
	assert.ok(
		(
			looped.err().match(/still running after a 1000ms wait; waiting again/g) ??
			[]
		).length >= 1,
		looped.err(),
	);
	assert.match(looped.out(), /analysis/);
});

test("profile: set/show/list/default/delete round trip through the CLI", async () => {
	const cwd = await project();
	const set = await runCli(cwd, [
		"profile",
		"set",
		"fast",
		"--executor",
		"codex",
		"--effort",
		"high",
		"--permission-mode",
		"safe",
		"--strict-capabilities",
		"readOnly,contextIsolation",
		"--default",
	]);
	assert.equal(set.code, 0, set.err());
	assert.match(set.out(), /^Saved profile:\nfast \(default\)/);
	const shown = await runCli(cwd, ["profile", "show", "--json"]);
	const profile = JSON.parse(shown.out()).data.profile;
	assert.equal(profile.name, "fast");
	assert.equal(profile.executor, "codex");
	assert.equal(profile.effort, "high");
	assert.equal(profile.permissionMode, "safe");
	assert.deepEqual(profile.strictCapabilities, [
		"readOnly",
		"contextIsolation",
	]);
	const unset = await runCli(cwd, [
		"profile",
		"set",
		"fast",
		"--unset",
		"effort",
	]);
	assert.equal(unset.code, 0);
	assert.match(unset.out(), /^Updated profile:/);
	assert.doesNotMatch(unset.out(), /effort/);
	assert.match(
		(await runCli(cwd, ["profile", "list"])).out(),
		/fast \(default\)/,
	);
	assert.equal((await runCli(cwd, ["profile", "default", "--clear"])).code, 0);
	assert.match(
		(await runCli(cwd, ["profile", "show"])).out(),
		/No default profile is set/,
	);
	assert.equal((await runCli(cwd, ["profile", "default", "fast"])).code, 0);
	assert.equal((await runCli(cwd, ["profile", "delete", "fast"])).code, 0);
	assert.equal((await runCli(cwd, ["profile", "delete", "fast"])).code, 2);
	const stored = JSON.parse(
		readFileSync(
			join(cwd, "home", "user-profiles", "v1", "profiles.json"),
			"utf8",
		),
	);
	assert.deepEqual(stored, {
		schema: "agent-workflow-user-profiles-v1",
		profiles: {},
	});
});

/** Spawn the real bin in a fresh process. */
function bin(cwd, args, env = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			cwd,
			env: {
				...process.env,
				AGENT_WORKFLOW_HOME: join(cwd, "home"),
				AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
	});
}

function hookEnv(cwd, config) {
	return {
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		AW_HOST_TEST_EFFECT_LOG: join(cwd, "effects.jsonl"),
		...(config ? { AW_HOST_TEST_EXECUTOR_CONFIG: JSON.stringify(config) } : {}),
	};
}

async function eventually(check, what, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	assert.fail(`timed out waiting for ${what}`);
}

test("detach: the bin returns a running run; fresh processes read status and wait to completion", async () => {
	const cwd = await project();
	const env = hookEnv(cwd);
	const launched = await bin(
		cwd,
		[
			"run",
			"wf.json",
			"detached task",
			"--executor",
			"test-fixture",
			"--detach",
			"--json",
		],
		env,
	);
	assert.equal(launched.code, 0, launched.stderr);
	assert.match(launched.stderr, /test executor "test-fixture" registered/);
	const data = JSON.parse(launched.stdout).data;
	assert.equal(data.status, "running");
	assert.equal(typeof data.detached.pid, "number");
	const status = await bin(cwd, ["status", data.runId, "--json"], env);
	assert.equal(status.code, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).data.run.runId, data.runId);
	const waited = await bin(cwd, ["wait", data.runId, "--json"], env);
	assert.equal(waited.code, 0, waited.stderr);
	const result = JSON.parse(waited.stdout);
	assert.equal(result.outcome, "completed");
	assert.equal(result.data.terminal, true);
	const log = data.detached.logPath;
	await eventually(
		() =>
			existsSync(log) &&
			readFileSync(log, "utf8").includes(`done: ${data.runId} completed`),
		"the detached supervisor to finish",
	);
});

test("stop: a fresh process stops a running detached run; its supervisor exits", async () => {
	const cwd = await project();
	const env = hookEnv(cwd, { stepDelayMs: 2_000 });
	const launched = await bin(
		cwd,
		[
			"run",
			"wf.json",
			"long task",
			"--executor",
			"test-fixture",
			"--detach",
			"--json",
		],
		env,
	);
	assert.equal(launched.code, 0, launched.stderr);
	const { runId, detached } = JSON.parse(launched.stdout).data;
	const stopped = await bin(cwd, ["stop", runId, "--json"], env);
	assert.equal(stopped.code, 0, stopped.stderr);
	assert.equal(JSON.parse(stopped.stdout).data.status, "interrupted");
	const status = await bin(cwd, ["status", runId, "--json"], env);
	assert.equal(JSON.parse(status.stdout).data.run.status, "interrupted");
	const waited = await bin(cwd, ["wait", runId], env);
	assert.equal(waited.code, 1, "an interrupted run is not a success");
	await eventually(
		() =>
			existsSync(detached.logPath) &&
			/done: \S+ interrupted/.test(readFileSync(detached.logPath, "utf8")),
		"the detached supervisor to observe the stop",
	);
});

test("test-executor hook: guarded by an explicit ack, an absolute path and a test- id", async () => {
	const cwd = await project();
	const noAck = await bin(cwd, ["list"], {
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AW_HOST_TEST_EFFECT_LOG: join(cwd, "effects.jsonl"),
	});
	assert.equal(noAck.code, 2);
	assert.match(
		noAck.stderr,
		/AGENT_WORKFLOW_TEST_EXECUTOR_ACK is not "test-only"/,
	);
	const relative = await bin(cwd, ["list"], {
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: "helper.mjs",
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
	});
	assert.equal(relative.code, 2);
	assert.match(relative.stderr, /must be an absolute path/);
	const shadow = join(cwd, "shadow.mjs");
	await writeFile(
		shadow,
		`export const testExecutorDescriptor = { id: "pi", version: "0.1.0", contractVersion: "0.1.0", module: ${JSON.stringify(shadow)}, config: null };\n`,
	);
	const shadowing = await bin(cwd, ["list"], {
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: shadow,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
	});
	assert.equal(shadowing.code, 2);
	assert.match(shadowing.stderr, /must start with "test-"/);
	const unhooked = await bin(cwd, [
		"run",
		"wf.json",
		"t",
		"--executor",
		"test-fixture",
	]);
	assert.equal(unhooked.code, 1);
	assert.match(
		unhooked.stdout,
		/executor "test-fixture" from run flag is unknown/,
	);
	assert.doesNotMatch(unhooked.stderr, /registered/);
});
