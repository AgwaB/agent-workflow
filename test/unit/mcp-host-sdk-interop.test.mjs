// New in agent-workflow (WP13): the built `agent-workflow` host MCP server in a child process
// against the official MCP TypeScript SDK client (@modelcontextprotocol/sdk, devDependency) over a
// real stdio transport, with the guarded WP11a test-executor hook (registers `test-fixture`; no model
// or agent-CLI calls): list → run (detached by default) → wait loop → inspect/status → stop, and
// degradation confirmation through the SDK's elicitation handler (accept and decline). WP28: the
// confirmed changes through the SDK's elicitation handler (accept, decline, no elicitation) and
// workflow_supervise picking up a run whose attached server process died.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
	HOST_SERVER,
	HOST_SERVER_BIN,
	hookEnv,
	killPid,
} from "../helpers/mcp-host-client.mjs";
import { trackProcess } from "../helpers/process-cleanup.mjs";

const hostServer = await import("../../dist/mcp/host-server/index.js");

const ONE_STAGE = {
	schemaVersion: 1,
	name: "mcp-host-sdk",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

let root;
let counter = 0;
const detachedPids = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-mcp-host-sdk-")));
});
after(async () => {
	for (const pid of detachedPids.splice(0)) await killPid(pid);
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

/** SDK client over a spawned server; closed (and the child killed) after the test. */
async function sdkClient(t, { cwd, config, capabilities, onElicit, command }) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [command ?? HOST_SERVER, "--host", "codex"],
		cwd,
		env: {
			...process.env,
			AGENT_WORKFLOW_HOME: join(cwd, "home"),
			...hookEnv(join(cwd, "effects.jsonl"), config),
		},
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = new Client(
		{ name: "aw-mcp-host-sdk", version: "0.0.0" },
		{ capabilities: capabilities ?? {} },
	);
	if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
	await client.connect(transport);
	trackProcess(transport.pid);
	t.after(async () => {
		await client.close().catch(() => undefined);
		const pid = transport.pid;
		if (pid) await killPid(pid);
	});
	return { client, stderr: () => stderr, pid: () => transport.pid };
}

async function call(client, name, args) {
	const result = await client.callTool({ name, arguments: args }, undefined, {
		timeout: 120_000,
	});
	return result;
}

async function waitUntilSettled(client, runId) {
	for (let index = 0; index < 60; index += 1) {
		const waited = await call(client, "workflow_wait", { runId });
		if (!waited.structuredContent.data.stillRunning) return waited;
	}
	throw new Error(`${runId} still running`);
}

test("official SDK client: list → run (detached by default) → wait loop → inspect, status, validate, stop", async (t) => {
	const cwd = await project();
	const { client, stderr } = await sdkClient(t, { cwd });
	assert.equal(client.getServerVersion()?.name, "agent-workflow");
	assert.deepEqual(client.getServerCapabilities(), {
		tools: { listChanged: false },
	});
	assert.equal(client.getInstructions(), hostServer.HOST_MCP_INSTRUCTIONS);
	const { tools } = await client.listTools();
	assert.deepEqual(
		tools.map((tool) => tool.name),
		hostServer.HOST_MCP_TOOLS.map((tool) => tool.name),
	);
	for (const tool of tools) {
		const expected = hostServer.HOST_MCP_TOOLS.find(
			(entry) => entry.name === tool.name,
		);
		assert.equal(tool.description, expected.description);
		assert.deepEqual(tool.inputSchema, expected.inputSchema);
	}

	const listed = await call(client, "workflow_list", { query: "deep-re" });
	assert.equal(listed.isError, false);
	assert.deepEqual(
		listed.structuredContent.data.workflows.map((row) => row.name).sort(),
		["deep-research", "deep-review"],
	);

	const validated = await call(client, "workflow_validate", {
		workflow: "wf.json",
	});
	assert.equal(validated.structuredContent.data.valid, true);

	const launched = await call(client, "workflow_run", {
		workflow: "wf.json",
		task: "collect facts over MCP",
		executor: "test-fixture",
	});
	assert.equal(launched.isError, false, launched.content[0].text);
	const launch = launched.structuredContent.data;
	assert.equal(launch.status, "running");
	assert.equal(launch.executor.id, "test-fixture");
	assert.equal(typeof launch.detached?.pid, "number", "detached by default");
	detachedPids.push(launch.detached.pid);
	trackProcess(launch.detached.pid);
	assert.match(stderr(), /test executor "test-fixture" registered/);

	const final = await waitUntilSettled(client, launch.runId);
	assert.equal(final.isError, false);
	assert.equal(final.structuredContent.outcome, "completed");
	assert.equal(final.structuredContent.data.terminal, true);
	assert.ok(Array.isArray(final.structuredContent.data.reportArtifacts));

	const inspected = await call(client, "workflow_inspect", {
		runId: launch.runId,
	});
	assert.equal(inspected.structuredContent.data.run.status, "completed");
	assert.equal(inspected.structuredContent.data.reliability.health, "clean");
	const status = await call(client, "workflow_status", {
		runId: launch.runId,
	});
	assert.equal(status.structuredContent.data.run.status, "completed");

	const slow = await sdkClient(t, { cwd, config: { stepDelayMs: 2_000 } });
	const slowRun = await call(slow.client, "workflow_run", {
		workflow: "wf.json",
		task: "slow facts",
		executor: "test-fixture",
	});
	const slowData = slowRun.structuredContent.data;
	detachedPids.push(slowData.detached.pid);
	trackProcess(slowData.detached.pid);
	const stopped = await call(slow.client, "workflow_stop", {
		runId: slowData.runId,
	});
	assert.equal(stopped.isError, false, stopped.content[0].text);
	const settled = await waitUntilSettled(slow.client, slowData.runId);
	assert.equal(settled.structuredContent.data.status, "interrupted");

	const usage = await call(client, "workflow_wait", {});
	assert.equal(usage.isError, true);
	assert.match(usage.content[0].text, /^Usage error: runId is required/);
});

test("official SDK client: elicitation accept and decline for a degraded safe-mode launch", async (t) => {
	const cwd = await project();
	const config = {
		capabilities: {
			contextIsolation: {
				level: "emulated",
				source: "probed",
				warning: "global AGENTS.md loaded",
			},
		},
	};
	const asked = [];
	let action = "accept";
	const { client } = await sdkClient(t, {
		cwd,
		config,
		capabilities: { elicitation: {} },
		onElicit: async (request) => {
			asked.push(request.params);
			return { action };
		},
	});
	const accepted = await call(client, "workflow_run", {
		workflow: "wf.json",
		task: "accepted",
		executor: "test-fixture",
		permissionMode: "safe",
	});
	assert.equal(accepted.isError, false, accepted.content[0].text);
	const data = accepted.structuredContent.data;
	detachedPids.push(data.detached?.pid);
	trackProcess(data.detached?.pid);
	assert.equal(data.capability.confirmation, "confirmed");
	assert.equal(asked.length, 1);
	assert.match(asked[0].message, /global AGENTS\.md loaded/);
	await waitUntilSettled(client, data.runId);

	action = "decline";
	const declined = await call(client, "workflow_run", {
		workflow: "wf.json",
		task: "declined",
		executor: "test-fixture",
		permissionMode: "safe",
	});
	assert.equal(declined.isError, true);
	assert.equal(
		declined.structuredContent.data.refusal.code,
		"CAPABILITY_DEGRADATION_DECLINED",
	);
	assert.equal(asked.length, 2);

	// Same launch from a client without elicitation (2026-11-04): nothing starts until the user
	// agrees in the conversation; then it starts, confirmed in chat. In free mode nothing needs an
	// OK, so nothing is asked.
	const headless = await sdkClient(t, { cwd, config });
	const unasked = await call(headless.client, "workflow_run", {
		workflow: "wf.json",
		task: "headless",
		executor: "test-fixture",
		permissionMode: "safe",
	});
	assert.equal(unasked.isError, true);
	assert.equal(
		unasked.structuredContent.data.refusal.code,
		"CAPABILITY_CONFIRMATION_REQUIRED",
	);
	const keys = JSON.parse(
		/acceptDegradations: (\[[^\]]*\])/.exec(unasked.content[0].text)[1],
	);
	const quiet = await call(headless.client, "workflow_run", {
		workflow: "wf.json",
		task: "headless",
		executor: "test-fixture",
		permissionMode: "safe",
		acceptDegradations: keys,
	});
	detachedPids.push(quiet.structuredContent.data.detached?.pid);
	trackProcess(quiet.structuredContent.data.detached?.pid);
	assert.deepEqual(
		[
			quiet.structuredContent.data.capability.confirmation,
			quiet.structuredContent.data.capability.confirmedVia,
		],
		["confirmed", "chat"],
	);
	await waitUntilSettled(headless.client, quiet.structuredContent.data.runId);
	const free = await call(headless.client, "workflow_run", {
		workflow: "wf.json",
		task: "headless free",
		executor: "test-fixture",
		permissionMode: "free",
	});
	assert.equal(free.isError, false, free.content[0].text);
	detachedPids.push(free.structuredContent.data.detached?.pid);
	trackProcess(free.structuredContent.data.detached?.pid);
	assert.equal(
		free.structuredContent.data.capability.confirmation,
		"not-needed",
	);
	await waitUntilSettled(headless.client, free.structuredContent.data.runId);
	assert.equal(asked.length, 2, "a client without dialogs is never sent one");
});

