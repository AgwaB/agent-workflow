// New in agent-workflow (WP17): `agent-workflow doctor` (host API `doctorAction` and the CLI) and the
// host identity plumbing (CLI → "cli", Pi host → "pi"). Fakes only: probes come from injected
// probers or fixture descriptors registered in-process under the built-in ids; the unit runner's
// fail-fast `pi`/`codex`/`claude` shims stand in for "nothing installed". No model calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const piHost = await import("../../dist/hosts/pi/host.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp17-doctor-")));
});
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	// Detached finalizers of completed runs may still be releasing files.
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const READY = { installed: true, cliVersion: "2.1.310", auth: "ok" };
const UNKNOWN = { installed: true, cliVersion: "1.1.0", auth: "unknown" };
const LOGGED_OUT = { installed: true, cliVersion: "0.150.0", auth: "missing" };
const NOT_INSTALLED = { installed: false, cliVersion: null, auth: "unknown" };

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			name: "doctor-one-stage",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		})}\n`,
	);
	const codexHome = join(cwd, "codex-home");
	await mkdir(join(codexHome, "rules"), { recursive: true });
	return {
		cwd,
		codexHome,
		env: {
			...process.env,
			AGENT_WORKFLOW_HOME: join(cwd, "home"),
			CODEX_HOME: codexHome,
		},
	};
}

function fakeProber(probes) {
	return async (descriptor) => {
		const probe = probes[descriptor.id];
		if (probe instanceof Error) throw probe;
		return { probe, capabilities: {} };
	};
}

function shadowBuiltins(probes) {
	for (const [id, probe] of Object.entries(probes))
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({
					id,
					effectLog: join(root, `${id}-${counter}.jsonl`),
					probe,
				}),
			),
		);
}

function capture(cwd, env) {
	const out = [];
	const err = [];
	return {
		io: {
			cwd,
			env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY: false,
		},
		out: () => out.join(""),
		err: () => err.join(""),
	};
}

test("doctorAction: executors, default and why, verified versions, fix commands (text and data)", async () => {
	const { cwd, env } = await project();
	const ctx = { cwd, env, host: "cli" };
	const result = await api.doctorAction(ctx, {
		prober: fakeProber({
			pi: NOT_INSTALLED,
			claude: READY,
			codex: LOGGED_OUT,
		}),
		nodeVersion: "24.1.0",
	});
	assert.equal(result.action, "doctor");
	assert.equal(result.ok, true);
	assert.equal(result.outcome, "success");
	const byId = Object.fromEntries(
		result.data.executors.map((entry) => [entry.id, entry]),
	);
	assert.deepEqual(
		result.data.executors.map((entry) => entry.id),
		["pi", "claude", "codex"],
	);
	assert.equal(byId.pi.state, "not-installed");
	assert.match(
		byId.pi.fix,
		/^install: see docs\/usage\.md#executors, check with `pi --version`$/,
	);
	assert.equal(byId.claude.usable, true);
	assert.equal(byId.claude.verifiedVersion, "2.1.310");
	assert.equal(byId.claude.versionMatchesVerified, true);
	assert.equal(byId.codex.state, "logged-out");
	assert.equal(byId.codex.fix, "log in: run `codex login`");
	assert.equal(byId.codex.versionMatchesVerified, false);
	assert.deepEqual(result.data.defaultExecutor, {
		id: "claude",
		source: "installed-default",
		usable: true,
		reason:
			"the terminal CLI uses the first installed and logged-in of pi → claude → codex, preferring a verified login over unknown auth.",
	});
	assert.deepEqual(result.data.permissionMode, {
		mode: "free",
		source: "default",
	});
	assert.deepEqual(result.data.node, {
		version: "v24.1.0",
		required: ">=22",
		supported: true,
	});
	assert.equal(result.data.home.path, join(cwd, "home"));
	assert.equal(result.data.home.fromEnv, true);
	assert.equal(result.data.home.exists, false);
	assert.equal(result.data.home.writable, true);
	assert.ok(
		result.data.warnings.some((warning) =>
			/codex: installed 0\.150\.0 differs from the verified/.test(warning),
		),
	);
	assert.match(result.text, /^agent-workflow doctor \(host: cli\)/);
	assert.match(result.text, /pi\s+not usable\s+not installed/);
	assert.match(
		result.text,
		/claude\s+usable\s+installed 2\.1\.310 \(verified 2\.1\.310\), logged in/,
	);
	assert.match(result.text, /fix: log in: run `codex login`/);
	assert.match(
		result.text,
		/Default executor here: claude \(installed-default\): the terminal CLI uses/,
	);
	assert.match(result.text, /Permission mode default: free \(default\)/);
	assert.match(result.text, /Node: v24\.1\.0 \(requires >=22\)/);
	assert.match(result.text, /OK: 1 of 3 executors usable\./);
	// Nothing was written by the check.
	assert.equal(existsSync(join(cwd, "home")), false);
	assert.equal(existsSync(join(cwd, ".agent-workflow", "workflows")), false);
});

test("doctorAction: host default, saved default profile, unsupported Node, unusable result", async () => {
	const { cwd, env } = await project();
	const prober = fakeProber({
		pi: UNKNOWN,
		claude: NOT_INSTALLED,
		codex: READY,
	});
	const hosted = await api.doctorAction(
		{ cwd, env, host: "claude-code" },
		{ prober },
	);
	assert.deepEqual(hosted.data.defaultExecutor, {
		id: "claude",
		source: "host-default",
		usable: false,
		reason: "the claude-code host uses its own CLI (claude).",
	});
	assert.match(
		hosted.text,
		/Default executor here: claude \(host-default, not usable\)/,
	);
	assert.match(
		hosted.text,
		/pi\s+usable\s+installed 1\.1\.0 \(verified 1\.1\.0\), auth unknown \(counts as usable\)/,
	);

	await api.profileAction(
		{ cwd, env },
		{
			op: "set",
			name: "mine",
			values: { executor: "codex", permissionMode: "safe" },
			makeDefault: true,
		},
	);
	const profiled = await api.doctorAction(
		{ cwd, env, host: "cli" },
		{ prober, nodeVersion: "v20.11.0" },
	);
	assert.deepEqual(profiled.data.defaultExecutor, {
		id: "codex",
		source: "user-profile",
		profile: "mine",
		usable: true,
		reason: 'The default saved user profile "mine" selects it.',
	});
	assert.deepEqual(profiled.data.permissionMode, {
		mode: "safe",
		source: "user-profile",
		profile: "mine",
	});
	assert.equal(profiled.data.node.supported, false);
	assert.match(profiled.text, /requires >=22, UNSUPPORTED/);
	assert.match(
		profiled.text,
		/Permission mode default: safe \(saved user profile "mine"\)/,
	);

	const none = await api.doctorAction(
		{ cwd, env, host: "cli" },
		{
			prober: fakeProber({
				pi: new Error("spawn pi ENOENT"),
				claude: NOT_INSTALLED,
				codex: LOGGED_OUT,
			}),
		},
	);
	assert.equal(none.ok, false);
	assert.equal(none.outcome, "failed");
	assert.equal(none.data.usable, false);
	// The saved profile still names codex, which is not usable here.
	assert.equal(none.data.defaultExecutor.usable, false);
	assert.match(none.text, /pi\s+not usable\s+probe failed \(spawn pi ENOENT\)/);
	assert.match(none.text, /No executor is usable\./);
});

test("doctorAction: Codex environment warnings are counts only; stale run-index entries get a prune hint", async () => {
	const { cwd, env, codexHome } = await project();
	await writeFile(
		join(codexHome, "rules", "default.rules"),
		'prefix_rule(pattern=["secret-command-xyz"], decision="allow")\nprefix_rule(pattern=["rm"], decision="forbidden")\n',
	);
	await writeFile(
		join(codexHome, "AGENTS.md"),
		"private global instructions\n",
	);
	const runsRoot = join(cwd, ".agent-workflow", "workflows");
	await mkdir(join(runsRoot, "workflow_present"), { recursive: true });
	await writeFile(join(runsRoot, "workflow_present", "run.json"), "{}\n");
	const entry = (runId, status) => ({
		runId,
		type: "workflow",
		status,
		taskSummary: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		runJson: `.agent-workflow/workflows/${runId}/run.json`,
	});
	await writeFile(
		join(runsRoot, "index.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
			runs: [
				entry("workflow_present", "completed"),
				entry("workflow_gone_a", "failed"),
				entry("workflow_gone_b", "running"),
			],
		})}\n`,
	);
	const result = await api.doctorAction(
		{ cwd, env, host: "cli" },
		{ prober: fakeProber({ pi: READY, claude: READY, codex: READY }) },
	);
	const warnings = result.data.warnings.join("\n");
	assert.match(warnings, /codex: 1 allow rule in 1 file under /);
	assert.match(warnings, /codex: global instructions .*AGENTS\.md \(1 file\)/);
	assert.doesNotMatch(
		result.text,
		/secret-command-xyz|private global instructions/,
	);
	assert.doesNotMatch(
		JSON.stringify(result.data),
		/secret-command-xyz|private global instructions/,
	);
	assert.deepEqual(
		{
			entries: result.data.runIndex.entries,
			dangling: result.data.runIndex.dangling,
			prunable: result.data.runIndex.prunable,
			stale: result.data.runIndex.stale,
		},
		{ entries: 3, dangling: 2, prunable: 0, stale: 2 },
	);
	assert.match(result.text, /3 entries, 2 stale \(2 missing run\.json/);
	assert.match(result.text, /run `agent-workflow prune` to preview/);
});

