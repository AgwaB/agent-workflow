// New in agent-workflow (WP4d): B4 capability negotiation in the engine before launch. Workflows run
// through the real engine with the fixture executor (test/helpers/workflow-executor-fixture.mjs)
// whose capability table and probe each test controls. No model or agent-CLI calls.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const profiles = await import("../../dist/core/execution-profile.js");
const { fakeCapabilities } = await import("../../dist/sdk/testing/index.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp4d-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	// A supervisor finishing its last write can still create a file meanwhile (ENOTEMPTY).
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

let counter = 0;
async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
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
		join(cwd, ".agent-workflow", "agents", "writer.md"),
		[
			"---",
			"name: writer",
			"description: reads and runs commands",
			"tools: read, bash",
			"---",
			"You read, run commands and report.",
			"",
		].join("\n"),
	);
	return cwd;
}

const ONE_STAGE = {
	schemaVersion: 1,
	name: "wp4d-one-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

async function writeSpec(cwd, spec) {
	const path = join(cwd, "workflow.json");
	await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`);
	return path;
}

/** Register a fixture executor with a controlled capability table / probe. */
function fixture(config = {}) {
	counter += 1;
	const id = config.id ?? `wf-wp4d-${counter}`;
	const effectLog = join(root, `${id}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ ...config, id, effectLog }),
		),
	);
	return { id, effectLog };
}

function submits(effectLog) {
	return readFixtureLog(effectLog).filter((entry) => entry.type === "submit");
}

function assertNothingStarted(cwd, effectLog) {
	const runs = join(cwd, ".agent-workflow", "workflows");
	assert.equal(
		existsSync(runs) && readdirSync(runs).length > 0,
		false,
		"no run record may exist",
	);
	assert.equal(
		existsSync(join(cwd, ".agent-workflow", "workflow-subagents")),
		false,
	);
	if (effectLog !== undefined) assert.deepEqual(submits(effectLog), []);
}

async function persisted(cwd, runId) {
	return JSON.parse(
		await readFile(
			join(cwd, ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
}

const warned = (warning) => ({ level: "emulated", source: "probed", warning });

function capabilityError(code, pattern) {
	return (error) => {
		assert.ok(
			error instanceof core.WorkflowCapabilityError,
			`expected WorkflowCapabilityError, got ${error?.stack ?? error}`,
		);
		assert.equal(error.code, code, error.message);
		if (pattern !== undefined) assert.match(error.message, pattern);
		return true;
	};
}

test("refusal before launch: missing required capability names stage, capability and code", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: { readOnly: { level: "none", source: "declared" } },
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, { task: "t", executor: id }),
		capabilityError(
			"CAPABILITY_REFUSED",
			/stage "a.main": readOnly — CAPABILITY_MISSING:readOnly \(executor has none\/declared\); no opt-in exists/,
		),
	);
	assertNothingStarted(cwd, effectLog);
});

test("refusal before launch: unverified without opt-in; the opt-in runs and records it", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: {
			contextIsolation: { level: "native", source: "unverified" },
		},
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, { task: "t", executor: id }),
		capabilityError(
			"CAPABILITY_REFUSED",
			/CAPABILITY_UNVERIFIED:contextIsolation.*allowUnverifiedCapabilities: \["contextIsolation"\]/,
		),
	);
	assertNothingStarted(cwd, effectLog);

	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		allowUnverifiedCapabilities: ["contextIsolation"],
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed");
	const record = (await persisted(cwd, run.runId)).capabilityNegotiation;
	assert.deepEqual(record.policy.allowUnverified, ["contextIsolation"]);
	const isolation = record.stages[0].report.entries.find(
		(entry) => entry.key === "contextIsolation",
	);
	assert.equal(isolation.outcome, "native");
	assert.equal(isolation.note, "unverified capability used by user opt-in");
	assert.equal(submits(effectLog).length, 1);
});

