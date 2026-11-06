import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP33 item 4, parity row 35): host-neutral launch capture. Every host API
// launch (CLI, Pi `/aw` command and `aw_*` tools, host MCP server) records `run.launch` (schema
// `agent-workflow-run-launch-v1`, with host-neutral `source` `cli`/`pi`/`mcp:<host>` and
// `entry`) and `launch-command.txt` (0600, the
// human-readable command, credentials redacted, home directory as `~`); `show <run>` and
// `inspect <run>` show it. Runs use the workflow executor
// fixture (no model or agent-CLI calls).
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import { fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const cli = await import("../../dist/hosts/cli/index.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const store = await import("../../dist/core/store.js");
const capture = await import("../../dist/hosts/launch-capture.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const clients = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp33-launch",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};
const SECRET = "supersecretvalue123";

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp33-launch-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const client of clients.splice(0))
		await client.close().catch(() => undefined);
	for (const { pi } of instances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp33-launch-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				stepDelayMs: 50,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const home = join(root, `home${counter}`);
	const env = {
		...process.env,
		HOME: home,
		AGENT_WORKFLOW_HOME: join(cwd, "aw-home"),
		MY_API_KEY: SECRET,
	};
	return { cwd, env, home, executor: id };
}

async function settle(cwd, env, runId) {
	let waited;
	do waited = await api.waitAction({ cwd, env }, { runId, timeoutMs: 10_000 });
	while (waited.data.stillRunning);
}

async function launchRecord(cwd, runId) {
	const run = JSON.parse(
		await readFile(
			join(stateDir(cwd), ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	const file = join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		runId,
		"launch-command.txt",
	);
	const text = await readFile(file, "utf8");
	return { launch: run.launch, text, mode: (await stat(file)).mode & 0o777 };
}

function assertClean(text, home) {
	assert.doesNotMatch(text, new RegExp(SECRET));
	assert.ok(!text.includes(home), `home path left in ${text}`);
}

test("CLI: run.launch v1 host shape, launch-command.txt (0600, redacted, ~), show and inspect", async () => {
	const { cwd, env, home, executor } = await project();
	const out = [];
	const io = {
		cwd,
		env,
		stdout: (text) => out.push(text),
		stderr: () => undefined,
		isTTY: false,
	};
	const task = `check ${home}/notes.md with key ${SECRET}`;
	const code = await cli.runAgentWorkflowCli(
		["run", "wf.json", task, "--executor", executor, "--json"],
		io,
	);
	assert.equal(code, 0, out.join(""));
	const runId = JSON.parse(out.join("")).data.runId;
	await settle(cwd, env, runId);
	const { launch, text, mode } = await launchRecord(cwd, runId);
	assert.equal(launch.schema, "agent-workflow-run-launch-v1");
	assert.equal(launch.source, "cli");
	assert.deepEqual(launch.entry, { kind: "command", action: "run" });
	assert.equal(launch.requestKind, "named-workflow");
	assert.equal(launch.routingMode, "off");
	assert.deepEqual(launch.profile, { kind: "base" });
	assert.deepEqual(launch.task, {
		characters: Array.from(task).length,
		lines: 1,
	});
	assert.equal(launch.command.state, "captured");
	assert.equal(launch.command.artifact, "launch-command.txt");
	assert.equal(launch.command.fidelity, "agent-workflow-host-command-v1");
	assert.equal(launch.command.bytes, Buffer.byteLength(text));
	assert.equal(mode, 0o600);
	assert.match(
		text,
		/^agent-workflow run wf\.json 'check ~\/notes\.md with key \[REDACTED:MY_API_KEY\]' --executor /,
	);
	assert.match(text, / --json$/);
	assertClean(text, home);
	assert.ok(store.isWorkflowRunLaunchMetadata(launch));

	const shown = await api.showAction({ cwd, env, host: "cli" }, { ref: runId });
	assert.match(
		shown.text,
		/Launch: cli · command run · named-workflow, base profile, task \d+ chars\/1 line/,
	);
	assert.match(shown.text, /Launch command: agent-workflow run wf\.json/);
	assert.equal(shown.data.launch.source, "cli");
	assert.equal(shown.data.launch.command.text, text);
	const inspected = await api.inspectAction({ cwd, env }, { runId });
	assert.match(inspected.text, /Launch: cli · command run/);
	assert.match(inspected.text, /Launch command: agent-workflow run wf\.json/);
	assert.equal(
		inspected.data.launch.command.fidelity,
		"agent-workflow-host-command-v1",
	);
});

test("Pi host: /aw run is a command, aw_dynamic a tool call (source pi)", async () => {
	const { cwd, env, home, executor } = await project();
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	instances.push({ pi });
	const ctx = fakeCtx(cwd);
	await pi.commands
		.get("aw")
		.handler(`run wf.json "pi ${SECRET}" --executor ${executor}`, ctx);
	const [listed] = (await api.statusAction({ cwd, env })).data.runs;
	await settle(cwd, env, listed.runId);
	const command = await launchRecord(cwd, listed.runId);
	assert.equal(command.launch.source, "pi");
	assert.deepEqual(command.launch.entry, { kind: "command", action: "run" });
	assert.equal(
		command.text,
		`/aw run wf.json "pi [REDACTED:MY_API_KEY]" --executor ${executor}`,
	);

	const dynamic = await pi.tools
		.get("aw_dynamic")
		.execute(
			"d",
			{ task: `dynamic in ${home}/repo`, executor },
			undefined,
			undefined,
			ctx,
		);
	const runId = dynamic.details.runId;
	await settle(cwd, env, runId);
	const tool = await launchRecord(cwd, runId);
	assert.equal(tool.launch.source, "pi");
	assert.deepEqual(tool.launch.entry, { kind: "tool", name: "aw_dynamic" });
	assert.equal(tool.launch.requestKind, "direct-dynamic");
	assert.deepEqual(tool.launch.profile, { kind: "not-applicable" });
	assert.equal(tool.launch.command.fidelity, "agent-workflow-tool-call-v1");
	assert.equal(
		tool.text,
		`aw_dynamic ${JSON.stringify({ task: "dynamic in ~/repo", executor })}`,
	);
	assertClean(tool.text, home);
});

test("host MCP server: workflow_run records source mcp:<host>", async () => {
	const { cwd, env, home, executor } = await project();
	const client = await inProcessHostServer({
		root: cwd,
		env,
		host: "claude-code",
	});
	clients.push(client);
	const init = await client.initialize();
	assert.equal(init.error, undefined, JSON.stringify(init));
	const launched = await client.call("workflow_run", {
		workflow: "wf.json",
		task: `mcp ${SECRET}`,
		executor,
		detach: false,
	});
	const runId =
		launched.structuredContent?.data?.runId ??
		/Run: (workflow_\S+)/.exec(launched.content?.[0]?.text ?? "")?.[1];
	assert.ok(runId, JSON.stringify(launched));
	await settle(cwd, env, runId);
	const { launch, text } = await launchRecord(cwd, runId);
	assert.equal(launch.source, "mcp:claude-code");
	assert.deepEqual(launch.entry, { kind: "tool", name: "workflow_run" });
	assert.match(
		text,
		/^workflow_run \{"workflow":"wf\.json","task":"mcp \[REDACTED:MY_API_KEY\]"/,
	);
	assertClean(text, home);
});

test("host API without an origin: a synthesized agent-workflow command; strict launch records", async () => {
	const { cwd, env, executor } = await project();
	const launched = await api.runWorkflowAction(
		{ cwd, env },
		{
			workflow: "wf.json",
			task: "plain task",
			executor,
			inputOverrides: {},
			forceNew: true,
		},
	);
	await settle(cwd, env, launched.data.runId);
	const { launch, text } = await launchRecord(cwd, launched.data.runId);
	assert.equal(launch.source, "cli");
	assert.equal(
		text,
		`agent-workflow run wf.json 'plain task' --executor ${executor} --force-new`,
	);

	assert.equal(capture.launchHostSource("generic"), "mcp:generic");
	assert.equal(capture.launchHostSource("codex"), "mcp:codex");
	assert.equal(capture.launchHostSource(undefined), "cli");
	// Strict validation: unknown sources/entries or mismatched kinds are rejected.
	const ok = { ...launch };
	assert.ok(store.isWorkflowRunLaunchMetadata(ok));
	for (const bad of [
		{ ...ok, source: "mcp:" },
		{ ...ok, source: "web" },
		{ ...ok, entry: { kind: "command", action: "dynamic" } },
		{ ...ok, routingMode: "default-on" },
		{ ...ok, command: { ...ok.command, fidelity: "pi-extension-command-v1" } },
		{ ...ok, extra: 1 },
	])
		assert.equal(
			store.isWorkflowRunLaunchMetadata(bad),
			false,
			JSON.stringify(bad),
		);
	// Launch records with unrecognized schemas are not accepted.
	assert.equal(
		store.isWorkflowRunLaunchMetadata({
			schema: "pi-workflow-run-launch-v1",
			source: { kind: "tool", name: "workflow_run" },
			requestKind: "named-workflow",
			routingMode: "off",
			profile: { kind: "base" },
			task: { characters: 1, lines: 1 },
			command: { state: "unavailable", reason: "not-a-command" },
		}),
		false,
	);
});