test("doctorAction: an unwritable AGENT_WORKFLOW_HOME is reported", async (t) => {
	if (process.getuid?.() === 0) t.skip("root can write anywhere");
	const { cwd, env } = await project();
	const locked = join(cwd, "locked");
	await mkdir(locked);
	await chmod(locked, 0o500);
	try {
		const result = await api.doctorAction(
			{
				cwd,
				env: { ...env, AGENT_WORKFLOW_HOME: join(locked, "home") },
				host: "cli",
			},
			{ prober: fakeProber({ pi: READY, claude: READY, codex: READY }) },
		);
		assert.equal(result.data.home.writable, false);
		assert.match(result.text, /NOT writable/);
		assert.ok(
			result.data.warnings.some((warning) => /is not writable/.test(warning)),
		);
	} finally {
		await chmod(locked, 0o700);
	}
});

test("CLI doctor: exit 1 when nothing is usable (shimmed CLIs), --json shape, exit 0 with one usable executor", async () => {
	const { cwd, env } = await project();
	const none = capture(cwd, env);
	assert.equal(await cli.runAgentWorkflowCli(["doctor"], none.io), 1);
	assert.match(none.out(), /agent-workflow doctor \(host: cli\)/);
	assert.match(none.out(), /pi\s+not usable\s+not installed/);
	assert.match(none.out(), /claude\s+not usable\s+not installed/);
	assert.match(none.out(), /codex\s+not usable\s+not installed/);
	assert.match(none.out(), /No executor is usable/);

	const json = capture(cwd, env);
	assert.equal(await cli.runAgentWorkflowCli(["doctor", "--json"], json.io), 1);
	const parsed = JSON.parse(json.out());
	assert.equal(parsed.action, "doctor");
	assert.equal(parsed.ok, false);
	assert.equal(parsed.data.host, "cli");
	assert.equal(parsed.data.defaultExecutor.id, null);
	assert.equal(parsed.data.executors.length, 3);

	const usage = capture(cwd, env);
	assert.equal(await cli.runAgentWorkflowCli(["doctor", "extra"], usage.io), 2);

	shadowBuiltins({ pi: NOT_INSTALLED, claude: NOT_INSTALLED, codex: READY });
	const ok = capture(cwd, env);
	assert.equal(await cli.runAgentWorkflowCli(["doctor"], ok.io), 0);
	assert.match(ok.out(), /Default executor here: codex \(installed-default\)/);
	assert.match(ok.out(), /OK: 1 of 3 executors usable\./);
	const help = capture(cwd, env);
	assert.equal(await cli.runAgentWorkflowCli(["help", "doctor"], help.io), 0);
	assert.match(help.out(), /Usage: agent-workflow doctor/);
});