test("refusal before launch: strict profile + emulated (declared profile and saved user profile)", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: { readOnly: { level: "emulated", source: "declared" } },
	});
	const spec = {
		...ONE_STAGE,
		executionProfiles: { strict: {} },
		executionProfileStrictCapabilities: { strict: ["readOnly"] },
	};
	const specPath = await writeSpec(cwd, spec);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			executionProfile: "strict",
		}),
		capabilityError(
			"CAPABILITY_REFUSED",
			/stage "a.main": readOnly — CAPABILITY_STRICT:readOnly.*strictCapabilities/,
		),
	);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			executionProfileOverride: {
				name: "mine",
				strictCapabilities: ["readOnly"],
				definitionFingerprint: profiles.workflowDefinitionFingerprint(spec),
				stageOverrides: {},
			},
		}),
		capabilityError("CAPABILITY_REFUSED", /CAPABILITY_STRICT:readOnly/),
	);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			executionProfileOverride: {
				name: "mine",
				strictCapabilities: ["warpDrive"],
				definitionFingerprint: profiles.workflowDefinitionFingerprint(spec),
				stageOverrides: {},
			},
		}),
		/saved user profile "mine" strictCapabilities unknown capability "warpDrive"/,
	);
	assertNothingStarted(cwd, effectLog);
});

test("spec validation: executionProfileStrictCapabilities and allowReadOnlyDowngrade", async () => {
	const cwd = await project();
	const { id } = fixture();
	const bad = await writeSpec(cwd, {
		...ONE_STAGE,
		executionProfiles: { strict: {} },
		executionProfileStrictCapabilities: { strict: ["nope"], other: [] },
		allowReadOnlyDowngrade: "yes",
	});
	await assert.rejects(
		engine.runWorkflowSpec(bad, cwd, { task: "t", executor: id }),
		(error) =>
			/executionProfileStrictCapabilities\.strict/.test(error.message) &&
			/unknown execution profile "other"/.test(error.message) &&
			/allowReadOnlyDowngrade/.test(error.message),
	);
});

test("degradation (environment warning) is recorded with a preview; non-interactive never calls the hook", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: { readOnly: warned("3 allow rules let commands run") },
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	let calls = 0;
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		// WP4e: B4 confirmation/strict rules for environment warnings are safe-mode behavior.
		permissionMode: "safe",
		confirmDegradations: async () => {
			calls += 1;
			return false;
		},
	});
	assert.equal(calls, 0);
	const negotiation = started.capabilityNegotiation;
	assert.equal(negotiation.confirmation, "non-interactive");
	assert.deepEqual(negotiation.degradations, [
		"a.main: CAPABILITY_WARNING:readOnly",
	]);
	assert.match(
		negotiation.preview,
		/^Capability check \(wf-wp4d-\d+@0\.1\.0, 1 stage, permission mode: safe\): accepted with 1 degradation/,
	);
	assert.match(negotiation.preview, /readOnly: degraded.*3 allow rules/);
	assert.equal(negotiation.probe.installed, true);
	assert.equal(negotiation.probe.auth, "ok");
	assert.equal(
		negotiation.capabilities.readOnly.warning,
		"3 allow rules let commands run",
	);
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed");
	assert.deepEqual(
		(await persisted(cwd, run.runId)).capabilityNegotiation.degradations,
		["a.main: CAPABILITY_WARNING:readOnly"],
	);
	assert.equal(submits(effectLog).length, 1);
});

test("no warning: an emulated capability passes silently, even on an interactive host", async () => {
	const cwd = await project();
	const { id } = fixture({
		capabilities: { readOnly: { level: "emulated", source: "declared" } },
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		interactive: true,
	});
	assert.equal(started.capabilityNegotiation.confirmation, "not-needed");
	assert.deepEqual(started.capabilityNegotiation.degradations, []);
	const entry = started.capabilityNegotiation.stages[0].report.entries.find(
		(item) => item.key === "readOnly",
	);
	assert.equal(entry.outcome, "emulated");
	await engine.waitForRun(cwd, started.runId, 60_000);
});