test("WP28 official SDK client: confirmed profile changes (accept, decline, no elicitation), dry-run prune asks nothing", async (t) => {
	const cwd = await project();
	const asked = [];
	let action = "accept";
	const { client } = await sdkClient(t, {
		cwd,
		capabilities: { elicitation: {} },
		onElicit: async (request) => {
			asked.push(request.params);
			return { action };
		},
	});
	const set = await call(client, "workflow_profile", {
		op: "set",
		name: "fast",
		executor: "codex",
		effort: "low",
	});
	assert.equal(set.isError, false, set.content[0].text);
	assert.equal(asked.length, 1);
	assert.match(
		asked[0].message,
		/^Save the agent-workflow user profile "fast"\?/,
	);
	const listed = await call(client, "workflow_profile", { op: "list" });
	assert.deepEqual(
		listed.structuredContent.data.profiles.map((profile) => profile.name),
		["fast"],
	);
	assert.equal(asked.length, 1, "list asks nothing");

	action = "decline";
	const declined = await call(client, "workflow_profile", {
		op: "delete",
		name: "fast",
	});
	assert.equal(declined.isError, true);
	assert.equal(declined.structuredContent.data.confirmation, "declined");
	assert.equal(asked.length, 2);
	const still = await call(client, "workflow_profile", {
		op: "show",
		name: "fast",
	});
	assert.equal(still.structuredContent.data.profile.name, "fast");

	const dry = await call(client, "workflow_prune", {});
	assert.equal(dry.isError, false, dry.content[0].text);
	assert.equal(dry.structuredContent.data.dryRun, true);
	assert.equal(asked.length, 2, "a dry run asks nothing");

	const headless = await sdkClient(t, { cwd });
	const refused = await call(headless.client, "workflow_profile", {
		op: "delete",
		name: "fast",
	});
	assert.equal(refused.isError, true);
	assert.match(
		refused.content[0].text,
		/does not support confirmation dialogs[\s\S]*agent-workflow profile delete fast/,
	);
	const kept = await call(headless.client, "workflow_profile", {});
	assert.equal(kept.structuredContent.data.profiles.length, 1);
});

