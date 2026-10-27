// New in agent-workflow (WP17): the default executor is the host's own CLI (owner decision
// "기본 실행기", 2026-10-27). Explicit selections keep B2 precedence and are never probed; the
// Claude Code / Codex / Pi hosts default to claude / codex / pi; the terminal CLI takes the first
// installed and logged-in of pi → claude → codex; nothing usable fails before any run record with
// install/login commands; nested runs keep the parent's executor. Fakes only: built-in ids are
// shadowed in-process by fixture descriptors (no real CLI, no model call).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let countingModule;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp17-")));
	// An executor module whose probe() appends one line per call (probe-count and cache checks).
	countingModule = join(root, "counting-executor.mjs");
	const testing = pathToFileURL(
		join(process.cwd(), "dist", "sdk", "testing", "index.js"),
	).href;
	await writeFile(
		countingModule,
		[
			'import { appendFileSync } from "node:fs";',
			`import { createFakeExecutor } from ${JSON.stringify(testing)};`,
			"export function createExecutor(config) {",
			"\tconst inner = createFakeExecutor({ id: config.id, version: '0.1.0', ...(config.probe ? { probe: config.probe } : {}) });",
			"\tconst probe = inner.probe;",
			"\tinner.probe = async () => { appendFileSync(config.log, `${config.id}\\n`); return probe(); };",
			"\treturn inner;",
			"}",
			"",
		].join("\n"),
	);
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
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

const READY = { installed: true, cliVersion: "1.0.0", auth: "ok" };
const UNKNOWN = { installed: true, cliVersion: "1.0.0", auth: "unknown" };
const MISSING_AUTH = { installed: true, cliVersion: "1.0.0", auth: "missing" };
const EXPIRED = { installed: true, cliVersion: "1.0.0", auth: "expired" };
const NOT_INSTALLED = { installed: false, cliVersion: null, auth: "unknown" };

/** Shadow the built-in ids with counting fakes; returns the probe log path. */
function shadowBuiltins(probes, name) {
	const log = join(root, `${name}-probes.log`);
	for (const [id, probe] of Object.entries(probes))
		unregister.push(
			core.registerWorkflowExecutor({
				id,
				version: "0.1.0",
				contractVersion: "0.1.0",
				module: countingModule,
				config: { id, log, ...(probe ? { probe } : {}) },
			}),
		);
	return log;
}

function probeLog(log) {
	return existsSync(log)
		? readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
}

async function project(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read and report.\n",
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		`${JSON.stringify({
			schemaVersion: 1,
			name: "wp17-one-stage",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		})}\n`,
	);
	return { cwd, specPath };
}

test("explicit selections keep B2 precedence and are never probed or second-guessed", async () => {
	const log = shadowBuiltins(
		{ pi: READY, claude: NOT_INSTALLED, codex: MISSING_AUTH },
		"explicit",
	);
	const flag = await core.resolveRunExecutorForHost({
		runFlag: "claude",
		workflowProfileName: "fast",
		workflowProfileExecutor: "codex",
		userProfileName: "mine",
		userProfileExecutor: "pi",
		host: "cli",
	});
	assert.deepEqual([flag.id, flag.source], ["claude", "run-flag"]);
	assert.equal(flag.host, undefined);
	const workflow = await core.resolveRunExecutorForHost({
		workflowProfileName: "fast",
		workflowProfileExecutor: "codex",
		userProfileName: "mine",
		userProfileExecutor: "pi",
		host: "claude-code",
	});
	assert.deepEqual(
		[workflow.id, workflow.source, workflow.profile],
		["codex", "workflow-profile", "fast"],
	);
	const user = await core.resolveRunExecutorForHost({
		userProfileName: "mine",
		userProfileExecutor: "claude",
		host: "pi",
	});
	assert.deepEqual(
		[user.id, user.source, user.profile],
		["claude", "user-profile", "mine"],
	);
	const override = await core.resolveRunExecutorForHost({
		defaultExecutor: "codex",
		host: "cli",
	});
	assert.deepEqual([override.id, override.source], ["codex", "default"]);
	// None of the explicit choices probed anything (the not-installed claude was taken as chosen).
	assert.deepEqual(probeLog(log), []);
	// An unknown explicit executor still fails, never falls back to the host default.
	await assert.rejects(
		core.resolveRunExecutorForHost({ runFlag: "nope", host: "cli" }),
		(error) =>
			error instanceof core.WorkflowExecutorUnavailableError &&
			/executor "nope" from run flag is unknown/.test(error.message),
	);
	assert.deepEqual(probeLog(log), []);
});