test("interactive confirmation: accepted proceeds, declined and missing hook fail before launch", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: { contextIsolation: warned("global AGENTS.md loaded") },
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			permissionMode: "safe",
			interactive: true,
			confirmDegradations: async () => false,
		}),
		capabilityError(
			"CAPABILITY_DEGRADATION_DECLINED",
			/a\.main: CAPABILITY_WARNING:contextIsolation/,
		),
	);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: id,
			permissionMode: "safe",
			interactive: true,
		}),
		capabilityError("CAPABILITY_CONFIRMATION_REQUIRED"),
	);
	assertNothingStarted(cwd, effectLog);

	const seen = [];
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		permissionMode: "safe",
		interactive: true,
		confirmDegradations: async (preview) => {
			seen.push(preview);
			return true;
		},
	});
	assert.equal(seen.length, 1);
	assert.equal(seen[0].needsConfirmation, true);
	assert.match(seen[0].text, /global AGENTS\.md loaded/);
	assert.equal(started.capabilityNegotiation.confirmation, "confirmed");
	assert.equal(started.capabilityNegotiation.policy.interactive, true);
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed");
	assert.equal(submits(effectLog).length, 1);
});

test("forcedReadOnly: coarse allowlist + spec allowReadOnlyDowngrade launches readOnly; without the flag it refuses", async () => {
	const cwd = await project();
	const { id, effectLog } = fixture({
		capabilities: {
			toolAllowlist: { level: "native", source: "declared", detail: "coarse" },
		},
	});
	const writable = {
		...ONE_STAGE,
		defaults: {
			agent: "writer",
			readOnly: false,
			tools: ["read", "bash"],
			worktreePolicy: "off",
		},
	};
	const refusedPath = await writeSpec(cwd, writable);
	await assert.rejects(
		engine.runWorkflowSpec(refusedPath, cwd, {
			task: "t",
			executor: id,
			// WP4e: the B4 coarse-allowlist refusal is safe-mode behavior.
			permissionMode: "safe",
			allowSharedCheckoutWrites: true,
		}),
		capabilityError(
			"CAPABILITY_REFUSED",
			/CAPABILITY_MISSING:toolAllowlist\.fine.*"allowReadOnlyDowngrade": true/,
		),
	);
	assertNothingStarted(cwd, effectLog);

	const specPath = await writeSpec(cwd, {
		...writable,
		allowReadOnlyDowngrade: true,
	});
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
		permissionMode: "safe",
		allowSharedCheckoutWrites: true,
	});
	assert.deepEqual(started.capabilityNegotiation.forcedReadOnly, ["a.main"]);
	assert.match(
		started.capabilityNegotiation.preview,
		/forced readOnly: a\.main/,
	);
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	const [submit] = submits(effectLog);
	assert.equal(submit.readOnly, true);
	assert.ok(!submit.approvalAllowKinds.includes("execute"));
});

test("probe failure fails before launch: not installed, not logged in (login command named), timeout", async () => {
	const cwd = await project();
	const notInstalled = fixture({
		probe: {
			installed: false,
			cliVersion: null,
			auth: "unknown",
			notes: ["fake --version failed"],
		},
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: notInstalled.id,
		}),
		capabilityError(
			"EXECUTOR_NOT_INSTALLED",
			new RegExp(
				`executor "${notInstalled.id}" is not installed.*fake --version failed`,
			),
		),
	);
	const loggedOut = fixture({
		probe: { installed: true, cliVersion: "1.0.0", auth: "expired" },
	});
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: loggedOut.id,
		}),
		capabilityError("EXECUTOR_AUTH_NOT_READY", /auth expired/),
	);
	// Injected prober for a built-in id: the message names that CLI's login command.
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: "codex",
			executorProber: async (descriptor) => {
				assert.equal(descriptor.id, "codex");
				return {
					probe: { installed: true, cliVersion: "0.159.2", auth: "missing" },
					capabilities: fakeCapabilities(),
				};
			},
		}),
		capabilityError(
			"EXECUTOR_AUTH_NOT_READY",
			/executor "codex" is not logged in \(auth missing\); run `codex login`/,
		),
	);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, {
			task: "t",
			executor: "claude",
			executorProbeTimeoutMs: 50,
			executorProber: () => new Promise(() => undefined),
		}),
		capabilityError(
			"EXECUTOR_PROBE_FAILED",
			/executor "claude" probe did not finish within 50 ms/,
		),
	);
	assertNothingStarted(cwd);
	assert.deepEqual(submits(notInstalled.effectLog), []);
	assert.deepEqual(submits(loggedOut.effectLog), []);
});

