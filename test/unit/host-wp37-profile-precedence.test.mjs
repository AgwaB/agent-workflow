// New in agent-workflow (WP37 item 4, parity §3.2 "saved vs declared profiles", B2 interpretation):
// a workflow-declared profile no longer replaces the saved user profile as a whole. The precedence
// run flag > workflow profile > saved user profile > default applies field by field: a declared
// profile that omits `executor` (or a permission mode, or strictCapabilities) inherits the default
// saved profile's value; the saved model/effort stay run defaults for the saved profile's executor.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp37-profiles-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const BASE = {
	schemaVersion: 1,
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

async function project(spec) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		`${JSON.stringify({ ...BASE, name: `wp37-profiles-${counter}`, ...spec }, null, 2)}\n`,
	);
	return {
		cwd,
		ctx: {
			cwd,
			env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		},
	};
}

function fixture(config = {}) {
	counter += 1;
	const id = `wp37-profile-exec-${counter}`;
	const effectLog = join(root, `${id}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ ...config, id, effectLog }),
		),
	);
	return { id, effectLog };
}

const submits = (effectLog) =>
	readFixtureLog(effectLog).filter((entry) => entry.type === "submit");

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

async function saveDefault(ctx, values) {
	await api.profileAction(ctx, {
		op: "set",
		name: "mine",
		values,
		makeDefault: true,
	});
}

test("a declared profile without an executor inherits the default saved profile's executor, mode and effort", async () => {
	const userExec = fixture();
	const { ctx } = await project({ executionProfiles: { declared: {} } });
	await saveDefault(ctx, {
		executor: userExec.id,
		permissionMode: "safe",
		effort: "low",
	});
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "explicit declared profile",
		profile: "declared",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.deepEqual(launched.data.executor, {
		id: userExec.id,
		source: "user-profile",
		profile: "mine",
	});
	assert.deepEqual(launched.data.permissionMode, {
		mode: "safe",
		source: "user-profile",
		profile: "mine",
	});
	assert.equal(launched.data.profile.name, "declared");
	assert.equal(launched.data.profile.kind, "declared");
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	const [submit] = submits(userExec.effectLog);
	assert.equal(submit.effort, "low");
	assert.equal(submit.permissionMode, "safe");
});

test("the workflow's default declared profile inherits the saved executor too (no --profile)", async () => {
	const userExec = fixture();
	const { ctx } = await project({
		executionProfiles: { quick: {} },
		defaultExecutionProfile: "quick",
	});
	await saveDefault(ctx, { executor: userExec.id });
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "default declared profile",
	});
	assert.equal(launched.outcome, "running", launched.text);
	assert.equal(launched.data.profile.name, "quick");
	assert.deepEqual(launched.data.executor, {
		id: userExec.id,
		source: "user-profile",
		profile: "mine",
	});
	assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	assert.equal(submits(userExec.effectLog).length, 1);
});

test("field by field: the declared executor and mode win where set, the saved fields fill the rest", async () => {
	const declaredExec = fixture();
	const userExec = fixture();
	const flagExec = fixture();
	const { ctx } = await project({
		executionProfiles: { declared: {}, freeProfile: {} },
		executionProfileExecutors: {
			declared: declaredExec.id,
			freeProfile: declaredExec.id,
		},
		executionProfilePermissionModes: { freeProfile: "free" },
	});
	await saveDefault(ctx, {
		executor: userExec.id,
		permissionMode: "safe",
		effort: "low",
	});
	const declared = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "declared executor, saved mode",
		profile: "declared",
	});
	assert.deepEqual(declared.data.executor, {
		id: declaredExec.id,
		source: "workflow-profile",
		profile: "declared",
	});
	assert.deepEqual(declared.data.permissionMode, {
		mode: "safe",
		source: "user-profile",
		profile: "mine",
	});
	const freeProfile = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "declared executor and mode",
		profile: "freeProfile",
	});
	assert.deepEqual(freeProfile.data.permissionMode, {
		mode: "free",
		source: "workflow-profile",
		profile: "freeProfile",
	});
	const flagged = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "run flags win",
		profile: "declared",
		executor: flagExec.id,
		permissionMode: "free",
	});
	assert.deepEqual(flagged.data.executor, {
		id: flagExec.id,
		source: "run-flag",
	});
	assert.deepEqual(flagged.data.permissionMode, {
		mode: "free",
		source: "run-flag",
	});
	for (const launched of [declared, freeProfile, flagged])
		assert.equal((await settle(ctx, launched.data.runId)).outcome, "completed");
	// The saved effort belongs to the saved profile's executor; another executor does not get it.
	for (const submit of submits(declaredExec.effectLog))
		assert.equal(submit.effort, null);
	assert.equal(submits(flagExec.effectLog)[0].effort, null);
	assert.equal(submits(userExec.effectLog).length, 0);
});

test("a declared profile without strictCapabilities inherits the saved profile's", async () => {
	const strictExec = fixture({
		capabilities: {
			readOnly: { level: "emulated", source: "declared" },
		},
	});
	const { ctx } = await project({
		executionProfiles: { declared: {}, lenient: {} },
		executionProfileStrictCapabilities: { lenient: [] },
	});
	await saveDefault(ctx, {
		executor: strictExec.id,
		permissionMode: "safe",
		strictCapabilities: ["readOnly"],
	});
	const refused = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "inherited strict",
		profile: "declared",
	});
	assert.equal(refused.outcome, "refused", refused.text);
	assert.match(refused.text, /CAPABILITY_STRICT:readOnly/u);
	// A declared entry (even an empty list) is the workflow profile's own value and wins.
	const lenient = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "declared strict list",
		profile: "lenient",
	});
	assert.equal(lenient.outcome, "running", lenient.text);
	assert.equal((await settle(ctx, lenient.data.runId)).outcome, "completed");
});