test("CLI run without an executor: nothing usable is refused before any run record, with fix commands", async () => {
	const { cwd, env } = await project();
	const result = capture(cwd, env);
	const code = await cli.runAgentWorkflowCli(
		["run", "wf.json", "task"],
		result.io,
	);
	assert.equal(code, 1);
	assert.match(result.out(), /^Not started: no executor is usable/);
	assert.match(
		result.out(),
		/- pi: not installed; install: see docs\/usage\.md#executors/,
	);
	assert.match(
		result.out(),
		/- claude: not installed; install: `npm i -g @anthropic-ai\/claude-code`/,
	);
	assert.match(
		result.out(),
		/- codex: not installed; install: `npm i -g @openai\/codex`/,
	);
	assert.equal(existsSync(join(cwd, ".agent-workflow", "workflows")), false);
});

test("CLI run without an executor uses the first usable one and records installed-default with host cli", async () => {
	const { cwd, env } = await project();
	shadowBuiltins({ pi: NOT_INSTALLED, claude: READY, codex: READY });
	const result = capture(cwd, env);
	const code = await cli.runAgentWorkflowCli(
		["run", "wf.json", "task", "--json", "--timeout", "60s"],
		result.io,
	);
	const parsed = JSON.parse(result.out());
	assert.equal(code, 0, result.out() + result.err());
	assert.deepEqual(parsed.data.executor, {
		id: "claude",
		source: "installed-default",
		host: "cli",
	});
	// An explicit --executor wins even when it is not the installed default.
	const explicit = capture(cwd, env);
	assert.equal(
		await cli.runAgentWorkflowCli(
			[
				"run",
				"wf.json",
				"task two",
				"--executor",
				"codex",
				"--json",
				"--timeout",
				"60s",
			],
			explicit.io,
		),
		0,
	);
	assert.deepEqual(JSON.parse(explicit.out()).data.executor, {
		id: "codex",
		source: "run-flag",
	});
});

test('Pi host passes host "pi" (the CLI passes "cli": see the run and doctor tests above)', () => {
	const ctx = piHost.hostContext(
		{ env: {}, pi: { getThinkingLevel: () => undefined } },
		{ cwd: "/tmp/project" },
	);
	assert.equal(ctx.host, "pi");
	assert.equal(ctx.cwd, "/tmp/project");
});