test("probed rows are merged over the declared table and recorded as probed", async () => {
	const cwd = await project();
	const { id } = fixture({
		probe: {
			installed: true,
			cliVersion: "fake-cli 2.0.0",
			auth: "unknown",
			notes: ["auth: unknown"],
			capabilities: {
				readOnly: { level: "emulated", warning: "probe says so" },
			},
		},
	});
	const specPath = await writeSpec(cwd, ONE_STAGE);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	const negotiation = started.capabilityNegotiation;
	assert.deepEqual(negotiation.capabilities.readOnly, {
		source: "probed",
		level: "emulated",
		warning: "probe says so",
	});
	assert.equal(negotiation.probe.cliVersion, "fake-cli 2.0.0");
	assert.equal(negotiation.probe.auth, "unknown");
	assert.deepEqual(negotiation.probe.notes, ["auth: unknown"]);
	assert.deepEqual(negotiation.degradations, [
		"a.main: CAPABILITY_WARNING:readOnly",
	]);
	await engine.waitForRun(cwd, started.runId, 60_000);
});

test("launch-time check: runtime-generated tasks are negotiated from the record; refusal throws", () => {
	// SDK fake table: fastTier and webTools are none.
	const capabilities = fakeCapabilities();
	const run = {
		capabilityNegotiation: {
			executorId: "fake",
			executorVersion: "0.1.0",
			capabilities,
			policy: {
				interactive: true,
				allowUnverified: [],
				strict: [],
				allowReadOnlyDowngrade: false,
			},
			stages: [],
			degradations: [],
			forcedReadOnly: [],
		},
	};
	const task = (id, tools, extra = {}) => ({
		id,
		runtime: { tools, fast: "on" },
		safety: { capability: "read-only" },
		...extra,
	});
	const decision = core.workflowTaskCapabilityLaunch(
		run,
		task("gen-1", ["read"]),
	);
	assert.equal(decision.forcedReadOnly, false);
	assert.equal(run.capabilityNegotiation.stages.length, 1);
	assert.equal(run.capabilityNegotiation.stages[0].negotiatedAt, "launch");
	assert.deepEqual(run.capabilityNegotiation.degradations, [
		"gen-1: CAPABILITY_MISSING:fastTier",
	]);
	// Same task again: not appended twice; never asks for confirmation at launch.
	core.workflowTaskCapabilityLaunch(run, task("gen-1", ["read"]));
	assert.equal(run.capabilityNegotiation.stages.length, 1);
	assert.equal(
		run.capabilityNegotiation.stages[0].report.needsConfirmation,
		false,
	);
	assert.throws(
		() => core.workflowTaskCapabilityLaunch(run, task("web", ["web_search"])),
		capabilityError(
			"CAPABILITY_REFUSED",
			/refused task web before launch:\n {2}- stage "web": webTools — CAPABILITY_MISSING:webTools/,
		),
	);
	// Records created before WP4d and non-executor tasks are not checked.
	assert.deepEqual(
		core.workflowTaskCapabilityLaunch({}, task("x", ["web_search"])),
		{ forcedReadOnly: false },
	);
	assert.deepEqual(
		core.workflowTaskCapabilityLaunch(
			run,
			task("helper", ["web_search"], { support: { uses: "x" } }),
		),
		{ forcedReadOnly: false },
	);
});