test("host default: Claude Code → claude, Codex → codex, Pi → pi, without a probe", async () => {
	const log = shadowBuiltins(
		{ pi: NOT_INSTALLED, claude: NOT_INSTALLED, codex: NOT_INSTALLED },
		"host",
	);
	for (const [host, id] of [
		["claude-code", "claude"],
		["codex", "codex"],
		["pi", "pi"],
	]) {
		const selection = await core.resolveRunExecutorForHost({ host });
		assert.deepEqual(
			[selection.id, selection.source, selection.host],
			[id, "host-default", host],
		);
		assert.equal(selection.candidates, undefined);
		assert.equal(selection.descriptor.id, id);
	}
	assert.deepEqual(probeLog(log), []);
	assert.deepEqual(core.HOST_DEFAULT_EXECUTORS, {
		"claude-code": "claude",
		codex: "codex",
		pi: "pi",
	});
	assert.deepEqual(
		[...core.WORKFLOW_HOST_IDS],
		["claude-code", "codex", "pi", "cli", "generic"],
	);
});

test("generic MCP host (no own CLI) uses the terminal installed order", async () => {
	const log = shadowBuiltins(
		{ pi: NOT_INSTALLED, claude: READY, codex: READY },
		"generic-host",
	);
	try {
		const selection = await core.resolveRunExecutorForHost({ host: "generic" });
		assert.deepEqual(
			[selection.id, selection.source, selection.host],
			["claude", "installed-default", "generic"],
		);
		assert.deepEqual(probeLog(log), ["pi", "claude"]);
	} finally {
		for (const undo of unregister.splice(0).reverse()) undo();
		core.resetExecutorProbeCacheForTests();
	}
});

test("terminal CLI: first installed and logged-in of pi → claude → codex; unknown auth is usable and recorded", async (t) => {
	const cases = [
		{
			name: "pi ready",
			probes: { pi: READY, claude: READY, codex: READY },
			expect: "pi",
			probed: ["pi"],
		},
		{
			name: "pi missing",
			probes: { pi: NOT_INSTALLED, claude: READY, codex: READY },
			expect: "claude",
			probed: ["pi", "claude"],
		},
		{
			name: "pi logged out, claude expired",
			probes: { pi: MISSING_AUTH, claude: EXPIRED, codex: READY },
			expect: "codex",
			probed: ["pi", "claude", "codex"],
		},
		{
			name: "pi auth unknown",
			probes: { pi: UNKNOWN, claude: READY, codex: READY },
			expect: "pi",
			probed: ["pi"],
		},
	];
	for (const item of cases)
		await t.test(item.name, async () => {
			const log = shadowBuiltins(item.probes, item.name.replace(/\W+/g, "-"));
			try {
				const selection = await core.resolveRunExecutorForHost({
					host: "cli",
				});
				assert.deepEqual(
					[selection.id, selection.source, selection.host],
					[item.expect, "installed-default", "cli"],
				);
				assert.deepEqual(probeLog(log), item.probed);
				assert.deepEqual(
					selection.candidates.map((candidate) => candidate.id),
					item.probed,
				);
				const chosen = selection.candidates.at(-1);
				assert.equal(chosen.usable, true);
				assert.equal(chosen.auth, item.probes[item.expect].auth);
				for (const skipped of selection.candidates.slice(0, -1))
					assert.equal(skipped.usable, false);
			} finally {
				for (const undo of unregister.splice(0).reverse()) undo();
				core.resetExecutorProbeCacheForTests();
			}
		});
	// No host behaves like the terminal CLI (library callers) but records no host.
	shadowBuiltins({ pi: NOT_INSTALLED, claude: READY, codex: READY }, "nohost");
	const selection = await core.resolveRunExecutorForHost({});
	assert.deepEqual(
		[selection.id, selection.source, selection.host],
		["claude", "installed-default", undefined],
	);
});

test("a probe that throws or hangs counts as not usable", async () => {
	shadowBuiltins({ pi: READY, claude: READY, codex: READY }, "throwing");
	const selection = await core.resolveRunExecutorForHost({
		host: "cli",
		probeTimeoutMs: 50,
		prober: async (descriptor) => {
			if (descriptor.id === "pi") throw new Error("spawn pi ENOENT");
			if (descriptor.id === "claude") return new Promise(() => undefined);
			return {
				probe: READY,
				capabilities: {},
			};
		},
	});
	assert.equal(selection.id, "codex");
	const readiness = await core.probeExecutorReadiness("pi", {
		prober: async () => {
			throw new Error("spawn pi ENOENT");
		},
	});
	assert.equal(readiness.state, "probe-failed");
	assert.equal(
		core.readinessFixHint(readiness),
		"install: see docs/usage.md#executors, check with `pi --version`",
	);
});

