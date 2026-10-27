// New in agent-workflow (WP16): the duplicate-launch guard for detached (and attached) launches,
// through every caller of the host API: the handlers, the `agent-workflow` CLI, the Pi `aw_run`
// tool and the host MCP server's `workflow_run`. An identical launch while the first run is active
// returns that run (`outcome: "existing"`); different inputs, `forceNew` or a terminal first run
// start a new one; concurrent identical launches yield one run. Runs use the guarded test-executor
// hook (also inside the detached supervisors, AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR=1 keeps
// them in this process group); every run is stopped and every supervisor killed in `after`.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";

const HOOK_MODULE = fileURLToPath(
	new URL("../helpers/host-test-executor.mjs", import.meta.url),
);
const EXECUTOR = "test-wp16-guard";
const hookRoot = await realpath(await mkdtemp(join(tmpdir(), "aw-wp16-hook-")));
// The hook module reads its config when imported (in this process and in each supervisor).
process.env.AW_HOST_TEST_EFFECT_LOG = join(hookRoot, "effects.jsonl");
process.env.AW_HOST_TEST_EXECUTOR_ID = EXECUTOR;
process.env.AW_HOST_TEST_EXECUTOR_CONFIG = JSON.stringify({
	stepDelayMs: 1_500,
});

const api = await import("../../dist/hosts/api.js");
const cli = await import("../../dist/hosts/cli/index.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const launchedRuns = [];
const supervisorPids = new Set();
const clients = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp16-guard",
	input: { depth: "standard" },
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp16-guard-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});