test("WP28 official SDK client: workflow_supervise drives a run whose attached server died", async (t) => {
	const cwd = await project();
	const first = await sdkClient(t, { cwd, config: { stepDelayMs: 1_500 } });
	const launched = await call(first.client, "workflow_run", {
		workflow: "wf.json",
		task: "orphaned attached run",
		executor: "test-fixture",
		detach: false,
	});
	assert.equal(launched.isError, false, launched.content[0].text);
	const runId = launched.structuredContent.data.runId;
	assert.equal(launched.structuredContent.data.detached, undefined);
	// The server that drove the run dies.
	// Kill the live server now (it just answered): a direct kill, not the stale-pid-safe cleanup,
	// which skips a process whose identity could not be read under load.
	process.kill(first.pid(), "SIGKILL");
	await new Promise((resolve) => setTimeout(resolve, 300));

	const second = await sdkClient(t, { cwd, config: { stepDelayMs: 1_500 } });
	const supervised = await call(second.client, "workflow_supervise", { runId });
	assert.equal(supervised.isError, false, supervised.content[0].text);
	const data = supervised.structuredContent.data;
	if (data.started) {
		detachedPids.push(data.detached.pid);
		trackProcess(data.detached.pid);
	}
	assert.equal(data.started, true, supervised.content[0].text);
	assert.equal(typeof data.detached.pid, "number");
	assert.match(supervised.content[0].text, /Detached supervisor started/);
	const final = await waitUntilSettled(second.client, runId);
	assert.equal(
		final.structuredContent.outcome,
		"completed",
		final.content[0].text,
	);
	const again = await call(second.client, "workflow_supervise", { runId });
	assert.equal(again.structuredContent.data.reason, "not-running");
});

test("the agent-workflow-mcp bin launcher serves the same server", async (t) => {
	const cwd = await project();
	const { client } = await sdkClient(t, { cwd, command: HOST_SERVER_BIN });
	assert.equal(client.getServerVersion()?.name, "agent-workflow");
	const listed = await call(client, "workflow_list", { limit: 1 });
	assert.equal(listed.structuredContent.data.workflows.length, 1);
});