test("nothing usable: the run fails before any record, naming each CLI's state and the fix commands", async () => {
	const log = shadowBuiltins(
		{ pi: NOT_INSTALLED, claude: MISSING_AUTH, codex: EXPIRED },
		"none",
	);
	const { cwd, specPath } = await project("none");
	let message = "";
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, { task: "t", host: "cli" }),
		(error) => {
			message = error.message;
			return (
				error instanceof core.WorkflowExecutorUnavailableError &&
				error.source === "installed-default"
			);
		},
	);
	assert.match(message, /^no executor is usable/);
	assert.match(message, /The run was not started\./);
	assert.match(
		message,
		/- pi: not installed; install: see docs\/usage\.md#executors, check with `pi --version`/,
	);
	assert.match(
		message,
		/- claude: installed \(1\.0\.0\), not logged in \(auth missing\); log in: run `claude auth login`/,
	);
	assert.match(
		message,
		/- codex: installed \(1\.0\.0\), not logged in \(auth expired\); log in: run `codex login`/,
	);
	assert.match(message, /--executor <id>/);
	assert.deepEqual(probeLog(log), ["pi", "claude", "codex"]);
	assert.equal(existsSync(join(cwd, ".agent-workflow", "workflows")), false);
	assert.equal(
		existsSync(join(cwd, ".agent-workflow", "workflow-subagents")),
		false,
	);
	// The Pi login hint is "run pi, then /login".
	assert.equal(core.executorSetupHints("pi").login, "run `pi`, then `/login`");
});

test("the chosen host CLI not installed: negotiation names the install command (first-run guidance)", async () => {
	shadowBuiltins({ pi: READY, claude: NOT_INSTALLED, codex: READY }, "guide");
	const { cwd, specPath } = await project("guide");
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, { task: "t", host: "claude-code" }),
		(error) =>
			error instanceof core.WorkflowCapabilityError &&
			error.code === "EXECUTOR_NOT_INSTALLED" &&
			/executor "claude" is not installed/.test(error.message) &&
			/install it: `npm i -g @anthropic-ai\/claude-code` \(see docs\/usage\.md#executors\)/.test(
				error.message,
			),
	);
	assert.equal(existsSync(join(cwd, ".agent-workflow", "workflows")), false);
});

test("engine records the rule and host; nested runs keep the parent's executor", async () => {
	const effectLog = join(root, "record-effects.jsonl");
	for (const [id, probe] of [
		["pi", NOT_INSTALLED],
		["claude", UNKNOWN],
		["codex", READY],
	])
		unregister.push(
			core.registerWorkflowExecutor(
				workflowFixtureDescriptor({ id, effectLog, probe }),
			),
		);
	const { cwd, specPath } = await project("record");
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		host: "cli",
	});
	assert.equal(started.executor.id, "claude");
	assert.equal(started.executor.source, "installed-default");
	assert.equal(started.executor.host, "cli");
	assert.deepEqual(
		started.executor.candidates.map((candidate) => [
			candidate.id,
			candidate.installed,
			candidate.auth,
			candidate.usable,
		]),
		[
			["pi", false, "unknown", false],
			["claude", true, "unknown", true],
		],
	);
	assert.equal(started.capabilityNegotiation.probe.auth, "unknown");
	const parent = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(parent.status, "completed", JSON.stringify(parent.tasks));

	// Host default recorded for a host run.
	const hosted = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t2",
		host: "codex",
	});
	assert.deepEqual(
		[hosted.executor.id, hosted.executor.source, hosted.executor.host],
		["codex", "host-default", "codex"],
	);
	await engine.waitForRun(cwd, hosted.runId, 60_000);

	// A nested run follows its parent's executor, whatever its own host would choose.
	const child = await engine.runWorkflowSpec(specPath, cwd, {
		task: "child",
		parentRunId: parent.runId,
		host: "codex",
	});
	assert.equal(child.executor.id, "claude");
	assert.equal(child.executor.source, "installed-default");
	assert.equal(child.executor.host, "cli");
	await engine.waitForRun(cwd, child.runId, 60_000);
});

test("cachedExecutorProber reuses a usable probe for a short time and never caches an unusable one", async () => {
	let now = 1_000_000;
	core.resetExecutorProbeCacheForTests(() => now);
	const log = shadowBuiltins({ pi: READY, claude: MISSING_AUTH }, "cache");
	const pi = core.workflowExecutorRegistration("pi").descriptor;
	const claude = core.workflowExecutorRegistration("claude").descriptor;
	await core.cachedExecutorProber(pi);
	await core.cachedExecutorProber(pi);
	await core.cachedExecutorProber(claude);
	await core.cachedExecutorProber(claude);
	assert.deepEqual(probeLog(log), ["pi", "claude", "claude"]);
	now += core.EXECUTOR_PROBE_CACHE_TTL_MS + 1;
	await core.cachedExecutorProber(pi);
	assert.deepEqual(probeLog(log), ["pi", "claude", "claude", "pi"]);
});

test("one engine run probes the default executor once: selection and negotiation share the cache", async () => {
	const log = shadowBuiltins({ pi: READY }, "shared");
	const { cwd, specPath } = await project("shared");
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		host: "cli",
	});
	assert.deepEqual(
		[started.executor.id, started.executor.source],
		["pi", "installed-default"],
	);
	// Only the engine probes (workers never call probe()).
	assert.deepEqual(probeLog(log), ["pi"]);
	await engine.waitForRun(cwd, started.runId, 60_000).catch(() => undefined);
});