after(async () => {
	for (const client of clients.splice(0))
		await client.close().catch(() => undefined);
	for (const { ctx, runId } of launchedRuns)
		await api.stopAction(ctx, { runId }).catch(() => undefined);
	for (const pid of supervisorPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	await new Promise((done) => setTimeout(done, 200));
	for (const dir of [root, hookRoot])
		await rm(dir, {
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
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC, null, 2)}\n`);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		AGENT_WORKFLOW_TEST_EXECUTOR_MODULE: HOOK_MODULE,
		AGENT_WORKFLOW_TEST_EXECUTOR_ACK: "test-only",
		AGENT_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR: "1",
	};
	await api.registerTestExecutorFromEnv(env);
	return { cwd, env, ctx: { cwd, env } };
}

function remember(ctx, data) {
	if (data?.runId) launchedRuns.push({ ctx, runId: data.runId });
	if (data?.detached?.pid) supervisorPids.add(data.detached.pid);
}

function runDirs(cwd) {
	return readdirSync(join(cwd, ".agent-workflow", "workflows")).filter((name) =>
		name.startsWith("workflow_"),
	);
}

async function settle(ctx, runId) {
	let waited;
	do waited = await api.waitAction(ctx, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
	return waited;
}

const base = (extra = {}) => ({
	workflow: "wf.json",
	task: "guarded task",
	executor: EXECUTOR,
	detach: true,
	...extra,
});

test("host API: identical detached launches → one run (existing); different inputs, forceNew, terminal → new runs", async () => {
	const { cwd, ctx } = await project();
	const first = await api.runWorkflowAction(ctx, base());
	remember(ctx, first.data);
	assert.equal(first.outcome, "running", first.text);
	assert.equal(typeof first.data.detached?.pid, "number");

	const retry = await api.runWorkflowAction(ctx, base());
	remember(ctx, retry.data);
	assert.equal(retry.outcome, "existing", retry.text);
	assert.equal(retry.ok, true);
	assert.equal(retry.data.runId, first.data.runId);
	assert.equal(retry.data.duplicateOf, first.data.runId);
	assert.equal(retry.data.detached, undefined, "no second supervisor");
	assert.match(retry.text, /^Duplicate launch guard: run workflow_/);
	assert.match(retry.text, /--force-new/);
	// detach is not part of the launch identity: an attached retry finds the same run.
	const attached = await api.runWorkflowAction(ctx, base({ detach: false }));
	assert.equal(attached.outcome, "existing");
	assert.equal(attached.data.runId, first.data.runId);
	assert.equal(runDirs(cwd).length, 1);

	const otherInputs = await api.runWorkflowAction(
		ctx,
		base({ inputOverrides: { depth: "quick" } }),
	);
	remember(ctx, otherInputs.data);
	assert.equal(otherInputs.outcome, "running");
	assert.notEqual(otherInputs.data.runId, first.data.runId);
	for (const variant of [
		{ task: "another task" },
		{ permissionMode: "safe" },
		{ effort: "low" },
	]) {
		const launched = await api.runWorkflowAction(ctx, base(variant));
		remember(ctx, launched.data);
		assert.equal(launched.outcome, "running", JSON.stringify(variant));
	}

	const forced = await api.runWorkflowAction(ctx, base({ forceNew: true }));
	remember(ctx, forced.data);
	assert.equal(forced.outcome, "running");
	assert.notEqual(forced.data.runId, first.data.runId);
	// The newest identical run is the one a later retry finds.
	const afterForced = await api.runWorkflowAction(ctx, base());
	assert.equal(afterForced.outcome, "existing");
	assert.equal(afterForced.data.runId, forced.data.runId);
	assert.equal(runDirs(cwd).length, 6);

	// Terminal first runs: a new identical launch starts a new run.
	for (const runId of [first.data.runId, forced.data.runId])
		assert.equal((await settle(ctx, runId)).data.terminal, true);
	const fresh = await api.runWorkflowAction(ctx, base());
	remember(ctx, fresh.data);
	assert.equal(fresh.outcome, "running", fresh.text);
	assert.ok(![first.data.runId, forced.data.runId].includes(fresh.data.runId));
	await settle(ctx, fresh.data.runId);
});

test("host API: concurrent identical launches (a retry racing the first call) start one run", async () => {
	const { cwd, ctx } = await project();
	const results = await Promise.all(
		[0, 1, 2].map(() =>
			api.runWorkflowAction(ctx, base({ task: "racing task" })),
		),
	);
	for (const launched of results) remember(ctx, launched.data);
	const runIds = new Set(results.map((launched) => launched.data.runId));
	assert.equal(runIds.size, 1, JSON.stringify(results.map((r) => r.outcome)));
	assert.deepEqual(results.map((launched) => launched.outcome).sort(), [
		"existing",
		"existing",
		"running",
	]);
	assert.equal(runDirs(cwd).length, 1);
	await settle(ctx, [...runIds][0]);
});

test("CLI: run --detach twice → the second prints the existing run (exit 0); --force-new starts another", async () => {
	const { cwd, env, ctx } = await project();
	const io = (out) => ({
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: () => undefined,
		isTTY: false,
	});
	const argv = [
		"run",
		"wf.json",
		"cli task",
		"--executor",
		EXECUTOR,
		"--detach",
		"--json",
	];
	const outs = [[], [], []];
	assert.equal(await cli.runAgentWorkflowCli(argv, io(outs[0])), 0);
	assert.equal(await cli.runAgentWorkflowCli(argv, io(outs[1])), 0);
	assert.equal(
		await cli.runAgentWorkflowCli([...argv, "--force-new"], io(outs[2])),
		0,
	);
	const [first, second, forced] = outs.map((out) => JSON.parse(out.join("")));
	for (const launched of [first, second, forced]) remember(ctx, launched.data);
	assert.equal(first.outcome, "running");
	assert.equal(second.outcome, "existing");
	assert.equal(second.ok, true);
	assert.equal(second.data.runId, first.data.runId);
	assert.equal(forced.outcome, "running");
	assert.notEqual(forced.data.runId, first.data.runId);
	assert.equal(runDirs(cwd).length, 2);
	await settle(ctx, first.data.runId);
	await settle(ctx, forced.data.runId);
});

test("Pi aw_run tool: a detached retry returns the existing run (not an error); forceNew starts another", async () => {
	const { cwd, env, ctx } = await project();
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env })(pi);
	const tool = pi.tools.get("aw_run");
	const piCtx = fakeCtx(cwd, { hasUI: false });
	const params = {
		workflow: "wf.json",
		task: "pi task",
		executor: EXECUTOR,
		detach: true,
	};
	const first = await tool.execute("1", params, undefined, undefined, piCtx);
	const retry = await tool.execute("2", params, undefined, undefined, piCtx);
	const forced = await tool.execute(
		"3",
		{ ...params, forceNew: true },
		undefined,
		undefined,
		piCtx,
	);
	for (const launched of [first, retry, forced])
		remember(ctx, launched.details);
	assert.equal(first.details.outcome, "running");
	assert.equal(retry.details.outcome, "existing");
	assert.equal(retry.details.ok, true);
	assert.equal(retry.isError, undefined);
	assert.equal(retry.details.runId, first.details.runId);
	assert.match(retry.content[0].text, /Duplicate launch guard/);
	assert.match(retry.details.waitWith, /^aw_wait /);
	assert.equal(forced.details.outcome, "running");
	assert.notEqual(forced.details.runId, first.details.runId);
	assert.equal(runDirs(cwd).length, 2);
	await settle(ctx, first.details.runId);
	await settle(ctx, forced.details.runId);
});

test("host MCP server workflow_run (detached by default): a retry returns the existing run; forceNew starts another", async () => {
	const { cwd, env, ctx } = await project();
	const client = await inProcessHostServer({ root: cwd, env });
	clients.push(client);
	const init = await client.initialize();
	assert.equal(init.error, undefined, JSON.stringify(init));
	const params = { workflow: "wf.json", task: "mcp task", executor: EXECUTOR };
	const first = await client.call("workflow_run", params);
	const retry = await client.call("workflow_run", params);
	const forced = await client.call("workflow_run", {
		...params,
		forceNew: true,
	});
	for (const launched of [first, retry, forced])
		remember(ctx, launched.structuredContent.data);
	assert.equal(first.structuredContent.outcome, "running");
	assert.equal(retry.isError, false);
	assert.equal(retry.structuredContent.outcome, "existing");
	assert.equal(
		retry.structuredContent.data.runId,
		first.structuredContent.data.runId,
	);
	assert.equal(forced.structuredContent.outcome, "running");
	assert.notEqual(
		forced.structuredContent.data.runId,
		first.structuredContent.data.runId,
	);
	assert.equal(runDirs(cwd).length, 2);
	await settle(ctx, first.structuredContent.data.runId);
	await settle(ctx, forced.structuredContent.data.runId);
});
